import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { TopologyReport } from '@cadfixer/mesh-topology';

/**
 * KERNEL-NEUTRAL REPAIR EVALUATION CONTRACT — research only.
 *
 * This package is NOT part of the application. Nothing here is imported by
 * `apps/**` or by any worker, and a test asserts that. It exists so Stage 3A-2
 * can compile several geometry kernels and judge them against identical
 * geometry with identical rules, without any of them touching production code.
 *
 * WHY A SEPARATE PACKAGE. Putting these types in `mesh-core` would commit the
 * production mesh contract to a repair API before a single kernel has been
 * benchmarked — the exact premature commitment this stage exists to avoid. When
 * a repair API is finally chosen, it will be designed from the evidence and
 * promoted deliberately.
 *
 * THE RULE THIS FILE ENCODES: **a candidate does not decide whether it
 * succeeded.** A candidate reports what it did and what it believes; CAD Fixer
 * validates the output independently and decides. See `RepairOutcome` versus
 * `AcceptanceVerdict`.
 */

/* ------------------------------------------------------------- operations -- */

/**
 * Repair operations a candidate may support.
 *
 * Named for the DEFECT they address, not for a kernel's function name, so two
 * candidates implementing the same repair differently are still comparable.
 */
export const RepairOperation = {
  /** Remove duplicate faces beyond the first. Deterministic. */
  RemoveDuplicateFaces: 'remove-duplicate-faces',
  /** Remove faces with no usable area. Deterministic. */
  RemoveDegenerateFaces: 'remove-degenerate-faces',
  /** Make winding consistent across each component. Deterministic if orientable. */
  UnifyWinding: 'unify-winding',
  /** Flip components whose signed volume indicates inward-facing normals. */
  OrientOutward: 'orient-outward',
  /** Merge vertices within a tolerance. PARAMETER-DEPENDENT. */
  WeldWithinTolerance: 'weld-within-tolerance',
  /** Fill boundary loops. RECONSTRUCTIVE. Never applied to every loop by default. */
  FillBoundaryLoops: 'fill-boundary-loops',
  /** Split non-manifold edges and vertices into manifold pieces. RECONSTRUCTIVE. */
  ResolveNonManifold: 'resolve-non-manifold',
  /** Resolve self-intersections. RECONSTRUCTIVE. */
  ResolveSelfIntersections: 'resolve-self-intersections',
  /** Union overlapping shells into one solid. RECONSTRUCTIVE. */
  UnionShells: 'union-shells',
  /** Rebuild a printable solid, discarding the original surface. DESTRUCTIVE. */
  RebuildAsSolid: 'rebuild-as-solid',
} as const;

export type RepairOperation = (typeof RepairOperation)[keyof typeof RepairOperation];

/**
 * How much confidence an operation's result deserves.
 *
 * Mirrors `docs/repair/REPAIR_POLICY.md`. Carried in the contract so a
 * benchmark result cannot present a reconstruction as conservative cleanup.
 */
export const ConfidenceClass = {
  Deterministic: 'deterministic',
  ParameterDependent: 'parameter-dependent',
  Reconstructive: 'reconstructive',
  DestructiveFallback: 'destructive-fallback',
} as const;

export type ConfidenceClass = (typeof ConfidenceClass)[keyof typeof ConfidenceClass];

/**
 * Parameters an operation may take.
 *
 * TOLERANCE IS DELIBERATELY NOT A SINGLE NUMBER. STL states no unit, so an
 * absolute tolerance and a bounding-box-relative one are different models of
 * the same idea and we do not yet know which is right. The bakeoff tests both
 * separately rather than picking one now — see REPAIR_POLICY.md §4.
 */
