import { describe, expect, it } from 'vitest';
import type {
  ConservativeRepairPlan,
  MeshBounds,
  ModelHandle,
  RenderSnapshot,
  RepairCandidateHandle,
  RepairValidation,
} from '@cadfixer/geometry-runtime';
import {
  DEFAULT_REPAIR_SELECTION,
  RepairCandidateState,
  RepairCommitState,
  RepairPlanState,
  RepairPreviewMode,
  WorkspaceStore,
  type RepairPreview,
} from './workspace-store';
import type { LoadedModel } from './model';

/**
 * The repair slice of the workspace store.
 *
 * WHAT THESE TESTS ARE ABOUT: the gates. A plan, a candidate and a commit are
 * all asynchronous, and all of them can arrive after the model they describe has
 * been replaced. Every write is guarded by a token AND by a handle comparison,
 * and each guard has its own case here because either one alone leaves a path
 * for one model's repair to be shown beside another model's geometry.
 *
 * The store is deliberately framework-free, so none of this needs a DOM.
 */

function handle(revision: number, modelId = 'model-1'): ModelHandle {
  return { modelId, revision } as ModelHandle;
}

function render(): RenderSnapshot {
  return { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 };
}

function loadedModel(
  overrides: Partial<Omit<LoadedModel, 'revision'>> = {},
): Omit<LoadedModel, 'revision'> {
  return {
    handle: handle(1),
    render: render(),
    source: {
      fileName: 'part.stl',
      fileBytes: 100,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount: 6,
    vertexCount: 18,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 288,
    ...overrides,
  };
}

function planFor(handleValue: ModelHandle, noOp = false): ConservativeRepairPlan {
  return {
    schemaVersion: 1,
    modelId: handleValue.modelId,
    sourceRevision: handleValue.revision,
    reportVersion: 1,
    requested: DEFAULT_REPAIR_SELECTION,
    order: noOp ? [] : ['remove-duplicate-faces'],
    decisions: [],
    memory: {
      candidateBytes: 0,
      workspaceBytes: 0,
      validationBytes: 0,
      inverseBytes: 0,
      peakBytes: 0,
    },
    warnings: [],
    planHash: 'plan-hash',
    noOp,
  };
}

function previewFor(source: ModelHandle): RepairPreview {
  return {
    candidate: {
      candidateId: 'candidate-1',
      modelId: source.modelId,
      sourceRevision: source.revision,
      generation: 1,
    } as RepairCandidateHandle,
    source,
    planHash: 'plan-hash',
    validation: { acceptance: 'ACCEPTED' } as RepairValidation,
    counts: {
      removedDuplicateFaces: 1,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 0,
      sourceFaceCount: 6,
      candidateFaceCount: 5,
    },
    samples: {
      removedDuplicateFaces: new Uint32Array([0]),
      removedRepeatedPositionFaces: new Uint32Array(0),
      removedZeroAreaFaces: new Uint32Array(0),
      flippedFaces: new Uint32Array(0),
      truncated: false,
      sampleLimit: 256,
    },
    render: render(),
    bounds: undefined,
    inverseBytes: 128,
  };
}

/** A store with a model loaded, a plan installed, and a candidate ready. */
function storeWithCandidate(): { store: WorkspaceStore; source: ModelHandle } {
  const store = new WorkspaceStore();
  const token = store.beginImport('part.stl');
  store.commitImport(token, loadedModel());
  const source = handle(1);

  const planToken = store.beginRepairPlan(source, DEFAULT_REPAIR_SELECTION);
  store.commitRepairPlan(planToken, source, planFor(source));

  const previewToken = store.beginRepairPreview();
  if (previewToken === undefined) throw new Error('preview token was refused');
  store.beginRepairCandidate(previewToken);
  store.commitRepairCandidate(previewToken, previewFor(source));

  return { store, source };
}

describe('planning', () => {
  it('starts unavailable when no model is loaded', () => {
    const store = new WorkspaceStore();

    expect(store.getSnapshot().repair.planState).toBe(RepairPlanState.Unavailable);
    expect(store.getSnapshot().repair.plan).toBeUndefined();
    expect(store.getSnapshot().repair.selection).toEqual(DEFAULT_REPAIR_SELECTION);
  });

  it('installs a plan for the loaded model', () => {
    const store = new WorkspaceStore();
    const importToken = store.beginImport('part.stl');
    store.commitImport(importToken, loadedModel());

    const token = store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);
    expect(store.commitRepairPlan(token, handle(1), planFor(handle(1)))).toBe(true);
    expect(store.getSnapshot().repair.planState).toBe(RepairPlanState.Ready);
  });

  it('refuses a plan from a superseded attempt', () => {
    const store = new WorkspaceStore();
    const importToken = store.beginImport('part.stl');
    store.commitImport(importToken, loadedModel());

    const first = store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);
    const second = store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);

    expect(store.commitRepairPlan(first, handle(1), planFor(handle(1)))).toBe(false);
    expect(store.commitRepairPlan(second, handle(1), planFor(handle(1)))).toBe(true);
  });

  it('refuses a plan for a model that is no longer loaded', () => {
    // THE SECOND GATE. Even a current token must not install a plan describing
    // geometry the user has replaced.
    const store = new WorkspaceStore();
    const first = store.beginImport('one.stl');
    store.commitImport(first, loadedModel());
    const token = store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);

    const second = store.beginImport('two.stl');
    store.commitImport(second, loadedModel({ handle: handle(1, 'model-2') }));

    expect(store.commitRepairPlan(token, handle(1), planFor(handle(1)))).toBe(false);
    expect(store.getSnapshot().repair.plan).toBeUndefined();
  });

  it('keeps the previous plan on screen while a new selection is planned', () => {
    /*
     * Blanking the decision list on every checkbox click makes the panel lose
     * its place, and takes the focused control out of the document underneath a
     * keyboard user. `planState` says it is being recomputed instead.
     */
    const store = new WorkspaceStore();
    const importToken = store.beginImport('part.stl');
    store.commitImport(importToken, loadedModel());
    const token = store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);
    store.commitRepairPlan(token, handle(1), planFor(handle(1)));

    store.setRepairSelection(['unify-winding']);

    expect(store.getSnapshot().repair.plan).toBeDefined();
    expect(store.getSnapshot().repair.planState).toBe(RepairPlanState.Planning);
    expect(store.getSnapshot().repair.selection).toEqual(['unify-winding']);
  });

  it('refuses to start a preview while the plan is being recomputed', () => {
    // The plan on screen belongs to the previous selection; building from it
    // would apply something other than what the user is looking at.
    const store = new WorkspaceStore();
    const importToken = store.beginImport('part.stl');
    store.commitImport(importToken, loadedModel());
    const token = store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);
    store.commitRepairPlan(token, handle(1), planFor(handle(1)));

    store.setRepairSelection(['unify-winding']);

    expect(store.beginRepairPreview()).toBeUndefined();
  });

  it('refuses to start a preview for a no-op plan', () => {
    const store = new WorkspaceStore();
    const importToken = store.beginImport('part.stl');
    store.commitImport(importToken, loadedModel());
    const token = store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);
    store.commitRepairPlan(token, handle(1), planFor(handle(1), true));

    expect(store.beginRepairPreview()).toBeUndefined();
  });
});

