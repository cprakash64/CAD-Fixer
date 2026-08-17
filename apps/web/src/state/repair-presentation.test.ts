import { describe, expect, it } from 'vitest';
import {
  BoundsComparison,
  RepairAcceptance,
  RepairDecision,
  RepairOperation,
  RepairReason,
  RepairRegression,
  VolumeComparison,
  type RepairOperationDecision,
  type RepairValidation,
  type TopologyReport,
} from '@cadfixer/geometry-runtime';
import {
  BOUNDARY_DELTA_NOTE,
  DeltaMeaning,
  NO_REPAIRS_AVAILABLE_HEADLINE,
  REPAIR_APPLIED_DETAIL,
  REPAIR_APPLIED_HEADLINE,
  REPAIR_EXCLUSIONS,
  REPAIR_FORBIDDEN_TERMS,
  REPAIR_OPERATION_COPY,
  REPAIR_OPERATION_ORDER,
  REPAIR_QUALIFIER,
  REPAIR_WORKFLOW_SUMMARY,
  REPAIR_WORKFLOW_TITLE,
  RepairDecisionTone,
  RESOURCE_LIMIT_DETAIL,
  buildMetricRows,
  describeAnalysisDependency,
  describeApplied,
  describeBoundsComparison,
  describeChangeSampling,
  describeNoRepairsAvailable,
  describeReason,
  describeRegression,
  describeVolumeComparison,
  describeVolumeComparisonHelp,
  presentAcceptance,
  presentDecision,
  type AnalysisLifecycle,
} from './repair-presentation';

/**
 * Wording is tested because wording is the product's honesty surface. A repair
 * panel that says "all errors fixed" about a model whose self-intersections were
 * never checked is a correctness bug, not a copy problem — and so is one that
 * styles a considered refusal as a failure.
 */

function decision(overrides: Partial<RepairOperationDecision> = {}): RepairOperationDecision {
  return {
    operation: RepairOperation.RemoveDuplicateFaces,
    decision: RepairDecision.Applicable,
    reason: RepairReason.NoDefectPresent,
    targetedCount: 2,
    expectedFaceMutations: 2,
    ...overrides,
  };
}

function reportWith(overrides: Partial<TopologyReport> = {}): TopologyReport {
  return {
    sourceFaceCount: 10,
    topologicalVertexCount: 8,
    componentCount: 1,
    boundaryEdgeCount: 0,
    nonManifoldEdgeCount: 0,
    nonManifoldVertexCount: 0,
    windingConflictEdgeCount: 0,
    sameOrientationDuplicateCount: 0,
    reversedOrientationDuplicateCount: 0,
    repeatedPositionFaceCount: 0,
    zeroAreaFaceCount: 0,
    totalSurfaceArea: 100,
    totalSignedVolume: 50,
    ...overrides,
  } as unknown as TopologyReport;
}

function validationWith(overrides: Partial<RepairValidation> = {}): RepairValidation {
  return {
    schemaVersion: 1,
    acceptance: RepairAcceptance.Accepted,
    requested: [],
    applied: [],
    before: reportWith(),
    after: reportWith(),
    deltas: {} as RepairValidation['deltas'],
    structurallyValid: true,
    surfaceAreaBefore: 100,
    surfaceAreaAfter: 100,
    volumeComparison: VolumeComparison.Unchanged,
    signedVolumeBefore: 50,
    signedVolumeAfter: 50,
    boundsComparison: BoundsComparison.Identical,
    boundsBefore: undefined,
    boundsAfter: undefined,
    regressions: [],
    warnings: [],
    selfIntersectionStatus: 'not-checked',
    planHash: 'abcd',
    ...overrides,
  };
}

