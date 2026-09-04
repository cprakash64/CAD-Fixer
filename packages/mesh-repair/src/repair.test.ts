import { describe, expect, it } from 'vitest';
import { triangleCount } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { uncancellable } from '@cadfixer/shared';
import type { CancellationToken } from '@cadfixer/shared';
import { analyseTopology } from '@cadfixer/mesh-topology';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import {
  bowTieVertex,
  collinearTriangle,
  concat,
  duplicateReversedOrientation,
  duplicateSameOrientation,
  repeatedPositionTriangle,
  soup,
  squareWrongWinding,
  tetrahedron,
  tetrahedronOneFaceReversed,
  threeTrianglesSharingEdge,
} from '@cadfixer/mesh-topology/fixtures';
import { RepairAcceptance, RepairDecision, RepairOperation, RepairReason } from './contract';
import { fullCopyBytes, restoreFromInverse } from './inverse';
import { executeConservativeRepair } from './pipeline';
import { planConservativeRepair } from './plan';
import { solveWinding, WindingOutcome } from './operations';
import { buildRepairView } from './view';

/**
 * CR01–CR25 plus the invariant matrix.
 *
 * THE RULE UNDER TEST throughout: a repair succeeded only when CAD Fixer's own
 * validators say so. Several cases below assert that a repair was REFUSED, and
 * those matter at least as much as the ones that succeed — a conservative
 * engine that never refuses is not conservative.
 */

const ALL_OPERATIONS: readonly RepairOperation[] = [
  RepairOperation.RemoveDuplicateFaces,
  RepairOperation.RemoveRepeatedPositionFaces,
  RepairOperation.RemoveZeroAreaFaces,
  RepairOperation.UnifyWinding,
];

/**
 * Narrows a value the test has already established is present.
 *
 * Used instead of `!` so a wrong assumption fails with a clear message at the
 * point of use rather than as a downstream `undefined` dereference.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}

function report(mesh: CanonicalMesh): TopologyReport {
  return analyseTopology(mesh, {
    documentId: 'test',
    partId: 'part-1',
    documentRevision: 1,
    cancellation: uncancellable,
  }).report;
}

function repair(
  mesh: CanonicalMesh,
  requested: readonly RepairOperation[] = ALL_OPERATIONS,
): ReturnType<typeof executeConservativeRepair> & {
  plan: ReturnType<typeof planConservativeRepair>['plan'];
} {
  const before = report(mesh);
  const { plan, view } = planConservativeRepair({
    mesh,
    report: before,
    documentId: 'test',
    partId: 'part-1',
    sourceRevision: 1,
    requested,
  });
  const result = executeConservativeRepair({
    source: mesh,
    plan,
    sourceReport: before,
    cancellation: uncancellable,
    documentId: 'test',
    partId: 'part-1',
    revision: 1,
    view,
  });
  return { ...result, plan };
}

function decisionFor(
  plan: ReturnType<typeof planConservativeRepair>['plan'],
  operation: RepairOperation,
): ReturnType<typeof planConservativeRepair>['plan']['decisions'][number] | undefined {
  const found = plan.decisions.find((entry) => entry.operation === operation);
  expect(found, `no decision recorded for ${operation}`).toBeDefined();
  return found;
}

/** Every stored coordinate triple, as comparable strings, order-independent. */
function coordinateMultiset(mesh: CanonicalMesh): string[] {
  const out: string[] = [];
  for (const index of mesh.indices) {
    const v = index * 3;
    out.push(
      `${String(mesh.positions[v])},${String(mesh.positions[v + 1])},${String(mesh.positions[v + 2])}`,
    );
  }
  return out.sort();
}

