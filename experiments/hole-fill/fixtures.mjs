/**
 * HF01 – HF30: THE HOLE-FILL QUALIFICATION CORPUS. RESEARCH ONLY.
 *
 * ANALYTIC WHERE POSSIBLE. Most fixtures are built from shapes whose correct
 * answer is known without running anything: a cube with one face removed has
 * one four-vertex boundary loop and a patch of exactly known area; a concave
 * polygon cap has a known area that a naive fan gets WRONG. Validating a
 * triangulator against another triangulator would only prove they agree.
 *
 * Every fixture reports what it expects, so the runner compares against a
 * stated prediction rather than against whatever came out.
 */

/* ------------------------------------------------------------- helpers -- */

/** Builds a soup mesh: positions are per-corner, indices are 0..3F-1. */
export function soup(triangles) {
  const positions = new Float32Array(triangles.length * 9);
  const indices = new Uint32Array(triangles.length * 3);
  let at = 0;
  for (const [a, b, c] of triangles) {
    for (const point of [a, b, c]) {
      positions[at * 3] = point[0];
      positions[at * 3 + 1] = point[1];
      positions[at * 3 + 2] = point[2];
      indices[at] = at;
      at += 1;
    }
  }
  return { positions, indices };
}

/** The eight corners of an axis-aligned box. */
function boxCorners(size = 10) {
  const s = size;
  return [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, s],
    [s, 0, s],
    [s, s, s],
    [0, s, s],
  ];
}

/**
 * A closed box, minus the faces named in `omit`.
 *
 * Winding is outward-facing throughout, so a removed face leaves a boundary
 * loop whose reversed half-edges wind the way the missing face did.
 */
export function openBox(omit = ['top'], size = 10) {
  const v = boxCorners(size);
  const faces = {
    bottom: [
      [v[0], v[2], v[1]],
      [v[0], v[3], v[2]],
    ],
    top: [
      [v[4], v[5], v[6]],
      [v[4], v[6], v[7]],
    ],
    front: [
      [v[0], v[1], v[5]],
      [v[0], v[5], v[4]],
    ],
    back: [
      [v[2], v[3], v[7]],
      [v[2], v[7], v[6]],
    ],
    left: [
      [v[3], v[0], v[4]],
      [v[3], v[4], v[7]],
    ],
    right: [
      [v[1], v[2], v[6]],
      [v[1], v[6], v[5]],
    ],
  };
  const triangles = [];
  for (const [name, tris] of Object.entries(faces)) {
    if (omit.includes(name)) continue;
    triangles.push(...tris);
  }
  return soup(triangles);
}

/**
 * A polygon fan cap plus a skirt, leaving the polygon's outline open.
 *
 * The skirt is what makes the boundary a genuine mesh boundary rather than a
 * free-floating ring: every boundary edge has exactly one incident face.
 */
export function openPrism(polygon, height = 5) {
  const triangles = [];
  const n = polygon.length;
  const lower = polygon.map(([x, y]) => [x, y, 0]);
  const upper = polygon.map(([x, y]) => [x, y, height]);

  // The skirt, wound so the outward normal points away from the axis.
  for (let index = 0; index < n; index += 1) {
    const next = (index + 1) % n;
    triangles.push([lower[index], upper[index], upper[next]]);
    triangles.push([lower[index], upper[next], lower[next]]);
  }
  /*
   * The bottom cap, fanned. The TOP is left open: that is the hole.
   *
   * THE CAP'S WINDING MUST OPPOSE THE SKIRT'S along every shared edge, or the
   * surface is not consistently orientable. It was written the other way round
   * first, and PMP refused every prism fixture with a topology exception —
   * correctly, because `SurfaceMesh` only represents orientable 2-manifolds.
   * CAD Fixer's own boundary extractor accepted those meshes, because an
   * orientation conflict on an INTERIOR edge does not disturb the boundary
   * loop; the patch it produced was still geometrically right. That divergence
   * is the finding: orientability is a kernel PRECONDITION that CAD Fixer must
   * check itself, not something the boundary walk notices.
   */
  for (let index = 1; index < n - 1; index += 1) {
    triangles.push([lower[0], lower[index], lower[index + 1]]);
  }
  return soup(triangles);
}

