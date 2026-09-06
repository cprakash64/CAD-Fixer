import {
  BoundaryLoopRefusal,
  HOLE_FILL_MAX_BOUNDARY_VERTICES,
  HOLE_FILL_MAX_PART_FACES,
  HoleFillStatus,
} from '@cadfixer/geometry-runtime';

/**
 * How the hole-fill workflow is worded for a user.
 *
 * ALL OF IT, IN ONE FILE, exactly as `repair-presentation.ts` and
 * `conversion-presentation.ts` hold all of theirs. A sentence written inline in
 * a component is a bug in this product: two screens drift, and a status the
 * engine can produce reaches one of them and not the other. Every switch below
 * is exhaustive with NO `default`, on purpose — a new engine status then fails
 * to compile until somebody has written its sentence.
 *
 * FRAMEWORK-FREE, so wording is tested without a DOM. In this product wording is
 * a correctness concern: the difference between "refused" and "failed", between
 * "preview" and "applied", and between "this opening is closed" and "this model
 * is watertight", are all differences between a claim the engine supports and
 * one it does not.
 *
 * THE FIVE RULES THIS FILE ENFORCES:
 *
 *   1. A REFUSAL IS NOT AN ERROR. A non-planar rim, a branched boundary, a
 *      512-vertex ceiling — these are things real files contain, and the engine
 *      has a considered answer for each. They are decisions with reasons, never
 *      failures, and never "your model is broken".
 *   2. AN OPENING IS NOT A DEFECT. A boundary loop may be exactly what the user
 *      modelled: an open tube, a vase, a shell. Nothing here calls one a hole,
 *      a flaw, damage or an error.
 *   3. A PREVIEW IS NOT AN APPLICATION. Nothing here describes a candidate as
 *      having changed the model.
 *   4. ONE FILLED OPENING IS NOT A REPAIRED MODEL. `Filled` means ONE named
 *      opening was closed and validated against the part it came from. Not
 *      watertight, not printable, not free of other openings, not free of
 *      pre-existing crossings.
 *   5. NO ENGINE INTERNALS. A user is never shown a broadphase ceiling, a
 *      narrowphase, a Euler characteristic, a kernel name or a raw status enum.
 */

/**
 * Terms that must never appear in hole-fill interface text.
 *
 * Enforced by test against every string this module can produce. The first group
 * is inherited from topology and repair presentation for the same reasons; the
 * rest are the claims a fill screen is specifically tempted to make, because
 * closing an opening LOOKS like fixing a model.
 */
export const HOLE_FILL_FORBIDDEN_TERMS: readonly string[] = [
  'printable', // needs self-intersection and thickness, neither established here
  'watertight', // implies a verified closed solid; one loop says nothing about the rest
  'valid mesh', // structural validity is a different, narrower claim
  'error free', // nothing here can establish that
  'fully repaired', // one opening was closed
  'ready to print', // the strongest unearned claim of all
  'all errors fixed',
  'model repaired', // a fill is not a repair of the model
  'model fixed',
  'damaged', // an opening is not damage
  'broken surface',
  'critical hole',
  'hole fixed', // the model is unchanged until Apply, and "fixed" overclaims after it
];

/* --------------------------------------------------------------- workflow -- */

/**
 * The section's name.
 *
 * "Open boundaries", not "Holes" and certainly not "Defects". A boundary loop is
 * a fact about the surface; whether it is a mistake is the user's judgement, not
 * CAD Fixer's. The verb the user presses is "Fill", which is what the operation
 * does — but the NOUN it operates on stays neutral.
 */
export const HOLE_FILL_SECTION_TITLE = 'Open boundaries';

export const HOLE_FILL_SECTION_SUMMARY =
  'Each open boundary is a rim where the surface stops. Some are intentional — an open tube, a ' +
  'shell, a vase — and CAD Fixer never closes one unless you choose it.';

/**
 * What automatic filling can and cannot attempt, stated on screen.
 *
 * The user needs to know whether CAD Fixer LOOKED at their opening and refused,
 * or never looked at all. A limits list that lives only in a document answers
 * neither question at the moment it is asked.
 */
