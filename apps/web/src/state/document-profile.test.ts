import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM, type PartTransform } from '@cadfixer/mesh-core';
import { planThreeMfObjects, type ExportDocumentSnapshot } from '@cadfixer/file-formats';
import type { DocumentHandle, PartDescriptor } from '@cadfixer/geometry-runtime';
import { LengthUnit } from '@cadfixer/shared';
import { documentFeatureProfile } from './document-profile';
import type { LoadedModel, ModelSource } from './model';

/**
 * THE SCALAR SUMMARY THE CONVERSION REPORT IS JUDGED FROM.
 *
 * The two mistakes that would matter most are both about SHARING: counting a
 * thousand placements of one mesh as a thousand meshes turns every shared
 * document into a false "geometry will be duplicated" warning for 3MF, and
 * summing groups per PART rather than per MESH tells a user that twelve groups
 * will be dropped from a model that has six.
 */

function descriptor(overrides: Partial<PartDescriptor> = {}): PartDescriptor {
  return {
    partId: 'part-1',
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount: 4,
    vertexCount: 4,
    bounds: undefined,
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
    ...overrides,
  };
}

function source(overrides: Partial<ModelSource> = {}): ModelSource {
  return {
    fileName: 'model.stl',
    fileBytes: 100,
    formatId: 'stl',
    encoding: 'binary',
    unit: undefined,
    unsupportedFeatures: [],
    externalReferences: [],
    importedAt: 0,
    ...overrides,
  };
}

function model(
  parts: readonly PartDescriptor[],
  overrides: Partial<ModelSource> = {},
): LoadedModel {
  const handle: DocumentHandle = { documentId: 'doc-1', revision: 1 } as DocumentHandle;
  return {
    handle,
    parts,
    render: { parts: [] },
    source: source(overrides),
    bounds: undefined,
    triangleCount: parts.reduce((total, part) => total + part.triangleCount, 0),
    vertexCount: parts.reduce((total, part) => total + part.vertexCount, 0),
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 0,
    revision: 1,
  };
}

const TRANSLATED: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0];

describe('counting parts and meshes', () => {
  it('reports one part and one mesh for a one-part document', () => {
    const profile = documentFeatureProfile(model([descriptor()]));
    expect(profile.partCount).toBe(1);
    expect(profile.meshResourceCount).toBe(1);
  });

  it('counts DISTINCT meshes, not placements', () => {
    /*
     * A thousand placements of one mesh is ONE mesh. Counting parts here would
     * make every shared document report as "geometry will be duplicated" for
     * 3MF, where it will not be.
     */
    const parts = Array.from({ length: 1000 }, (_unused, index) =>
      descriptor({ partId: `part-${String(index + 1)}`, meshResourceIndex: 0 }),
    );
    const profile = documentFeatureProfile(model(parts));
    expect(profile.partCount).toBe(1000);
    expect(profile.meshResourceCount).toBe(1);
  });

  it('counts distinct meshes when the indices are not contiguous from zero', () => {
    const profile = documentFeatureProfile(
      model([
        descriptor({ partId: 'a', meshResourceIndex: 0 }),
        descriptor({ partId: 'b', meshResourceIndex: 2 }),
        descriptor({ partId: 'c', meshResourceIndex: 2 }),
      ]),
    );
    expect(profile.meshResourceCount).toBe(2);
  });
});

describe('placements', () => {
  it('counts only the parts whose placement is not the identity', () => {
    const profile = documentFeatureProfile(
      model([
        descriptor({ partId: 'a' }),
        descriptor({ partId: 'b', transform: TRANSLATED }),
        descriptor({ partId: 'c', transform: TRANSLATED }),
      ]),
    );
    expect(profile.nonIdentityTransformCount).toBe(2);
  });

  it('treats a negative-zero translation as a real placement', () => {
    /*
     * `Object.is`, NOT `===`, matching the 3MF writer's own identity test.
     * `-0 === 0` is true, so a placement translated by negative zero would be
     * judged the identity here and written as a placement there — and the report
     * would describe a bake that does not happen.
     */
    const negativeZero: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, -0, 0, 0];
    const profile = documentFeatureProfile(model([descriptor({ transform: negativeZero })]));
    expect(profile.nonIdentityTransformCount).toBe(1);
  });
});

