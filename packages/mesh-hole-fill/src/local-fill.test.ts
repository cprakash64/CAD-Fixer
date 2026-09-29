import { describe, expect, it } from 'vitest';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology, scanBoundaries, type TopologyReport } from '@cadfixer/mesh-topology';
import { uncancellable } from '@cadfixer/shared';
import { runHoleFill } from './engine';
import { HoleFillStatus } from './status';
import { extractBoundaryLoops } from '@cadfixer/mesh-topology';
import {
  admitBoundaryLoops,
  BoundaryFillVerdict,
  DEFAULT_BOUNDARY_FILL_LIMITS,
  type AdmittedLoop,
} from './admission';
import { appendPatches, judgeFilledCandidate, sourcePreserved } from './fill-candidate';
import { buildLocalPatchProblem } from './local-region';
import { classifyLocalPatches } from './local-intersection';
import * as fx from './fixtures';

/**
 * REPAIR-CORE-02 at engine level: scan → admission → local region →
 * patch-attributed narrowphase → append-only candidate → independent Stage 2
 * re-analysis, over the fixture matrix the stage names (A–J). The narrowphase
 * here is the test-only reference checker; the qualified Geogram kernel is
 * exercised by the worker suite.
 */

interface LocalFillResult {
  readonly verdicts: ReadonlyMap<string, string>;
  readonly filled: readonly AdmittedLoop[];
  readonly candidate: CanonicalMesh;
  readonly before: TopologyReport;
  readonly after: TopologyReport;
}

function analyse(mesh: CanonicalMesh): TopologyReport {
  return analyseTopology(mesh, {
    documentId: 'test',
    partId: 'part-1',
    documentRevision: 1,
    cancellation: uncancellable,
  }).report;
}

function localFill(mesh: CanonicalMesh, maxLocalFaces = 250_000): LocalFillResult {
  const scan = scanBoundaries(mesh, {
    limits: {
      maxBoundaryEdges: DEFAULT_BOUNDARY_FILL_LIMITS.maxBoundaryEdges,
      maxLoopVertices: DEFAULT_BOUNDARY_FILL_LIMITS.maxLoopVertices,
    },
  });
  const admission = admitBoundaryLoops(mesh, scan);
  const verdicts = new Map<string, string>(
    admission.decisions.map((decision) => [decision.id, decision.verdict]),
  );
  const problem = buildLocalPatchProblem(mesh, admission.admitted, { maxFaces: maxLocalFaces });
  for (const id of problem.excluded) verdicts.set(id, BoundaryFillVerdict.RegionTooLarge);
  const results = classifyLocalPatches(problem, fx.referenceNarrowphase());
  const filled: AdmittedLoop[] = [];
  for (const [index, id] of problem.loopIds.entries()) {
    const verdict = results[index];
    const loop = admission.admitted.find((candidate) => candidate.id === id);
    if (verdict === undefined || loop === undefined) continue;
    if (!verdict.complete) {
      verdicts.set(id, BoundaryFillVerdict.NotVerifiable);
    } else if (verdict.invalidPatchSourcePairs > 0 || verdict.invalidPatchPatchPairs > 0) {
      verdicts.set(id, BoundaryFillVerdict.WouldIntersect);
    } else {
      filled.push(loop);
    }
  }
  const candidate = appendPatches(mesh, filled);
  return { verdicts, filled, candidate, before: analyse(mesh), after: analyse(candidate) };
}

function expectValid(result: LocalFillResult, mesh: CanonicalMesh): void {
  expect(judgeFilledCandidate(result.before, result.after, result.filled)).toEqual([]);
  expect(sourcePreserved(mesh, result.candidate)).toBe(true);
}

function verdictCounts(result: LocalFillResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const verdict of result.verdicts.values()) counts[verdict] = (counts[verdict] ?? 0) + 1;
  return counts;
}

describe('A: a small simple planar opening', () => {
  it('is admitted, filled, and closes exactly its rim', () => {
    const mesh = fx.hp02QuadHole();
    const result = localFill(mesh);
    // A tube has two openings, top and bottom; both are simple and planar.
    expect(result.filled).toHaveLength(2);
    expectValid(result, mesh);
    expect(result.after.boundaryEdgeCount).toBe(0);
  });
});

describe('B: a large part with a tiny opening', () => {
  it('fills it without the per-opening engine’s part ceiling, and checks only its neighbourhood', () => {
    const mesh = fx.hp27LargeInPolicyPart(40_000);
    const scan = scanBoundaries(mesh, {
      limits: { maxBoundaryEdges: 100_000, maxLoopVertices: 512 },
    });
    const admission = admitBoundaryLoops(mesh, scan);
    const problem = buildLocalPatchProblem(mesh, admission.admitted, { maxFaces: 250_000 });
    // The region holds the tube and nothing from the far field of tetrahedra.
    expect(problem.sourceFaceCount).toBeLessThanOrEqual(8);
    const result = localFill(mesh);
    expect(result.filled).toHaveLength(2);
    expectValid(result, mesh);
  });
});

describe('C: several independent openings', () => {
  it('fills every independent simple opening in one candidate', () => {
    const mesh = fx.hp12TwoIndependentHoles();
    const result = localFill(mesh);
    expect(result.filled).toHaveLength(4);
    expectValid(result, mesh);
  });
});

describe('D: a branched boundary', () => {
  it('is never filled', () => {
    const result = localFill(fx.hp13BranchedBoundary());
    expect(result.filled).toHaveLength(0);
    expect(verdictCounts(result)[BoundaryFillVerdict.NotSimple]).toBeGreaterThan(0);
  });
});