export const HOLE_FILL_LIMITS: readonly string[] = Object.freeze([
  'One opening at a time. There is no fill-all, and openings are never closed automatically.',
  `Flat openings only. The rim must lie in a plane; a rim that curves out of one is left alone.`,
  `Up to ${HOLE_FILL_MAX_BOUNDARY_VERTICES.toLocaleString()} rim points, on a part of up to ${HOLE_FILL_MAX_PART_FACES.toLocaleString()} triangles.`,
  'The new surface adds no points and moves none of yours. Every existing triangle is left exactly as it was.',
  'Filling one opening says nothing about the rest of the model, and nothing about whether it can be printed.',
]);

/* --------------------------------------------------------------- listing -- */

/** The label a row carries. The identity used for the operation is never shown. */
export function describeOpening(displayIndex: number): string {
  return `Opening ${displayIndex.toLocaleString()}`;
}

/** How big the rim is, in the only unit that is meaningful without a document unit. */
export function describeOpeningSize(vertexCount: number): string {
  return vertexCount === 1 ? '1 rim point' : `${vertexCount.toLocaleString()} rim points`;
}

/**
 * The one-line availability verdict for a row.
 *
 * "CAN BE ATTEMPTED", NOT "CAN BE FILLED", AND THE DISTINCTION IS LOAD-BEARING.
 *
 * Listing a part's openings is a TOPOLOGICAL question and it is answered
 * exactly: is this boundary component one ordered, closed, simple, manifold
 * cycle? Whether it is FLAT ENOUGH is a geometric question the qualified engine
 * answers, and the engine is the only thing that answers it — the interface
 * cannot, because the planarity policy lives in the fill engine and that engine
 * deliberately does not run in the geometry worker or on the page.
 *
 * So a row that says "can be filled automatically" would be a promise the
 * listing has no way to keep: a perfectly simple rim that curves out of its own
 * plane is eligible here and refused a moment later, and the user would
 * reasonably read that as CAD Fixer breaking its word. Saying what is actually
 * known — that this opening is one CAD Fixer will attempt — is the honest form,
 * and the sentence beneath says what remains to be checked.
 *
 * Deliberately not a colour either: a user who cannot distinguish the row tints
 * still reads which openings CAD Fixer will attempt.
 */
export const OPENING_ELIGIBLE = 'CAD Fixer can attempt this opening';
export const OPENING_INELIGIBLE = 'Automatic fill unavailable for this opening';

/**
 * What is still unknown about an opening the interface has called eligible.
 *
 * Shown beside the Preview action, so the possibility of a refusal is stated
 * BEFORE the button is pressed rather than explained afterwards.
 */
export const OPENING_ELIGIBLE_DETAIL =
  'Its rim is a single closed loop. Whether it is flat enough to close, and whether the new ' +
  'surface would cross the model, are checked when the fill runs.';

/**
 * Why an opening cannot be filled automatically, in plain language.
 *
 * EVERY SENTENCE SAYS WHAT CAD FIXER FOUND AND WHAT IT DECIDED, and none of them
 * says the model is wrong. A branched boundary is a real thing to model; it is
 * simply not something a single flat patch can close.
 *
 * NOTE THE ABSENT `default`. If `mesh-topology` gains a refusal, this stops
 * compiling — which is the point. A refusal with no sentence would reach a user
 * as an empty explanation beside a disabled button.
 */
export function describeBoundaryRefusal(refusal: BoundaryLoopRefusal): string {
  switch (refusal) {
    case BoundaryLoopRefusal.BranchedBoundary:
    case BoundaryLoopRefusal.ConvergentBoundary:
      return 'This rim splits into more than one path, so there is no single opening to close. CAD Fixer will not choose one for you.';
    case BoundaryLoopRefusal.NotClosed:
      return 'This rim does not come back to where it started, so it does not enclose an opening.';
    case BoundaryLoopRefusal.RepeatedVertex:
      return 'This rim passes through the same point twice, so it encloses more than one region and there is no single opening to close.';
    case BoundaryLoopRefusal.TooFewVertices:
      return 'This rim has fewer than three distinct points, so there is no area to close.';
    case BoundaryLoopRefusal.TooManyVertices:
      return `This rim has more than ${HOLE_FILL_MAX_BOUNDARY_VERTICES.toLocaleString()} points, which is beyond what CAD Fixer's automatic fill is proven to handle.`;
    case BoundaryLoopRefusal.DegenerateSegment:
      return 'Part of this rim has zero length, so its shape cannot be determined.';
    case BoundaryLoopRefusal.NonFinite:
      return 'A coordinate on this rim is not a usable number, so its shape cannot be determined.';
    case BoundaryLoopRefusal.NonManifoldAdjacency:
      return 'More than two surfaces meet along this rim, so there is no single side for a new surface to join. CAD Fixer will not guess which one you meant.';
    case BoundaryLoopRefusal.AmbiguousOrientation:
      return 'The surfaces around this rim disagree about which way they face, so a new surface has no side to match. Conservative repair can often resolve this first.';
  }
}