export interface RepairParameters {
  /** Absolute distance, in the model's own unspecified unit. */
  readonly absoluteTolerance?: number;
  /** Fraction of the bounding-box diagonal. Scale-independent. */
  readonly relativeTolerance?: number;
  /** Which boundary loops to fill, by index. Absent means none — never "all". */
  readonly fillLoopIndices?: readonly number[];
  /** Candidate-specific knobs, recorded for reproducibility. */
  readonly extra?: Readonly<Record<string, number | string | boolean>>;
}

/* ----------------------------------------------------------- the candidate -- */

export const LicenceClass = {
  Permissive: 'permissive',
  CopyleftWeak: 'copyleft-weak',
  CopyleftStrong: 'copyleft-strong',
  Proprietary: 'proprietary',
  NonCommercial: 'non-commercial',
} as const;

export type LicenceClass = (typeof LicenceClass)[keyof typeof LicenceClass];

export const ThreadingMode = {
  Serial: 'serial',
  Threaded: 'threaded',
  Unknown: 'unknown',
} as const;

export type ThreadingMode = (typeof ThreadingMode)[keyof typeof ThreadingMode];

/**
 * Everything needed to reproduce a benchmark row.
 *
 * A result without this is an anecdote: "kernel X took 40 ms" means nothing
 * without the version, the build flags, and the threading mode.
 */
export interface CandidateMetadata {
  readonly candidateId: string;
  readonly displayName: string;
  /** Upstream tag or commit actually built. Not a range, not "latest". */
  readonly upstreamVersion: string;
  readonly licence: string;
  readonly licenceClass: LicenceClass;
  /** e.g. "emscripten 4.x, -O3, no threads, exceptions off". */
  readonly buildMode: string;
  /** Size of the shipped WASM artifact. Bundle cost is a product concern. */
  readonly wasmByteLength: number;
  readonly threading: ThreadingMode;
  readonly supportedOperations: readonly RepairOperation[];
  /**
   * Operations deliberately NOT supported.
   *
   * Stated explicitly rather than inferred from absence, so the results can
   * distinguish "cannot do this" from "we forgot to wire it up".
   */
  readonly unsupportedOperations: readonly RepairOperation[];
  /** Preconditions on input, e.g. "requires 2-manifold input". */
  readonly inputRequirements: readonly string[];
  readonly notes: readonly string[];
}

export const SelfIntersectionCapability = {
  None: 'none',
  DetectOnly: 'detect-only',
  EnumeratePairs: 'enumerate-pairs',
  Resolve: 'resolve',
} as const;

export type SelfIntersectionCapability =
  (typeof SelfIntersectionCapability)[keyof typeof SelfIntersectionCapability];

/**
 * What a candidate reports about itself after an operation.
 *
 * NOTE THE ABSENCE of a `success` field that anything downstream trusts.
 * `kernelReportedSuccess` is recorded as evidence about the kernel, never used
 * as the verdict — a kernel that returns `valid: true` for a mesh our topology
 * engine finds broken is telling us something important about the kernel.
 */
export interface RepairOutcome {
  readonly status: RepairStatus;
  /** The kernel's own opinion. Recorded, never trusted. */
  readonly kernelReportedSuccess: boolean;
  /** Free-form messages from the candidate. */
  readonly warnings: readonly string[];
  /** Absent when the operation produced no mesh. */
  readonly mesh: CanonicalMesh | undefined;
  readonly elapsedMs: number;
  /** Peak WASM heap during the operation, where the candidate can report it. */
  readonly peakWasmHeapBytes: number | undefined;
  /**
   * True when the output geometry was reconstructed rather than edited.
   *
   * Load-bearing for scoring: a candidate that "fixes" everything by rebuilding
   * the surface has not preserved the user's model, and geometry-preservation
   * scoring must know the difference.
   */
  readonly reconstructed: boolean;
}

export const RepairStatus = {
  Completed: 'completed',
  /** The candidate refused the input, e.g. a manifold precondition. */
  Refused: 'refused',
  Cancelled: 'cancelled',
  /** The candidate threw, trapped, or otherwise failed. */
  Failed: 'failed',
  /** The operation exceeded its time budget. */
  TimedOut: 'timed-out',
  /** The candidate does not implement this operation. */
  Unsupported: 'unsupported',
} as const;