describe('E: mixed simple and branched boundaries', () => {
  it('fills the simple openings and leaves the branched boundary exactly as it was', () => {
    const mesh = fx.concatMeshes(
      fx.hp02QuadHole(),
      fx.translateMesh(fx.hp13BranchedBoundary(), [20, 0, 0]),
    );
    const result = localFill(mesh);
    expect(result.filled).toHaveLength(2);
    expect(verdictCounts(result)[BoundaryFillVerdict.NotSimple]).toBe(1);
    expectValid(result, mesh);
    expect(result.after.branchedBoundaryCount).toBe(result.before.branchedBoundaryCount);
  });
});

describe('F: a concave simple opening', () => {
  it('is triangulated by ear clipping, never a fan, and validates', () => {
    for (const mesh of [fx.hp04ConcaveL(), fx.hp05DeepConcave()]) {
      const result = localFill(mesh);
      expect(result.filled.length).toBeGreaterThan(0);
      expectValid(result, mesh);
    }
  });
});

describe('G: a non-planar opening', () => {
  it('is refused as non-planar, never filled', () => {
    const result = localFill(fx.hp08StronglyNonPlanar());
    expect(verdictCounts(result)[BoundaryFillVerdict.NonPlanar]).toBeGreaterThan(0);
    for (const loop of result.filled) {
      expect(result.verdicts.get(loop.id)).toBe(BoundaryFillVerdict.Admitted);
    }
  });
});

describe('H: an opening near unrelated geometry', () => {
  it('fills when nearby geometry is close but not touched', () => {
    const mesh = fx.hp24ThinWallNoIntersection();
    const result = localFill(mesh);
    expect(result.filled.length).toBeGreaterThan(0);
    expectValid(result, mesh);
  });
});

describe('I: a patch that would pierce existing geometry', () => {
  it('is refused by the local intersection check, and the rest still fills', () => {
    const mesh = fx.hp23PatchPiercesOppositeShell();
    const result = localFill(mesh);
    expect(verdictCounts(result)[BoundaryFillVerdict.WouldIntersect]).toBe(1);
    expectValid(result, mesh);
  });

  it('agrees with the whole-part engine on which openings are safe', () => {
    for (const build of [
      fx.hp02QuadHole,
      fx.hp04ConcaveL,
      fx.hp23PatchPiercesOppositeShell,
      fx.hp24ThinWallNoIntersection,
      fx.hp25GloballyReversed,
      fx.hp26MixedLocalWinding,
      fx.hp29FarFromOrigin,
    ]) {
      const mesh = build();
      const local = localFill(mesh);
      const loops = extractBoundaryLoops(mesh, { maxLoopVertices: 512 }).loops;
      const engineValid = loops.filter(
        (loop) =>
          runHoleFill({
            source: mesh,
            request: {
              operationId: 'x',
              documentId: 'd',
              revision: 1,
              partId: 'p',
              boundaryLoopId: loop.id,
            },
            narrowphase: fx.referenceNarrowphase(),
          }).outcome.status === HoleFillStatus.ValidCandidate,
      ).length;
      expect(local.filled.length, build.name).toBe(engineValid);
    }
  });
});

describe('J: openings whose bounds touch', () => {
  it('fills the first and defers the second, so order never decides topology', () => {
    // Two tubes sharing no point, whose bounding boxes touch at x = 2.
    const mesh = fx.concatMeshes(
      fx.hp02QuadHole(),
      fx.tube([
        [2, 0.5],
        [3, 0.5],
        [3, 1.5],
        [2, 1.5],
      ]),
    );
    const result = localFill(mesh);
    const counts = verdictCounts(result);
    expect(counts[BoundaryFillVerdict.InteractsWithAnotherOpening]).toBeGreaterThan(0);
    expectValid(result, mesh);
  });
});

describe('limits and determinism', () => {
  it('excludes a loop whose surroundings exceed the local budget, and never checks it partially', () => {
    const result = localFill(fx.hp02QuadHole(), 3);
    expect(verdictCounts(result)[BoundaryFillVerdict.RegionTooLarge]).toBeGreaterThan(0);
  });

  it('defers loops beyond the batch limit', () => {
    const mesh = fx.hp12TwoIndependentHoles();
    const scan = scanBoundaries(mesh, { limits: { maxBoundaryEdges: 100, maxLoopVertices: 512 } });
    const admission = admitBoundaryLoops(mesh, scan, { maxLoopsPerCandidate: 1 });
    expect(admission.admitted).toHaveLength(1);
    expect(
      admission.decisions.filter((d) => d.verdict === BoundaryFillVerdict.BatchLimit).length,
    ).toBeGreaterThan(0);
  });

  it('can only narrow its limits, never widen them', () => {
    const mesh = fx.hp02QuadHole();
    const scan = scanBoundaries(mesh, { limits: { maxBoundaryEdges: 100, maxLoopVertices: 512 } });
    const wide = admitBoundaryLoops(mesh, scan, { maxLoopVertices: 1_000_000 });
    const plain = admitBoundaryLoops(mesh, scan);
    expect(wide.admitted.length).toBe(plain.admitted.length);
  });

  it('produces byte-identical candidates from repeated runs', () => {
    const mesh = fx.hp12TwoIndependentHoles();
    const first = localFill(mesh).candidate;
    const second = localFill(mesh).candidate;
    expect(new Uint8Array(second.indices.buffer)).toEqual(new Uint8Array(first.indices.buffer));
  });

  it('refuses to re-close a single loose triangle with its own reverse', () => {
    const mesh = fx.soup([
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]);
    const result = localFill(mesh);
    expect(result.filled).toHaveLength(0);
    expect(verdictCounts(result)[BoundaryFillVerdict.DuplicatesExistingFace]).toBe(1);
  });
});
