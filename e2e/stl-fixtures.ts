/**
 * STL fixture builders for the end-to-end suite.
 *
 * Generated in the test process and handed to the page through Playwright's
 * file-chooser API, so nothing large is committed to the repository and every
 * byte under test is auditable here.
 */

const BINARY_PREFIX_BYTES = 84;
const BINARY_FACET_BYTES = 50;

export interface GeneratedStl {
  readonly bytes: Buffer;
  readonly triangles: number;
}

/**
 * Builds a binary STL approximating a lattice of distinct triangles.
 *
 * `triangles` is chosen by the caller so a test can ask for something big
 * enough to be genuinely slow to parse, which is what the responsiveness test
 * needs.
 */
export function binaryStl(triangles: number): GeneratedStl {
  const bytes = Buffer.alloc(BINARY_PREFIX_BYTES + triangles * BINARY_FACET_BYTES);
  bytes.write('cadfixer e2e fixture', 0, 'ascii');
  bytes.writeUInt32LE(triangles, 80);

  for (let index = 0; index < triangles; index += 1) {
    const offset = BINARY_PREFIX_BYTES + index * BINARY_FACET_BYTES;
    const x = (index % 256) * 0.5;
    const y = Math.floor(index / 256) * 0.5;

    // Facet normal left at zero: it is advisory, and leaving it unset also
    // exercises the "zero stored normals" diagnostic path.
    bytes.writeFloatLE(x, offset + 12);
    bytes.writeFloatLE(y, offset + 16);
    bytes.writeFloatLE(0, offset + 20);

    bytes.writeFloatLE(x + 0.4, offset + 24);
    bytes.writeFloatLE(y, offset + 28);
    bytes.writeFloatLE(0, offset + 32);

    bytes.writeFloatLE(x, offset + 36);
    bytes.writeFloatLE(y + 0.4, offset + 40);
    bytes.writeFloatLE(0.2, offset + 44);
  }

  return { bytes, triangles };
}

/** A minimal, unambiguous ASCII STL. */
export function asciiStl(triangles: number): GeneratedStl {
  const lines: string[] = ['solid e2e'];
  for (let index = 0; index < triangles; index += 1) {
    const x = index * 1.5;
    lines.push(
      '  facet normal 0.0 0.0 1.0',
      '    outer loop',
      `      vertex ${x.toFixed(4)} 0.0000 0.0000`,
      `      vertex ${(x + 1).toFixed(4)} 0.0000 0.0000`,
      `      vertex ${x.toFixed(4)} 1.0000 0.0000`,
      '    endloop',
      '  endfacet',
    );
  }
  lines.push('endsolid e2e', '');
  return { bytes: Buffer.from(lines.join('\n'), 'ascii'), triangles };
}

/**
 * A binary STL whose 80-byte header begins with "solid".
 *
 * This is the file that breaks naive detectors, and it exists in the wild.
 */
export function binaryStlWithSolidHeader(triangles: number): GeneratedStl {
  const generated = binaryStl(triangles);
  generated.bytes.fill(0, 0, 80);
  generated.bytes.write('solid a binary file with a misleading header', 0, 'ascii');
  return generated;
}

/** A binary STL that declares far more triangles than it contains. */
export function truncatedBinaryStl(): Buffer {
  const generated = binaryStl(4);
  generated.bytes.writeUInt32LE(9000, 80);
  return generated.bytes;
}

/* ------------------------------------------------- topology fixtures -- */

export type Point = readonly [number, number, number];

/**
 * Writes an arbitrary triangle list as a binary STL.
 *
 * The topology fixtures below are generated at test time and imported through
 * the real file picker, so the browser tests exercise the same parse → resident
 * model → analyze path a user would. Coordinates are written as float32, which
 * is exactly what the format holds, so what the engine recovers is what the file
 * actually says.
 */