export type RepairStatus = (typeof RepairStatus)[keyof typeof RepairStatus];

/* -------------------------------------------------- geometry-change metrics -- */

/**
 * Kernel-neutral measures of how much the model changed.
 *
 * All are cheap and exact except where noted. The expensive one — actual
 * surface distance — is deliberately deferred; see `plannedDistanceMetrics` in
 * the README of this package and REPAIR_ARCHITECTURE.md.
 */
export interface GeometryChange {
  readonly triangleDelta: number;
  readonly topologicalVertexDelta: number;
  readonly componentDelta: number;
  /** Largest change in any bounding-box coordinate. Catches gross displacement. */
  readonly boundingBoxDelta: number;
  readonly surfaceAreaDelta: number;
  /**
   * Change in algebraic signed volume.
   *
   * `undefined` when volume was not interpretable before or after — an open
   * surface has no enclosed volume, and reporting a delta between two
   * uninterpretable numbers would invent meaning.
   */
  readonly signedVolumeDelta: number | undefined;
}

/* ------------------------------------------------------------ the verdict -- */

/**
 * CAD Fixer's independent judgement, computed from validation — never from the
 * candidate's own claims.
 */
export interface AcceptanceVerdict {
  readonly accepted: boolean;
  /** Criteria that passed, by id, for auditability. */
  readonly satisfied: readonly string[];
  /** Criteria that failed, by id. */
  readonly violated: readonly string[];
  /** Forbidden outcomes triggered. Any one of these disqualifies the result. */
  readonly forbidden: readonly ForbiddenOutcome[];
}

/**
 * Failures that disqualify a result regardless of anything else.
 *
 * These are not weighted against other dimensions. A kernel that emits NaN has
 * not produced a slightly worse mesh; it has produced a mesh that cannot be
 * used, and no amount of speed compensates.
 */
export const ForbiddenOutcome = {
  NonFiniteCoordinate: 'non-finite-coordinate',
  UnexpectedlyEmpty: 'unexpectedly-empty',
  TriangleExplosion: 'triangle-explosion',
  IntroducedNewDefect: 'introduced-new-defect',
  CleanInputChanged: 'clean-input-changed',
  MergedDisjointShells: 'merged-disjoint-shells',
  FilledIntentionalOpening: 'filled-intentional-opening',
  RemovedThinFeature: 'removed-thin-feature',
  Crashed: 'crashed',
  OutputNotReimportable: 'output-not-reimportable',
  NonDeterministic: 'non-deterministic',
} as const;

export type ForbiddenOutcome = (typeof ForbiddenOutcome)[keyof typeof ForbiddenOutcome];

/**
 * One row of the bakeoff: candidate × fixture × operation × parameters.
 *
 * NO RAW GEOMETRY. Results are written to disk and read by people; embedding
 * meshes would make them unreadable and enormous, and would put user-shaped
 * data into a file that gets shared.
 */
export interface BakeoffRow {
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly fixtureId: string;
  readonly operation: RepairOperation;
  readonly confidence: ConfidenceClass;
  readonly parameters: RepairParameters;

  readonly status: RepairStatus;
  readonly kernelReportedSuccess: boolean;
  readonly warnings: readonly string[];

  /** Excludes candidate initialisation, which is reported separately. */
  readonly elapsedMs: number;
  readonly initialisationMs: number;
  readonly wasmByteLength: number;
  readonly peakWasmHeapBytes: number | undefined;

  readonly inputTriangles: number;
  readonly outputTriangles: number | undefined;

  /** Stage 2 report on the INPUT — the pre-condition oracle. */
  readonly preDiagnostics: TopologySummaryRow;
  /** Stage 2 report on the OUTPUT. Absent when no mesh was produced. */
  readonly postDiagnostics: TopologySummaryRow | undefined;
  readonly selfIntersection: SelfIntersectionCapability;

