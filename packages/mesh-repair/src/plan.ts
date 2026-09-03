import { triangleCount } from '@cadfixer/mesh-core';
import type { CancellationToken } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import {
  RepairDecision,
  RepairOperation,
  RepairReason,
  REPAIR_PIPELINE_ORDER,
  REPAIR_PLAN_VERSION,
  type ConservativeRepairPlan,
  type RepairMemoryEstimate,
  type RepairOperationDecision,
} from './contract';
import { WindingOutcome } from './operations';
import { prepareConservativeRepair, type PreparedRepair } from './prepare';
import type { RepairView } from './view';

/**
 * Turns a topology report plus a request into a plan that states exactly what
 * will happen.
 *
 * PLANNING IS NOT DOING. Nothing is mutated here and no candidate is allocated.
 * The plan exists so a caller — and later a user — can see which operations
 * will run, which are refused and why, and what it will cost, BEFORE any
 * memory is committed.
 *
 * REQUESTED IS NOT PERMITTED. The plan never widens what was asked for: an
 * operation absent from `requested` is `NOT_NEEDED` with reason
 * `not-requested`, even if the defect exists. A repair engine that fixes things
 * nobody asked it to fix is not conservative.
 */

export interface RepairPlanInput {
  readonly mesh: CanonicalMesh;
  readonly report: TopologyReport;
  readonly modelId: string;
  readonly sourceRevision: number;
  readonly requested: readonly RepairOperation[];
  /** Reject before allocating if the estimated peak exceeds this. */
  readonly memoryBudgetBytes?: number;
  /** Polled inside planning's own loops. Planning builds connectivity too. */
  readonly cancellation?: CancellationToken;
}

export interface RepairPlanResult {
  readonly plan: ConservativeRepairPlan;
  /** Reused by candidate creation so connectivity is built once. */
  readonly view: RepairView;
  /** The shared analysis, so execution repeats none of this work. */
  readonly prepared: PreparedRepair;
}

