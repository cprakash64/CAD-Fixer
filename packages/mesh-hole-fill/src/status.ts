/**
 * THE FROZEN HOLE-FILL RESULT TAXONOMY.
 *
 * Every attempt ends in exactly one of these, and the set is exhaustive on
 * purpose: a caller that switches over it can be checked at compile time, and
 * the interface layer that will eventually word these (Stage 4B-1B2) cannot be
 * handed a state it has no sentence for.
 *
 * EXPECTED UNSUPPORTED GEOMETRY IS NOT AN INTERNAL ERROR. A non-planar loop, a
 * branched boundary, a bow-tie — these are things real files contain, and the
 * engine has a considered answer for each. `INTERNAL_FAILURE` means CAD Fixer
 * is broken, and nothing else may be routed there.
 *
 * A REFUSAL IS NON-DESTRUCTIVE. Every status except `VALID_CANDIDATE` means no
 * candidate exists, and in NO case has authoritative geometry been touched.
 */
export const HoleFillStatus = {
  /** A patch was built, independently validated, and may be previewed. */
  ValidCandidate: 'VALID_CANDIDATE',

  /** The boundary component is not one ordered, closed, simple cycle. */
  RefusedNotSimpleLoop: 'REFUSED_NOT_SIMPLE_LOOP',
  /** A non-manifold edge touches this boundary; the rim has no single side. */
  RefusedNonManifoldBoundary: 'REFUSED_NON_MANIFOLD_BOUNDARY',
  /** Faces around the rim disagree about winding. Never repaired here. */
  RefusedAmbiguousOrientation: 'REFUSED_AMBIGUOUS_ORIENTATION',
  /** The loop failed the relative planarity policy. */
  RefusedNonPlanar: 'REFUSED_NON_PLANAR',
  /** Collinear, zero-area, zero-extent, or fewer than three distinct vertices. */
  RefusedDegenerateBoundary: 'REFUSED_DEGENERATE_BOUNDARY',
  /** More boundary vertices than the production ceiling allows. */
  RefusedBoundarySize: 'REFUSED_BOUNDARY_SIZE',
  /** The part has more faces than the production ceiling allows. */
  RefusedPartSize: 'REFUSED_PART_SIZE',

  /** Ear clipping could not find a valid ear. Nothing is emitted. */
  NoEarFound: 'NO_EAR_FOUND',

  /** A patch face participates in an invalid intersection. THE HARD GATE. */
  SelfIntersectionCreated: 'SELF_INTERSECTION_CREATED',
  /** The candidate introduced non-manifold structure the source did not have. */
  NonManifoldCreated: 'NON_MANIFOLD_CREATED',
  /** A patch face has zero area, or duplicates another face. */
  DegeneratePatch: 'DEGENERATE_PATCH',

  /** A broadphase, narrowphase or allocation ceiling fired. */
  ResourceLimit: 'RESOURCE_LIMIT',
  /** A post-fill check other than the specific ones above failed. */
  ValidationFailed: 'VALIDATION_FAILED',

  /** The caller cancelled. Not a defect and never a failure. */
  Cancelled: 'CANCELLED',
  /** The document moved on while the candidate was being built. */
  StaleRevision: 'STALE_REVISION',
  /** No boundary component of this part carries the requested id. */
  UnknownLoop: 'UNKNOWN_LOOP',

  /** A defect in CAD Fixer itself. Nothing expected is routed here. */
  InternalFailure: 'INTERNAL_FAILURE',
} as const;

export type HoleFillStatus = (typeof HoleFillStatus)[keyof typeof HoleFillStatus];

/** True when the status means a validated candidate exists. */
export function isValidCandidate(status: HoleFillStatus): boolean {
  return status === HoleFillStatus.ValidCandidate;
}

/**
 * True when the status is a considered decision about unsupported geometry
 * rather than a failure.
 *
 * The distinction is not cosmetic: a refusal is rendered as a decision with a
 * reason, and a failure is rendered as something going wrong. Putting a
 * non-planar hole in the second category would tell a user their file is broken
 * when it is merely outside this operation's proven scope.
 */
export function isRefusal(status: HoleFillStatus): boolean {
  return (
    status === HoleFillStatus.RefusedNotSimpleLoop ||
    status === HoleFillStatus.RefusedNonManifoldBoundary ||
    status === HoleFillStatus.RefusedAmbiguousOrientation ||
    status === HoleFillStatus.RefusedNonPlanar ||
    status === HoleFillStatus.RefusedDegenerateBoundary ||
    status === HoleFillStatus.RefusedBoundarySize ||
    status === HoleFillStatus.RefusedPartSize ||
    status === HoleFillStatus.NoEarFound
  );
}