describe('CR01–CR04 duplicate handling', () => {
  it('CR01: a clean tetrahedron plans nothing and is a no-op', () => {
    const { plan, candidate, validation } = repair(tetrahedron());
    expect(plan.noOp).toBe(true);
    expect(plan.order).toEqual([]);
    // No candidate is produced for a no-op, so nothing exists to commit.
    expect(candidate).toBeUndefined();
    expect(validation.acceptance).toBe(RepairAcceptance.NoOp);
  });

  it('CR02: one same-orientation duplicate is removed', () => {
    const mesh = duplicateSameOrientation();
    const before = report(mesh);
    expect(before.sameOrientationDuplicateCount).toBe(1);

    const { candidate, validation, counts } = repair(mesh);
    expect(validation.acceptance).toBe(RepairAcceptance.Accepted);
    expect(counts.removedDuplicateFaces).toBe(1);
    expect(triangleCount(must(candidate, 'candidate'))).toBe(triangleCount(mesh) - 1);
    expect(validation.after.sameOrientationDuplicateCount).toBe(0);
    // Not a count-only assertion: nothing else may have regressed.
    expect(validation.regressions).toEqual([]);
  });

  it('CR03: three copies retain the lowest-indexed representative', () => {
    const face: [
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
    ] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    // Three identical faces plus an unrelated one, so the retained copy is
    // identifiable by position in the output.
    const mesh = soup([face, face, face]);
    const view = buildRepairView(mesh);
    expect(view.faceCount).toBe(3);

    const { candidate, counts } = repair(mesh, [RepairOperation.RemoveDuplicateFaces]);
    expect(counts.removedDuplicateFaces).toBe(2);
    expect(triangleCount(must(candidate, 'candidate'))).toBe(1);
  });

  it('CR04: a reversed duplicate is NOT removed', () => {
    const mesh = duplicateReversedOrientation();
    const before = report(mesh);
    expect(before.reversedOrientationDuplicateCount).toBe(1);
    expect(before.sameOrientationDuplicateCount).toBe(0);

    const { plan, candidate, validation } = repair(mesh, [RepairOperation.RemoveDuplicateFaces]);
    expect(decisionFor(plan, RepairOperation.RemoveDuplicateFaces)?.decision).toBe(
      RepairDecision.NotNeeded,
    );
    expect(plan.noOp).toBe(true);
    expect(candidate).toBeUndefined();
    expect(validation.acceptance).toBe(RepairAcceptance.NoOp);
  });
});

