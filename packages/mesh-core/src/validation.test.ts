import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError, LengthUnit } from '@cadfixer/shared';
import { IDENTITY_MATRIX4, type CanonicalMesh } from './mesh';
import {
  assertMeshStructure,
  MeshValidationCode,
  MeshValidationSeverity,
  validateMeshStructure,
} from './validation';

/** A single valid triangle. Tests mutate copies of this to introduce one defect at a time. */
function validTriangle(overrides: Partial<CanonicalMesh> = {}): CanonicalMesh {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    metadata: { transform: IDENTITY_MATRIX4, unit: LengthUnit.Millimeter },
    ...overrides,
  };
}

function codesOf(mesh: CanonicalMesh): readonly string[] {
  return validateMeshStructure(mesh).issues.map((issue) => issue.code);
}

describe('validateMeshStructure', () => {
  it('accepts a well-formed triangle and reports derived counts', () => {
    const report = validateMeshStructure(validTriangle());

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.vertexCount).toBe(3);
    expect(report.triangleCount).toBe(1);
  });

  it('rejects a position buffer that is not a whole number of triplets', () => {
    const mesh = validTriangle({ positions: new Float32Array([0, 0, 0, 1, 0]) });
    expect(codesOf(mesh)).toContain(MeshValidationCode.PositionsNotTriplets);
    expect(validateMeshStructure(mesh).valid).toBe(false);
  });

  it('rejects an index buffer that is not a whole number of triangles', () => {
    const mesh = validTriangle({ indices: new Uint32Array([0, 1]) });
    expect(codesOf(mesh)).toContain(MeshValidationCode.IndicesNotTriplets);
  });

  it('rejects indices that point past the end of the position buffer', () => {
    const mesh = validTriangle({ indices: new Uint32Array([0, 1, 7]) });

    const report = validateMeshStructure(mesh);

    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain(MeshValidationCode.IndexOutOfRange);
  });

  it('rejects NaN and infinite coordinates', () => {
    const mesh = validTriangle({
      positions: new Float32Array([0, 0, 0, Number.NaN, 0, 0, 0, Number.POSITIVE_INFINITY, 0]),
    });

    const report = validateMeshStructure(mesh);
    const issue = report.issues.find(
      (candidate) => candidate.code === MeshValidationCode.NonFinitePosition,
    );

    expect(report.valid).toBe(false);
    expect(issue?.details).toEqual({ count: 2 });
  });

  it('rejects an empty mesh', () => {
    const mesh = validTriangle({
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
    });

    expect(codesOf(mesh)).toEqual(
      expect.arrayContaining([MeshValidationCode.EmptyMesh, MeshValidationCode.NoTriangles]),
    );
  });

  it('rejects a normal buffer whose length disagrees with the positions', () => {
    const mesh = validTriangle({ normals: new Float32Array([0, 0, 1]) });
    expect(codesOf(mesh)).toContain(MeshValidationCode.NormalLengthMismatch);
  });

  it('rejects a UV buffer whose length disagrees with the vertex count', () => {
    const mesh = validTriangle({ uvs: new Float32Array([0, 0, 1, 1]) });
    expect(codesOf(mesh)).toContain(MeshValidationCode.UvLengthMismatch);
  });

  it('rejects a group that runs past the end of the index buffer', () => {
    const mesh = validTriangle({
      groups: [{ name: 'shell', indexOffset: 0, indexCount: 9 }],
    });
    expect(codesOf(mesh)).toContain(MeshValidationCode.GroupRangeInvalid);
  });

  it('rejects a group whose offset is not triangle-aligned', () => {
    const mesh = validTriangle({
      groups: [{ name: 'shell', indexOffset: 1, indexCount: 3 }],
    });
    expect(codesOf(mesh)).toContain(MeshValidationCode.GroupRangeInvalid);
  });

  it('treats a degenerate triangle as a warning, not a failure', () => {
    // Repair exists to fix defects like this, so a mesh containing one must
    // still be loadable.
    const mesh = validTriangle({ indices: new Uint32Array([0, 1, 1]) });

    const report = validateMeshStructure(mesh);
    const issue = report.issues.find(
      (candidate) => candidate.code === MeshValidationCode.DegenerateTriangle,
    );

    expect(issue?.severity).toBe(MeshValidationSeverity.Warning);
    expect(report.valid).toBe(true);
  });

  it('caps the issue list so a pathological mesh cannot exhaust memory', () => {
    const mesh = validTriangle({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      groups: Array.from({ length: 200 }, (_unused, index) => ({
        name: `bad-${String(index)}`,
        indexOffset: 0,
        indexCount: 999,
      })),
    });

    const report = validateMeshStructure(mesh, { maxIssues: 5 });

    expect(report.issues).toHaveLength(5);
    expect(report.truncated).toBe(true);
  });
});

describe('assertMeshStructure', () => {
  it('returns the report when the mesh is valid', () => {
    expect(assertMeshStructure(validTriangle(), 'unit test').valid).toBe(true);
  });

  it('throws GEOMETRY_VALIDATION_FAILED naming the operation that produced the mesh', () => {
    const broken = validTriangle({ indices: new Uint32Array([0, 1, 99]) });

    try {
      assertMeshStructure(broken, 'hollow');
      expect.unreachable('assertMeshStructure should have thrown');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.GeometryValidationFailed);
      expect(caught.details.context).toBe('hollow');
      expect(caught.details.codes).toContain(MeshValidationCode.IndexOutOfRange);
    }
  });

  it('does not throw for warning-only issues', () => {
    const degenerate = validTriangle({ indices: new Uint32Array([0, 0, 0]) });
    expect(() => assertMeshStructure(degenerate, 'repair')).not.toThrow();
  });
});
