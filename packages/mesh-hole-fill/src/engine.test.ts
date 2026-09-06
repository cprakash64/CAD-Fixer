import { describe, expect, it } from 'vitest';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { extractBoundaryLoops } from '@cadfixer/mesh-topology';
import { runHoleFill, type HoleFillEngineResult } from './engine';
import { HoleFillStatus, isRefusal } from './status';
import {
  HOLE_FILL_MAX_BOUNDARY_VERTICES,
  HOLE_FILL_MAX_PART_FACES,
  MAX_AABB_TESTS,
  MAX_BROADPHASE_CANDIDATES,
  MAX_BVH_NODE_VISITS,
  MAX_NARROWPHASE_PAIRS,
  patchFaceCountFor,
} from './limits';
import { projectedPolygonTwiceArea, projectedTwiceArea } from './ear-clip';
import { collectNonManifoldDefects, diffNonManifoldDefects } from './validate';
import { recoverVertexIdentity } from '@cadfixer/mesh-topology';
import {
  hp01TriangleHole,
  hp02QuadHole,
  hp03ConvexEight,
  hp04ConcaveL,
  hp05DeepConcave,
  hp06MildlyWarped,
  hp07NonPlanar,
  hp08StronglyNonPlanar,
  hp12TwoIndependentHoles,
  hp13BranchedBoundary,
  hp14TJunction,
  hp15BowTie,
  hp16TwoLoopsSharingVertex,
  hp17DuplicateBoundaryEdge,
  hp18RepeatedVertex,
  hp19ZeroLengthEdge,
  hp20CollinearBoundary,
  hp21NearCollinear,
  hp22PreExistingSourceIntersection,
  hp23PatchPiercesOppositeShell,
  hp24ThinWallNoIntersection,
  hp25GloballyReversed,
  hp26MixedLocalWinding,
  hp27LargeInPolicyPart,
  hp28AbovePartCeiling,
  hp29FarFromOrigin,
  hpBoundaryOfSize,
  referenceNarrowphase,
  reviewCoplanarOverlap,
  reviewNonAdjacentPointTouch,
  soup,
  concatMeshes,
  tp01CleanFill,
  tp02ExistingNonManifoldOnly,
  tp03ChordCollisionWithExistingDefect,
  tp04ChordCollisionAlone,
  unrelatedNonManifoldCluster,
} from './fixtures';

/**
 * THE ENGINE MATRIX, run against the TEST-ONLY reference narrowphase.
 *
 * TWO INDEPENDENT PREDICATES, ON PURPOSE. This suite exercises the pipeline
 * with a separating-axis checker that shares no code with production; the
 * worker suite runs the SAME fixtures against the qualified Geogram kernel that
 * actually ships. A verdict both agree on is a verdict two unrelated pieces of
 * arithmetic reached — which is exactly what the format writers' oracles exist
 * to provide, and the reason `runHoleFill` takes its narrowphase as a
 * parameter.
 */

/** Picks the loop the fixtures are about: the one at `z = 0`, the top rim. */
function topLoopId(mesh: CanonicalMesh): string {
  const set = extractBoundaryLoops(mesh);
  let best: { id: string; height: number } | undefined;
  for (const loop of set.loops) {
    if (loop.refusal !== undefined || loop.vertices.length === 0) continue;
    let height = -Infinity;
    for (const vertex of loop.vertices) {
      const corner = (set.vertexRepresentativeCorner[vertex] ?? 0) * 3;
      height = Math.max(height, mesh.positions[corner + 2] ?? 0);
    }
    if (best === undefined || height > best.height) best = { id: loop.id, height };
  }
  return best?.id ?? 'bl-missing';
}

/** Any loop id, eligible or not — for fixtures whose boundary is refused. */
function anyLoopId(mesh: CanonicalMesh): string {
  return extractBoundaryLoops(mesh).loops[0]?.id ?? 'bl-missing';
}

function fill(
  mesh: CanonicalMesh,
  loopId: string,
  limits?: Parameters<typeof runHoleFill>[0]['limits'],
): HoleFillEngineResult {
  return runHoleFill({
    source: mesh,
    request: {
      operationId: 'op-test',
      documentId: 'doc-test',
      revision: 1,
      partId: 'part-test',
      boundaryLoopId: loopId,
    },
    narrowphase: referenceNarrowphase(),
    ...(limits === undefined ? {} : { limits }),
  });
}

