import { describe, expect, it } from 'vitest';
import {
  buildDrawableTriangles,
  computeBounds,
  computeVertexNormals,
  triangleNormal,
} from './analysis';
import { createIndexArray, createPositionArray, vertexCount } from './mesh';
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

/* ------------------------------------ Stage 4B-1D: the drawable stream --- */

describe('buildDrawableTriangles', () => {
  /**
   * WHAT A NON-INDEXED DRAW ACTUALLY NEEDS, and why reading the vertex table was
   * never it.
   *
   * A `RenderSnapshot` carries no index buffer: the GPU walks the position
   * buffer three vertices at a time. For STL soup the vertex table IS that
   * stream, which is why handing it over worked and why nothing noticed when
   * OBJ and 3MF import arrived carrying genuinely indexed meshes. For those, the
   * table is a POOL — a tetrahedron's four corners in some order — and drawing
   * it non-indexed spells one arbitrary triangle out of four.
   */
  const TETRAHEDRON: CanonicalMesh = {
    positions: createPositionArray(12),
    indices: createIndexArray(12),
    metadata: {},
  };
  TETRAHEDRON.positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  TETRAHEDRON.indices.set([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);

  it('expands an indexed mesh into three corners per face', () => {
    const drawable = buildDrawableTriangles(TETRAHEDRON);

    // FOUR FACES, TWELVE CORNERS. The source's vertex table has four entries;
    // drawing THAT non-indexed would have produced a single triangle.
    expect(drawable.vertexCount).toBe(12);
    expect(drawable.positions.length).toBe(36);
    expect(vertexCount(TETRAHEDRON)).toBe(4);

    // Face 2 is (0, 3, 2): the origin, then (0,0,1), then (0,1,0).
    expect([...drawable.positions.slice(18, 27)]).toEqual([0, 0, 0, 0, 0, 1, 0, 1, 0]);
  });

  it('gives every corner its own face normal, so hard edges stay hard', () => {
    const drawable = buildDrawableTriangles(TETRAHEDRON);

    for (let face = 0; face < 4; face += 1) {
      const base = face * 9;
      const n = drawable.normals.slice(base, base + 3);
      // Constant across the face — that is what flat shading means.
      expect([...drawable.normals.slice(base + 3, base + 6)]).toEqual([...n]);
      expect([...drawable.normals.slice(base + 6, base + 9)]).toEqual([...n]);
      /*
       * AND A UNIT VECTOR, to float32 precision. Six places, not twelve: this is
       * a RENDER buffer and `Float32Array` carries about seven decimal digits,
       * so a tighter tolerance would be asserting a precision the selected
       * vertex-attribute format does not have.
       */
      const nx = n[0] ?? 0;
      const ny = n[1] ?? 0;
      const nz = n[2] ?? 0;
      expect(Math.sqrt(nx * nx + ny * ny + nz * nz)).toBeCloseTo(1, 6);
    }

    /*
     * THE VERTEX THE SHARING WOULD HAVE SMOOTHED. Vertex 0 is a corner of three
     * faces with three different normals. Averaging them — which is what
     * per-vertex normals over a shared table produce — would round that corner
     * off. Here its three appearances disagree, because they belong to three
     * different faces.
     */
    const corner0 = drawable.normals.slice(0, 3).join(',');
    const corner0Again = drawable.normals.slice(9, 12).join(',');
    expect(corner0).not.toBe(corner0Again);
  });

  it('matches what a soup mesh already produced, so nothing looks different', () => {
    /*
     * THE REGRESSION GUARD FOR EVERY EXISTING STL. Soup gave each corner its own
     * position slot, so `computeVertexNormals` accumulated exactly one face
     * normal per slot and normalised it — flat shading by accident of the
     * representation. Expansion must reproduce that answer exactly, or every
     * model already in front of a user changes appearance.
     */
    const soup: CanonicalMesh = {
      positions: createPositionArray(18),
      indices: createIndexArray(6),
      metadata: {},
    };
    soup.positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
    soup.indices.set([0, 1, 2, 3, 4, 5]);

    const drawable = buildDrawableTriangles(soup);
    expect([...drawable.positions]).toEqual([...soup.positions]);
    expect([...drawable.normals]).toEqual([...computeVertexNormals(soup)]);
  });

  it('gives a degenerate face a finite normal rather than NaN', () => {
    const degenerate: CanonicalMesh = {
      positions: createPositionArray(9),
      indices: createIndexArray(3),
      metadata: {},
    };
    degenerate.positions.set([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    degenerate.indices.set([0, 1, 2]);

    const drawable = buildDrawableTriangles(degenerate);
    // The same fallback `computeVertexNormals` uses: any unit vector is as wrong
    // as any other, and a zero or NaN normal breaks lighting for the whole draw.
    expect([...drawable.normals]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });
});
