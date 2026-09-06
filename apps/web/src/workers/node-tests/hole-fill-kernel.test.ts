import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import createSelfIntersectionKernel from '@cadfixer/self-intersection-kernel';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { extractBoundaryLoops } from '@cadfixer/mesh-topology';
import { HoleFillStatus, runHoleFill, type PatchNarrowphase } from '@cadfixer/mesh-hole-fill';
import {
  hp01TriangleHole,
  hp02QuadHole,
  hp03ConvexEight,
  hp04ConcaveL,
  hp05DeepConcave,
  hp06MildlyWarped,
  hp12TwoIndependentHoles,
  hp21NearCollinear,
  hp22PreExistingSourceIntersection,
  hp23PatchPiercesOppositeShell,
  hp24ThinWallNoIntersection,
  hp25GloballyReversed,
  hp27LargeInPolicyPart,
  hp29FarFromOrigin,
  reviewCoplanarOverlap,
  reviewNonAdjacentPointTouch,
  soup,
} from '@cadfixer/mesh-hole-fill/fixtures';
import { createKernelNarrowphase } from '../hole-fill-narrowphase';

/**
 * THE HP MATRIX AGAINST THE PREDICATE THAT ACTUALLY SHIPS.
 *
 * `packages/mesh-hole-fill/src/engine.test.ts` runs the same fixtures with a
 * separating-axis checker that shares no code with production. This suite runs
 * them with the QUALIFIED GEOGRAM KERNEL — the same exact narrowphase and the
 * same frozen Stage 3C classifier the self-intersection diagnostic uses — so
 * every geometric verdict below is one two unrelated implementations reached.
 *
 * WHY IT LIVES HERE AND NOT IN THE PACKAGE. `@cadfixer/mesh-hole-fill` is
 * kernel-free by design, which is what lets the production boundary scan prove
 * the WebAssembly stays confined to the workers that load it. The kernel-backed
 * narrowphase is worker code, so its tests are worker tests.
 *
 * THE MODULE IS LOADED WITH `wasmBinary`. The Emscripten glue is built for
 * `web,worker` and fetches its `.wasm` relative to `import.meta.url`, which no
 * test runner can satisfy. Supplying the bytes skips the fetch; the artifact
 * instantiated is byte-for-byte the one the browser gets.
 */

/**
 * Located by walking up from the working directory rather than from
 * `import.meta.url`: this suite runs in the jsdom project, where `import.meta.url`
 * is an `http:` URL that `readFileSync` cannot open.
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

let narrowphaseFactory: () => PatchNarrowphase;

beforeAll(async () => {
  const wasmBinary = readFileSync(kernelWasmPath());
  const module = await createSelfIntersectionKernel({ wasmBinary });
  narrowphaseFactory = (): PatchNarrowphase => createKernelNarrowphase(module);
}, 60_000);

/** The loop at `z = 0`: the rim every tube fixture is about. */
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

function fill(mesh: CanonicalMesh, loopId = topLoopId(mesh)): ReturnType<typeof runHoleFill> {
  return runHoleFill({
    source: mesh,
    request: {
      operationId: 'op-kernel',
      documentId: 'doc-kernel',
      revision: 1,
      partId: 'part-kernel',
      boundaryLoopId: loopId,
    },
    narrowphase: narrowphaseFactory(),
  });
}

describe('the qualified kernel agrees with the engine on every fillable fixture', () => {
  for (const [name, mesh, boundaryVertices] of [
    ['HP01 triangle', hp01TriangleHole(), 3],
    ['HP02 quad', hp02QuadHole(), 4],
    ['HP03 convex eight', hp03ConvexEight(), 8],
    ['HP04 concave L', hp04ConcaveL(), 6],
    ['HP05 deep concave comb', hp05DeepConcave(), 14],
    ['HP06 mildly warped', hp06MildlyWarped(), 8],
    ['HP21 near-collinear sliver', hp21NearCollinear(), 4],
    ['HP25 globally reversed', hp25GloballyReversed(), 4],
    ['HP29 far from origin', hp29FarFromOrigin(), 4],
  ] as const) {
    it(`validates: ${name}`, () => {
      const result = fill(mesh);
      expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
      expect(result.outcome.summary.patchFaceCount).toBe(boundaryVertices - 2);
      expect(result.outcome.summary.invalidPatchSourcePairs).toBe(0);
      expect(result.outcome.summary.invalidPatchPatchPairs).toBe(0);
      expect(result.outcome.summary.narrowphaseRefusals).toBe(0);
      expect(result.candidate).toBeDefined();
    });
  }
});