describe('names', () => {
  it('separates named parts from unnamed ones', () => {
    const profile = documentFeatureProfile(
      model([
        descriptor({ partId: 'a', name: 'Bracket' }),
        descriptor({ partId: 'b' }),
        descriptor({ partId: 'c', name: '' }),
      ]),
    );
    expect(profile.namedPartCount).toBe(1);
    // AN EMPTY NAME IS NOT A NAME. It cannot be written and cannot be shown.
    expect(profile.unnamedPartCount).toBe(2);
  });
});

describe('groups and attributes are counted per DISTINCT mesh', () => {
  it('does not multiply a shared mesh group count by its placements', () => {
    /*
     * THE FAILURE THIS CATCHES is telling the user that twelve groups will be
     * dropped from a model that has six. The same reasoning `assertMeshStructure`
     * uses on import: a shared mesh is one thing, however many places it stands.
     */
    const parts = Array.from({ length: 4 }, (_unused, index) =>
      descriptor({
        partId: `part-${String(index + 1)}`,
        meshResourceIndex: 0,
        groupCount: 6,
        groupMaterialRefCount: 2,
        hasNormals: true,
        hasUvs: true,
      }),
    );
    const profile = documentFeatureProfile(model(parts));
    expect(profile.groupCount).toBe(6);
    expect(profile.groupMaterialRefCount).toBe(2);
    expect(profile.meshesWithNormals).toBe(1);
    expect(profile.meshesWithUvs).toBe(1);
  });

  it('sums across genuinely distinct meshes', () => {
    const profile = documentFeatureProfile(
      model([
        descriptor({ partId: 'a', meshResourceIndex: 0, groupCount: 2, hasNormals: true }),
        descriptor({ partId: 'b', meshResourceIndex: 1, groupCount: 3, hasUvs: true }),
      ]),
    );
    expect(profile.groupCount).toBe(5);
    expect(profile.meshesWithNormals).toBe(1);
    expect(profile.meshesWithUvs).toBe(1);
  });

  it('counts PART material references per part, because they live on the part', () => {
    /*
     * UNLIKE GROUPS. A material reference on a part is per-placement metadata in
     * 3MF's model — two placements of one mesh under two references are two
     * objects — so counting it per distinct mesh would undercount it.
     */
    const parts = Array.from({ length: 3 }, (_unused, index) =>
      descriptor({
        partId: `part-${String(index + 1)}`,
        meshResourceIndex: 0,
        materialRef: 'steel',
      }),
    );
    expect(documentFeatureProfile(model(parts)).partMaterialRefCount).toBe(3);
  });
});

describe('what the profile carries from the source', () => {
  it('mirrors the document unit and the source format', () => {
    const profile = documentFeatureProfile(
      model([descriptor()], { unit: LengthUnit.Inch, formatId: '3mf' }),
    );
    expect(profile.unit).toBe(LengthUnit.Inch);
    expect(profile.sourceFormat).toBe('3mf');
  });

  it('never defaults an unknown unit', () => {
    expect(documentFeatureProfile(model([descriptor()])).unit).toBeUndefined();
  });

  it('carries the source import warnings unchanged', () => {
    const profile = documentFeatureProfile(
      model([descriptor()], { unsupportedFeatures: ['TEXTURES', 'MATERIALS'] }),
    );
    expect(profile.sourceUnsupported).toEqual(['TEXTURES', 'MATERIALS']);
  });

  it('takes the triangle count from the model rather than re-deriving it', () => {
    const profile = documentFeatureProfile(
      model([descriptor({ triangleCount: 7 }), descriptor({ partId: 'b', triangleCount: 11 })]),
    );
    expect(profile.triangleCount).toBe(18);
  });
});

