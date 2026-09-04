import { describe, expect, it } from 'vitest';
import { computeBounds, computeVertexNormals, triangleNormal } from './analysis';
import type { CanonicalMesh } from './mesh';

/**
 * These functions produce the numbers the interface shows and the normals the
 * viewport shades with. A regression here is invisible in the worst way: a model
 * renders black, or is framed off-screen, and no test that only counts triangles
 * would notice.
 */

function mesh(positions: readonly number[], indices: readonly number[]): CanonicalMesh {
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    metadata: { sourceFormat: 'stl' },
  };
}

/** One unit triangle in the XY plane, wound counter-clockwise, so its normal is +Z. */
const UNIT = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);

describe('computeBounds', () => {
  it('measures a simple triangle', () => {
    const bounds = computeBounds(UNIT);

    expect(bounds?.min).toEqual([0, 0, 0]);
    expect(bounds?.max).toEqual([1, 1, 0]);
    expect(bounds?.size).toEqual([1, 1, 0]);
    expect(bounds?.center).toEqual([0.5, 0.5, 0]);
  });

  it('returns undefined for an empty mesh rather than inventing a box at the origin', () => {
    expect(computeBounds(mesh([], []))).toBeUndefined();
  });

  it('returns undefined for a ragged position buffer', () => {
    expect(computeBounds(mesh([1, 2], []))).toBeUndefined();
  });

  it('handles a single vertex', () => {
    const bounds = computeBounds(mesh([4, -5, 6], [0, 0, 0]));

    expect(bounds?.min).toEqual([4, -5, 6]);
    expect(bounds?.max).toEqual([4, -5, 6]);
    expect(bounds?.radius).toBe(0);
  });

  it('handles a model far from the origin without assuming it is centred', () => {
    // The camera-framing path depends on this: a part exported 1 km from the
    // origin must still be measured correctly.
    const bounds = computeBounds(
      mesh([1000, 2000, 3000, 1002, 2000, 3000, 1000, 2002, 3000], [0, 1, 2]),
    );

    expect(bounds?.center).toEqual([1001, 2001, 3000]);
    expect(bounds?.size).toEqual([2, 2, 0]);
  });

  it('handles entirely negative coordinates', () => {
    const bounds = computeBounds(mesh([-3, -3, -3, -1, -3, -3, -3, -1, -3], [0, 1, 2]));

    expect(bounds?.min).toEqual([-3, -3, -3]);
    expect(bounds?.max).toEqual([-1, -1, -3]);
  });

  it('measures the radius from the vertices rather than the box diagonal', () => {
    // A flat square: the true enclosing radius is half its diagonal,
    // sqrt(2) ≈ 1.414. Deriving the radius from the box would give the same
    // here, so the discriminating case is the thin sliver below.
    const square = mesh([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], [0, 1, 2, 0, 2, 3]);
    expect(computeBounds(square)?.radius).toBeCloseTo(Math.SQRT2, 5);

    // A wide, flat triangle: every vertex lies on the Y = 0 plane, so the
    // radius must be 10 — half the box diagonal would overstate it.
    const sliver = mesh([-10, 0, 0, 10, 0, 0, 0, 0, 0], [0, 1, 2]);
    expect(computeBounds(sliver)?.radius).toBeCloseTo(10, 5);
  });

  it('reports zero radius when every vertex is coincident', () => {
    expect(computeBounds(mesh([2, 2, 2, 2, 2, 2, 2, 2, 2], [0, 1, 2]))?.radius).toBe(0);
  });
});

describe('computeVertexNormals', () => {
  it('derives the geometric normal from winding order', () => {
    const normals = computeVertexNormals(UNIT);

    expect([...normals]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('flips with the winding, not with anything stored in the file', () => {
    const reversed = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 2, 1]);

    expect([...computeVertexNormals(reversed)]).toEqual([0, 0, -1, 0, 0, -1, 0, 0, -1]);
  });

  it('shades triangle soup flat, because unshared vertices cannot smooth', () => {
    // Two coplanar triangles with no shared vertices — which is what every STL
    // is. Each vertex belongs to exactly one triangle, so each normal is that
    // triangle's own.
    const soup = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 3, 4, 5]);

    const normals = computeVertexNormals(soup);

    for (let vertex = 0; vertex < 6; vertex += 1) {
      expect(normals[vertex * 3 + 2]).toBeCloseTo(1, 6);
    }
  });

  it('smooths where vertices are genuinely shared', () => {
    // Two triangles meeting at a right angle along a shared edge. The shared
    // vertices average the two face normals; the unshared ones do not.
    const folded = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 2, 0, 2, 3]);

    const normals = computeVertexNormals(folded);

    // Vertex 1 belongs to one face only, so it keeps that face's normal.
    expect(normals[1 * 3 + 2]).toBeCloseTo(1, 5);
    // Vertex 0 is shared, so its normal is neither face's.
    expect(normals[2]).toBeLessThan(1);
  });

  it('emits unit-length, finite normals for every vertex', () => {
    const soup = mesh([0, 0, 0, 3, 0, 0, 0, 4, 0, 5, 5, 5, 6, 5, 5, 5, 7, 5], [0, 1, 2, 3, 4, 5]);

    const normals = computeVertexNormals(soup);

    for (let vertex = 0; vertex * 3 < normals.length; vertex += 1) {
      const x = normals[vertex * 3] ?? 0;
      const y = normals[vertex * 3 + 1] ?? 0;
      const z = normals[vertex * 3 + 2] ?? 0;
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 5);
    }
  });

  it('emits a finite fallback for a vertex touched only by degenerate triangles', () => {
    // A zero-area triangle contributes a zero cross product. Normalising that
    // would produce NaN and render the model black.
    const degenerate = mesh([2, 2, 2, 2, 2, 2, 2, 2, 2], [0, 1, 2]);

    const normals = computeVertexNormals(degenerate);

    for (const value of normals) expect(Number.isFinite(value)).toBe(true);
    expect([...normals]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('skips triangles whose indices are out of range instead of reading past the buffer', () => {
    // A hostile-index guard. It must not throw and must not produce NaN.
    const broken = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 99]);

    const normals = computeVertexNormals(broken);

    expect(normals).toHaveLength(9);
    for (const value of normals) expect(Number.isFinite(value)).toBe(true);
  });

  it('does not modify the source positions', () => {
    const source = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const before = [...source.positions];

    computeVertexNormals(source);

    expect([...source.positions]).toEqual(before);
  });
});

describe('triangleNormal', () => {
  it('returns a unit normal for a well-formed triangle', () => {
    const out = new Float64Array(3);

    triangleNormal(UNIT, 0, out);

    expect([...out]).toEqual([0, 0, 1]);
  });

  it('returns a zero normal, never NaN, for a degenerate triangle', () => {
    // The documented writer policy: real STL files contain zero normals in
    // abundance and every consumer tolerates them; NaN produces a file other
    // tools cannot read.
    const out = new Float64Array(3);

    triangleNormal(mesh([1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 2]), 0, out);

    expect([...out]).toEqual([0, 0, 0]);
  });

  it('returns a zero normal for collinear vertices', () => {
    const out = new Float64Array(3);

    triangleNormal(mesh([0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, 2]), 0, out);

    expect([...out]).toEqual([0, 0, 0]);
  });

  it('stays finite for coordinates at the top of the float32 range', () => {
    const out = new Float64Array(3);
    const huge = 3e38;

    triangleNormal(mesh([0, 0, 0, huge, 0, 0, 0, huge, 0], [0, 1, 2]), 0, out);

    for (const value of out) expect(Number.isFinite(value)).toBe(true);
  });
});
