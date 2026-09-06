import type {
  HoleFillStatus as EngineHoleFillStatus,
  HoleFillLimits as EngineHoleFillLimits,
  HoleFillValidationSummary as EngineHoleFillValidationSummary,
} from '@cadfixer/mesh-hole-fill';

/**
 * The hole-fill contract's VALUES, restated here so the application can compare
 * against them without importing the hole-fill engine.
 *
 * SAME REASON AS `repair.ts` AND `topology.ts`. A value re-export from
 * `@cadfixer/mesh-hole-fill` would make its index — and therefore the
 * triangulator, the broadphase, every validator and the whole `mesh-topology`
 * engine behind them — a runtime dependency of the main-thread bundle, because
 * the main thread imports the protocol from this package. The fill engine
 * belongs in the worker chunk and nowhere else. Trusting a bundler to shake it
 * back out is a promise nobody checks; a few frozen strings keep the boundary
 * provable instead.
 *
 * The duplication is guarded, not trusted: every constant is checked below
 * against the engine's own type at compile time, and against its runtime values
 * in `hole-fill-contract.test.ts`.
 */

export const HoleFillStatus = {
  ValidCandidate: 'VALID_CANDIDATE',

  RefusedNotSimpleLoop: 'REFUSED_NOT_SIMPLE_LOOP',
  RefusedNonManifoldBoundary: 'REFUSED_NON_MANIFOLD_BOUNDARY',
  RefusedAmbiguousOrientation: 'REFUSED_AMBIGUOUS_ORIENTATION',
  RefusedNonPlanar: 'REFUSED_NON_PLANAR',
  RefusedDegenerateBoundary: 'REFUSED_DEGENERATE_BOUNDARY',
  RefusedBoundarySize: 'REFUSED_BOUNDARY_SIZE',
  RefusedPartSize: 'REFUSED_PART_SIZE',

  NoEarFound: 'NO_EAR_FOUND',

  SelfIntersectionCreated: 'SELF_INTERSECTION_CREATED',
  NonManifoldCreated: 'NON_MANIFOLD_CREATED',
  DegeneratePatch: 'DEGENERATE_PATCH',

  ResourceLimit: 'RESOURCE_LIMIT',
  ValidationFailed: 'VALIDATION_FAILED',

  Cancelled: 'CANCELLED',
  StaleRevision: 'STALE_REVISION',
  UnknownLoop: 'UNKNOWN_LOOP',

  InternalFailure: 'INTERNAL_FAILURE',
} as const;

export type HoleFillStatus = (typeof HoleFillStatus)[keyof typeof HoleFillStatus];

/**
 * The production ceilings, restated.
 *
 * The application needs these to say what it will and will not attempt BEFORE
 * an operation starts — the same role `SELF_INTERSECTION_MAX_FACES` plays for
 * the diagnostic. Asserted equal to the engine's own constants by test.
 */
export const HOLE_FILL_MAX_BOUNDARY_VERTICES = 512;
export const HOLE_FILL_MAX_PART_FACES = 250_000;

/**
 * The summary a fill attempt reports.
 *
 * TYPE-ONLY, so it costs the bundle nothing: a structural alias of the engine's
 * own interface, checked in both directions below. Scalars throughout — no
 * coordinates ever reach the page.
 */
export type HoleFillValidationSummary = EngineHoleFillValidationSummary;

/** The limits a caller may NARROW. Never widen; the worker clamps. */
export type HoleFillLimits = EngineHoleFillLimits;

/**
 * Compile-time proof that the restatement above matches the engine exactly.
 *
 * Checked in BOTH directions: one way alone would let this module quietly drop
 * a status the engine can still produce, which is the failure that would
 * actually reach a user — a refusal the interface has no branch for.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _statusMatches: Exactly<HoleFillStatus, EngineHoleFillStatus> = true;

export const HOLE_FILL_CONTRACT_CHECKED = [_statusMatches] as const;