/** Every user-visible string this module can produce. */
function everyEmittedString(): string {
  const parts: string[] = [
    REPAIR_WORKFLOW_TITLE,
    REPAIR_WORKFLOW_SUMMARY,
    REPAIR_QUALIFIER,
    REPAIR_APPLIED_HEADLINE,
    REPAIR_APPLIED_DETAIL,
    NO_REPAIRS_AVAILABLE_HEADLINE,
    RESOURCE_LIMIT_DETAIL,
    BOUNDARY_DELTA_NOTE,
    ...REPAIR_EXCLUSIONS,
    describeNoRepairsAvailable(true),
    describeNoRepairsAvailable(false),
    describeApplied([]),
    describeApplied([RepairOperation.RemoveDuplicateFaces, RepairOperation.UnifyWinding]),
    describeChangeSampling(1, 5) ?? '',
  ];

  for (const operation of Object.values(RepairOperation)) {
    parts.push(REPAIR_OPERATION_COPY[operation].label, REPAIR_OPERATION_COPY[operation].help);
  }
  for (const value of Object.values(RepairDecision)) {
    for (const reason of Object.values(RepairReason)) {
      const presented = presentDecision(decision({ decision: value, reason }));
      parts.push(presented.verdict, presented.reason);
    }
  }
  for (const value of Object.values(RepairAcceptance)) {
    const presented = presentAcceptance(value, Object.values(RepairRegression));
    parts.push(presented.headline, presented.qualifier, presented.detail);
  }
  for (const value of Object.values(RepairRegression)) parts.push(describeRegression(value));
  for (const value of Object.values(RepairReason))
    parts.push(describeReason(decision({ reason: value })));
  for (const value of Object.values(VolumeComparison)) {
    parts.push(describeVolumeComparison(value), describeVolumeComparisonHelp(value));
  }
  for (const value of Object.values(BoundsComparison)) parts.push(describeBoundsComparison(value));
  for (const row of buildMetricRows(validationWith())) {
    parts.push(row.label, row.note ?? '');
  }

  return parts.join(' \n ').toLowerCase();
}

describe('forbidden claims', () => {
  it('emits no term the engine cannot support', () => {
    const emitted = everyEmittedString();

    for (const term of REPAIR_FORBIDDEN_TERMS) {
      // "hole" is checked on a word boundary rather than as a substring, so a
      // legitimate "whole" cannot fail the test for the wrong reason. Every
      // other term is a phrase and is checked as one.
      const pattern =
        term === 'hole' ? /\bholes?\b/ : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      expect(emitted, `forbidden term: ${term}`).not.toMatch(pattern);
    }
  });

  it('never claims a repaired model faces outward', () => {
    const emitted = everyEmittedString();

    // The disclaimers DO contain "outward"; what must not exist is a claim.
    expect(emitted).not.toMatch(/faces outward|facing outward|outward-facing/);
    expect(emitted).toContain('never decides which side is outside');
  });

  it('states the unchecked qualifier on every acceptance verdict, including success', () => {
    for (const value of Object.values(RepairAcceptance)) {
      expect(presentAcceptance(value).qualifier).toBe(REPAIR_QUALIFIER);
    }
    expect(REPAIR_QUALIFIER).toBe(
      'Self-intersections and wall thickness have not yet been checked.',
    );
  });

  it('names the workflow conservatively rather than as general repair', () => {
    expect(REPAIR_WORKFLOW_TITLE).toBe('Conservative repair');
    expect(REPAIR_WORKFLOW_SUMMARY.toLowerCase()).not.toMatch(/everything|all errors|automatic/);
  });

  it('lists what the workflow does not do, on screen rather than only in docs', () => {
    const joined = REPAIR_EXCLUSIONS.join(' ').toLowerCase();

    expect(joined).toContain('no tolerance');
    expect(joined).toContain('openings in the surface');
    expect(joined).toContain('non-manifold');
    expect(joined).toContain('self-intersections');
    expect(joined).toContain('which side of the surface is outside');
    expect(joined).toContain('whether a model will print');
  });
});