/* ------------------------------------------------------------- generation -- */

/**
 * What the fill is doing, as a phase name.
 *
 * NAMES, NOT PERCENTAGES. The operation reports when it has started and when it
 * has finished; the phases between are not instrumented as a fraction. A
 * progress bar filling smoothly to 90% and stopping would be a fabricated
 * measurement, so the interface shows an indeterminate indicator and says which
 * stage it is in.
 */
export const HoleFillPhase = {
  Preparing: 'Preparing',
  Building: 'Building the new surface',
  Validating: 'Checking the result',
} as const;

export type HoleFillPhase = (typeof HoleFillPhase)[keyof typeof HoleFillPhase];

export const HOLE_FILL_PREVIEW_ACTION = 'Preview fill';
export const HOLE_FILL_APPLY_ACTION = 'Apply fill';
export const HOLE_FILL_DISCARD_ACTION = 'Discard preview';
export const HOLE_FILL_CANCEL_ACTION = 'Cancel';
export const HOLE_FILL_UNDO_ACTION = 'Undo fill';

/** Shown the instant a validated candidate exists. NOT a claim about the model. */
export const HOLE_FILL_PREVIEW_READY = 'Fill preview ready';

export const HOLE_FILL_PREVIEW_NOT_APPLIED =
  'Nothing has changed yet. Your model is exactly as it was until you choose Apply fill.';

/**
 * The strongest sentence allowed after a successful Apply.
 *
 * ONE OPENING, VALIDATED AGAINST ONE PART. Everything a fill does NOT establish
 * is said immediately afterwards, in `HOLE_FILL_APPLIED_QUALIFIER`, because a
 * success message on its own is exactly where an unearned claim would slip in.
 */
export const HOLE_FILL_APPLIED_HEADLINE = 'Selected opening filled and validated';

export const HOLE_FILL_APPLIED_QUALIFIER =
  'The new surface was checked against this part and did not cross it. Other openings, other ' +
  'parts, wall thickness and whether the model can be printed were not examined.';

export const HOLE_FILL_UNDONE =
  'The fill was undone. This part has been restored to exactly the triangles it had before.';

export const HOLE_FILL_DISCARDED =
  'Fill preview discarded. Your model is unchanged, and you can preview this opening again.';

export const HOLE_FILL_CANCELLED =
  'Fill cancelled. Your model is unchanged, and you can try this opening again.';

/* ----------------------------------------------------------------- status -- */

/**
 * How an outcome should be presented: as a decision, or as something going
 * wrong.
 *
 * THIS DISTINCTION IS NOT COSMETIC. A refusal gets its own quiet register and
 * says what CAD Fixer decided; a failure says something went wrong. Putting a
 * non-planar rim in the second category would tell a user their file is broken
 * when it is merely outside this operation's proven scope — and would invite
 * them to go looking for a defect that is not there.
 */
export const HoleFillTone = {
  /** A considered decision about geometry outside the proven scope. */
  Refusal: 'refusal',
  /** The patch was built but did not survive validation. Also a decision. */
  Rejected: 'rejected',
  /** A ceiling fired. The model is intact and the advice is different. */
  ResourceLimit: 'resource-limit',
  /** The document moved on. Nothing is wrong; the preview is simply out of date. */
  Stale: 'stale',
  /** Something in CAD Fixer went wrong. */
  Failure: 'failure',
  /** The user cancelled. Never a failure. */
  Cancelled: 'cancelled',
  /** A validated candidate exists. */
  Ready: 'ready',
} as const;

export type HoleFillTone = (typeof HoleFillTone)[keyof typeof HoleFillTone];