describe('the candidate', () => {
  it('opens the preview on AFTER when a render snapshot exists', () => {
    const { store } = storeWithCandidate();

    expect(store.getSnapshot().repair.candidateState).toBe(RepairCandidateState.Ready);
    expect(store.getSnapshot().repair.previewMode).toBe(RepairPreviewMode.After);
  });

  it('stays on BEFORE when the candidate carries no snapshot to draw', () => {
    const store = new WorkspaceStore();
    const importToken = store.beginImport('part.stl');
    store.commitImport(importToken, loadedModel());
    const planToken = store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);
    store.commitRepairPlan(planToken, handle(1), planFor(handle(1)));
    const token = store.beginRepairPreview();
    if (token === undefined) throw new Error('preview token was refused');
    store.beginRepairCandidate(token);

    store.commitRepairCandidate(token, { ...previewFor(handle(1)), render: undefined });

    expect(store.getSnapshot().repair.previewMode).toBe(RepairPreviewMode.Before);
    // And AFTER cannot be selected: there is nothing to show.
    store.setRepairPreviewMode(RepairPreviewMode.After);
    expect(store.getSnapshot().repair.previewMode).toBe(RepairPreviewMode.Before);
  });

  it('refuses a candidate whose model has been replaced', () => {
    const store = new WorkspaceStore();
    const first = store.beginImport('one.stl');
    store.commitImport(first, loadedModel());
    const planToken = store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);
    store.commitRepairPlan(planToken, handle(1), planFor(handle(1)));
    const token = store.beginRepairPreview();
    if (token === undefined) throw new Error('preview token was refused');
    store.beginRepairCandidate(token);

    const second = store.beginImport('two.stl');
    store.commitImport(second, loadedModel({ handle: handle(1, 'model-2') }));

    expect(store.commitRepairCandidate(token, previewFor(handle(1)))).toBe(false);
    expect(store.getSnapshot().repair.candidate).toBeUndefined();
  });

  it('returns the dropped candidate handle so the caller can release the worker copy', () => {
    // The store holds no client and dispatches nothing. Forgetting a candidate
    // without releasing it would leave a mesh the size of the model resident.
    const { store } = storeWithCandidate();

    const dropped = store.clearRepairCandidate();

    expect(dropped?.candidateId).toBe('candidate-1');
    expect(store.getSnapshot().repair.candidate).toBeUndefined();
    expect(store.getSnapshot().repair.candidateState).toBe(RepairCandidateState.Idle);
    expect(store.getSnapshot().repair.previewMode).toBe(RepairPreviewMode.Before);
    // A second clear has nothing to release, and says so rather than erroring.
    expect(store.clearRepairCandidate()).toBeUndefined();
  });

  it('drops the candidate when a new model is imported', () => {
    const { store } = storeWithCandidate();

    const token = store.beginImport('two.stl');
    store.commitImport(token, loadedModel({ handle: handle(1, 'model-2') }));

    expect(store.getSnapshot().repair.candidate).toBeUndefined();
    expect(store.getSnapshot().repair.plan).toBeUndefined();
    expect(store.getSnapshot().repair.lastApplied).toBeUndefined();
  });
});

