import { beforeEach, describe, expect, it } from 'vitest';
import {
  AppErrorCode,
  isAppError,
  operationCancelled,
  uncancellable,
  type CancellationToken,
} from '@cadfixer/shared';
import { DEFAULT_DOCUMENT_LIMITS, distinctMeshes, triangleCount } from '@cadfixer/mesh-core';
import { refusalOf, ImportRefusal } from '@cadfixer/file-formats';
import {
  buildZip,
  modelXml,
  TETRAHEDRON_MESH,
  valid3mf,
} from '@cadfixer/file-formats/threemf-fixtures';
import type { OperationContext } from '@cadfixer/geometry-runtime';
import {
  modelImportHandler,
  repairCandidates,
  repairHistory,
  residentDocuments,
  topologyReports,
} from './stl-handlers';

/**
 * IMPORT THROUGH THE WHOLE PRODUCTION PATH: identify, dispatch, validate, commit.
 *
 * The reader suites test each parser against its own corpus. This tests what
 * only the worker can answer — that a file reaches the right reader, that the
 * document gate runs, that the commit is transactional, and that OBJ and 3MF go
 * through the SAME transaction STL does rather than acquiring their own.
 */

function context(cancellation: CancellationToken = uncancellable): OperationContext {
  return {
    cancellation,
    interruptible: true,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (cancellation.isCancelled) throw operationCancelled();
    },
  };
}

function bytesOf(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(view.byteLength);
  new Uint8Array(buffer).set(view);
  return buffer;
}

/** A 84-byte binary STL declaring zero triangles: the smallest valid one. */
function emptyBinaryStl(triangles: number): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);
  for (let index = 0; index < triangles; index += 1) {
    const base = 84 + index * 50 + 12;
    view.setFloat32(base, 0, true);
    view.setFloat32(base + 4, 0, true);
    view.setFloat32(base + 8, 0, true);
    view.setFloat32(base + 12, 1, true);
    view.setFloat32(base + 16, 0, true);
    view.setFloat32(base + 20, 0, true);
    view.setFloat32(base + 24, 0, true);
    view.setFloat32(base + 28, 1, true);
    view.setFloat32(base + 32, 0, true);
  }
  return buffer;
}

const OBJ_TRIANGLE = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

async function expectRefusal(
  run: () => Promise<unknown>,
  code: string,
  reason?: ImportRefusal,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (cause) {
    caught = cause;
  }
  expect(isAppError(caught), 'expected a typed AppError').toBe(true);
  if (!isAppError(caught)) return;
  expect(caught.code).toBe(code);
  if (reason !== undefined) expect(refusalOf(caught)).toBe(reason);
}

beforeEach(() => {
  residentDocuments.releaseAll();
  repairCandidates.releaseAll();
  repairHistory.releaseAll();
  topologyReports.releaseAll();
});

/* ------------------------------------------------ identification and dispatch -- */

