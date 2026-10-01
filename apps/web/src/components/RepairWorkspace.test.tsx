import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import {
  BoundaryFillScanStatus,
  PrintabilityStatus,
  RepairAcceptance,
  RepairDecision,
  RepairOperation,
  RepairReason,
  SelfIntersectionStatus,
  type BoundaryFillPlan,
  type ConservativeRepairPlan,
  type DocumentHandle,
  type DocumentRenderSnapshot,
  type PartDescriptor,
  type RepairCandidateHandle,
  type RepairOperationDecision,
  type RepairValidation,
  type TopologyDetail,
  type TopologyReport,
} from '@cadfixer/geometry-runtime';
import { RepairWorkspace } from './RepairWorkspace';
import { GeometryClientProvider } from '../runtime/client-context';
import { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from '../state/store-context';
import { WorkflowControllersProvider } from '../state/workflow-controllers';
import { WorkspaceStore } from '../state/workspace-store';
import {
  REPAIR_EXCLUSIONS,
  REPAIR_ISOLATION_HEADLINE,
  REPAIR_QUALIFIER,
} from '../state/repair-presentation';
import {
  NO_REPAIRABLE_PROBLEMS,
  NO_SAFE_REPAIRS,
  REPAIR_WORKSPACE_FORBIDDEN_TERMS,
} from '../state/repair-workspace-presentation';
import type { LoadedModel } from '../state/model';

/**
 * THE REPAIR WORKSPACE — REPAIR-UX-01, at component level.
 *
 * What is proved here is the SHAPE of the default screen: one primary action
 * that is always in the same place and always says why it is disabled, compact
 * issue rows, explanations behind ⓘ buttons, and the full report collapsed.
 * The pure decisions behind every sentence are in
 * `repair-workspace-presentation.test.ts`; the happy path against a real
 * worker is end to end. The worker here is stubbed and never replies, so the
 * store is driven directly and nothing can be reading a real result.
 */

function setIsolated(value: boolean): void {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    configurable: true,
    writable: true,
    value,
  });
}

beforeEach(() => {
  setIsolated(true);
});

afterEach(cleanup);

const PART = 'part-1';
const HANDLE = { documentId: 'model-1', revision: 1 } as DocumentHandle;

function renderWorkspace(
  configure: (store: WorkspaceStore) => void = () => undefined,
): WorkspaceStore {
  const store = new WorkspaceStore();
  configure(store);
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <WorkflowControllersProvider>
          <RepairWorkspace />
        </WorkflowControllersProvider>
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
  return store;
}

function partDescriptor(triangleCount = 4): PartDescriptor {
  return {
    partId: PART,
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount,
    vertexCount: triangleCount * 3,
    bounds: undefined,
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
  };
}