describe('operation decisions', () => {
  it('lists operations in the engine’s pipeline order', () => {
    expect([...REPAIR_OPERATION_ORDER]).toEqual([
      RepairOperation.RemoveDuplicateFaces,
      RepairOperation.RemoveRepeatedPositionFaces,
      RepairOperation.RemoveZeroAreaFaces,
      RepairOperation.UnifyWinding,
    ]);
  });

  it('keeps repeated-position and zero-area as separate operations', () => {
    // Different defects with different risks. Folding them into one counter
    // would hide which was actually removed.
    expect(REPAIR_OPERATION_COPY[RepairOperation.RemoveRepeatedPositionFaces].label).not.toBe(
      REPAIR_OPERATION_COPY[RepairOperation.RemoveZeroAreaFaces].label,
    );
    expect(REPAIR_OPERATION_COPY[RepairOperation.RemoveRepeatedPositionFaces].help).toContain(
      'fewer than three distinct corners',
    );
    expect(REPAIR_OPERATION_COPY[RepairOperation.RemoveZeroAreaFaces].help).toContain('collinear');
  });

  it('offers an applicable operation for selection and says what it would do', () => {
    const presented = presentDecision(decision());

    expect(presented.verdict).toBe('Can be repaired conservatively');
    expect(presented.tone).toBe(RepairDecisionTone.Available);
    expect(presented.selectable).toBe(true);
    expect(presented.reason).toContain('2 triangles would be removed');
  });

  it('treats a REFUSAL as withheld, never as an error', () => {
    const presented = presentDecision(
      decision({
        decision: RepairDecision.RefusedUnsafe,
        reason: RepairReason.RemovalIntroducesBoundary,
      }),
    );

    expect(presented.verdict).toBe('Not changed automatically');
    expect(presented.tone).toBe(RepairDecisionTone.Withheld);
    // A refused operation cannot be selected: selecting it would produce a plan
    // that refuses it again, which reads as the checkbox not working.
    expect(presented.selectable).toBe(false);
    expect(presented.reason.toLowerCase()).not.toMatch(/error|failed|broken/);
    expect(presented.reason).toContain('leave the surface open');
  });

  it('treats a BLOCKED precondition as withheld and explains the topology', () => {
    const presented = presentDecision(
      decision({
        operation: RepairOperation.UnifyWinding,
        decision: RepairDecision.BlockedByPrecondition,
        reason: RepairReason.NonManifoldVertexPresent,
      }),
    );

    expect(presented.tone).toBe(RepairDecisionTone.Withheld);
    expect(presented.selectable).toBe(false);
    expect(presented.reason).toContain('single continuous fan');
  });

  it('distinguishes “nothing to fix” from “you did not ask”', () => {
    const notPresent = presentDecision(
      decision({
        decision: RepairDecision.NotNeeded,
        reason: RepairReason.NoDefectPresent,
        targetedCount: 0,
      }),
    );
    const notAsked = presentDecision(
      decision({
        decision: RepairDecision.NotNeeded,
        reason: RepairReason.NotRequested,
        targetedCount: 3,
      }),
    );

    expect(notPresent.verdict).toBe('No matching issue found');
    expect(notAsked.verdict).toBe('Not selected');
    expect(notAsked.reason).toContain('3 instances');
    // Both remain selectable: neither is a refusal.
    expect(notPresent.selectable).toBe(true);
    expect(notAsked.selectable).toBe(true);
  });

  it('says when an earlier operation in the plan already resolves the defect', () => {
    /*
     * The reachable third case. Winding is solved on the POST-REMOVAL topology,
     * so a model with three winding conflicts that all vanish once a duplicate
     * is removed reports NOT_NEEDED with a non-zero target count. Saying "CAD
     * Fixer found none" there would contradict Mesh Health on the same screen.
     */
    const presented = presentDecision(
      decision({
        operation: RepairOperation.UnifyWinding,
        decision: RepairDecision.NotNeeded,
        reason: RepairReason.NoDefectPresent,
        targetedCount: 3,
        expectedFaceMutations: 0,
      }),
    );

    expect(presented.verdict).toBe('Already resolved by this plan');
    expect(presented.reason).toContain('3 instances');
    expect(presented.reason).toContain('earlier operations in this plan');
  });

  it('has a distinct sentence for every machine reason', () => {
    const sentences = Object.values(RepairReason).map((reason) =>
      describeReason(decision({ reason })),
    );

    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
  });
});

