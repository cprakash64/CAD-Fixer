import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import type { NarrowphaseBatchResult, NarrowphaseSamples, PatchNarrowphase } from './contract';

/**
 * THE HP01–HP29 HOLE-FILL CORPUS. Test-only.
 *
 * Every fixture is TRIANGLE SOUP — three independent corners per face, with
 * sequential indices — because that is exactly what an STL import produces.
 * Building them any other way would let a test pass while the real pipeline
 * failed: soup is precisely the case where indices carry no connectivity and
 * topology must be recovered from coordinates.
 *
 * Coordinates are chosen so that shared corners are BIT-IDENTICAL, never merely
 * close. Nothing here relies on a tolerance, and nothing here should: exact
 * stored-coordinate identity is what the engine reasons in.
 *
 * THE STANDARD SHAPE IS AN OPEN TUBE. A polygon `P` at `z = 0` and the same
 * polygon at `z = -h`, joined by vertical quad walls. It is manifold, it is
 * orientable, it has exactly TWO boundary loops, and — crucially — it needs no
 * cap of its own to exist, so a fixture for "fill this hole" does not have to
 * solve the problem it is testing in order to be built. Its walls are embedded
 * for any SIMPLE polygon, concave ones included.
 *
 * χ OF AN OPEN TUBE IS 0, and filling one end gives a disk, χ = 1. So Δχ = +1 is
 * the expected Euler movement for every fillable fixture here.
 *
 * The worker-level cases — HP30 cancellation, HP31 stale revision and stale
 * loop, HP32 forced worker failure — are LIFECYCLE rather than geometry and
 * live with the worker and service suites. There is no geometry that expresses
 * "the user pressed Cancel".
 */

export type Point = readonly [number, number, number];
export type Triangle = readonly [Point, Point, Point];

/** Builds a soup mesh from triangles given as three points each. */
export function soup(triangles: readonly Triangle[]): CanonicalMesh {
  const positions = createPositionArray(triangles.length * 9);
  const indices = createIndexArray(triangles.length * 3);

  triangles.forEach((triangle, face) => {
    triangle.forEach((point, corner) => {
      const base = face * 9 + corner * 3;
      positions[base] = point[0];
      positions[base + 1] = point[1];
      positions[base + 2] = point[2];
      indices[face * 3 + corner] = face * 3 + corner;
    });
  });

  return { positions, indices, metadata: { sourceFormat: 'stl' } };
}

/** Concatenates soup meshes into one. Components stay independent. */
export function concatMeshes(...meshes: readonly CanonicalMesh[]): CanonicalMesh {
  let total = 0;
  for (const mesh of meshes) total += mesh.positions.length;
  const positions = createPositionArray(total);
  let cursor = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, cursor);
    cursor += mesh.positions.length;
  }
  const indices = createIndexArray(total / 3);
  for (let index = 0; index < indices.length; index += 1) indices[index] = index;
  return { positions, indices, metadata: { sourceFormat: 'stl' } };
}

/** A copy with every face's winding reversed. Geometry is unchanged. */
export function reverseWinding(mesh: CanonicalMesh): CanonicalMesh {
  const triangles: Triangle[] = [];
  for (let face = 0; face < mesh.indices.length / 3; face += 1) {
    const corner = (slot: number): Point => {
      const base = (mesh.indices[face * 3 + slot] ?? 0) * 3;
      return [
        mesh.positions[base] ?? 0,
        mesh.positions[base + 1] ?? 0,
        mesh.positions[base + 2] ?? 0,
      ];
    };
    triangles.push([corner(0), corner(2), corner(1)]);
  }
  return soup(triangles);
}

/** A copy translated by `offset`. */
export function translateMesh(mesh: CanonicalMesh, offset: Point): CanonicalMesh {
  const positions = createPositionArray(mesh.positions.length);
  for (let index = 0; index < mesh.positions.length; index += 3) {
    positions[index] = (mesh.positions[index] ?? 0) + offset[0];
    positions[index + 1] = (mesh.positions[index + 1] ?? 0) + offset[1];
    positions[index + 2] = (mesh.positions[index + 2] ?? 0) + offset[2];
  }
  return { ...mesh, positions };
}

