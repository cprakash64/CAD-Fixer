/**
 * The self-intersection diagnostic CONTRACT.
 *
 * Deliberately kernel-free. This package holds the policy, the caps, the frozen
 * taxonomy and the status model — everything the application and the worker
 * must agree on. The Geogram kernel itself lives in the disposable diagnostic
 * worker and is never reachable from the main-thread bundle, which the
 * production boundary scan asserts.
 */

export {
  AUTO_ELIGIBLE_MAX_FACES,
  SELF_INTERSECTION_MAX_FACES,
  SelfIntersectionBand,
  bandForFaceCount,
  isAutoEligible,
  isCheckable,
} from './policy';

export {
  SelfIntersectionCategory,
  SelfIntersectionPhase,
  SelfIntersectionStatus,
  hasFindings,
  isCompleteCleanResult,
  isIncompleteExamination,
} from './contract';
export type {
  SelfIntersectionCategoryCounts,
  SelfIntersectionEngine,
  SelfIntersectionReport,
} from './contract';

export {
  DEFAULT_SELF_INTERSECTION_LIMITS,
  MAX_CANDIDATE_PAIRS,
  MAX_SAMPLES,
  MAX_TESTED_PAIRS,
  SAMPLE_STRIDE,
  narrowLimits,
} from './limits';
export type { SelfIntersectionLimits } from './limits';
