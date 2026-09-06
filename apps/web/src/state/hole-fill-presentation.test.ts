import { describe, expect, it } from 'vitest';
import { BoundaryLoopRefusal, HoleFillStatus } from '@cadfixer/geometry-runtime';
import { REPAIR_FORBIDDEN_TERMS } from './repair-presentation';
import { FORBIDDEN_TERMS } from './topology-presentation';
import {
  HOLE_FILL_APPLIED_HEADLINE,
  HOLE_FILL_APPLIED_QUALIFIER,
  HOLE_FILL_CANCELLED,
  HOLE_FILL_DISCARDED,
  HOLE_FILL_FORBIDDEN_TERMS,
  HOLE_FILL_LIMITS,
  HOLE_FILL_PREVIEW_NOT_APPLIED,
  HOLE_FILL_PREVIEW_READY,
  HOLE_FILL_SECTION_SUMMARY,
  HOLE_FILL_SECTION_TITLE,
  HOLE_FILL_UNDONE,
  HoleFillTone,
  OPENING_ELIGIBLE,
  OPENING_ELIGIBLE_DETAIL,
  OPENING_INELIGIBLE,
  describeApplied,
  describeBoundaryRefusal,
  describeOpening,
  describeOpeningCount,
  describeOpeningSize,
  describePartSizeRefusal,
  describeTruncatedInventory,
  presentHoleFillStatus,
} from './hole-fill-presentation';

/**
 * WORDING IS A CORRECTNESS CONCERN, AND THIS IS WHERE IT IS CHECKED.
 *
 * Every sentence the hole-fill interface can show comes from
 * `hole-fill-presentation.ts`, so every sentence it can show is enumerable —
 * which is what makes "no screen may claim the model is watertight" a test
 * rather than a review comment.
 *
 * THE THREE THINGS THIS SUITE ESTABLISHES:
 *
 *   1. EVERY status and EVERY refusal has a sentence. An engine outcome with no
 *      wording reaches a user as a blank explanation beside a disabled control,
 *      and the compiler's exhaustiveness check alone cannot prove the sentence
 *      is non-empty or that it says anything.
 *   2. NO sentence makes a claim the engine does not support. The forbidden
 *      list is checked against the full text of everything, not against a
 *      sample.
 *   3. A REFUSAL IS TONED AS A DECISION, not as a failure. That distinction is
 *      the difference between telling a user their file is outside a proven
 *      scope and telling them it is broken.
 */

/** Every string the module can produce, gathered once. */
function everySentence(): readonly string[] {
  const sentences: string[] = [
    HOLE_FILL_SECTION_TITLE,
    HOLE_FILL_SECTION_SUMMARY,
    HOLE_FILL_PREVIEW_READY,
    HOLE_FILL_PREVIEW_NOT_APPLIED,
    HOLE_FILL_APPLIED_HEADLINE,
    HOLE_FILL_APPLIED_QUALIFIER,
    HOLE_FILL_UNDONE,
    HOLE_FILL_DISCARDED,
    HOLE_FILL_CANCELLED,
    OPENING_ELIGIBLE,
    OPENING_ELIGIBLE_DETAIL,
    OPENING_INELIGIBLE,
    ...HOLE_FILL_LIMITS,
    describeOpening(1),
    describeOpening(12),
    describeOpeningSize(1),
    describeOpeningSize(512),
    describeOpeningCount(0),
    describeOpeningCount(1),
    describeOpeningCount(20_165),
    describeTruncatedInventory(256, 20_165),
    describePartSizeRefusal(400_000),
    describeApplied(1, 1),
    describeApplied(3, 510),
  ];
  for (const refusal of Object.values(BoundaryLoopRefusal)) {
    sentences.push(describeBoundaryRefusal(refusal));
  }
  for (const status of Object.values(HoleFillStatus)) {
    const presented = presentHoleFillStatus(status);
    sentences.push(presented.headline, presented.detail);
  }
  return sentences;
}

