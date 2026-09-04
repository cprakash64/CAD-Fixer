import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError, LengthUnit } from '@cadfixer/shared';
import { createIndexArray, createPositionArray, meshByteLength } from './mesh';
import type { CanonicalMesh } from './mesh';
import {
  applyPartTransform,
  composePartTransforms,
  distinctMeshes,
  documentTriangleCount,
  documentVertexCount,
  findPart,
  IDENTITY_PART_TRANSFORM,
  partId,
  partIndexOf,
  singlePartDocument,
  transformBounds,
  unionBounds,
  withPartMesh,
  withPartTransform,
  type GeometryDocument,
  type PartTransform,
} from './document';
import {
  assertGeometryDocument,
  DocumentValidationCode,
  isValidPartTransform,
  validateGeometryDocument,
} from './document-validation';
import { computeBounds } from './analysis';
import {
  mp01TwoIndependentParts,
  mp02SharedGeometry,
  mp03DistinctTransforms,
  mp08SharedPlacements,
  makePart,
  tetrahedronMesh,
  translation,
} from './document-fixtures';

/**
 * THE DOCUMENT MODEL'S OWN GUARANTEES.
 *
 * Everything here is about the two things the Stage 4A research said the
 * document had to get right and that nothing above it can fix afterwards:
 * geometry is SHARED rather than copied, and a candidate document that is not
 * well formed never becomes authoritative.
 */

function mesh(triangles = 1): CanonicalMesh {
  return {
    positions: createPositionArray(triangles * 9),
    indices: createIndexArray(triangles * 3),
    metadata: { sourceFormat: 'stl' },
  };
}

describe('single-part documents', () => {
  it('DF01: an STL-shaped import produces one part, identity placement, unknown unit', () => {
    const source = mesh(4);

    const document = singlePartDocument(source);

    expect(document.parts).toHaveLength(1);
    // The SAME OBJECT. Wrapping a mesh in a document copies nothing.
    expect(document.parts[0]?.mesh).toBe(source);
    expect(document.parts[0]?.transform).toEqual(IDENTITY_PART_TRANSFORM);
    // Unknown, and ABSENT rather than defaulted. STL states no unit, and
    // millimetres would be a guess presented as a fact.
    expect(document.unit).toBeUndefined();
    expect('unit' in document).toBe(false);
  });

  it('carries a unit only when one was actually stated', () => {
    const withUnit = singlePartDocument(mesh(), { unit: LengthUnit.Inch });
    expect(withUnit.unit).toBe(LengthUnit.Inch);
  });
});

