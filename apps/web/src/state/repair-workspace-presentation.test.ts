import { describe, expect, it } from 'vitest';
import {
  HOLE_FILL_MAX_PART_FACES,
  RepairDecision,
  RepairOperation,
  RepairReason,
  type ConservativeRepairPlan,
  type RepairOperationDecision,
} from '@cadfixer/geometry-runtime';
import { IssueSeverity, RepairIssueId, type RepairIssue } from './repair-issues';
import {
  ADVANCED_INFO,
  FILE_STRUCTURE_INFO,
  Fixability,
  HOLE_FILL_SIZE_LIMIT_LINE,
  ISSUE_INFO,
  NO_REPAIRABLE_PROBLEMS,
  NO_SAFE_REPAIRS,
  PREVIEW_READY_LINE,
  REPAIRS_APPLIED_LINE,
  REPAIR_MODEL_ACTION,
  REPAIR_MODEL_SUPPORT,
  REPAIR_OPTIONS_INFO,
  REPAIR_OPTION_LABELS,
  REPAIR_UNAVAILABLE_LINE,
  REPAIR_WORKSPACE_FORBIDDEN_TERMS,
  RepairActionKind,
  SUMMARY_INFO,
  deriveIssueStatus,
  deriveRepairAction,
  deriveRepairScope,
  describeAppliedChanges,
  describeFileStructure,
  describeOptionStatus,
  describeRemaining,
  describeRepairScope,
  type IssueStatus,
  type IssueStatusContext,
  type RepairActionInput,
} from './repair-workspace-presentation';

/* ---------------------------------------------------------------- helpers -- */

function issue(
  id: RepairIssueId,
  count: number | undefined,
  severity?: IssueSeverity,
): RepairIssue {
  return {
    id,
    label: id,
    help: '',
    severity:
      severity ??
      (count === undefined
        ? IssueSeverity.Unchecked
        : count === 0
          ? IssueSeverity.Ok
          : IssueSeverity.Warning),
    count,
    unit: ['thing', 'things'],
    occurrenceSource: 'none',
    occurrenceCount: 0,
    occurrencesPartial: false,
  };
}

function decision(
  operation: RepairOperation,
  overrides: Partial<RepairOperationDecision> = {},
): RepairOperationDecision {
  return {
    operation,
    decision: RepairDecision.NotNeeded,
    reason: RepairReason.NoDefectPresent,
    targetedCount: 0,
    expectedFaceMutations: 0,
    ...overrides,
  };
}

function plan(decisions: readonly RepairOperationDecision[]): ConservativeRepairPlan {
  const all = [
    RepairOperation.RemoveDuplicateFaces,
    RepairOperation.RemoveRepeatedPositionFaces,
    RepairOperation.RemoveZeroAreaFaces,
    RepairOperation.UnifyWinding,
  ].map(
    (operation) => decisions.find((entry) => entry.operation === operation) ?? decision(operation),
  );
  return {
    schemaVersion: 1,
    documentId: 'model-1',
    partId: 'part-1',
    sourceRevision: 1,
    reportVersion: 1,
    requested: [],
    order: [],
    decisions: all,
    memory: {
      candidateBytes: 0,
      workspaceBytes: 0,
      validationBytes: 0,
      undoRetainedBytes: 0,
      peakBytes: 0,
    },
    warnings: [],
    planHash: 'hash',
    noOp: !all.some((entry) => entry.decision === RepairDecision.Applicable),
  };
}

function context(overrides: Partial<IssueStatusContext> = {}): IssueStatusContext {
  return {
    plan: plan([]),
    boundaries: { simpleLoops: 0, openChains: 0, branched: 0 },
    partFaceCount: 1_000,
    selfIntersectionSizeLimited: false,
    ...overrides,
  };
}

function action(overrides: Partial<RepairActionInput> = {}): RepairActionKind {
  return deriveRepairAction({
    hasModel: true,
    isolationSupported: true,
    reportIsCurrent: true,
    isAnalyzing: false,
    planState: 'ready',
    planNoOp: false,
    candidateState: 'idle',
    commitState: 'idle',
    detectedIssueTypes: 1,
    ...overrides,
  });
}