export interface PresentedHoleFillStatus {
  readonly tone: HoleFillTone;
  readonly headline: string;
  readonly detail: string;
  /** Whether trying the same opening again could plausibly produce a result. */
  readonly retryable: boolean;
}

/**
 * Every terminal engine status, worded.
 *
 * NO `default`, and no raw code ever reaches this function's output. A user is
 * told what happened and what they can do; `REFUSED_NON_PLANAR` is a developer
 * diagnostic and stays one.
 */
export function presentHoleFillStatus(status: HoleFillStatus): PresentedHoleFillStatus {
  switch (status) {
    case HoleFillStatus.ValidCandidate:
      return {
        tone: HoleFillTone.Ready,
        headline: HOLE_FILL_PREVIEW_READY,
        detail: HOLE_FILL_PREVIEW_NOT_APPLIED,
        retryable: false,
      };

    /* ------------------------------------------------------- refusals -- */

    case HoleFillStatus.RefusedNonPlanar:
      return {
        tone: HoleFillTone.Refusal,
        headline: 'This opening is not flat enough to fill automatically',
        detail:
          'Its rim curves out of a plane, and CAD Fixer only fills flat openings. Closing a ' +
          'curved rim needs a shaped surface, which this version does not build.',
        retryable: false,
      };
    case HoleFillStatus.RefusedNotSimpleLoop:
      return {
        tone: HoleFillTone.Refusal,
        headline: 'This rim is not a single closed loop',
        detail:
          'It branches, or does not return to where it started, so there is no single opening ' +
          'to close. CAD Fixer will not choose one of the possibilities for you.',
        retryable: false,
      };
    case HoleFillStatus.RefusedNonManifoldBoundary:
      return {
        tone: HoleFillTone.Refusal,
        headline: 'The surrounding surface is ambiguous',
        detail:
          'More than two surfaces meet along this rim, so a new surface has no single side to ' +
          'join. CAD Fixer will not guess which one you meant.',
        retryable: false,
      };
    case HoleFillStatus.RefusedAmbiguousOrientation:
      return {
        tone: HoleFillTone.Refusal,
        headline: 'The surfaces around this opening disagree about which way they face',
        detail:
          'A new surface has no consistent side to match. Conservative repair can often make ' +
          'neighbouring triangles agree first, after which this opening may become fillable.',
        retryable: false,
      };
    case HoleFillStatus.RefusedDegenerateBoundary:
      return {
        tone: HoleFillTone.Refusal,
        headline: 'This opening has no area to close',
        detail:
          'Its rim points are in a straight line, or too few of them are distinct, so there is ' +
          'no region for a new surface to cover.',
        retryable: false,
      };
    case HoleFillStatus.RefusedBoundarySize:
      return {
        tone: HoleFillTone.Refusal,
        headline: 'This opening is too complex for the automatic fill',
        detail: `Its rim has more than ${HOLE_FILL_MAX_BOUNDARY_VERTICES.toLocaleString()} points, which is beyond what CAD Fixer's automatic fill is proven to handle.`,
        retryable: false,
      };
    case HoleFillStatus.RefusedPartSize:
      return {
        tone: HoleFillTone.Refusal,
        headline: 'This part is too large for the automatic fill',
        detail: `Automatic filling runs on parts of up to ${HOLE_FILL_MAX_PART_FACES.toLocaleString()} triangles, so that it stays responsive in a browser. This part is above that.`,
        retryable: false,
      };
    case HoleFillStatus.NoEarFound:
      return {
        tone: HoleFillTone.Refusal,
        headline: 'CAD Fixer could not build a surface for this opening',
        detail:
          'The rim shape did not yield a valid set of triangles. Nothing was changed, and no ' +
          'partial surface was kept.',
        retryable: false,
      };

    /* ------------------------------------------- validation rejections -- */

    case HoleFillStatus.SelfIntersectionCreated:
      return {
        tone: HoleFillTone.Rejected,
        headline: 'The new surface would pass through this part',
        detail:
          'CAD Fixer built a surface for this opening, checked it against the part, and found ' +
          'that it would cross the model. It was discarded rather than applied.',
        retryable: false,
      };
    case HoleFillStatus.NonManifoldCreated:
      return {
        tone: HoleFillTone.Rejected,
        headline: 'The new surface would not join the model cleanly',
        detail:
          'Adding it would leave edges where more than two surfaces meet, which this part did ' +
          'not have before. It was discarded rather than applied.',
        retryable: false,
      };
    case HoleFillStatus.DegeneratePatch:
      return {
        tone: HoleFillTone.Rejected,
        headline: 'The new surface contained unusable triangles',
        detail:
          'Some of the triangles CAD Fixer built had no area, or repeated one another. The ' +
          'result was discarded rather than applied.',
        retryable: false,
      };
    case HoleFillStatus.ValidationFailed:
      return {
        tone: HoleFillTone.Rejected,
        headline: 'The new surface did not pass checking',
        detail:
          'CAD Fixer built a surface for this opening and then found a problem with it, so it ' +
          'was discarded. Your model was not changed.',
        retryable: false,
      };

    /* ------------------------------------------------------ conditions -- */

    case HoleFillStatus.ResourceLimit:
      return {
        tone: HoleFillTone.ResourceLimit,
        headline: 'This opening is within the supported shape, but this model is too large',
        detail:
          'Filling it would need more work than CAD Fixer will do in a browser tab without ' +
          'risking the page. Your model was not changed.',
        retryable: false,
      };
    case HoleFillStatus.StaleRevision:
      return {
        tone: HoleFillTone.Stale,
        headline: 'The model changed while this fill was being prepared',
        detail: 'Nothing was applied. Choose the opening again to prepare a fresh preview.',
        retryable: true,
      };
    case HoleFillStatus.UnknownLoop:
      return {
        tone: HoleFillTone.Stale,
        headline: 'That opening is no longer in this part',
        detail: 'The list of open boundaries has been refreshed. Choose an opening again.',
        retryable: true,
      };
    case HoleFillStatus.Cancelled:
      return {
        tone: HoleFillTone.Cancelled,
        headline: 'Fill cancelled',
        detail: HOLE_FILL_CANCELLED,
        retryable: true,
      };
    case HoleFillStatus.InternalFailure:
      return {
        tone: HoleFillTone.Failure,
        headline: 'CAD Fixer could not complete this fill',
        detail:
          'Something went wrong inside CAD Fixer. Your model was not changed. Trying again is ' +
          'safe; if it keeps happening, this opening cannot be filled in this version.',
        retryable: true,
      };
  }
}

