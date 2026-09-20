import { describe, expect, it } from 'vitest';
import { AppErrorCode, CancellationSource, isAppError } from '@cadfixer/shared';
import { documentTriangleCount } from '@cadfixer/mesh-core';
import { ImportRefusal, refusalOf } from '../import-errors';
import { inflateRawForTests, inflateRawSlicedForTests, testReadContext } from '../test-context';
import { read3mf, type StreamingIngestion } from './threemf-reader';
import {
  createInflationBudget,
  DEFAULT_ZIP_LIMITS,
  readZipDirectory,
  readZipEntry,
  streamZipEntry,
  type ZipEntry,
} from './zip';
import { buildZip, CONTENT_TYPES, RELS, TETRAHEDRON_MESH } from './zip-fixtures';
import { createStreamScanStats } from './xml-stream';

/**
 * 6E-Z / 6E-R — THE STREAMING ENTRY READER AND THE STREAMING READ, AS UNITS.
 *
 * Parity with the whole-buffer reader over the mutation campaign lives in
 * `mutation-campaign.test.ts` (6E-P). This file pins what only streaming has:
 * chunked delivery with every `readZipEntry` rule still applied, a budget
 * charged once across two passes, cancellation observed at byte positions,
 * parse-once across two passes, and no document from a late failure.
 */

const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, reason: refusalOf(error) };
  }
  throw new Error('expected a refusal');
}