describe('acceptance verdicts', () => {
  it('says a validated candidate is NOT applied yet', () => {
    const presented = presentAcceptance(RepairAcceptance.Accepted);

    expect(presented.headline).toBe('Repair validated — not applied yet');
    expect(presented.previewable).toBe(true);
    expect(presented.detail).toContain('Nothing has changed yet');
  });

  it('offers no preview for any outcome other than ACCEPTED', () => {
    for (const value of Object.values(RepairAcceptance)) {
      if (value === RepairAcceptance.Accepted) continue;
      expect(presentAcceptance(value).previewable, `${value} must not be previewable`).toBe(false);
    }
  });

  it('explains a rejection with the regressions that caused it, and says the model is unchanged', () => {
    const presented = presentAcceptance(RepairAcceptance.RejectedRegression, [
      RepairRegression.BoundaryEdgesIncreased,
    ]);

    expect(presented.detail).toContain('left open in places the plan did not predict');
    expect(presented.detail).toContain('Your model is unchanged');
    expect(presented.retryable).toBe(true);
  });

  it('treats a resource refusal as a limit rather than a fault, and never suggests reloading', () => {
    const presented = presentAcceptance(RepairAcceptance.ResourceLimit);

    expect(presented.detail).toBe(RESOURCE_LIMIT_DETAIL);
    expect(presented.detail).toContain('safety limit');
    expect(presented.detail).toContain('still loaded');
    expect(presented.detail.toLowerCase()).not.toContain('reload');
    // Retrying an identical refusal would be a button that cannot help.
    expect(presented.retryable).toBe(false);
  });
});

describe('the change summary', () => {
  it('marks every difference on an ACCEPTED candidate as expected', () => {
    /*
     * PART F1. Removing a duplicate can REVEAL boundary edges the duplicate was
     * hiding — two coincident triangles pair each other's edges and look closed.
     * The engine predicted that exact count before rebuilding and confirmed it
     * afterwards, so calling it an error would invent a problem the engine
     * explicitly reasoned about and allowed.
     */
    const rows = buildMetricRows(
      validationWith({
        before: reportWith({ boundaryEdgeCount: 0, sameOrientationDuplicateCount: 1 }),
        after: reportWith({ boundaryEdgeCount: 3, sameOrientationDuplicateCount: 0 }),
      }),
    );

    const boundary = rows.find((row) => row.key === 'boundaryEdges');
    expect(boundary?.before).toBe(0);
    expect(boundary?.after).toBe(3);
    expect(boundary?.delta).toBe(3);
    expect(boundary?.meaning).toBe(DeltaMeaning.Expected);
    expect(boundary?.note).toContain('coincident triangles pair each other');
  });

  it('marks a difference on a REJECTED candidate as a regression', () => {
    const rows = buildMetricRows(
      validationWith({
        acceptance: RepairAcceptance.RejectedRegression,
        before: reportWith({ boundaryEdgeCount: 0 }),
        after: reportWith({ boundaryEdgeCount: 3 }),
      }),
    );

    expect(rows.find((row) => row.key === 'boundaryEdges')?.meaning).toBe(DeltaMeaning.Regression);
  });

  it('shows rows that did not move, so a user can see the check ran', () => {
    const rows = buildMetricRows(validationWith());

    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const row of rows) {
      expect(row.meaning).toBe(DeltaMeaning.Unchanged);
      // A note belongs to a change, not to a row that stayed put.
      expect(row.note).toBeUndefined();
    }
  });

  it('reminds the reader that reversed duplicates must never move', () => {
    const rows = buildMetricRows(
      validationWith({
        before: reportWith({ reversedOrientationDuplicateCount: 2 }),
        after: reportWith({ reversedOrientationDuplicateCount: 1 }),
      }),
    );

    expect(rows.find((row) => row.key === 'reversedDuplicates')?.note).toContain(
      'never removed by conservative repair',
    );
  });

  it('describes a volume change caused by orientation as exactly that', () => {
    expect(describeVolumeComparison(VolumeComparison.ChangedByOrientation)).toBe(
      'Changed because triangle orientation changed',
    );
    expect(describeVolumeComparisonHelp(VolumeComparison.ChangedByOrientation)).toContain(
      'says nothing about whether the model gained or lost material',
    );
  });

  it('attributes a bounding-box change to removed triangles when that explains it', () => {
    expect(describeBoundsComparison(BoundsComparison.ChangedExplainedByRemovedFaces)).toContain(
      'explained by removed triangles',
    );
    expect(describeBoundsComparison(BoundsComparison.ChangedUnexplained)).toContain(
      'not explained',
    );
  });
});

