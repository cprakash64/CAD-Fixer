import type { MeshBounds } from '@cadfixer/mesh-core';
import type { TopologyReport } from '@cadfixer/mesh-topology';

/**
 * CONSERVATIVE DETERMINISTIC REPAIR — the production contract.
 *
 * THE RULE THIS FILE ENCODES: a repair has not succeeded because it produced
 * another mesh. It succeeds when CAD Fixer's own validators, run against the
 * candidate, say the requested defects improved and nothing else regressed. The
 * repair algorithm never decides its own success — see `RepairValidation`.
 *
 * SCOPE IS DELIBERATELY NARROW. Only operations decidable from exact stored
 * coordinates are here. There is NO tolerance in this API — no epsilon, no weld
 * distance, no proximity threshold — because Stage 3A proved no single global
 * tolerance can be correct (the value that heals R19's crack destroys R21's
 * intentional gap). Tolerance belongs to a later assisted-repair stage where it
 * is explicit, previewable and user-chosen.
 *
 * NO GEOMETRY KERNEL. Nothing here links Manifold, Geogram, PMP or any WASM
 * artifact. The research programme qualified those for later roles; this stage
 * is what CAD Fixer can do conservatively on its own.
 */

export const REPAIR_PLAN_VERSION = 1;
export const REPAIR_VALIDATION_VERSION = 1;
export const REPAIR_RECORD_VERSION = 1;

/* ------------------------------------------------------------ operations -- */

/**
 * The conservative operations, named for the DEFECT they address.
 *
 * Repeated-position and zero-area degeneracy are separate entries on purpose.
 * They are different defects with different risks — one is a triangle with a
 * duplicated corner, the other three distinct but collinear corners — and
 * folding them into one counter would hide which was actually removed.
 */
export const RepairOperation = {
  /** Extra faces beyond the first, SAME cyclic orientation. Exact. */
  RemoveDuplicateFaces: 'remove-duplicate-faces',
  /** Faces with fewer than three distinct topological vertices. */
  RemoveRepeatedPositionFaces: 'remove-repeated-position-faces',
  /** Faces with three distinct vertices that are exactly collinear. */
  RemoveZeroAreaFaces: 'remove-zero-area-faces',
  /** Make adjacent faces traverse shared edges consistently. RELATIVE only. */
  UnifyWinding: 'unify-winding',
} as const;

export type RepairOperation = (typeof RepairOperation)[keyof typeof RepairOperation];

/**
 * The deterministic order in which selected operations run.
 *
 * Duplicates first: a duplicated face raises edge incidence to 4, which makes
 * the edge non-manifold and would block winding unification on geometry that is
 * actually fine once the duplicate is gone. Degeneracy next, because a
 * degenerate face contributes edges that distort the parity graph without
 * contributing surface. Winding last, so it solves over the surviving faces.
 *
 * `plan.order` states the order actually used; this constant is the source it
 * is derived from, not a second copy of the truth.
 */
export const REPAIR_PIPELINE_ORDER: readonly RepairOperation[] = [
  RepairOperation.RemoveDuplicateFaces,
  RepairOperation.RemoveRepeatedPositionFaces,
  RepairOperation.RemoveZeroAreaFaces,
  RepairOperation.UnifyWinding,
];

/* -------------------------------------------------------------- decisions -- */

/**
 * Why an operation will or will not run.
 *
 * NOT A BOOLEAN, deliberately. "false" cannot distinguish "there is nothing to
 * fix" from "we refuse because fixing it would break something else", and those
 * two must read differently to a user and to a test.
 */
export const RepairDecision = {
  /** Will run: the defect exists and preconditions hold. */
  Applicable: 'APPLICABLE',
  /** The defect is not present. Running would be a no-op. */
  NotNeeded: 'NOT_NEEDED',
  /** Running would violate a conservative safety invariant. */
  RefusedUnsafe: 'REFUSED_UNSAFE',
  /** Not implemented in this stage. */
  Unsupported: 'UNSUPPORTED',
  /** A precondition fails, e.g. non-manifold input for winding. */
  BlockedByPrecondition: 'BLOCKED_BY_PRECONDITION',
} as const;

export type RepairDecision = (typeof RepairDecision)[keyof typeof RepairDecision];

/** Machine-readable reasons. Never a free-text string as the only signal. */
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

export interface RepairOperationDecision {
  readonly operation: RepairOperation;
  readonly decision: RepairDecision;
  readonly reason: RepairReason;
  /** Defect instances this operation targets in the source, as counted by Stage 2. */
  readonly targetedCount: number;
  /**
   * Faces this operation expects to remove or flip.
   *
   * Distinct from `targetedCount`: three copies of one triangle are one
   * duplicate group but two removals.
   */
  readonly expectedFaceMutations: number;
  readonly note?: string;
}

/* ------------------------------------------------------------------ plan -- */

export interface RepairMemoryEstimate {
  /** Candidate canonical geometry, worst case (nothing removed). */
  readonly candidateBytes: number;
  /** Masks, parity state and compaction scratch. */
  readonly workspaceBytes: number;
  /** Topology analysis workspace for validating the candidate. */
  readonly validationBytes: number;
  /** Inverse patch, worst case for the planned removals and flips. */
  readonly inverseBytes: number;
  /**
   * Peak while the authoritative mesh and the candidate coexist.
   *
   * They DO coexist — that is the whole safety property — so the peak is not
   * the candidate's size, it is both plus scratch.
   */
  readonly peakBytes: number;
}