export function planConservativeRepair(input: RepairPlanInput): RepairPlanResult {
  const { mesh, report, requested } = input;
  const prepared = prepareConservativeRepair(
    mesh,
    report,
    requested,
    undefined,
    input.cancellation,
  );
  const view = prepared.sourceView;
  const faceCount = triangleCount(mesh);
  const stageFor = (operation: RepairOperation): (typeof prepared.stages)[number] | undefined =>
    prepared.stages.find((entry) => entry.operation === operation);

  const wants = (operation: RepairOperation): boolean => requested.includes(operation);
  const decisions: RepairOperationDecision[] = [];
  const warnings: string[] = [];

  /* ------------------------------------------------------------ duplicates -- */

  const duplicates = prepared.duplicates;

  if (!wants(RepairOperation.RemoveDuplicateFaces)) {
    decisions.push(
      notRequested(RepairOperation.RemoveDuplicateFaces, report.sameOrientationDuplicateCount),
    );
  } else if (report.sameOrientationDuplicateCount === 0) {
    decisions.push({
      operation: RepairOperation.RemoveDuplicateFaces,
      decision: RepairDecision.NotNeeded,
      reason: RepairReason.NoDefectPresent,
      targetedCount: 0,
      expectedFaceMutations: 0,
    });
  } else if (duplicates?.spansMeshGroups === true) {
    // Refusing rather than silently discarding a group assignment. See
    // `meshGroupIndexPerFace` in operations.ts.
    warnings.push(
      'Duplicate faces belong to different mesh groups. Removing one would discard a group assignment, so duplicate removal was refused.',
    );
    decisions.push({
      operation: RepairOperation.RemoveDuplicateFaces,
      decision: RepairDecision.RefusedUnsafe,
      reason: RepairReason.DuplicatesSpanGroups,
      targetedCount: report.sameOrientationDuplicateCount,
      expectedFaceMutations: 0,
      note: 'A duplicate group spans two mesh groups; the distinction would be lost.',
    });
  } else {
    decisions.push({
      operation: RepairOperation.RemoveDuplicateFaces,
      decision: RepairDecision.Applicable,
      reason: RepairReason.NoDefectPresent,
      targetedCount: report.sameOrientationDuplicateCount,
      expectedFaceMutations: duplicates?.removeCount ?? 0,
    });
  }

  /* ------------------------------------------------------------ degeneracy -- */

  decisions.push(
    degeneracyDecision(
      RepairOperation.RemoveRepeatedPositionFaces,
      wants(RepairOperation.RemoveRepeatedPositionFaces),
      report.repeatedPositionFaceCount,
      stageFor(RepairOperation.RemoveRepeatedPositionFaces),
    ),
  );
  decisions.push(
    degeneracyDecision(
      RepairOperation.RemoveZeroAreaFaces,
      wants(RepairOperation.RemoveZeroAreaFaces),
      report.zeroAreaFaceCount,
      stageFor(RepairOperation.RemoveZeroAreaFaces),
    ),
  );

  /* --------------------------------------------------------------- winding -- */

  if (!wants(RepairOperation.UnifyWinding)) {
    decisions.push(notRequested(RepairOperation.UnifyWinding, report.windingConflictEdgeCount));
  } else if (report.windingConflictEdgeCount === 0) {
    decisions.push({
      operation: RepairOperation.UnifyWinding,
      decision: RepairDecision.NotNeeded,
      reason: RepairReason.NoDefectPresent,
      targetedCount: 0,
      expectedFaceMutations: 0,
    });
  } else {
    // Solved against the POST-REMOVAL topology by `prepareConservativeRepair`,
    // so a non-manifold edge or vertex that exists only because of a duplicate
    // does not block a repair this same pipeline is about to make safe.
    const solution = prepared.winding;
    if (solution === null) {
      decisions.push(notRequested(RepairOperation.UnifyWinding, report.windingConflictEdgeCount));
    } else {
      decisions.push(
        windingDecision(report.windingConflictEdgeCount, solution, prepared.flipCount),
      );
    }
    if (solution?.outcome === WindingOutcome.BlockedNonOrientable) {
      warnings.push(
        'At least one component cannot be consistently oriented. Winding unification was blocked rather than choosing arbitrary flips.',
      );
    }
  }

  const order = REPAIR_PIPELINE_ORDER.filter((operation) =>
    decisions.some(
      (entry) => entry.operation === operation && entry.decision === RepairDecision.Applicable,
    ),
  );

  const memory = estimateRepairMemory(mesh, faceCount, decisions);
  if (input.memoryBudgetBytes !== undefined && memory.peakBytes > input.memoryBudgetBytes) {
    warnings.push(
      `Estimated repair peak ${String(Math.round(memory.peakBytes / 1_048_576))} MiB exceeds the ${String(Math.round(input.memoryBudgetBytes / 1_048_576))} MiB budget.`,
    );
  }

  const plan: ConservativeRepairPlan = {
    schemaVersion: REPAIR_PLAN_VERSION,
    modelId: input.modelId,
    sourceRevision: input.sourceRevision,
    reportVersion: report.schemaVersion,
    requested: [...requested],
    order,
    decisions,
    memory,
    warnings,
    planHash: hashPlan(input.modelId, input.sourceRevision, order, decisions),
    noOp: order.length === 0,
  };

  return { plan, view, prepared };
}

function notRequested(operation: RepairOperation, targeted: number): RepairOperationDecision {
  return {
    operation,
    decision: RepairDecision.NotNeeded,
    reason: RepairReason.NotRequested,
    targetedCount: targeted,
    expectedFaceMutations: 0,
  };
}

function degeneracyDecision(
  operation: RepairOperation,
  requested: boolean,
  targeted: number,
  stage: { safe: boolean; boundaryDelta: number; nonManifoldDelta: number } | undefined,
): RepairOperationDecision {
  if (!requested) return notRequested(operation, targeted);
  if (stage !== undefined && !stage.safe) {
    // Part E2: removing these would open a boundary or create a non-manifold
    // edge. Refused here, at planning time, so no candidate is ever built for
    // an operation that cannot be safe.
    return {
      operation,
      decision: RepairDecision.RefusedUnsafe,
      reason:
        stage.boundaryDelta > 0
          ? RepairReason.RemovalIntroducesBoundary
          : RepairReason.RemovalIntroducesNonManifold,
      targetedCount: targeted,
      expectedFaceMutations: 0,
      note: `boundary ${String(stage.boundaryDelta)}, non-manifold ${String(stage.nonManifoldDelta)}`,
    };
  }
  if (targeted === 0) {
    return {
      operation,
      decision: RepairDecision.NotNeeded,
      reason: RepairReason.NoDefectPresent,
      targetedCount: 0,
      expectedFaceMutations: 0,
    };
  }
  // APPLICABLE here means "will be attempted". Safety is decided against the
  // built candidate, not predicted — removing a degenerate face can change
  // connectivity, and only the post-removal topology can show whether it did.
  return {
    operation,
    decision: RepairDecision.Applicable,
    reason: RepairReason.NoDefectPresent,
    targetedCount: targeted,
    expectedFaceMutations: targeted,
  };
}