/* ------------------------------------------------------ CTA state machine -- */

describe('the primary action state machine', () => {
  it('asks for an analysis before anything can be repaired (state A)', () => {
    expect(action({ reportIsCurrent: false, planState: 'unavailable', planNoOp: undefined })).toBe(
      RepairActionKind.Analyze,
    );
    expect(action({ isAnalyzing: true, reportIsCurrent: false })).toBe(RepairActionKind.Analyzing);
  });

  it('offers Repair model only for a current plan with applicable work (state B)', () => {
    expect(action()).toBe(RepairActionKind.Ready);
    expect(action({ planState: 'planning', planNoOp: undefined })).toBe(RepairActionKind.Planning);
    // A plan object without a current noOp answer is not a plan to act on.
    expect(action({ planNoOp: undefined })).toBe(RepairActionKind.Planning);
    expect(action({ planState: 'failed' })).toBe(RepairActionKind.PlanFailed);
  });

  it('turns into Apply once a validated preview exists (state C), and outranks planning', () => {
    expect(action({ candidateState: 'ready' })).toBe(RepairActionKind.Preview);
    expect(action({ candidateState: 'ready', planState: 'planning' })).toBe(
      RepairActionKind.Preview,
    );
    expect(action({ candidateState: 'building' })).toBe(RepairActionKind.Building);
    expect(action({ candidateState: 'cancelling' })).toBe(RepairActionKind.Building);
  });

  it('reports commits in flight above everything else', () => {
    expect(action({ candidateState: 'ready', commitState: 'applying' })).toBe(
      RepairActionKind.Applying,
    );
    expect(action({ commitState: 'undoing' })).toBe(RepairActionKind.Undoing);
  });

  it('distinguishes "nothing safe" from "nothing found" (state E)', () => {
    expect(action({ planNoOp: true, detectedIssueTypes: 3 })).toBe(RepairActionKind.NothingSafe);
    expect(action({ planNoOp: true, detectedIssueTypes: 0 })).toBe(RepairActionKind.NothingFound);
  });

  it('fails closed without a model or an interruptible context', () => {
    expect(action({ hasModel: false })).toBe(RepairActionKind.NoModel);
    expect(action({ isolationSupported: false, candidateState: 'ready' })).toBe(
      RepairActionKind.Unavailable,
    );
  });

  it('never lets an in-flight analysis hide a stale report behind Repair model', () => {
    // A stale report with a plan still in the store must not enable the action.
    expect(action({ reportIsCurrent: false, planState: 'ready', planNoOp: false })).toBe(
      RepairActionKind.Analyze,
    );
  });
});

/* ------------------------------------------------------------ fixability -- */