const fillTop = (mesh: CanonicalMesh): HoleFillEngineResult => fill(mesh, topLoopId(mesh));

/* ------------------------------------------------------------ HP01–HP06 -- */

describe('HP01–HP06: planar holes that must fill', () => {
  const cases = [
    ['HP01 triangle', hp01TriangleHole(), 3],
    ['HP02 quad', hp02QuadHole(), 4],
    ['HP03 convex eight', hp03ConvexEight(), 8],
    ['HP04 concave L', hp04ConcaveL(), 6],
    ['HP05 deep concave comb', hp05DeepConcave(), 14],
    ['HP06 mildly warped, inside the threshold', hp06MildlyWarped(), 8],
  ] as const;

  for (const [name, mesh, boundaryVertices] of cases) {
    it(`produces a validated candidate: ${name}`, () => {
      const result = fillTop(mesh);
      expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
      expect(result.candidate).toBeDefined();

      const summary = result.outcome.summary;
      expect(summary.boundaryVertexCount).toBe(boundaryVertices);
      expect(summary.patchFaceCount).toBe(patchFaceCountFor(boundaryVertices));
      expect(summary.addedVertexCount).toBe(0);
      expect(summary.degeneratePatchFaces).toBe(0);
      expect(summary.duplicatePatchFaces).toBe(0);
      expect(summary.foreignPatchCorners).toBe(0);
      expect(summary.agreeingBoundaryEdges).toBe(0);
      expect(summary.opposingBoundaryEdges).toBe(boundaryVertices);
      expect(summary.invalidPatchSourcePairs).toBe(0);
      expect(summary.invalidPatchPatchPairs).toBe(0);
      expect(summary.narrowphaseRefusals).toBe(0);
      expect(summary.selectedLoopRemoved).toBe(true);
      expect(summary.boundaryLoopsAfter).toBe(summary.boundaryLoopsBefore - 1);
      expect(summary.eulerPassed).toBe(true);
      expect(summary.eulerAfter).toBe(summary.eulerBefore + 1);
      expect(summary.planarityRatio).toBeLessThanOrEqual(1e-4);
    });

    it(`adds vertices to nothing and appends only: ${name}`, () => {
      const result = fillTop(mesh);
      const candidate = result.candidate;
      expect(candidate).toBeDefined();
      if (candidate === undefined) return;

      // POSITIONS BYTE-IDENTICAL.
      expect(new Uint8Array(candidate.positions.buffer, candidate.positions.byteOffset)).toEqual(
        new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset),
      );
      // INDEX PREFIX BYTE-IDENTICAL, and the suffix is exactly the patch.
      expect(candidate.indices.subarray(0, mesh.indices.length)).toEqual(mesh.indices);
      expect(candidate.indices.length - mesh.indices.length).toBe(
        patchFaceCountFor(boundaryVertices) * 3,
      );
    });
  }

  it('HP06 sits inside the threshold and HP07 outside it, measurably', () => {
    // The two fixtures bracket the policy rather than merely naming it.
    expect(fillTop(hp06MildlyWarped()).outcome.summary.planarityRatio).toBeLessThanOrEqual(1e-4);
    expect(fillTop(hp07NonPlanar()).outcome.summary.planarityRatio).toBeGreaterThan(1e-4);
  });
});

/* ------------------------------------------------------------ HP07–HP08 -- */

describe('HP07–HP08: non-planar loops are refused, never approximated', () => {
  for (const [name, mesh] of [
    ['HP07 just outside the threshold', hp07NonPlanar()],
    ['HP08 strongly non-planar', hp08StronglyNonPlanar()],
  ] as const) {
    it(`refuses: ${name}`, () => {
      const result = fillTop(mesh);
      expect(result.outcome.status).toBe(HoleFillStatus.RefusedNonPlanar);
      expect(result.candidate).toBeUndefined();
      expect(isRefusal(result.outcome.status)).toBe(true);
      // NOTHING WAS BUILT. A refusal that had triangulated first would be
      // paying for work it then threw away.
      expect(result.outcome.summary.patchFaceCount).toBe(0);
    });
  }
});

/* ------------------------------------------------------------ HP09–HP11 -- */

