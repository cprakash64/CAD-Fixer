import { describe, expect, it } from 'vitest';
import * as engine from '@cadfixer/mesh-hole-fill';
import { BOUNDARY_FILL_MAX_OPENINGS_PER_REPAIR, BoundaryFillVerdict } from './boundary-fill';

/**
 * The runtime RESTATES the engine's verdict taxonomy so the main-thread bundle
 * never depends on the engine. This keeps the restatement honest: every engine
 * verdict exists here with the same value, and the only addition is `FILLED`,
 * which describes a candidate's outcome rather than an admission decision.
 */
describe('boundary-fill verdicts', () => {
  it('restates every engine verdict with the same value', () => {
    for (const [key, value] of Object.entries(engine.BoundaryFillVerdict)) {
      expect(BoundaryFillVerdict[key as keyof typeof BoundaryFillVerdict], key).toBe(value);
    }
  });

  it('adds only FILLED', () => {
    const extra = Object.keys(BoundaryFillVerdict).filter(
      (key) => !(key in engine.BoundaryFillVerdict),
    );
    expect(extra).toEqual(['Filled']);
  });

  it('restates the per-repair opening limit', () => {
    expect(BOUNDARY_FILL_MAX_OPENINGS_PER_REPAIR).toBe(
      engine.DEFAULT_BOUNDARY_FILL_LIMITS.maxLoopsPerCandidate,
    );
  });
});
