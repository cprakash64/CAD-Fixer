/**
 * DETERMINISTIC PRODUCTION CEILINGS FOR HOLE FILLING.
 *
 * WORK COUNTS, NEVER A CLOCK, for the same reason the self-intersection
 * diagnostic uses work counts: the same part and the same loop must reach the
 * same verdict on a fast machine and a slow one. A wall-clock cap would make
 * the answer a property of the hardware.
 *
 * THE CEILINGS BELONG TO THE VALIDATOR, not to the triangulator. Stage 4B-1A
 * measured the split and it is not close — a 512-vertex loop cost 10 ms to fill
 * and 293 ms to validate, and a 40,338-face part with a four-vertex loop cost
 * 0.02 ms to fill and 503 ms to validate. Capping the kernel would be capping
 * the cheap half.
 *
 * Every value here is recorded in `docs/adr/0018-hole-filling-qualification.md`
 * together with the measurement it came from.
 */

/**
 * The boundary-vertex ceiling.
 *
 * MEASURED, NOT GUESSED. `npm run bench:hole-fill` runs the whole production
 * path — extraction, planarity, triangulation, topology, broadphase and the
 * exact Geogram narrowphase — on a bare tube, median of three after a warm-up:
 *
 *       8 vertices      2.3 ms       106 candidate pairs
 *      32 vertices      6.6 ms     1,404
 *     128 vertices     58.4 ms    20,988
 *     256 vertices    227.3 ms    82,940
 *     384 vertices    515.8 ms   185,852
 *     511 vertices    882.9 ms   328,183
 *     512 vertices    897.1 ms   329,724
 *
 * The growth is quadratic and lives almost entirely in validation: at 512 the
 * broadphase and the narrowphase are 883 ms and 884 ms of a 897 ms total, while
 * ear clipping is 0.42 ms. Doubling to 1,024 would therefore cost roughly three
 * and a half seconds for the SAME hole — which is the shape of the curve, not
 * an accident of one machine.
 *
 * WHY 512 RATHER THAN THE "LOW HUNDREDS" ADR 0018 SUGGESTED. That figure came
 * from the research validator's PAIRWISE scan, which exhausted a 1.7 GB heap
 * and had no spatial index; the ADR explicitly deferred the number until one
 * existed. With the broadphase in place the cost at 512 is under a second, and
 * the operation is an explicit, cancellable user action in a disposable worker
 * — a band the self-intersection diagnostic already extends to ~9.4 s. The
 * worst in-policy combination measured, a 512-vertex boundary on a
 * 248,000-face part, is 2.18 s.
 *
 * It is a PRODUCT DECISION about acceptable waiting on one reference device,
 * not a hardware-independent guarantee, and it is expected to move. What must
 * not move quietly is the refusal: a loop above it is refused BEFORE
 * triangulation, so an oversized boundary costs the walk and nothing more.
 */
export const HOLE_FILL_MAX_BOUNDARY_VERTICES = 512;

/**
 * The part-size ceiling, in faces.
 *
 * INHERITED FROM STAGE 3C DELIBERATELY, AND ONLY BECAUSE THE EVIDENCE AGREES.
 * ADR 0018 says the 250,000-face band may be adopted "only once the intersection
 * check uses a spatial index" — which it now does. Measured with a four-vertex
 * hole, so the number is the part's cost and not the boundary's:
 *
 *      10,000 faces     28.3 ms      20 candidate pairs
 *      50,000 faces    169.6 ms      20
 *     100,000 faces    378.4 ms      20
 *     200,000 faces    927.8 ms      20
 *     249,000 faces  1,285.6 ms      20
 *
 * TWENTY CANDIDATE PAIRS AT EVERY SIZE. That is the spatial index doing its
 * job: the intersection check costs what the patch's NEIGHBOURHOOD costs, not
 * what the model costs. What does still grow is topology validation — 1,085 ms
 * of the 1,286 ms at 249,000 faces — because the candidate's boundary loops are
 * re-extracted over the whole part, which is unavoidable if the postconditions
 * are to be checked on the whole part.
 *
 * The number is the same as `SELF_INTERSECTION_MAX_FACES`, and that is not
 * laziness: the exact narrowphase behind both is the same Geogram kernel, and a
 * part CAD Fixer will not check for self-intersection is a part it cannot honestly
 * validate a patch inside either.
 */
export const HOLE_FILL_MAX_PART_FACES = 250_000;