function entryOf(archive: Uint8Array, name: string): ZipEntry {
  const entry = readZipDirectory(archive).find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no ${name}`);
  return entry;
}

const PAYLOAD = new TextEncoder().encode(
  Array.from({ length: 4_000 }, (_unused, n) => `<vertex x="${String(n)}" y="1" z="2"/>`).join(''),
);

describe('6E-Z: streamZipEntry delivers the entry readZipEntry delivers, under every rule', () => {
  for (const [label, method, zip64] of [
    ['deflated', 8, false],
    ['stored', 0, false],
    ['deflated, Zip64 form', 8, true],
  ] as const) {
    it(`${label}: the chunks concatenate to the whole entry`, async () => {
      const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method }], { zip64 });
      const entry = entryOf(archive, 'a.model');
      const whole = await readZipEntry(archive, entry, {
        inflateRaw: inflateRawForTests,
        budget: createInflationBudget(),
      });
      const streamed = await collect(
        streamZipEntry(archive, entry, {
          inflateRaw: inflateRawSlicedForTests(64),
          budget: createInflationBudget(),
          charge: true,
          storedSliceBytes: 1_000,
        }),
      );
      expect(streamed).toEqual(whole);
    });
  }

  it('a declared size over the per-entry ceiling is refused before anything is inflated', async () => {
    const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method: 8 }]);
    const entry = entryOf(archive, 'a.model');
    let inflations = 0;
    const result = await refusal(async () => {
      await collect(
        streamZipEntry(archive, entry, {
          limits: { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 1_000 },
          inflateRaw: (bytes) => {
            inflations += 1;
            return inflateRawForTests(bytes);
          },
          budget: createInflationBudget(),
          charge: true,
        }),
      );
    });
    expect(result.reason).toBe(ImportRefusal.ZipEntryTooLarge);
    expect(inflations).toBe(0);
  });

  it('overrun, shortfall and corrupt deflate are the whole-buffer refusals', async () => {
    const cases: readonly (readonly [Parameters<typeof buildZip>[0][number], unknown])[] = [
      [
        { name: 'a.model', content: PAYLOAD, method: 8, declaredUncompressedSize: 100 },
        ImportRefusal.ZipDeclaredSizeOverrun,
      ],
      [
        {
          name: 'a.model',
          content: PAYLOAD,
          method: 8,
          declaredUncompressedSize: PAYLOAD.byteLength + 9,
        },
        ImportRefusal.ZipDeclaredSizeShortfall,
      ],
    ];
    for (const [spec, expected] of cases) {
      const archive = await buildZip([spec]);
      const entry = entryOf(archive, 'a.model');
      const result = await refusal(() =>
        collect(
          streamZipEntry(archive, entry, {
            inflateRaw: inflateRawSlicedForTests(256),
            budget: createInflationBudget(),
            charge: true,
          }),
        ),
      );
      expect(result.reason).toBe(expected);
    }

    const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method: 8 }]);
    const entry = entryOf(archive, 'a.model');
    const damaged = archive.slice();
    const view = new DataView(damaged.buffer);
    const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true);
    damaged[start] = (damaged[start] ?? 0) ^ 0xff;
    damaged[start + 1] = (damaged[start + 1] ?? 0) ^ 0xff;
    const result = await refusal(() =>
      collect(
        streamZipEntry(damaged, entry, {
          inflateRaw: inflateRawSlicedForTests(256),
          budget: createInflationBudget(),
          charge: true,
        }),
      ),
    );
    expect(result).toEqual({
      code: AppErrorCode.MalformedFile,
      reason: ImportRefusal.ZipMalformed,
    });
  });

  it('charges the package budget when asked to, and only then', async () => {
    const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method: 8 }]);
    const entry = entryOf(archive, 'a.model');
    const budget = createInflationBudget();
    for (const charge of [true, false, false]) {
      await collect(
        streamZipEntry(archive, entry, {
          inflateRaw: inflateRawSlicedForTests(65_536),
          budget,
          charge,
        }),
      );
    }
    expect(budget.totalProducedBytes).toBe(PAYLOAD.byteLength);

    const tight = createInflationBudget({
      ...DEFAULT_ZIP_LIMITS,
      maxTotalUncompressedBytes: PAYLOAD.byteLength - 1,
    });
    const result = await refusal(() =>
      collect(
        streamZipEntry(archive, entry, {
          inflateRaw: inflateRawSlicedForTests(65_536),
          budget: tight,
          charge: true,
        }),
      ),
    );
    expect(result.reason).toBe(ImportRefusal.ZipTotalTooLarge);
  });

  it('the runtime ratio check fires on a stream that lies about its compressed size', async () => {
    const zeros = new Uint8Array(4 * 1024 * 1024);
    const archive = await buildZip([
      { name: 'a.model', content: zeros, method: 8, declaredUncompressedSize: 1024 },
    ]);
    const entry = { ...entryOf(archive, 'a.model'), uncompressedSize: zeros.byteLength };
    const result = await refusal(() =>
      collect(
        streamZipEntry(archive, entry, {
          inflateRaw: inflateRawSlicedForTests(65_536),
          budget: createInflationBudget(),
          charge: true,
        }),
      ),
    );
    expect(result.reason).toBe(ImportRefusal.ZipRatioExceeded);
  });
});

/* ------------------------------------------------------------ read3mf -- */

function denseModel(triangles: number): string {
  const vertices: string[] = [];
  const faces: string[] = [];
  for (let n = 0; n < triangles; n += 1) {
    vertices.push(
      `<vertex x="${String(n)}" y="0" z="0"/><vertex x="${String(n)}" y="1" z="0"/><vertex x="${String(n)}" y="0" z="1"/>`,
    );
    faces.push(
      `<triangle v1="${String(n * 3)}" v2="${String(n * 3 + 1)}" v3="${String(n * 3 + 2)}"/>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}">` +
    `<resources><object id="1" type="model" name="Größe 大"><mesh><vertices>${vertices.join('')}</vertices>` +
    `<triangles>${faces.join('')}</triangles></mesh></object></resources>` +
    '<build><item objectid="1"/></build></model>'
  );
}

async function packageOf(model: string, extra: Record<string, string> = {}): Promise<Uint8Array> {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES, method: 8 },
    { name: '_rels/.rels', content: RELS, method: 8 },
    { name: '3D/3dmodel.model', content: model, method: 8 },
    ...Object.entries(extra).map(([name, content]) => ({ name, content, method: 8 })),
  ]);
}

function streaming(extra: Partial<StreamingIngestion> = {}): StreamingIngestion {
  return {
    inflateRaw: inflateRawSlicedForTests(4_096),
    createDecoder: () => new TextDecoder('utf-8', { fatal: false }),
    ...extra,
  };
}

