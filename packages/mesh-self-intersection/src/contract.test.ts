import { describe, expect, it } from 'vitest';
import {
  SelfIntersectionStatus,
  hasFindings,
  isCompleteCleanResult,
  isIncompleteExamination,
  type SelfIntersectionReport,
} from './contract';

/**
 * THE TRUTHFULNESS GATE.
 *
 * Five of the six statuses can carry an intersection count of zero, and only
 * ONE of them means the mesh has no self-intersections. These tests exist so
 * that a future change which lets any of the other five render as "none found"
 * fails loudly rather than shipping a confident lie.
 */

function report(overrides: Partial<SelfIntersectionReport> = {}): SelfIntersectionReport {
  return {
    schemaVersion: 1,
    status: SelfIntersectionStatus.Checked,
    modelId: 'model-1',
    modelRevision: 1,
    faceCount: 12,
    intersectingPairCount: 0,
    affectedFaceCount: 0,
    categories: {
      properCrossing: 0,
      coplanarOverlap: 0,
      nonAdjacentPointTouch: 0,
      nonAdjacentEdgeTouch: 0,
      adjacentOverlapBeyondShared: 0,
      duplicateTopologyDefect: 0,
      legitimateShared: 0,
    },
    skippedDegenerateFaceCount: 0,
    skippedPairCount: 0,
    unclassifiedPairCount: 0,
    candidatePairCount: 0,
    testedPairCount: 0,
    samples: new Uint32Array(0),
    samplePairCount: 0,
    samplesTruncated: false,
    engine: { name: 'geogram', version: 'v1.10.0', commit: 'c8529bb' },
    ...overrides,
  };
}

describe('only a complete, clean CHECKED result means "none found"', () => {
  it('accepts CHECKED with zero findings', () => {
    expect(isCompleteCleanResult(report())).toBe(true);
  });

  it('rejects CHECKED that actually found something', () => {
    expect(isCompleteCleanResult(report({ intersectingPairCount: 3 }))).toBe(false);
  });

  const notClean = [
    SelfIntersectionStatus.Partial,
    SelfIntersectionStatus.ResourceLimit,
    SelfIntersectionStatus.Cancelled,
    SelfIntersectionStatus.InternalFailure,
    SelfIntersectionStatus.NotRunSizePolicy,
  ] as const;

  for (const status of notClean) {
    it(`REFUSES ${status} even though its intersection count is zero`, () => {
      // This is the whole point: every one of these has a zero count, and every
      // one of them means something other than "the mesh is fine".
      const r = report({ status, intersectingPairCount: 0 });
      expect(r.intersectingPairCount).toBe(0);
      expect(isCompleteCleanResult(r)).toBe(false);
    });
  }
});

describe('incomplete EXAMINATION is not the same as an absent one', () => {
  it('treats PARTIAL and RESOURCE_LIMIT as incomplete examinations', () => {
    expect(isIncompleteExamination(report({ status: SelfIntersectionStatus.Partial }))).toBe(true);
    expect(isIncompleteExamination(report({ status: SelfIntersectionStatus.ResourceLimit }))).toBe(
      true,
    );
  });

  it('does NOT treat cancellation, failure or size policy as incomplete examinations', () => {
    // Those three are absent examinations. The interface says something
    // different about each, so collapsing them here would erase the distinction.
    for (const status of [
      SelfIntersectionStatus.Cancelled,
      SelfIntersectionStatus.InternalFailure,
      SelfIntersectionStatus.NotRunSizePolicy,
    ] as const) {
      expect(isIncompleteExamination(report({ status }))).toBe(false);
    }
  });
});

describe('findings survive incompleteness', () => {
  it('reports findings from a PARTIAL scan rather than discarding them', () => {
    const r = report({
      status: SelfIntersectionStatus.Partial,
      intersectingPairCount: 3,
      affectedFaceCount: 5,
      skippedDegenerateFaceCount: 2,
    });
    expect(hasFindings(r)).toBe(true);
    expect(r.intersectingPairCount).toBe(3);
    // ...but it still may not be called clean.
    expect(isCompleteCleanResult(r)).toBe(false);
  });

  it('reports findings discovered before a resource cap fired', () => {
    const r = report({ status: SelfIntersectionStatus.ResourceLimit, intersectingPairCount: 7 });
    expect(hasFindings(r)).toBe(true);
    expect(isCompleteCleanResult(r)).toBe(false);
  });
});

describe('duplicates are provenance, not self-intersections', () => {
  it('keeps duplicate counts out of intersectingPairCount', () => {
    const r = report({
      categories: { ...report().categories, duplicateTopologyDefect: 4 },
    });
    expect(r.categories.duplicateTopologyDefect).toBe(4);
    expect(r.intersectingPairCount).toBe(0);
    // A mesh whose only finding is duplicate topology is still clean of
    // self-intersection; Stage 2 reports the duplicates separately.
    expect(isCompleteCleanResult(r)).toBe(true);
  });
});

describe('work counters exceed Uint32 range', () => {
  it('carries a candidate count larger than 2^32 without wrapping', () => {
    // At the 250,000-face ceiling a fully-overlapping mesh reaches ~3.1e10
    // candidate pairs. A Uint32 would silently wrap; a JS number holds every
    // integer to 2^53 exactly.
    const huge = 31_250_000_000;
    expect(huge).toBeGreaterThan(0xffffffff);
    const r = report({ candidatePairCount: huge });
    expect(r.candidatePairCount).toBe(huge);
    expect(Number.isSafeInteger(r.candidatePairCount)).toBe(true);
  });
});
