import { describe, expect, it } from 'vitest';
import { AppErrorCode, formatBytes, isAppError } from '@cadfixer/shared';
import { testReadContext } from '../test-context';
import { ImportRefusal, refusalOf } from '../import-errors';
import { DEFAULT_MAX_INTAKE_BYTES, screenFile } from '../screening';
import { read3mf, DEFAULT_3MF_LIMITS } from './threemf-reader';
import { DEFAULT_ZIP_LIMITS } from './zip';
import { DEFAULT_XML_LIMITS } from './xml-scan';
import { buildZip, CONTENT_TYPES, modelXml, TETRAHEDRON_MESH, valid3mf } from './zip-fixtures';

/**
 * 3MF-C1 – 3MF-C5 AND 3MF-R1 – 3MF-R7 — Stage 6B-C1.
 *
 * Promoted from the Stage 6B-D1 diagnosis suite, which reproduced two real beta
 * failures. This is permanent regression coverage for the two properties that
 * stage established were missing:
 *
 * 1. A VALID file must never be described as a broken one. A 3MF that uses the
 *    production extension is something CAD Fixer cannot read; it is not damaged,
 *    and the refusal has to say which of those it is.
 * 2. A RESOURCE REFUSAL MUST NAME WHAT IT MEASURED. Six ceilings share one error
 *    code, and a user who is told only "too large" cannot tell raw bytes from
 *    expanded bytes — which is exactly what one beta tester could not tell.
 *
 * The resource tests assert the MEASURED QUANTITY AND THE CEILING, and they get
 * the ceiling from the same constant the enforcement reads. A test that hard-
 * coded `512 MiB` would keep passing if a limit moved and the message did not.
 */

interface CapturedRefusal {
  readonly code: string;
  readonly reason: string | undefined;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

async function refusalFor(run: () => Promise<unknown>): Promise<CapturedRefusal> {
  let caught: unknown;
  try {
    await run();
  } catch (cause) {
    caught = cause;
  }
  expect(isAppError(caught), 'expected a typed AppError').toBe(true);
  if (!isAppError(caught)) throw new Error('unreachable');
  return {
    code: caught.code,
    reason: refusalOf(caught),
    message: caught.message,
    details: caught.details,
  };
}

const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

/** The object part a production-extension package keeps its geometry in. */
const OBJECT_PART = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}">
 <resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>
 <build/>
</model>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

async function packageWith(rootModel: string, extras: readonly string[] = []): Promise<Uint8Array> {
  return buildZip([
    { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
    { name: '_rels/.rels', method: 8, content: RELS },
    { name: '3D/3dmodel.model', method: 8, content: rootModel },
    ...extras.map((content, at) => ({
      name: `3D/Objects/object_${String(at + 1)}.model`,
      method: 8,
      content,
    })),
  ]);
}

/* ============================================ refusal semantics — 3MF-C == */

describe('3MF-C1: a genuine dangling component reference', () => {
  const dangling = modelXml({
    unit: 'millimeter',
    resources:
      `<object id="1" type="model">${TETRAHEDRON_MESH}</object>` +
      '<object id="17" type="model"><components>' +
      '<component objectid="1"/><component objectid="42"/>' +
      '</components></object>',
    build: '<item objectid="17"/>',
  });

  it('stays MALFORMED_FILE: an unresolvable reference is a broken file', async () => {
    const refusal = await refusalFor(async () =>
      read3mf(await valid3mf(dangling), testReadContext()),
    );

    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfMissingObject);
  });

  it('names the missing object, the object holding the reference, and which component', async () => {
    const refusal = await refusalFor(async () =>
      read3mf(await valid3mf(dangling), testReadContext()),
    );

    expect(refusal.message).toContain('Object 17, component 2 refers to missing object 42.');
    expect(refusal.details.objectId).toBe('42');
    expect(refusal.details.referencingObjectId).toBe('17');
    expect(refusal.details.componentIndex).toBe(2);
  });

  it('commits no document', async () => {
    await expect(read3mf(await valid3mf(dangling), testReadContext())).rejects.toBeDefined();
  });

  /**
   * AN OBJECT ID IS UNTRUSTED TEXT. A well-formed id is at most ten digits and
   * belongs in the sentence; anything else stays in `details`, so no refusal can
   * be made to carry a kilobyte of attacker-chosen content into the interface.
   */
  it('keeps a malformed id out of the prose and still reports it in details', async () => {
    const hostile = 'x'.repeat(400);
    const xml = modelXml({
      unit: 'millimeter',
      resources:
        `<object id="1" type="model">${TETRAHEDRON_MESH}</object>` +
        `<object id="2" type="model"><components><component objectid="${hostile}"/></components></object>`,
      build: '<item objectid="2"/>',
    });

    const refusal = await refusalFor(async () => read3mf(await valid3mf(xml), testReadContext()));

    expect(refusal.reason).toBe(ImportRefusal.ThreeMfMissingObject);
    expect(refusal.message).not.toContain('xxx');
    expect(refusal.message.length).toBeLessThan(200);
    expect(String(refusal.details.objectId)).toHaveLength(64);
  });
});