function loadModel(store: WorkspaceStore, triangleCount = 4): DocumentHandle {
  const render_: DocumentRenderSnapshot = {
    parts: [
      {
        partId: PART,
        transform: IDENTITY_PART_TRANSFORM,
        positions: new Float32Array(9),
        normals: new Float32Array(9),
        vertexCount: 3,
      },
    ],
  };
  const model: Omit<LoadedModel, 'revision'> = {
    handle: HANDLE,
    parts: [partDescriptor(triangleCount)],
    render: render_,
    source: {
      fileName: 'part.stl',
      fileBytes: 100,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount,
    vertexCount: triangleCount * 3,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 192,
  };
  const token = store.beginImport('part.stl');
  store.commitImport(token, model);
  return HANDLE;
}

function report(overrides: Partial<TopologyReport> = {}): TopologyReport {
  return {
    schemaVersion: 1,
    documentId: 'model-1',
    documentRevision: 1,
    partId: PART,
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

const DETAIL: TopologyDetail = {
  boundaryEdges: new Uint32Array(0),
  boundaryEdgesTruncated: false,
  nonManifoldEdges: new Uint32Array(0),
  nonManifoldEdgesTruncated: false,
  windingConflictEdges: new Uint32Array(0),
  windingConflictEdgesTruncated: false,
  degenerateFaces: new Uint32Array(0),
  degenerateFacesTruncated: false,
  sampleVertexIds: new Uint32Array(0),
  sampleVertexPositions: new Float32Array(0),
  sampleLimit: 64,
};

/**
 * Commits a report as if the worker had answered. Must run AFTER render: the
 * analysis hook starts its own automatic analysis on mount, and a report
 * committed before that would simply be superseded by it.
 */
function analyse(store: WorkspaceStore, overrides: Partial<TopologyReport> = {}): void {
  act(() => {
    const token = store.beginAnalysis(HANDLE, PART);
    store.commitAnalysis(token, HANDLE, PART, report(overrides), DETAIL, 1);
  });
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

function planWith(decisions: readonly RepairOperationDecision[]): ConservativeRepairPlan {
  const all = [
    RepairOperation.RemoveDuplicateFaces,
    RepairOperation.RemoveRepeatedPositionFaces,
    RepairOperation.RemoveZeroAreaFaces,
    RepairOperation.UnifyWinding,
  ].map((op) => decisions.find((entry) => entry.operation === op) ?? decision(op));
  return {
    schemaVersion: 1,
    documentId: 'model-1',
    partId: PART,
    sourceRevision: 1,
    reportVersion: 1,
    requested: all.map((entry) => entry.operation),
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

/** Installs a plan as if the worker had answered. Must run after render. */
function commitPlan(
  store: WorkspaceStore,
  plan: ConservativeRepairPlan,
  fill: BoundaryFillPlan = fillPlan(0),
): void {
  act(() => {
    const token = store.beginRepairPlan(HANDLE, PART, plan.requested);
    store.commitRepairPlan(token, HANDLE, plan, fill);
  });
}

function fillPlan(admitted: number, verified = true): BoundaryFillPlan {
  return {
    status: BoundaryFillScanStatus.Scanned,
    boundaryEdgeCount: 400,
    simpleLoopCount: 6,
    complexBoundaryCount: 7,
    admittedCount: admitted,
    admittedPatchFaces: admitted * 4,
    verified,
    loops: [],
    loopsTruncated: false,
    planHash: `bf-${String(admitted)}`,
  };
}

const DEGENERATE_PLAN = planWith([
  decision(RepairOperation.RemoveZeroAreaFaces, {
    decision: RepairDecision.Applicable,
    targetedCount: 2,
    expectedFaceMutations: 2,
  }),
]);

function validation(): RepairValidation {
  return {
    acceptance: RepairAcceptance.Accepted,
    regressions: [],
    warnings: [],
    before: report({ zeroAreaFaceCount: 2 }),
    after: report({ sourceFaceCount: 2 }),
    surfaceAreaBefore: 1,
    surfaceAreaAfter: 1,
    signedVolumeBefore: 1,
    signedVolumeAfter: 1,
    volumeComparison: 'UNCHANGED',
    boundsComparison: 'IDENTICAL',
  } as unknown as RepairValidation;
}

function commitPreview(store: WorkspaceStore): void {
  act(() => {
    const token = store.beginRepairPreview();
    if (token === undefined) throw new Error('no preview token');
    store.beginRepairCandidate(token);
    store.commitRepairCandidate(token, {
      candidate: { candidateId: 'c-1' } as unknown as RepairCandidateHandle,
      source: HANDLE,
      partId: PART,
      planHash: 'hash',
      validation: validation(),
      counts: {
        removedDuplicateFaces: 0,
        removedRepeatedPositionFaces: 0,
        removedZeroAreaFaces: 2,
        flippedFaces: 0,
        sourceFaceCount: 4,
        candidateFaceCount: 2,
      },
      samples: {
        removedDuplicateFaces: new Uint32Array(0),
        removedRepeatedPositionFaces: new Uint32Array(0),
        removedZeroAreaFaces: new Uint32Array(0),
        flippedFaces: new Uint32Array(0),
        truncated: false,
        sampleLimit: 256,
      },
      render: undefined,
      bounds: undefined,
      undoRetainedBytes: 0,
      boundaryFill: undefined,
    });
  });
}

function applied(store: WorkspaceStore, undoable: boolean): void {
  store.applyRepairResult({
    handle: { documentId: 'model-1', revision: 2 } as DocumentHandle,
    partId: PART,
    parts: [partDescriptor()],
    parentRevision: 1,
    recordId: 'record-1',
    appliedOperations: [RepairOperation.RemoveZeroAreaFaces],
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 12,
      removedZeroAreaFaces: 2,
      flippedFaces: 0,
      sourceFaceCount: 18,
      candidateFaceCount: 4,
    },
    undoable,
    render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
    bounds: undefined,
    triangleCount: 4,
    vertexCount: 12,
    residentBytes: 192,
  });
}

/* --------------------------------------------------------- primary action -- */

describe('the primary action', () => {
  it('exists, disabled, with no model — the same place every other workspace keeps its action', () => {
    renderWorkspace();
    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.queryByTestId('apply-repair')).toBeNull();
    expect(screen.queryByTestId('undo-repair')).toBeNull();
  });

  it('asks for an analysis first, and offers a cancel while one runs', () => {
    renderWorkspace(loadModel);
    // The hook starts the automatic analysis on mount; the stub never replies.
    expect(screen.getByTestId('analyze-mesh')).toBeDisabled();
    expect(screen.getByTestId('analyze-mesh')).toHaveTextContent('Analyzing…');
    expect(screen.getByTestId('cancel-analysis')).toBeEnabled();
    expect(screen.getByTestId('analysis-progress')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-repair')).toBeNull();
  });

  it('shows Repair model, disabled, while the plan is worked out', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-planning')).toBeInTheDocument();
  });

  it('enables Repair model for a current plan with applicable work, and says how much it covers', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2, nonManifoldVertexCount: 1, isVertexManifold: false });
    commitPlan(store, DEGENERATE_PLAN);

    const button = screen.getByTestId('preview-repair');
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Repair model');
    // Honest scope: one of the two detected types, and the rest named as such.
    expect(screen.getByTestId('repair-scope')).toHaveTextContent(
      '1 repairable issue type of 2 detected. 1 type will need other attention.',
    );
    expect(screen.getByTestId('issue-status-degenerate-faces')).toHaveTextContent(
      'Repair available',
    );
    expect(screen.getByTestId('issue-status-non-manifold-vertices')).toHaveTextContent(
      'Not automatically repairable',
    );
  });

  it('keeps Repair model visible but disabled, with the reason, when nothing safe can run', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { nonManifoldVertexCount: 155, isVertexManifold: false, componentCount: 39 });
    commitPlan(store, planWith([]));

    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-no-repairs')).toHaveTextContent(NO_SAFE_REPAIRS);
    // The longer reason is one ⓘ away, not on screen.
    const detail = screen.getByTestId('repair-no-repairs-detail');
    expect(detail).not.toBeVisible();
    fireEvent.click(screen.getByTestId('repair-no-repairs-info'));
    expect(detail).toBeVisible();
  });

  it('says there is nothing to repair on a model with no detected issue', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store);
    commitPlan(store, planWith([]));

    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-no-repairs')).toHaveTextContent(NO_REPAIRABLE_PROBLEMS);
  });

  it('becomes Apply repairs + Cancel preview once a validated preview exists', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    commitPreview(store);

    expect(screen.queryByTestId('preview-repair')).toBeNull();
    expect(screen.getByTestId('apply-repair')).toBeEnabled();
    expect(screen.getByTestId('apply-repair')).toHaveTextContent('Apply repairs');
    expect(screen.getByTestId('discard-preview')).toHaveTextContent('Cancel preview');
    expect(screen.getByTestId('repair-preview-ready')).toHaveTextContent(
      'nothing has changed until you apply it',
    );
    // The preview's metrics are one click away, not on screen.
    expect(screen.getByTestId('repair-metrics')).not.toBeVisible();
    fireEvent.click(screen.getByTestId('repair-preview-details-toggle'));
    expect(screen.getByTestId('repair-metrics')).toBeVisible();
  });

  it('refuses a stale plan: a report for another revision disables the action', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    expect(screen.getByTestId('preview-repair')).toBeEnabled();

    act(() => {
      applied(store, true);
    });
    // Revision 2 has no report yet: the action asks for analysis, and the
    // plan for revision 1 cannot be pressed.
    expect(screen.queryByTestId('preview-repair')).toBeNull();
    expect(screen.getByTestId('analyze-mesh')).toBeInTheDocument();
  });

  it('fails closed in a context that cannot stop a repair — disabled, with the reason', () => {
    setIsolated(false);
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });

    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.queryByTestId('cancel-repair')).toBeNull();
    expect(screen.queryByTestId('apply-repair')).toBeNull();
    expect(screen.queryByTestId('repair-operations')).toBeNull();
    expect(screen.getByTestId('repair-isolation-unavailable')).toHaveTextContent(
      REPAIR_ISOLATION_HEADLINE,
    );
    expect(screen.getByTestId('repair-isolation-detail')).toHaveTextContent(
      /cross-origin isolated/i,
    );
  });
});