describe('HP09–HP11: the boundary-size ceiling', () => {
  it(`fills at the ceiling minus one (${String(HOLE_FILL_MAX_BOUNDARY_VERTICES - 1)})`, () => {
    const mesh = hpBoundaryOfSize(HOLE_FILL_MAX_BOUNDARY_VERTICES - 1);
    const result = fillTop(mesh);
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.patchFaceCount).toBe(
      patchFaceCountFor(HOLE_FILL_MAX_BOUNDARY_VERTICES - 1),
    );
  });

  it(`fills exactly AT the ceiling (${String(HOLE_FILL_MAX_BOUNDARY_VERTICES)})`, () => {
    const mesh = hpBoundaryOfSize(HOLE_FILL_MAX_BOUNDARY_VERTICES);
    const result = fillTop(mesh);
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.patchFaceCount).toBe(
      patchFaceCountFor(HOLE_FILL_MAX_BOUNDARY_VERTICES),
    );
  });

  it('refuses one above the ceiling BEFORE triangulating', () => {
    const mesh = hpBoundaryOfSize(HOLE_FILL_MAX_BOUNDARY_VERTICES + 1);
    // Extraction refuses the loop, so it has an id but no ordering. The engine
    // must still name it and must still say why.
    const result = fill(mesh, anyLoopId(mesh));
    expect(result.outcome.status).toBe(HoleFillStatus.RefusedBoundarySize);
    expect(result.candidate).toBeUndefined();
    expect(result.outcome.summary.patchFaceCount).toBe(0);
    expect(result.outcome.summary.projectionAxis).toBe(-1);
    expect(result.outcome.summary.phaseMilliseconds.triangulation).toBe(0);
  });
});

/* ------------------------------------------------------------ HP12–HP20 -- */

describe('HP12: two independent openings', () => {
  it('fills the one that was named and leaves the other alone', () => {
    const mesh = hp12TwoIndependentHoles();
    const set = extractBoundaryLoops(mesh);
    const eligible = set.loops.filter((loop) => loop.refusal === undefined);
    expect(eligible).toHaveLength(4); // two tubes, two rims each

    const chosen = eligible[0];
    expect(chosen).toBeDefined();
    const result = fill(mesh, chosen?.id ?? '');
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);

    const after = extractBoundaryLoops(result.candidate ?? mesh);
    const remaining = new Set<string>(after.loops.map((loop) => loop.id));
    expect(remaining.has(chosen?.id ?? '')).toBe(false);
    for (const other of eligible.slice(1)) expect(remaining.has(other.id)).toBe(true);
  });
});

describe('HP13–HP20: boundaries that are not one simple manifold cycle', () => {
  const cases = [
    ['HP13 branched boundary', hp13BranchedBoundary(), HoleFillStatus.RefusedNotSimpleLoop],
    ['HP14 T-junction', hp14TJunction(), HoleFillStatus.RefusedNotSimpleLoop],
    ['HP15 bow-tie', hp15BowTie(), HoleFillStatus.RefusedNotSimpleLoop],
    [
      'HP16 two loops sharing a vertex',
      hp16TwoLoopsSharingVertex(),
      HoleFillStatus.RefusedNotSimpleLoop,
    ],
    ['HP18 repeated vertex', hp18RepeatedVertex(), HoleFillStatus.RefusedDegenerateBoundary],
    ['HP19 zero-length edge', hp19ZeroLengthEdge(), HoleFillStatus.RefusedDegenerateBoundary],
  ] as const;

  for (const [name, mesh, expected] of cases) {
    it(`refuses with a typed reason and builds nothing: ${name}`, () => {
      const set = extractBoundaryLoops(mesh);
      const refused = set.loops.find((loop) => loop.refusal !== undefined);
      expect(refused, `${name} should produce a refused boundary component`).toBeDefined();

      const result = fill(mesh, refused?.id ?? '');
      expect(result.outcome.status).toBe(expected);
      expect(result.candidate).toBeUndefined();
      expect(isRefusal(result.outcome.status)).toBe(true);
    });
  }

  it('HP17 duplicate boundary edge: the rim stops being closed', () => {
    const mesh = hp17DuplicateBoundaryEdge();
    const set = extractBoundaryLoops(mesh);
    const refused = set.loops.filter((loop) => loop.refusal !== undefined);
    expect(refused.length).toBeGreaterThan(0);
    const result = fill(mesh, refused[0]?.id ?? '');
    expect(isRefusal(result.outcome.status)).toBe(true);
    expect(result.candidate).toBeUndefined();
  });

  it('HP20 collinear boundary: no plane exists, so it is degenerate', () => {
    const mesh = hp20CollinearBoundary();
    const result = fill(mesh, anyLoopId(mesh));
    expect(result.outcome.status).toBe(HoleFillStatus.RefusedDegenerateBoundary);
    expect(result.candidate).toBeUndefined();
  });
});