describe('issue fixability', () => {
  it('says "Not checked" rather than zero, and names the size limit for self-intersections', () => {
    expect(deriveIssueStatus(issue(RepairIssueId.SelfIntersections, undefined), context())).toEqual(
      {
        fixability: Fixability.CheckNotRun,
        text: 'Not checked',
      },
    );
    expect(
      deriveIssueStatus(
        issue(RepairIssueId.SelfIntersections, undefined),
        context({ selfIntersectionSizeLimited: true }),
      ).text,
    ).toBe('Not checked — model exceeds automatic check size');
  });

  it('marks a zero count as no issue, except a single component which is simply one piece', () => {
    expect(deriveIssueStatus(issue(RepairIssueId.NonManifoldEdges, 0), context()).fixability).toBe(
      Fixability.NoIssue,
    );
    expect(deriveIssueStatus(issue(RepairIssueId.Components, 1), context()).fixability).toBe(
      Fixability.NoIssue,
    );
  });

  it('never calls separate components a defect to repair', () => {
    const status = deriveIssueStatus(issue(RepairIssueId.Components, 39), context());
    expect(status.fixability).toBe(Fixability.Review);
    expect(status.text).toMatch(/review recommended/i);
  });

  it('reports non-manifold geometry and self-intersections as not automatically repairable', () => {
    for (const id of [
      RepairIssueId.NonManifoldEdges,
      RepairIssueId.NonManifoldVertices,
      RepairIssueId.SelfIntersections,
    ]) {
      expect(deriveIssueStatus(issue(id, 155, IssueSeverity.Error), context()).fixability).toBe(
        Fixability.NotRepairable,
      );
    }
  });

  it('splits open boundaries into simple and complex, and states the part-size limit', () => {
    const boundaries = { simpleLoops: 6, openChains: 2, branched: 5 };
    const large = deriveIssueStatus(
      issue(RepairIssueId.OpenBoundaries, 13),
      context({ boundaries, partFaceCount: 1_988_877 }),
    );
    expect(large).toEqual({
      fixability: Fixability.ResourceLimit,
      text: 'Automatic filling isn’t available at this part size',
      detail: '6 simple loops · 7 complex',
    });

    const small = deriveIssueStatus(
      issue(RepairIssueId.OpenBoundaries, 13),
      context({ boundaries, partFaceCount: HOLE_FILL_MAX_PART_FACES }),
    );
    expect(small.fixability).toBe(Fixability.Partial);

    // Branched-only boundaries are never presented as fillable.
    const complexOnly = deriveIssueStatus(
      issue(RepairIssueId.OpenBoundaries, 7),
      context({ boundaries: { simpleLoops: 0, openChains: 0, branched: 7 } }),
    );
    expect(complexOnly.fixability).toBe(Fixability.NotRepairable);
  });

  it('reads repairability from the plan decisions, never from the count alone', () => {
    const degenerate = issue(RepairIssueId.DegenerateFaces, 14);
    const both = context({
      plan: plan([
        decision(RepairOperation.RemoveRepeatedPositionFaces, {
          decision: RepairDecision.Applicable,
          reason: RepairReason.NoDefectPresent,
          targetedCount: 10,
          expectedFaceMutations: 10,
        }),
        decision(RepairOperation.RemoveZeroAreaFaces, {
          decision: RepairDecision.Applicable,
          targetedCount: 4,
          expectedFaceMutations: 4,
        }),
      ]),
    });
    expect(deriveIssueStatus(degenerate, both).fixability).toBe(Fixability.Repairable);

    const oneRefused = context({
      plan: plan([
        decision(RepairOperation.RemoveRepeatedPositionFaces, {
          decision: RepairDecision.Applicable,
          targetedCount: 10,
          expectedFaceMutations: 10,
        }),
        decision(RepairOperation.RemoveZeroAreaFaces, {
          decision: RepairDecision.RefusedUnsafe,
          reason: RepairReason.RemovalIntroducesBoundary,
          targetedCount: 4,
        }),
      ]),
    });
    expect(deriveIssueStatus(degenerate, oneRefused).fixability).toBe(Fixability.Partial);

    const refused = context({
      plan: plan([
        decision(RepairOperation.RemoveZeroAreaFaces, {
          decision: RepairDecision.RefusedUnsafe,
          reason: RepairReason.RemovalIntroducesBoundary,
          targetedCount: 4,
        }),
      ]),
    });
    expect(deriveIssueStatus(degenerate, refused).fixability).toBe(Fixability.NotRepairable);
  });

  it('says a repair is available but not selected when the user deselected it', () => {
    const status = deriveIssueStatus(
      issue(RepairIssueId.WindingConflicts, 3),
      context({
        plan: plan([
          decision(RepairOperation.UnifyWinding, {
            reason: RepairReason.NotRequested,
            targetedCount: 3,
          }),
        ]),
      }),
    );
    expect(status.fixability).toBe(Fixability.NotSelected);
  });

  it('counts a conflict an earlier operation resolves as repairable', () => {
    const status = deriveIssueStatus(
      issue(RepairIssueId.WindingConflicts, 3),
      context({
        plan: plan([
          decision(RepairOperation.UnifyWinding, {
            reason: RepairReason.NoDefectPresent,
            targetedCount: 3,
          }),
        ]),
      }),
    );
    expect(status.fixability).toBe(Fixability.Repairable);
  });

  it('keeps reversed duplicates honest', () => {
    const reversedOnly = deriveIssueStatus(issue(RepairIssueId.DuplicateFaces, 2), context());
    expect(reversedOnly.fixability).toBe(Fixability.NotRepairable);
    expect(reversedOnly.text).toMatch(/kept/);

    const exact = deriveIssueStatus(
      issue(RepairIssueId.DuplicateFaces, 2),
      context({
        plan: plan([
          decision(RepairOperation.RemoveDuplicateFaces, {
            decision: RepairDecision.Applicable,
            targetedCount: 1,
            expectedFaceMutations: 1,
          }),
        ]),
      }),
    );
    expect(exact.fixability).toBe(Fixability.Partial);
  });

  it('says it is still checking while the plan is being worked out', () => {
    expect(
      deriveIssueStatus(issue(RepairIssueId.WindingConflicts, 3), context({ plan: undefined })),
    ).toEqual({ fixability: Fixability.Pending, text: 'Checking…' });
  });
});

