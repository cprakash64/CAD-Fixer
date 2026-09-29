/**
 * `@cadfixer/mesh-hole-fill/admission` — REPAIR-CORE-02.
 *
 * THE ONLY PART OF THIS PACKAGE THE AUTHORITATIVE GEOMETRY WORKER MAY IMPORT.
 * Everything reachable from here is pure and bounded by the loop: planarity,
 * deterministic ear clipping, the admission rules and the local-region builder.
 * The engine entry (`runHoleFill`), the BVH and anything that drives the exact
 * narrowphase are NOT reachable from here — they stay in the disposable worker,
 * where cancellation is termination. A production boundary test holds both
 * halves of that.
 */
export {
  admitBoundaryLoops,
  BoundaryFillVerdict,
  DEFAULT_BOUNDARY_FILL_LIMITS,
  narrowBoundaryFillLimits,
  triangleArea,
} from './admission';
export type {
  AdmittedLoop,
  BoundaryFillAdmission,
  BoundaryFillLimits,
  LoopDecision,
} from './admission';
export { buildLocalPatchProblem } from './local-region';
export type { LocalPatchProblem, LocalRegionOptions } from './local-region';
export {
  appendPatches,
  FillRegression,
  judgeFilledCandidate,
  sourcePreserved,
} from './fill-candidate';
