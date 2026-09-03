import { describe, expect, it } from 'vitest';
import {
  AUTO_ELIGIBLE_MAX_FACES,
  SELF_INTERSECTION_MAX_FACES,
  SelfIntersectionBand,
  bandForFaceCount,
  isAutoEligible,
  isCheckable,
} from './policy';

/**
 * THE SIZE POLICY, AND ITS EXACT BOUNDARIES.
 *
 * Off-by-one here is not cosmetic: one face either side of the ceiling is the
 * difference between allocating a ~272 MiB broadphase and refusing before
 * allocating anything. Every boundary is asserted on both sides, and the
 * constants are asserted by VALUE so a silent retune cannot slip through as a
 * green test.
 */

describe('the qualified thresholds', () => {
  it('are the values Stage 3C-1A-R1 measured and froze', () => {
    // Changing either of these is a product decision, not a refactor. ADR 0012
    // records the latency evidence behind both.
    expect(AUTO_ELIGIBLE_MAX_FACES).toBe(25_000);
    expect(SELF_INTERSECTION_MAX_FACES).toBe(250_000);
  });
});

describe('band boundaries', () => {
  const cases: readonly (readonly [number, SelfIntersectionBand])[] = [
    [0, SelfIntersectionBand.AutoEligible],
    [1, SelfIntersectionBand.AutoEligible],
    [24_999, SelfIntersectionBand.AutoEligible],
    [25_000, SelfIntersectionBand.AutoEligible],
    [25_001, SelfIntersectionBand.ExplicitCheck],
    [249_999, SelfIntersectionBand.ExplicitCheck],
    [250_000, SelfIntersectionBand.ExplicitCheck],
    [250_001, SelfIntersectionBand.SizeLimit],
  ];

  for (const [faces, band] of cases) {
    it(`classifies ${String(faces)} faces as ${band}`, () => {
      expect(bandForFaceCount(faces)).toBe(band);
    });
  }

  it('treats an empty model as auto-eligible rather than undefined', () => {
    // A model with nothing in it is trivially checkable; answering "unknown"
    // would push a decision the caller cannot make any better.
    expect(bandForFaceCount(0)).toBe(SelfIntersectionBand.AutoEligible);
    expect(isCheckable(0)).toBe(true);
    expect(isAutoEligible(0)).toBe(true);
  });
});

describe('the ceiling is inclusive and the auto band is inclusive', () => {
  it('checks a model of exactly the ceiling', () => {
    expect(isCheckable(SELF_INTERSECTION_MAX_FACES)).toBe(true);
    expect(isAutoEligible(SELF_INTERSECTION_MAX_FACES)).toBe(false);
  });

  it('refuses one face above the ceiling', () => {
    expect(isCheckable(SELF_INTERSECTION_MAX_FACES + 1)).toBe(false);
    expect(isAutoEligible(SELF_INTERSECTION_MAX_FACES + 1)).toBe(false);
  });

  it('auto-checks a model of exactly the auto boundary', () => {
    expect(isAutoEligible(AUTO_ELIGIBLE_MAX_FACES)).toBe(true);
    expect(isAutoEligible(AUTO_ELIGIBLE_MAX_FACES + 1)).toBe(false);
    // Still checkable, just not without being asked.
    expect(isCheckable(AUTO_ELIGIBLE_MAX_FACES + 1)).toBe(true);
  });
});
