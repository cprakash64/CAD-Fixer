/**
 * SIZE POLICY FOR THE SELF-INTERSECTION DIAGNOSTIC.
 *
 * WHY A POLICY EXISTS AT ALL. The diagnostic is exact and therefore expensive:
 * Stage 3C-1A-R1 measured ~4-6 microseconds per candidate pair, dominated by
 * Geogram's `triangles_intersections` itself, and proved the cost is not
 * prefilterable — two mathematically sound prefilters were implemented,
 * measured and rejected. So the product cannot make it fast. What it CAN do is
 * be honest about when it will run, and never pretend a model was checked when
 * it was not.
 *
 * MEASURED, NOT GUESSED. Median of three runs on a conforming surface, native,
 * recorded in ADR 0012:
 *
 *     20,000 faces    0.70 s
 *     49,928 faces    1.79 s
 *    100,352 faces    3.55 s
 *    199,712 faces    7.50 s
 *    500,000 faces   17.5 s
 *    999,698 faces   34.8 s
 *
 * FACE COUNT, NEVER FILE BYTES. The same geometry has wildly different byte
 * counts as STL, OBJ or 3MF — binary STL alone spends 50 bytes per triangle
 * regardless of how many vertices are shared. A policy keyed on file size would
 * move when the container changed while the geometry did not.
 *
 * CONSERVATIVE REFERENCE-DEVICE POLICY. These thresholds come from one machine.
 * They are an MVP product decision about acceptable waiting, not a
 * hardware-independent performance guarantee, and they are expected to move.
 */

/**
 * Upper bound of the band that is checked AUTOMATICALLY.
 *
 * ~0.9 s at the boundary. Short enough to run unprompted after a model becomes
 * usable without the application feeling like it stalled.
 */
export const AUTO_ELIGIBLE_MAX_FACES = 25_000;

/**
 * The production face ceiling: above this, the diagnostic does not run at all.
 *
 * ~9.4 s at the boundary; 17.5 s at 500k and 34.8 s at 1M, and far worse on an
 * adversarial mesh. Enforced as a PREFLIGHT gate rather than a runtime one,
 * because at a million faces the broadphase allocated ~272 MiB BEFORE any pair
 * cap could fire — rejecting after allocating is not rejecting.
 */
export const SELF_INTERSECTION_MAX_FACES = 250_000;

/** What the size policy permits for a given model. */
export const SelfIntersectionBand = {
  /** Small enough to check automatically. */
  AutoEligible: 'AUTO_ELIGIBLE',
  /** Supported, but long enough that the user must ask for it. */
  ExplicitCheck: 'EXPLICIT_CHECK',
  /** Above the production ceiling. Not started at all. */
  SizeLimit: 'SIZE_LIMIT',
} as const;

export type SelfIntersectionBand = (typeof SelfIntersectionBand)[keyof typeof SelfIntersectionBand];

/**
 * Classifies a model by face count.
 *
 * Total over every non-negative integer, including zero: an empty model is
 * trivially auto-eligible, and answering "which band" with `undefined` would
 * push a decision the caller cannot make any better.
 */
export function bandForFaceCount(faceCount: number): SelfIntersectionBand {
  if (faceCount > SELF_INTERSECTION_MAX_FACES) return SelfIntersectionBand.SizeLimit;
  if (faceCount > AUTO_ELIGIBLE_MAX_FACES) return SelfIntersectionBand.ExplicitCheck;
  return SelfIntersectionBand.AutoEligible;
}

/** True when a model of this size may be checked at all. */
export function isCheckable(faceCount: number): boolean {
  return bandForFaceCount(faceCount) !== SelfIntersectionBand.SizeLimit;
}

/** True when a model of this size should be checked without being asked. */
export function isAutoEligible(faceCount: number): boolean {
  return bandForFaceCount(faceCount) === SelfIntersectionBand.AutoEligible;
}