/**
 * The tube: polygon `outline` at `z = 0`, the same polygon at `z = -depth`,
 * joined by vertical walls.
 *
 * WINDING IS CONSISTENT AND IS NOT CHOSEN BY A NORMAL. Each wall quad is split
 * so that the TOP rim edge `i → i+1` is traversed by its face as `i+1 → i`,
 * which makes the absent face traverse `i → i+1` — so the walk recovers the
 * outline in its own order, and the patch is wound as the polygon is.
 */
export function tube(outline: readonly (readonly [number, number])[], depth = 1): CanonicalMesh {
  const triangles: Triangle[] = [];
  const count = outline.length;
  for (let index = 0; index < count; index += 1) {
    const here = outline[index] ?? [0, 0];
    const next = outline[(index + 1) % count] ?? [0, 0];
    const topHere: Point = [here[0], here[1], 0];
    const topNext: Point = [next[0], next[1], 0];
    const bottomHere: Point = [here[0], here[1], -depth];
    const bottomNext: Point = [next[0], next[1], -depth];
    triangles.push([topHere, bottomHere, bottomNext]);
    triangles.push([topHere, bottomNext, topNext]);
  }
  return soup(triangles);
}

/** A closed tetrahedron. Adds χ = 2 and no boundary. */
export function tetrahedron(centre: Point, size: number): CanonicalMesh {
  const a: Point = [centre[0], centre[1], centre[2]];
  const b: Point = [centre[0] + size, centre[1], centre[2]];
  const c: Point = [centre[0], centre[1] + size, centre[2]];
  const d: Point = [centre[0], centre[1], centre[2] + size];
  return soup([
    [a, c, b],
    [a, b, d],
    [b, c, d],
    [a, d, c],
  ]);
}

/* --------------------------------------------------------------- HP01-11 -- */

/** A regular polygon outline of `sides` vertices, radius 1, in the XY plane. */
export function regularOutline(sides: number, radius = 1): readonly (readonly [number, number])[] {
  const points: (readonly [number, number])[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = (2 * Math.PI * index) / sides;
    /*
     * ROUNDED TO Float32 AT CONSTRUCTION, deliberately. The canonical buffer is
     * Float32, so a fixture that reasoned in Float64 would be describing
     * geometry the engine never sees — and two vertices that differ only below
     * Float32 would silently weld into one, changing the loop under the test.
     */
    points.push([Math.fround(radius * Math.cos(angle)), Math.fround(radius * Math.sin(angle))]);
  }
  return points;
}

/** HP01: a triangular planar hole. The smallest fillable loop. */
export function hp01TriangleHole(): CanonicalMesh {
  return tube(regularOutline(3));
}

/** HP02: a quadrilateral planar hole. */
export function hp02QuadHole(): CanonicalMesh {
  return tube([
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ]);
}

/** HP03: a convex eight-vertex planar hole. */
export function hp03ConvexEight(): CanonicalMesh {
  return tube(regularOutline(8));
}

/**
 * HP04: a concave planar hole — an L-shape.
 *
 * THE FIRST CASE A FAN GETS WRONG. A fan from the reflex corner emits triangles
 * covering area outside the polygon.
 */
export function hp04ConcaveL(): CanonicalMesh {
  return tube([
    [0, 0],
    [3, 0],
    [3, 1],
    [1, 1],
    [1, 3],
    [0, 3],
  ]);
}

/** HP05: a deeply concave planar hole — a comb with three teeth. */
export function hp05DeepConcave(): CanonicalMesh {
  return tube([
    [0, 0],
    [6, 0],
    [6, 4],
    [5, 4],
    [5, 1],
    [4, 1],
    [4, 4],
    [3, 4],
    [3, 1],
    [2, 1],
    [2, 4],
    [1, 4],
    [1, 1],
    [0, 1],
  ]);
}