export interface ConservativeRepairPlan {
  readonly schemaVersion: typeof REPAIR_PLAN_VERSION;
  readonly modelId: string;
  readonly sourceRevision: number;
  /** Version of the topology report the plan was derived from. */
  readonly reportVersion: number;
  /** What the caller asked for. */
  readonly requested: readonly RepairOperation[];
  /** What the plan will actually run, in order. Never wider than `requested`. */
  readonly order: readonly RepairOperation[];
  readonly decisions: readonly RepairOperationDecision[];
  readonly memory: RepairMemoryEstimate;
  readonly warnings: readonly string[];
  /**
   * Deterministic identity of this plan.
   *
   * Commit names the plan it validated. A plan hash makes "commit the thing I
   * previewed" checkable rather than assumed — the same guard as a revision,
   * one level up.
   */
  readonly planHash: string;
  /** True when nothing is applicable: no candidate need be created. */
  readonly noOp: boolean;
}

/* ------------------------------------------------------------ validation -- */

export const RepairAcceptance = {
  Accepted: 'ACCEPTED',
  /** A forbidden regression appeared. The candidate must not commit. */
  RejectedRegression: 'REJECTED_REGRESSION',
  BlockedPrecondition: 'BLOCKED_PRECONDITION',
  ResourceLimit: 'RESOURCE_LIMIT',
  Cancelled: 'CANCELLED',
  InternalFailure: 'INTERNAL_FAILURE',
  /** Nothing to do. Not a failure, and not a licence to commit either. */
  NoOp: 'NO_OP',
} as const;

export type RepairAcceptance = (typeof RepairAcceptance)[keyof typeof RepairAcceptance];

/**
 * Regressions that disqualify a candidate outright.
 *
 * Not weighted against anything. A repair that fixes duplicates by opening a
 * hole has not produced a slightly worse mesh; it has produced a different
 * model than the user asked for.
 */
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

/**
 * Whether the volume comparison means anything.
 *
 * Winding unification legitimately changes ALGEBRAIC signed volume, because it
 * changes orientation. That is not damage, and the status says so rather than
 * letting a reader infer physical meaning from a sign flip.
 */
export const VolumeComparison = {
  Unchanged: 'unchanged',
  ChangedByOrientation: 'changed-by-orientation',
  ChangedUnexpectedly: 'changed-unexpectedly',
  NotInterpretable: 'not-interpretable',
} as const;

export type VolumeComparison = (typeof VolumeComparison)[keyof typeof VolumeComparison];

/**
 * How the bounding box changed, and whether removed geometry explains it.
 *
 * A removable zero-area outlier may legitimately have defined an extreme, so
 * bbox equality is NOT a hard gate. It is recorded, attributed, and warned
 * about — which is more useful than a rule that would refuse a correct repair.
 */
export const BoundsComparison = {
  Identical: 'identical',
  ChangedExplainedByRemovedFaces: 'changed-explained-by-removed-faces',
  ChangedUnexplained: 'changed-unexplained',
  NotComparable: 'not-comparable',
} as const;

export type BoundsComparison = (typeof BoundsComparison)[keyof typeof BoundsComparison];

export interface RepairDefectDeltas {
  readonly triangles: number;
  readonly topologicalVertices: number;
  readonly components: number;
  readonly boundaryEdges: number;
  readonly nonManifoldEdges: number;
  readonly nonManifoldVertices: number;
  readonly windingConflicts: number;
  readonly sameOrientationDuplicates: number;
  readonly reversedOrientationDuplicates: number;
  readonly repeatedPositionFaces: number;
  readonly zeroAreaFaces: number;
}

export interface RepairValidation {
  readonly schemaVersion: typeof REPAIR_VALIDATION_VERSION;
  readonly acceptance: RepairAcceptance;
  /** The stage that failed, when acceptance is not ACCEPTED. */
  readonly failedOperation?: RepairOperation;
  readonly requested: readonly RepairOperation[];
  readonly applied: readonly RepairOperation[];
  readonly before: TopologyReport;
  readonly after: TopologyReport;
  readonly deltas: RepairDefectDeltas;
  readonly structurallyValid: boolean;
  readonly surfaceAreaBefore: number;
  readonly surfaceAreaAfter: number;
  readonly volumeComparison: VolumeComparison;
  readonly signedVolumeBefore: number;
  readonly signedVolumeAfter: number;
  readonly boundsComparison: BoundsComparison;
  readonly boundsBefore: MeshBounds | undefined;
  readonly boundsAfter: MeshBounds | undefined;
  readonly regressions: readonly RepairRegression[];
  readonly warnings: readonly string[];
  /**
   * ALWAYS `not-checked` in this stage.
   *
   * Stage 3A-3B established that no independent self-intersection oracle
   * exists. Conservative repair does not create or resolve self-intersections,
   * and it must not imply it checked for them. See docs/repair/REPAIR_POLICY.md.
   */
  readonly selfIntersectionStatus: 'not-checked';
  /** Ties this validation to the plan it judged. Commit checks it. */
  readonly planHash: string;
}

/* -------------------------------------------------------------- outcomes -- */

/** Bounded, deterministic samples of what changed, for the future preview UI. */
export interface RepairChangeSamples {
  readonly removedDuplicateFaces: Uint32Array;
  readonly removedRepeatedPositionFaces: Uint32Array;
  readonly removedZeroAreaFaces: Uint32Array;
  readonly flippedFaces: Uint32Array;
  readonly truncated: boolean;
  readonly sampleLimit: number;
}

export interface RepairChangeCounts {
  readonly removedDuplicateFaces: number;
  readonly removedRepeatedPositionFaces: number;
  readonly removedZeroAreaFaces: number;
  readonly flippedFaces: number;
  readonly sourceFaceCount: number;
  readonly candidateFaceCount: number;
}

export const DEFAULT_CHANGE_SAMPLE_LIMIT = 256;