describe('ADJACENCY IS NOT INTERSECTION', () => {
  it('classifies the rim edge a patch shares with its source face as legitimate', () => {
    /*
     * THE HARDEST PART OF THE WHOLE CHECK. A patch triangle legitimately SHARES
     * its rim edge with the source face that owns it, and patch triangles
     * legitimately share their internal edges with each other. A predicate that
     * reported those would report every correct fill as broken.
     *
     * The kernel decides this with the SAME `classify_pair` the diagnostic uses:
     * a contact of dimension <= 1 that never reaches either interior IS the
     * shared edge, and anything more is an overlap.
     */
    const result = fill(hp02QuadHole());
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    // The rim pairs were TESTED — the broadphase did not simply miss them — and
    // came back clean.
    expect(result.outcome.summary.narrowphaseChecks).toBeGreaterThan(0);
    expect(result.outcome.summary.invalidPatchSourcePairs).toBe(0);
  });

  it('classifies an internal patch edge shared by two patch triangles as legitimate', () => {
    // The comb's patch is twelve triangles sharing eleven internal edges.
    const result = fill(hp05DeepConcave());
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.invalidPatchPatchPairs).toBe(0);
  });
});

describe('HP23: the hard gate, decided by the shipping predicate', () => {
  it('rejects a patch that pierces an opposing surface', () => {
    const result = fill(hp23PatchPiercesOppositeShell());
    expect(result.outcome.status).toBe(HoleFillStatus.SelfIntersectionCreated);
    expect(result.candidate).toBeUndefined();
    expect(result.outcome.summary.invalidPatchSourcePairs).toBeGreaterThan(0);
  });

  it('would have passed every other check', () => {
    const summary = fill(hp23PatchPiercesOppositeShell()).outcome.summary;
    expect(summary.selectedLoopRemoved).toBe(true);
    expect(summary.boundaryLoopsAfter).toBe(summary.boundaryLoopsBefore - 1);
    expect(summary.agreeingBoundaryEdges).toBe(0);
    expect(summary.eulerPassed).toBe(true);
    expect(summary.degeneratePatchFaces).toBe(0);
  });
});

describe('HP24: a thin wall is not an intersection', () => {
  it('accepts geometry that comes close without touching', () => {
    const result = fill(hp24ThinWallNoIntersection());
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.invalidPatchSourcePairs).toBe(0);
  });
});

describe('HP22: a pre-existing source intersection is never attributed to the patch', () => {
  it('fills cleanly beside a crossing the file already had', () => {
    const result = fill(hp22PreExistingSourceIntersection());
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
    expect(result.outcome.summary.invalidPatchSourcePairs).toBe(0);
    expect(result.outcome.summary.invalidPatchPatchPairs).toBe(0);
  });
});

describe('HP12: only the named loop is filled', () => {
  it('leaves the other three openings exactly where they were', () => {
    const mesh = hp12TwoIndependentHoles();
    const eligible = extractBoundaryLoops(mesh).loops.filter((loop) => loop.refusal === undefined);
    const chosen = eligible[0]?.id ?? '';
    const result = fill(mesh, chosen);
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);

    const after = new Set<string>(
      extractBoundaryLoops(result.candidate ?? mesh).loops.map((loop) => loop.id),
    );
    expect(after.has(chosen)).toBe(false);
    for (const other of eligible.slice(1)) expect(after.has(other.id)).toBe(true);
  });
});