/**
 * HP06: a hole warped just INSIDE the relative planarity threshold.
 *
 * One vertex is lifted by `2e-5` of the loop's own extent — comfortably below
 * the 1e-4 policy and comfortably above Float32 noise at this scale, so the
 * fixture tests the policy rather than the representation.
 */
export function hp06MildlyWarped(): CanonicalMesh {
  return warpedTube(2e-5);
}

/** HP07: warped just OUTSIDE the threshold. Refused as non-planar. */
export function hp07NonPlanar(): CanonicalMesh {
  return warpedTube(1e-3);
}

/** HP08: strongly non-planar. A saddle nothing planar could approximate. */
export function hp08StronglyNonPlanar(): CanonicalMesh {
  return warpedTube(0.5);
}

/**
 * A tube whose top rim has one vertex displaced along `z`.
 *
 * The displacement is relative to the loop's extent (2 for a unit-radius
 * regular polygon), so the ratio the policy measures is the number passed in,
 * not an absolute distance that would mean different things at different sizes.
 */
function warpedTube(relativeLift: number): CanonicalMesh {
  const outline = regularOutline(8);
  const extent = 2;
  const lift = Math.fround(relativeLift * extent);
  const triangles: Triangle[] = [];
  const topZ = (index: number): number => (index === 0 ? lift : 0);

  for (let index = 0; index < outline.length; index += 1) {
    const nextIndex = (index + 1) % outline.length;
    const here = outline[index] ?? [0, 0];
    const next = outline[nextIndex] ?? [0, 0];
    const topHere: Point = [here[0], here[1], topZ(index)];
    const topNext: Point = [next[0], next[1], topZ(nextIndex)];
    const bottomHere: Point = [here[0], here[1], -1];
    const bottomNext: Point = [next[0], next[1], -1];
    triangles.push([topHere, bottomHere, bottomNext]);
    triangles.push([topHere, bottomNext, topNext]);
  }
  return soup(triangles);
}

/** HP09/HP10/HP11: a hole with exactly `vertices` boundary vertices. */
export function hpBoundaryOfSize(vertices: number): CanonicalMesh {
  // A radius large enough that neighbouring vertices stay distinct in Float32
  // at several hundred sides: at radius 1,000 the chord at 514 sides is ~12,
  // far above the ~6e-5 Float32 spacing there.
  return tube(regularOutline(vertices, 1_000), 100);
}

/* --------------------------------------------------------------- HP12-20 -- */

/** HP12: two independent openings. Selecting one must not touch the other. */
export function hp12TwoIndependentHoles(): CanonicalMesh {
  return concatMeshes(hp02QuadHole(), translateMesh(hp02QuadHole(), [10, 0, 0]));
}

/**
 * HP13: a branched boundary — three triangles meeting at ONE vertex, sharing no
 * edge. Three boundary half-edges leave the apex and no rule can pick one.
 */
export function hp13BranchedBoundary(): CanonicalMesh {
  const apex: Point = [0, 0, 0];
  return soup([
    [apex, [1, 0, 0], [1, 1, 0]],
    [apex, [-1, 1, 0], [-1, 0, 0]],
    [apex, [0, 0, 1], [0, 1, 1]],
  ]);
}

/**
 * HP14: a T-junction. One face spans `(0,0)–(2,0)`; two others meet at the
 * midpoint `(1,0)`, which is a real vertex for them and no vertex at all for the
 * long edge. The boundary that results is not one simple cycle.
 */