describe('6E-R: the streaming read', () => {
  it('reads a dense part through bounded pieces, with the UTF-8 name intact', async () => {
    const stats = createStreamScanStats();
    const bytes = await packageOf(denseModel(20_000));
    const whole = await read3mf(bytes, testReadContext());
    const streamed = await read3mf(bytes, testReadContext(), {
      ingestion: streaming({ stats }),
    });
    expect(documentTriangleCount(streamed.document)).toBe(20_000);
    expect(streamed.document.parts[0]?.name).toBe('Größe 大');
    expect(streamed.document.parts[0]?.mesh.positions).toEqual(
      whole.document.parts[0]?.mesh.positions,
    );
    // Nothing near the size of the part was ever held as one piece or one tag.
    expect(stats.maxPieceChars).toBeLessThan(200_000);
    expect(stats.maxTagChars).toBeLessThan(200);
  });

  it('parses each model part once — two passes — however often it is referenced', async () => {
    const root =
      `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}" xmlns:p="${PRODUCTION}" requiredextensions="p">` +
      '<resources><object id="1" type="model"><components>' +
      '<component objectid="7" p:path="/3D/child.model"/>' +
      '<component objectid="7" p:path="/3D/child.model" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>' +
      '</components></object></resources>' +
      '<build><item objectid="1"/><item objectid="7" p:path="/3D/child.model"/></build></model>';
    const child =
      `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}">` +
      `<resources><object id="7" type="model">${TETRAHEDRON_MESH}</object></resources><build/></model>`;
    const bytes = await packageOf(root, { '3D/child.model': child });
    let inflations = 0;
    const result = await read3mf(bytes, testReadContext(), {
      ingestion: streaming({
        inflateRaw: (compressed) => {
          inflations += 1;
          return inflateRawSlicedForTests(128)(compressed);
        },
      }),
    });
    expect(result.document.parts).toHaveLength(3);
    // Root twice, child twice. Three references to the child, one parse.
    expect(inflations).toBe(4);
  });

  it('charges the package budget once for a part it reads twice', async () => {
    const model = denseModel(2_000);
    const bytes = await packageOf(model);
    const exact = new TextEncoder().encode(model).byteLength;
    const rels = new TextEncoder().encode(RELS).byteLength;
    const budget = createInflationBudget();
    await read3mf(bytes, testReadContext(), { ingestion: streaming(), budget });
    expect(budget.totalProducedBytes).toBe(exact + rels);
  });

  for (const fraction of [0.1, 0.5, 0.9]) {
    it(`a cancel at ${String(fraction * 100)}% of the bytes stops the read, and returns nothing`, async () => {
      const bytes = await packageOf(denseModel(20_000));
      const total = new TextEncoder().encode(denseModel(20_000)).byteLength * 2;
      const source = new CancellationSource();
      let seen = 0;
      let seenAtCancel = 0;
      const result = await refusal(() =>
        read3mf(bytes, testReadContext({ cancellation: source.token }), {
          ingestion: streaming({
            onBytes: (_pass, length) => {
              seen += length;
              if (seenAtCancel === 0 && seen >= total * fraction) {
                seenAtCancel = seen;
                source.cancel();
              }
            },
          }),
        }),
      );
      expect(result.code).toBe(AppErrorCode.OperationCancelled);
      // Stopped within one piece of where it was asked to.
      expect(seen - seenAtCancel).toBeLessThan(70_000);
    });
  }

  it('a malformed token at the very end refuses the part — no document, no partial', async () => {
    const model = denseModel(5_000).replace('</model>', '</model><broken');
    const bytes = await packageOf(model);
    const stats = createStreamScanStats();
    const whole = await refusal(() => read3mf(bytes, testReadContext()));
    const streamed = await refusal(() =>
      read3mf(bytes, testReadContext(), { ingestion: streaming({ stats }) }),
    );
    expect(streamed).toEqual(whole);
    expect(streamed.reason).toBe(ImportRefusal.XmlMalformed);
    // The scanner's location: it had consumed the whole part when it refused.
    expect(stats.charsConsumed).toBe(model.length);
  });

  it('a required extension split across pieces is still refused as unsupported', async () => {
    const model = denseModel(10).replace(
      '<model unit="millimeter"',
      '<model unit="millimeter" xmlns:q="http://example.invalid/q" requiredextensions="q"',
    );
    const bytes = await packageOf(model);
    for (const slice of [1, 2, 3, 5, 8, 13]) {
      const result = await refusal(() =>
        read3mf(bytes, testReadContext(), {
          ingestion: streaming({ inflateRaw: inflateRawSlicedForTests(slice) }),
        }),
      );
      expect(result.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
    }
  });
});

/* ------------------------------------------- unsupported-feature parity -- */

const ALTERNATIVES = 'http://schemas.microsoft.com/3dmanufacturing/production/alternatives/2021/04';
const CHILD = '3D/Objects/a.model';

function childModel(): string {
  return denseModel(3);
}

/** A root placing the child through `p:path`, with extra namespaces and attributes. */
function productionRoot(xmlns: string, attrs: string, objectExtra = ''): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}" xmlns:p="${PRODUCTION}"${xmlns}${attrs}>` +
    `<resources><object id="2" type="model">${TETRAHEDRON_MESH}${objectExtra}</object></resources>` +
    `<build><item objectid="2"/><item objectid="1" p:path="/${CHILD}"/></build></model>`
  );
}

