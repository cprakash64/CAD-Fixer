import { describe, expect, it } from 'vitest';
import {
  PrintabilityStatus,
  SelfIntersectionStatus as TopologySelfIntersectionStatus,
  type TopologyDetail,
  type TopologyReport,
} from '@cadfixer/geometry-runtime';
import {
  SelfIntersectionStatus,
  type SelfIntersectionReport,
} from '@cadfixer/mesh-self-intersection';
import { HOLE_FILL_FORBIDDEN_TERMS } from './hole-fill-presentation';
import {
  deriveHealthSummary,
  deriveRepairIssues,
  describeCount,
  IssueSeverity,
  locateOccurrence,
  REPAIR_ISSUE_ORDER,
  RepairIssueId,
  type RepairIssue,
  type RepairIssueSources,
} from './repair-issues';
import { FORBIDDEN_TERMS, TOPOLOGY_QUALIFIER } from './topology-presentation';

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
    selfIntersectionStatus: TopologySelfIntersectionStatus.NotChecked,
    printabilityStatus: PrintabilityStatus.NotFullyDetermined,
    analysisMilliseconds: 1,
    ...overrides,
  };
}

/** Two sampled edges with known endpoints, and one sampled face. */
function detailWith(overrides: Partial<TopologyDetail> = {}): TopologyDetail {
  return {
    boundaryEdges: new Uint32Array(0),
    boundaryEdgesTruncated: false,
    nonManifoldEdges: new Uint32Array([2, 5, 5, 9]),
    nonManifoldEdgesTruncated: false,
    windingConflictEdges: new Uint32Array(0),
    windingConflictEdgesTruncated: false,
    degenerateFaces: new Uint32Array([1]),
    degenerateFacesTruncated: false,
    sampleVertexIds: new Uint32Array([2, 5, 9]),
    sampleVertexPositions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 4, 0]),
    sampleLimit: 64,
    ...overrides,
  };
}