  readonly geometryChange: GeometryChange | undefined;
  readonly verdict: AcceptanceVerdict;

  /**
   * Stable summary of the output, for determinism comparison across runs.
   *
   * A hash of counts and rounded metrics rather than of coordinates: bitwise
   * coordinate equality is too strict a determinism test for a kernel that may
   * legitimately reorder its output, and too weak a summary to store raw.
   */
  readonly resultDigest: string;
}

/** The subset of a Stage 2 report worth writing into a results file. */
export interface TopologySummaryRow {
  readonly triangles: number;
  readonly topologicalVertices: number;
  readonly uniqueEdges: number;
  readonly components: number;
  readonly boundaryEdges: number;
  readonly simpleBoundaryLoops: number;
  readonly openBoundaryChains: number;
  readonly branchedBoundaries: number;
  readonly nonManifoldEdges: number;
  readonly nonManifoldVertices: number;
  readonly windingConflicts: number;
  readonly duplicateFaces: number;
  readonly reversedDuplicateFaces: number;
  readonly repeatedPositionFaces: number;
  readonly zeroAreaFaces: number;
  readonly isEdgeManifold: boolean;
  readonly isVertexManifold: boolean;
  readonly isWindingConsistent: boolean;
  readonly isBoundaryFree: boolean;
  readonly surfaceArea: number;
  readonly signedVolume: number;
}

/** Projects a full Stage 2 report into the row form written to results. */
export function summariseReport(report: TopologyReport): TopologySummaryRow {
  return {
    triangles: report.sourceFaceCount,
    topologicalVertices: report.topologicalVertexCount,
    uniqueEdges: report.uniqueEdgeCount,
    components: report.componentCount,
    boundaryEdges: report.boundaryEdgeCount,
    simpleBoundaryLoops: report.simpleBoundaryLoopCount,
    openBoundaryChains: report.openBoundaryChainCount,
    branchedBoundaries: report.branchedBoundaryCount,
    nonManifoldEdges: report.nonManifoldEdgeCount,
    nonManifoldVertices: report.nonManifoldVertexCount,
    windingConflicts: report.windingConflictEdgeCount,
    duplicateFaces: report.sameOrientationDuplicateCount,
    reversedDuplicateFaces: report.reversedOrientationDuplicateCount,
    repeatedPositionFaces: report.repeatedPositionFaceCount,
    zeroAreaFaces: report.zeroAreaFaceCount,
    isEdgeManifold: report.isEdgeManifold,
    isVertexManifold: report.isVertexManifold,
    isWindingConsistent: report.isWindingConsistent,
    isBoundaryFree: report.isBoundaryFree,
    surfaceArea: report.totalSurfaceArea,
    signedVolume: report.totalSignedVolume,
  };
}

/* ---------------------------------------------------------- the adapter -- */

/**
 * The experimental candidate interface.
 *
 * CAPABILITY-DISCOVERED, NOT FAKE-IMPLEMENTED. A candidate declares the
 * operations it supports; the harness asks for nothing else. Requiring every
 * candidate to expose a no-op for every operation would produce benchmark rows
 * that look like failures but are really absences, and the distinction is the
 * whole point of a role-based evaluation.
 */
export interface RepairKernelCandidate {
  readonly metadata: CandidateMetadata;
  /** Loads and instantiates the kernel. Timed separately from operations. */
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  /** What this candidate can say about self-intersection, if anything. */
  readonly selfIntersection: SelfIntersectionCapability;
  /**
   * Runs one repair. Implementations must not throw for an unsupported
   * operation; they return `Unsupported` so the harness can record it.
   */
  repair(
    mesh: CanonicalMesh,
    operation: RepairOperation,
    parameters: RepairParameters,
  ): Promise<RepairOutcome>;
}
