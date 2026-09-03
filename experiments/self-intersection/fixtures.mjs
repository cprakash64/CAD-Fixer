/**
 * Stage 3C-1A adversarial self-intersection corpus. RESEARCH ONLY.
 *
 * EVERY FIXTURE IS HAND-AUTHORED ON INTEGER OR EXACTLY-REPRESENTABLE
 * COORDINATES, so the expected answer is decidable by inspection rather than by
 * asking the implementation what it thinks. A corpus whose expectations came
 * from the code under test would prove only that the code is self-consistent.
 *
 * Vertices are TOPOLOGICAL: a shared index means a genuinely shared vertex,
 * exactly as Stage 2's exact stored-coordinate identity defines it. That is what
 * lets the classifier tell a conforming neighbour from an overlap.
 */

/** Triangulated unit cube, 8 shared vertices, 12 faces, closed and clean. */
function cube(scale = 1, dx = 0, dy = 0, dz = 0) {
  const p = [];
  for (const [x, y, z] of [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ]) {
    p.push(x * scale + dx, y * scale + dy, z * scale + dz);
  }
  const t = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0,
    4, 3, 4, 7,
  ];
  return { positions: p, triangles: t };
}

/** A regular grid of quads on the z=0 plane: many shared edges and vertices. */
function grid(side, scale = 1) {
  const positions = [];
  for (let y = 0; y <= side; y += 1) {
    for (let x = 0; x <= side; x += 1) positions.push(x * scale, y * scale, 0);
  }
  const triangles = [];
  const at = (x, y) => y * (side + 1) + x;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      triangles.push(at(x, y), at(x + 1, y), at(x, y + 1));
      triangles.push(at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
    }
  }
  return { positions, triangles };
}

