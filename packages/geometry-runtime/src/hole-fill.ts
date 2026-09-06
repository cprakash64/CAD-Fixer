import type {
  HoleFillStatus as EngineHoleFillStatus,
  HoleFillLimits as EngineHoleFillLimits,
  HoleFillValidationSummary as EngineHoleFillValidationSummary,
} from '@cadfixer/mesh-hole-fill';
import type { BoundaryLoopRefusal as EngineBoundaryLoopRefusal } from '@cadfixer/mesh-topology';

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
 * Why a boundary component is not one ordered, fillable cycle.
 *
 * RESTATED FOR THE SAME REASON THE STATUSES ARE. The interface has to give each
 * of these a sentence BEFORE any operation runs — a refused opening is listed
 * and explained without a worker ever being built — and importing the value from
 * `@cadfixer/mesh-topology` would put the whole topology engine in the
 * main-thread bundle to compare nine strings.
 *
 * TYPED RATHER THAN `string`, so the wording layer's switch over it stays
 * exhaustive: a refusal the engine can produce and the interface has no sentence
 * for then fails to compile, instead of reaching a user as a blank explanation.
 */
export const BoundaryLoopRefusal = {
  BranchedBoundary: 'BRANCHED_BOUNDARY',
  ConvergentBoundary: 'CONVERGENT_BOUNDARY',
  NotClosed: 'NOT_CLOSED',
  RepeatedVertex: 'REPEATED_VERTEX',
  TooFewVertices: 'TOO_FEW_VERTICES',
  TooManyVertices: 'TOO_MANY_VERTICES',
  DegenerateSegment: 'DEGENERATE_SEGMENT',
  NonFinite: 'NON_FINITE',
  NonManifoldAdjacency: 'NON_MANIFOLD_ADJACENCY',
  AmbiguousOrientation: 'AMBIGUOUS_ORIENTATION',
} as const;

export type BoundaryLoopRefusal = (typeof BoundaryLoopRefusal)[keyof typeof BoundaryLoopRefusal];

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
const _refusalMatches: Exactly<BoundaryLoopRefusal, EngineBoundaryLoopRefusal> = true;

export const HOLE_FILL_CONTRACT_CHECKED = [_statusMatches, _refusalMatches] as const;
