/**
 * CONSERVATIVE DETERMINISTIC MESH REPAIR — production.
 *
 * Exact-topology operations only. No tolerance, no reconstruction, no geometry
 * kernel, no React, no DOM. Produces validated CANDIDATES; the caller decides
 * whether to commit one, and the authoritative mesh is never mutated here.
 *
 * See docs/repair/REPAIR_ARCHITECTURE.md and docs/adr/0010.
 */

export {
  BoundsComparison,
  DEFAULT_CHANGE_SAMPLE_LIMIT,
  RepairAcceptance,
  RepairDecision,
  RepairOperation,
  RepairReason,
  RepairRegression,
  REPAIR_PIPELINE_ORDER,
  REPAIR_PLAN_VERSION,
  REPAIR_RECORD_VERSION,
  REPAIR_VALIDATION_VERSION,
  VolumeComparison,
} from './contract';
export type {
  ConservativeRepairPlan,
  RepairChangeCounts,
  RepairChangeSamples,
  RepairDefectDeltas,
  RepairMemoryEstimate,
  RepairOperationDecision,
  RepairValidation,
} from './contract';

export { estimateRepairMemory, planConservativeRepair } from './plan';
export type { RepairPlanInput, RepairPlanResult } from './plan';

export { executeConservativeRepair, RepairCancelled } from './pipeline';
export type { RepairExecutionInput, RepairExecutionResult } from './pipeline';

export { buildInversePatch, fullCopyBytes, restoreFromInverse } from './inverse';
export type { RepairInversePatch } from './inverse';

export {
  selectDuplicateFaces,
  selectRepeatedPositionFaces,
  selectZeroAreaFaces,
  solveWinding,
  WindingOutcome,
} from './operations';
export type { DegenerateSelection, DuplicateSelection, WindingSolution } from './operations';

export { rebuildCandidate } from './rebuild';
export type { RebuiltCandidate } from './rebuild';

export {
  buildRepairView,
  facesOnNonManifoldEdges,
  facesOnNonManifoldVertices,
  hasRepeatedPosition,
  isExactlyZeroArea,
  vertexCoordinate,
} from './view';
export type { RepairView } from './view';