export function binaryStlFrom(triangles: readonly (readonly [Point, Point, Point])[]): Buffer {
  const bytes = Buffer.alloc(BINARY_PREFIX_BYTES + triangles.length * BINARY_FACET_BYTES);
  bytes.write('cadfixer topology fixture', 0, 'ascii');
  bytes.writeUInt32LE(triangles.length, 80);

  triangles.forEach((triangle, index) => {
    const offset = BINARY_PREFIX_BYTES + index * BINARY_FACET_BYTES;
    // Normal left at zero: stored normals are advisory and the engine ignores
    // them, deriving orientation from vertex order instead.
    triangle.forEach((point, corner) => {
      const base = offset + 12 + corner * 12;
      bytes.writeFloatLE(point[0], base);
      bytes.writeFloatLE(point[1], base + 4);
      bytes.writeFloatLE(point[2], base + 8);
    });
  });

  return bytes;
}

/** A closed tetrahedron, wound outward. No topological defects. */
export function tetrahedronStl(): Buffer {
  const a: Point = [0, 0, 0];
  const b: Point = [10, 0, 0];
  const c: Point = [0, 10, 0];
  const d: Point = [0, 0, 10];
  return binaryStlFrom([
    [a, c, b],
    [a, b, d],
    [a, d, c],
    [b, c, d],
  ]);
}

/** One triangle: three boundary edges forming one simple loop. */
export function singleTriangleStl(): Buffer {
  return binaryStlFrom([
    [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ],
  ]);
}

/** Three triangles sharing one edge: exactly one non-manifold edge. */
export function nonManifoldEdgeStl(): Buffer {
  const a: Point = [0, 0, 0];
  const b: Point = [10, 0, 0];
  return binaryStlFrom([
    [a, b, [0, 10, 0]],
    [a, b, [0, 0, 10]],
    [a, b, [0, -10, 0]],
  ]);
}

/**
 * THE BOW-TIE. Two square patches meeting at exactly one vertex.
 *
 * No edge is shared between the patches, so every edge has at most two incident
 * faces. Only genuine vertex-fan analysis finds the pinch — which is why this
 * fixture is in the browser suite and not only the unit suite: it proves the
 * interface did not reduce manifoldness to an edge count somewhere on the way to
 * the screen.
 */
export function bowTieStl(): Buffer {
  const apex: Point = [0, 0, 0];
  return binaryStlFrom([
    [apex, [10, 0, 0], [10, 10, 0]],
    [apex, [10, 10, 0], [0, 10, 0]],
    [apex, [-10, 0, 0], [-10, -10, 0]],
    [apex, [-10, -10, 0], [0, -10, 0]],
  ]);
}

/**
 * Two adjacent triangles that traverse their shared edge the SAME way.
 *
 * Worked through explicitly, because "reverse one of them" is easy to get
 * backwards. The first triangle (a,b,c) traverses its edges a→b, b→c, c→a, so
 * it crosses the shared edge {a,c} in the direction c→a. A consistently wound
 * neighbour must therefore cross it a→c. This one is (d,c,a): its edges are
 * d→c, c→a, a→d — it crosses c→a as well, which is the conflict.
 */
export function windingConflictStl(): Buffer {
  const a: Point = [0, 0, 0];
  const b: Point = [10, 0, 0];
  const c: Point = [10, 10, 0];
  const d: Point = [0, 10, 0];
  return binaryStlFrom([
    [a, b, c],
    [d, c, a],
  ]);
}

/** A valid triangle plus one whose three corners are exactly collinear. */
export function degenerateFaceStl(): Buffer {
  return binaryStlFrom([
    [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ],
    [
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
    ],
  ]);
}

/**
 * A grid of open quads, large enough that analysis takes measurable time.
 *
 * Used for cancellation and responsiveness. Height varies with grid position so
 * neighbouring quads genuinely share vertices — a fixture where every quad has
 * its own corners would exercise the hash table's insert path and almost none of
 * its merging, which is the part that costs.
 */
