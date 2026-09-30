/**
 * AUTOMATIC BOUNDARY FILLING OVER THE WIRE — REPAIR-CORE-02.
 *
 * Repair model may close eligible simple planar openings as part of ONE
 * combined candidate. These are the scalars and bounded lists that describe
 * that — to the page, which holds no geometry — and nothing else.
 *
 * RESTATED, NOT RE-EXPORTED. The verdict taxonomy is defined by
 * `@cadfixer/mesh-hole-fill`; re-exporting it would make the engine a runtime
 * dependency of the main-thread bundle, exactly as `repair.ts` explains for the
 * repair constants. `boundary-fill-contract.test.ts` keeps the two equal.
 */

export const BoundaryFillVerdict = {
  Admitted: 'ADMITTED',
  NotSimple: 'NOT_SIMPLE',
  NonManifoldBoundary: 'NON_MANIFOLD_BOUNDARY',
  AmbiguousOrientation: 'AMBIGUOUS_ORIENTATION',
  DegenerateBoundary: 'DEGENERATE_BOUNDARY',
  TooManyVertices: 'TOO_MANY_VERTICES',
  NonPlanar: 'NON_PLANAR',
  NoTriangulation: 'NO_TRIANGULATION',
  DegeneratePatch: 'DEGENERATE_PATCH',
  EdgeAlreadyExists: 'EDGE_ALREADY_EXISTS',
  DuplicatesExistingFace: 'DUPLICATES_EXISTING_FACE',
  InteractsWithAnotherOpening: 'INTERACTS_WITH_ANOTHER_OPENING',
  BatchLimit: 'BATCH_LIMIT',
  AmbiguousIdentity: 'AMBIGUOUS_IDENTITY',
  WouldIntersect: 'WOULD_INTERSECT',
  NotVerifiable: 'NOT_VERIFIABLE',
  RegionTooLarge: 'REGION_TOO_LARGE',
  /** Set in a candidate's outcome: the loop was closed and validated. */
  Filled: 'FILLED',
} as const;

export type BoundaryFillVerdict = (typeof BoundaryFillVerdict)[keyof typeof BoundaryFillVerdict];

export const BoundaryFillScanStatus = {
  /** Filling was not asked for. Nothing was scanned. */
  NotRequested: 'NOT_REQUESTED',
  Scanned: 'SCANNED',
  /** More boundary edges than the scan assembles. The count is exact. */
  TooManyBoundaryEdges: 'TOO_MANY_BOUNDARY_EDGES',
} as const;

export type BoundaryFillScanStatus =
  (typeof BoundaryFillScanStatus)[keyof typeof BoundaryFillScanStatus];

export interface BoundaryFillLoopSummary {
  /** Geometric identity (`bx-…`). Never an index. */
  readonly id: string;
  readonly vertexCount: number;
  readonly verdict: BoundaryFillVerdict;
}

/**
 * Openings one repair may close — the engine's `maxLoopsPerCandidate`, restated
 * so the page can state the limit without importing the engine.
 */
export const BOUNDARY_FILL_MAX_OPENINGS_PER_REPAIR = 64;

/** Rows of a loop list that cross the wire. The counts are never capped. */
export const BOUNDARY_FILL_LOOP_LIST_LIMIT = 256;

/**
 * What automatic filling WOULD attempt at this revision, decided in the worker.
 *
 * `admittedCount` loops passed every check that can be made without the exact
 * intersection test; the preview runs that test and may refuse some of them.
 */
export interface BoundaryFillPlan {
  readonly status: BoundaryFillScanStatus;
  readonly boundaryEdgeCount: number;
  readonly simpleLoopCount: number;
  readonly complexBoundaryCount: number;
  readonly admittedCount: number;
  readonly admittedPatchFaces: number;
  readonly loops: readonly BoundaryFillLoopSummary[];
  readonly loopsTruncated: boolean;
  /**
   * TRUE ONLY WHEN EVERY ADMITTED OPENING HAS PASSED THE EXACT CHECK — REPAIR-RC-03.
   * Admission alone is topology and planarity; the exact intersection check
   * refused four of the six simple openings on the model that motivated
   * REPAIR-CORE-02, all of them backed by existing faces. So `admittedCount`
   * is a promise ("N openings can be filled") ONLY when this is true; an
   * unverified count is never presented as fillable. Vacuously true when
   * nothing is admitted.
   */
  readonly verified: boolean;
  /** Binds a candidate request to the admitted set the user saw. */
  readonly planHash: string;
}

export const BoundaryFillOutcomeStatus = {
  /** Nothing was attempted: not requested, or nothing admitted. */
  None: 'NONE',
  /** At least one opening was closed and the combined candidate validated. */
  Filled: 'FILLED',
  /** Every admitted opening was refused by the exact check or the budget. */
  NothingPassed: 'NOTHING_PASSED',
  /** The independent re-analysis disagreed with the prediction; nothing filled. */
  Rejected: 'REJECTED',
} as const;

export type BoundaryFillOutcomeStatus =
  (typeof BoundaryFillOutcomeStatus)[keyof typeof BoundaryFillOutcomeStatus];

/** What a candidate's fill stage actually did. */
export interface BoundaryFillOutcome {
  readonly status: BoundaryFillOutcomeStatus;
  readonly filledCount: number;
  readonly patchFaceCount: number;
  /** Final verdict for every loop of the mesh the fill stage scanned. */
  readonly loops: readonly BoundaryFillLoopSummary[];
  readonly loopsTruncated: boolean;
  /** Regression codes from the independent re-analysis, when `Rejected`. */
  readonly regressions: readonly string[];
}

/** An empty plan: filling not requested or nothing to report. */
/**
 * HOW MANY OPENINGS A PLAN MAY PROMISE TO FILL — REPAIR-RC-03. The one reading
 * of a plan the interface uses: an unverified admitted count is not a promise,
 * so it is zero here, and every "N openings can be filled" is derived from it.
 */
export function fillableOpeningCount(plan: BoundaryFillPlan | undefined): number {
  return plan?.verified === true ? plan.admittedCount : 0;
}

export const NO_BOUNDARY_FILL_PLAN: BoundaryFillPlan = Object.freeze({
  status: BoundaryFillScanStatus.NotRequested,
  boundaryEdgeCount: 0,
  simpleLoopCount: 0,
  complexBoundaryCount: 0,
  admittedCount: 0,
  admittedPatchFaces: 0,
  loops: [],
  loopsTruncated: false,
  verified: true,
  planHash: 'none',
});