function selfReport(overrides: Partial<SelfIntersectionReport> = {}): SelfIntersectionReport {
  return {
    schemaVersion: 1,
    status: SelfIntersectionStatus.Checked,
    documentId: 'model-1',
    documentRevision: 1,
    partId: 'part-1',
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

function sources(overrides: Partial<RepairIssueSources> = {}): RepairIssueSources {
  return {
    report: reportWith(),
    detail: detailWith({
      nonManifoldEdges: new Uint32Array(0),
      degenerateFaces: new Uint32Array(0),
    }),
    selfIntersection: undefined,
    boundaryRows: [],
    ...overrides,
  };
}

const byId = (issues: readonly RepairIssue[], id: RepairIssueId): RepairIssue => {
  const issue = issues.find((candidate) => candidate.id === id);
  if (issue === undefined) throw new Error(`no ${id} row`);
  return issue;
};

describe('the issue list', () => {
  it('is empty until there is a current report, so zeros never stand in for a result', () => {
    expect(deriveRepairIssues(sources({ report: undefined }))).toEqual([]);
    expect(deriveHealthSummary([])).toMatchObject({ tone: 'neutral', text: 'Not analysed' });
  });

  it('lists exactly the checks CAD Fixer runs, in the reference order', () => {
    const ids = deriveRepairIssues(sources()).map((issue) => issue.id);
    expect(ids).toEqual(REPAIR_ISSUE_ORDER);
    // The reference's thin-wall and gap rows describe checks that do not exist.
    expect(ids.join(' ')).not.toMatch(/thin|gap/i);
  });

  it('keeps passed checks visible as zero-count OK rows', () => {
    const issues = deriveRepairIssues(sources());
    for (const id of [
      RepairIssueId.OpenBoundaries,
      RepairIssueId.NonManifoldEdges,
      RepairIssueId.DegenerateFaces,
      RepairIssueId.Components,
    ]) {
      expect(byId(issues, id).severity).toBe(IssueSeverity.Ok);
    }
    expect(byId(issues, RepairIssueId.OpenBoundaries).count).toBe(0);
    expect(byId(issues, RepairIssueId.Components).count).toBe(1);
  });

  it('marks a check that has not run as unchecked, never as a pass', () => {
    const self = byId(deriveRepairIssues(sources()), RepairIssueId.SelfIntersections);
    expect(self.severity).toBe(IssueSeverity.Unchecked);
    expect(self.count).toBeUndefined();
    expect(describeCount(self)).toBe('Not checked');
  });

  it('classifies structural ambiguity as errors and reviewable findings as warnings', () => {
    const issues = deriveRepairIssues(
      sources({
        report: reportWith({
          nonManifoldEdgeCount: 2,
          nonManifoldVertexCount: 1,
          windingConflictEdgeCount: 3,
          simpleBoundaryLoopCount: 2,
          zeroAreaFaceCount: 4,
          repeatedPositionFaceCount: 1,
          sameOrientationDuplicateCount: 2,
          reversedOrientationDuplicateCount: 1,
          componentCount: 3,
        }),
        selfIntersection: selfReport({ affectedFaceCount: 6, intersectingPairCount: 3 }),
      }),
    );
    expect(byId(issues, RepairIssueId.NonManifoldEdges).severity).toBe(IssueSeverity.Error);
    expect(byId(issues, RepairIssueId.NonManifoldVertices).severity).toBe(IssueSeverity.Error);
    expect(byId(issues, RepairIssueId.SelfIntersections).severity).toBe(IssueSeverity.Error);
    expect(byId(issues, RepairIssueId.OpenBoundaries).severity).toBe(IssueSeverity.Warning);
    expect(byId(issues, RepairIssueId.WindingConflicts).severity).toBe(IssueSeverity.Warning);
    expect(byId(issues, RepairIssueId.DegenerateFaces).count).toBe(5);
    expect(byId(issues, RepairIssueId.DuplicateFaces).count).toBe(3);
    expect(byId(issues, RepairIssueId.Components).severity).toBe(IssueSeverity.Warning);

    // Categories, not occurrences.
    expect(deriveHealthSummary(issues)).toMatchObject({
      errors: 3,
      warnings: 5,
      tone: 'error',
      text: '3 errors · 5 warnings',
    });
  });

  it('counts open boundaries as components and names the unit correctly', () => {
    const issue = byId(
      deriveRepairIssues(
        sources({
          report: reportWith({ simpleBoundaryLoopCount: 1, openBoundaryChainCount: 1 }),
          boundaryRows: [{ boundaryLoopId: 'bl-1' }, { boundaryLoopId: 'bl-2' }],
        }),
      ),
      RepairIssueId.OpenBoundaries,
    );
    expect(describeCount(issue)).toBe('2 boundaries');
    expect(issue.occurrenceCount).toBe(2);
    expect(issue.occurrencesPartial).toBe(false);
  });

  it('says when it can step through fewer occurrences than it counted', () => {
    const issues = deriveRepairIssues(
      sources({
        report: reportWith({ nonManifoldEdgeCount: 40 }),
        detail: detailWith(),
      }),
    );
    const edges = byId(issues, RepairIssueId.NonManifoldEdges);
    expect(edges.occurrenceCount).toBe(2);
    expect(edges.occurrencesPartial).toBe(true);
    // No location data exists for vertices, so no navigator is offered.
    expect(byId(issues, RepairIssueId.NonManifoldVertices).occurrenceCount).toBe(0);
  });

  it('keeps the health summary qualified, and never calls a clean result sound', () => {
    const summary = deriveHealthSummary(deriveRepairIssues(sources()));
    expect(summary).toMatchObject({ errors: 0, warnings: 0, tone: 'ok', text: 'No issues found' });
    expect(summary.qualifier).toBe(TOPOLOGY_QUALIFIER);
  });

  it('uses no forbidden term in any label, help text or summary', () => {
    const issues = deriveRepairIssues(
      sources({ selfIntersection: selfReport({ affectedFaceCount: 2, intersectingPairCount: 1 }) }),
    );
    const emitted = [
      ...issues.flatMap((issue) => [issue.label, issue.help, describeCount(issue)]),
      deriveHealthSummary(issues).text,
    ].join('\n');
    for (const term of [...FORBIDDEN_TERMS, 'watertight', 'holes']) {
      expect(emitted.toLowerCase()).not.toContain(term);
    }
    for (const term of HOLE_FILL_FORBIDDEN_TERMS.filter((t) => t !== 'Euler')) {
      expect(emitted.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
});

describe('occurrence locations', () => {
  const issues = deriveRepairIssues(
    sources({
      report: reportWith({ nonManifoldEdgeCount: 2, zeroAreaFaceCount: 1 }),
      detail: detailWith(),
    }),
  );

  it('locates a sampled edge from its two endpoints', () => {
    const edge = byId(issues, RepairIssueId.NonManifoldEdges);
    const second = locateOccurrence(edge, 1, {
      detail: detailWith(),
      renderPositions: undefined,
      selfIntersection: undefined,
      rim: undefined,
    });
    // Vertices 5 (2,0,0) and 9 (2,4,0): midpoint (2,2,0), half-diagonal 2.
    expect(second).toEqual({ center: [2, 2, 0], radius: 2 });
  });

  it('locates a sampled face from the render snapshot', () => {
    const face = byId(issues, RepairIssueId.DegenerateFaces);
    const positions = new Float32Array(18);
    positions.set([0, 0, 0, 2, 0, 0, 4, 0, 0], 9); // face 1: collinear on X
    expect(
      locateOccurrence(face, 0, {
        detail: detailWith(),
        renderPositions: positions,
        selfIntersection: undefined,
        rim: undefined,
      }),
    ).toEqual({ center: [2, 0, 0], radius: 2 });
  });

  it('never guesses: out of range, or data not yet arrived, is unknown', () => {
    const edge = byId(issues, RepairIssueId.NonManifoldEdges);
    const empty = {
      detail: undefined,
      renderPositions: undefined,
      selfIntersection: undefined,
      rim: undefined,
    };
    expect(locateOccurrence(edge, 7, { ...empty, detail: detailWith() })).toBeUndefined();
    expect(locateOccurrence(edge, 0, empty)).toBeUndefined();
    const face = byId(issues, RepairIssueId.DegenerateFaces);
    expect(locateOccurrence(face, 0, { ...empty, detail: detailWith() })).toBeUndefined();
  });
});