describe('3MF-C2: a valid production-extension package', () => {
  const root = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}">
 <resources>
  <object id="2" type="model"><components>
   <component p:path="/3D/Objects/object_1.model" objectid="1"/>
  </components></object>
 </resources>
 <build><item objectid="2"/></build>
</model>`;

  it('is UNSUPPORTED_FILE, not MALFORMED_FILE', async () => {
    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(root, [OBJECT_PART]), testReadContext()),
    );

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.code).not.toBe(AppErrorCode.MalformedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfMultiModelPart);
  });

  it('says the objects live in several model parts, and never that the file is broken', async () => {
    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(root, [OBJECT_PART]), testReadContext()),
    );

    expect(refusal.message).toContain('several model parts');
    expect(refusal.message).toContain('does not support');
    // THE OLD SENTENCE MUST NOT COME BACK for a valid file.
    expect(refusal.message).not.toContain('does not exist');
    for (const forbidden of ['broken', 'corrupt', 'damaged', 'invalid', 'malformed']) {
      expect(refusal.message.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('suggests something the user can actually do', async () => {
    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(root, [OBJECT_PART]), testReadContext()),
    );
    expect(refusal.message).toMatch(/plain 3MF|STL/i);
  });

  /**
   * ORDER, NOT COINCIDENCE.
   *
   * The same package with an ADDITIONAL genuinely dangling reference must still
   * be classified unsupported. If the missing-object check ran first this would
   * come back MALFORMED_FILE, which is the exact defect Stage 6B-C1 fixes.
   */
  it('takes priority over the missing-object check when a file trips both', async () => {
    const both = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}">
 <resources>
  <object id="3" type="model">${TETRAHEDRON_MESH}</object>
  <object id="2" type="model"><components>
   <component p:path="/3D/Objects/object_1.model" objectid="1"/>
   <component objectid="9999"/>
  </components></object>
 </resources>
 <build><item objectid="2"/></build>
</model>`;

    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(both, [OBJECT_PART]), testReadContext()),
    );

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfMultiModelPart);
  });

  /**
   * THE PREFIX IS THE AUTHOR'S TO CHOOSE. Detection resolves the namespace, so
   * a package using `prod:` rather than `p:` is recognised identically — and a
   * literal match on the text `p:path` would have missed it.
   */
  it('recognises the extension whatever prefix the file binds it to', async () => {
    const renamed = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:prod="${PRODUCTION_NS}">
 <resources>
  <object id="2" type="model"><components>
   <component prod:path="/3D/Objects/object_1.model" objectid="1"/>
  </components></object>
 </resources>
 <build><item objectid="2"/></build>
</model>`;

    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(renamed, [OBJECT_PART]), testReadContext()),
    );
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfMultiModelPart);
  });

  /**
   * THE SHAPE REAL PRODUCER OUTPUT ACTUALLY HAS — Stage v0.1.1 RC1.
   *
   * A production-extension package commonly has an EMPTY root `<resources/>`:
   * the root model is a manifest of build items pointing into other model
   * parts, and every mesh lives elsewhere. This is the structure observed in
   * the 3MF production-extension fixture carried in PrusaSlicer's own
   * repository, reproduced here as a tiny synthetic equivalent rather than by
   * vendoring a third-party file.
   *
   * Under v0.1.0 this exact shape was refused as MALFORMED_FILE — "this 3MF
   * file builds an object which does not exist" — which is the BETA-001 defect
   * reproduced on real producer output rather than on a constructed case.
   */
  it('classifies an empty-root manifest with an item path as unsupported, not malformed', async () => {
    const manifestRoot = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}">
 <resources/>
 <build>
  <item objectid="2" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 50 50 0"/>
 </build>
</model>`;

    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(manifestRoot, [OBJECT_PART]), testReadContext()),
    );

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfMultiModelPart);
    expect(refusal.message).not.toContain('does not exist');
  });

  it('recognises a production path on a build item too', async () => {
    const onItem = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}">
 <resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>
 <build><item p:path="/3D/Objects/object_1.model" objectid="1"/></build>
</model>`;

    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(onItem, [OBJECT_PART]), testReadContext()),
    );
    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.details.via).toBe('item');
  });
});

describe('3MF-C3: a declared required extension', () => {
  it('refuses rather than reading the file as baseline 3MF', async () => {
    const declared = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" requiredextensions="p">
 <resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>
 <build><item objectid="1"/></build>
</model>`;

    // NOTE: this model is otherwise perfectly readable. Refusing it is the
    // point — the file says it cannot be understood without semantics CAD Fixer
    // does not have, and importing the recognisable half would be incomplete
    // geometry presented as the user's model.
    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(declared), testReadContext()),
    );

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
    expect(refusal.message).toContain('production extension');
    expect(refusal.details.extension).toBe(PRODUCTION_NS);
  });

  it('refuses an unknown required extension without naming it in the prose', async () => {
    const unknown = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:s="http://example.invalid/slice/2099" requiredextensions="s">
 <resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>
 <build><item objectid="1"/></build>
</model>`;

    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(unknown), testReadContext()),
    );

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
    // The URI is structural metadata and belongs in details, not in a sentence.
    expect(refusal.message).not.toContain('example.invalid');
    expect(refusal.details.extension).toBe('http://example.invalid/slice/2099');
  });

  /** An unresolvable prefix is a requirement whose meaning is unknown. Refuse. */
  it('refuses a required prefix that resolves to no namespace', async () => {
    const orphan = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" requiredextensions="ghost">
 <resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>
 <build><item objectid="1"/></build>
</model>`;

    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(orphan), testReadContext()),
    );

    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
    expect(refusal.details.resolved).toBe(false);
  });

  /**
   * THE COST OF BEING CONSERVATIVE, WRITTEN DOWN.
   *
   * This package declares the production extension REQUIRED and then keeps all
   * of its geometry in the root model part, so CAD Fixer could in fact read it —
   * and before Stage 6B-C1 it did. It is refused now because the file itself
   * says it cannot be understood without semantics CAD Fixer does not implement,
   * and the extension carries more than paths: reading it as baseline 3MF would
   * be deciding, on the user's behalf, that the parts we ignored did not matter.
   *
   * THIS IS A DELIBERATE NARROWING OF WHAT IMPORTS, not an oversight. If beta
   * evidence shows slicers routinely declare the extension without using it,
   * this is the test to revisit — and the decision to revisit is a product
   * decision, not a quiet loosening.
   */
  it('refuses a declared-required extension even when the geometry is all in the root part', async () => {
    const readableButDeclared = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" requiredextensions="p">
 <resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>
 <build><item objectid="1"/></build>
</model>`;

    const refusal = await refusalFor(async () =>
      read3mf(await packageWith(readableButDeclared), testReadContext()),
    );

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
  });

  it('does not refuse a file that lists only the core namespace as required', async () => {
    const core = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:c="${CORE_NS}" requiredextensions="c">
 <resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>
 <build><item objectid="1"/></build>
</model>`;

    const result = await read3mf(await packageWith(core), testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });
});