export function analysisHeavyStl(side: number): GeneratedStl {
  const triangles: (readonly [Point, Point, Point])[] = [];
  const height = (x: number, y: number): number => ((x * 7 + y * 13) % 17) * 0.01;

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const p00: Point = [col, row, height(col, row)];
      const p10: Point = [col + 1, row, height(col + 1, row)];
      const p01: Point = [col, row + 1, height(col, row + 1)];
      const p11: Point = [col + 1, row + 1, height(col + 1, row + 1)];
      triangles.push([p00, p10, p01], [p10, p11, p01]);
    }
  }

  return { bytes: binaryStlFrom(triangles), triangles: triangles.length };
}

/* -------------------------------------------------- repair fixtures -- */

/**
 * REPAIR FIXTURES.
 *
 * Each one is built to exercise exactly ONE decision of the conservative repair
 * plan, so a failing end-to-end test names the behaviour that broke rather than
 * "repair is wrong". They are deliberately tiny: the point is which decision the
 * engine reaches, not how fast it reaches it.
 */

const TETRA_A: Point = [0, 0, 0];
const TETRA_B: Point = [10, 0, 0];
const TETRA_C: Point = [0, 10, 0];
const TETRA_D: Point = [0, 0, 10];

/** The four faces of the clean tetrahedron, wound consistently. */
function tetrahedronFaces(): (readonly [Point, Point, Point])[] {
  return [
    [TETRA_A, TETRA_C, TETRA_B],
    [TETRA_A, TETRA_B, TETRA_D],
    [TETRA_A, TETRA_D, TETRA_C],
    [TETRA_B, TETRA_C, TETRA_D],
  ];
}

/**
 * A closed tetrahedron with ONE face written twice in the same rotational order.
 *
 * The removable case. The duplicate raises that face's three edges to incidence
 * three, so the model reads as non-manifold until the copy is gone — which is
 * exactly why duplicates are removed before winding is solved.
 */
export function duplicateFaceStl(): Buffer {
  const faces = tetrahedronFaces();
  const first = faces[0];
  if (first === undefined) throw new Error('tetrahedron fixture is empty');
  return binaryStlFrom([...faces, first]);
}

/**
 * A closed tetrahedron with one face written twice in OPPOSITE order.
 *
 * The case conservative repair must refuse to remove. A reversed duplicate may
 * encode a deliberate zero-thickness feature, so it is reported and left alone.
 * Written by rotating the corner order rather than by reversing the array, so the
 * two triangles genuinely traverse their shared edges in opposite directions.
 */
export function reversedDuplicateFaceStl(): Buffer {
  const faces = tetrahedronFaces();
  const first = faces[0];
  if (first === undefined) throw new Error('tetrahedron fixture is empty');
  const reversed: readonly [Point, Point, Point] = [first[0], first[2], first[1]];
  return binaryStlFrom([...faces, reversed]);
}

/**
 * A closed tetrahedron plus a detached, exactly collinear triangle.
 *
 * SAFELY removable: the degenerate triangle shares no vertex with the solid, so
 * deleting it cannot open the surface or create a non-manifold edge. It does
 * remove one connected component, which the validator allows precisely because
 * every face of that component was deleted.
 */
export function safeDegenerateStl(): Buffer {
  return binaryStlFrom([
    ...tetrahedronFaces(),
    [
      [100, 0, 0],
      [110, 0, 0],
      [120, 0, 0],
    ],
  ]);
}

/**
 * A closed tetrahedron plus a detached triangle with two identical corners.
 *
 * The repeated-position case, kept separate from the zero-area one because they
 * are different defects and the interface counts them separately.
 */
export function safeRepeatedPositionStl(): Buffer {
  return binaryStlFrom([
    ...tetrahedronFaces(),
    [
      [100, 0, 0],
      [100, 0, 0],
      [110, 0, 0],
    ],
  ]);
}