describe('the 3MF object count mirrors the writer own planner', () => {
  /**
   * The snapshot the export worker would build from the same parts.
   *
   * Geometry is irrelevant to the grouping — `planThreeMfObjects` keys on
   * (mesh resource, name, material reference) — so one empty mesh per distinct
   * index is enough to make the two sides comparable.
   */
  function snapshotFor(parts: readonly PartDescriptor[]): ExportDocumentSnapshot {
    const meshCount = Math.max(0, ...parts.map((part) => part.meshResourceIndex + 1));
    return {
      documentId: 'doc-1',
      revision: 1,
      unit: undefined,
      unitAsserted: false,
      meshes: Array.from({ length: meshCount }, () => ({
        positions: new Float32Array(0),
        indices: new Uint32Array(0),
      })),
      parts: parts.map((part) => ({
        partId: part.partId,
        meshResourceIndex: part.meshResourceIndex,
        transform: part.transform,
        ...(part.name === undefined ? {} : { name: part.name }),
        ...(part.materialRef === undefined ? {} : { materialRef: part.materialRef }),
      })),
    };
  }

  /*
   * THE MIRROR EXISTS BECAUSE IMPORTING THE PLANNER WOULD PULL THE 3MF WRITER
   * INTO THE MAIN-THREAD BUNDLE. That makes it a second copy of one rule, and a
   * second copy of a rule is a drift bug with a delay on it — so this asserts
   * the two agree across every shape the grouping key can distinguish.
   */
  const CASES: readonly { readonly name: string; readonly parts: readonly PartDescriptor[] }[] = [
    { name: 'one part', parts: [descriptor()] },
    {
      name: 'two independent meshes',
      parts: [
        descriptor({ partId: 'a', meshResourceIndex: 0 }),
        descriptor({ partId: 'b', meshResourceIndex: 1 }),
      ],
    },
    {
      name: 'three placements of one mesh, all anonymous',
      parts: ['a', 'b', 'c'].map((id) => descriptor({ partId: id, meshResourceIndex: 0 })),
    },
    {
      name: 'three placements of one mesh under three names',
      parts: ['a', 'b', 'c'].map((id) =>
        descriptor({ partId: id, meshResourceIndex: 0, name: `Part ${id}` }),
      ),
    },
    {
      name: 'placements that agree on a name',
      parts: ['a', 'b', 'c'].map((id) =>
        descriptor({ partId: id, meshResourceIndex: 0, name: 'Repeated' }),
      ),
    },
    {
      name: 'placements split by material reference alone',
      parts: [
        descriptor({ partId: 'a', meshResourceIndex: 0, name: 'Same', materialRef: 'steel' }),
        descriptor({ partId: 'b', meshResourceIndex: 0, name: 'Same', materialRef: 'brass' }),
        descriptor({ partId: 'c', meshResourceIndex: 0, name: 'Same', materialRef: 'steel' }),
      ],
    },
    {
      name: 'a named placement beside anonymous ones',
      parts: [
        descriptor({ partId: 'a', meshResourceIndex: 0 }),
        descriptor({ partId: 'b', meshResourceIndex: 0 }),
        descriptor({ partId: 'c', meshResourceIndex: 0, name: 'Special' }),
      ],
    },
  ];

  for (const testCase of CASES) {
    it(`agrees with planThreeMfObjects for ${testCase.name}`, () => {
      expect(documentFeatureProfile(model(testCase.parts)).threeMfObjectCount).toBe(
        planThreeMfObjects(snapshotFor(testCase.parts)).length,
      );
    });
  }

  it('never claims more sharing than the writer will deliver', () => {
    /*
     * THE DIRECTION THAT MATTERS. Over-counting objects understates sharing,
     * which is merely pessimistic; UNDER-counting them would let the report
     * promise that a thousand differently-named placements reuse one copy of the
     * geometry, when the writer is about to emit a thousand.
     */
    for (const testCase of CASES) {
      const profile = documentFeatureProfile(model(testCase.parts));
      expect(profile.threeMfObjectCount).toBeGreaterThanOrEqual(profile.meshResourceCount);
      expect(profile.threeMfObjectCount).toBeLessThanOrEqual(profile.partCount);
    }
  });
});