describe('structural sharing', () => {
  it('MP02: two parts hold the SAME mesh object, not two copies', () => {
    const document = mp02SharedGeometry();

    expect(document.parts[0]?.mesh).toBe(document.parts[1]?.mesh);
    expect(distinctMeshes(document)).toHaveLength(1);
  });

  it('MP08: a thousand placements cost one mesh', () => {
    const document = mp08SharedPlacements(1000);
    const meshes = distinctMeshes(document);

    expect(document.parts).toHaveLength(1000);
    expect(meshes).toHaveLength(1);

    // The counts still describe a thousand parts, because they do exist — it is
    // only the GEOMETRY that is shared.
    const only = meshes[0];
    if (only === undefined) throw new Error('expected a mesh');
    expect(documentTriangleCount(document)).toBe(4000);
    expect(documentVertexCount(document)).toBe(12_000);

    // And the bytes: one mesh's worth, not a thousand.
    let bytes = 0;
    for (const shared of meshes) bytes += meshByteLength(shared);
    expect(bytes).toBe(meshByteLength(only));
  });

  it('replacing one part’s mesh carries every other part across BY REFERENCE', () => {
    const document = mp01TwoIndependentParts();
    const b = document.parts[1];
    if (b === undefined) throw new Error('expected part b');

    const replacement = tetrahedronMesh(5);
    const next = withPartMesh(document, partId('a'), replacement);
    if (next === undefined) throw new Error('expected a rewritten document');

    expect(next.parts[0]?.mesh).toBe(replacement);
    // DF19/DF25 at the model level: the untouched part is the SAME OBJECT, so
    // nothing about it was cloned, rewritten, or re-uploaded.
    expect(next.parts[1]).toBe(b);
    expect(next.parts[1]?.mesh).toBe(b.mesh);
    // And the original document is untouched: this is a rewrite, not a mutation.
    expect(document.parts[0]?.mesh).not.toBe(replacement);
  });

  it('a transform-only change leaves the mesh object and its bytes alone', () => {
    const document = mp01TwoIndependentParts();
    const before = document.parts[0]?.mesh;
    const bytesBefore = before === undefined ? [] : [...before.positions];

    const moved = withPartTransform(document, partId('a'), translation(1, 2, 3));
    if (moved === undefined) throw new Error('expected a rewritten document');

    expect(moved.parts[0]?.transform).toEqual(translation(1, 2, 3));
    expect(moved.parts[0]?.mesh).toBe(before);
    expect([...(moved.parts[0]?.mesh.positions ?? [])]).toEqual(bytesBefore);
  });

  it('refuses to rewrite a part the document does not have', () => {
    // `undefined` rather than a silent no-op document, so a caller cannot
    // mistake "nothing happened" for "the edit landed".
    expect(withPartMesh(mp01TwoIndependentParts(), partId('missing'), mesh())).toBeUndefined();
    expect(
      withPartTransform(mp01TwoIndependentParts(), partId('missing'), IDENTITY_PART_TRANSFORM),
    ).toBeUndefined();
  });
});

describe('part lookup', () => {
  it('finds a part by id and reports its position', () => {
    const document = mp03DistinctTransforms();

    expect(findPart(document, partId('b'))?.id).toBe('b');
    expect(partIndexOf(document, partId('c'))).toBe(2);
  });

  it('reports a missing part rather than returning the first one', () => {
    const document = mp03DistinctTransforms();

    expect(findPart(document, partId('zzz'))).toBeUndefined();
    expect(partIndexOf(document, partId('zzz'))).toBe(-1);
  });
});

