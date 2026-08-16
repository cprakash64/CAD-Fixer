import {
  createIndexArray,
  createPositionArray,
  IDENTITY_MATRIX4,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';

/**
 * Deterministic synthetic topology fixtures.
 *
 * Every fixture is built as TRIANGLE SOUP — three independent corners per face,
 * with sequential indices — because that is exactly what an STL import
 * produces. Building them any other way would let the tests pass while the real
 * pipeline failed: soup is precisely the case where sequential indices carry no
 * connectivity and topology must be recovered from coordinates.
 *
 * Coordinates are chosen so that shared corners are bit-identical, never merely
 * close. Nothing here relies on a tolerance.
 */

export type Point = readonly [number, number, number];

/** Builds a soup mesh from triangles given as three points each. */
export function soup(triangles: readonly (readonly [Point, Point, Point])[]): CanonicalMesh {
  const positions = createPositionArray(triangles.length * 9);
  const indices = createIndexArray(triangles.length * 3);

  triangles.forEach((triangle, faceIndex) => {
    triangle.forEach((point, corner) => {
      const base = faceIndex * 9 + corner * 3;
      positions[base] = point[0];
      positions[base + 1] = point[1];
      positions[base + 2] = point[2];
      indices[faceIndex * 3 + corner] = faceIndex * 3 + corner;
    });
  });

  return {
    positions,
    indices,
    metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
  };
}

/** A: one triangle in the XY plane. */
export function singleTriangle(): CanonicalMesh {
  return soup([
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
  ]);
}

/** B: unit square from two triangles, consistently wound counter-clockwise. */
export function square(): CanonicalMesh {
  return soup([
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  ]);
}

/** C: same square with the second triangle wound the same way round the shared edge. */
export function squareWrongWinding(): CanonicalMesh {
  return soup([
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ],
    // Reversed: now both faces traverse the shared diagonal (0,0)→(1,1).
    [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
  ]);
}

const T0: Point = [0, 0, 0];
const T1: Point = [1, 0, 0];
const T2: Point = [0, 1, 0];
const T3: Point = [0, 0, 1];

/** D: closed tetrahedron, all faces wound outward. */
export function tetrahedron(offset: Point = [0, 0, 0], scale = 1): CanonicalMesh {
  const move = (p: Point): Point => [
    p[0] * scale + offset[0],
    p[1] * scale + offset[1],
    p[2] * scale + offset[2],
  ];
  const a = move(T0);
  const b = move(T1);
  const c = move(T2);
  const d = move(T3);

  return soup([
    [a, c, b],
    [a, b, d],
    [a, d, c],
    [b, c, d],
  ]);
}

/** E: tetrahedron with one face's winding reversed. */
export function tetrahedronOneFaceReversed(): CanonicalMesh {
  const mesh = tetrahedron();
  const positions = createPositionArray(mesh.positions.length);
  positions.set(mesh.positions);

  // Reverse face 0 by swapping its second and third corners, which inverts the
  // cyclic order. Writing a hand-typed triangle here is how an earlier version
  // of this fixture silently reversed nothing at all.
  for (let axis = 0; axis < 3; axis += 1) {
    const second = mesh.positions[3 + axis] ?? 0;
    const third = mesh.positions[6 + axis] ?? 0;
    positions[3 + axis] = third;
    positions[6 + axis] = second;
  }

  return { ...mesh, positions };
}

/** F: two tetrahedra with no shared coordinates. */
export function twoTetrahedra(): CanonicalMesh {
  const first = tetrahedron([0, 0, 0]);
  const second = tetrahedron([10, 0, 0]);
  return concat(first, second);
}

/** G: three triangles sharing exactly one edge. */
export function threeTrianglesSharingEdge(): CanonicalMesh {
  const a: Point = [0, 0, 0];
  const b: Point = [1, 0, 0];
  return soup([
    [a, b, [0, 1, 0]],
    [a, b, [0, 0, 1]],
    [a, b, [0, -1, 0]],
  ]);
}

/**
 * H: BOW-TIE. Two square patches meeting at exactly one vertex.
 *
 * Each patch is two triangles forming a quad, and the two quads touch only at
 * the origin. Critically, NO edge is shared between the patches, so every edge
 * has at most two incident faces — the singularity is purely the vertex, which
 * is what makes this the case that edge-only manifold checks miss.
 */
export function bowTieVertex(): CanonicalMesh {
  const apex: Point = [0, 0, 0];
  return soup([
    // Patch 1, in the +X +Y quadrant.
    [apex, [1, 0, 0], [1, 1, 0]],
    [apex, [1, 1, 0], [0, 1, 0]],
    // Patch 2, in the -X -Y quadrant. Shares only `apex`.
    [apex, [-1, 0, 0], [-1, -1, 0]],
    [apex, [-1, -1, 0], [0, -1, 0]],
  ]);
}

/** I: axis-aligned cube with one face missing, consistently wound. */
export function cubeMissingOneFace(): CanonicalMesh {
  // Named corners rather than a keyed record, so every reference is checked at
  // compile time instead of falling back on a runtime default.
  const a: Point = [0, 0, 0];
  const b: Point = [1, 0, 0];
  const c: Point = [1, 1, 0];
  const d: Point = [0, 1, 0];
  const e: Point = [0, 0, 1];
  const f: Point = [1, 0, 1];
  const g: Point = [1, 1, 1];
  const h: Point = [0, 1, 1];

  const quad = (
    one: Point,
    two: Point,
    three: Point,
    four: Point,
  ): readonly (readonly [Point, Point, Point])[] => [
    [one, two, three],
    [one, three, four],
  ];

  return soup([
    // Bottom face omitted, leaving a square boundary loop.
    ...quad(e, f, g, h),
    ...quad(a, e, h, d),
    ...quad(b, c, g, f),
    ...quad(a, b, f, e),
    ...quad(d, h, g, c),
  ]);
}

/**
 * J: branched boundary — a boundary vertex where three boundary edges meet.
 *
 * Three triangles arranged in a fan around a shared centre, with two of them
 * disconnected from the third except at the centre, produces boundary vertices
 * of degree 3.
 */
export function branchedBoundary(): CanonicalMesh {
  const centre: Point = [0, 0, 0];
  const rim: Point = [1, 0, 0];
  return soup([
    [centre, rim, [1, 1, 0]],
    [centre, rim, [1, -1, 0]],
    [centre, rim, [0, 0, 1]],
  ]);
}

/** K: a triangle and an exact copy with the same winding. */
export function duplicateSameOrientation(): CanonicalMesh {
  const triangle: readonly [Point, Point, Point] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ];
  return soup([triangle, triangle]);
}