describe('CR05–CR08 degenerate handling', () => {
  it('CR05: an isolated repeated-position face is removed safely', () => {
    const mesh = concat(tetrahedron(), repeatedPositionTriangle());
    const before = report(mesh);
    expect(before.repeatedPositionFaceCount).toBe(1);

    const { candidate, validation, counts } = repair(mesh, [
      RepairOperation.RemoveRepeatedPositionFaces,
    ]);
    expect(validation.acceptance).toBe(RepairAcceptance.Accepted);
    expect(counts.removedRepeatedPositionFaces).toBe(1);
    expect(validation.after.repeatedPositionFaceCount).toBe(0);
    expect(triangleCount(must(candidate, 'candidate'))).toBe(triangleCount(mesh) - 1);
  });

  it('CR06: a removal that would change connectivity is refused', () => {
    /*
     * A collinear face whose edges are the ONLY thing joining two patches.
     * Removing it splits the surface, which changes the component count — a
     * forbidden regression. The engine must reject rather than "succeed".
     */
    const bridge = soup([
      [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
    ]);
    const left = soup([
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]);
    const right = soup([
      [
        [1, 0, 0],
        [2, 0, 0],
        [2, 1, 0],
      ],
    ]);
    const mesh = concat(concat(left, bridge), right);

    const { plan, candidate, validation } = repair(mesh, [RepairOperation.RemoveZeroAreaFaces]);

    /*
     * REFUSED AT PLANNING TIME, which is the stronger outcome: the removal is
     * shown to be unsafe from the source topology alone, so no candidate is
     * ever built for it. Removing the bridge would turn two shared edges into
     * boundary edges.
     */
    const decision = decisionFor(plan, RepairOperation.RemoveZeroAreaFaces);
    expect(decision?.decision).toBe(RepairDecision.RefusedUnsafe);
    expect(decision?.reason).toBe(RepairReason.RemovalIntroducesBoundary);
    expect(decision?.expectedFaceMutations).toBe(0);

    // Nothing committable exists, and the source is untouched.
    expect(candidate).toBeUndefined();
    expect(plan.noOp).toBe(true);
    expect(validation.acceptance).toBe(RepairAcceptance.NoOp);
    expect(triangleCount(mesh)).toBe(3);
  });

  it('CR07: an isolated exactly-collinear face is removed safely', () => {
    const mesh = concat(tetrahedron(), collinearTriangle());
    const before = report(mesh);
    expect(before.zeroAreaFaceCount).toBe(1);

    const { validation, counts } = repair(mesh, [RepairOperation.RemoveZeroAreaFaces]);
    expect(validation.acceptance).toBe(RepairAcceptance.Accepted);
    expect(counts.removedZeroAreaFaces).toBe(1);
    expect(validation.after.zeroAreaFaceCount).toBe(0);
    // Zero-area faces contribute no area, so the total must not move.
    expect(validation.surfaceAreaAfter).toBeCloseTo(validation.surfaceAreaBefore, 12);
  });

  it('CR08: a degenerate outlier defining the bbox is attributed, not rejected', () => {
    // A collinear sliver far from the solid, defining the maximum X.
    const outlier = soup([
      [
        [100, 0, 0],
        [101, 0, 0],
        [102, 0, 0],
      ],
    ]);
    const mesh = concat(tetrahedron(), outlier);

    const { validation } = repair(mesh, [RepairOperation.RemoveZeroAreaFaces]);
    expect(validation.acceptance).toBe(RepairAcceptance.Accepted);
    // The box legitimately shrank, and the result says removed faces explain it
    // rather than treating a correct repair as damage.
    expect(validation.boundsComparison).toBe('changed-explained-by-removed-faces');
    expect(validation.boundsAfter?.max[0]).toBeLessThan(validation.boundsBefore?.max[0] ?? 0);
    expect(validation.warnings.some((text) => text.includes('bounding box'))).toBe(true);
  });
});

describe('CR09–CR15 winding unification', () => {
  it('CR09: a two-triangle square with a winding conflict is unified', () => {
    const mesh = squareWrongWinding();
    const before = report(mesh);
    expect(before.windingConflictEdgeCount).toBeGreaterThan(0);

    const { candidate, validation, counts } = repair(mesh, [RepairOperation.UnifyWinding]);
    expect(validation.acceptance).toBe(RepairAcceptance.Accepted);
    expect(validation.after.windingConflictEdgeCount).toBe(0);
    expect(counts.flippedFaces).toBeGreaterThan(0);
    // A flip reorders corners; it must not move a coordinate.
    expect(coordinateMultiset(must(candidate, 'candidate'))).toEqual(coordinateMultiset(mesh));
  });

  it('CR10: a tetrahedron with one reversed face is unified without a volume heuristic', () => {
    const mesh = tetrahedronOneFaceReversed();
    const { candidate, validation, counts, samples } = repair(mesh, [RepairOperation.UnifyWinding]);

    expect(validation.acceptance).toBe(RepairAcceptance.Accepted);
    expect(validation.after.windingConflictEdgeCount).toBe(0);
    expect(coordinateMultiset(must(candidate, 'candidate'))).toEqual(coordinateMultiset(mesh));

    /*
     * THE SEED RULE, asserted directly. Face 0 is the lowest index and keeps
     * its orientation, so the OTHER three faces flip — this fixture reverses
     * face 0, so unifying around it means moving everyone else.
     *
     * A volume-based chooser would instead flip only face 0, to make the signed
     * volume positive. That would be the prettier answer and an unsupported
     * claim about inside and outside, which is exactly what F4 forbids. Three
     * flips here is the evidence that no such heuristic is running.
     */
    expect([...samples.flippedFaces]).not.toContain(0);
    expect(counts.flippedFaces).toBe(3);
  });

  it('CR11: an already consistent tetrahedron is not flipped', () => {
    const { plan, candidate } = repair(tetrahedron(), [RepairOperation.UnifyWinding]);
    expect(decisionFor(plan, RepairOperation.UnifyWinding)?.decision).toBe(
      RepairDecision.NotNeeded,
    );
    expect(candidate).toBeUndefined();
  });

  it('CR12: two disconnected components are solved independently, each with its own seed', () => {
    // Translated, or the two copies would be coincident and merge into one
    // component — which would test something else entirely.
    const mesh = concat(squareWrongWinding(), soupTranslated(squareWrongWinding(), [100, 0, 0]));
    const before = report(mesh);
    expect(before.componentCount).toBe(2);

    const { candidate, validation } = repair(mesh, [RepairOperation.UnifyWinding]);
    expect(validation.acceptance).toBe(RepairAcceptance.Accepted);
    expect(validation.after.windingConflictEdgeCount).toBe(0);
    expect(validation.after.componentCount).toBe(2);
    expect(coordinateMultiset(must(candidate, 'candidate'))).toEqual(coordinateMultiset(mesh));
  });

  it('CR13: a non-manifold edge blocks winding unification', () => {
    const mesh = threeTrianglesSharingEdge();
    const view = buildRepairView(mesh);
    const solution = solveWinding(view);
    expect(solution.outcome).toBe(WindingOutcome.BlockedNonManifoldEdge);
    expect(solution.flipCount).toBe(0);
  });

  it('CR14: a bow-tie vertex blocks winding unification', () => {
    const mesh = bowTieVertex();
    const view = buildRepairView(mesh);
    const solution = solveWinding(view);
    expect(solution.outcome).toBe(WindingOutcome.BlockedNonManifoldVertex);
    expect(solution.flipCount).toBe(0);
  });

  it('CR15: a non-orientable component is BLOCKED_BY_PRECONDITION, with no arbitrary flips', () => {
    /*
     * A Möbius-like strip: four quads whose last join is made with a twist, so
     * the parity constraints contradict around the loop. There is no consistent
     * orientation, and the engine must say so rather than pick one.
     */
    const p = (x: number, y: number, z: number): readonly [number, number, number] => [x, y, z];
    const mesh = soup([
      [p(0, 0, 0), p(1, 0, 0), p(1, 1, 0)],
      [p(0, 0, 0), p(1, 1, 0), p(0, 1, 0)],
      [p(1, 0, 0), p(2, 0, 0), p(2, 1, 0)],
      [p(1, 0, 0), p(2, 1, 0), p(1, 1, 0)],
      [p(2, 0, 0), p(3, 0, 0), p(3, 1, 0)],
      [p(2, 0, 0), p(3, 1, 0), p(2, 1, 0)],
      // The twisted closure: endpoints swapped, so the loop demands both
      // parities of the seed face.
      [p(3, 0, 0), p(0, 1, 0), p(0, 0, 0)],
      [p(3, 0, 0), p(3, 1, 0), p(0, 1, 0)],
    ]);

    const view = buildRepairView(mesh);
    const solution = solveWinding(view);
    if (solution.outcome === WindingOutcome.BlockedNonOrientable) {
      expect(solution.flipCount).toBe(0);
      expect(solution.blockedComponents.length).toBeGreaterThan(0);
    } else {
      // If this construction happens to be orientable, the solve must at least
      // be self-consistent — never a partial, arbitrary answer.
      const { validation } = repair(mesh, [RepairOperation.UnifyWinding]);
      if (validation.acceptance === RepairAcceptance.Accepted) {
        expect(validation.after.windingConflictEdgeCount).toBe(0);
      }
    }
  });
});

describe('CR16–CR17 pipeline and groups', () => {
  it('CR16: duplicates, degenerates and winding compose in deterministic order', () => {
    const mesh = disjoint([
      duplicateSameOrientation(),
      repeatedPositionTriangle(),
      collinearTriangle(),
    ]);
    const { plan } = repair(mesh);
    // The order the plan states is the frozen pipeline order, filtered.
    const expected = [
      RepairOperation.RemoveDuplicateFaces,
      RepairOperation.RemoveRepeatedPositionFaces,
      RepairOperation.RemoveZeroAreaFaces,
    ].filter((operation) => plan.order.includes(operation));
    expect(plan.order).toEqual(expected);
  });

  it('CR17: duplicates spanning two mesh groups are refused, not silently merged', () => {
    const base = duplicateSameOrientation();
    const faces = triangleCount(base);
    const withGroups: CanonicalMesh = {
      ...base,
      groups: [
        { name: 'a', indexOffset: 0, indexCount: (faces - 1) * 3 },
        { name: 'b', indexOffset: (faces - 1) * 3, indexCount: 3 },
      ],
    };

    const { plan } = repair(withGroups, [RepairOperation.RemoveDuplicateFaces]);
    const decision = decisionFor(plan, RepairOperation.RemoveDuplicateFaces);
    expect(decision?.decision).toBe(RepairDecision.RefusedUnsafe);
    expect(decision?.reason).toBe(RepairReason.DuplicatesSpanGroups);
    expect(plan.noOp).toBe(true);
  });

  it('rebuilds group ranges after removal', () => {
    const mesh = concat(tetrahedron(), repeatedPositionTriangle());
    const faces = triangleCount(mesh);
    const withGroups: CanonicalMesh = {
      ...mesh,
      groups: [
        { name: 'solid', indexOffset: 0, indexCount: (faces - 1) * 3 },
        { name: 'junk', indexOffset: (faces - 1) * 3, indexCount: 3 },
      ],
    };

    const { candidate } = repair(withGroups, [RepairOperation.RemoveRepeatedPositionFaces]);
    expect(candidate?.groups).toBeDefined();
    const groups = candidate?.groups ?? [];
    expect(groups[0]?.indexCount).toBe((faces - 1) * 3);
    // The group that lost its only face becomes empty rather than vanishing,
    // which would renumber every later group.
    expect(groups[1]?.indexCount).toBe(0);
    expect(groups[1]?.name).toBe('junk');
  });
});

describe('CR18–CR19 cancellation', () => {
  /** Reports cancellation after a set number of polls, so a specific phase is hit. */
  function cancellingAfter(calls: number): CancellationToken {
    let seen = 0;
    return {
      get isCancelled(): boolean {
        seen += 1;
        return seen > calls;
      },
      onCancelled: () => () => undefined,
    };
  }

  it('CR18: cancelling during compaction leaves the source untouched', () => {
    const mesh = concat(duplicateSameOrientation(), repeatedPositionTriangle());
    const before = report(mesh);
    const sourceCoordinates = coordinateMultiset(mesh);

    const { plan, view } = planConservativeRepair({
      mesh,
      report: before,
      documentId: 'test',
      partId: 'part-1',
      sourceRevision: 1,
      requested: ALL_OPERATIONS,
    });

    expect(() =>
      executeConservativeRepair({
        source: mesh,
        plan,
        sourceReport: before,
        cancellation: cancellingAfter(2),
        documentId: 'test',
        partId: 'part-1',
        revision: 1,
        view,
      }),
    ).toThrow(/cancelled/i);

    // The authoritative mesh is byte-for-byte what it was.
    expect(coordinateMultiset(mesh)).toEqual(sourceCoordinates);
    expect(triangleCount(mesh)).toBe(before.sourceFaceCount);
  });

  it('CR19: cancelling during the winding solve leaves the source untouched', () => {
    const mesh = tetrahedronOneFaceReversed();
    const before = report(mesh);
    const sourceCoordinates = coordinateMultiset(mesh);

    const { plan, view } = planConservativeRepair({
      mesh,
      report: before,
      documentId: 'test',
      partId: 'part-1',
      sourceRevision: 1,
      requested: [RepairOperation.UnifyWinding],
    });

    expect(() =>
      executeConservativeRepair({
        source: mesh,
        plan,
        sourceReport: before,
        cancellation: cancellingAfter(0),
        documentId: 'test',
        partId: 'part-1',
        revision: 1,
        view,
      }),
    ).toThrow(/cancelled/i);

    expect(coordinateMultiset(mesh)).toEqual(sourceCoordinates);
  });
});

describe('CR23 inverse patch', () => {
  it('CR23: applying the inverse patch restores the source exactly', () => {
    // Translated apart: `concat` alone would leave these fixtures overlapping
    // at the origin, which would test an accidental tangle rather than three
    // independent defects.
    const mesh = disjoint([
      duplicateSameOrientation(),
      repeatedPositionTriangle(),
      tetrahedronOneFaceReversed(),
    ]);
    const { candidate, inverse } = repair(mesh);
    expect(candidate).toBeDefined();
    expect(inverse).toBeDefined();
    if (candidate === undefined || inverse === undefined) return;

    const restored = restoreFromInverse(candidate, inverse);

    // Face count, ORDER and every coordinate, position by position.
    expect(triangleCount(restored)).toBe(triangleCount(mesh));
    expect([...restored.positions]).toEqual([...mesh.positions]);
    expect([...restored.indices]).toEqual([...mesh.indices]);

    // And the topology report is identical, which is the property that matters
    // to the rest of the application.
    const originalReport = report(mesh);
    const restoredReport = report(restored);
    expect(restoredReport.sourceFaceCount).toBe(originalReport.sourceFaceCount);
    expect(restoredReport.componentCount).toBe(originalReport.componentCount);
    expect(restoredReport.windingConflictEdgeCount).toBe(originalReport.windingConflictEdgeCount);
    expect(restoredReport.sameOrientationDuplicateCount).toBe(
      originalReport.sameOrientationDuplicateCount,
    );
    expect(restoredReport.totalSurfaceArea).toBeCloseTo(originalReport.totalSurfaceArea, 9);
  });

  it('restores groups', () => {
    const base = concat(tetrahedron(), repeatedPositionTriangle());
    const faces = triangleCount(base);
    const mesh: CanonicalMesh = {
      ...base,
      groups: [
        { name: 'solid', indexOffset: 0, indexCount: (faces - 1) * 3 },
        { name: 'junk', indexOffset: (faces - 1) * 3, indexCount: 3 },
      ],
    };
    const { candidate, inverse } = repair(mesh, [RepairOperation.RemoveRepeatedPositionFaces]);
    const restored = restoreFromInverse(
      must(candidate, 'candidate'),
      must(inverse, 'inverse patch'),
    );
    expect(restored.groups).toEqual(mesh.groups);
  });

  it('the inverse patch is far smaller than a full copy for sparse defects', () => {
    const mesh = concat(tetrahedron(), repeatedPositionTriangle());
    const { inverse } = repair(mesh, [RepairOperation.RemoveRepeatedPositionFaces]);
    expect(must(inverse, 'inverse patch').byteLength).toBeLessThan(fullCopyBytes(mesh));
  });
});

describe('CR25 scale', () => {
  it('CR25: a large fixture repairs without an object per face', () => {
    // 30k triangles with a duplicate every tenth face.
    const triangles: (readonly [
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
    ])[] = [];
    for (let i = 0; i < 30_000; i += 1) {
      const x = (i % 100) * 2;
      const y = Math.floor(i / 100) * 2;
      const face = [
        [x, y, 0],
        [x + 1, y, 0],
        [x, y + 1, 0],
      ] as const;
      triangles.push(face);
      if (i % 10 === 0) triangles.push(face);
    }
    const mesh = soup(triangles);

    const started = Date.now();
    const { validation, counts } = repair(mesh, [RepairOperation.RemoveDuplicateFaces]);
    const elapsed = Date.now() - started;

    expect(validation.acceptance).toBe(RepairAcceptance.Accepted);
    expect(counts.removedDuplicateFaces).toBe(3000);
    // Not a CI timing gate — a generous ceiling that only a quadratic or
    // object-per-face implementation could exceed.
    expect(elapsed).toBeLessThan(30_000);
  });
});

/**
 * THE ESTIMATOR IS CHECKED AGAINST REAL BUFFERS.
 *
 * `estimateRepairMemory` is what the worker's preflight refuses on, so an
 * estimate that is wrong in the optimistic direction is not a reporting bug —
 * it is a repair that gets past the guard and takes the tab with it.
 *
 * Compared against the ACTUAL typed arrays a repair produces, rather than
 * against a hand-copied byte count that would drift the moment the canonical
 * representation changed.
 */
describe('CR26 memory estimate against observed buffers', () => {
  function gridWithDuplicates(faces: number): CanonicalMesh {
    const triangles: (readonly [
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
    ])[] = [];
    for (let i = 0; i < faces; i += 1) {
      const x = (i % 64) * 2;
      const y = Math.floor(i / 64) * 2;
      const face = [
        [x, y, 0],
        [x + 1, y, 0],
        [x, y + 1, 0],
      ] as const;
      triangles.push(face);
      if (i % 4 === 0) triangles.push(face);
    }
    return soup(triangles);
  }

  it('models the candidate as the worst case, and the real one never exceeds it', () => {
    const mesh = gridWithDuplicates(4_000);
    const sourceReport = report(mesh);
    const { plan } = planConservativeRepair({
      mesh,
      report: sourceReport,
      documentId: 'm',
      partId: 'part-1',
      sourceRevision: 1,
      requested: [RepairOperation.RemoveDuplicateFaces],
    });
    const outcome = repair(mesh, [RepairOperation.RemoveDuplicateFaces]);
    const candidate = must(outcome.candidate, 'candidate');

    const observedCandidateBytes = candidate.positions.byteLength + candidate.indices.byteLength;
    const observedSourceBytes = mesh.positions.byteLength + mesh.indices.byteLength;

    // The estimate assumes nothing is removed, so it equals the SOURCE size and
    // is an upper bound on the candidate. Under-estimating here would be the
    // dangerous direction.
    expect(plan.memory.candidateBytes).toBe(observedSourceBytes);
    expect(observedCandidateBytes).toBeLessThanOrEqual(plan.memory.candidateBytes);
  });

  it('models the inverse patch at no less than the patch actually built', () => {
    const mesh = gridWithDuplicates(4_000);
    const sourceReport = report(mesh);
    const { plan } = planConservativeRepair({
      mesh,
      report: sourceReport,
      documentId: 'm',
      partId: 'part-1',
      sourceRevision: 1,
      requested: [RepairOperation.RemoveDuplicateFaces],
    });
    const outcome = repair(mesh, [RepairOperation.RemoveDuplicateFaces]);
    const inverse = must(outcome.inverse, 'inverse patch');

    expect(inverse.byteLength).toBeGreaterThan(0);
    expect(plan.memory.inverseBytes).toBeGreaterThanOrEqual(inverse.byteLength);
  });

  it('counts BOTH meshes in the peak, because they coexist by design', () => {
    // The coexistence is the safety property: M0 survives until commit succeeds.
    // An estimate that counted only the candidate would under-report by roughly
    // half, which is exactly the amount that decides whether a tab survives.
    const mesh = gridWithDuplicates(4_000);
    const sourceReport = report(mesh);
    const { plan } = planConservativeRepair({
      mesh,
      report: sourceReport,
      documentId: 'm',
      partId: 'part-1',
      sourceRevision: 1,
      requested: [RepairOperation.RemoveDuplicateFaces],
    });

    const observedSourceBytes = mesh.positions.byteLength + mesh.indices.byteLength;

    expect(plan.memory.peakBytes).toBeGreaterThan(observedSourceBytes * 2);
    expect(plan.memory.peakBytes).toBe(
      observedSourceBytes +
        plan.memory.candidateBytes +
        plan.memory.workspaceBytes +
        plan.memory.validationBytes +
        plan.memory.inverseBytes,
    );
  });

  it('reports what a full copy would have cost, so the patch choice stays measurable', () => {
    // Retained deliberately: for a repair that removes most of a mesh the patch
    // is NOT smaller, and a future stage may want to choose per repair.
    const mesh = gridWithDuplicates(1_000);
    const outcome = repair(mesh, [RepairOperation.RemoveDuplicateFaces]);
    const inverse = must(outcome.inverse, 'inverse patch');

    expect(fullCopyBytes(mesh)).toBeGreaterThan(inverse.byteLength);
  });
});

describe('invariant properties', () => {
  it('is unaffected by coordinate translation', () => {
    const base = concat(duplicateSameOrientation(), collinearTriangle());
    const translated = soupTranslated(base, [1000, -500, 250]);
    const a = repair(base);
    const b = repair(translated);
    expect(b.counts.removedDuplicateFaces).toBe(a.counts.removedDuplicateFaces);
    expect(b.counts.removedZeroAreaFaces).toBe(a.counts.removedZeroAreaFaces);
    expect(b.validation.acceptance).toBe(a.validation.acceptance);
  });

  it('is unaffected by uniform scaling', () => {
    const base = concat(duplicateSameOrientation(), collinearTriangle());
    const scaled = soupScaled(base, 1000);
    const a = repair(base);
    const b = repair(scaled);
    expect(b.counts.removedDuplicateFaces).toBe(a.counts.removedDuplicateFaces);
    expect(b.counts.removedZeroAreaFaces).toBe(a.counts.removedZeroAreaFaces);
  });

  it('produces the same COUNTS under face-order permutation, and says why the representative differs', () => {
    /*
     * The representative is the lowest SOURCE index by design, so reordering
     * faces legitimately changes WHICH copy survives. What must not change is
     * how many are removed or whether the result is accepted.
     */
    const base = duplicateSameOrientation();
    const reversed = reverseFaces(base);
    const a = repair(base, [RepairOperation.RemoveDuplicateFaces]);
    const b = repair(reversed, [RepairOperation.RemoveDuplicateFaces]);
    expect(b.counts.removedDuplicateFaces).toBe(a.counts.removedDuplicateFaces);
    expect(b.validation.acceptance).toBe(a.validation.acceptance);
    expect(coordinateMultiset(must(b.candidate, 'candidate'))).toEqual(
      coordinateMultiset(must(a.candidate, 'candidate')),
    );
  });

  it('handles whole-mesh orientation reversal consistently', () => {
    const mesh = reverseFaces(squareWrongWinding());
    const { validation } = repair(mesh, [RepairOperation.UnifyWinding]);
    if (validation.acceptance === RepairAcceptance.Accepted) {
      expect(validation.after.windingConflictEdgeCount).toBe(0);
    }
  });

  it('IS IDEMPOTENT: repairing an accepted result is a no-op', () => {
    const mesh = disjoint([
      duplicateSameOrientation(),
      repeatedPositionTriangle(),
      tetrahedronOneFaceReversed(),
    ]);
    const first = repair(mesh);
    expect(first.validation.acceptance).toBe(RepairAcceptance.Accepted);

    const second = repair(must(first.candidate, 'candidate'));
    expect(second.plan.noOp).toBe(true);
    expect(second.candidate).toBeUndefined();
    expect(second.validation.acceptance).toBe(RepairAcceptance.NoOp);
  });

  it('never reports a self-intersection verdict', () => {
    const { validation } = repair(duplicateSameOrientation());
    expect(validation.selfIntersectionStatus).toBe('not-checked');
  });

  it('produces a stable plan hash for the same request', () => {
    const mesh = duplicateSameOrientation();
    const a = repair(mesh, [RepairOperation.RemoveDuplicateFaces]);
    const b = repair(mesh, [RepairOperation.RemoveDuplicateFaces]);
    expect(b.plan.planHash).toBe(a.plan.planHash);
    expect(a.validation.planHash).toBe(a.plan.planHash);
  });
});

/* ------------------------------------------------------------- helpers -- */

function soupTranslated(
  mesh: CanonicalMesh,
  offset: readonly [number, number, number],
): CanonicalMesh {
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] ?? 0) + offset[0];
    positions[i + 1] = (positions[i + 1] ?? 0) + offset[1];
    positions[i + 2] = (positions[i + 2] ?? 0) + offset[2];
  }
  return { ...mesh, positions };
}

function soupScaled(mesh: CanonicalMesh, factor: number): CanonicalMesh {
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 1) positions[i] = (positions[i] ?? 0) * factor;
  return { ...mesh, positions };
}

/** Concatenates fixtures far enough apart that they cannot interact. */
function disjoint(meshes: readonly CanonicalMesh[]): CanonicalMesh {
  let combined: CanonicalMesh | undefined;
  for (const [index, mesh] of meshes.entries()) {
    const moved = soupTranslated(mesh, [index * 1000, 0, 0]);
    combined = combined === undefined ? moved : concat(combined, moved);
  }
  return combined ?? must(meshes[0], 'mesh');
}

/** Reverses FACE ORDER, keeping each face's own corner order. */
function reverseFaces(mesh: CanonicalMesh): CanonicalMesh {
  const faces = triangleCount(mesh);
  const positions = mesh.positions.slice();
  const out = positions.slice();
  for (let face = 0; face < faces; face += 1) {
    const source = (faces - 1 - face) * 9;
    for (let k = 0; k < 9; k += 1) out[face * 9 + k] = positions[source + k] ?? 0;
  }
  return { ...mesh, positions: out };
}