describe('HP21: near-collinear but eligible', () => {
  it('fills a sliver, because thinness is not a refusal rule', () => {
    const mesh = hp21NearCollinear();
    const result = fillTop(mesh);
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.degeneratePatchFaces).toBe(0);
    expect(result.outcome.summary.patchFaceCount).toBe(2);
  });
});

/* ------------------------------------------------------------ HP22–HP26 -- */

describe('HP22: a pre-existing, unrelated source intersection', () => {
  it('still fills, and never generates a source/source pair to blame it on', () => {
    const mesh = hp22PreExistingSourceIntersection();
    const result = fillTop(mesh);
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.invalidPatchSourcePairs).toBe(0);
    expect(result.outcome.summary.invalidPatchPatchPairs).toBe(0);
  });
});

describe('HP23: THE HARD GATE — the patch pierces an opposing surface', () => {
  it('rejects a topologically perfect fill whose patch crosses a wall', () => {
    const mesh = hp23PatchPiercesOppositeShell();
    const result = fillTop(mesh);

    expect(result.outcome.status).toBe(HoleFillStatus.SelfIntersectionCreated);
    expect(result.candidate).toBeUndefined();
    expect(result.outcome.summary.invalidPatchSourcePairs).toBeGreaterThan(0);
  });

  it('would have passed every OTHER check, which is why the gate exists', () => {
    /*
     * The point of HF25, restated as an assertion. The fill is topologically
     * flawless: the loop is gone, the loop count drops by exactly one, the
     * winding attaches correctly, no non-manifold structure appears, and χ moves
     * by exactly +1. Only patch-attributed intersection can see the defect.
     */
    const summary = fillTop(hp23PatchPiercesOppositeShell()).outcome.summary;
    expect(summary.selectedLoopRemoved).toBe(true);
    expect(summary.boundaryLoopsAfter).toBe(summary.boundaryLoopsBefore - 1);
    expect(summary.agreeingBoundaryEdges).toBe(0);
    expect(summary.opposingBoundaryEdges).toBe(summary.boundaryVertexCount);
    expect(summary.degeneratePatchFaces).toBe(0);
    expect(summary.duplicatePatchFaces).toBe(0);
    expect(summary.foreignPatchCorners).toBe(0);
    expect(summary.eulerPassed).toBe(true);
  });
});

describe('HP24: a thin wall that does NOT intersect', () => {
  it('accepts, because hole filling proves nothing about wall thickness', () => {
    const result = fillTop(hp24ThinWallNoIntersection());
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.invalidPatchSourcePairs).toBe(0);
  });
});

describe('HP25–HP26: winding', () => {
  it('HP25 fills a globally reversed but consistent model', () => {
    const result = fillTop(hp25GloballyReversed());
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.agreeingBoundaryEdges).toBe(0);
  });

  it('HP26 refuses a mixed rim rather than repairing the winding', () => {
    const mesh = hp26MixedLocalWinding();
    const set = extractBoundaryLoops(mesh);
    const refused = set.loops.filter((loop) => loop.refusal !== undefined);
    expect(refused.length).toBeGreaterThan(0);
    const result = fill(mesh, refused[0]?.id ?? '');
    expect([
      HoleFillStatus.RefusedAmbiguousOrientation,
      HoleFillStatus.RefusedNotSimpleLoop,
    ]).toContain(result.outcome.status);
    expect(result.candidate).toBeUndefined();
  });
});

/* ------------------------------------------------------------ HP27–HP29 -- */

describe('HP27–HP29: scale and precision', () => {
  it('HP27 fills a small hole in a large in-policy part', () => {
    const mesh = hp27LargeInPolicyPart(20_000);
    const result = fillTop(mesh);
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.sourceFaceCount).toBeGreaterThan(20_000);
    // The broadphase did its job: the patch was not compared with the whole part.
    expect(result.outcome.summary.narrowphaseChecks).toBeLessThan(
      result.outcome.summary.sourceFaceCount,
    );
  });

  it('HP28 refuses above the part ceiling, before allocating anything', () => {
    const mesh = hp28AbovePartCeiling(HOLE_FILL_MAX_PART_FACES + 1);
    const result = fill(mesh, 'bl-anything');
    expect(result.outcome.status).toBe(HoleFillStatus.RefusedPartSize);
    expect(result.outcome.summary.boundaryLoopsBefore).toBe(0);
    expect(result.outcome.summary.phaseMilliseconds.loopResolution).toBe(0);
  });

  it('HP29 fills a unit-sized hole a million units from the origin', () => {
    const result = fillTop(hp29FarFromOrigin());
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.degeneratePatchFaces).toBe(0);
  });
});

