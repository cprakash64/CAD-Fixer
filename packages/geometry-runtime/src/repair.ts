import type {
  BoundsComparison as EngineBoundsComparison,
  RepairAcceptance as EngineRepairAcceptance,
  RepairDecision as EngineRepairDecision,
  RepairOperation as EngineRepairOperation,
  RepairReason as EngineRepairReason,
  RepairRegression as EngineRepairRegression,
  VolumeComparison as EngineVolumeComparison,
} from '@cadfixer/mesh-repair';

/**
 * The repair contract's VALUES, restated here so the application can compare
 * against them without importing the repair engine.
 *
 * SAME REASON AS `topology.ts`, and it matters more here. A value re-export from
 * `@cadfixer/mesh-repair` would make its index — and therefore
 * `planConservativeRepair`, `executeConservativeRepair` and the whole
 * `mesh-topology` engine behind them — a runtime dependency of the main-thread
 * bundle, because the main thread imports the protocol from this package. The
 * repair engine belongs in the worker chunk and nowhere else. Trusting a bundler
 * to shake it back out is a promise nobody checks; a few frozen strings keep the
 * boundary provable instead.
 *
 * The duplication is guarded, not trusted: every constant is checked below
 * against the engine's own type in both directions, so a value that drifts fails
 * `tsc` rather than silently comparing false at runtime.
 */

export const RepairOperation = {
  RemoveDuplicateFaces: 'remove-duplicate-faces',
  RemoveRepeatedPositionFaces: 'remove-repeated-position-faces',
  RemoveZeroAreaFaces: 'remove-zero-area-faces',
  UnifyWinding: 'unify-winding',
} as const;

export type RepairOperation = (typeof RepairOperation)[keyof typeof RepairOperation];

/**
 * The order the engine runs selected operations in.
 *
 * Restated rather than imported for the reason above, and asserted against the
 * engine's own constant by test — the UI lists operations in pipeline order, and
 * a UI that showed a different order than the engine uses would be describing a
 * repair that does not happen.
 */
export const REPAIR_PIPELINE_ORDER: readonly RepairOperation[] = Object.freeze([
  RepairOperation.RemoveDuplicateFaces,
  RepairOperation.RemoveRepeatedPositionFaces,
  RepairOperation.RemoveZeroAreaFaces,
  RepairOperation.UnifyWinding,
]);

export const RepairDecision = {
  Applicable: 'APPLICABLE',
  NotNeeded: 'NOT_NEEDED',
  RefusedUnsafe: 'REFUSED_UNSAFE',
  Unsupported: 'UNSUPPORTED',
  BlockedByPrecondition: 'BLOCKED_BY_PRECONDITION',
} as const;

export type RepairDecision = (typeof RepairDecision)[keyof typeof RepairDecision];

export const RepairReason = {
  NoDefectPresent: 'no-defect-present',
  NotRequested: 'not-requested',
  NonManifoldEdgePresent: 'non-manifold-edge-present',
  NonManifoldVertexPresent: 'non-manifold-vertex-present',
  NonOrientableComponent: 'non-orientable-component',
  RemovalIntroducesBoundary: 'removal-introduces-boundary',
  RemovalIntroducesNonManifold: 'removal-introduces-non-manifold',
  RemovalChangesComponents: 'removal-changes-components',
  RemovalIntroducesWindingConflict: 'removal-introduces-winding-conflict',
  DuplicatesSpanGroups: 'duplicates-span-groups',
  OperationNotImplemented: 'operation-not-implemented',
  ResourceLimitExceeded: 'resource-limit-exceeded',
} as const;

export type RepairReason = (typeof RepairReason)[keyof typeof RepairReason];

export const RepairAcceptance = {
  Accepted: 'ACCEPTED',
  RejectedRegression: 'REJECTED_REGRESSION',
  BlockedPrecondition: 'BLOCKED_PRECONDITION',
  ResourceLimit: 'RESOURCE_LIMIT',
  Cancelled: 'CANCELLED',
  InternalFailure: 'INTERNAL_FAILURE',
  NoOp: 'NO_OP',
} as const;

export type RepairAcceptance = (typeof RepairAcceptance)[keyof typeof RepairAcceptance];

export const RepairRegression = {
  NonFiniteCoordinate: 'non-finite-coordinate',
  StructurallyInvalid: 'structurally-invalid',
  BoundaryEdgesIncreased: 'boundary-edges-increased',
  NonManifoldEdgesIncreased: 'non-manifold-edges-increased',
  NonManifoldVerticesIncreased: 'non-manifold-vertices-increased',
  WindingConflictsIncreased: 'winding-conflicts-increased',
  ReversedDuplicatesChanged: 'reversed-duplicates-changed',
  ComponentCountChanged: 'component-count-changed',
  TargetDefectNotRemoved: 'target-defect-not-removed',
  UnexpectedFaceCountChange: 'unexpected-face-count-change',
  SurfaceAreaChanged: 'surface-area-changed',
  CoordinateMoved: 'coordinate-moved',
} as const;

export type RepairRegression = (typeof RepairRegression)[keyof typeof RepairRegression];

export const VolumeComparison = {
  Unchanged: 'unchanged',
  ChangedByOrientation: 'changed-by-orientation',
  ChangedUnexpectedly: 'changed-unexpectedly',
  NotInterpretable: 'not-interpretable',
} as const;

export type VolumeComparison = (typeof VolumeComparison)[keyof typeof VolumeComparison];

export const BoundsComparison = {
  Identical: 'identical',
  ChangedExplainedByRemovedFaces: 'changed-explained-by-removed-faces',
  ChangedUnexplained: 'changed-unexplained',
  NotComparable: 'not-comparable',
} as const;

export type BoundsComparison = (typeof BoundsComparison)[keyof typeof BoundsComparison];

/**
 * Compile-time proof that the restatements above match the engine exactly.
 *
 * Checked in BOTH directions: one way alone would let this module quietly drop a
 * case the engine can still produce, which is the failure that would actually
 * reach a user — a decision or a refusal the interface has no branch for.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _operationMatches: Exactly<RepairOperation, EngineRepairOperation> = true;
const _decisionMatches: Exactly<RepairDecision, EngineRepairDecision> = true;
const _reasonMatches: Exactly<RepairReason, EngineRepairReason> = true;
const _acceptanceMatches: Exactly<RepairAcceptance, EngineRepairAcceptance> = true;
const _regressionMatches: Exactly<RepairRegression, EngineRepairRegression> = true;
const _volumeMatches: Exactly<VolumeComparison, EngineVolumeComparison> = true;
const _boundsMatches: Exactly<BoundsComparison, EngineBoundsComparison> = true;

export const REPAIR_CONTRACT_CHECKED = [
  _operationMatches,
  _decisionMatches,
  _reasonMatches,
  _acceptanceMatches,
  _regressionMatches,
  _volumeMatches,
  _boundsMatches,
] as const;