/* ------------------------------------------------------------ repair scope -- */

describe('the repair scope line', () => {
  it('counts issue TYPES Repair model acts on, and never the boundaries it cannot fill', () => {
    const issues = [
      issue(RepairIssueId.OpenBoundaries, 13),
      issue(RepairIssueId.NonManifoldVertices, 155, IssueSeverity.Error),
      issue(RepairIssueId.DegenerateFaces, 14),
      issue(RepairIssueId.Components, 39),
      issue(RepairIssueId.DuplicateFaces, 0),
    ];
    const statuses = new Map<RepairIssueId, IssueStatus>([
      [RepairIssueId.OpenBoundaries, { fixability: Fixability.Partial, text: '' }],
      [RepairIssueId.NonManifoldVertices, { fixability: Fixability.NotRepairable, text: '' }],
      [RepairIssueId.DegenerateFaces, { fixability: Fixability.Repairable, text: '' }],
      [RepairIssueId.Components, { fixability: Fixability.Review, text: '' }],
    ]);
    const scope = deriveRepairScope(issues, statuses);
    expect(scope).toEqual({ detected: 4, repairable: 1 });
    expect(describeRepairScope(scope)).toBe(
      '1 repairable issue type of 4 detected. 3 types will need other attention.',
    );
    // A complete scope still promises only a review, never a result.
    expect(describeRepairScope({ detected: 2, repairable: 2 })).toBe(
      '2 repairable issue types of 2 detected. You review the result before anything changes.',
    );
    expect(describeRepairScope({ detected: 0, repairable: 0 })).toBe(REPAIR_MODEL_SUPPORT);
  });
});

/* ---------------------------------------------------------- applied result -- */

describe('the applied result', () => {
  it('lists only what actually changed, from the committed counts', () => {
    expect(
      describeAppliedChanges({
        removedDuplicateFaces: 0,
        removedRepeatedPositionFaces: 10,
        removedZeroAreaFaces: 4,
        flippedFaces: 1,
        sourceFaceCount: 100,
        candidateFaceCount: 86,
      }),
    ).toEqual(['14 degenerate triangles removed', '1 triangle reversed to match neighbours']);
  });

  it('lists what is still detected, never a check that has not run', () => {
    expect(
      describeRemaining([
        issue(RepairIssueId.OpenBoundaries, 13),
        issue(RepairIssueId.SelfIntersections, undefined),
        issue(RepairIssueId.DegenerateFaces, 0),
        issue(RepairIssueId.Components, 39),
      ]),
    ).toEqual(['13 open-boundaries', '39 components']);
  });
});

/* ---------------------------------------------------------- repair options -- */

