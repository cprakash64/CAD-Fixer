import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SELF_INTERSECTION_LIMITS,
  MAX_CANDIDATE_PAIRS,
  MAX_SAMPLES,
  MAX_TESTED_PAIRS,
  narrowLimits,
} from './limits';

/**
 * The caps, and the rule that a caller may only tighten them.
 *
 * A message that could WIDEN a resource limit would let a caller talk the
 * application out of its own safety margin — the same reason the repair memory
 * ceiling may only narrow.
 */

describe('the qualified caps', () => {
  it('are the values carried over from Stage 3C-1A-R1', () => {
    expect(MAX_CANDIDATE_PAIRS).toBe(40_000_000);
    expect(MAX_TESTED_PAIRS).toBe(20_000_000);
    expect(MAX_SAMPLES).toBe(4_096);
  });

  it('keeps candidate and tested caps DISTINCT', () => {
    // Broadphase and narrowphase work cost differently, and a mesh can generate
    // enormous numbers of candidates while testing few. One shared number would
    // hide which limit actually fired.
    expect(MAX_CANDIDATE_PAIRS).not.toBe(MAX_TESTED_PAIRS);
  });
});

describe('narrowLimits', () => {
  it('returns the defaults when nothing is requested', () => {
    expect(narrowLimits(undefined)).toEqual(DEFAULT_SELF_INTERSECTION_LIMITS);
  });

  it('accepts a narrower request', () => {
    const narrowed = narrowLimits({ maxTestedPairs: 1_000, maxSamples: 16 });
    expect(narrowed.maxTestedPairs).toBe(1_000);
    expect(narrowed.maxSamples).toBe(16);
    expect(narrowed.maxCandidatePairs).toBe(MAX_CANDIDATE_PAIRS);
  });

  it('REFUSES to widen any cap', () => {
    const widened = narrowLimits({
      maxCandidatePairs: Number.MAX_SAFE_INTEGER,
      maxTestedPairs: MAX_TESTED_PAIRS * 10,
      maxSamples: 1_000_000,
    });
    expect(widened.maxCandidatePairs).toBe(MAX_CANDIDATE_PAIRS);
    expect(widened.maxTestedPairs).toBe(MAX_TESTED_PAIRS);
    expect(widened.maxSamples).toBe(MAX_SAMPLES);
  });

  it('falls back to the ceiling for values that are not usable numbers', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(narrowLimits({ maxTestedPairs: bad }).maxTestedPairs).toBe(MAX_TESTED_PAIRS);
    }
  });

  it('floors a fractional request rather than carrying a fraction into the worker', () => {
    expect(narrowLimits({ maxSamples: 10.9 }).maxSamples).toBe(10);
  });
});