/** A regular n-gon in the XY plane. */
export function regularPolygon(n, radius = 10) {
  const points = [];
  for (let index = 0; index < n; index += 1) {
    const angle = (2 * Math.PI * index) / n;
    points.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return points;
}

/** The shoelace area of a closed 2D polygon. Exact for the fixtures below. */
export function polygonArea(points) {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/** An L-shape: the simplest genuinely concave polygon. */
export const L_SHAPE = [
  [0, 0],
  [20, 0],
  [20, 8],
  [8, 8],
  [8, 20],
  [0, 20],
];

/** A deep notch — a fan from any single vertex leaves the polygon. */
export const NOTCH = [
  [0, 0],
  [20, 0],
  [20, 20],
  [11, 20],
  [11, 3],
  [9, 3],
  [9, 20],
  [0, 20],
];

/** A star: many alternating reflex vertices. */
export function star(points = 5, outer = 10, inner = 4) {
  const result = [];
  for (let index = 0; index < points * 2; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = (Math.PI * index) / points;
    result.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return result;
}

/* -------------------------------------------------------- the fixtures -- */

/**
 * Each fixture states what it IS, and what the extractor and a correct filler
 * should produce. `expect.loops` is the number of eligible ordered loops;
 * `expect.refusal` names the reason an ineligible one must be refused with.
 */
export function corpus() {
  const cases = [];
  const add = (id, what, build, expect) => cases.push({ id, what, build, expect });

  /* ------------------------------------------- simple planar openings -- */

  add('HF01', 'triangular planar hole', () => openPrism(regularPolygon(3, 10)), {
    loops: 1,
    loopVertices: 3,
    planar: true,
    patchArea: polygonArea(regularPolygon(3, 10)),
    closesShell: true,
  });

  add('HF02', 'quad planar hole (cube, top face removed)', () => openBox(['top']), {
    loops: 1,
    loopVertices: 4,
    planar: true,
    patchArea: 100,
    closesShell: true,
  });

  add('HF03', 'convex 8-vertex hole', () => openPrism(regularPolygon(8, 10)), {
    loops: 1,
    loopVertices: 8,
    planar: true,
    patchArea: polygonArea(regularPolygon(8, 10)),
    closesShell: true,
  });

  add('HF04', 'concave planar hole (L-shape)', () => openPrism(L_SHAPE), {
    loops: 1,
    loopVertices: 6,
    planar: true,
    patchArea: polygonArea(L_SHAPE),
    closesShell: true,
    concave: true,
  });

  add('HF05', 'deep concave notch', () => openPrism(NOTCH), {
    loops: 1,
    loopVertices: 8,
    planar: true,
    patchArea: polygonArea(NOTCH),
    closesShell: true,
    concave: true,
  });

  /* ----------------------------------------------------- non-planar -- */

  add('HF06', 'mildly non-planar loop', () => warpedPrism(8, 0.0005), {
    loops: 1,
    loopVertices: 8,
    planar: false,
    closesShell: true,
  });

  add('HF07', 'strongly non-planar loop', () => warpedPrism(8, 3), {
    loops: 1,
    loopVertices: 8,
    planar: false,
    closesShell: true,
  });

  add('HF08', 'twisted / saddle loop', () => saddlePrism(8, 3), {
    loops: 1,
    loopVertices: 8,
    planar: false,
    closesShell: true,
  });

  /* --------------------------------------------------------- scaling -- */

  for (const [id, n] of [
    ['HF09', 32],
    ['HF10', 128],
    ['HF11', 512],
    ['HF12', 2000],
  ]) {
    add(id, `${n}-vertex loop`, () => openPrism(regularPolygon(n, 10)), {
      loops: 1,
      loopVertices: n,
      planar: true,
      patchArea: polygonArea(regularPolygon(n, 10)),
      closesShell: true,
    });
  }

  /* --------------------------------------------------- multiple holes -- */

  add(
    'HF13',
    'two independent holes (box, top and bottom removed)',
    () => openBox(['top', 'bottom']),
    {
      loops: 2,
      loopVertices: 4,
      planar: true,
      closesShell: true,
    },
  );

  add('HF14', 'many small holes', () => manyHoles(6), { loops: 6, planar: true });

  /* ------------------------------------------- non-manifold refusals -- */

  add('HF15', 'boundary vertex of degree > 2', () => twoLoopsSharingVertex(), {
    loops: 0,
    refusal: 'BRANCHED_BOUNDARY',
  });

  add('HF16', 'T-junction boundary', () => tJunction(), { loops: 0, refusalAny: true });

  add('HF17', 'bow-tie boundary', () => bowTie(), { loops: 0, refusalAny: true });

  add('HF18', 'two loops sharing a vertex', () => twoLoopsSharingVertex(), {
    loops: 0,
    refusalAny: true,
  });

  add('HF19', 'duplicate boundary edge', () => duplicateBoundaryEdge(), {
    loops: 0,
    refusalAny: true,
  });

  add('HF20', 'repeated boundary vertex in one loop', () => pinchedLoop(), {
    loops: 0,
    refusalAny: true,
  });

  /* ---------------------------------------------- degenerate refusals -- */

  add('HF21', 'zero-length boundary edge', () => zeroLengthEdge(), { loops: 0, refusalAny: true });

  add('HF22', 'entirely collinear loop', () => collinearLoop(), {
    loops: 1,
    loopVertices: 4,
    degenerateArea: true,
  });

  add('HF23', 'near-collinear boundary', () => openPrism(nearCollinear()), {
    loops: 1,
    loopVertices: 6,
    planar: true,
    patchArea: polygonArea(nearCollinear()),
    closesShell: true,
  });

  /* ------------------------------------------------ geometric hazards -- */

  add('HF24', 'hole next to existing self-intersection', () => holeNearCrossing(), {
    loops: 1,
    loopVertices: 4,
    preexistingSelfIntersection: true,
  });

  add('HF25', 'patch would pierce an internal wall', () => holePiercedByWall(), {
    loops: 1,
    loopVertices: 4,
    patchMustIntersect: true,
  });

  add('HF26', 'opposite surface very close to, but not through, the patch', () => holeNearWall(), {
    loops: 1,
    loopVertices: 4,
    patchMustIntersect: false,
  });

  add('HF27', 'globally reversed winding', () => reverseWinding(openBox(['top'])), {
    loops: 1,
    loopVertices: 4,
    planar: true,
    closesShell: true,
    reversed: true,
  });

  add('HF28', 'mixed local winding around the boundary', () => mixedWinding(), {
    loops: 0,
    refusalAny: true,
  });

  add('HF29', 'very large part with one small hole', () => largePartWithHole(40_000), {
    loops: 1,
    loopVertices: 4,
    planar: true,
  });

  add('HF30', 'Float32-sensitive tiny geometry', () => openPrism(regularPolygon(6, 1e-3)), {
    loops: 1,
    loopVertices: 6,
    planar: true,
    patchArea: polygonArea(regularPolygon(6, 1e-3)),
    closesShell: true,
    tiny: true,
  });

  return cases;
}

/* ---------------------------------------------------- fixture builders -- */

/**
 * A prism whose open rim is displaced by a SECOND harmonic.
 *
 * THE FIRST HARMONIC IS NOT NON-PLANAR, which is why this uses the second. A
 * displacement `z = A·sin(theta)` around a circle of radius r is exactly
 * `z = (A/r)·y` — a linear function of y, so the rim lies on a TILTED PLANE and
 * is perfectly planar. The first version of these fixtures used one period and
 * measured a relative deviation of 8e-9: they were testing tilt, not warp, and
 * the planarity policy was right to accept them.
 *
 * `sin(2·theta)` is quadratic in the plane and genuinely leaves it.
 */
function warpedPrism(n, amplitude) {
  const polygon = regularPolygon(n, 10);
  const triangles = [];
  const lower = polygon.map(([x, y]) => [x, y, 0]);
  const upper = polygon.map(([x, y], index) => [
    x,
    y,
    5 + amplitude * Math.sin((4 * Math.PI * index) / n),
  ]);
  for (let index = 0; index < n; index += 1) {
    const next = (index + 1) % n;
    triangles.push([lower[index], upper[index], upper[next]]);
    triangles.push([lower[index], upper[next], lower[next]]);
  }
  for (let index = 1; index < n - 1; index += 1) {
    triangles.push([lower[0], lower[index], lower[index + 1]]);
  }
  return soup(triangles);
}

/*
 * AMPLITUDE IS BOUNDED BELOW THE BASE HEIGHT ON PURPOSE. At amplitude 5 the
 * rim's lowest points land on z = 0, welding onto the bottom cap's vertices
 * under exact identity — which makes the boundary non-manifold and the fixture
 * a test of something else entirely. It was written that way first, and the
 * extractor correctly refused it; the fixture was wrong, not the refusal.
 */
function saddlePrism(n, amplitude) {
  const polygon = regularPolygon(n, 10);
  const triangles = [];
  const lower = polygon.map(([x, y]) => [x, y, 0]);
  // Two full periods: up, down, up, down — a saddle rather than a tilt.
  const upper = polygon.map(([x, y], index) => [
    x,
    y,
    5 + amplitude * Math.sin((4 * Math.PI * index) / n),
  ]);
  for (let index = 0; index < n; index += 1) {
    const next = (index + 1) % n;
    triangles.push([lower[index], upper[index], upper[next]]);
    triangles.push([lower[index], upper[next], lower[next]]);
  }
  for (let index = 1; index < n - 1; index += 1) {
    triangles.push([lower[0], lower[index], lower[index + 1]]);
  }
  return soup(triangles);
}

function manyHoles(count) {
  const triangles = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * 40;
    const { positions, indices } = openPrism(regularPolygon(4, 5));
    for (let face = 0; face < indices.length / 3; face += 1) {
      const corners = [];
      for (let corner = 0; corner < 3; corner += 1) {
        const at = indices[face * 3 + corner] * 3;
        corners.push([positions[at] + offset, positions[at + 1], positions[at + 2]]);
      }
      triangles.push(corners);
    }
  }
  return soup(triangles);
}

/** Two open squares meeting at exactly one shared corner. */
function twoLoopsSharingVertex() {
  const a = openPrism([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]);
  const b = openPrism([
    [10, 10],
    [20, 10],
    [20, 20],
    [10, 20],
  ]);
  return concat(a, b);
}

/** A strip whose boundary has a vertex with three incident boundary edges. */
function tJunction() {
  const base = openPrism([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]);
  // A flap attached along a single edge creates a boundary branch at its ends.
  const flap = soup([
    [
      [10, 0, 5],
      [10, 10, 5],
      [18, 5, 5],
    ],
  ]);
  return concat(base, flap);
}

/** Two triangles meeting at one vertex only. */
function bowTie() {
  return soup([
    [
      [0, 0, 0],
      [10, 0, 0],
      [5, 8, 0],
    ],
    [
      [5, 8, 0],
      [12, 16, 0],
      [0, 16, 0],
    ],
  ]);
}

/** The same directed boundary edge contributed twice. */
function duplicateBoundaryEdge() {
  return soup([
    [
      [0, 0, 0],
      [10, 0, 0],
      [5, 8, 0],
    ],
    [
      [0, 0, 0],
      [10, 0, 0],
      [5, -8, 0],
    ],
    [
      [0, 0, 0],
      [10, 0, 0],
      [5, 16, 0],
    ],
  ]);
}

/** A boundary walk that returns to a vertex it already used. */
function pinchedLoop() {
  const a = openPrism([
    [0, 0],
    [10, 0],
    [5, 9],
  ]);
  const b = openPrism([
    [5, 9],
    [15, 9],
    [10, 18],
  ]);
  return concat(a, b);
}

/** A triangle two of whose corners are the identical stored point. */
function zeroLengthEdge() {
  const base = openPrism([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]);
  const sliver = soup([
    [
      [0, 0, 5],
      [0, 0, 5],
      [4, 4, 9],
    ],
  ]);
  return concat(base, sliver);
}

/** Four distinct collinear points: a closed cycle enclosing zero area. */
function collinearLoop() {
  return soup([
    [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ],
    [
      [0, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ],
  ]);
}

function nearCollinear() {
  // Two near-collinear runs, distinct under Float32 but almost straight.
  return [
    [0, 0],
    [10, 0],
    [20, 1e-3],
    [30, 0],
    [30, 20],
    [0, 20],
  ];
}

function holeNearCrossing() {
  const base = openBox(['top']);
  // Two triangles that cross each other, well away from the hole rim.
  const crossing = soup([
    [
      [2, 2, 2],
      [8, 2, 2],
      [5, 8, 6],
    ],
    [
      [5, 2, 6],
      [5, 8, 2],
      [2, 5, 2],
    ],
  ]);
  return concat(base, crossing);
}

/**
 * A box open at the top, with an internal fin that CROSSES the rim plane.
 *
 * THE HAZARD THIS FIXTURE EXISTS FOR. The boundary loop is a perfectly ordinary
 * planar square, so every topological check passes and a triangulator produces
 * a perfectly ordinary two-triangle patch. That patch then passes straight
 * through the fin. Boundary-edge counts go down, Euler is right, the patch is
 * wound correctly — and the model is worse than before.
 *
 * The fin is a separate open shell, so it contributes its own boundary; the
 * selected loop is still the four-vertex rim, which is why the runner selects
 * the LARGEST eligible loop rather than the first.
 */
function holePiercedByWall() {
  const base = openBox(['top'], 10);
  // A vertical quad spanning z = 8 .. 12, inside the footprint: it crosses the
  // rim plane at z = 10.
  const fin = soup([
    [
      [5, 1, 8],
      [5, 9, 8],
      [5, 9, 12],
    ],
    [
      [5, 1, 8],
      [5, 9, 12],
      [5, 1, 12],
    ],
  ]);
  return concat(base, fin);
}

/**
 * The same shape with the fin stopping just BELOW the rim plane.
 *
 * THE OTHER HALF OF THE PROOF. A check that flagged this too would be useless:
 * geometry near a patch is not geometry through it, and a validator that
 * cannot tell them apart would refuse every hole in a dense model.
 */
function holeNearWall() {
  const base = openBox(['top'], 10);
  const fin = soup([
    [
      [5, 1, 8],
      [5, 9, 8],
      [5, 9, 9.999],
    ],
    [
      [5, 1, 8],
      [5, 9, 9.999],
      [5, 1, 9.999],
    ],
  ]);
  return concat(base, fin);
}

function reverseWinding({ positions, indices }) {
  const flipped = new Uint32Array(indices.length);
  for (let face = 0; face < indices.length / 3; face += 1) {
    flipped[face * 3] = indices[face * 3];
    flipped[face * 3 + 1] = indices[face * 3 + 2];
    flipped[face * 3 + 2] = indices[face * 3 + 1];
  }
  return { positions, indices: flipped };
}

/**
 * A face TOUCHING THE RIM reversed relative to its neighbours.
 *
 * THE FACE HAS TO BE ON THE BOUNDARY for this to test anything. Reversing an
 * interior face away from the opening is a winding defect the topology report
 * already catches, and it leaves the rim's half-edge directions untouched — the
 * loop extracts perfectly, which is correct. Reversing a face that OWNS a
 * boundary edge flips the direction the missing face would have used, so two
 * boundary half-edges now leave the same vertex and the loop is genuinely
 * ambiguous. That is the case worth refusing.
 */
function mixedWinding() {
  const { positions, indices } = openBox(['top']);
  const flipped = new Uint32Array(indices);
  const rimFace = findRimFace(positions, indices);
  const b = flipped[rimFace * 3 + 1];
  flipped[rimFace * 3 + 1] = flipped[rimFace * 3 + 2];
  flipped[rimFace * 3 + 2] = b;
  return { positions, indices: flipped };
}

/** The first face with two corners on the open top rim (z === size). */
function findRimFace(positions, indices) {
  let maxZ = -Infinity;
  for (let index = 2; index < positions.length; index += 3) {
    if (positions[index] > maxZ) maxZ = positions[index];
  }
  for (let face = 0; face < indices.length / 3; face += 1) {
    let onRim = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      if (positions[indices[face * 3 + corner] * 3 + 2] === maxZ) onRim += 1;
    }
    if (onRim === 2) return face;
  }
  return 0;
}

function largePartWithHole(targetTriangles) {
  const base = openBox(['top']);
  const filler = [];
  const side = Math.ceil(Math.sqrt(targetTriangles / 2));
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const x = 100 + column * 0.5;
      const y = row * 0.5;
      filler.push([
        [x, y, 0],
        [x + 0.4, y, 0],
        [x, y + 0.4, 0],
      ]);
      filler.push([
        [x + 0.4, y, 0],
        [x + 0.4, y + 0.4, 0],
        [x, y + 0.4, 0],
      ]);
    }
  }
  return concat(base, soup(filler));
}

export function concat(left, right) {
  const positions = new Float32Array(left.positions.length + right.positions.length);
  positions.set(left.positions, 0);
  positions.set(right.positions, left.positions.length);
  const indices = new Uint32Array(left.indices.length + right.indices.length);
  indices.set(left.indices, 0);
  const offset = left.positions.length / 3;
  for (let index = 0; index < right.indices.length; index += 1) {
    indices[left.indices.length + index] = right.indices[index] + offset;
  }
  return { positions, indices };
}