describe('sampling and completion', () => {
  it('says how many changes the viewport is showing when it cannot show them all', () => {
    expect(describeChangeSampling(256, 4000)).toBe('Showing 256 of 4,000 changes.');
    expect(describeChangeSampling(4, 4)).toBeUndefined();
  });

  it('reports a completed repair without claiming more than happened', () => {
    const message = describeApplied([
      RepairOperation.RemoveDuplicateFaces,
      RepairOperation.UnifyWinding,
    ]);

    expect(message).toContain('Conservative repair applied');
    expect(message).toContain('remove exact duplicate triangles');
    expect(message).toContain('unify relative face winding');
    expect(REPAIR_APPLIED_DETAIL).toContain('repaired and revalidated');
  });

  it('distinguishes a clean model from one whose defects need assisted repair', () => {
    expect(describeNoRepairsAvailable(true)).toContain('assisted or reconstructive repair');
    expect(describeNoRepairsAvailable(false)).toContain('not a statement about the entire model');
  });
});

describe('the analysis dependency', () => {
  /**
   * Repair is planned from a topology report, so every reason there might not be
   * one has to be distinguishable. Which sentence a user sees decides what they
   * should do next, and "no report" alone answers none of those questions.
   */
  it('asks for patience while analysis is running', () => {
    expect(describeAnalysisDependency('analyzing', false)).toContain('still running');
    // The hook's own view of "running" is honoured even before the state moves.
    expect(describeAnalysisDependency('idle', true)).toContain('still running');
  });

  it('says a cancelled analysis can be run again', () => {
    expect(describeAnalysisDependency('cancelled', false)).toContain('was cancelled');
    expect(describeAnalysisDependency('cancelled', false)).toContain('Run it again');
  });

  it('says a failed analysis leaves the model usable', () => {
    const message = describeAnalysisDependency('failed', false);

    expect(message).toContain('still loaded and can be viewed and exported');
    // Losing a model because its diagnostics failed would be its own data loss.
    expect(message.toLowerCase()).not.toContain('re-import');
  });

  it('says a report for a DIFFERENT revision cannot be planned from', () => {
    // The state immediately after applying or undoing a repair: the report on
    // screen describes geometry the model has moved past.
    expect(describeAnalysisDependency('ready', false)).toContain('different version of this model');
  });

  it('has a distinct sentence for every lifecycle state', () => {
    const states: readonly AnalysisLifecycle[] = [
      'unavailable',
      'idle',
      'analyzing',
      'ready',
      'failed',
      'cancelled',
    ];
    const sentences = states.map((state) => describeAnalysisDependency(state, false));

    // `idle` and `unavailable` share a sentence on purpose — both mean "no report
    // yet, nothing to do about it" — so five distinct answers for six states.
    expect(new Set(sentences).size).toBe(5);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
  });
});