describe('every engine outcome has wording', () => {
  it('gives every hole-fill status a headline and a detail', () => {
    for (const status of Object.values(HoleFillStatus)) {
      const presented = presentHoleFillStatus(status);
      expect(presented.headline.length, `${status} has no headline`).toBeGreaterThan(10);
      expect(presented.detail.length, `${status} has no detail`).toBeGreaterThan(20);
    }
  });

  it('gives every boundary refusal a sentence', () => {
    for (const refusal of Object.values(BoundaryLoopRefusal)) {
      const sentence = describeBoundaryRefusal(refusal);
      expect(sentence.length, `${refusal} has no sentence`).toBeGreaterThan(20);
    }
  });

  it('never leaks a raw code into user-facing text', () => {
    /*
     * `REFUSED_NON_PLANAR`, `NON_MANIFOLD_ADJACENCY` and their siblings are
     * developer diagnostics. A screaming-snake token on screen tells a user
     * nothing and looks like a crash.
     */
    const codes = [
      ...Object.values(HoleFillStatus),
      ...Object.values(BoundaryLoopRefusal),
    ] as readonly string[];
    for (const sentence of everySentence()) {
      for (const code of codes) {
        expect(sentence, `"${sentence}" leaks ${code}`).not.toContain(code);
      }
    }
  });

  it('never names an engine internal', () => {
    // §81. These are real things and they are all developer diagnostics.
    const INTERNALS = [
      'Geogram',
      'narrowphase',
      'broadphase',
      'BVH',
      'Euler',
      'Float32',
      'ear clip',
      'ear-clip',
      'WASM',
      'kernel',
    ];
    for (const sentence of everySentence()) {
      for (const internal of INTERNALS) {
        expect(sentence.toLowerCase(), `"${sentence}" names ${internal}`).not.toContain(
          internal.toLowerCase(),
        );
      }
    }
  });
});

describe('no sentence claims more than the engine established', () => {
  it('avoids every forbidden hole-fill term', () => {
    for (const sentence of everySentence()) {
      for (const term of HOLE_FILL_FORBIDDEN_TERMS) {
        expect(sentence.toLowerCase(), `"${sentence}" contains "${term}"`).not.toContain(
          term.toLowerCase(),
        );
      }
    }
  });

  it('inherits the topology and repair bans', () => {
    /*
     * INHERITED RATHER THAN RE-LISTED, so a term banned once is banned
     * everywhere. `hole` is the one deliberate exception and it is handled
     * below: the engine's own name for the operation is "fill", and this
     * workflow is about openings.
     */
    const inherited = [...FORBIDDEN_TERMS, ...REPAIR_FORBIDDEN_TERMS].filter(
      (term) => term !== 'hole',
    );
    for (const sentence of everySentence()) {
      for (const term of inherited) {
        expect(sentence.toLowerCase(), `"${sentence}" contains "${term}"`).not.toContain(
          term.toLowerCase(),
        );
      }
    }
  });

  it('never calls an opening a hole, a defect or damage', () => {
    /*
     * A BOUNDARY LOOP MAY BE EXACTLY WHAT THE USER MODELLED. An open tube, a
     * vase, a shell — calling one a hole tells them they have a problem they
     * may not have, which is the same diagnostic dishonesty the topology panel
     * is forbidden from committing.
     */
    for (const sentence of everySentence()) {
      const lower = sentence.toLowerCase();
      for (const term of ['hole', 'defect', 'damage', 'broken', 'flaw', 'corrupt']) {
        expect(lower, `"${sentence}" calls an opening a ${term}`).not.toContain(term);
      }
    }
  });

  it('never says a fill repaired, closed or completed the MODEL', () => {
    for (const sentence of everySentence()) {
      const lower = sentence.toLowerCase();
      expect(lower).not.toContain('model is closed');
      expect(lower).not.toContain('model is complete');
      expect(lower).not.toContain('model is now');
      expect(lower).not.toContain('fully closed');
    }
  });

  it('qualifies the success claim in the same breath as making it', () => {
    // §41. The strongest allowed statement names ONE opening and ONE part, and
    // the qualifier says what was not examined.
    expect(HOLE_FILL_APPLIED_HEADLINE).toBe('Selected opening filled and validated');
    expect(HOLE_FILL_APPLIED_QUALIFIER).toContain('Other openings');
    expect(HOLE_FILL_APPLIED_QUALIFIER).toContain('wall thickness');
    expect(HOLE_FILL_APPLIED_QUALIFIER).toContain('were not examined');
    // And the status-log line carries the qualifier with it.
    expect(describeApplied(2, 6)).toContain(HOLE_FILL_APPLIED_QUALIFIER);
  });

  it('says the model is unchanged wherever a preview exists', () => {
    // §25. "Ready" must never read as "done".
    expect(HOLE_FILL_PREVIEW_READY).toBe('Fill preview ready');
    expect(HOLE_FILL_PREVIEW_NOT_APPLIED.toLowerCase()).toContain('nothing has changed');
    const ready = presentHoleFillStatus(HoleFillStatus.ValidCandidate);
    expect(ready.tone).toBe(HoleFillTone.Ready);
    expect(ready.detail).toBe(HOLE_FILL_PREVIEW_NOT_APPLIED);
  });

  it('calls a discard a discard, and never an undo', () => {
    // §39. Nothing was applied, so there is nothing to reverse. Using "undo"
    // here would tell a user a change had been made and then taken back.
    expect(HOLE_FILL_DISCARDED.toLowerCase()).not.toContain('undo');
    expect(HOLE_FILL_DISCARDED.toLowerCase()).toContain('unchanged');
    expect(HOLE_FILL_CANCELLED.toLowerCase()).not.toContain('undo');
    expect(HOLE_FILL_CANCELLED.toLowerCase()).toContain('unchanged');
  });
});