/**
 * Patch faces a successful fill may produce.
 *
 * DERIVED, NOT CHOSEN. Ear clipping adds no vertices, so an n-vertex boundary
 * always yields exactly `n - 2` triangles. A separate patch ceiling would be a
 * second number that could disagree with the first, and the only way it could
 * ever fire is if the triangulator broke — which is a validation failure, not a
 * resource limit.
 */
export function patchFaceCountFor(boundaryVertexCount: number): number {
  return boundaryVertexCount - 2;
}

/** The patch-face ceiling implied by the boundary ceiling. */
export const HOLE_FILL_MAX_PATCH_FACES = patchFaceCountFor(HOLE_FILL_MAX_BOUNDARY_VERTICES);

export interface HoleFillLimits {
  readonly maxBoundaryVertices: number;
  readonly maxPartFaces: number;
  /** Bounding-box overlap tests the broadphase may perform. */
  readonly maxAabbTests: number;
  /** Hierarchy nodes the broadphase may visit. */
  readonly maxBvhNodeVisits: number;
  /** Candidate pairs the broadphase may emit. Streamed, never accumulated. */
  readonly maxBroadphaseCandidates: number;
  /** Pairs handed to the exact narrowphase. */
  readonly maxNarrowphasePairs: number;
  /** Retained sample pairs. Bounds MEMORY ONLY; counts keep rising past it. */
  readonly maxSamples: number;
}

/**
 * Broadphase and narrowphase ceilings.
 *
 * SMALLER THAN THE DIAGNOSTIC'S BY TWO ORDERS OF MAGNITUDE, and deliberately.
 * `MAX_CANDIDATE_PAIRS` is 40,000,000 there because that scan asks about a
 * WHOLE mesh. This one asks only whether a patch of at most 510 triangles hits
 * anything, so a candidate count in the millions does not mean a big model — it
 * means a pathological one, and answering "I could not check this affordably"
 * is better than spending a minute to say the same thing.
 */
export const MAX_AABB_TESTS = 40_000_000;
export const MAX_BVH_NODE_VISITS = 20_000_000;
export const MAX_BROADPHASE_CANDIDATES = 4_000_000;
export const MAX_NARROWPHASE_PAIRS = 2_000_000;
export const MAX_SAMPLES = 64;

export const DEFAULT_HOLE_FILL_LIMITS: HoleFillLimits = Object.freeze({
  maxBoundaryVertices: HOLE_FILL_MAX_BOUNDARY_VERTICES,
  maxPartFaces: HOLE_FILL_MAX_PART_FACES,
  maxAabbTests: MAX_AABB_TESTS,
  maxBvhNodeVisits: MAX_BVH_NODE_VISITS,
  maxBroadphaseCandidates: MAX_BROADPHASE_CANDIDATES,
  maxNarrowphasePairs: MAX_NARROWPHASE_PAIRS,
  maxSamples: MAX_SAMPLES,
});

/**
 * Narrows the defaults. A caller may only make the engine MORE cautious.
 *
 * The rule the repair memory ceiling and the diagnostic caps both follow: a
 * message that could WIDEN a resource limit would let a caller talk CAD Fixer
 * out of its own safety margin, so every field is clamped to the default rather
 * than replacing it.
 */
export function narrowHoleFillLimits(
  requested: Partial<HoleFillLimits> | undefined,
): HoleFillLimits {
  if (requested === undefined) return DEFAULT_HOLE_FILL_LIMITS;
  const clamp = (value: number | undefined, ceiling: number): number =>
    value === undefined || !Number.isFinite(value) || value <= 0
      ? ceiling
      : Math.min(Math.floor(value), ceiling);
  return Object.freeze({
    maxBoundaryVertices: clamp(requested.maxBoundaryVertices, HOLE_FILL_MAX_BOUNDARY_VERTICES),
    maxPartFaces: clamp(requested.maxPartFaces, HOLE_FILL_MAX_PART_FACES),
    maxAabbTests: clamp(requested.maxAabbTests, MAX_AABB_TESTS),
    maxBvhNodeVisits: clamp(requested.maxBvhNodeVisits, MAX_BVH_NODE_VISITS),
    maxBroadphaseCandidates: clamp(requested.maxBroadphaseCandidates, MAX_BROADPHASE_CANDIDATES),
    maxNarrowphasePairs: clamp(requested.maxNarrowphasePairs, MAX_NARROWPHASE_PAIRS),
    maxSamples: clamp(requested.maxSamples, MAX_SAMPLES),
  });
}
