/**
 * DETERMINISTIC RESOURCE CAPS.
 *
 * WORK COUNTS, NOT A CLOCK. The same mesh must reach the same verdict on a fast
 * machine and a slow one; a wall-clock cap would make the reported status a
 * property of the hardware. A watchdog, if one is ever added, is a SECONDARY
 * backstop and never replaces these.
 *
 * Values are carried over unchanged from the Stage 3C-1A-R1 qualification
 * (ADR 0012 and docs/self-intersection/qualification.json). They were exercised
 * against the SI corpus, the regenerated Stage 3A R16-R18 fixtures, and a
 * pathological mesh where every bounding box overlaps.
 */

/**
 * Candidate pairs the broadphase may enumerate.
 *
 * Distinct from the tested cap on purpose: broadphase work and narrowphase work
 * have different costs, and a mesh can generate enormous numbers of candidates
 * while testing very few of them. Collapsing the two would hide which limit
 * actually fired.
 */
export const MAX_CANDIDATE_PAIRS = 40_000_000;

/** Pairs handed to the exact narrowphase. At ~4-6 microseconds each, this bounds the scan. */
export const MAX_TESTED_PAIRS = 20_000_000;

/**
 * Retained sample pairs.
 *
 * Bounds MEMORY ONLY. Aggregate counts keep rising after the cap, so a
 * truncated sample list never becomes a smaller intersection count.
 */
export const MAX_SAMPLES = 4_096;

/** Uint32 values per retained sample: face, face, category index. */
export const SAMPLE_STRIDE = 3;

export interface SelfIntersectionLimits {
  readonly maxCandidatePairs: number;
  readonly maxTestedPairs: number;
  readonly maxSamples: number;
}

export const DEFAULT_SELF_INTERSECTION_LIMITS: SelfIntersectionLimits = Object.freeze({
  maxCandidatePairs: MAX_CANDIDATE_PAIRS,
  maxTestedPairs: MAX_TESTED_PAIRS,
  maxSamples: MAX_SAMPLES,
});

/**
 * Narrows the defaults. A caller may only make the diagnostic MORE cautious.
 *
 * The same rule the repair memory ceiling follows: a message that could widen a
 * resource limit would let a caller talk the application out of its own safety
 * margin, so every field is clamped to the default rather than replacing it.
 */
export function narrowLimits(
  requested: Partial<SelfIntersectionLimits> | undefined,
): SelfIntersectionLimits {
  if (requested === undefined) return DEFAULT_SELF_INTERSECTION_LIMITS;
  const clamp = (value: number | undefined, ceiling: number): number =>
    value === undefined || !Number.isFinite(value) || value <= 0
      ? ceiling
      : Math.min(Math.floor(value), ceiling);
  return Object.freeze({
    maxCandidatePairs: clamp(requested.maxCandidatePairs, MAX_CANDIDATE_PAIRS),
    maxTestedPairs: clamp(requested.maxTestedPairs, MAX_TESTED_PAIRS),
    maxSamples: clamp(requested.maxSamples, MAX_SAMPLES),
  });
}