function windingDecision(
  conflicts: number,
  solution: { outcome: WindingOutcome },
  flipCount: number,
): RepairOperationDecision {
  switch (solution.outcome) {
    case WindingOutcome.Solved:
      return {
        operation: RepairOperation.UnifyWinding,
        decision: RepairDecision.Applicable,
        reason: RepairReason.NoDefectPresent,
        targetedCount: conflicts,
        expectedFaceMutations: flipCount,
      };
    case WindingOutcome.AlreadyConsistent:
      return {
        operation: RepairOperation.UnifyWinding,
        decision: RepairDecision.NotNeeded,
        reason: RepairReason.NoDefectPresent,
        targetedCount: conflicts,
        expectedFaceMutations: 0,
      };
    case WindingOutcome.BlockedNonManifoldEdge:
      return blockedWinding(conflicts, RepairReason.NonManifoldEdgePresent);
    case WindingOutcome.BlockedNonManifoldVertex:
      return blockedWinding(conflicts, RepairReason.NonManifoldVertexPresent);
    case WindingOutcome.BlockedNonOrientable:
      return blockedWinding(conflicts, RepairReason.NonOrientableComponent);
  }
}

function blockedWinding(conflicts: number, reason: RepairReason): RepairOperationDecision {
  return {
    operation: RepairOperation.UnifyWinding,
    decision: RepairDecision.BlockedByPrecondition,
    reason,
    targetedCount: conflicts,
    expectedFaceMutations: 0,
  };
}

/**
 * Peak while the authoritative mesh and the candidate coexist.
 *
 * They DO coexist — M0 survives until commit succeeds, which is the safety
 * property this whole design exists for — so the peak is both meshes plus the
 * masks, the compaction scratch, the validation workspace and the patch. An
 * estimate that counted only the candidate would under-report by roughly half.
 */
export function estimateRepairMemory(
  mesh: CanonicalMesh,
  faceCount: number,
  decisions: readonly RepairOperationDecision[],
): RepairMemoryEstimate {
  const authoritativeBytes = mesh.positions.byteLength + mesh.indices.byteLength;
  // Worst case: nothing is removed, so the candidate is the same size.
  const candidateBytes = authoritativeBytes;

  // Masks and parity state: a handful of bytes per face, not per coordinate.
  const maskBytes = faceCount * 4;
  // Identity, edges and edge groups, dominated by ~24 bytes per corner.
  const connectivityBytes = faceCount * 3 * 24;
  const workspaceBytes = maskBytes + connectivityBytes;

  const validationBytes = estimateTopologyWorkspaceBytes(faceCount, faceCount * 3);

  let removals = 0;
  let flips = 0;
  for (const entry of decisions) {
    if (entry.decision !== 'APPLICABLE') continue;
    if (entry.operation === RepairOperation.UnifyWinding) flips += entry.expectedFaceMutations;
    else removals += entry.expectedFaceMutations;
  }
  // Nine float64 coordinates plus an index per removed face, plus an index per
  // flipped face.
  const inverseBytes = removals * (9 * 8 + 4) + flips * 4;

  return {
    candidateBytes,
    workspaceBytes,
    validationBytes,
    inverseBytes,
    peakBytes:
      authoritativeBytes + candidateBytes + workspaceBytes + validationBytes + inverseBytes,
  };
}

/**
 * Deterministic plan identity.
 *
 * FNV-1a over the fields that decide what the repair will do. Not a security
 * primitive — it answers "is this the plan I validated?", which is the same
 * class of guard as a revision number. Wall-clock time is deliberately excluded
 * so the same request against the same model yields the same hash.
 */
function hashPlan(
  modelId: string,
  revision: number,
  order: readonly RepairOperation[],
  decisions: readonly RepairOperationDecision[],
): string {
  let hash = 0x811c9dc5;
  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  feed(modelId);
  feed(`@${String(revision)}`);
  for (const operation of order) feed(`|${operation}`);
  for (const entry of decisions) {
    feed(
      `#${entry.operation}:${entry.decision}:${entry.reason}:${String(entry.expectedFaceMutations)}`,
    );
  }
  return hash.toString(16).padStart(8, '0');
}
