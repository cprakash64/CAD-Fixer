import { describe, expect, it } from 'vitest';
import type {
  ModelHandle,
  ModelId,
  TopologyDetail,
  TopologyReport,
} from '@cadfixer/geometry-runtime';
import { AnalysisState, WorkspaceStore } from './workspace-store';
import type { LoadedModel } from './model';

/**
 * The analysis state machine, tested without React.
 *
 * The rule these tests defend is one thing: a topology report may only ever be
 * shown beside the geometry it describes. Everything else here — cancellation,
 * failure, worker loss — is downstream of that.
 */

function handleFor(modelId: string, revision: number): ModelHandle {
  return { modelId: modelId as ModelId, revision };
}

function modelFor(handle: ModelHandle): Omit<LoadedModel, 'revision'> {
  return {
    handle,
    render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
    source: {
      fileName: `${handle.modelId}.stl`,
      fileBytes: 84,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount: 1,
    vertexCount: 3,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 48,
  };
}

function reportFor(handle: ModelHandle): TopologyReport {
  return {
    schemaVersion: 1,
    modelId: handle.modelId,
    modelRevision: handle.revision,
    identityMode: 'exact-stored-coordinate',
    sourceFaceCount: 1,
    sourceCornerCount: 3,
    topologicalVertexCount: 3,
    uniqueEdgeCount: 3,
    boundaryEdgeCount: 3,
    ordinaryEdgeCount: 0,
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
    simpleBoundaryLoopCount: 1,
    openBoundaryChainCount: 0,
    branchedBoundaryCount: 0,
    boundaryComponents: [],
    boundaryComponentsTruncated: false,
    totalSurfaceArea: 0.5,
    totalSignedVolume: 0,
    isEdgeManifold: true,
    isVertexManifold: true,
    isWindingConsistent: true,
    isBoundaryFree: false,
    selfIntersectionStatus: 'not-checked',
    printabilityStatus: 'topological-defects',
    analysisMilliseconds: 1,
  };
}

const EMPTY_DETAIL: TopologyDetail = {
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
  sampleLimit: 50_000,
};

/** Imports a model and returns the handle it was stored under. */
function loadModel(store: WorkspaceStore, modelId: string, revision: number): ModelHandle {
  const handle = handleFor(modelId, revision);
  const token = store.beginImport(`${modelId}.stl`);
  store.commitImport(token, modelFor(handle));
  return handle;
}

describe('analysis lifecycle', () => {
  it('is unavailable until a model is loaded', () => {
    const store = new WorkspaceStore();

    expect(store.getSnapshot().analysis.state).toBe(AnalysisState.Unavailable);
  });

  it('becomes idle for the newly imported model', () => {
    const store = new WorkspaceStore();
    const handle = loadModel(store, 'model-1', 1);

    const analysis = store.getSnapshot().analysis;
    expect(analysis.state).toBe(AnalysisState.Idle);
    expect(analysis.handle).toEqual(handle);
    expect(analysis.report).toBeUndefined();
  });

  it('installs a report for the loaded model', () => {
    const store = new WorkspaceStore();
    const handle = loadModel(store, 'model-1', 1);

    const token = store.beginAnalysis(handle);
    expect(store.commitAnalysis(token, handle, reportFor(handle), EMPTY_DETAIL, 12)).toBe(true);

    const analysis = store.getSnapshot().analysis;
    expect(analysis.state).toBe(AnalysisState.Ready);
    expect(analysis.report?.boundaryEdgeCount).toBe(3);
    expect(analysis.durationMs).toBe(12);
  });
});

describe('stale report protection', () => {
  /**
   * THE CASE THIS EXISTS FOR. M0's analysis is slow; the user imports M1 while
   * it runs; M0's report arrives afterwards. Showing it would put one model's
   * topology beside another's geometry, and the numbers would look completely
   * plausible.
   */
  it('refuses a report for a model that has since been replaced', () => {
    const store = new WorkspaceStore();
    const first = loadModel(store, 'model-1', 1);
    const token = store.beginAnalysis(first);

    // The user imports a different file before the analysis returns.
    const second = loadModel(store, 'model-2', 1);

    expect(store.commitAnalysis(token, first, reportFor(first), EMPTY_DETAIL, 5)).toBe(false);

    const analysis = store.getSnapshot().analysis;
    expect(analysis.handle).toEqual(second);
    expect(analysis.report).toBeUndefined();
    expect(analysis.state).toBe(AnalysisState.Idle);
  });

  it('refuses a report whose handle does not match the loaded model', () => {
    const store = new WorkspaceStore();
    const handle = loadModel(store, 'model-1', 1);
    const token = store.beginAnalysis(handle);

    // Same model id, different revision: the geometry was replaced in place.
    const wrongRevision = handleFor('model-1', 2);
    expect(
      store.commitAnalysis(token, wrongRevision, reportFor(wrongRevision), EMPTY_DETAIL, 5),
    ).toBe(false);
    expect(store.getSnapshot().analysis.report).toBeUndefined();
  });

  it('refuses a superseded analysis of the same model', () => {
    const store = new WorkspaceStore();
    const handle = loadModel(store, 'model-1', 1);

    const first = store.beginAnalysis(handle);
    const second = store.beginAnalysis(handle);

    expect(store.commitAnalysis(first, handle, reportFor(handle), EMPTY_DETAIL, 1)).toBe(false);
    expect(store.commitAnalysis(second, handle, reportFor(handle), EMPTY_DETAIL, 1)).toBe(true);
  });

  it('drops the previous report when a different model is imported', () => {
    const store = new WorkspaceStore();
    const first = loadModel(store, 'model-1', 1);
    const token = store.beginAnalysis(first);
    store.commitAnalysis(token, first, reportFor(first), EMPTY_DETAIL, 1);
    expect(store.getSnapshot().analysis.report).toBeDefined();

    loadModel(store, 'model-2', 1);

    // Not merely stale-flagged: gone. A report kept "just in case" is a report
    // some future code path can render.
    expect(store.getSnapshot().analysis.report).toBeUndefined();
    expect(store.getSnapshot().analysis.detail).toBeUndefined();
  });
});

describe('cancellation', () => {
  it('reports cancelled when there was no earlier report', () => {
    const store = new WorkspaceStore();
    const handle = loadModel(store, 'model-1', 1);
    const token = store.beginAnalysis(handle);

    expect(store.cancelAnalysis(token)).toBe(true);

    const analysis = store.getSnapshot().analysis;
    expect(analysis.state).toBe(AnalysisState.Cancelled);
    // No partial data of any kind.
    expect(analysis.report).toBeUndefined();
    expect(analysis.detail).toBeUndefined();
  });

  it('keeps the earlier report when a re-run is cancelled', () => {
    const store = new WorkspaceStore();
    const handle = loadModel(store, 'model-1', 1);

    const first = store.beginAnalysis(handle);
    store.commitAnalysis(first, handle, reportFor(handle), EMPTY_DETAIL, 3);

    const second = store.beginAnalysis(handle);
    // The previous answer stays visible while the re-run is in flight.
    expect(store.getSnapshot().analysis.report).toBeDefined();

    store.cancelAnalysis(second);

    const analysis = store.getSnapshot().analysis;
    expect(analysis.state).toBe(AnalysisState.Ready);
    expect(analysis.report?.boundaryEdgeCount).toBe(3);
  });

  it('leaves the model loaded', () => {
    const store = new WorkspaceStore();
    const handle = loadModel(store, 'model-1', 1);
    const token = store.beginAnalysis(handle);

    store.cancelAnalysis(token);

    expect(store.getSnapshot().model).toBeDefined();
  });
});

describe('failure', () => {
  it('does not disturb the loaded model', () => {
    const store = new WorkspaceStore();
    const handle = loadModel(store, 'model-1', 1);
    const token = store.beginAnalysis(handle);

    store.failAnalysis(token, {
      message: 'Analysis workspace exceeds the session budget.',
      code: 'RESOURCE_LIMIT_EXCEEDED',
      retryable: false,
    });

    expect(store.getSnapshot().model).toBeDefined();
    expect(store.getSnapshot().analysis.state).toBe(AnalysisState.Failed);
    expect(store.getSnapshot().analysis.error?.retryable).toBe(false);
  });
});

describe('worker loss', () => {
  it('clears the report along with the model', () => {
    const store = new WorkspaceStore();
    const handle = loadModel(store, 'model-1', 1);
    const token = store.beginAnalysis(handle);
    store.commitAnalysis(token, handle, reportFor(handle), EMPTY_DETAIL, 1);

    store.loseGeometrySession('The geometry worker crashed.');

    const analysis = store.getSnapshot().analysis;
    // The report describes geometry that no longer exists anywhere.
    expect(store.getSnapshot().model).toBeUndefined();
    expect(analysis.state).toBe(AnalysisState.Unavailable);
    expect(analysis.report).toBeUndefined();
    expect(analysis.detail).toBeUndefined();
  });

  it('stops a late report from the dead worker installing anything', () => {
    const store = new WorkspaceStore();
    const handle = loadModel(store, 'model-1', 1);
    const token = store.beginAnalysis(handle);

    store.loseGeometrySession('The geometry worker crashed.');

    expect(store.commitAnalysis(token, handle, reportFor(handle), EMPTY_DETAIL, 1)).toBe(false);
    expect(store.getSnapshot().analysis.report).toBeUndefined();
  });
});

describe('overlay visibility', () => {
  it('starts hidden so a fresh import is not buried in diagnostic lines', () => {
    const store = new WorkspaceStore();

    expect(store.getSnapshot().overlays).toEqual({
      boundaryEdges: false,
      nonManifoldEdges: false,
      windingConflictEdges: false,
      degenerateFaces: false,
    });
  });

  it('toggles one category without disturbing the others', () => {
    const store = new WorkspaceStore();

    store.setOverlayVisible('nonManifoldEdges', true);

    expect(store.getSnapshot().overlays.nonManifoldEdges).toBe(true);
    expect(store.getSnapshot().overlays.boundaryEdges).toBe(false);
  });

  it('does not notify when the value is unchanged', () => {
    const store = new WorkspaceStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.setOverlayVisible('boundaryEdges', false);

    expect(notifications).toBe(0);
  });
});