describe('applying', () => {
  it('claims the commit slot exactly once', () => {
    // The first of two independent defences against a double apply; the worker
    // refuses to commit a candidate twice as well.
    const { store } = storeWithCandidate();

    expect(store.beginRepairCommit()).toBe(true);
    expect(store.beginRepairCommit()).toBe(false);
    expect(store.getSnapshot().repair.commitState).toBe(RepairCommitState.Applying);
  });

  it('refuses to commit without a validated candidate', () => {
    const store = new WorkspaceStore();
    const token = store.beginImport('part.stl');
    store.commitImport(token, loadedModel());

    expect(store.beginRepairCommit()).toBe(false);
  });

  it('replaces the model, resets diagnostics, and records the repair for undo', () => {
    const { store } = storeWithCandidate();
    store.beginRepairCommit();

    const bounds: MeshBounds = {
      min: [0, 0, 0],
      max: [1, 1, 1],
      center: [0.5, 0.5, 0.5],
      size: [1, 1, 1],
      radius: 1,
    };
    const applied = store.applyRepairResult({
      handle: handle(2),
      parentRevision: 1,
      recordId: 'record-1',
      appliedOperations: ['remove-duplicate-faces'],
      counts: previewFor(handle(1)).counts,
      undoable: true,
      render: render(),
      bounds,
      triangleCount: 5,
      vertexCount: 15,
      residentBytes: 240,
    });

    expect(applied).toBe(true);
    const state = store.getSnapshot();
    // The model IS the repaired revision: viewport, export and diagnostics all
    // follow from here, so anything less would leave one of them stale.
    expect(state.model?.handle.revision).toBe(2);
    expect(state.model?.triangleCount).toBe(5);
    expect(state.model?.bounds).toEqual(bounds);
    // The source file facts are carried forward: the file did not change.
    expect(state.model?.source.fileName).toBe('part.stl');
    // Diagnostics are reset for the new handle so analysis re-runs.
    expect(state.analysis.handle?.revision).toBe(2);
    expect(state.analysis.report).toBeUndefined();
    // The candidate is gone and the repair is recorded.
    expect(state.repair.candidate).toBeUndefined();
    expect(state.repair.commitState).toBe(RepairCommitState.Idle);
    expect(state.repair.lastApplied?.recordId).toBe('record-1');
    expect(state.repair.lastApplied?.undoable).toBe(true);
  });

  it('refuses a commit result for a different model', () => {
    const { store } = storeWithCandidate();
    store.beginRepairCommit();

    const applied = store.applyRepairResult({
      handle: handle(2, 'model-9'),
      parentRevision: 1,
      recordId: 'record-1',
      appliedOperations: [],
      counts: previewFor(handle(1)).counts,
      undoable: true,
      render: render(),
      bounds: undefined,
      triangleCount: 5,
      vertexCount: 15,
      residentBytes: 240,
    });

    expect(applied).toBe(false);
    expect(store.getSnapshot().model?.handle.revision).toBe(1);
  });

  it('keeps the candidate when a commit fails, so it can be retried', () => {
    const { store } = storeWithCandidate();
    store.beginRepairCommit();

    store.failRepairCommit({ message: 'nope', code: 'INVALID_STATE', retryable: false });

    const state = store.getSnapshot();
    expect(state.repair.commitState).toBe(RepairCommitState.Idle);
    expect(state.repair.commitError?.message).toBe('nope');
    expect(state.repair.candidate).toBeDefined();
    expect(state.model?.handle.revision).toBe(1);
  });
});

