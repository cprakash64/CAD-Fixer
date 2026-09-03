import { describe, expect, it } from 'vitest';
import {
  SelfIntersectionBand,
  SelfIntersectionPhase,
  SelfIntersectionStatus,
  type SelfIntersectionReport,
} from '@cadfixer/mesh-self-intersection';
import {
  CATEGORY_LABELS,
  SELF_INTERSECTION_FORBIDDEN_TERMS,
  SELF_INTERSECTION_QUALIFIER,
  SELF_INTERSECTION_TITLE,
  describePhase,
  describeReport,
} from './self-intersection-presentation';

/**
 * THE HONESTY TEST.
 *
 * Every string the diagnostic can emit is enumerated here and checked twice:
 * that it contains no over-claiming vocabulary, and — the load-bearing one —
 * that nothing except a completed check with zero findings is ever marked
 * `clean`. Five of the six statuses carry a zero intersection count, so
 * "count === 0" is not a safe thing for a component to branch on.
 */

function report(overrides: Partial<SelfIntersectionReport> = {}): SelfIntersectionReport {
  return {
    schemaVersion: 1,
    status: SelfIntersectionStatus.Checked,
    modelId: 'm',
    modelRevision: 1,
    faceCount: 100,
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

const ALL_STATUSES = Object.values(SelfIntersectionStatus);
const ALL_PHASES = Object.values(SelfIntersectionPhase);
const ALL_BANDS = Object.values(SelfIntersectionBand);

/** Every sentence this module can produce, in every state. */
function everyString(): string[] {
  const out: string[] = [SELF_INTERSECTION_TITLE, SELF_INTERSECTION_QUALIFIER];
  out.push(...Object.values(CATEGORY_LABELS));
  for (const phase of ALL_PHASES) {
    for (const band of ALL_BANDS) {
      const described = describePhase(phase, band);
      if (described === undefined) continue;
      out.push(described.headline);
      if (described.detail !== undefined) out.push(described.detail);
    }
  }
  for (const status of ALL_STATUSES) {
    for (const found of [0, 1, 5]) {
      const described = describeReport(
        report({
          status,
          intersectingPairCount: found,
          affectedFaceCount: found * 2,
          skippedDegenerateFaceCount: 2,
          unclassifiedPairCount: 1,
        }),
      );
      out.push(described.headline);
      if (described.detail !== undefined) out.push(described.detail);
    }
  }
  return out;
}

describe('no self-intersection string over-claims', () => {
  it('contains none of the forbidden terms', () => {
    for (const line of everyString()) {
      for (const term of SELF_INTERSECTION_FORBIDDEN_TERMS) {
        expect(line.toLowerCase().includes(term), `"${line}" must not contain "${term}"`).toBe(
          false,
        );
      }
    }
  });

  it('never claims the model is fine, only that this one check passed', () => {
    const clean = describeReport(report());
    expect(clean.headline).toBe('None found');
    // The qualifier is what stops "None found" being read as "model is good".
    expect(SELF_INTERSECTION_QUALIFIER).toMatch(/wall thickness/i);
  });
});

describe('only a completed, empty check is marked clean', () => {
  it('marks CHECKED with zero findings clean', () => {
    expect(describeReport(report()).clean).toBe(true);
  });

  it('does NOT mark CHECKED with findings clean', () => {
    expect(describeReport(report({ intersectingPairCount: 2 })).clean).toBe(false);
  });

  for (const status of ALL_STATUSES.filter((s) => s !== SelfIntersectionStatus.Checked)) {
    it(`does NOT mark ${status} clean, despite its zero count`, () => {
      const described = describeReport(report({ status, intersectingPairCount: 0 }));
      expect(described.clean).toBe(false);
      expect(described.headline.toLowerCase()).not.toContain('none found');
    });
  }

  it('marks no in-progress or idle phase clean', () => {
    for (const phase of ALL_PHASES) {
      for (const band of ALL_BANDS) {
        expect(describePhase(phase, band)?.clean ?? false).toBe(false);
      }
    }
  });
});

describe('incomplete results still report what was found', () => {
  it('leads with the findings when a PARTIAL scan found some', () => {
    const described = describeReport(
      report({
        status: SelfIntersectionStatus.Partial,
        intersectingPairCount: 3,
        skippedDegenerateFaceCount: 2,
      }),
    );
    expect(described.headline).toContain('3');
    expect(described.headline.toLowerCase()).toContain('incomplete');
    expect(described.detail ?? '').toMatch(/no area/i);
  });

  it('says a resource-limited result is a lower bound', () => {
    const described = describeReport(
      report({ status: SelfIntersectionStatus.ResourceLimit, intersectingPairCount: 7 }),
    );
    expect(described.detail ?? '').toMatch(/lower bound/i);
    expect(described.clean).toBe(false);
  });
});

describe('the size policy is explained rather than hidden', () => {
  it('says the model was not checked, not that it is clean', () => {
    const described = describePhase(SelfIntersectionPhase.Idle, SelfIntersectionBand.SizeLimit);
    expect(described?.headline).toMatch(/not checked/i);
    expect(described?.detail).toMatch(/250,000/);
    expect(described?.clean).toBe(false);
  });

  it('explains why a medium model is not started automatically', () => {
    const described = describePhase(SelfIntersectionPhase.Idle, SelfIntersectionBand.ExplicitCheck);
    expect(described?.detail).toMatch(/25,000/);
  });
});