async function refusalWithDetails(
  run: () => Promise<unknown>,
): Promise<{ code: string; reason: unknown; message: string; details: unknown }> {
  try {
    await run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      code: error.code,
      reason: refusalOf(error),
      message: error.message,
      details: error.details,
    };
  }
  throw new Error('expected a refusal');
}

describe('6E-U: unsupported features are refused identically however the part arrives', () => {
  const cases: readonly { name: string; model: string; reason: string }[] = [
    {
      name: 'Secure Content declared required',
      model: productionRoot(
        ' xmlns:z="http://schemas.microsoft.com/3dmanufacturing/securecontent/2019/04"',
        ' requiredextensions="p z"',
      ),
      reason: ImportRefusal.ThreeMfUnsupportedExtension,
    },
    {
      name: 'Slice declared required',
      model: productionRoot(
        ' xmlns:s="http://schemas.microsoft.com/3dmanufacturing/slice/2015/07"',
        ' requiredextensions="p s"',
      ),
      reason: ImportRefusal.ThreeMfUnsupportedExtension,
    },
    {
      name: 'an alternatives element, under a non-conventional prefix',
      model: productionRoot(
        ` xmlns:alt="${ALTERNATIVES}"`,
        ' requiredextensions="p"',
        `<alt:alternatives><alt:alternative p:path="/${CHILD}" objectid="1"/></alt:alternatives>`,
      ),
      reason: ImportRefusal.ThreeMfModelResolutionUnsupported,
    },
  ];

  for (const { name, model, reason } of cases) {
    it(`${name}: same code, reason, message and details at every slice size`, async () => {
      const bytes = await packageOf(model, { [CHILD]: childModel() });
      const whole = await refusalWithDetails(() => read3mf(bytes, testReadContext()));
      expect(whole.reason).toBe(reason);
      for (const slice of [1, 2, 3, 7, 64, 4_096]) {
        const streamed = await refusalWithDetails(() =>
          read3mf(bytes, testReadContext(), {
            ingestion: streaming({ inflateRaw: inflateRawSlicedForTests(slice) }),
          }),
        );
        expect(streamed).toEqual(whole);
      }
    });
  }
});

describe('6E-D: a refused stream leaves nothing behind for the next import', () => {
  it('a corrupt deflate is the typed "damaged" refusal, and the next read is unaffected', async () => {
    const good = await packageOf(denseModel(200));
    const expected = await read3mf(good, testReadContext());

    // Corrupt the model entry's compressed data in place: same sizes, bad stream.
    const bad = good.slice();
    const entry = entryOf(bad, '3D/3dmodel.model');
    const view = new DataView(bad.buffer, bad.byteOffset, bad.byteLength);
    const start =
      entry.localOffset +
      30 +
      view.getUint16(entry.localOffset + 26, true) +
      view.getUint16(entry.localOffset + 28, true);
    bad.fill(0xff, start, start + Math.min(64, entry.compressedSize));

    const whole = await refusalWithDetails(() => read3mf(bad, testReadContext()));
    const streamed = await refusalWithDetails(() =>
      read3mf(bad, testReadContext(), { ingestion: streaming() }),
    );
    expect(streamed.code).toBe(AppErrorCode.MalformedFile);
    expect(streamed.reason).toBe(ImportRefusal.ZipMalformed);
    expect(streamed.message).toMatch(/damaged/);
    expect(streamed).toEqual(whole);

    // The next streamed read, with a fresh context as every import has, is whole.
    const after = await read3mf(good, testReadContext(), { ingestion: streaming() });
    expect(documentTriangleCount(after.document)).toBe(documentTriangleCount(expected.document));
    expect(after.document.parts[0]?.name).toBe(expected.document.parts[0]?.name);
  });
});