/**
 * A zero-area triangle that SEALS a closed surface. CR06-equivalent.
 *
 * WHY THIS SHAPE AND NOT THE OBVIOUS ONE. A collinear triangle merely touching
 * other geometry is safely removable — it contributes more boundary edges than it
 * hides, so deleting it CLOSES nothing and opens nothing. To make removal unsafe
 * the degenerate face has to be load-bearing: every one of its edges must already
 * be paired with a real face, so that deleting it opens the surface in three
 * places at once.
 *
 * This is a tetrahedron A-M-B-U whose base A-M-B is exactly collinear: M is the
 * midpoint of AB. All six edges have two incident faces, so the model reports no
 * boundary edges at all — and removing the zero-area base would create three.
 * Conservative repair refuses, because that is a change to the model's shape
 * rather than a cleanup.
 */
export function unsafeDegenerateStl(): Buffer {
  const a: Point = [0, 0, 0];
  const m: Point = [5, 0, 0];
  const b: Point = [10, 0, 0];
  const u: Point = [5, 4, 3];
  // The tetrahedron winding pattern, with the collinear base first.
  return binaryStlFrom([
    [a, b, m],
    [a, m, u],
    [a, u, b],
    [m, b, u],
  ]);
}

/**
 * ONE triangle, written twice in the same rotational order.
 *
 * THE FIXTURE FOR THE NON-MONOTONIC CASE. Two coincident triangles pair each
 * other's edges, so the model reports ZERO boundary edges and looks closed.
 * Removing the redundant copy reveals the three boundary edges that were there
 * all along.
 *
 * The engine predicts that exact count before rebuilding and confirms it
 * afterwards, so it is an expected consequence of a correct repair rather than
 * damage. An interface that reported "3 new boundary errors" here would be
 * inventing a problem the engine explicitly reasoned about and allowed.
 */
export function hiddenBoundaryDuplicateStl(): Buffer {
  const face: readonly [Point, Point, Point] = [
    [0, 0, 0],
    [10, 0, 0],
    [0, 10, 0],
  ];
  return binaryStlFrom([face, face]);
}

/**
 * A winding conflict in a component that also contains a NON-MANIFOLD VERTEX.
 *
 * Two square halves that disagree across their shared edge, plus a second patch
 * touching the first at exactly one vertex and nowhere else. The pinch makes the
 * vertex non-manifold, and winding unification is blocked rather than propagated
 * across a fan that is not a fan.
 *
 * Worked through explicitly, because "reverse one of them" is easy to get
 * backwards. Triangle (a,b,c) crosses the shared edge {a,c} in the direction
 * c -> a. A consistently wound neighbour must cross it a -> c. Triangle (d,c,a)
 * crosses c -> a as well, which is the conflict.
 */
export function windingBlockedByVertexStl(): Buffer {
  const a: Point = [0, 0, 0];
  const b: Point = [10, 0, 0];
  const c: Point = [10, 10, 0];
  const d: Point = [0, 10, 0];
  return binaryStlFrom([
    [a, b, c],
    [d, c, a],
    // Second patch, joined to the first at `a` alone.
    [a, [-10, 0, 0], [-10, -10, 0]],
    [a, [-10, -10, 0], [0, -10, 0]],
  ]);
}

/**
 * One model carrying a duplicate, a safely removable degenerate, AND a winding
 * conflict.
 *
 * Exercises the deterministic pipeline order end to end: the duplicate is removed
 * first, which drops three edges from incidence three back to two and makes the
 * winding solve possible at all; the detached degenerate goes with it; and the
 * reversed face is turned back the right way relative to its neighbours.
 */
export function combinedRepairStl(): Buffer {
  const faces = tetrahedronFaces();
  const [first, second, third, fourth] = faces as [
    readonly [Point, Point, Point],
    readonly [Point, Point, Point],
    readonly [Point, Point, Point],
    readonly [Point, Point, Point],
  ];
  // `fourth` reversed: three of its edges now disagree with their neighbours.
  const flipped: readonly [Point, Point, Point] = [fourth[0], fourth[2], fourth[1]];
  return binaryStlFrom([
    first,
    second,
    third,
    flipped,
    // An exact duplicate of `second`, same rotational order.
    second,
    // A detached zero-area triangle, safely removable.
    [
      [100, 0, 0],
      [110, 0, 0],
      [120, 0, 0],
    ],
  ]);
}