export const FIXTURES = [
  {
    id: 'SI01',
    name: 'clean tetrahedron',
    why: 'Four faces meeting only at shared edges and vertices. Every pair is a conforming neighbour, so nothing may be reported.',
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
    expect: { status: 'CHECKED', intersecting: 0 },
  },
  {
    id: 'SI02',
    name: 'clean triangulated cube',
    why: '12 faces sharing 8 vertices. Coplanar face pairs on each side share an edge legitimately; nothing crosses.',
    ...cube(),
    expect: { status: 'CHECKED', intersecting: 0 },
  },
  {
    id: 'SI03',
    name: 'two separated triangles',
    why: 'Bounding boxes do not even overlap; broadphase should emit no candidate.',
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 10, 10, 11, 10, 10, 10, 11, 10],
    triangles: [0, 1, 2, 3, 4, 5],
    expect: { status: 'CHECKED', intersecting: 0, candidates: 0 },
  },
  {
    id: 'SI04',
    name: 'two properly crossing triangles',
    why: 'A vertical triangle passes through the interior of a horizontal one; the interiors genuinely cross.',
    positions: [0, 0, 0, 4, 0, 0, 0, 4, 0, 1, 1, -2, 3, 1, 2, 1, 3, 2],
    triangles: [0, 1, 2, 3, 4, 5],
    expect: { status: 'CHECKED', intersecting: 1, properCrossing: 1 },
  },
  {
    id: 'SI05',
    name: 'small but exactly representable gap',
    why: 'Separated by 2^-20 in z, exactly representable in binary floating point. A tolerance-based detector collapses this; an exact one must not.',
    positions: [
      0, 0, 0, 4, 0, 0, 0, 4, 0, 1, 1, 0.00000095367431640625, 3, 1, 0.00000095367431640625, 1, 3,
      0.00000095367431640625,
    ],
    triangles: [0, 1, 2, 3, 4, 5],
    expect: { status: 'CHECKED', intersecting: 0 },
  },
  {
    id: 'SI06',
    name: 'exact non-adjacent point touch',
    why: 'Two triangles with NO shared topological vertex whose corners land on the identical coordinate. Geometric contact at exactly one point.',
    positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, -2, 0, 0, 0, -2, 0],
    triangles: [0, 1, 2, 3, 4, 5],
    expect: { status: 'CHECKED', contactOnly: true },
  },
  {
    id: 'SI07',
    name: 'exact non-adjacent edge touch',
    why: 'Two coplanar triangles that share a full edge geometrically but NOT topologically (distinct vertex ids at identical coordinates).',
    positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, -2, 0],
    triangles: [0, 1, 2, 3, 4, 5],
    expect: { status: 'CHECKED', contactOnly: true },
  },
  {
    id: 'SI08',
    name: 'coplanar partial overlap',
    why: 'Two coplanar triangles overlapping over a genuine area. The case a plane-crossing test misses entirely.',
    positions: [0, 0, 0, 4, 0, 0, 0, 4, 0, 1, 1, 0, 5, 1, 0, 1, 5, 0],
    triangles: [0, 1, 2, 3, 4, 5],
    expect: { status: 'CHECKED', intersecting: 1, coplanarOverlap: 1 },
  },
  {
    id: 'SI09',
    name: 'coplanar containment',
    why: 'A small coplanar triangle entirely inside a larger one. Overlap area is the whole small triangle.',
    positions: [0, 0, 0, 8, 0, 0, 0, 8, 0, 1, 1, 0, 3, 1, 0, 1, 3, 0],
    triangles: [0, 1, 2, 3, 4, 5],
    expect: { status: 'CHECKED', intersecting: 1, coplanarOverlap: 1 },
  },
  {
    id: 'SI10',
    name: 'identical same-orientation duplicate',
    why: 'The same triangle twice, same winding. Stage 2 already reports this as a duplicate defect; it must not be recounted as a crossing.',
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    triangles: [0, 1, 2, 0, 1, 2],
    expect: { status: 'CHECKED', duplicate: 1, intersecting: 0 },
  },
  {
    id: 'SI11',
    name: 'identical reversed duplicate',
    why: 'Same three vertices, opposite winding. May encode a zero-thickness feature; still a duplicate, still not a crossing.',
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    triangles: [0, 1, 2, 0, 2, 1],
    expect: { status: 'CHECKED', duplicate: 1, intersecting: 0 },
  },
  {
    id: 'SI12',
    name: 'manifold neighbours sharing one edge',
    why: 'The commonest configuration in any triangulated surface. If this reports, every mesh is broken.',
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    triangles: [0, 1, 2, 0, 2, 3],
    expect: { status: 'CHECKED', intersecting: 0, legitimate: 1 },
  },
  {
    id: 'SI13',
    name: 'triangles sharing only their topological vertex',
    why: 'Two faces meeting at exactly one shared vertex and nowhere else — legitimate in a valid fan.',
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0],
    triangles: [0, 1, 2, 0, 3, 4],
    expect: { status: 'CHECKED', intersecting: 0, legitimate: 1 },
  },
  {
    id: 'SI14',
    name: 'adjacent faces overlapping beyond their shared edge',
    why: 'Shares edge (0,1) topologically but folds back so the two faces overlap in area. A real defect that adjacency must not excuse.',
    positions: [0, 0, 0, 4, 0, 0, 0, 3, 0, 1, 1, 0],
    triangles: [0, 1, 2, 0, 1, 3],
    expect: { status: 'CHECKED', adjacentBeyond: 1 },
  },
  {
    id: 'SI15',
    name: 'adjacent-at-vertex faces crossing beyond it',
    why: 'Shares exactly one vertex, but the second face passes through the first face interior.',
    positions: [0, 0, 0, 4, 0, 0, 0, 4, 0, 1, 1, -2, 1, 1, 2],
    triangles: [0, 1, 2, 0, 3, 4],
    expect: { status: 'CHECKED', anyDefect: true },
  },
  {
    id: 'SI16',
    name: 'non-manifold edge neighbourhood',
    why: 'Three faces on one shared edge. Legal input for a diagnostic; must not crash and must not invent crossings.',
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1],
    triangles: [0, 1, 2, 0, 1, 3, 0, 1, 4],
    expect: { status: 'CHECKED', intersecting: 0 },
  },
  {
    id: 'SI17',
    name: 'bow-tie vertex',
    why: 'Two fans meeting at a single vertex only. Non-manifold VERTEX, not an intersection.',
    positions: [0, 0, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0],
    triangles: [0, 1, 2, 0, 3, 4],
    expect: { status: 'CHECKED', intersecting: 0 },
  },
  {
    id: 'SI18',
    name: 'repeated-position degenerate triangle',
    why: 'Two corners are the same topological vertex. Outside the narrowphase precondition, so it must be SKIPPED and the report must say PARTIAL.',
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    triangles: [0, 1, 2, 0, 1, 1],
    expect: { status: 'PARTIAL', skippedFaces: 1 },
  },
  {
    id: 'SI19',
    name: 'collinear zero-area triangle',
    why: 'Three distinct vertices on one line: no plane, no area. Also outside the precondition.',
    positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0],
    triangles: [0, 1, 2, 0, 1, 3],
    expect: { status: 'PARTIAL', skippedFaces: 1 },
  },
  {
    id: 'SI20',
    name: 'large coordinate magnitude crossing',
    why: 'SI04 translated by 2^20. Exact predicates must not lose the crossing at magnitude.',
    positions: (() => {
      const o = 1048576;
      return [
        0 + o,
        0 + o,
        0 + o,
        4 + o,
        0 + o,
        0 + o,
        0 + o,
        4 + o,
        0 + o,
        1 + o,
        1 + o,
        -2 + o,
        3 + o,
        1 + o,
        2 + o,
        1 + o,
        3 + o,
        2 + o,
      ];
    })(),
    triangles: [0, 1, 2, 3, 4, 5],
    expect: { status: 'CHECKED', intersecting: 1, properCrossing: 1 },
  },
  {
    id: 'SI21',
    name: 'very small coordinate magnitude crossing',
    why: 'SI04 scaled by 2^-20, an exact binary scaling. Classification must be scale-invariant.',
    positions: (() => {
      const s = Math.pow(2, -20);
      return [
        0,
        0,
        0,
        4 * s,
        0,
        0,
        0,
        4 * s,
        0,
        1 * s,
        1 * s,
        -2 * s,
        3 * s,
        1 * s,
        2 * s,
        1 * s,
        3 * s,
        2 * s,
      ];
    })(),
    triangles: [0, 1, 2, 3, 4, 5],
    expect: { status: 'CHECKED', intersecting: 1, properCrossing: 1 },
  },
  {
    id: 'SI22',
    name: 'multiple independent crossings',
    why: 'Three disjoint copies of SI04, far apart. Counts must be exactly three times SI04 and affected faces exactly six.',
    positions: (() => {
      const p = [];
      for (let k = 0; k < 3; k += 1) {
        const o = k * 100;
        p.push(0 + o, 0, 0, 4 + o, 0, 0, 0 + o, 4, 0, 1 + o, 1, -2, 3 + o, 1, 2, 1 + o, 3, 2);
      }
      return p;
    })(),
    triangles: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    expect: { status: 'CHECKED', intersecting: 3, properCrossing: 3, affected: 6 },
  },
  {
    id: 'SI26',
    name: 'clean 32x32 manifold grid (2048 faces)',
    why: 'A large conforming surface: thousands of shared edges and vertices, zero geometric defects. The false-positive gate.',
    ...grid(32),
    expect: { status: 'CHECKED', intersecting: 0 },
  },
  {
    id: 'SI27',
    name: 'pathological all-boxes-overlap fan',
    why: 'Every triangle spans the whole domain, so every AABB overlaps every other: candidate pairs are ~n^2/2. Used to force the resource limit.',
    positions: (() => {
      const p = [0, 0, 0];
      const n = 400;
      for (let i = 0; i < n; i += 1) {
        const a = (i * 2 * Math.PI) / n;
        p.push(Math.cos(a) * 100, Math.sin(a) * 100, 0);
        p.push(Math.cos(a) * 100, Math.sin(a) * 100, 1);
      }
      return p;
    })(),
    triangles: (() => {
      const t = [];
      for (let i = 0; i < 400; i += 1) t.push(0, 1 + i * 2, 2 + i * 2);
      return t;
    })(),
    expect: { pathological: true },
  },
];
