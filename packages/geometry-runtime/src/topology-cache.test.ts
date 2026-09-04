import { describe, expect, it } from 'vitest';
import { partId } from '@cadfixer/mesh-core';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import { TopologyReportCache } from './topology-cache';
import type { DocumentHandle, DocumentId } from './resident-documents';

/**
 * The cache exists to stop the same unchanged mesh being analysed three times,
 * and it is safe only because geometry at a revision is immutable. That makes
 * the revision comparison the entire correctness argument, so it is what these
 * tests are about: a report must never be returned for geometry it does not
 * describe.
 */

function handle(revision: number, documentId = 'model-1'): DocumentHandle {
  return { documentId: documentId as DocumentId, revision };
}

const A = partId('part-a');
const B = partId('part-b');

function report(faces: number): TopologyReport {
  // Only the field these tests distinguish reports by needs to be real; the rest
  // of the shape is asserted by the analysis tests that produce it.
  return { sourceFaceCount: faces } as unknown as TopologyReport;
}

describe('TopologyReportCache', () => {
  it('returns a report for the exact handle it was stored against', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(3), A, report(10));

    expect(cache.get(handle(3), A)?.sourceFaceCount).toBe(10);
  });

  it('refuses a report for an older revision of the same model', () => {
    // THE CASE THAT WOULD CORRUPT A REPAIR. A plan built from revision 3's report
    // against revision 4's geometry would describe defects that are no longer
    // there and miss ones that are.
    const cache = new TopologyReportCache();
    cache.set(handle(3), A, report(10));

    expect(cache.get(handle(4), A)).toBeUndefined();
  });

  it('refuses a report for a newer revision than it holds', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(4), A, report(10));

    expect(cache.get(handle(3), A)).toBeUndefined();
  });

  it('refuses a report for a different model at the same revision', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(1, 'model-1'), A, report(10));

    expect(cache.get(handle(1, 'model-2'), A)).toBeUndefined();
  });

  it('replaces a model’s report rather than accumulating revisions', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(1), A, report(10));
    cache.set(handle(2), A, report(8));

    expect(cache.size).toBe(1);
    expect(cache.get(handle(2), A)?.sourceFaceCount).toBe(8);
    expect(cache.get(handle(1), A)).toBeUndefined();
  });

  it('drops a model’s report when the model is released', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(1, 'model-1'), A, report(10));
    cache.set(handle(1, 'model-2'), A, report(20));

    cache.release('model-1' as DocumentId);

    expect(cache.get(handle(1, 'model-1'), A)).toBeUndefined();
    expect(cache.get(handle(1, 'model-2'), A)?.sourceFaceCount).toBe(20);
  });

  it('DF12: refuses a report for a different PART at the same revision', () => {
    /*
     * THE CASE A HANDLE COMPARISON CANNOT CATCH. Two parts of one document share
     * a revision, so without a part key part A's counts would be returned for
     * part B — and the repair plan derived from them would describe defects in a
     * mesh nobody analysed.
     */
    const cache = new TopologyReportCache();
    cache.set(handle(1), A, report(10));

    expect(cache.get(handle(1), B)).toBeUndefined();
    expect(cache.get(handle(1), A)?.sourceFaceCount).toBe(10);
  });

  it('holds a report per part of one document', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(1), A, report(10));
    cache.set(handle(1), B, report(20));

    expect(cache.size).toBe(2);
    expect(cache.get(handle(1), A)?.sourceFaceCount).toBe(10);
    expect(cache.get(handle(1), B)?.sourceFaceCount).toBe(20);
  });

  it('DF13: a new document revision invalidates EVERY part’s report', () => {
    // The qualified cost of one revision per document: an edit to part A moves
    // part B's handle too, so B's report describes nothing reachable.
    const cache = new TopologyReportCache();
    cache.set(handle(1), A, report(10));
    cache.set(handle(1), B, report(20));

    expect(cache.get(handle(2), A)).toBeUndefined();
    expect(cache.get(handle(2), B)).toBeUndefined();

    cache.set(handle(2), A, report(9));
    expect(cache.get(handle(2), B)).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it('releases everything on teardown', () => {
    const cache = new TopologyReportCache();
    cache.set(handle(1, 'model-1'), A, report(10));
    cache.set(handle(1, 'model-2'), A, report(20));

    cache.releaseAll();

    expect(cache.size).toBe(0);
  });
});
