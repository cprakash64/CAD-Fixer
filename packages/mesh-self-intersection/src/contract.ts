/**
 * THE PRODUCTION SELF-INTERSECTION CONTRACT.
 *
 * Stage 2 answered this question with the single value `not-checked`, which was
 * truthful but carried no information. This replaces it with a model that can
 * distinguish the six genuinely different things that can happen — and, most
 * importantly, can distinguish "we looked and found nothing" from the five
 * outcomes that merely LOOK like it.
 *
 * THE ONE RULE EVERYTHING HERE EXISTS TO ENFORCE: only a complete check with
 * zero findings may be rendered as "no self-intersections found". A check that
 * was capped, cancelled, skipped, refused or never started has a zero
 * intersection count too, and every one of those zeros means something else.
 */

/** Cause of the intersection, decided from Geogram's SYMBOLIC result. */
export const SelfIntersectionCategory = {
  /** Two triangle interiors cross in 3D. */
  ProperCrossing: 'PROPER_CROSSING',
  /** Coplanar triangles overlapping over non-zero area. */
  CoplanarOverlap: 'COPLANAR_OVERLAP',
  /** Topologically unrelated faces meeting at exactly one point. */
  NonAdjacentPointTouch: 'NON_ADJACENT_POINT_TOUCH',
  /** Topologically unrelated faces meeting along a segment. */
  NonAdjacentEdgeTouch: 'NON_ADJACENT_EDGE_TOUCH',
  /** Neighbours meeting in MORE than the edge or vertex they legitimately share. */
  AdjacentOverlapBeyondShared: 'ADJACENT_OVERLAP_BEYOND_SHARED',
  /**
   * The same triangle twice, in either winding.
   *
   * Reported for provenance and NEVER counted as a self-intersection: Stage 2
   * already reports duplicates as their own defect, and counting them here
   * would report one problem twice under two names.
   */
  DuplicateTopologyDefect: 'DUPLICATE_TOPOLOGY_DEFECT',
} as const;

export type SelfIntersectionCategory =
  (typeof SelfIntersectionCategory)[keyof typeof SelfIntersectionCategory];

/**
 * How a diagnostic ENDED. Terminal only — see `SelfIntersectionPhase` for the
 * states a check passes through while it is alive.
 */
export const SelfIntersectionStatus = {
  /** Every face examined, nothing skipped, no cap fired. The only complete answer. */
  Checked: 'CHECKED',
  /** It ran, but something was skipped, so the counts are a LOWER BOUND. */
  Partial: 'PARTIAL',
  /** It started and a deterministic work or memory cap stopped it. Lower bound. */
  ResourceLimit: 'RESOURCE_LIMIT',
  /** The user stopped it. No verdict at all. */
  Cancelled: 'CANCELLED',
  /** The diagnostic worker failed. No verdict at all. */
  InternalFailure: 'INTERNAL_FAILURE',
  /**
   * It never started, because the model exceeds the production face ceiling.
   *
   * DELIBERATELY DISTINCT FROM `RESOURCE_LIMIT`. That one means "we looked and
   * ran out"; this one means "we did not look". Collapsing them would let the
   * interface imply an examination that never happened.
   */
  NotRunSizePolicy: 'NOT_RUN_SIZE_POLICY',
} as const;

export type SelfIntersectionStatus =
  (typeof SelfIntersectionStatus)[keyof typeof SelfIntersectionStatus];

/**
 * Where a check is in its life. Separate from `SelfIntersectionStatus` on
 * purpose: overloading a terminal verdict to also mean "running" or "never
 * asked" is exactly how an interface ends up claiming a result it does not have.
 */
export const SelfIntersectionPhase = {
  /** Never invoked. For an EXPLICIT_CHECK model this is the resting state. */
  Idle: 'IDLE',
  /** Queued, worker not yet started. */
  Scheduled: 'SCHEDULED',
  /** The diagnostic worker is doing the work. */
  Running: 'RUNNING',
  /** Cancel requested; the worker is being torn down. */
  Cancelling: 'CANCELLING',
  /** A terminal `SelfIntersectionReport` exists. */
  Complete: 'COMPLETE',
} as const;