describe('repair option status', () => {
  it('states each decision in a word or two', () => {
    expect(
      describeOptionStatus(
        decision(RepairOperation.RemoveDuplicateFaces, {
          decision: RepairDecision.Applicable,
          targetedCount: 2,
          expectedFaceMutations: 3,
        }),
      ),
    ).toBe('3 to remove');
    expect(
      describeOptionStatus(
        decision(RepairOperation.UnifyWinding, {
          decision: RepairDecision.Applicable,
          targetedCount: 2,
          expectedFaceMutations: 5,
        }),
      ),
    ).toBe('5 to reverse');
    expect(describeOptionStatus(decision(RepairOperation.RemoveZeroAreaFaces))).toBe('No matches');
    expect(
      describeOptionStatus(
        decision(RepairOperation.UnifyWinding, {
          decision: RepairDecision.BlockedByPrecondition,
          reason: RepairReason.NonManifoldVertexPresent,
          targetedCount: 2,
        }),
      ),
    ).toBe('Blocked');
    expect(
      describeOptionStatus(
        decision(RepairOperation.RemoveDuplicateFaces, {
          reason: RepairReason.NotRequested,
          targetedCount: 2,
        }),
      ),
    ).toBe('Not selected');
  });
});

/* ------------------------------------------------------------ vocabulary -- */

describe('vocabulary', () => {
  it('labels file structure so it cannot read as mesh health', () => {
    expect(describeFileStructure(true)).toBe('File structure valid');
    expect(FILE_STRUCTURE_INFO.cannot).toMatch(/does not mean the mesh is manifold/);
  });

  it('explains that the summary counts issue types, not occurrences', () => {
    expect(SUMMARY_INFO.meaning).toMatch(/issue TYPES, not individual occurrences/);
  });

  it('has an explanation for every issue row', () => {
    for (const id of Object.values(RepairIssueId)) {
      const info = ISSUE_INFO[id];
      expect(info.meaning.length).toBeGreaterThan(0);
      expect(info.canDo.length).toBeGreaterThan(0);
      expect(info.cannot.length).toBeGreaterThan(0);
    }
  });

  it('emits no forbidden term from any string it can produce', () => {
    const strings: string[] = [
      REPAIR_MODEL_ACTION,
      REPAIR_MODEL_SUPPORT,
      NO_SAFE_REPAIRS,
      NO_REPAIRABLE_PROBLEMS,
      PREVIEW_READY_LINE,
      REPAIRS_APPLIED_LINE,
      REPAIR_UNAVAILABLE_LINE,
      HOLE_FILL_SIZE_LIMIT_LINE,
      describeFileStructure(true),
      describeFileStructure(false),
      describeRepairScope({ detected: 5, repairable: 2 }),
      ...Object.values(REPAIR_OPTION_LABELS),
      ...[SUMMARY_INFO, REPAIR_OPTIONS_INFO, FILE_STRUCTURE_INFO, ADVANCED_INFO].flatMap((info) => [
        info.meaning,
        info.canDo,
        info.cannot,
      ]),
      ...Object.values(ISSUE_INFO).flatMap((info) => [info.meaning, info.canDo, info.cannot]),
    ];
    const contexts = [
      context(),
      context({ plan: undefined }),
      context({
        partFaceCount: 2_000_000,
        boundaries: { simpleLoops: 1, openChains: 1, branched: 1 },
      }),
      context({ selfIntersectionSizeLimited: true }),
    ];
    for (const id of Object.values(RepairIssueId)) {
      for (const count of [undefined, 0, 1, 7]) {
        for (const ctx of contexts) {
          const status = deriveIssueStatus(issue(id, count), ctx);
          strings.push(status.text, status.detail ?? '');
        }
      }
    }
    for (const text of strings) {
      for (const term of REPAIR_WORKSPACE_FORBIDDEN_TERMS) {
        // Whole words: "whole" is not "hole".
        expect(text, `"${text}" contains "${term}"`).not.toMatch(new RegExp(`\\b${term}\\b`, 'i'));
      }
    }
  });
});