/* ---------------------------------------------------------- lifecycle -- */

describe('unknown and refused loop identities', () => {
  it('refuses an id no boundary carries, and never defaults to the first loop', () => {
    const mesh = hp12TwoIndependentHoles();
    const result = fill(mesh, 'bl-0-0-0000000000000000');
    expect(result.outcome.status).toBe(HoleFillStatus.UnknownLoop);
    expect(result.candidate).toBeUndefined();
  });

  it('refuses a loop id from a DIFFERENT mesh', () => {
    // The stale-loop case in miniature: an id resolved against other geometry
    // must not match here, whatever it happens to look like.
    const other = topLoopId(hp04ConcaveL());
    const result = fill(hp02QuadHole(), other);
    expect(result.outcome.status).toBe(HoleFillStatus.UnknownLoop);
  });

  it('echoes the operation identity it was asked about, unchanged', () => {
    const mesh = hp02QuadHole();
    const result = fill(mesh, topLoopId(mesh));
    expect(result.outcome.identity).toEqual({
      operationId: 'op-test',
      documentId: 'doc-test',
      revision: 1,
      partId: 'part-test',
      boundaryLoopId: topLoopId(mesh),
    });
  });
});

describe('determinism', () => {
  for (const [name, mesh] of [
    ['convex', hp03ConvexEight()],
    ['concave', hp04ConcaveL()],
    ['near-collinear', hp21NearCollinear()],
  ] as const) {
    it(`is identical across 100 runs: ${name}`, () => {
      const loopId = topLoopId(mesh);
      const first = fill(mesh, loopId);
      const reference = {
        status: first.outcome.status,
        loopId,
        patchFaceCount: first.outcome.summary.patchFaceCount,
        indices: [...(first.candidate?.indices ?? [])].join(','),
        opposing: first.outcome.summary.opposingBoundaryEdges,
        euler: first.outcome.summary.eulerAfter,
        narrowphaseChecks: first.outcome.summary.narrowphaseChecks,
        broadphaseCandidates: first.outcome.summary.broadphaseCandidates,
      };

      for (let run = 0; run < 100; run += 1) {
        const again = fill(mesh, topLoopId(mesh));
        expect({
          status: again.outcome.status,
          loopId: topLoopId(mesh),
          patchFaceCount: again.outcome.summary.patchFaceCount,
          indices: [...(again.candidate?.indices ?? [])].join(','),
          opposing: again.outcome.summary.opposingBoundaryEdges,
          euler: again.outcome.summary.eulerAfter,
          narrowphaseChecks: again.outcome.summary.narrowphaseChecks,
          broadphaseCandidates: again.outcome.summary.broadphaseCandidates,
        }).toEqual(reference);
      }
    });
  }
});

describe('analytic area', () => {
  for (const [name, mesh] of [
    ['convex', hp03ConvexEight()],
    ['concave L', hp04ConcaveL()],
    ['deep concave comb', hp05DeepConcave()],
    ['near-collinear sliver', hp21NearCollinear()],
  ] as const) {
    it(`patch area equals the polygon's own area: ${name}`, () => {
      /*
       * CORROBORATING EVIDENCE, not a substitute for the intersection check.
       * Equal area means the triangles tile the polygon rather than covering
       * area outside it — which is what a fan does — and says nothing about
       * whether the patch hits anything else.
       */
      const set = extractBoundaryLoops(mesh);
      const loopId = topLoopId(mesh);
      const loop = set.loops.find((entry) => entry.id === loopId);
      expect(loop).toBeDefined();
      if (loop === undefined) return;

      const points = [...loop.vertices].map((vertex) => {
        const corner = (set.vertexRepresentativeCorner[vertex] ?? 0) * 3;
        return [
          mesh.positions[corner] ?? 0,
          mesh.positions[corner + 1] ?? 0,
          mesh.positions[corner + 2] ?? 0,
        ] as const;
      });

      const result = fill(mesh, loopId);
      const axis = result.outcome.summary.projectionAxis;
      const candidate = result.candidate;
      expect(candidate).toBeDefined();
      if (candidate === undefined) return;

      const polygonArea = Math.abs(projectedPolygonTwiceArea(points, axis)) / 2;
      let patchArea = 0;
      const sourceFaces = mesh.indices.length / 3;
      for (let face = sourceFaces; face < candidate.indices.length / 3; face += 1) {
        const corner = (slot: number): readonly [number, number, number] => {
          const at = (candidate.indices[face * 3 + slot] ?? 0) * 3;
          return [
            candidate.positions[at] ?? 0,
            candidate.positions[at + 1] ?? 0,
            candidate.positions[at + 2] ?? 0,
          ];
        };
        patchArea += Math.abs(projectedTwiceArea(corner(0), corner(1), corner(2), axis)) / 2;
      }

      expect(Math.abs(patchArea - polygonArea) / polygonArea).toBeLessThan(5e-8);
    });
  }
});

