/**
 * THE CONSERVATIVE PLANAR HOLE-FILL ENGINE.
 *
 * Deliberately KERNEL-FREE. This package holds the policy, the ceilings, the
 * frozen status taxonomy, the deterministic triangulator, the bounded
 * broadphase and every independent validator. The exact triangle/triangle
 * narrowphase is INJECTED — it is the Geogram WASM kernel, and it stays
 * confined to the disposable worker that loads it, which the production
 * boundary scan asserts.
 *
 * SCOPE, stated once so it cannot drift: ONE selected boundary loop per
 * operation, which must be a topologically simple manifold cycle under exact
 * stored-coordinate identity and must be proven planar by the relative policy.
 * No non-planar filling. No batch filling. No tolerance welding, seam snapping,
 * fairing, smoothing or surrounding remeshing. See
 * `docs/adr/0018-hole-filling-qualification.md`.
 */

export { runHoleFill } from './engine';
export type { HoleFillEngineInput, HoleFillEngineResult } from './engine';

export { HoleFillStatus, isRefusal, isValidCandidate } from './status';

export {
  DEFAULT_HOLE_FILL_LIMITS,
  HOLE_FILL_MAX_BOUNDARY_VERTICES,
  HOLE_FILL_MAX_PART_FACES,
  HOLE_FILL_MAX_PATCH_FACES,
  MAX_AABB_TESTS,
  MAX_BROADPHASE_CANDIDATES,
  MAX_BVH_NODE_VISITS,
  MAX_NARROWPHASE_PAIRS,
  MAX_SAMPLES,
  narrowHoleFillLimits,
  patchFaceCountFor,
} from './limits';
export type { HoleFillLimits } from './limits';

export { assessPlanarity, newellNormal, RELATIVE_PLANARITY } from './planarity';
export type { LoopPoint, PlanarityAssessment } from './planarity';

export {
  earClip,
  EarClipRefusal,
  projectedPolygonTwiceArea,
  projectedTwiceArea,
  projectionAxisFor,
  projectPoint,
} from './ear-clip';
export type { EarClipResult, PatchTriangle } from './ear-clip';

export { boxesOverlap, createCounters, faceBoxOf, FaceBvh } from './bvh';
export type { BroadphaseBudget, BroadphaseCounters } from './bvh';

export {
  analysePatchConnectivity,
  analysePatchFaces,
  analysePatchOrientation,
  eulerCharacteristicOf,
  validateSourcePreservation,
} from './validate';
export type {
  PatchConnectivityReport,
  PatchFaceReport,
  PatchOrientationReport,
  SourcePreservation,
} from './validate';

export type {
  HoleFillOperationIdentity,
  HoleFillOutcome,
  HoleFillPhaseTimings,
  HoleFillRequest,
  HoleFillValidationSummary,
  NarrowphaseBatchResult,
  NarrowphaseGeometry,
  NarrowphaseSamples,
  PatchNarrowphase,
} from './contract';