export type SelfIntersectionPhase =
  (typeof SelfIntersectionPhase)[keyof typeof SelfIntersectionPhase];

/** Per-category counts. Every category is always present, including zeros. */
export interface SelfIntersectionCategoryCounts {
  readonly properCrossing: number;
  readonly coplanarOverlap: number;
  readonly nonAdjacentPointTouch: number;
  readonly nonAdjacentEdgeTouch: number;
  readonly adjacentOverlapBeyondShared: number;
  /** Provenance only. Not part of `intersectingPairCount`. */
  readonly duplicateTopologyDefect: number;
  /** Conforming neighbour pairs confirmed to share only what they should. */
  readonly legitimateShared: number;
}

/** Which kernel produced a report, so a stale result can be identified later. */
export interface SelfIntersectionEngine {
  readonly name: string;
  readonly version: string;
  readonly commit: string;
}

export interface SelfIntersectionReport {
  readonly schemaVersion: number;
  readonly status: SelfIntersectionStatus;

  readonly modelId: string;
  readonly modelRevision: number;

  readonly faceCount: number;

  /**
   * Pairs that intersect. EXCLUDES duplicates by construction.
   *
   * A lower bound whenever `status` is not `CHECKED`.
   */
  readonly intersectingPairCount: number;
  /** Distinct faces appearing in at least one intersecting pair. */
  readonly affectedFaceCount: number;

  readonly categories: SelfIntersectionCategoryCounts;

  /** Faces the narrowphase cannot accept. Non-zero forces `PARTIAL`. */
  readonly skippedDegenerateFaceCount: number;
  /** Pairs not tested because a face was skipped. */
  readonly skippedPairCount: number;
  /**
   * Pairs the kernel refused to classify by throwing.
   *
   * Geogram's symbolic buffer is a fixed 20 entries with an always-on
   * assertion. Non-zero forces `PARTIAL`.
   */
  readonly unclassifiedPairCount: number;

  /**
   * Work counters.
   *
   * NUMBERS, NOT UINT32. At the 250,000-face ceiling a fully-overlapping mesh
   * reaches ~3.1e10 candidate pairs, which silently wraps a Uint32. JavaScript
   * numbers hold every integer to 2^53 exactly, and the worker widens these to
   * double before they cross the boundary.
   */
  readonly candidatePairCount: number;
  readonly testedPairCount: number;

  /** Bounded face-id pairs. Flattened `[f1, f2, categoryIndex, ...]`. */
  readonly samples: Uint32Array;
  readonly samplePairCount: number;
  readonly samplesTruncated: boolean;

  readonly engine: SelfIntersectionEngine;
}

/**
 * Whether this report may be rendered as "no self-intersections found".
 *
 * THE SINGLE GATE, expressed once so no call site can reinvent it more
 * leniently. Every other status has a zero intersection count too.
 */
export function isCompleteCleanResult(report: SelfIntersectionReport): boolean {
  return report.status === SelfIntersectionStatus.Checked && report.intersectingPairCount === 0;
}

/** Whether findings exist. True even when the check was incomplete. */
export function hasFindings(report: SelfIntersectionReport): boolean {
  return report.intersectingPairCount > 0;
}

/**
 * Whether the report describes an examination that did not finish.
 *
 * `CANCELLED`, `INTERNAL_FAILURE` and `NOT_RUN_SIZE_POLICY` are NOT incomplete
 * examinations — they are absent ones, and the interface says something
 * different about each.
 */
export function isIncompleteExamination(report: SelfIntersectionReport): boolean {
  return (
    report.status === SelfIntersectionStatus.Partial ||
    report.status === SelfIntersectionStatus.ResourceLimit
  );
}