describe('placement arithmetic', () => {
  it('transforms all eight corners, not just the extremes', () => {
    /*
     * THE CLASSIC BUG. Under a 90-degree rotation about Z, transforming only
     * `min` and `max` produces a box whose min is greater than its max on one
     * axis — and the model gets silently clipped. Eight corners is the only
     * arithmetic that is right.
     *
     * The rotation is expressed in 3MF's ROW-VECTOR convention, so
     * `[0 -1 0, 1 0 0, 0 0 1]` sends (x, y, z) to (y, -x, z).
     */
    const rotateZ: PartTransform = [0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0];
    const box = computeBounds({
      positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 2, 0]),
      indices: new Uint32Array([0, 1, 2]),
      metadata: {},
    });
    if (box === undefined) throw new Error('expected bounds');

    const rotated = transformBounds(box, rotateZ);

    // x' = y over [0, 2]; y' = -x over [-4, 0].
    expect(rotated.min[0]).toBeCloseTo(0, 10);
    expect(rotated.max[0]).toBeCloseTo(2, 10);
    expect(rotated.min[1]).toBeCloseTo(-4, 10);
    expect(rotated.max[1]).toBeCloseTo(0, 10);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(rotated.min[axis] ?? 0).toBeLessThanOrEqual(rotated.max[axis] ?? 0);
    }
  });

  it('reads a placement exactly as the qualified 3MF reference does', () => {
    /*
     * RT05 FROM `experiments/format-io/threemf-matrix.mjs`, asserted against
     * production. The research reference places (1,0,0) under this transform at
     * (0, 2, 0); reading the same twelve numbers as column vectors would give
     * (0, -2, 0), and no fixture made of identity and translation can tell the
     * two apart. Stage 4A-2A had only such fixtures and read them the other way
     * round.
     */
    const rotScale: PartTransform = [0, 2, 0, -2, 0, 0, 0, 0, 2, 0, 0, 0];

    const placed = applyPartTransform(rotScale, 1, 0, 0);

    expect(placed[0]).toBeCloseTo(0, 12);
    expect(placed[1]).toBeCloseTo(2, 12);
    expect(placed[2]).toBeCloseTo(0, 12);
  });

  it('composes nested placements the way 3MF components nest', () => {
    /*
     * RT10's composition: an outer placement of (0, +5) applied after an inner
     * placement of (+10, 0) puts the leaf at (10, 5). Getting the operand order
     * backwards produces the same answer for pure translations and a different
     * one the moment either level rotates, so the rotation is included.
     */
    const outer: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0];
    const inner: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0];

    const composed = composePartTransforms(outer, inner);
    const placed = applyPartTransform(composed, 0, 0, 0);

    expect(placed[0]).toBeCloseTo(10, 12);
    expect(placed[1]).toBeCloseTo(5, 12);

    // Composition must equal applying the two in order, for any point.
    const stepwise = applyPartTransform(outer, ...applyPartTransform(inner, 2, -3, 4));
    const direct = applyPartTransform(composed, 2, -3, 4);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(direct[axis]).toBeCloseTo(stepwise[axis] ?? 0, 10);
    }
  });

  it('composes a rotation with a translation in the right order', () => {
    // Rotate (x,y) -> (y,-x), then translate by (+10, 0). A reversed order
    // would translate first and rotate the offset with it.
    const outer: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0];
    const inner: PartTransform = [0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0];

    const placed = applyPartTransform(composePartTransforms(outer, inner), 1, 0, 0);

    expect(placed[0]).toBeCloseTo(10, 12);
    expect(placed[1]).toBeCloseTo(-1, 12);
  });

  it('unions two boxes into the smallest containing one', () => {
    const a = transformBounds(
      {
        min: [0, 0, 0],
        max: [1, 1, 1],
        size: [1, 1, 1],
        center: [0.5, 0.5, 0.5],
        radius: 0.87,
      },
      IDENTITY_PART_TRANSFORM,
    );
    const b = transformBounds(a, translation(10, 0, 0));

    const both = unionBounds(a, b);
    expect(both?.min).toEqual([0, 0, 0]);
    expect(both?.max).toEqual([11, 1, 1]);
    // Either side missing returns the other rather than inventing a box.
    expect(unionBounds(undefined, b)).toBe(b);
    expect(unionBounds(a, undefined)).toBe(a);
    expect(unionBounds(undefined, undefined)).toBeUndefined();
  });
});