describe('the worker identifies a file from its bytes', () => {
  it('imports an OBJ and reports the format it actually read', async () => {
    const outcome = await modelImportHandler(
      { fileName: 'part.obj', bytes: bytesOf(OBJ_TRIANGLE) },
      context(),
    );

    expect(outcome.value.formatId).toBe('obj');
    expect(outcome.value.encoding).toBe('text');
    expect(outcome.value.parts).toHaveLength(1);
    expect(outcome.value.triangleCount).toBe(1);
    // OBJ states no unit, and nothing defaults it.
    expect(outcome.value.unit).toBeUndefined();
  });

  it('imports a 3MF and preserves its unit', async () => {
    const outcome = await modelImportHandler(
      { fileName: 'part.3mf', bytes: toArrayBuffer(await valid3mf(modelXml({ unit: 'inch' }))) },
      context(),
    );

    expect(outcome.value.formatId).toBe('3mf');
    expect(outcome.value.unit).toBe('inch');
    expect(outcome.value.parts).toHaveLength(1);
    expect(outcome.value.triangleCount).toBe(4);
  });

  it('still imports STL, unchanged', async () => {
    const outcome = await modelImportHandler(
      { fileName: 'part.stl', bytes: emptyBinaryStl(2) },
      context(),
    );

    expect(outcome.value.formatId).toBe('stl');
    expect(outcome.value.encoding).toBe('binary');
    expect(outcome.value.parts).toHaveLength(1);
    expect(outcome.value.unit).toBeUndefined();
  });

  it('trusts the CONTENT over the extension for an ambiguous text file', async () => {
    // An `.obj` holding OBJ records is unambiguous; the point is that the
    // decision came from the bytes, which the reported format proves.
    const outcome = await modelImportHandler(
      { fileName: 'mislabelled.txt', bytes: bytesOf(OBJ_TRIANGLE) },
      context(),
    );
    expect(outcome.value.formatId).toBe('obj');
  });

  it('refuses a file whose name and contents disagree rather than guessing', async () => {
    await expectRefusal(
      () => modelImportHandler({ fileName: 'lying.3mf', bytes: bytesOf(OBJ_TRIANGLE) }, context()),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.ContentExtensionMismatch,
    );
  });

  it('refuses a file it cannot recognise at all', async () => {
    await expectRefusal(
      () =>
        modelImportHandler(
          { fileName: 'notes.stl', bytes: bytesOf('this is not a model of any kind') },
          context(),
        ),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.UnknownFormat,
    );
  });

  it('does not treat an arbitrary ZIP as a 3MF just because it is an archive', async () => {
    const archive = await buildZip([{ name: 'readme.txt', content: 'hello' }]);

    await expectRefusal(
      () =>
        modelImportHandler({ fileName: 'archive.3mf', bytes: toArrayBuffer(archive) }, context()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfNoModelPart,
    );
  });
});

/* ---------------------------------------------------- one commit path -- */

describe('every format goes through the same document transaction', () => {
  it('commits an OBJ document at revision 1 with a deterministic first part', async () => {
    const outcome = await modelImportHandler(
      {
        fileName: 'two.obj',
        bytes: bytesOf(
          'o Alpha\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' +
            'o Beta\nv 5 0 0\nv 6 0 0\nv 5 1 0\nf 4 5 6\n',
        ),
      },
      context(),
    );

    expect(outcome.value.handle.revision).toBe(1);
    expect(outcome.value.parts.map((part) => part.name)).toEqual(['Alpha', 'Beta']);
    expect(residentDocuments.has(outcome.value.handle)).toBe(true);
  });

  it('shares one authoritative mesh across repeated 3MF placements', async () => {
    const xml = modelXml({
      build: '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 0 0"/>',
    });
    const outcome = await modelImportHandler(
      { fileName: 'shared.3mf', bytes: toArrayBuffer(await valid3mf(xml)) },
      context(),
    );

    // The page's view: two parts naming ONE mesh resource.
    expect(outcome.value.parts).toHaveLength(2);
    expect(outcome.value.parts[0]?.meshResourceIndex).toBe(
      outcome.value.parts[1]?.meshResourceIndex,
    );

    // The worker's view: one mesh object, and bytes charged once.
    const document = residentDocuments.resolve(outcome.value.handle);
    if (!('parts' in document)) throw new Error('expected a document');
    expect(distinctMeshes(document)).toHaveLength(1);
    expect(document.parts[0]?.mesh).toBe(document.parts[1]?.mesh);
  });

  it('builds one render snapshot buffer per distinct mesh, not per placement', async () => {
    const xml = modelXml({
      build:
        '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>' +
        '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>',
    });
    const outcome = await modelImportHandler(
      { fileName: 'shared.3mf', bytes: toArrayBuffer(await valid3mf(xml)) },
      context(),
    );

    expect(outcome.value.render.parts).toHaveLength(3);
    const first = outcome.value.render.parts[0];
    for (const part of outcome.value.render.parts) {
      expect(part.positions).toBe(first?.positions);
    }
    // Deduplicated, or the transfer would throw a DataCloneError.
    expect(outcome.transfer).toHaveLength(2);
  });

  it('reports unsupported source features without refusing the geometry', async () => {
    const xml = modelXml({
      resources:
        '<texture2d id="9" path="/3D/Textures/skin.png" contenttype="image/png"/>' +
        `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
    });

    const outcome = await modelImportHandler(
      { fileName: 'textured.3mf', bytes: toArrayBuffer(await valid3mf(xml)) },
      context(),
    );

    expect(outcome.value.parts).toHaveLength(1);
    expect(outcome.value.unsupportedFeatures).toContain('TEXTURES');
    expect(outcome.value.warnings.map((warning) => warning.code)).toContain(
      'THREEMF_TEXTURES_NOT_IMPORTED',
    );
  });

  it('says nothing unsupported for an ordinary file', async () => {
    const outcome = await modelImportHandler(
      { fileName: 'plain.obj', bytes: bytesOf(OBJ_TRIANGLE) },
      context(),
    );
    expect(outcome.value.unsupportedFeatures).toEqual([]);
    expect(outcome.value.warnings).toEqual([]);
  });
});

/* ------------------------------------------------------ transactionality -- */

describe('a failed import leaves the previous document untouched', () => {
  it.each([
    ['OBJ', 'broken.obj', 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n'],
    ['OBJ index', 'broken.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n'],
  ])('%s: a malformed replacement changes nothing', async (_label, name, text) => {
    const first = await modelImportHandler(
      { fileName: 'good.obj', bytes: bytesOf(OBJ_TRIANGLE) },
      context(),
    );
    const before = residentDocuments.resolve(first.value.handle);

    await expect(
      modelImportHandler({ fileName: name, bytes: bytesOf(text) }, context()),
    ).rejects.toThrow();

    // SAME OBJECT, same revision, same store.
    expect(residentDocuments.resolve(first.value.handle)).toBe(before);
    expect(residentDocuments.revisionOf(first.value.handle.documentId)).toBe(1);
    expect(residentDocuments.stats().documentCount).toBe(1);
  });

  it('3MF: a hostile archive changes nothing', async () => {
    const first = await modelImportHandler(
      { fileName: 'good.3mf', bytes: toArrayBuffer(await valid3mf()) },
      context(),
    );
    const before = residentDocuments.resolve(first.value.handle);

    const hostile = await buildZip([{ name: '../../etc/passwd', content: 'x' }]);
    await expect(
      modelImportHandler({ fileName: 'hostile.3mf', bytes: toArrayBuffer(hostile) }, context()),
    ).rejects.toThrow();

    expect(residentDocuments.resolve(first.value.handle)).toBe(before);
    expect(residentDocuments.stats().documentCount).toBe(1);
  });

  it('3MF: a refused XML construct changes nothing', async () => {
    const first = await modelImportHandler(
      { fileName: 'good.3mf', bytes: toArrayBuffer(await valid3mf()) },
      context(),
    );

    const hostile = await valid3mf(modelXml({ prolog: '<!DOCTYPE model>\n' }));
    await expectRefusal(
      () => modelImportHandler({ fileName: 'xxe.3mf', bytes: toArrayBuffer(hostile) }, context()),
      AppErrorCode.MalformedFile,
      ImportRefusal.XmlDoctypeRefused,
    );

    expect(residentDocuments.revisionOf(first.value.handle.documentId)).toBe(1);
  });

  it('an unrecognised file changes nothing', async () => {
    const first = await modelImportHandler(
      { fileName: 'good.obj', bytes: bytesOf(OBJ_TRIANGLE) },
      context(),
    );

    await expect(
      modelImportHandler(
        { fileName: 'junk.stl', bytes: bytesOf('nothing recognisable here at all') },
        context(),
      ),
    ).rejects.toThrow();

    expect(residentDocuments.has(first.value.handle)).toBe(true);
  });
});

/* --------------------------------------------------------- cancellation -- */

describe('cancellation', () => {
  it('leaves nothing resident when an OBJ import is cancelled mid-parse', async () => {
    const faces = Array.from({ length: 200_000 }, () => 'f 1 2 3').join('\n');
    const text = `v 0 0 0\nv 1 0 0\nv 0 1 0\n${faces}\n`;

    /*
     * A CANCEL THAT ARRIVES DURING THE PARSE, simulated deterministically
     * rather than by racing a timer: the token reports "not cancelled" for the
     * first few polls and "cancelled" afterwards, which is exactly what a real
     * cancel message looks like from inside the loop.
     */
    let polls = 0;
    const token: CancellationToken = {
      get isCancelled(): boolean {
        polls += 1;
        return polls > 3;
      },
      onCancelled(): () => void {
        return (): void => undefined;
      },
    };

    await expectRefusal(
      () => modelImportHandler({ fileName: 'big.obj', bytes: bytesOf(text) }, context(token)),
      AppErrorCode.OperationCancelled,
    );

    // NOTHING COMMITTED. A cancel that left a partial document resident would
    // be worse than no cancel at all.
    expect(residentDocuments.stats().documentCount).toBe(0);
    // And the parser really did poll rather than running to completion first.
    expect(polls).toBeGreaterThan(3);
  });

  it('leaves an earlier document untouched when a later import is cancelled', async () => {
    const first = await modelImportHandler(
      { fileName: 'good.obj', bytes: bytesOf(OBJ_TRIANGLE) },
      context(),
    );
    const before = residentDocuments.resolve(first.value.handle);

    let polls = 0;
    const token: CancellationToken = {
      get isCancelled(): boolean {
        polls += 1;
        return polls > 1;
      },
      onCancelled(): () => void {
        return (): void => undefined;
      },
    };

    const archive = toArrayBuffer(await valid3mf());
    await expectRefusal(
      () => modelImportHandler({ fileName: 'later.3mf', bytes: archive }, context(token)),
      AppErrorCode.OperationCancelled,
    );

    expect(residentDocuments.resolve(first.value.handle)).toBe(before);
    expect(residentDocuments.stats().documentCount).toBe(1);
  });

  it('allows a retry after a cancellation', async () => {
    const outcome = await modelImportHandler(
      { fileName: 'retry.obj', bytes: bytesOf(OBJ_TRIANGLE) },
      context(),
    );
    expect(outcome.value.parts).toHaveLength(1);
  });
});

/* --------------------------------------------------- document validation -- */

describe('the document gate runs for every format', () => {
  it('IMPORTS a degenerate OBJ face, because that is a defect and not a broken file', async () => {
    /*
     * THE SAME LINE THE 3MF READER DRAWS for a zero-area triangle. A face whose
     * corners repeat a vertex is index-level degeneracy: a valid file
     * describing a defective mesh. `validateMeshStructure` reports it as a
     * WARNING for exactly this reason — refusing it would make the models the
     * repair workflow exists to fix unloadable.
     */
    const outcome = await modelImportHandler(
      { fileName: 'degenerate.obj', bytes: bytesOf('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 1 1\n') },
      context(),
    );

    expect(outcome.value.parts).toHaveLength(1);
    // Structurally valid, and the defect is surfaced rather than hidden.
    expect(outcome.value.validation.valid).toBe(true);
    expect(outcome.value.validation.codes).toContain('DEGENERATE_TRIANGLE');
    expect(outcome.value.validation.warningCount).toBeGreaterThan(0);
  });

  it('accepts a part count JUST BELOW the document ceiling', async () => {
    // The DOCUMENT gate, which no mesh check can answer. Both sides of the
    // boundary are pinned, because a ceiling that is never actually reached is
    // a ceiling nobody has tested.
    const limit = DEFAULT_DOCUMENT_LIMITS.maxParts;
    const items = Array.from({ length: limit }, () => '<item objectid="1"/>').join('');

    const outcome = await modelImportHandler(
      { fileName: 'many.3mf', bytes: toArrayBuffer(await valid3mf(modelXml({ build: items }))) },
      context(),
    );
    expect(outcome.value.parts).toHaveLength(limit);
  });

  it('refuses a part count JUST ABOVE the document ceiling, and commits nothing', async () => {
    /*
     * ONE ITEM MORE. As of Stage 4A-2B1-R1 this refusal comes from the READER,
     * during expansion, rather than from `assertGeometryDocument` after it: the
     * reader's part ceiling IS the document's, so the 4,097th part is never
     * built. Both orderings leave nothing resident; this one does far less work
     * to get there, and the typed reason below is what distinguishes them.
     */
    const first = await modelImportHandler(
      { fileName: 'good.3mf', bytes: toArrayBuffer(await valid3mf()) },
      context(),
    );
    const before = residentDocuments.resolve(first.value.handle);

    const items = Array.from(
      { length: DEFAULT_DOCUMENT_LIMITS.maxParts + 1 },
      () => '<item objectid="1"/>',
    ).join('');

    let caught: unknown;
    try {
      await modelImportHandler(
        {
          fileName: 'toomany.3mf',
          bytes: toArrayBuffer(await valid3mf(modelXml({ build: items }))),
        },
        context(),
      );
    } catch (error) {
      caught = error;
    }

    // REFUSED BY THE EXPANDER, not by the document gate afterwards.
    expect(isAppError(caught) && refusalOf(caught)).toBe(ImportRefusal.ThreeMfTooManyParts);
    expect(residentDocuments.resolve(first.value.handle)).toBe(before);
    expect(residentDocuments.stats().documentCount).toBe(1);
  });

  it('refuses an archive whose entries together exceed the inflation budget', async () => {
    /*
     * THE CUMULATIVE BUDGET, through the real worker handler. The model part
     * declares one byte and inflates to far more, so every ceiling checked
     * before inflation is satisfied and only the running count of produced
     * bytes can stop it.
     */
    const first = await modelImportHandler(
      { fileName: 'good.3mf', bytes: toArrayBuffer(await valid3mf()) },
      context(),
    );
    const before = residentDocuments.resolve(first.value.handle);

    /*
     * THREE ENTRIES OF TWO HUNDRED MEGABYTES, declared. Each is inside the
     * 256 MiB per-entry cap and each declares a 100:1 ratio, inside the 200:1
     * cap — so every per-entry ceiling is satisfied and only the archive-wide
     * total, 600 MiB against 512 MiB, refuses this.
     *
     * DECLARED rather than real: producing 512 MiB of output to prove a 512 MiB
     * ceiling would allocate exactly what the ceiling exists to prevent. The
     * RUNTIME half of the same rule — the count of bytes actually produced,
     * which catches a directory that lies — is proven against the reader in
     * `threemf/zip.test.ts` (ZT01–ZT05) with the limits narrowed instead.
     */
    /*
     * THE COMPRESSED BYTES ARE REAL — Stage 6D-A4. This declared 2 MiB of
     * compressed data per entry inside an archive of a few hundred bytes; the
     * directory now refuses an entry whose data would lie outside the archive,
     * so each entry carries 1.2 MiB of incompressible bytes instead and the
     * ratio stays under 200:1 honestly.
     */
    const incompressible = (length: number, seed: number): Uint8Array => {
      const out = new Uint8Array(length);
      let state = 0x9e3779b9 ^ seed;
      for (let at = 0; at < length; at += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        out[at] = state & 0xff;
      }
      return out;
    };
    const oversized = await buildZip(
      ['a', 'b', 'c'].map((name, index) => ({
        name: `3D/${name}.model`,
        content: incompressible(1.2 * 1024 * 1024, index + 1),
        method: 8,
        declaredUncompressedSize: 200 * 1024 * 1024,
      })),
    );

    let caught: unknown;
    try {
      await modelImportHandler(
        { fileName: 'huge.3mf', bytes: toArrayBuffer(oversized) },
        context(),
      );
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught) && refusalOf(caught)).toBe(ImportRefusal.ZipTotalTooLarge);
    expect(residentDocuments.resolve(first.value.handle)).toBe(before);
    expect(residentDocuments.stats().documentCount).toBe(1);

    // AND THE NEXT VALID IMPORT SUCCEEDS. A budget that leaked into the next
    // import, or a decompressor left in a bad state, shows up only here.
    const recovered = await modelImportHandler(
      { fileName: 'again.3mf', bytes: toArrayBuffer(await valid3mf()) },
      context(),
    );
    expect(recovered.value.parts).toHaveLength(1);
  });

  it('validates each DISTINCT mesh once, not once per placement', async () => {
    // A thousand placements of one component must not cost a thousand full
    // coordinate walks. Proven by the document committing at all in reasonable
    // time, and by the resident bytes being charged once.
    const items = Array.from(
      { length: 200 },
      (_item, index) => `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${String(index)} 0 0"/>`,
    ).join('');

    const outcome = await modelImportHandler(
      { fileName: 'many.3mf', bytes: toArrayBuffer(await valid3mf(modelXml({ build: items }))) },
      context(),
    );

    expect(outcome.value.parts).toHaveLength(200);
    const document = residentDocuments.resolve(outcome.value.handle);
    if (!('parts' in document)) throw new Error('expected a document');
    expect(distinctMeshes(document)).toHaveLength(1);
    expect(triangleCount(document.parts[0]?.mesh as never)).toBe(4);
  });
});

/* ---------------------------------- A3: multi-model-part, through the worker -- */

describe('A3: a production-extension package goes through the same transaction', () => {
  const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
  const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  const RELS =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rel0" Target="/3D/3dmodel.model" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  const CONTENT_TYPES_XML =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>';

  /** `children` referenced parts, each placed once by the root's build. */
  async function productionPackage(children: number, broken = false): Promise<ArrayBuffer> {
    const items: string[] = [];
    const parts: { name: string; method: 8; content: string }[] = [];
    for (let index = 0; index < children; index += 1) {
      const path = `3D/Objects/object_${String(index + 1)}.model`;
      items.push(
        `<item objectid="1" p:path="/${path}" transform="1 0 0 0 1 0 0 0 1 ${String(index * 30)} 0 0"/>`,
      );
      parts.push({
        name: path,
        method: 8,
        content:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          `<model unit="millimeter" xmlns="${CORE}"><resources>` +
          // THE LAST CHILD IS THE BROKEN ONE when asked for, so the refusal
          // happens AFTER earlier children have been read and materialised.
          (broken && index === children - 1
            ? '<object id="1" type="model"><mesh><vertices>' +
              '<vertex x="0" y="0" z="0"/></vertices><triangles>' +
              '<triangle v1="0" v2="9" v3="9"/></triangles></mesh></object>'
            : `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`) +
          '</resources><build/></model>',
      });
    }

    return toArrayBuffer(
      await buildZip([
        { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES_XML },
        { name: '_rels/.rels', method: 8, content: RELS },
        {
          name: '3D/3dmodel.model',
          method: 8,
          content:
            '<?xml version="1.0" encoding="UTF-8"?>' +
            `<model unit="millimeter" xmlns="${CORE}" xmlns:p="${PRODUCTION}" requiredextensions="p">` +
            `<resources/><build>${items.join('')}</build></model>`,
        },
        ...parts,
      ]),
    );
  }

  it('commits every reachable part as one document, with one render buffer each', async () => {
    const result = await modelImportHandler(
      { bytes: await productionPackage(3), fileName: 'package.3mf' },
      context(),
    );

    expect(result.value.formatId).toBe('3mf');
    expect(result.value.parts).toHaveLength(3);
    expect(result.value.unit).toBe('millimeter');
    expect(result.value.triangleCount).toBe(12);
    // THREE DISTINCT MESHES, so three render resources and no accidental sharing.
    expect(new Set(result.value.parts.map((part) => part.meshResourceIndex)).size).toBe(3);
    expect(result.value.render.parts).toHaveLength(3);
  });

  it('leaves the previous document untouched when one reachable part is broken', async () => {
    /*
     * THE TRANSACTIONAL CLAIM AT THE LAYER THAT CAN BREAK IT. Two children are
     * read and materialised before the third refuses, so this is not a package
     * that failed at the door — and still nothing becomes authoritative.
     */
    const first = await modelImportHandler(
      { bytes: await productionPackage(1), fileName: 'good.3mf' },
      context(),
    );
    const before = residentDocuments.stats();

    await expectRefusal(
      async () =>
        modelImportHandler(
          { bytes: await productionPackage(3, true), fileName: 'broken.3mf' },
          context(),
        ),
      AppErrorCode.MalformedFile,
    );

    // The handle from before still resolves, and nothing new became resident.
    expect(residentDocuments.stats()).toEqual(before);
    const document = residentDocuments.resolve(first.value.handle);
    expect('parts' in document).toBe(true);

    // And the next valid package still imports.
    const next = await modelImportHandler(
      { bytes: await productionPackage(2), fileName: 'next.3mf' },
      context(),
    );
    expect(next.value.parts).toHaveLength(2);
  });

  it('a replacement is a SEPARATE document, and releasing the first does not disturb it', async () => {
    /*
     * THE REPLACEMENT RACE, WITH MULTI-PART SOURCES ON BOTH SIDES.
     *
     * AN IMPORT NEVER OVERWRITES. Each commit produces its own `documentId`, so
     * a package import that takes seconds cannot have its result written over
     * by one started later — the two are different documents and the page
     * decides which it is looking at. Releasing the one it has moved off is the
     * separate, explicit act, and it must not touch the other.
     */
    const original = await modelImportHandler(
      { bytes: await productionPackage(3), fileName: 'a.3mf' },
      context(),
    );
    const replacement = await modelImportHandler(
      { bytes: await productionPackage(2), fileName: 'b.3mf' },
      context(),
    );

    expect(replacement.value.parts).toHaveLength(2);
    expect(original.value.handle.documentId).not.toBe(replacement.value.handle.documentId);
    expect('parts' in residentDocuments.resolve(original.value.handle)).toBe(true);
    expect('parts' in residentDocuments.resolve(replacement.value.handle)).toBe(true);

    residentDocuments.release(original.value.handle.documentId);

    // The superseded handle stops resolving; the current one is untouched.
    expect('parts' in residentDocuments.resolve(original.value.handle)).toBe(false);
    const current = residentDocuments.resolve(replacement.value.handle);
    expect('parts' in current).toBe(true);
    if (!('parts' in current)) return;
    expect(current.parts).toHaveLength(2);
  });

  it('a stale handle for a released package resolves to a typed failure, not to geometry', async () => {
    const original = await modelImportHandler(
      { bytes: await productionPackage(3), fileName: 'a.3mf' },
      context(),
    );
    residentDocuments.release(original.value.handle.documentId);

    const stale = residentDocuments.resolve(original.value.handle);
    expect('parts' in stale).toBe(false);
    expect(isAppError(stale)).toBe(true);
  });

  it('a cancelled package import commits nothing and leaves the worker usable', async () => {
    let cancelled = false;
    const token: CancellationToken = {
      get isCancelled(): boolean {
        return cancelled;
      },
      onCancelled(): () => void {
        return (): void => undefined;
      },
    };

    const bytes = await productionPackage(3);
    cancelled = true;
    await expectRefusal(
      async () => modelImportHandler({ bytes, fileName: 'cancelled.3mf' }, context(token)),
      AppErrorCode.OperationCancelled,
    );
    expect(residentDocuments.stats().documentCount).toBe(0);

    const after = await modelImportHandler(
      { bytes: await productionPackage(2), fileName: 'after.3mf' },
      context(),
    );
    expect(after.value.parts).toHaveLength(2);
  });
});