/** L: a triangle and a copy with the opposite winding. */
export function duplicateReversedOrientation(): CanonicalMesh {
  return soup([
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
    ],
  ]);
}

/** M: a triangle whose corners occupy only two distinct positions. */
export function repeatedPositionTriangle(): CanonicalMesh {
  return soup([
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ],
  ]);
}

/** N: three distinct but exactly collinear points. */
export function collinearTriangle(): CanonicalMesh {
  return soup([
    [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ],
  ]);
}

/** O: the same point written with negative and positive zero. */
export function signedZeroPair(): CanonicalMesh {
  return soup([
    [
      [-0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    // Positive zero. Written plain rather than as `+0`: the unary operator is a
    // no-op on a numeric literal, so it only looks like it is doing something.
    [
      [0, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
    ],
  ]);
}

/**
 * P: two points one ULP apart in the canonical storage type.
 *
 * The neighbouring value is computed rather than written as a decimal literal,
 * so the test cannot silently degrade into comparing two identical values.
 */
export function nearButDistinctPair(): { mesh: CanonicalMesh; a: number; b: number } {
  const probe = createPositionArray(2);
  probe[0] = 1;
  // Read back, not reused: 1 survives every candidate storage type unchanged,
  // but the round trip is what makes `a` a value the array actually holds.
  const a = probe[0];

  // Find the next representable value ABOVE `a` in whatever type
  // `createPositionArray` returns. The step is DOUBLED rather than scaled by
  // `Number.EPSILON`, because that constant is the double ulp (2^-52) and would
  // never move a float32 store (ulp 2^-23) — an earlier version of this fixture
  // silently compared a value against itself.
  let candidate = a;
  for (let delta = Number.EPSILON; delta < 1; delta *= 2) {
    probe[1] = a + delta;
    const stored = probe[1];
    if (stored !== a) {
      candidate = stored;
      break;
    }
  }

  const mesh = soup([
    [
      [a, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [
      [candidate, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  ]);

  return { mesh, a, b: candidate };
}

/** W: two tetrahedra overlapping in space but combinatorially separate. */
export function overlappingClosedShells(): CanonicalMesh {
  return concat(tetrahedron([0, 0, 0]), tetrahedron([0.25, 0.25, 0.25]));
}

/**
 * X: two CLOSED shells touching at exactly one recovered vertex, sharing no edge.
 *
 * The point-contact case with closed components, which the bow-tie (open
 * patches) does not cover. Each shell is a tetrahedron; the second is the first
 * reflected through the origin, so the only coordinate the two have in common is
 * (0, 0, 0) — every other corner differs in sign on at least one axis, and no
 * pair of corners can form a shared edge.
 *
 * Reflection also mirrors orientation, so the second shell's winding is reversed
 * afterwards to leave both shells wound outward. Without that, one shell would
 * report a negative signed volume and the fixture would be testing two things at
 * once.
 *
 * Expected, from the geometry rather than from the implementation:
 *   global    V = 7   (4 + 4 − 1 shared apex)
 *   component V = 4,  E = 6,  F = 4,  χ = 2   — for BOTH components
 *   sum(component V) = 8 = global 7 + 1 shared vertex
 */
export function tetrahedraTouchingAtOneVertex(): CanonicalMesh {
  const first = tetrahedron();
  const mirrored = scale(first, -1);
  return concat(first, reverseWinding(mirrored));
}

/** Concatenates two soup meshes into one. */
export function concat(first: CanonicalMesh, second: CanonicalMesh): CanonicalMesh {
  const positions = createPositionArray(first.positions.length + second.positions.length);
  positions.set(first.positions, 0);
  positions.set(second.positions, first.positions.length);

  const cornerCount = positions.length / 3;
  const indices = createIndexArray(cornerCount);
  for (let i = 0; i < cornerCount; i += 1) indices[i] = i;

  return {
    positions,
    indices,
    metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
  };
}

/** Returns a copy with every face's winding reversed. */
export function reverseWinding(mesh: CanonicalMesh): CanonicalMesh {
  const positions = createPositionArray(mesh.positions.length);
  const faces = mesh.positions.length / 9;
  for (let f = 0; f < faces; f += 1) {
    const base = f * 9;
    // Swap corners 1 and 2, which reverses the cyclic order.
    for (let axis = 0; axis < 3; axis += 1) {
      positions[base + axis] = mesh.positions[base + axis] ?? 0;
      positions[base + 3 + axis] = mesh.positions[base + 6 + axis] ?? 0;
      positions[base + 6 + axis] = mesh.positions[base + 3 + axis] ?? 0;
    }
  }
  return { ...mesh, positions };
}

/** Returns a copy translated by `offset`. */
export function translate(mesh: CanonicalMesh, offset: Point): CanonicalMesh {
  const positions = createPositionArray(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = (mesh.positions[i] ?? 0) + offset[0];
    positions[i + 1] = (mesh.positions[i + 1] ?? 0) + offset[1];
    positions[i + 2] = (mesh.positions[i + 2] ?? 0) + offset[2];
  }
  return { ...mesh, positions };
}

/** Returns a copy scaled uniformly about the origin. */
export function scale(mesh: CanonicalMesh, factor: number): CanonicalMesh {
  const positions = createPositionArray(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 1) {
    positions[i] = (mesh.positions[i] ?? 0) * factor;
  }
  return { ...mesh, positions };
}

/** Returns a copy with faces emitted in reverse order. */
export function permuteFaceOrder(mesh: CanonicalMesh): CanonicalMesh {
  const faces = mesh.positions.length / 9;
  const positions = createPositionArray(mesh.positions.length);
  for (let f = 0; f < faces; f += 1) {
    const source = (faces - 1 - f) * 9;
    positions.set(mesh.positions.subarray(source, source + 9), f * 9);
  }
  return { ...mesh, positions };
}
