import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError, LengthUnit } from '@cadfixer/shared';
import {
  createIndexArray,
  createPositionArray,
  distinctMeshes,
  IDENTITY_PART_TRANSFORM,
  partId,
  type CanonicalMesh,
  type GeometryDocument,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { MeshFormatId } from '../formats';
import { ImportRefusal, refusalOf } from '../import-errors';
import { read3mf } from '../threemf/threemf-reader';
import {
  analyseConversion,
  CompatibilityDisposition,
  CompatibilityFeature,
  ConversionVerdict,
  EXPORT_FORMATS,
  ExportFormat,
  type DocumentFeatureProfile,
} from './compatibility';
import {
  ExportObservation,
  exportSnapshotOf,
  planThreeMfObjects,
  type ExportDocumentSnapshot,
} from './export-contract';
import { exportDocument } from './export-document';
import { checkResourceReferences, inspect3mf } from './threemf-oracle';
import { testExportReadContext, testWriteContextWithDeflate } from './test-context';

/**
 * PR01 – PR11: 3MF PROPERTY-REFERENCE CONFORMANCE.
 *
 * THE DEFECT THIS SUITE EXISTS FOR. CAD Fixer's 3MF writer emitted
 * `<object pid="...">` carrying the document's opaque `materialRef`, while
 * writing no property resource for it to name. 3MF core defines `object@pid`
 * as an `ST_ResourceID` — a positive integer identifying a property-group
 * resource that must exist — so every such file contained a dangling reference,
 * and a reference that did not originate as a number (`pid="steel-brushed"`)
 * was not even lexically an id.
 *
 * IT SURVIVED EVERY EXISTING GATE, which is the part worth remembering. The
 * writer's own observations claimed the reference was preserved. Parse-back
 * validation passed, because our reader accepted the dangling `pid` as an
 * opaque string and handed it back unchanged — writer and reader sharing one
 * blind spot. The independent oracle checked ZIP structure, CRCs and XML
 * well-formedness, none of which a dangling reference disturbs.
 *
 * So this suite closes it at four independent points: the writer emits none,
 * the compatibility report says so, the ORACLE now validates references and is
 * proven to reject a bad one, and the READER refuses a dangling reference on
 * import instead of carrying it.
 */

/* ------------------------------------------------------------- fixtures -- */

function mesh(): CanonicalMesh {
  const positions = createPositionArray(12);
  positions.set([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
  const indices = createIndexArray(12);
  indices.set([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  return { positions, indices, metadata: { sourceFormat: MeshFormatId.ThreeMf } };
}

function translation(x: number): PartTransform {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1, x, 0, 0];
}

interface PartInput {
  readonly mesh: CanonicalMesh;
  readonly transform?: PartTransform;
  readonly name?: string;
  readonly materialRef?: string;
}

function documentOf(parts: readonly PartInput[]): GeometryDocument {
  return {
    unit: LengthUnit.Millimeter,
    parts: parts.map((part, index) => ({
      id: partId(`part-${String(index + 1)}`),
      mesh: part.mesh,
      transform: part.transform ?? IDENTITY_PART_TRANSFORM,
      ...(part.name === undefined ? {} : { name: part.name }),
      ...(part.materialRef === undefined ? {} : { materialRef: part.materialRef }),
    })),
  };
}

async function export3mf(document: GeometryDocument): Promise<{
  bytes: Uint8Array;
  observations: readonly ExportObservation[];
  modelXml: string;
  problems: readonly string[];
}> {
  const written = await exportDocument({
    snapshot: exportSnapshotOf(document, 'doc-1', 1),
    target: MeshFormatId.ThreeMf,
    write: testWriteContextWithDeflate(),
    read: testExportReadContext(),
  });
  const inspected = await inspect3mf(written.bytes);
  return {
    bytes: written.bytes,
    observations: written.metadata.observations,
    modelXml: inspected.modelXml ?? '',
    problems: inspected.problems,
  };
}

const EMPTY_PROFILE: DocumentFeatureProfile = {
  partCount: 1,
  meshResourceCount: 1,
  threeMfObjectCount: 1,
  triangleCount: 4,
  unit: LengthUnit.Millimeter,
  nonIdentityTransformCount: 0,
  namedPartCount: 0,
  unnamedPartCount: 1,
  groupCount: 0,
  groupMaterialRefCount: 0,
  partMaterialRefCount: 0,
  meshesWithNormals: 0,
  meshesWithUvs: 0,
  sourceUnsupported: [],
  namesUnwritableAsObj: 0,
  namesUnwritableAsXml: 0,
};

function profile(overrides: Partial<DocumentFeatureProfile> = {}): DocumentFeatureProfile {
  return { ...EMPTY_PROFILE, ...overrides };
}

/* ------------------------------------------------------------------ PR01 -- */

describe('PR01 — a document with no material reference', () => {
  it('writes no pid at all', async () => {
    const written = await export3mf(documentOf([{ mesh: mesh(), name: 'Bracket' }]));
    expect(written.modelXml).not.toContain('pid=');
    expect(written.modelXml).not.toContain('pindex=');
    expect(written.problems).toEqual([]);
  });

  it('says nothing about materials', async () => {
    const written = await export3mf(documentOf([{ mesh: mesh() }]));
    expect(written.observations).not.toContain(ExportObservation.MaterialReferencesOmitted);
    expect(written.observations).not.toContain(ExportObservation.MaterialReferencesPreserved);
  });
});

/* ------------------------------------------------------------------ PR02 -- */

describe('PR02 — a document WITH an opaque material reference', () => {
  it.each([
    ['a numeric reference', '5'],
    ['a name from an OBJ-like source', 'steel-brushed'],
    ['a reference that is not an id at all', 'Anodised Aluminium'],
  ])('writes no pid for %s', async (_label, materialRef) => {
    /*
     * BOTH SHAPES USED TO REACH THE FILE. `pid="5"` was dangling; the other two
     * were not even lexical resource ids. A conforming consumer rejects all
     * three, and CAD Fixer produced all three.
     */
    const written = await export3mf(documentOf([{ mesh: mesh(), materialRef }]));

    expect(written.modelXml).not.toContain('pid=');
    /*
     * ASSERTED ONLY FOR VALUES THAT ARE NOT PLAIN DIGITS. A bare `5` appears
     * legitimately in coordinates, so demanding its absence would be asserting
     * something about the geometry rather than about the material reference.
     */
    if (!/^[0-9]+$/.test(materialRef)) {
      expect(written.modelXml).not.toContain(materialRef);
    }
    expect(written.problems).toEqual([]);
  });

  it('records the omission rather than claiming preservation', async () => {
    const written = await export3mf(documentOf([{ mesh: mesh(), materialRef: '5' }]));
    expect(written.observations).toContain(ExportObservation.MaterialReferencesOmitted);
    expect(written.observations).not.toContain(ExportObservation.MaterialReferencesPreserved);
  });

  it('still writes the geometry, the placement and the name', async () => {
    // THE LOSS IS THE REFERENCE, NOTHING ELSE. Dropping a material must not
    // quietly cost the user anything the format can carry.
    const written = await export3mf(
      documentOf([{ mesh: mesh(), name: 'Bracket', transform: translation(40), materialRef: '5' }]),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());

    expect(parsed.document.parts[0]?.name).toBe('Bracket');
    expect([...(parsed.document.parts[0]?.transform ?? [])]).toEqual([...translation(40)]);
    expect(parsed.document.unit).toBe(LengthUnit.Millimeter);
    expect((parsed.document.parts[0]?.mesh.indices.length ?? 0) / 3).toBe(4);
    expect(parsed.document.parts[0]?.materialRef).toBeUndefined();
  });

  it('reports the loss in the compatibility report, for every target', () => {
    for (const target of EXPORT_FORMATS) {
      const report = analyseConversion({ profile: profile({ partMaterialRefCount: 1 }), target });
      const fact = report.losses.find(
        (entry) => entry.feature === CompatibilityFeature.PartMaterialReferences,
      );
      expect(fact?.disposition, `target ${target}`).toBe(CompatibilityDisposition.Dropped);
      expect(report.verdict).not.toBe(ConversionVerdict.Lossless);
    }
  });
});

/* ------------------------------------------------------------------ PR03 -- */

describe('PR03 — sharing is not split by metadata that is never written', () => {
  it('MPID01: same mesh, same name, two material references — ONE object', async () => {
    /*
     * SPLITTING HERE WOULD COST MEGABYTES FOR NOTHING. The object plan used to
     * key on the material reference, which was right while a `pid` was written:
     * two references meant two `<object>` elements. Now that nothing is written,
     * duplicating the geometry would preserve a distinction the file cannot
     * express.
     */
    const shared = mesh();
    const document = documentOf([
      { mesh: shared, name: 'Bracket', materialRef: '5' },
      { mesh: shared, name: 'Bracket', materialRef: '9', transform: translation(40) },
    ]);

    expect(planThreeMfObjects(exportSnapshotOf(document, 'doc-1', 1))).toHaveLength(1);

    const written = await export3mf(document);
    const parsed = await read3mf(written.bytes, testExportReadContext());

    expect(distinctMeshes(parsed.document)).toHaveLength(1);
    expect(parsed.document.parts).toHaveLength(2);
    expect(written.observations).toContain(ExportObservation.SharingPreserved);
    expect(written.observations).toContain(ExportObservation.MaterialReferencesOmitted);
  });

  it('MPID02: same mesh, different NAMES — still two objects', async () => {
    // A NAME IS WRITTEN, so it still splits. The rule is exactly "the key holds
    // what the object element carries".
    const shared = mesh();
    const document = documentOf([
      { mesh: shared, name: 'Left' },
      { mesh: shared, name: 'Right', transform: translation(40) },
    ]);

    expect(planThreeMfObjects(exportSnapshotOf(document, 'doc-1', 1))).toHaveLength(2);

    const written = await export3mf(document);
    const parsed = await read3mf(written.bytes, testExportReadContext());
    expect(distinctMeshes(parsed.document)).toHaveLength(2);
    expect(parsed.document.parts.map((part) => part.name)).toEqual(['Left', 'Right']);
  });

  it('keeps a thousand placements at one object even with differing references', () => {
    const shared = mesh();
    const document = documentOf(
      Array.from({ length: 1000 }, (_unused, index) => ({
        mesh: shared,
        name: 'Repeated',
        materialRef: String(index + 1),
        transform: translation(index * 20),
      })),
    );
    expect(planThreeMfObjects(exportSnapshotOf(document, 'doc-1', 1))).toHaveLength(1);
  });
});

/* ------------------------------------------------------------ PR04/PR05 -- */

describe('PR04 and PR05 — the independent oracle validates references', () => {
  it('PR04: a generated 3MF passes the reference checks', async () => {
    const written = await export3mf(
      documentOf([
        { mesh: mesh(), name: 'Left', materialRef: '5' },
        { mesh: mesh(), name: 'Right', transform: translation(40) },
      ]),
    );
    expect(written.problems).toEqual([]);
    expect(checkResourceReferences(written.modelXml)).toEqual([]);
  });

  it('PR05: a mutated file with a dangling pid is REJECTED', async () => {
    /*
     * THE NON-VACUITY PROOF. An oracle nobody has seen fail is not evidence —
     * and this oracle passed the defective writer for the whole of Stage
     * 4A-2B3. The mutation is exactly what the writer used to emit.
     */
    const written = await export3mf(documentOf([{ mesh: mesh(), name: 'Bracket' }]));
    const mutated = written.modelXml.replace('<object id="1"', '<object id="1" pid="5"');
    expect(mutated).not.toBe(written.modelXml);

    const problems = checkResourceReferences(mutated);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('dangling property reference');
  });

  it('PR05: a pid that is not a lexical resource id is REJECTED', async () => {
    const written = await export3mf(documentOf([{ mesh: mesh() }]));
    const mutated = written.modelXml.replace(
      '<object id="1"',
      '<object id="1" pid="steel-brushed"',
    );
    expect(checkResourceReferences(mutated).join(' ')).toContain('not a positive integer');
  });

  it('PR05: a pid pointing at an OBJECT rather than a property group is REJECTED', async () => {
    const written = await export3mf(
      documentOf([
        { mesh: mesh(), name: 'A' },
        { mesh: mesh(), name: 'B' },
      ]),
    );
    const mutated = written.modelXml.replace('<object id="2"', '<object id="2" pid="1"');
    expect(checkResourceReferences(mutated).join(' ')).toContain('dangling property reference');
  });

  it('PR05: pindex without pid is REJECTED', async () => {
    const written = await export3mf(documentOf([{ mesh: mesh() }]));
    const mutated = written.modelXml.replace('<object id="1"', '<object id="1" pindex="0"');
    expect(checkResourceReferences(mutated).join(' ')).toContain('but no pid');
  });

  it('accepts a pid that DOES resolve, so the check is not simply "no pid"', () => {
    /*
     * THE OTHER HALF OF NON-VACUITY. A checker that rejected every `pid` would
     * pass PR05 while being useless — it has to accept a well-formed reference.
     */
    const xml =
      '<model unit="millimeter"><resources>' +
      '<basematerials id="7"><base name="Steel" displaycolor="#808080FF"/></basematerials>' +
      '<object id="1" type="model" pid="7"><mesh/></object>' +
      '</resources><build><item objectid="1"/></build></model>';
    expect(checkResourceReferences(xml)).toEqual([]);
  });

  it('rejects duplicate ids across the whole resource space', () => {
    const xml =
      '<model unit="millimeter"><resources>' +
      '<basematerials id="1"><base name="Steel" displaycolor="#808080FF"/></basematerials>' +
      '<object id="1" type="model"><mesh/></object>' +
      '</resources><build><item objectid="1"/></build></model>';
    expect(checkResourceReferences(xml).join(' ')).toContain('duplicate resource id');
  });

  it('rejects a build item naming an object that does not exist', () => {
    const xml =
      '<model unit="millimeter"><resources>' +
      '<object id="1" type="model"><mesh/></object>' +
      '</resources><build><item objectid="9"/></build></model>';
    expect(checkResourceReferences(xml).join(' ')).toContain('references no object resource');
  });
});

/* ------------------------------------------------------------------ PR09 -- */

describe('PR09 — parse-back validation catches a written property reference', () => {
  it('refuses if a material reference ever comes back from a file we wrote', async () => {
    /*
     * THE REGRESSION GATE INSIDE THE EXPORT TRANSACTION. `validate3mfRoundTrip`
     * now asserts the ABSENCE of a material reference — previously it asserted
     * its presence, which is how writer and reader agreed about a malformed
     * file. This proves the assertion is live by feeding the validator a parsed
     * document that carries one.
     */
    const { validate3mfRoundTrip } = await import('./validate');
    const snapshot: ExportDocumentSnapshot = exportSnapshotOf(
      documentOf([{ mesh: mesh(), name: 'Bracket' }]),
      'doc-1',
      1,
    );
    const parsedWithMaterial: GeometryDocument = {
      unit: LengthUnit.Millimeter,
      parts: [
        {
          id: partId('part-1'),
          mesh: mesh(),
          transform: IDENTITY_PART_TRANSFORM,
          name: 'Bracket',
          materialRef: '5',
        },
      ],
    };

    let caught: unknown;
    try {
      validate3mfRoundTrip(snapshot, parsedWithMaterial);
    } catch (cause) {
      caught = cause;
    }
    expect(isAppError(caught), 'expected the validator to refuse').toBe(true);
    if (isAppError(caught)) expect(caught.code).toBe(AppErrorCode.Internal);
  });
});

/* ----------------------------------------------------------- PR10 / PR11 -- */

describe('PR10 and PR11 — same-format 3MF verdicts are data-driven', () => {
  it('PR10: a 3MF holding a material reference is NOT lossless as 3MF', async () => {
    const report = analyseConversion({
      profile: profile({ partMaterialRefCount: 1, sourceFormat: MeshFormatId.ThreeMf }),
      target: ExportFormat.ThreeMf,
    });
    expect(report.verdict).toBe(ConversionVerdict.LossyMetadata);
    expect(
      report.losses.some((fact) => fact.feature === CompatibilityFeature.PartMaterialReferences),
    ).toBe(true);

    // And the file really does lose it.
    const written = await export3mf(documentOf([{ mesh: mesh(), materialRef: '5' }]));
    expect(written.modelXml).not.toContain('pid=');
  });

  it('PR11: a 3MF without one is still lossless as 3MF', () => {
    const report = analyseConversion({
      profile: profile({
        sourceFormat: MeshFormatId.ThreeMf,
        namedPartCount: 1,
        unnamedPartCount: 0,
      }),
      target: ExportFormat.ThreeMf,
    });
    expect(report.verdict).toBe(ConversionVerdict.Lossless);
    expect(report.losses).toEqual([]);
  });

  it('does not warn about materials on a document that has none', () => {
    for (const target of EXPORT_FORMATS) {
      const report = analyseConversion({ profile: profile(), target });
      expect(
        report.losses.some((fact) => fact.feature === CompatibilityFeature.PartMaterialReferences),
      ).toBe(false);
    }
  });
});

/* --------------------------------------------------------- PR06 reference -- */

describe('PR06 — the reader refuses a dangling property reference', () => {
  it('carries a typed refusal, asserted by CODE rather than by wording', async () => {
    /*
     * The full lexical and reference matrix lives in `threemf-reader.test.ts`
     * beside the rest of the import corpus. This asserts the contract exists
     * from the export side, because the export path depends on it: a document
     * can only carry a material reference that the reader admitted.
     */
    const { buildZip, modelXml, valid3mf } = await import('../threemf/zip-fixtures');
    expect(typeof buildZip).toBe('function');

    let caught: unknown;
    try {
      await read3mf(
        await valid3mf(
          modelXml({
            resources: '<object id="1" type="model" pid="7"><mesh/></object>',
          }),
        ),
        testExportReadContext(),
      );
    } catch (cause) {
      caught = cause;
    }
    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) {
      expect(refusalOf(caught)).toBe(ImportRefusal.ThreeMfDanglingPropertyReference);
    }
  });
});