describe('a refusal is toned as a decision, not a failure', () => {
  const REFUSALS: readonly HoleFillStatus[] = [
    HoleFillStatus.RefusedNonPlanar,
    HoleFillStatus.RefusedNotSimpleLoop,
    HoleFillStatus.RefusedNonManifoldBoundary,
    HoleFillStatus.RefusedAmbiguousOrientation,
    HoleFillStatus.RefusedDegenerateBoundary,
    HoleFillStatus.RefusedBoundarySize,
    HoleFillStatus.RefusedPartSize,
    HoleFillStatus.NoEarFound,
  ];

  it('tones every expected refusal as a refusal', () => {
    for (const status of REFUSALS) {
      expect(presentHoleFillStatus(status).tone, status).toBe(HoleFillTone.Refusal);
    }
  });

  it('tones the validation gate as a rejection, which is also a decision', () => {
    for (const status of [
      HoleFillStatus.SelfIntersectionCreated,
      HoleFillStatus.NonManifoldCreated,
      HoleFillStatus.DegeneratePatch,
      HoleFillStatus.ValidationFailed,
    ]) {
      expect(presentHoleFillStatus(status).tone, status).toBe(HoleFillTone.Rejected);
    }
  });

  it('reserves the failure tone for CAD Fixer being broken', () => {
    /*
     * EXACTLY ONE STATUS. `INTERNAL_FAILURE` means CAD Fixer is broken, and
     * nothing expected may be routed there — the same rule the engine's own
     * taxonomy states.
     */
    const failures = Object.values(HoleFillStatus).filter(
      (status) => presentHoleFillStatus(status).tone === HoleFillTone.Failure,
    );
    expect(failures).toEqual([HoleFillStatus.InternalFailure]);
  });

  it('distinguishes a resource ceiling from a defect', () => {
    // §45. The model is intact and the advice is different, so the register is
    // different too.
    const limited = presentHoleFillStatus(HoleFillStatus.ResourceLimit);
    expect(limited.tone).toBe(HoleFillTone.ResourceLimit);
    expect(limited.headline.toLowerCase()).toContain('within the supported shape');
  });

  it('tells a stale preview to be regenerated rather than reported', () => {
    for (const status of [HoleFillStatus.StaleRevision, HoleFillStatus.UnknownLoop]) {
      const presented = presentHoleFillStatus(status);
      expect(presented.tone, status).toBe(HoleFillTone.Stale);
      expect(presented.retryable, status).toBe(true);
    }
  });

  it('never treats a cancellation as a failure', () => {
    const cancelled = presentHoleFillStatus(HoleFillStatus.Cancelled);
    expect(cancelled.tone).toBe(HoleFillTone.Cancelled);
    expect(cancelled.retryable).toBe(true);
    expect(cancelled.detail.toLowerCase()).toContain('unchanged');
  });

  it('says the model was not changed for every non-success outcome', () => {
    /*
     * NOT LITERALLY IN EVERY SENTENCE — some say it by describing what was
     * discarded instead — but the interface must never leave a user wondering.
     * The panel renders "Your model was not changed." beneath every one of
     * these; this asserts none of them CONTRADICTS that.
     */
    for (const status of Object.values(HoleFillStatus)) {
      if (status === HoleFillStatus.ValidCandidate) continue;
      const presented = presentHoleFillStatus(status);
      const text = `${presented.headline} ${presented.detail}`.toLowerCase();
      // "Nothing was applied" is the sentence a stale outcome MUST carry, so
      // the ban is on the affirmative claim rather than on the substring.
      expect(text, status).not.toContain('the fill was applied');
      expect(text, status).not.toContain('has been filled');
      expect(text, status).not.toContain('your model was changed');
    }
  });
});