describe('undo', () => {
  function storeWithAppliedRepair(): WorkspaceStore {
    const { store } = storeWithCandidate();
    store.beginRepairCommit();
    store.applyRepairResult({
      handle: handle(2),
      parentRevision: 1,
      recordId: 'record-1',
      appliedOperations: ['remove-duplicate-faces'],
      counts: previewFor(handle(1)).counts,
      undoable: true,
      render: render(),
      bounds: undefined,
      triangleCount: 5,
      vertexCount: 15,
      residentBytes: 240,
    });
    return store;
  }

  it('claims the undo slot exactly once', () => {
    const store = storeWithAppliedRepair();

    expect(store.beginRepairUndo()).toBe(true);
    expect(store.beginRepairUndo()).toBe(false);
    expect(store.getSnapshot().repair.commitState).toBe(RepairCommitState.Undoing);
  });

  it('refuses to undo a repair that was never undoable', () => {
    const { store } = storeWithCandidate();
    store.beginRepairCommit();
    store.applyRepairResult({
      handle: handle(2),
      parentRevision: 1,
      recordId: 'record-1',
      appliedOperations: [],
      counts: previewFor(handle(1)).counts,
      undoable: false,
      render: render(),
      bounds: undefined,
      triangleCount: 5,
      vertexCount: 15,
      residentBytes: 240,
    });

    expect(store.beginRepairUndo()).toBe(false);
  });

  it('installs restored geometry as a NEW revision and clears the undo record', () => {
    /*
     * A new revision, not a rewind. The worker produced fresh authoritative
     * geometry at a higher revision number and the interface follows it — see
     * ADR 0011. `lastApplied` goes because the repair it described has been
     * reversed and cannot be reversed again.
     */
    const store = storeWithAppliedRepair();
    store.beginRepairUndo();

    const restored = store.applyUndoResult({
      handle: handle(3),
      render: render(),
      bounds: undefined,
      triangleCount: 6,
      vertexCount: 18,
      residentBytes: 288,
    });

    expect(restored).toBe(true);
    const state = store.getSnapshot();
    expect(state.model?.handle.revision).toBe(3);
    expect(state.model?.triangleCount).toBe(6);
    expect(state.repair.lastApplied).toBeUndefined();
    expect(state.repair.commitState).toBe(RepairCommitState.Idle);
    expect(state.analysis.handle?.revision).toBe(3);
    expect(state.analysis.report).toBeUndefined();
  });

  it('keeps the undo available when it fails', () => {
    const store = storeWithAppliedRepair();
    store.beginRepairUndo();

    store.failRepairUndo({ message: 'no', code: 'MODEL_UNAVAILABLE', retryable: true });

    expect(store.getSnapshot().repair.commitState).toBe(RepairCommitState.Idle);
    expect(store.getSnapshot().repair.lastApplied?.undoable).toBe(true);
  });
});

describe('worker loss', () => {
  it('clears the plan, the candidate, the overlays and the undo record', () => {
    /*
     * POLICY A. The worker held the only copy of every mesh a repair named, so
     * leaving an Apply button pointing at a dead candidate would be worse than
     * showing nothing: pressing it could only fail.
     */
    const store = storeWithCandidate().store;

    store.loseGeometrySession('The geometry worker crashed.');

    const state = store.getSnapshot();
    expect(state.model).toBeUndefined();
    expect(state.repair.plan).toBeUndefined();
    expect(state.repair.candidate).toBeUndefined();
    expect(state.repair.candidateState).toBe(RepairCandidateState.Idle);
    expect(state.repair.lastApplied).toBeUndefined();
    expect(state.repair.planState).toBe(RepairPlanState.Unavailable);
    expect(state.overlays.boundaryEdges).toBe(false);
  });
});

