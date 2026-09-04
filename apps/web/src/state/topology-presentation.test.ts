import { describe, expect, it } from 'vitest';
import {
  PrintabilityStatus,
  SelfIntersectionStatus,
  VolumeStatus,
  type TopologyReport,
} from '@cadfixer/geometry-runtime';
import {
  DEFECT_EXPLANATIONS,
  FORBIDDEN_TERMS,
  describeOverlaySampling,
  describeTruncation,
  formatArea,
  formatVolume,
  presentVolume,
  summariseTopology,
} from './topology-presentation';

/**
 * Wording is tested because wording is the product's honesty surface. A panel
 * that says "watertight" about a mesh whose self-intersections were never
 * checked is a correctness bug, not a copy problem.
 */

function reportWith(overrides: Partial<TopologyReport> = {}): TopologyReport {
  return {
    schemaVersion: 1,
    documentId: 'model-1',
    documentRevision: 1,
    partId: 'part-1',
    identityMode: 'exact-stored-coordinate',
    sourceFaceCount: 4,
    sourceCornerCount: 12,
    topologicalVertexCount: 4,
    uniqueEdgeCount: 6,
    boundaryEdgeCount: 0,
    ordinaryEdgeCount: 6,
    nonManifoldEdgeCount: 0,
    nonManifoldVertexCount: 0,
    windingConflictEdgeCount: 0,
    repeatedPositionFaceCount: 0,
    zeroAreaFaceCount: 0,
    sameOrientationDuplicateCount: 0,
    reversedOrientationDuplicateCount: 0,
    componentCount: 1,
    components: [],
    componentsTruncated: false,
    simpleBoundaryLoopCount: 0,
    openBoundaryChainCount: 0,
    branchedBoundaryCount: 0,
    boundaryComponents: [],
    boundaryComponentsTruncated: false,
    totalSurfaceArea: 1,
    totalSignedVolume: 1 / 6,
    isEdgeManifold: true,
    isVertexManifold: true,
    isWindingConsistent: true,
    isBoundaryFree: true,
    selfIntersectionStatus: SelfIntersectionStatus.NotChecked,
    printabilityStatus: PrintabilityStatus.NotFullyDetermined,
    analysisMilliseconds: 1,
    ...overrides,
  };
}

describe('forbidden terminology', () => {
  /**
   * The claim this test defends: nothing this module can emit tells the user
   * their model is fine in a way the engine has not established.
   */
  it('never appears in any explanation or summary this module produces', () => {
    const emitted = [
      ...Object.values(DEFECT_EXPLANATIONS).flatMap((entry) => [entry.label, entry.help]),
      ...[
        summariseTopology(reportWith()),
        summariseTopology(reportWith({ boundaryEdgeCount: 3 })),
      ].flatMap((summary) => [summary.headline, summary.qualifier]),
      ...[
        VolumeStatus.ClosedManifold,
        VolumeStatus.OpenSurface,
        VolumeStatus.NotInterpretable,
      ].flatMap((status) => {
        const presented = presentVolume(1, status, undefined);
        return [presented.label, presented.help];
      }),
    ]
      .join(' ')
      .toLowerCase();

    for (const term of FORBIDDEN_TERMS) {
      expect(emitted).not.toContain(term);
    }
  });

  it('calls a boundary cycle a loop, never a hole', () => {
    expect(DEFECT_EXPLANATIONS.simpleBoundaryLoop.label).toBe('Simple boundary loops');
    expect(DEFECT_EXPLANATIONS.simpleBoundaryLoop.help.toLowerCase()).not.toContain('hole');
    // And it says the opening may be intentional, which is the whole reason
    // "hole" is wrong.
    expect(DEFECT_EXPLANATIONS.simpleBoundaryLoop.help).toContain('intentional');
  });
});

describe('overall summary', () => {
  it('qualifies a clean result rather than declaring success', () => {
    const summary = summariseTopology(reportWith());

    expect(summary.hasDefects).toBe(false);
    expect(summary.headline).toBe('No topological defects detected');
    expect(summary.qualifier).toBe(
      'Self-intersections and wall thickness have not yet been checked.',
    );
  });

  it('reports defects when any category is non-zero', () => {
    // One boundary edge is enough. A category-by-category summary that ignored
    // boundaries would call an open shell clean.
    expect(summariseTopology(reportWith({ boundaryEdgeCount: 1 })).hasDefects).toBe(true);
    expect(summariseTopology(reportWith({ zeroAreaFaceCount: 1 })).hasDefects).toBe(true);
    expect(summariseTopology(reportWith({ reversedOrientationDuplicateCount: 1 })).hasDefects).toBe(
      true,
    );
  });
});

describe('units', () => {
  it('uses a neutral unit when the format states none', () => {
    expect(formatArea(125, undefined)).toBe('125 unit²');
    expect(formatVolume(30, undefined)).toBe('30 unit³');
  });

  it('uses the stated unit when there is one', () => {
    expect(formatArea(125, 'mm')).toBe('125 mm²');
  });
});

describe('volume presentation', () => {
  it('offers no number for an open surface', () => {
    const presented = presentVolume(12, VolumeStatus.OpenSurface, undefined);

    expect(presented.value).toBeUndefined();
    expect(presented.help).toContain('does not enclose');
  });

  it('offers no number when the surface is not interpretable', () => {
    expect(presentVolume(12, VolumeStatus.NotInterpretable, undefined).value).toBeUndefined();
  });

  it('shows magnitude, not a negative physical volume', () => {
    const presented = presentVolume(-30, VolumeStatus.ClosedManifold, undefined);

    // The user must not read this as negative matter.
    expect(presented.value).toBe('30 unit³');
    expect(presented.help).toContain('face inward');
  });

  it('always says self-intersections are untested, even for a clean shell', () => {
    const presented = presentVolume(30, VolumeStatus.ClosedManifold, undefined);

    expect(presented.value).toBe('30 unit³');
    expect(presented.help).toContain('Self-intersections are not tested');
  });
});

describe('truncation disclosure', () => {
  it('says nothing when the whole list is shown', () => {
    expect(describeTruncation(5, 5)).toBeUndefined();
    expect(describeOverlaySampling(50, 50)).toBeUndefined();
  });

  it('names both the shown and the actual totals', () => {
    expect(describeTruncation(1_000, 12_500)).toBe('Showing first 1,000 of 12,500 components.');
    expect(describeOverlaySampling(50_000, 1_842_193)).toBe(
      'Showing 50,000 of 1,842,193 in the viewport.',
    );
  });
});