describe('HP27: the broadphase keeps a large part affordable', () => {
  it('tests far fewer pairs than the part has faces', () => {
    /*
     * THE BOUNDED-VALIDATION PROOF, stated as a ratio rather than a stopwatch.
     * The research implementation compared every patch face with every source
     * face; here the patch queries a hierarchy with its own boxes, so the number
     * of exact narrowphase calls is a property of the NEIGHBOURHOOD rather than
     * of the model.
     */
    const mesh = hp27LargeInPolicyPart(20_000);
    const result = fill(mesh);
    expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);

    const summary = result.outcome.summary;
    const naive = summary.patchFaceCount * summary.sourceFaceCount;
    expect(summary.narrowphaseChecks).toBeLessThan(naive / 1_000);
    expect(summary.broadphaseCandidates).toBeLessThan(naive / 1_000);
  }, 60_000);
});

describe('a lone triangle is refused rather than duplicated', () => {
  it('reports a duplicate patch face', () => {
    const lone = soup([
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]);
    const loopId = extractBoundaryLoops(lone).loops[0]?.id ?? '';
    const result = fill(lone, loopId);
    expect(result.outcome.status).toBe(HoleFillStatus.DegeneratePatch);
    expect(result.candidate).toBeUndefined();
  });
});

describe('the kernel narrowphase releases what it allocates', () => {
  it('runs repeatedly on one module without leaking or drifting', () => {
    /*
     * ONE MODULE, MANY OPERATIONS. `begin` uploads geometry and `end` frees it;
     * a leak here would be a leak per fill, inside a worker that may serve
     * several. Identical results across runs also show `cf_hf_begin` genuinely
     * resets the kernel's counters rather than accumulating them.
     */
    const first = fill(hp04ConcaveL()).outcome.summary;
    for (let run = 0; run < 25; run += 1) {
      const again = fill(hp04ConcaveL()).outcome.summary;
      expect(again.narrowphaseChecks).toBe(first.narrowphaseChecks);
      expect(again.invalidPatchSourcePairs).toBe(0);
      expect(again.invalidPatchPatchPairs).toBe(0);
      expect(again.broadphaseCandidates).toBe(first.broadphaseCandidates);
    }
  });
});

describe('REVIEW C: the cases a weaker predicate would let through', () => {
  /*
   * THE THIRD REVIEW PASS, as evidence rather than as an assurance. Each case
   * below is one a plausible-looking checker misses, and each is caught only
   * because the narrowphase is the qualified Stage 3C classifier rather than a
   * "do these triangles properly cross" test.
   */

  it('rejects a patch that overlaps a COPLANAR source face', () => {
    /*
     * The two surfaces never cross — they lie in the same plane — so a
     * plane-crossing test finds nothing, and they share no vertex, so a
     * shared-vertex exclusion finds nothing either. Only exact coplanar-overlap
     * classification sees it.
     */
    const result = fill(reviewCoplanarOverlap());
    expect(result.outcome.status).toBe(HoleFillStatus.SelfIntersectionCreated);
    expect(result.candidate).toBeUndefined();
    expect(result.outcome.summary.invalidPatchSourcePairs).toBeGreaterThan(0);
  });

  it('rejects a source face touching the patch INTERIOR at a single point', () => {
    // Not a crossing and not an overlap: two faces sharing no topology meeting
    // at one point is a defect the surface should not have.
    const result = fill(reviewNonAdjacentPointTouch());
    expect(result.outcome.status).toBe(HoleFillStatus.SelfIntersectionCreated);
    expect(result.candidate).toBeUndefined();
    expect(result.outcome.summary.invalidPatchSourcePairs).toBeGreaterThan(0);
  });

  it('still accepts the legitimate adjacency both of those resemble', () => {
    // The control. If the two rejections above came from over-eagerness rather
    // than from classification, this would fail too — a patch shares its rim
    // edge with the source by design, in the same plane, at exact contact.
    expect(fill(hp02QuadHole()).outcome.status).toBe(HoleFillStatus.ValidCandidate);
  });
});