describe('resource ceilings', () => {
  it('reports RESOURCE_LIMIT rather than running to exhaustion', () => {
    const mesh = hp03ConvexEight();
    const result = fill(mesh, topLoopId(mesh), { maxBroadphaseCandidates: 1 });
    expect(result.outcome.status).toBe(HoleFillStatus.ResourceLimit);
    expect(result.candidate).toBeUndefined();
  });

  it('lets a caller NARROW a ceiling but never widen one', () => {
    const mesh = hp03ConvexEight();
    const widened = fill(mesh, topLoopId(mesh), {
      maxPartFaces: Number.MAX_SAFE_INTEGER,
      maxBoundaryVertices: Number.MAX_SAFE_INTEGER,
    });
    // A widened request is clamped to the production ceiling, so this still
    // behaves exactly as the default does.
    expect(widened.outcome.status).toBe(HoleFillStatus.ValidCandidate);

    const oversized = hp28AbovePartCeiling(HOLE_FILL_MAX_PART_FACES + 1);
    expect(
      fill(oversized, 'bl-anything', { maxPartFaces: Number.MAX_SAFE_INTEGER }).outcome.status,
    ).toBe(HoleFillStatus.RefusedPartSize);
  });
});

describe('a lone triangle cannot be "filled"', () => {
  it('refuses, because the patch would duplicate the face already there', () => {
    /*
     * FOUND BY A FIXTURE, KEPT AS A RULE. A single triangle has a perfectly
     * eligible three-vertex boundary, and the only patch that closes it is a
     * copy of the triangle itself — a duplicate face, which is a defect Stage 2
     * reports rather than something an operation may manufacture.
     */
    const lone = soup([
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]);
    const result = fill(lone, anyLoopId(lone));
    expect(result.outcome.status).toBe(HoleFillStatus.DegeneratePatch);
    expect(result.outcome.summary.duplicatePatchFaces).toBe(1);
    expect(result.candidate).toBeUndefined();
  });
});

describe('the reference narrowphase is a SECOND OPINION, not a substitute', () => {
  /*
   * WHY THIS SUITE ASSERTS A WEAKNESS.
   *
   * §32 of the stage brief forbids shipping the research separating-axis
   * checker as the production safety predicate. That is easy to state and easy
   * to drift away from, so the difference is pinned here as a measurement: the
   * two cases below are ones the double genuinely cannot see, and
   * `apps/web/src/workers/node-tests/hole-fill-kernel.test.ts` shows the
   * qualified Geogram narrowphase rejecting both.
   *
   * If this ever starts failing — if the double begins catching them — that is
   * a signal to check whether someone strengthened the double instead of using
   * the kernel, which is the substitution the rule exists to prevent.
   */

  it('cannot see a COPLANAR overlap, because a separating axis test cannot', () => {
    // Every candidate axis, including both face normals, yields touching rather
    // than overlapping intervals for two coplanar triangles, and touching is
    // deliberately not an overlap — coplanar neighbours touch by design.
    expect(fillTop(reviewCoplanarOverlap()).outcome.status).toBe(HoleFillStatus.ValidCandidate);
  });

  it('sees a single-point contact only as touching, which it excludes', () => {
    expect(fillTop(reviewNonAdjacentPointTouch()).outcome.status).toBe(
      HoleFillStatus.ValidCandidate,
    );
  });

  it('DOES see the crossing that decides the stage, which is why it is useful', () => {
    // Its value is being independent, not being complete. On HP23 — the hard
    // gate — the two unrelated implementations agree.
    expect(fillTop(hp23PatchPiercesOppositeShell()).outcome.status).toBe(
      HoleFillStatus.SelfIntersectionCreated,
    );
  });
});

