import { createIndexArray, createPositionArray } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';

/**
 * Triangle-soup builders for the adversarial corpus.
 *
 * SOUP, DELIBERATELY. Every fixture is emitted the way STL import produces
 * geometry: independent corners with sequential indices. A fixture built from a
 * pre-indexed mesh would let a candidate read connectivity it would never have
 * in production, and would make the corpus easier than reality.
 *
 * GENERATED, NOT CHECKED IN. No binary fixture files: every byte under test is
 * auditable here, the repository stays small, and a size variant is a parameter
 * rather than another file.
 */

export type Point = readonly [number, number, number];
export type Triangle = readonly [Point, Point, Point];

export function soup(triangles: readonly Triangle[]): CanonicalMesh {
  const positions = createPositionArray(triangles.length * 9);
  const indices = createIndexArray(triangles.length * 3);

  let write = 0;
  for (const triangle of triangles) {
    for (const point of triangle) {
      positions[write] = point[0];
      positions[write + 1] = point[1];
      positions[write + 2] = point[2];
      write += 3;
    }
  }
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;

  return { positions, indices, metadata: { sourceFormat: 'stl' } };
}

export function translate(triangles: readonly Triangle[], offset: Point): Triangle[] {
  return triangles.map(
    (triangle) =>
      triangle.map(
        (p) => [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]] as Point,
      ) as unknown as Triangle,
  );
}

export function scalePoints(triangles: readonly Triangle[], factor: number): Triangle[] {
  return triangles.map(
    (triangle) =>
      triangle.map(
        (p) => [p[0] * factor, p[1] * factor, p[2] * factor] as Point,
      ) as unknown as Triangle,
  );
}

/** Reverses every face's winding by swapping the second and third corners. */
export function reverseAll(triangles: readonly Triangle[]): Triangle[] {
  return triangles.map((t) => [t[0], t[2], t[1]] as Triangle);
}

/**
 * A closed tetrahedron, wound outward.
 *
 * Verified outward rather than assumed: face (a,c,b) has normal
 * (c−a)×(b−a) = (0,0,−1) for the unit corner tetrahedron, which points away
 * from the fourth vertex d = (0,0,1).
 */
export function tetrahedron(scale = 10, offset: Point = [0, 0, 0]): Triangle[] {
  const a: Point = [offset[0], offset[1], offset[2]];
  const b: Point = [offset[0] + scale, offset[1], offset[2]];
  const c: Point = [offset[0], offset[1] + scale, offset[2]];
  const d: Point = [offset[0], offset[1], offset[2] + scale];
  return [
    [a, c, b],
    [a, b, d],
    [a, d, c],
    [b, c, d],
  ];
}

/**
 * A closed axis-aligned box, wound outward.
 *
 * Written as six quads split consistently so the winding is right by
 * construction; getting this wrong silently would make several fixtures test
 * the wrong thing.
 */
export function box(min: Point, max: Point): Triangle[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;

  const p = {
    a: [x0, y0, z0] as Point,
    b: [x1, y0, z0] as Point,
    c: [x1, y1, z0] as Point,
    d: [x0, y1, z0] as Point,
    e: [x0, y0, z1] as Point,
    f: [x1, y0, z1] as Point,
    g: [x1, y1, z1] as Point,
    h: [x0, y1, z1] as Point,
  };

  const quad = (one: Point, two: Point, three: Point, four: Point): Triangle[] => [
    [one, two, three],
    [one, three, four],
  ];

  return [
    ...quad(p.a, p.d, p.c, p.b), // bottom, normal −Z
    ...quad(p.e, p.f, p.g, p.h), // top, normal +Z
    ...quad(p.a, p.b, p.f, p.e), // front, normal −Y
    ...quad(p.d, p.h, p.g, p.c), // back, normal +Y
    ...quad(p.a, p.e, p.h, p.d), // left, normal −X
    ...quad(p.b, p.c, p.g, p.f), // right, normal +X
  ];
}

/** The box above with one face's two triangles omitted: one simple boundary loop. */
export function boxMissingOneFace(min: Point, max: Point): Triangle[] {
  return box(min, max).slice(2);
}

/**
 * An open tube: two rings joined by a wall, both ends deliberately open.
 *
 * The openings are the POINT of this fixture. A candidate that fills them has
 * turned a pipe into a rod and called it a repair.
 */
export function openTube(radius: number, height: number, segments: number): Triangle[] {
  // RING VERTICES ARE COMPUTED ONCE AND INDEXED MODULO `segments`.
  //
  // The obvious version computes the angle per quad as `i/segments · 2π` and
  // `(i+1)/segments · 2π`, which makes the final quad close the ring at angle
  // 2π rather than 0 — and `Math.cos(2π)` is not bit-identical to `Math.cos(0)`
  // (`sin(2π)` is about −2.4e-16, not zero). Under exact-coordinate identity
  // that leaves a seam: the tube is one open sheet rolled up, with a single
  // boundary loop running down the seam and around both rims, instead of the
  // two rim loops this fixture exists to provide.
  //
  // The pinned-oracle test caught exactly that. Computing each ring vertex once
  // and reusing it makes the wrap exact by construction.
  const ring: Point[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    ring.push([Math.cos(angle) * radius, Math.sin(angle) * radius, 0]);
  }

  const triangles: Triangle[] = [];
  for (let i = 0; i < segments; i += 1) {
    const lower = ring[i];
    const nextLower = ring[(i + 1) % segments];
    if (lower === undefined || nextLower === undefined) continue;

    const a: Point = lower;
    const b: Point = nextLower;
    const c: Point = [nextLower[0], nextLower[1], height];
    const d: Point = [lower[0], lower[1], height];
    triangles.push([a, b, c], [a, c, d]);
  }
  return triangles;
}

/**
 * A grid patch in the XY plane, used for size variants and crack fixtures.
 *
 * Corners are computed from grid position, so neighbours share bit-identical
 * coordinates and the recovered topology is genuinely connected.
 */
export function gridPatch(side: number, cell = 1, origin: Point = [0, 0, 0]): Triangle[] {
  const triangles: Triangle[] = [];
  const at = (col: number, row: number): Point => [
    origin[0] + col * cell,
    origin[1] + row * cell,
    origin[2],
  ];
  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      triangles.push(
        [at(col, row), at(col + 1, row), at(col, row + 1)],
        [at(col + 1, row), at(col + 1, row + 1), at(col, row + 1)],
      );
    }
  }
  return triangles;
}

/**
 * Two grid patches separated along X by `gap`.
 *
 * When `gap` is 0 the seam is exact and the patches are one component; any
 * non-zero gap makes them two, joined by nothing, with boundary edges facing
 * each other. That is a crack — and at `gap = 0` it is not, which is what makes
 * the pair a useful control.
 */
export function crackedPatch(side: number, gap: number): Triangle[] {
  return [...gridPatch(side, 1, [0, 0, 0]), ...gridPatch(side, 1, [side + gap, 0, 0])];
}