/* ------------------------------------------------------------ applied result -- */

describe('after a repair has been applied', () => {
  it('lists what was fixed, qualifies it, and offers a single undo', () => {
    renderWorkspace((store) => {
      loadModel(store);
      applied(store, true);
    });

    expect(screen.getByTestId('repair-applied-headline')).toHaveTextContent(
      'Conservative repair applied',
    );
    expect(screen.getByTestId('repair-applied-changes')).toHaveTextContent(
      '14 degenerate triangles removed',
    );
    // The new revision has no report yet, so nothing claims what remains.
    expect(screen.getByTestId('repair-applied-remaining')).toHaveTextContent(
      'Checking the repaired mesh…',
    );
    expect(screen.getByTestId('repair-applied-detail')).toHaveTextContent(
      'Selected topological issues were repaired and revalidated.',
    );
    expect(screen.getByTestId('repair-applied-qualifier')).toHaveTextContent(REPAIR_QUALIFIER);
    expect(screen.getByTestId('undo-repair')).toBeEnabled();
  });

  it('names what remains from the NEW analysis, never "all fixed"', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
      applied(s, true);
    });
    const handle = { documentId: 'model-1', revision: 2 } as DocumentHandle;
    act(() => {
      const token = store.beginAnalysis(handle, PART);
      store.commitAnalysis(
        token,
        handle,
        PART,
        report({
          documentRevision: 2,
          boundaryEdgeCount: 3,
          simpleBoundaryLoopCount: 1,
          componentCount: 39,
        }),
        DETAIL,
        1,
      );
    });

    const remaining = screen.getByTestId('repair-applied-remaining');
    expect(remaining).toHaveTextContent('1 open boundaries');
    expect(remaining).toHaveTextContent('39 separate components');
  });

  it('disables undo and says so when the repair cannot be reversed', () => {
    renderWorkspace((store) => {
      loadModel(store);
      applied(store, false);
    });
    expect(screen.getByTestId('undo-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-undo-unavailable')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------ progressive disclosure -- */

describe('progressive disclosure', () => {
  function renderAnalysed(): WorkspaceStore {
    const store = renderWorkspace((s) => {
      loadModel(s, 1_988_877);
    });
    analyse(store, {
      sourceFaceCount: 1_988_877,
      boundaryEdgeCount: 400,
      simpleBoundaryLoopCount: 6,
      branchedBoundaryCount: 7,
      nonManifoldVertexCount: 155,
      isVertexManifold: false,
      isBoundaryFree: false,
      componentCount: 39,
    });
    // The reported model's shape: nothing for the four conservative operations,
    // four openings the worker admitted for filling.
    commitPlan(store, planWith([]), fillPlan(4));
    // The worker skips the openings walk above the filling ceiling.
    act(() => {
      const token = store.beginHoleFillListing(HANDLE, PART);
      store.commitHoleFillListing(token, {
        handle: HANDLE,
        partId: PART,
        inventoried: false,
        loopCount: 0,
        rows: [],
        truncated: false,
        partFaceCount: 1_988_877,
      });
    });
    return store;
  }

  it('shows compact rows by default and keeps the long explanations out of view', () => {
    renderAnalysed();

    // Issue TYPES, not occurrences.
    expect(screen.getByTestId('health-summary')).toHaveTextContent('1 error · 2 warnings');
    expect(screen.getByTestId('issue-detail-open-boundaries')).toHaveTextContent(
      '6 simple loops · 7 complex',
    );
    expect(screen.getByTestId('issue-status-open-boundaries')).toHaveTextContent(
      '4 fillable · 9 need attention',
    );
    expect(screen.getByTestId('issue-status-components')).toHaveTextContent('Review recommended');
    expect(screen.getByTestId('file-structure')).toHaveTextContent('File structure valid');

    // No prose walls: exclusions, filling limits, topology and the component
    // table are all present in the document and none is visible.
    expect(screen.getByTestId('repair-exclusions')).not.toBeVisible();
    expect(screen.getByTestId('hole-fill-limits')).not.toBeVisible();
    expect(screen.getByTestId('health-topology')).not.toBeVisible();
    expect(screen.getByTestId('issue-info-panel-open-boundaries')).not.toBeVisible();
    expect(screen.getByTestId('hole-fill-size-limit')).toHaveTextContent(
      'Choosing openings one at a time isn’t available at this part size.',
    );
    expect(screen.getByTestId('hole-fill-not-inventoried')).not.toBeVisible();
    fireEvent.click(screen.getByTestId('hole-fill-size-limit-info'));
    expect(screen.getByTestId('hole-fill-not-inventoried')).toHaveTextContent('1,988,877');
  });

  it('enables Repair model on a large part when filling openings is the only work (REPAIR-CORE-02 §42)', () => {
    renderAnalysed();
    const button = screen.getByTestId('preview-repair');
    expect(button).toBeEnabled();
    expect(screen.getByTestId('repair-scope')).toHaveTextContent(
      '4 openings can be filled. Other detected issues will remain.',
    );
    expect(screen.getByTestId('repair-op-status-fill-openings')).toHaveTextContent('4 to fill');
  });

  it('turning filling off disables Repair model when nothing else can run', () => {
    const store = renderAnalysed();
    fireEvent.click(screen.getByTestId('repair-op-toggle-fill-openings'));
    expect(store.getSnapshot().repair.fillOpenings).toBe(false);
    expect(screen.getByTestId('issue-status-open-boundaries')).toHaveTextContent(
      'Automatic filling not selected',
    );
  });

  it('starts Advanced diagnostics collapsed and reveals the full report when opened', () => {
    renderAnalysed();

    const section = screen.getByTestId('advanced-diagnostics');
    const toggle = within(section).getByRole('button', { name: 'Advanced diagnostics' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('health-topology')).toBeVisible();
    expect(screen.getByTestId('topo-nonmanifold-vertices')).toHaveTextContent('155');
    const exclusions = within(screen.getByTestId('repair-exclusions')).getAllByRole('listitem');
    expect(exclusions).toHaveLength(REPAIR_EXCLUSIONS.length);
    expect(screen.getByTestId('hole-fill-limits')).toBeVisible();
  });

  it('keeps a way to re-run a finished analysis, in Advanced diagnostics', () => {
    // Regression: the redesign first removed Mesh Health's re-run control along
    // with the analysis lifecycle, leaving no way to analyse a current model again.
    renderAnalysed();
    const rerun = screen.getByTestId('rerun-analysis');
    expect(rerun).not.toBeVisible();
    fireEvent.click(
      within(screen.getByTestId('advanced-diagnostics')).getByRole('button', {
        name: 'Advanced diagnostics',
      }),
    );
    expect(rerun).toBeVisible();
    fireEvent.click(rerun);
    // The analysis restarts: the footer shows its progress and Cancel.
    expect(screen.getByTestId('cancel-analysis')).toBeInTheDocument();
  });

  it('opens an ⓘ by click, closes it with Escape and returns focus to the button', () => {
    renderAnalysed();

    const button = screen.getByTestId('issue-info-non-manifold-vertices');
    const panel = screen.getByTestId('issue-info-panel-non-manifold-vertices');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAccessibleName('About Non-manifold vertices');
    expect(button.getAttribute('aria-controls')).toBe(panel.id);

    fireEvent.click(button);
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent('What it means');
    expect(panel).toHaveTextContent('What Pybrix can do');
    expect(panel).toHaveTextContent('When it cannot');

    within(panel).getByRole('button', { name: 'Close' }).focus();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(panel).not.toBeVisible();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(button);
  });

  it('reports a self-intersection check that did not run as not checked, never as zero', () => {
    renderAnalysed();
    expect(screen.getByTestId('issue-count-self-intersections')).toHaveTextContent('—');
    expect(screen.getByTestId('self-intersection-headline')).toHaveTextContent(
      'Not checked — model exceeds automatic check size',
    );
    // No button above the ceiling, not even a disabled one.
    expect(screen.queryByTestId('run-self-intersection')).toBeNull();
  });

  it('never emits a forbidden claim anywhere in the workspace', () => {
    renderAnalysed();
    const text = screen.getByTestId('repair-workspace').textContent;
    for (const term of REPAIR_WORKSPACE_FORBIDDEN_TERMS) {
      expect(text).not.toMatch(new RegExp(`\\b${term}\\b`, 'i'));
    }
  });
});

/* ---------------------------------------------------- WORKSPACE-UX-03 -- */

/** The lines the action region is DRAWING — not the ones it only speaks. */
function drawnLines(footer: HTMLElement): number {
  return footer.querySelectorAll(
    '.action-footer__line, .convert-footer__hint, .repair-footer__progress',
  ).length;
}

describe('the bounded action region', () => {
  it('holds the action row and one line while a preview is ready', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    commitPreview(store);

    const footer = screen.getByTestId('repair-footer');
    expect(footer).toHaveClass('action-footer');
    expect(drawnLines(footer)).toBe(1);
    expect(footer).toContainElement(screen.getByTestId('repair-preview-ready'));
    // What Apply does is still said — as the button's description, not a line.
    expect(screen.getByTestId('apply-repair')).toHaveAccessibleDescription(
      'Apply replaces the model with the validated preview. You can undo it.',
    );
    // The preview's review is content.
    expect(footer).not.toContainElement(screen.getByTestId('repair-candidate'));
  });

  it('keeps the applied result and its Undo out of the action region', () => {
    renderWorkspace((store) => {
      loadModel(store);
      applied(store, true);
    });

    const footer = screen.getByTestId('repair-footer');
    expect(footer).not.toContainElement(screen.getByTestId('repair-applied'));
    expect(footer).not.toContainElement(screen.getByTestId('undo-repair'));
    expect(
      screen.getByTestId('undo-repair').closest('.convert-workspace__sections'),
    ).not.toBeNull();
    expect(drawnLines(footer)).toBeLessThanOrEqual(1);
  });

  it('states a failure as a headline, with the message in the scrolling content', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    const message =
      'The preview could not be built because the working memory it needs is larger than this browser session allows for a part of this size.';
    act(() => {
      const token = store.beginRepairPreview();
      if (token === undefined) throw new Error('no preview token');
      store.beginRepairCandidate(token);
      store.failRepairCandidate(token, { message, code: 'RESOURCE_LIMIT', retryable: true });
    });

    const footer = screen.getByTestId('repair-footer');
    const alert = screen.getByTestId('repair-candidate-error');
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(footer).not.toContainElement(alert);
    expect(alert.closest('.workspace-outcome')).not.toBeNull();
    expect(screen.getByTestId('repair-failure-line')).toHaveTextContent('No preview was made');
    expect(footer).not.toHaveTextContent(message);
    expect(drawnLines(footer)).toBe(1);
    // One alert for one failure.
    expect(within(footer).queryByRole('alert')).toBeNull();
  });

  it('opens the reason behind ⓘ in the scrolling content, never in the region', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { nonManifoldVertexCount: 3 });
    commitPlan(store, planWith([]));

    const footer = screen.getByTestId('repair-footer');
    const detail = screen.getByTestId('repair-no-repairs-detail');
    fireEvent.click(screen.getByTestId('repair-no-repairs-info'));
    expect(detail).toBeVisible();
    expect(footer).not.toContainElement(detail);
    expect(footer).toContainElement(screen.getByTestId('repair-no-repairs-info'));
  });
});