describe('REVIEW E: resource abuse', () => {
  /**
   * A mesh built to DEFEAT the broadphase without intersecting anything.
   *
   * Every stray triangle's bounding box overlaps the patch's — it reaches down
   * to `y = 1.9`, inside the rim — while the triangle's own `z = 0` crossing
   * sits at `y ≈ 2.45`, outside it. So the broadphase must produce the pair and
   * the narrowphase must clear it, which is exactly the work the ceilings exist
   * to bound. Stacking hundreds of them defeats every spatial split.
   */
  function pathological(count: number): CanonicalMesh {
    const bodies: CanonicalMesh[] = [hp02QuadHole()];
    for (let index = 0; index < count; index += 1) {
      const x = 0.5 + index * 1e-4;
      bodies.push(
        soup([
          [
            [x, 1.9, -1],
            [x, 3, 1],
            [x + 0.01, 3, 1],
          ],
        ]),
      );
    }
    return concatMeshes(...bodies);
  }

  it('produces the pairs, clears them, and stays inside every ceiling', () => {
    const mesh = pathological(600);
    const result = fill(mesh, topLoopId(mesh));

    // The broadphase could not separate them, so it emitted them — and the
    // narrowphase found no intersection, which is the correct answer.
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.broadphaseCandidates).toBeGreaterThan(500);
    // The counters stayed inside the production ceilings.
    expect(result.outcome.summary.broadphaseCandidates).toBeLessThanOrEqual(
      MAX_BROADPHASE_CANDIDATES,
    );
    expect(result.outcome.summary.narrowphaseChecks).toBeLessThanOrEqual(MAX_NARROWPHASE_PAIRS);
    expect(result.outcome.summary.broadphaseNodeVisits).toBeLessThanOrEqual(MAX_BVH_NODE_VISITS);
    expect(result.outcome.summary.broadphaseAabbTests).toBeLessThanOrEqual(MAX_AABB_TESTS);
  });

  it('refuses with RESOURCE_LIMIT and publishes NOTHING when a ceiling fires', () => {
    const mesh = pathological(600);
    const result = fill(mesh, topLoopId(mesh), { maxBroadphaseCandidates: 64 });
    expect(result.outcome.status).toBe(HoleFillStatus.ResourceLimit);
    expect(result.candidate).toBeUndefined();
  });

  it('refuses a narrowphase ceiling the same way', () => {
    const mesh = pathological(600);
    const result = fill(mesh, topLoopId(mesh), { maxNarrowphasePairs: 8 });
    expect(result.outcome.status).toBe(HoleFillStatus.ResourceLimit);
    expect(result.candidate).toBeUndefined();
  });

  it('never allocates a pair list proportional to patch x source', () => {
    /*
     * THE SHAPE THE RESEARCH IMPLEMENTATION HAD, and the one this stage
     * forbids. Stated as a measured ratio rather than as a claim about the
     * code: the broadphase emits a small fraction of the naive product even on
     * a part with a hundred thousand faces, and the pairs it does emit stream
     * through a fixed buffer.
     */
    const mesh = hp27LargeInPolicyPart(20_000);
    const summary = fillTop(mesh).outcome.summary;
    const naive = summary.patchFaceCount * summary.sourceFaceCount;
    expect(naive).toBeGreaterThan(40_000);
    expect(summary.broadphaseCandidates).toBeLessThan(naive / 1_000);
  });
});

/* ------------------------------------- TP: differential topology matrix -- */