export function hp14TJunction(): CanonicalMesh {
  return soup([
    [
      [0, 0, 0],
      [2, 0, 0],
      [1, 2, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [0.5, -1, 0],
    ],
    [
      [1, 0, 0],
      [2, 0, 0],
      [1.5, -1, 0],
    ],
  ]);
}

/** HP15: a bow-tie — two patches sharing exactly one vertex. */
export function hp15BowTie(): CanonicalMesh {
  const apex: Point = [0, 0, 0];
  return soup([
    [apex, [1, 0, 0], [1, 1, 0]],
    [apex, [1, 1, 0], [0, 1, 0]],
    [apex, [-1, 0, 0], [-1, -1, 0]],
    [apex, [-1, -1, 0], [0, -1, 0]],
  ]);
}

/** HP16: two openings sharing one rim vertex. */
export function hp16TwoLoopsSharingVertex(): CanonicalMesh {
  const first = tube([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]);
  /*
   * A DIFFERENT DEPTH, deliberately. With equal depths the two tubes would also
   * share the VERTICAL edge below the corner, making that edge incident to four
   * faces — a non-manifold edge, which is a different defect with a different
   * refusal. Changing the depth leaves exactly one shared VERTEX, which is the
   * case this fixture is for.
   */
  const second = translateMesh(
    tube(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      2,
    ),
    [1, 1, 0],
  );
  return concatMeshes(first, second);
}

/**
 * HP17: a duplicated wall face on the rim.
 *
 * The duplicate makes the rim edge it carries incident to TWO faces traversing
 * it the same way, so the edge stops being a boundary and the loop stops being
 * closed.
 */
export function hp17DuplicateBoundaryEdge(): CanonicalMesh {
  const base = hp02QuadHole();
  const face = (index: number): Triangle => {
    const corner = (slot: number): Point => {
      const at = (base.indices[index * 3 + slot] ?? 0) * 3;
      return [base.positions[at] ?? 0, base.positions[at + 1] ?? 0, base.positions[at + 2] ?? 0];
    };
    return [corner(0), corner(1), corner(2)];
  };
  const triangles: Triangle[] = [];
  for (let index = 0; index < base.indices.length / 3; index += 1) triangles.push(face(index));
  // Face 1 is the wall triangle carrying the first top-rim edge.
  triangles.push(face(1));
  return soup(triangles);
}

/**
 * HP18: a wall face with a repeated corner, touching the rim.
 *
 * Its "edge" between the two identical corners welds to a single vertex, so the
 * boundary carries a segment with no direction.
 */
export function hp18RepeatedVertex(): CanonicalMesh {
  const repeated: Point = [0, 0, 0];
  return concatMeshes(hp02QuadHole(), soup([[repeated, repeated, [0, 0, -1]]]));
}

/** HP19: a zero-length boundary edge, the same defect stated geometrically. */
export function hp19ZeroLengthEdge(): CanonicalMesh {
  const point: Point = [2, 0, 0];
  return concatMeshes(hp02QuadHole(), soup([[point, point, [3, 0, 0]]]));
}

/** HP20: an entirely collinear boundary. No plane exists to measure against. */
export function hp20CollinearBoundary(): CanonicalMesh {
  return soup([
    [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ],
  ]);
}

/**
 * HP21: a near-collinear but genuinely eligible boundary.
 *
 * A sliver quad, 4 units long and 1/1024 wide. Every vertex is exactly
 * representable in Float32 and the polygon has real area, so it must be FILLED
 * rather than refused — the frozen eligibility rules say nothing about
 * thinness, and inventing a minimum aspect ratio here would refuse geometry the
 * qualification accepted.
 */
export function hp21NearCollinear(): CanonicalMesh {
  const thin = 1 / 1024;
  return tube([
    [0, 0],
    [4, 0],
    [4, thin],
    [0, thin],
  ]);
}

/* --------------------------------------------------------------- HP22-29 -- */

/**
 * HP22: a fillable hole beside a PRE-EXISTING, unrelated source intersection.
 *
 * Two independent triangles crossing each other, far from the hole. The fill
 * must still succeed: the crossing is not something this operation did, and the
 * validator only ever generates pairs containing a patch face — so no
 * source/source pair is even produced, let alone counted.
 */
export function hp22PreExistingSourceIntersection(): CanonicalMesh {
  /*
   * BOTH TRIANGLES SIT ENTIRELY BELOW `z = 0`, so nothing about them can be
   * mistaken for the rim under test — and they cross each other, which is the
   * pre-existing defect the fill must neither fix nor be blamed for.
   */
  const crossing = soup([
    [
      [20, -1, -3],
      [20, 1, -3],
      [20, 0, -1],
    ],
    [
      [19, 0, -2],
      [21, 0, -2],
      [20, 0, -0.5],
    ],
  ]);
  return concatMeshes(hp02QuadHole(), crossing);
}

/**
 * HP23: THE HARD GATE. A topologically perfect fill whose patch runs straight
 * through an opposing surface.
 *
 * A tetrahedron sits inside the tube, straddling `z = 0`, so the patch that
 * closes the top rim passes through it. Every topological postcondition holds —
 * the loop is gone, the loop count drops by one, no non-manifold structure
 * appears, the winding attaches correctly — and χ moves by exactly +1. Only the
 * patch-attributed intersection check can reject it.
 *
 * If this fixture ever validates, the stage is BLOCKED.
 */
export function hp23PatchPiercesOppositeShell(): CanonicalMesh {
  return concatMeshes(hp02QuadHole(), tetrahedron([0.8, 0.8, -0.5], 0.6));
}

/**
 * HP24: an opposing surface CLOSE to the patch but not touching it.
 *
 * The same tetrahedron, lowered so its apex stops 1/1024 below the patch plane.
 * It must VALIDATE. Hole filling does not prove wall thickness, and inventing a
 * clearance requirement here would refuse correct geometry while still proving
 * nothing about printability.
 */
export function hp24ThinWallNoIntersection(): CanonicalMesh {
  const clearance = 1 / 1024;
  return concatMeshes(hp02QuadHole(), tetrahedron([0.8, 0.8, -0.6 - clearance], 0.6));
}

/**
 * HP25: the whole model wound the other way, consistently.
 *
 * MUST FILL. The winding rule is RELATIVE — a patch edge must oppose the source
 * face that owns it — so a globally reversed but internally consistent model is
 * exactly as fillable as the original. Anything that consulted a signed volume
 * or a world axis would get this wrong.
 */
export function hp25GloballyReversed(): CanonicalMesh {
  return reverseWinding(hp02QuadHole());
}

/**
 * HP26: one rim-adjacent face reversed. A MIXED RIM.
 *
 * Refused, and never repaired: filling must not silently fix a winding it was
 * not asked to fix, and the rim has no single side for a patch to face.
 */
export function hp26MixedLocalWinding(): CanonicalMesh {
  const base = hp02QuadHole();
  const triangles: Triangle[] = [];
  for (let face = 0; face < base.indices.length / 3; face += 1) {
    const corner = (slot: number): Point => {
      const at = (base.indices[face * 3 + slot] ?? 0) * 3;
      return [base.positions[at] ?? 0, base.positions[at + 1] ?? 0, base.positions[at + 2] ?? 0];
    };
    // Face 1 carries a top-rim edge; reversing it alone folds the rim there.
    triangles.push(
      face === 1 ? [corner(0), corner(2), corner(1)] : [corner(0), corner(1), corner(2)],
    );
  }
  return soup(triangles);
}

/**
 * HP27: a large but in-policy part with one small hole.
 *
 * Bulk comes from closed tetrahedra, which add faces and χ without adding
 * boundary loops — so the fixture scales the VALIDATOR without changing the
 * topological arithmetic under test.
 */
export function hp27LargeInPolicyPart(extraFaces = 50_000): CanonicalMesh {
  const bodies: CanonicalMesh[] = [hp02QuadHole()];
  const count = Math.ceil(extraFaces / 4);
  for (let index = 0; index < count; index += 1) {
    // Spread along X so boxes do not all pile onto each other.
    bodies.push(tetrahedron([100 + index * 0.5, 0, 0], 0.25));
  }
  return concatMeshes(...bodies);
}

/**
 * HP28: above the part ceiling.
 *
 * DELIBERATELY DEGENERATE AND DELIBERATELY CHEAP, exactly as the
 * self-intersection band fixture is: the ceiling is decided by FACE COUNT
 * alone, so a fixture proving it is refused before allocation must not itself
 * allocate the megabytes the ceiling exists to avoid.
 */
export function hp28AbovePartCeiling(faces: number): CanonicalMesh {
  const positions = createPositionArray(9);
  positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = createIndexArray(faces * 3);
  for (let index = 0; index < indices.length; index += 1) indices[index] = index % 3;
  return { positions, indices, metadata: { sourceFormat: 'stl' } };
}

/**
 * HP29: Float32-sensitive geometry — a unit-sized hole a million units from the
 * origin.
 *
 * Float32 spacing at 1e6 is about 0.0625, so a feature this size survives with
 * only a handful of representable values across it. It is the case where a
 * validator working in the wrong precision, or a candidate judged before
 * narrowing, would disagree with what actually ships.
 */
export function hp29FarFromOrigin(): CanonicalMesh {
  return translateMesh(hp02QuadHole(), [1_000_000, 0, 0]);
}

/* ------------------------------------- TP: differential topology corpus -- */

/**
 * Three triangles sharing one edge, far from everything else.
 *
 * A PRE-EXISTING, UNRELATED non-manifold edge. Its only job is to make the
 * defect KIND `NON_MANIFOLD` already present in the source, so a check that
 * compared kinds rather than identities would see no regression when the patch
 * manufactures a second one.
 */
export function unrelatedNonManifoldCluster(offsetX = 50): CanonicalMesh {
  const a: Point = [offsetX, 0, 0];
  const b: Point = [offsetX + 1, 0, 0];
  return soup([
    [a, b, [offsetX, 1, 0]],
    [a, b, [offsetX, -1, 0]],
    [a, b, [offsetX, 0, 1]],
  ]);
}

/**
 * A closed tetrahedron whose base edge IS the diagonal ear clipping will use.
 *
 * THE POINT OF THE FIXTURE. For `hp02QuadHole` the rim walks
 * (0,0)→(2,0)→(2,2)→(0,2) and the triangulator emits (D,A,B) and (B,C,D), so
 * its ONE internal edge is B–D — `(2,0,0)–(0,2,0)`. This tetrahedron already
 * owns that edge with exactly two faces, which is perfectly manifold on its
 * own. Add the patch and the edge reaches FOUR incident faces: a brand-new
 * non-manifold edge that no earlier check can see.
 *
 * It is closed, so it adds no boundary and leaves the rim eligible; and it
 * shares only topology the patch is entitled to share, so the exact narrowphase
 * classifies every one of those contacts as a legitimate shared edge. This
 * defect is invisible to intersection testing and visible only to a
 * differential on defect IDENTITY.
 */
export function chordTetrahedron(): CanonicalMesh {
  const b: Point = [2, 0, 0];
  const d: Point = [0, 2, 0];
  const p: Point = [1, 0.5, -1];
  const q: Point = [0.5, 1, -2];
  return soup([
    [b, d, p],
    [b, p, q],
    [b, q, d],
    [d, q, p],
  ]);
}

/** TP01: a clean source and a clean fill. */
export function tp01CleanFill(): CanonicalMesh {
  return hp02QuadHole();
}

/** TP02 / TP05: an unrelated pre-existing non-manifold edge, and nothing new. */
export function tp02ExistingNonManifoldOnly(): CanonicalMesh {
  return concatMeshes(hp02QuadHole(), unrelatedNonManifoldCluster());
}

/**
 * TP03 / TP04 / TP06: the case a defect-KIND comparison cannot see.
 *
 * The source already contains a non-manifold edge (so the kind is present) AND
 * a chord the patch is about to land on top of. The candidate's defect kinds
 * are identical to the source's; its defect IDENTITIES are not.
 */
export function tp03ChordCollisionWithExistingDefect(): CanonicalMesh {
  return concatMeshes(hp02QuadHole(), chordTetrahedron(), unrelatedNonManifoldCluster());
}

/** The control: the same chord collision with NO pre-existing defect at all. */
export function tp04ChordCollisionAlone(): CanonicalMesh {
  return concatMeshes(hp02QuadHole(), chordTetrahedron());
}

/* --------------------------------------------------- review-pass cases -- */

/**
 * REVIEW C1: a source face COPLANAR WITH THE PATCH and overlapping its area.
 *
 * The nastiest kind for a naive checker. A plane-crossing test finds nothing —
 * the two surfaces never cross, they lie in the same plane — and a
 * "do the triangles share a vertex" exclusion finds nothing either, because
 * they share none. Only an exact coplanar-overlap classification sees it, which
 * is precisely the case Stage 3C's `classify_pair` was written to catch and the
 * research separating-axis checker cannot.
 */
export function reviewCoplanarOverlap(): CanonicalMesh {
  return concatMeshes(
    hp02QuadHole(),
    soup([
      [
        [0.5, 0.5, 0],
        [1.5, 0.5, 0],
        [1, 1.5, 0],
      ],
    ]),
  );
}

/**
 * REVIEW C2: a needle whose apex touches the patch's INTERIOR at one point.
 *
 * Not a crossing, not an overlap, and not adjacency: two faces that share no
 * topology meeting at a single point is a defect the surface should not have,
 * and it is the case a "do they properly cross" test misses entirely. The apex
 * is deliberately off the patch's internal diagonal so the contact lands inside
 * one triangle rather than on an edge two triangles share.
 */
export function reviewNonAdjacentPointTouch(): CanonicalMesh {
  return concatMeshes(
    hp02QuadHole(),
    soup([
      [
        [1.2, 0.9, 0],
        [1.1, 0.2, -1],
        [1.3, 0.2, -1],
      ],
    ]),
  );
}

/**
 * REVIEW A: one mesh SHARED by two parts, so both carry the SAME loop ids.
 *
 * Loop identity is unique WITHIN a part, which is all it has to be: an
 * operation already names a document, a revision and a part. This fixture makes
 * the ambiguity real so a test can prove the part is what disambiguates —
 * naming part B's id while asking for part A fills part A, because part A is
 * what was asked for.
 */
export function reviewSharedMesh(): CanonicalMesh {
  return hp02QuadHole();
}

/* ------------------------------------------------- a second opinion, only -- */

/**
 * A TEST-ONLY separating-axis narrowphase. Never production.
 *
 * WHAT IT IS FOR. The production predicate is the qualified Geogram kernel, and
 * a kernel that is its own oracle proves only that it is self-consistent — the
 * same reason the format writers have structural oracles that share no code
 * with the readers. This is a SECOND, INDEPENDENT implementation, used so the
 * engine's geometric verdicts are asserted twice by two unrelated pieces of
 * arithmetic.
 *
 * WHAT IT IS DELIBERATELY NOT. It is strictly WEAKER than the kernel and must
 * never replace it: it excludes any pair sharing a welded vertex, so it cannot
 * see an overlap that goes BEYOND a legitimately shared edge, and it has no
 * exact predicates — it is floating-point separating-axis arithmetic. It is
 * sound in the direction that matters for a second opinion (it does not invent
 * crossings between faces that share nothing) and incomplete in the other.
 *
 * `packages/mesh-hole-fill` ships no narrowphase of its own, and a production
 * boundary test asserts that this module never becomes reachable from one.
 */
export function referenceNarrowphase(): PatchNarrowphase & { readonly kind: 'reference' } {
  // Annotated rather than inferred: the contract's arrays are backed by
  // `ArrayBufferLike`, and an inferred `Float64Array<ArrayBuffer>` would refuse
  // the assignment in `begin`.
  let positions: Float64Array = new Float64Array(0);
  let triangles: Uint32Array = new Uint32Array(0);
  let patchFaceStart = 0;
  let maxSamples = 0;
  const collected: number[] = [];
  let truncated = false;

  const corners = (face: number): readonly (readonly [number, number, number])[] =>
    [0, 1, 2].map((slot) => {
      const vertex = (triangles[face * 3 + slot] ?? 0) * 3;
      return [
        positions[vertex] ?? 0,
        positions[vertex + 1] ?? 0,
        positions[vertex + 2] ?? 0,
      ] as const;
    });

  const vertexSet = (face: number): Set<number> =>
    new Set([0, 1, 2].map((slot) => triangles[face * 3 + slot] ?? 0));

  return {
    kind: 'reference',
    begin(geometry): void {
      positions = geometry.positions;
      triangles = geometry.triangles;
      patchFaceStart = geometry.patchFaceStart;
      maxSamples = geometry.maxSamples;
      collected.length = 0;
      truncated = false;
    },
    classify(pairs, pairCount): NarrowphaseBatchResult {
      let testedPairs = 0;
      let invalidPatchSourcePairs = 0;
      let invalidPatchPatchPairs = 0;
      let skippedPairs = 0;

      for (let index = 0; index < pairCount; index += 1) {
        const a = pairs[index * 2] ?? 0;
        const b = pairs[index * 2 + 1] ?? 0;
        const aPatch = a >= patchFaceStart;
        const bPatch = b >= patchFaceStart;
        if (!aPatch && !bPatch) continue;

        const shared = vertexSet(a);
        let shares = false;
        for (const vertex of vertexSet(b)) {
          if (shared.has(vertex)) {
            shares = true;
            break;
          }
        }
        if (shares) {
          skippedPairs += 1;
          continue;
        }

        testedPairs += 1;
        if (!trianglesIntersect(corners(a), corners(b))) continue;
        if (aPatch && bPatch) invalidPatchPatchPairs += 1;
        else invalidPatchSourcePairs += 1;
        if (collected.length / 3 < maxSamples) collected.push(a, b, 1);
        else truncated = true;
      }

      return {
        complete: true,
        testedPairs,
        skippedPairs,
        unclassifiedPairs: 0,
        invalidPatchSourcePairs,
        invalidPatchPatchPairs,
      };
    },
    samples(): NarrowphaseSamples {
      return { samples: Uint32Array.from(collected), truncated };
    },
    end(): void {
      positions = new Float64Array(0);
      triangles = new Uint32Array(0);
    },
  };
}

/** Separating-axis triangle overlap. Touching is NOT an overlap. */
function trianglesIntersect(
  p: readonly (readonly [number, number, number])[],
  q: readonly (readonly [number, number, number])[],
): boolean {
  const sub = (a: readonly number[], b: readonly number[]): readonly [number, number, number] => [
    (a[0] ?? 0) - (b[0] ?? 0),
    (a[1] ?? 0) - (b[1] ?? 0),
    (a[2] ?? 0) - (b[2] ?? 0),
  ];
  const cross = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
  ): readonly [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: readonly number[], b: readonly [number, number, number]): number =>
    (a[0] ?? 0) * b[0] + (a[1] ?? 0) * b[1] + (a[2] ?? 0) * b[2];

  const edgesP = [
    sub(p[1] ?? [], p[0] ?? []),
    sub(p[2] ?? [], p[1] ?? []),
    sub(p[0] ?? [], p[2] ?? []),
  ];
  const edgesQ = [
    sub(q[1] ?? [], q[0] ?? []),
    sub(q[2] ?? [], q[1] ?? []),
    sub(q[0] ?? [], q[2] ?? []),
  ];

  const axes: (readonly [number, number, number])[] = [
    cross(edgesP[0] ?? [0, 0, 0], edgesP[1] ?? [0, 0, 0]),
    cross(edgesQ[0] ?? [0, 0, 0], edgesQ[1] ?? [0, 0, 0]),
  ];
  for (const edgeP of edgesP) {
    for (const edgeQ of edgesQ) axes.push(cross(edgeP, edgeQ));
  }

  for (const axis of axes) {
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    if (length === 0) continue;
    const unit: readonly [number, number, number] = [
      axis[0] / length,
      axis[1] / length,
      axis[2] / length,
    ];

    let minP = Infinity;
    let maxP = -Infinity;
    for (const point of p) {
      const value = dot(point, unit);
      minP = Math.min(minP, value);
      maxP = Math.max(maxP, value);
    }
    let minQ = Infinity;
    let maxQ = -Infinity;
    for (const point of q) {
      const value = dot(point, unit);
      minQ = Math.min(minQ, value);
      maxQ = Math.max(maxQ, value);
    }
    // Exact touching is NOT an overlap: coplanar neighbours touch by design.
    if (maxP <= minQ || maxQ <= minP) return false;
  }
  return true;
}