/* ------------------------------------------------------------- resources -- */

/** Stated BEFORE anything runs, from the part's own triangle count. */
export function describePartSizeRefusal(partFaceCount: number): string {
  return (
    `This part has ${partFaceCount.toLocaleString()} triangles. Automatic filling runs on parts ` +
    `of up to ${HOLE_FILL_MAX_PART_FACES.toLocaleString()}, so that it stays responsive in a ` +
    `browser. Everything else CAD Fixer does is unaffected.`
  );
}

/**
 * How a capped listing is disclosed.
 *
 * THE COUNT IS EXACT AND THE LIST IS NOT. A model of loose triangles has one
 * boundary component per triangle; showing twenty thousand rows would freeze the
 * page, and showing twenty thousand as "256 openings" would be a lie. So the
 * number is the truth and the list says it is a subset.
 */
export function describeTruncatedInventory(shown: number, total: number): string {
  return (
    `Showing the first ${shown.toLocaleString()} of ${total.toLocaleString()} open boundaries. ` +
    `The rest are not listed; CAD Fixer fills one opening at a time and never all of them.`
  );
}

/** The whole-part count, whether or not the list was capped. */
export function describeOpeningCount(total: number): string {
  if (total === 0) return 'No open boundaries were found in this part.';
  if (total === 1) return 'This part has 1 open boundary.';
  return `This part has ${total.toLocaleString()} open boundaries.`;
}

/**
 * What was applied, for the status log.
 *
 * ONE OPENING, NAMED BY ITS DISPLAY POSITION, and the qualifier travels with it.
 * A success line that stopped at "filled" would be the exact place an unearned
 * claim about the whole model would take hold.
 */
export function describeApplied(displayIndex: number, patchFaceCount: number): string {
  const triangles =
    patchFaceCount === 1 ? '1 new triangle' : `${patchFaceCount.toLocaleString()} new triangles`;
  return `${describeOpening(displayIndex)} filled with ${triangles}. ${HOLE_FILL_APPLIED_QUALIFIER}`;
}
