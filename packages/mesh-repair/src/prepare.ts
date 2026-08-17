import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import { RepairOperation } from './contract';
import { isDegenerateRemovalSafe } from './predict';
import {
  selectDuplicateFaces,
  selectRepeatedPositionFaces,
  selectZeroAreaFaces,
  solveWinding,
  WindingOutcome,
  type DuplicateSelection,
  type WindingSolution,
} from './operations';
import { rebuildCandidate } from './rebuild';
import { buildRepairView, type RepairView } from './view';

/**
 * Everything both planning and execution need, computed exactly once.
 *
 * WHY WINDING IS SOLVED ON THE POST-REMOVAL TOPOLOGY. The first version solved
 * it on the source and tried to compensate for pending removals. That was
 * wrong in a way the idempotence test caught: a duplicated triangle makes its
 * edges non-manifold AND its corners non-manifold vertices, and while the edge
 * check could be adjusted for removals, the vertex check could not. Winding was
 * refused because of a defect the same pipeline had already deleted — so
 * repairing twice kept finding more to do, and the operation was not idempotent.
 *
 * Removals are now materialised into an INTERMEDIATE mesh, its topology is
 * recovered from scratch, and winding is solved against that. It costs one
 * extra compaction and one extra connectivity build; it buys a parity solve
 * that sees the surface as it will actually exist. Incremental adjustment of
 * three interacting analyses would have been faster and would have been the
 * kind of cleverness that produces plausible, wrong answers.
 *
 * Planning and execution share this so the plan cannot promise something
 * execution then decides differently.
 */

export interface PreparedStage {
  readonly operation: RepairOperation;
  readonly mask: Uint8Array;
  readonly count: number;
  readonly safe: boolean;
  readonly boundaryDelta: number;
  readonly nonManifoldDelta: number;
}

export interface PreparedRepair {
  readonly sourceView: RepairView;
  readonly stages: readonly PreparedStage[];
  /** Union of every safe stage's removals, over SOURCE face indices. */
  readonly removalMask: Uint8Array;
  readonly removalCount: number;
  readonly duplicates: DuplicateSelection | null;
  /** The mesh after removals, before flips. Absent when nothing is removed. */
  readonly intermediate: CanonicalMesh | undefined;
  /** Maps intermediate face index to source face index. */
  readonly intermediateToSource: Uint32Array | undefined;
  readonly winding: WindingSolution | null;
  /** Flip mask over SOURCE face indices, for the inverse patch. */
  readonly sourceFlipMask: Uint8Array | undefined;
  readonly flipCount: number;
}

export function prepareConservativeRepair(
  mesh: CanonicalMesh,
  report: TopologyReport,
  requested: readonly RepairOperation[],
  existingView?: RepairView,
): PreparedRepair {
  const sourceView = existingView ?? buildRepairView(mesh);
  const faceCount = sourceView.faceCount;
  const wants = (operation: RepairOperation): boolean => requested.includes(operation);

  const stages: PreparedStage[] = [];
  const removalMask = new Uint8Array(faceCount);
  let removalCount = 0;

  let duplicates: DuplicateSelection | null = null;
  if (wants(RepairOperation.RemoveDuplicateFaces) && report.sameOrientationDuplicateCount > 0) {
    duplicates = selectDuplicateFaces(sourceView);
    if (!duplicates.spansMeshGroups) {
      // Duplicate removal is exempt from the strict degeneracy gate: its
      // boundary and area effects are expected and are checked by prediction.
      stages.push({
        operation: RepairOperation.RemoveDuplicateFaces,
        mask: duplicates.removeMask,
        count: duplicates.removeCount,
        safe: true,
        boundaryDelta: 0,
        nonManifoldDelta: 0,
      });
    }
  }

  const addDegenerate = (operation: RepairOperation, count: number, mask: Uint8Array): void => {
    if (count === 0) return;
    const safety = isDegenerateRemovalSafe(sourceView, mask);
    stages.push({
      operation,
      mask,
      count,
      safe: safety.safe,
      boundaryDelta: safety.boundaryDelta,
      nonManifoldDelta: safety.nonManifoldDelta,
    });
  };

  if (wants(RepairOperation.RemoveRepeatedPositionFaces) && report.repeatedPositionFaceCount > 0) {
    const selection = selectRepeatedPositionFaces(sourceView);
    addDegenerate(
      RepairOperation.RemoveRepeatedPositionFaces,
      selection.removeCount,
      selection.removeMask,
    );
  }
  if (wants(RepairOperation.RemoveZeroAreaFaces) && report.zeroAreaFaceCount > 0) {
    const selection = selectZeroAreaFaces(sourceView);
    addDegenerate(RepairOperation.RemoveZeroAreaFaces, selection.removeCount, selection.removeMask);
  }

  for (const stage of stages) {
    if (!stage.safe) continue;
    for (let face = 0; face < faceCount; face += 1) {
      if (stage.mask[face] === 1 && removalMask[face] !== 1) {
        removalMask[face] = 1;
        removalCount += 1;
      }
    }
  }

  /* ---------------------------------------------- intermediate + winding -- */

  let intermediate: CanonicalMesh | undefined;
  let intermediateToSource: Uint32Array | undefined;
  if (removalCount > 0) {
    const rebuilt = rebuildCandidate(mesh, faceCount, removalMask, undefined);
    intermediate = rebuilt.mesh;
    intermediateToSource = rebuilt.candidateToSourceFace;
  }

  let winding: WindingSolution | null = null;
  let sourceFlipMask: Uint8Array | undefined;
  let flipCount = 0;

  if (wants(RepairOperation.UnifyWinding)) {
    const windingView = intermediate === undefined ? sourceView : buildRepairView(intermediate);
    winding = solveWinding(windingView);

    if (winding.outcome === WindingOutcome.Solved) {
      sourceFlipMask = new Uint8Array(faceCount);
      for (let face = 0; face < windingView.faceCount; face += 1) {
        if (winding.flipMask[face] !== 1) continue;
        const sourceFace =
          intermediateToSource === undefined ? face : (intermediateToSource[face] ?? face);
        sourceFlipMask[sourceFace] = 1;
        flipCount += 1;
      }
    }
  }

  return {
    sourceView,
    stages,
    removalMask,
    removalCount,
    duplicates,
    intermediate,
    intermediateToSource,
    winding,
    sourceFlipMask,
    flipCount,
  };
}
