import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import createSelfIntersectionKernel from '@cadfixer/self-intersection-kernel';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  analyseTopology,
  extractBoundaryLoops,
  scanBoundaries,
  type TopologyReport,
} from '@cadfixer/mesh-topology';
import {
  admitBoundaryLoops,
  appendPatches,
  BoundaryFillVerdict,
  buildLocalPatchProblem,
  classifyLocalPatches,
  DEFAULT_BOUNDARY_FILL_LIMITS,
  HoleFillStatus,
  judgeFilledCandidate,
  runHoleFill,
  type AdmittedLoop,
  type PatchNarrowphase,
} from '@cadfixer/mesh-hole-fill';
import * as fx from '@cadfixer/mesh-hole-fill/fixtures';
import { uncancellable } from '@cadfixer/shared';
import { createKernelNarrowphase } from '../hole-fill-narrowphase';

/**
 * REPAIR-CORE-02 AGAINST THE PREDICATE THAT SHIPS.
 *
 * The local pipeline — compact scan, admission, local region, patch-attributed
 * narrowphase, append-only candidate, independent Stage 2 re-analysis — with
 * the QUALIFIED GEOGRAM KERNEL as the narrowphase. And, for every single-rim
 * fixture, the same question put to the whole-part engine with the same
 * kernel: the two must agree on which openings are safe to close.
 */

function kernelWasmPath(): string {
  const relative = join(
    'packages',
    'self-intersection-kernel',
    'artifacts',
    'self-intersection.wasm',
  );
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not locate ${relative} from ${process.cwd()}`);
}

let narrowphase: () => PatchNarrowphase;

beforeAll(async () => {
  const module = await createSelfIntersectionKernel({ wasmBinary: readFileSync(kernelWasmPath()) });
  narrowphase = (): PatchNarrowphase => createKernelNarrowphase(module);
}, 60_000);

function analyse(mesh: CanonicalMesh): TopologyReport {
  return analyseTopology(mesh, {
    documentId: 'k',
    partId: 'p',
    documentRevision: 1,
    cancellation: uncancellable,
  }).report;
}

function localFill(mesh: CanonicalMesh): {
  readonly filled: readonly AdmittedLoop[];
  readonly verdicts: ReadonlyMap<string, string>;
  readonly regressions: readonly string[];
} {
  const scan = scanBoundaries(mesh, {
    limits: {
      maxBoundaryEdges: DEFAULT_BOUNDARY_FILL_LIMITS.maxBoundaryEdges,
      maxLoopVertices: DEFAULT_BOUNDARY_FILL_LIMITS.maxLoopVertices,
    },
  });
  const admission = admitBoundaryLoops(mesh, scan);
  const verdicts = new Map<string, string>(admission.decisions.map((d) => [d.id, d.verdict]));
  const problem = buildLocalPatchProblem(mesh, admission.admitted, {
    maxFaces: DEFAULT_BOUNDARY_FILL_LIMITS.maxLocalFaces,
  });
  const results = classifyLocalPatches(problem, narrowphase());
  const filled: AdmittedLoop[] = [];
  for (const [index, id] of problem.loopIds.entries()) {
    const result = results[index];
    const loop = admission.admitted.find((candidate) => candidate.id === id);
    if (result === undefined || loop === undefined) continue;
    if (!result.complete) verdicts.set(id, BoundaryFillVerdict.NotVerifiable);
    else if (result.invalidPatchSourcePairs + result.invalidPatchPatchPairs > 0) {
      verdicts.set(id, BoundaryFillVerdict.WouldIntersect);
    } else filled.push(loop);
  }
  const candidate = appendPatches(mesh, filled);
  return {
    filled,
    verdicts,
    regressions: judgeFilledCandidate(analyse(mesh), analyse(candidate), filled),
  };
}

describe('the local pipeline with the Geogram kernel', () => {
  const fixtures: Readonly<Record<string, () => CanonicalMesh>> = {
    hp01TriangleHole: fx.hp01TriangleHole,
    hp02QuadHole: fx.hp02QuadHole,
    hp03ConvexEight: fx.hp03ConvexEight,
    hp04ConcaveL: fx.hp04ConcaveL,
    hp05DeepConcave: fx.hp05DeepConcave,
    hp06MildlyWarped: fx.hp06MildlyWarped,
    hp12TwoIndependentHoles: fx.hp12TwoIndependentHoles,
    hp21NearCollinear: fx.hp21NearCollinear,
    hp22PreExistingSourceIntersection: fx.hp22PreExistingSourceIntersection,
    hp23PatchPiercesOppositeShell: fx.hp23PatchPiercesOppositeShell,
    hp24ThinWallNoIntersection: fx.hp24ThinWallNoIntersection,
    hp25GloballyReversed: fx.hp25GloballyReversed,
    hp29FarFromOrigin: fx.hp29FarFromOrigin,
    reviewCoplanarOverlap: fx.reviewCoplanarOverlap,
    reviewNonAdjacentPointTouch: fx.reviewNonAdjacentPointTouch,
  };

  for (const [name, build] of Object.entries(fixtures)) {
    it(`${name}: agrees with the whole-part engine, and every fill validates`, () => {
      const mesh = build();
      const local = localFill(mesh);
      expect(local.regressions, name).toEqual([]);

      const loops = extractBoundaryLoops(mesh, { maxLoopVertices: 512 }).loops;
      const engineValid = loops.filter(
        (loop) =>
          runHoleFill({
            source: mesh,
            request: {
              operationId: 'k',
              documentId: 'd',
              revision: 1,
              partId: 'p',
              boundaryLoopId: loop.id,
            },
            narrowphase: narrowphase(),
          }).outcome.status === HoleFillStatus.ValidCandidate,
      ).length;
      // Loops the local path defers for independence are the only permitted
      // difference: the whole-part engine fills one opening at a time.
      let deferred = 0;
      for (const verdict of local.verdicts.values()) {
        if (verdict === BoundaryFillVerdict.InteractsWithAnotherOpening) deferred += 1;
      }
      expect(local.filled.length + deferred, name).toBe(engineValid);
    });
  }

  it('refuses the patch that pierces the opposite shell (HP23) with the kernel too', () => {
    const local = localFill(fx.hp23PatchPiercesOppositeShell());
    expect([...local.verdicts.values()]).toContain(BoundaryFillVerdict.WouldIntersect);
  });

  it('checks a tiny opening on a large part against its neighbourhood only', () => {
    const mesh = fx.hp27LargeInPolicyPart(200_000);
    const scan = scanBoundaries(mesh, {
      limits: { maxBoundaryEdges: 100_000, maxLoopVertices: 512 },
    });
    const admission = admitBoundaryLoops(mesh, scan);
    const problem = buildLocalPatchProblem(mesh, admission.admitted, { maxFaces: 250_000 });
    expect(problem.sourceFaceCount).toBeLessThan(20);
    expect(localFill(mesh).regressions).toEqual([]);
  });
});
