import { describe, expect, it } from 'vitest';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import { TopologyReportCache } from './topology-cache';
import type { ModelHandle, ModelId } from './resident-models';

/**
 * The cache exists to stop the same unchanged mesh being analysed three times,
 * and it is safe only because geometry at a revision is immutable. That makes
 * the revision comparison the entire correctness argument, so it is what these
 * tests are about: a report must never be returned for geometry it does not
 * describe.
 */

function handle(revision: number, modelId = 'model-1'): ModelHandle {
  return { modelId: modelId as ModelId, revision };
}

function report(faces: number): TopologyReport {
  // Only the field these tests distinguish reports by needs to be real; the rest
  // of the shape is asserted by the analysis tests that produce it.
  return { sourceFaceCount: faces } as unknown as TopologyReport;
}

describe('TopologyReportCache', () => {
  it('returns a report for the exact handle it was stored against', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(3), report(10));

    expect(cache.get(handle(3))?.sourceFaceCount).toBe(10);
  });

  it('refuses a report for an older revision of the same model', () => {
    // THE CASE THAT WOULD CORRUPT A REPAIR. A plan built from revision 3's report
    // against revision 4's geometry would describe defects that are no longer
    // there and miss ones that are.
    const cache = new TopologyReportCache();
    cache.set(handle(3), report(10));

    expect(cache.get(handle(4))).toBeUndefined();
  });

  it('refuses a report for a newer revision than it holds', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(4), report(10));

    expect(cache.get(handle(3))).toBeUndefined();
  });

  it('refuses a report for a different model at the same revision', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(1, 'model-1'), report(10));

    expect(cache.get(handle(1, 'model-2'))).toBeUndefined();
  });

  it('replaces a model’s report rather than accumulating revisions', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(1), report(10));
    cache.set(handle(2), report(8));

    expect(cache.size).toBe(1);
    expect(cache.get(handle(2))?.sourceFaceCount).toBe(8);
    expect(cache.get(handle(1))).toBeUndefined();
  });

  it('drops a model’s report when the model is released', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(1, 'model-1'), report(10));
    cache.set(handle(1, 'model-2'), report(20));

    cache.release('model-1' as ModelId);

    expect(cache.get(handle(1, 'model-1'))).toBeUndefined();
    expect(cache.get(handle(1, 'model-2'))?.sourceFaceCount).toBe(20);
  });

  it('releases everything on teardown', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(1, 'model-1'), report(10));
    cache.set(handle(1, 'model-2'), report(20));

    cache.releaseAll();

    expect(cache.size).toBe(0);
  });
});
