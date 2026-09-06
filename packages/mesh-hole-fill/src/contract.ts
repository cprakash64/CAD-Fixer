import type { HoleFillStatus } from './status';

/**
 * THE HOLE-FILL ENGINE CONTRACT.
 *
 * Everything that crosses a boundary is here, and everything here is a SCALAR
 * or a small bounded typed array. No coordinates, no pair lists, no
 * `CanonicalMesh`. A candidate's geometry never appears in a result: the engine
 * returns it separately to the code that owns geometry, and what travels
 * outward is a summary a panel could render without holding a model.
 */

/**
 * Bounded, machine-readable evidence about one attempt.
 *
 * NUMBERS, NOT SENTENCES. Stage 4B-1B2 decides the wording; a second copy of
 * that copy in here would drift, exactly as the repair and conversion
 * presentation modules were written to avoid.
 */
export interface HoleFillValidationSummary {
  readonly boundaryVertexCount: number;
  readonly sourceFaceCount: number;
  readonly patchFaceCount: number;
  readonly addedVertexCount: number;

  readonly boundaryLoopsBefore: number;
  readonly boundaryLoopsAfter: number;
  /** True when the loop that was targeted is gone from the candidate. */
  readonly selectedLoopRemoved: boolean;

  readonly degeneratePatchFaces: number;
  readonly duplicatePatchFaces: number;
  /** Patch corners referencing a source vertex outside the filled loop. */
  readonly foreignPatchCorners: number;
  /** Patch half-edges opposing the source face that owns their rim edge. */
  readonly opposingBoundaryEdges: number;
  /** Patch half-edges AGREEING with a source face: a reversed attachment. */
  readonly agreeingBoundaryEdges: number;

  readonly invalidPatchSourcePairs: number;
  readonly invalidPatchPatchPairs: number;

  readonly broadphaseCandidates: number;
  readonly broadphaseAabbTests: number;
  readonly broadphaseNodeVisits: number;
  readonly narrowphaseChecks: number;
  /** Pairs the exact narrowphase could not classify. Any is a failure. */
  readonly narrowphaseRefusals: number;

  /** Relative planarity actually measured, against `RELATIVE_PLANARITY`. */
  readonly planarityRatio: number;
  /** The dropped projection axis: 0 = x, 1 = y, 2 = z. */
  readonly projectionAxis: number;

  readonly eulerApplicable: boolean;
  readonly eulerBefore: number;
  readonly eulerAfter: number;
  readonly eulerPassed: boolean;

  readonly totalDurationMs: number;
  readonly phaseMilliseconds: HoleFillPhaseTimings;
}

export interface HoleFillPhaseTimings {
  readonly loopResolution: number;
  readonly eligibility: number;
  readonly planarity: number;
  readonly triangulation: number;
  readonly candidateAssembly: number;
  readonly structuralValidation: number;
  readonly topologyValidation: number;
  readonly broadphase: number;
  readonly narrowphase: number;
}

/**
 * What a caller must state to fill one hole.
 *
 * THE CALLER SUPPLIES NO GEOMETRY. Not vertex coordinates, not triangle
 * indices, not a boundary vertex array — only identifiers. The authoritative
 * worker resolves the loop from `document + revision + part + boundaryLoopId`,
 * so a request cannot smuggle in a boundary the model does not have.
 */
export interface HoleFillRequest {
  readonly operationId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly partId: string;
  readonly boundaryLoopId: string;
}

/** The identity a result must still match before it may be published. */
export type HoleFillOperationIdentity = HoleFillRequest;

export interface HoleFillOutcome {
  readonly status: HoleFillStatus;
  readonly identity: HoleFillOperationIdentity;
  readonly summary: HoleFillValidationSummary;
  /**
   * Bounded sample pairs, flattened as (faceA, faceB, category).
   *
   * DIAGNOSTIC ONLY, and capped hard. Aggregate counts keep rising past the
   * cap, so a truncated sample list can never become a smaller intersection
   * count — the same rule the self-intersection report follows.
   */
  readonly intersectionSamples: Uint32Array;
  readonly samplesTruncated: boolean;
}

/* --------------------------------------------------------- narrowphase -- */

/**
 * The exact triangle/triangle predicate, INJECTED rather than imported.
 *
 * WHY INJECTED. The production predicate is the Geogram WASM kernel, which must
 * stay confined to the disposable workers that load it — a package-level import
 * would put 1.2 MB of WebAssembly in front of every user who never fills a
 * hole. Injection also keeps this package kernel-free, which is what lets the
 * production boundary scan assert the confinement.
 *
 * WHY NOT A LOCAL IMPLEMENTATION. Stage 4B-1A's separating-axis checker was
 * research: it exists to be a SECOND opinion, not the only one. Classification
 * of a legitimate shared edge, an overlap beyond a shared edge, a coplanar area
 * overlap and a non-adjacent touch is exactly what Stage 3C qualified, and
 * re-deriving it here would mean shipping a weaker predicate beside a stronger
 * one and hoping they agreed.
 */
export interface NarrowphaseGeometry {
  /** One Float64 XYZ triple per TOPOLOGICAL vertex. */
  readonly positions: Float64Array;
  /** Three topological vertex ids per face. */
  readonly triangles: Uint32Array;
  /** Faces at or above this index were manufactured by this operation. */
  readonly patchFaceStart: number;
  readonly maxSamples: number;
}

export interface NarrowphaseBatchResult {
  /** False when any pair could not be classified. Never absorbed into a pass. */
  readonly complete: boolean;
  readonly testedPairs: number;
  readonly skippedPairs: number;
  readonly unclassifiedPairs: number;
  readonly invalidPatchSourcePairs: number;
  readonly invalidPatchPatchPairs: number;
}

export interface NarrowphaseSamples {
  /** Flattened (faceA, faceB, category) triples. */
  readonly samples: Uint32Array;
  readonly truncated: boolean;
}

/**
 * A batched exact narrowphase.
 *
 * `begin` uploads geometry once; `classify` is called repeatedly with a REUSED
 * fixed-size pair buffer, so no caller ever holds the full candidate product.
 * `end` releases whatever `begin` allocated, and must run even when a batch
 * failed.
 */
export interface PatchNarrowphase {
  begin(geometry: NarrowphaseGeometry): void;
  /** Classifies `pairCount` flattened (faceA, faceB) entries from `pairs`. */
  classify(pairs: Uint32Array, pairCount: number): NarrowphaseBatchResult;
  samples(): NarrowphaseSamples;
  end(): void;
}