describe('document validation', () => {
  it('accepts a well-formed multi-part document', () => {
    expect(validateGeometryDocument(mp01TwoIndependentParts()).valid).toBe(true);
  });

  it('refuses two parts claiming the same identifier', () => {
    const shared = tetrahedronMesh();
    const document: GeometryDocument = {
      parts: [makePart('a', shared), makePart('a', shared)],
    };

    const report = validateGeometryDocument(document);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain(
      DocumentValidationCode.DuplicatePartId,
    );
  });

  it('refuses a document with no parts at all', () => {
    const report = validateGeometryDocument({ parts: [] });
    expect(report.issues.map((issue) => issue.code)).toContain(DocumentValidationCode.NoParts);
  });

  it('refuses a non-finite placement', () => {
    const broken: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, Number.NaN, 0, 0];
    const document: GeometryDocument = {
      parts: [makePart('a', tetrahedronMesh(), { transform: broken })],
    };

    expect(isValidPartTransform(broken)).toBe(false);
    expect(validateGeometryDocument(document).issues.map((issue) => issue.code)).toContain(
      DocumentValidationCode.InvalidTransform,
    );
  });

  it('refuses a transform with the wrong number of values', () => {
    // The parameter is `readonly number[]` precisely so this is answerable: a
    // document built from an asserted wire payload can carry any array.
    expect(isValidPartTransform([1, 0, 0])).toBe(false);
    expect(isValidPartTransform([...IDENTITY_PART_TRANSFORM])).toBe(true);
  });

  it('refuses a unit CAD Fixer does not recognise', () => {
    const document = {
      unit: 'furlong',
      parts: [makePart('a', tetrahedronMesh())],
    } as unknown as GeometryDocument;

    expect(validateGeometryDocument(document).issues.map((issue) => issue.code)).toContain(
      DocumentValidationCode.InvalidUnit,
    );
  });

  it('refuses a part whose mesh is not well formed', () => {
    const broken: CanonicalMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      // References a vertex that does not exist.
      indices: new Uint32Array([0, 1, 99]),
      metadata: {},
    };

    const report = validateGeometryDocument({ parts: [makePart('a', broken)] });
    expect(report.issues.map((issue) => issue.code)).toContain(
      DocumentValidationCode.InvalidPartMesh,
    );
  });

  it('enforces a part-count ceiling rather than accepting anything a file declares', () => {
    const document = mp08SharedPlacements(20);

    const report = validateGeometryDocument(document, {
      limits: {
        maxParts: 4,
        maxTotalTriangles: 1e9,
        maxTotalVertices: 1e9,
        maxTotalGeometryBytes: 1e12,
        maxNameLength: 512,
        maxMaterialRefLength: 512,
      },
    });

    expect(report.issues.map((issue) => issue.code)).toContain(DocumentValidationCode.TooManyParts);
  });

  it('enforces triangle, vertex and byte ceilings across the WHOLE document', () => {
    // Splitting a model into parts must not be a way around a limit one mesh
    // could not have passed.
    const document = mp01TwoIndependentParts();
    const tight = {
      maxParts: 4096,
      maxTotalTriangles: 1,
      maxTotalVertices: 1,
      maxTotalGeometryBytes: 1,
      maxNameLength: 512,
      maxMaterialRefLength: 512,
    };

    const codes = validateGeometryDocument(document, { limits: tight }).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain(DocumentValidationCode.TooManyTriangles);
    expect(codes).toContain(DocumentValidationCode.TooManyVertices);
    expect(codes).toContain(DocumentValidationCode.TooManyBytes);
  });

  it('bounds part names and material references', () => {
    const document: GeometryDocument = {
      parts: [
        {
          id: partId('a'),
          mesh: tetrahedronMesh(),
          transform: IDENTITY_PART_TRANSFORM,
          name: 'x'.repeat(600),
          materialRef: 'y'.repeat(600),
        },
      ],
    };

    const codes = validateGeometryDocument(document).issues.map((issue) => issue.code);
    expect(codes).toContain(DocumentValidationCode.NameTooLong);
    expect(codes).toContain(DocumentValidationCode.MaterialRefTooLong);
  });

  it('counts shared geometry once when budgeting bytes', () => {
    const document = mp08SharedPlacements(500);
    const one = distinctMeshes(document)[0];
    if (one === undefined) throw new Error('expected a mesh');

    expect(validateGeometryDocument(document).geometryBytes).toBe(meshByteLength(one));
  });

  it('assertGeometryDocument throws a typed error on a malformed candidate', () => {
    const shared = tetrahedronMesh();
    const document: GeometryDocument = {
      parts: [makePart('a', shared), makePart('a', shared)],
    };

    let caught: unknown;
    try {
      assertGeometryDocument(document, 'test import');
    } catch (cause) {
      caught = cause;
    }

    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(caught.code).toBe(AppErrorCode.GeometryValidationFailed);
    expect(String(caught.details.codes)).toContain(DocumentValidationCode.DuplicatePartId);
  });

  it('assertGeometryDocument accepts a valid document silently', () => {
    expect(() => {
      assertGeometryDocument(mp02SharedGeometry(), 'test import');
    }).not.toThrow();
  });
});