/**
 * A grid large enough that preparing a repair takes measurable time.
 *
 * Every quad is written twice, so the model is half duplicates: the duplicate
 * scan, the rebuild and the revalidation all have real work to do. Used for the
 * cancellation test and for the browser performance measurements.
 */
export function repairHeavyStl(side: number): GeneratedStl {
  const triangles: (readonly [Point, Point, Point])[] = [];
  const height = (x: number, y: number): number => ((x * 7 + y * 13) % 17) * 0.01;

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const p00: Point = [col, row, height(col, row)];
      const p10: Point = [col + 1, row, height(col + 1, row)];
      const p01: Point = [col, row + 1, height(col, row + 1)];
      const p11: Point = [col + 1, row + 1, height(col + 1, row + 1)];
      const lower: readonly [Point, Point, Point] = [p00, p10, p01];
      const upper: readonly [Point, Point, Point] = [p10, p11, p01];
      // Each quad, then an exact duplicate of each of its triangles.
      triangles.push(lower, upper, lower, upper);
    }
  }

  return { bytes: binaryStlFrom(triangles), triangles: triangles.length };
}

/* --------------------------------------- self-intersection fixtures -- */

/**
 * SELF-INTERSECTION FIXTURES.
 *
 * Hand-authored on exact integer coordinates so the expected answer is decidable
 * by inspection rather than by asking the diagnostic what it thinks. These are
 * the production-path counterparts of the Stage 3C research corpus; the full
 * adversarial corpus stays in `experiments/self-intersection`.
 */

/** Two triangles whose interiors genuinely cross. Expected: one proper crossing. */
export function crossingTrianglesStl(): Buffer {
  return binaryStlFrom([
    [
      [0, 0, 0],
      [4, 0, 0],
      [0, 4, 0],
    ],
    [
      [1, 1, -2],
      [3, 1, 2],
      [1, 3, 2],
    ],
  ]);
}

/**
 * The Stage 3A R17 shell: a bow-tie prism that passes through itself.
 *
 * Closed, manifold, consistently wound — and self-intersecting. The corpus's own
 * demonstration that topology alone cannot establish printability, and the
 * fixture that decided Stage 3C qualification.
 */
export function selfIntersectingShellStl(): Buffer {
  const z0 = 0;
  const z1 = 1;
  const p: Point[] = [
    [0, 0, z0],
    [1, 1, z0],
    [1, 0, z0],
    [0, 1, z0],
  ];
  const q: Point[] = p.map((v) => [v[0], v[1], z1] as Point);
  const triangles: (readonly [Point, Point, Point])[] = [];
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    const a = p[i] ?? [0, 0, 0];
    const b = p[j] ?? [0, 0, 0];
    const c = q[j] ?? [0, 0, 0];
    const d = q[i] ?? [0, 0, 0];
    triangles.push([a, b, c], [a, c, d]);
  }
  const [p0, p1, p2, p3] = p as [Point, Point, Point, Point];
  const [q0, q1, q2, q3] = q as [Point, Point, Point, Point];
  triangles.push([p0, p2, p1], [p0, p3, p2], [q0, q1, q2], [q0, q2, q3]);
  return binaryStlFrom(triangles);
}

/** A clean conforming grid of `side * side * 2` triangles, no defects. */
export function cleanGridStl(side: number): GeneratedStl {
  const triangles: (readonly [Point, Point, Point])[] = [];
  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const p00: Point = [col, row, 0];
      const p10: Point = [col + 1, row, 0];
      const p01: Point = [col, row + 1, 0];
      const p11: Point = [col + 1, row + 1, 0];
      triangles.push([p00, p10, p01], [p10, p11, p01]);
    }
  }
  return { bytes: binaryStlFrom(triangles), triangles: triangles.length };
}