describe('the listing wording', () => {
  it('keeps the count exact when the list is capped', () => {
    // §9. A truncated list must never become a smaller number of openings.
    const disclosure = describeTruncatedInventory(256, 20_165);
    expect(disclosure).toContain('256');
    expect(disclosure).toContain('20,165');
    expect(describeOpeningCount(20_165)).toContain('20,165');
  });

  it('states a part-size refusal without disabling anything else', () => {
    const sentence = describePartSizeRefusal(400_000);
    expect(sentence).toContain('400,000');
    expect(sentence).toContain('250,000');
    expect(sentence.toLowerCase()).toContain('everything else cad fixer does is unaffected');
  });

  it('distinguishes zero, one and many openings', () => {
    expect(describeOpeningCount(0)).toContain('No open boundaries');
    expect(describeOpeningCount(1)).toContain('1 open boundary');
    expect(describeOpeningCount(7)).toContain('7 open boundaries');
    expect(describeOpeningSize(1)).toBe('1 rim point');
    expect(describeOpeningSize(512)).toBe('512 rim points');
  });

  it('§7: promises only that an eligible opening will be ATTEMPTED', () => {
    /*
     * THE LISTING ANSWERS A TOPOLOGICAL QUESTION AND NOT A GEOMETRIC ONE. A rim
     * that is a perfect simple cycle may still curve out of its own plane, and
     * only the engine can say. A row promising "can be filled" would be a
     * promise the listing has no way to keep.
     */
    expect(OPENING_ELIGIBLE.toLowerCase()).not.toContain('can be filled');
    expect(OPENING_ELIGIBLE.toLowerCase()).toContain('attempt');
    expect(OPENING_ELIGIBLE_DETAIL.toLowerCase()).toContain('flat enough');
    expect(OPENING_ELIGIBLE_DETAIL.toLowerCase()).toContain('when the fill runs');
  });

  it('labels an opening by its display position only', () => {
    // §13. The identity is never the label.
    expect(describeOpening(1)).toBe('Opening 1');
    expect(describeOpening(3)).toBe('Opening 3');
    expect(describeOpening(3)).not.toContain('bl-');
  });

  it('states the limits on screen rather than only in a document', () => {
    const text = HOLE_FILL_LIMITS.join(' ');
    expect(text).toContain('One opening at a time');
    expect(text).toContain('512');
    expect(text).toContain('250,000');
    expect(text.toLowerCase()).toContain('adds no points');
    expect(text.toLowerCase()).toContain('no fill-all');
  });
});