describe('progress', () => {
  it('drops progress from a superseded repair attempt', () => {
    const store = new WorkspaceStore();
    const importToken = store.beginImport('part.stl');
    store.commitImport(importToken, loadedModel());

    const stale = store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);
    store.beginRepairPlan(handle(1), DEFAULT_REPAIR_SELECTION);

    store.reportRepairProgress(stale, 0.5, 'Building');

    expect(store.getSnapshot().repair.fraction).toBe(0);
  });

  it('drops commit progress when nothing is being committed', () => {
    const { store } = storeWithCandidate();

    store.reportRepairCommitProgress(0.5, 'Applying');

    expect(store.getSnapshot().repair.fraction).toBe(1);
  });

  it('reports commit progress while a commit is running', () => {
    const { store } = storeWithCandidate();
    store.beginRepairCommit();

    store.reportRepairCommitProgress(0.5, 'Applying');

    expect(store.getSnapshot().repair.fraction).toBe(0.5);
    expect(store.getSnapshot().repair.phase).toBe('Applying');
  });
});

describe('a commit whose result cannot be installed', () => {
  /**
   * REGRESSION. `applyRepairResult` returning false means the worker committed —
   * the user's geometry really did change — but the workspace could not install
   * the result because the model it belongs to is no longer loaded.
   *
   * The store deliberately does NOT release the commit slot on that path: it has
   * no way to distinguish "could not install" from "not finished yet", and
   * guessing would let a genuine in-flight commit be started twice. Releasing it
   * is the caller's job, and the caller forgot — which left Apply, Discard and
   * Undo frozen behind a spinner for an operation that had already finished.
   *
   * These two tests pin both halves of that contract so the fix cannot silently
   * regress.
   */
  it('leaves the commit slot claimed when the result is refused', () => {
    const { store } = storeWithCandidate();
    store.beginRepairCommit();

    const applied = store.applyRepairResult({
      handle: handle(2, 'model-9'),
      parentRevision: 1,
      recordId: 'record-1',
      appliedOperations: [],
      counts: previewFor(handle(1)).counts,
      undoable: true,
      render: render(),
      bounds: undefined,
      triangleCount: 5,
      vertexCount: 15,
      residentBytes: 240,
    });

    expect(applied).toBe(false);
    expect(store.getSnapshot().repair.commitState).toBe(RepairCommitState.Applying);
    // And nothing else may be started while it is claimed.
    expect(store.beginRepairCommit()).toBe(false);
    expect(store.beginRepairUndo()).toBe(false);
  });

  it('releases the slot and explains itself when the caller reports the divergence', () => {
    const { store } = storeWithCandidate();
    store.beginRepairCommit();
    store.applyRepairResult({
      handle: handle(2, 'model-9'),
      parentRevision: 1,
      recordId: 'record-1',
      appliedOperations: [],
      counts: previewFor(handle(1)).counts,
      undoable: true,
      render: render(),
      bounds: undefined,
      triangleCount: 5,
      vertexCount: 15,
      residentBytes: 240,
    });

    store.failRepairCommit({
      message: 'The repair was applied, but the model it belongs to is no longer open.',
      code: 'MODEL_UNAVAILABLE',
      retryable: false,
    });

    expect(store.getSnapshot().repair.commitState).toBe(RepairCommitState.Idle);
    expect(store.getSnapshot().repair.commitError?.message).toMatch(/no longer open/);
  });

  it('releases the undo slot on the same divergence', () => {
    const { store } = storeWithCandidate();
    store.beginRepairCommit();
    store.applyRepairResult({
      handle: handle(2),
      parentRevision: 1,
      recordId: 'record-1',
      appliedOperations: [],
      counts: previewFor(handle(1)).counts,
      undoable: true,
      render: render(),
      bounds: undefined,
      triangleCount: 5,
      vertexCount: 15,
      residentBytes: 240,
    });
    store.beginRepairUndo();

    // A restored result for a model that is no longer loaded.
    expect(
      store.applyUndoResult({
        handle: handle(3, 'model-9'),
        render: render(),
        bounds: undefined,
        triangleCount: 6,
        vertexCount: 18,
        residentBytes: 288,
      }),
    ).toBe(false);
    expect(store.getSnapshot().repair.commitState).toBe(RepairCommitState.Undoing);

    store.failRepairUndo({
      message: 'no longer open',
      code: 'MODEL_UNAVAILABLE',
      retryable: false,
    });

    expect(store.getSnapshot().repair.commitState).toBe(RepairCommitState.Idle);
  });
});