describe('3MF-C4: baseline 3MF is unchanged', () => {
  it('imports a plain file exactly as before', async () => {
    const result = await read3mf(await valid3mf(), testReadContext());

    expect(result.document.parts).toHaveLength(1);
    expect(result.document.unit).toBe('millimeter');
    expect([...(result.document.parts[0]?.mesh.positions ?? [])]).toEqual([
      0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10,
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('still imports ordinary components, which are not an extension', async () => {
    const xml = modelXml({
      unit: 'millimeter',
      resources:
        `<object id="1" type="model">${TETRAHEDRON_MESH}</object>` +
        '<object id="2" type="model"><components><component objectid="1"/></components></object>',
      build: '<item objectid="2"/>',
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });
});

describe('3MF-C5: several model parts are not, on their own, evidence', () => {
  /**
   * DETECTION IS STRUCTURAL, NEVER CIRCUMSTANTIAL.
   *
   * An archive may carry spare `.model` entries for any reason. Treating their
   * mere presence as an extension would refuse files CAD Fixer reads perfectly
   * well — trading one false accusation for another.
   */
  it('imports normally when extra .model entries carry no extension reference', async () => {
    const root = modelXml({ unit: 'millimeter' });
    const bytes = await packageWith(root, [OBJECT_PART, OBJECT_PART]);

    const result = await read3mf(bytes, testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });

  it('imports normally when the production namespace is declared but never used', async () => {
    const declaredOnly = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}">
 <resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>
 <build><item objectid="1"/></build>
</model>`;

    const result = await read3mf(await packageWith(declaredOnly, [OBJECT_PART]), testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });
});

/* ========================================= resource diagnostics — 3MF-R == */

describe('3MF-R1: raw intake size', () => {
  it('names the file size and the intake ceiling', () => {
    const result = screenFile({ name: 'huge.3mf', size: 563_000_000 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.message).toBe("This file is 537 MiB; CAD Fixer's intake limit is 512 MiB.");
  });

  it('derives the ceiling from the enforcing constant', () => {
    const result = screenFile({ name: 'x.3mf', size: 4096 }, { maxBytes: 1024 });
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    // The caller's limit, not the default, appears in the sentence.
    expect(result.message).toContain('1 KiB');
    expect(result.message).not.toContain('512 MiB');
    expect(DEFAULT_MAX_INTAKE_BYTES).toBe(512 * 1024 * 1024);
  });
});

describe('3MF-R2: total expanded archive size', () => {
  /** The beta case: small on disk, large expanded. Both numbers, one sentence. */
  it('distinguishes the size on disk from the expanded total', async () => {
    const bytes = await buildZip([
      { name: '3D/3dmodel.model', method: 8, content: new Uint8Array(4 * 1024 * 1024) },
    ]);
    expect(bytes.byteLength).toBeLessThan(64 * 1024);

    const refusal = await refusalFor(async () =>
      read3mf(bytes, testReadContext(), {
        zipLimits: { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 1024 * 1024 },
      }),
    );

    expect(refusal.code).toBe(AppErrorCode.ResourceLimitExceeded);
    expect(refusal.reason).toBe(ImportRefusal.ZipTotalTooLarge);
    expect(refusal.message).toContain('on disk but expands to');
    expect(refusal.message).toContain('4 MiB in total');
    expect(refusal.message).toContain('total expansion limit is 1 MiB');
    // 3MF-R7: the expanded total is never presented as the file's own size.
    expect(refusal.message).toContain(
      'The limit is on expanded data, not on the size of the file.',
    );
  });
});

describe('3MF-R3: per-entry expanded size', () => {
  it('identifies the per-entry metric and its ceiling', async () => {
    const bytes = await buildZip([
      { name: '3D/3dmodel.model', method: 8, content: new Uint8Array(4 * 1024 * 1024) },
    ]);

    const refusal = await refusalFor(async () =>
      read3mf(bytes, testReadContext(), {
        zipLimits: { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 1024 * 1024 },
      }),
    );

    expect(refusal.reason).toBe(ImportRefusal.ZipEntryTooLarge);
    expect(refusal.message).toBe(
      "A file inside this archive expands to 4 MiB; CAD Fixer's per-entry expansion limit is 1 MiB.",
    );
  });

  it('says the default per-entry ceiling in IEC units', () => {
    expect(DEFAULT_ZIP_LIMITS.maxEntryBytes).toBe(256 * 1024 * 1024);
  });
});

describe('3MF-R4: compression ratio', () => {
  it('states the observed ratio and the threshold', async () => {
    const bytes = await buildZip([
      { name: '3D/3dmodel.model', method: 8, content: new Uint8Array(4 * 1024 * 1024) },
    ]);

    const refusal = await refusalFor(async () => read3mf(bytes, testReadContext()));

    expect(refusal.reason).toBe(ImportRefusal.ZipRatioExceeded);
    expect(refusal.message).toMatch(/^A file inside this archive expands at [\d,]+:1;/);
    expect(refusal.message).toContain(
      `CAD Fixer's compression-ratio limit is ${String(DEFAULT_ZIP_LIMITS.maxCompressionRatio)}:1.`,
    );
  });
});

describe('3MF-R5: geometry count ceilings', () => {
  it('an object ceiling names objects, not bytes', async () => {
    const resources = Array.from(
      { length: 6 },
      (_, at) => `<object id="${String(at + 1)}" type="model">${TETRAHEDRON_MESH}</object>`,
    ).join('');

    const refusal = await refusalFor(async () =>
      read3mf(await valid3mf(modelXml({ unit: 'millimeter', resources })), testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxObjects: 3 },
      }),
    );

    expect(refusal.reason).toBe(ImportRefusal.ThreeMfTooManyObjects);
    expect(refusal.message).toBe(
      "This 3MF file declares 4 objects; CAD Fixer's limit is 3 objects.",
    );
    expect(refusal.message).not.toMatch(/larger|size|bytes/i);
  });

  it('a per-object triangle ceiling names triangles', async () => {
    const refusal = await refusalFor(async () =>
      read3mf(await valid3mf(), testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxTrianglesPerObject: 2 },
      }),
    );

    expect(refusal.reason).toBe(ImportRefusal.ThreeMfTooManyTriangles);
    expect(refusal.message).toBe(
      "An object in this 3MF file contains 3 triangles; CAD Fixer's limit is 2 triangles for one object.",
    );
  });

  it('a per-object vertex ceiling names vertices', async () => {
    const refusal = await refusalFor(async () =>
      read3mf(await valid3mf(), testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxVerticesPerObject: 2 },
      }),
    );

    expect(refusal.reason).toBe(ImportRefusal.ThreeMfTooManyVertices);
    expect(refusal.message).toBe(
      "An object in this 3MF file contains 3 vertices; CAD Fixer's limit is 2 vertices for one object.",
    );
  });

  it('a component-depth ceiling names levels', async () => {
    const chain = Array.from(
      { length: 5 },
      (_, at) =>
        `<object id="${String(at + 2)}" type="model"><components><component objectid="${String(at + 1)}"/></components></object>`,
    ).join('');

    const refusal = await refusalFor(async () =>
      read3mf(
        await valid3mf(
          modelXml({
            unit: 'millimeter',
            resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>${chain}`,
            build: '<item objectid="6"/>',
          }),
        ),
        testReadContext(),
        { limits: { ...DEFAULT_3MF_LIMITS, maxComponentDepth: 2 } },
      ),
    );

    expect(refusal.reason).toBe(ImportRefusal.ThreeMfComponentTooDeep);
    expect(refusal.message).toBe(
      "This 3MF file nests components 3 levels deep; CAD Fixer's limit is 2 levels.",
    );
  });

  it('an XML depth ceiling names levels', async () => {
    const refusal = await refusalFor(async () =>
      read3mf(await valid3mf(), testReadContext(), {
        xmlLimits: { ...DEFAULT_XML_LIMITS, maxDepth: 2 },
      }),
    );

    expect(refusal.reason).toBe(ImportRefusal.XmlTooDeep);
    expect(refusal.message).toBe(
      "This 3MF file nests XML 3 levels deep; CAD Fixer's limit is 2 levels.",
    );
  });
});

describe('3MF-R6: every number comes from the enforcing constant', () => {
  /**
   * NARROW THE LIMIT, AND THE SENTENCE MOVES WITH IT.
   *
   * This is what separates a message that reports the ceiling from one that
   * merely recites a number someone typed twice. A duplicated literal would go
   * on printing 256 MiB after the limit changed, and nothing would notice.
   */
  it.each([
    [4096, '4 KiB'],
    [1024 * 1024, '1 MiB'],
    [3 * 1024 * 1024, '3 MiB'],
  ])('renders a per-entry ceiling of %i bytes as %s', async (limit, rendered) => {
    const bytes = await buildZip([
      { name: '3D/3dmodel.model', method: 8, content: new Uint8Array(8 * 1024 * 1024) },
    ]);

    const refusal = await refusalFor(async () =>
      read3mf(bytes, testReadContext(), {
        zipLimits: { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: limit },
      }),
    );

    expect(refusal.reason).toBe(ImportRefusal.ZipEntryTooLarge);
    expect(refusal.message).toContain(`per-entry expansion limit is ${rendered}`);
  });

  it.each([
    [2, '2 objects'],
    [7, '7 objects'],
  ])('renders an object ceiling of %i as %s', async (limit, rendered) => {
    const resources = Array.from(
      { length: limit + 2 },
      (_, at) => `<object id="${String(at + 1)}" type="model">${TETRAHEDRON_MESH}</object>`,
    ).join('');

    const refusal = await refusalFor(async () =>
      read3mf(await valid3mf(modelXml({ unit: 'millimeter', resources })), testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxObjects: limit },
      }),
    );

    expect(refusal.message).toContain(`CAD Fixer's limit is ${rendered}.`);
  });

  /**
   * THE DEFAULTS ARE BINARY, SO THE LABELS MUST BE IEC.
   *
   * `512 * 1024 * 1024` is 512 MiB and is not 512 MB. Calling it MB would
   * misstate the ceiling by 7% in the user's favour — which is how a support
   * thread about a refused "500 MB" file starts.
   */
  it('labels the binary defaults with binary units', () => {
    expect(DEFAULT_ZIP_LIMITS.maxArchiveBytes).toBe(512 * 1024 * 1024);
    expect(DEFAULT_ZIP_LIMITS.maxEntryBytes).toBe(256 * 1024 * 1024);
    expect(DEFAULT_ZIP_LIMITS.maxTotalUncompressedBytes).toBe(512 * 1024 * 1024);
    expect(formatBytes(DEFAULT_ZIP_LIMITS.maxArchiveBytes)).toBe('512 MiB');
    expect(formatBytes(DEFAULT_ZIP_LIMITS.maxEntryBytes)).toBe('256 MiB');
  });
});

describe('3MF-R7: expanded size is never called the file size', () => {
  it('no resource message on the 3MF path describes expansion as the file itself', async () => {
    const collected: string[] = [];

    const small = await buildZip([
      { name: '3D/3dmodel.model', method: 8, content: new Uint8Array(4 * 1024 * 1024) },
    ]);

    for (const zipLimits of [
      { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 1024 },
      { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 1024 },
      { ...DEFAULT_ZIP_LIMITS, maxCompressionRatio: 2 },
    ]) {
      collected.push(
        (await refusalFor(async () => read3mf(small, testReadContext(), { zipLimits }))).message,
      );
    }

    for (const message of collected) {
      // Each one says what it measured: expansion, per entry or in total.
      expect(message).toMatch(/expands/);
      // And none of them claims the FILE is that size.
      expect(message).not.toMatch(/This file is \d/);
      expect(message).not.toMatch(/^This archive is \d+(\.\d+)? [KMG]?i?B;/);
    }
  });

  it('the archive-size message, which IS about the file, says so plainly', async () => {
    const refusal = await refusalFor(async () =>
      read3mf(await valid3mf(), testReadContext(), {
        zipLimits: { ...DEFAULT_ZIP_LIMITS, maxArchiveBytes: 16 },
      }),
    );

    expect(refusal.reason).toBe(ImportRefusal.ZipArchiveTooLarge);
    expect(refusal.message).toMatch(/^This archive is \d+ B; CAD Fixer's archive limit is 16 B\.$/);
    expect(refusal.message).not.toContain('expands');
  });
});

/* ================================================ transactional behaviour == */

describe('every new refusal path leaves nothing behind', () => {
  /**
   * AT THIS LAYER the proof is that `read3mf` is a pure function: it returns a
   * document or it throws, and nothing becomes authoritative until the worker's
   * `commitImportedDocument` accepts one. The browser-level proof that a refused
   * import leaves the OPEN model untouched lives in `e2e/format-import.spec.ts`.
   */
  it('produces no document for any of the new refusals, and reads a good file afterwards', async () => {
    const productionRoot = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}">
 <resources><object id="2" type="model"><components>
  <component p:path="/3D/Objects/object_1.model" objectid="1"/>
 </components></object></resources>
 <build><item objectid="2"/></build>
</model>`;
    const requiredRoot = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" requiredextensions="p">
 <resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>
 <build><item objectid="1"/></build>
</model>`;

    for (const bytes of [
      await packageWith(productionRoot, [OBJECT_PART]),
      await packageWith(requiredRoot),
    ]) {
      await expect(read3mf(bytes, testReadContext())).rejects.toBeDefined();
      // The very next import still works: no state survived the refusal.
      const good = await read3mf(await valid3mf(), testReadContext());
      expect(good.document.parts).toHaveLength(1);
    }
  });
});