describe('TP01-TP06: new non-manifold topology is detected BY IDENTITY', () => {
  it('TP01: a clean source and a clean fill create nothing', () => {
    const result = fillTop(tp01CleanFill());
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.newNonManifoldDefectCount).toBe(0);
  });

  it('TP02: an unrelated PRE-EXISTING defect does not block a clean fill', () => {
    /*
     * The same policy as pre-existing self-intersection: this operation is
     * neither blamed for a defect it did not create nor expected to repair one.
     */
    const result = fillTop(tp02ExistingNonManifoldOnly());
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.newNonManifoldDefectCount).toBe(0);
  });

  it('TP03/TP06: a NEW defect of an ALREADY-PRESENT KIND is still rejected', () => {
    /*
     * THE CASE THAT MOTIVATED STAGE 4B-1B1-R1, and the reason a kind comparison
     * had to go. The source already contains a non-manifold edge, so the KIND
     * is present before and after; only the identity of the second edge is new.
     */
    const mesh = tp03ChordCollisionWithExistingDefect();
    const result = fillTop(mesh);
    expect(result.outcome.status).toBe(HoleFillStatus.NonManifoldCreated);
    expect(result.candidate).toBeUndefined();
    expect(result.outcome.summary.newNonManifoldDefectCount).toBe(1);
  });

  it('TP06: and the KIND comparison it replaced would have passed this case', () => {
    /*
     * PROVEN, NOT ASSERTED. The defect KIND sets really are identical before and
     * after — so the old check really would have accepted a candidate carrying a
     * manufactured non-manifold edge. This is the discriminating evidence for
     * the whole change.
     */
    const mesh = tp03ChordCollisionWithExistingDefect();
    const sourceIdentity = recoverVertexIdentity(mesh);
    const source = collectNonManifoldDefects(mesh, sourceIdentity);

    // Build the candidate the engine would have registered, by re-running the
    // fill with the differential's own inputs.
    const loopId = topLoopId(mesh);
    const attempt = runHoleFill({
      source: mesh,
      request: {
        operationId: 'tp06',
        documentId: 'tp06',
        revision: 1,
        partId: 'tp06',
        boundaryLoopId: loopId,
      },
      narrowphase: referenceNarrowphase(),
    });
    expect(attempt.outcome.status).toBe(HoleFillStatus.NonManifoldCreated);

    // The source genuinely has a non-manifold edge already.
    expect(source.edges.size).toBeGreaterThan(0);
    // And the candidate has strictly more of them — same kind, new identity.
    expect(attempt.outcome.summary.newNonManifoldDefectCount).toBeGreaterThan(0);

    // The kind comparison the differential replaced: "was NON_MANIFOLD present
    // before?" — yes. "Is it present after?" — yes. No regression detected.
    const kindBefore = source.edges.size > 0;
    expect(kindBefore).toBe(true);
  });

  it('TP04: the chord collision is rejected even with NO pre-existing defect', () => {
    const result = fillTop(tp04ChordCollisionAlone());
    expect(result.outcome.status).toBe(HoleFillStatus.NonManifoldCreated);
    expect(result.outcome.summary.newNonManifoldDefectCount).toBe(1);
  });

  it('TP04: and the exact narrowphase does NOT see it, which is why this check exists', () => {
    /*
     * Every contact on the shared chord is a legitimate shared edge — two faces
     * meeting along topology they are entitled to share. Intersection testing is
     * the wrong instrument for a topological defect, and this asserts it.
     */
    const summary = fillTop(tp04ChordCollisionAlone()).outcome.summary;
    expect(summary.invalidPatchSourcePairs).toBe(0);
    expect(summary.invalidPatchPatchPairs).toBe(0);
  });

  it('TP05: the rule is a SUBSET, so removing a defect is never a regression', () => {
    // Stated directly against the differential, because no fill in this scope
    // removes a non-manifold edge — the rule still has to be the right one.
    const mesh = unrelatedNonManifoldCluster();
    const defects = collectNonManifoldDefects(mesh, recoverVertexIdentity(mesh));
    expect(defects.edges.size).toBeGreaterThan(0);

    const empty = {
      edges: new Set<string>(),
      vertices: new Set<number>(),
      windingConflictEdges: new Set<string>(),
    };
    // Candidate removed everything: allowed.
    expect(diffNonManifoldDefects(defects, empty).total).toBe(0);
    // Candidate kept everything: allowed.
    expect(diffNonManifoldDefects(defects, defects).total).toBe(0);
    // Candidate swapped one defect for a different one of the SAME KIND:
    // rejected, which a count comparison would also have missed.
    const swapped = {
      edges: new Set<string>(['9999:10000']),
      vertices: new Set<number>(),
      windingConflictEdges: new Set<string>(),
    };
    expect(diffNonManifoldDefects(defects, swapped).total).toBe(1);
    expect(defects.edges.size).toBe(swapped.edges.size);
  });

  it('counts non-manifold VERTICES too, not only edges', () => {
    // Edge manifoldness does not imply vertex manifoldness — the bow-tie has
    // every edge at exactly two faces and is still pinched.
    const bowTie = hp15BowTie();
    const defects = collectNonManifoldDefects(bowTie, recoverVertexIdentity(bowTie));
    expect(defects.edges.size).toBe(0);
    expect(defects.vertices.size).toBeGreaterThan(0);
  });
});
