import { describe, expect, it, vi } from 'vitest';
import { ImportState, SelfTestState, StatusSeverity, WorkspaceStore } from './workspace-store';
import { WorkflowId } from './workflows';
import type { LoadedModel } from './model';
import { IDENTITY_MATRIX4 } from '@cadfixer/mesh-core';

/** A minimal stand-in model. The store never inspects geometry, only holds it. */
function sampleModel(fileName: string): Omit<LoadedModel, 'revision'> {
  return {
    mesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
    },
    renderNormals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    bounds: {
      min: [0, 0, 0],
      max: [1, 1, 0],
      size: [1, 1, 0],
      center: [0.5, 0.5, 0],
      radius: 0.7071,
    },
    triangleCount: 1,
    vertexCount: 3,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    source: {
      fileName,
      fileBytes: 134,
      formatId: 'stl',
      encoding: 'binary',
      importedAt: 0,
    },
  };
}

describe('WorkspaceStore', () => {
  it('starts with an empty workspace', () => {
    const store = new WorkspaceStore();

    expect(store.getSnapshot().model).toBeUndefined();
    expect(store.getSnapshot().selectedWorkflow).toBeUndefined();
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Idle);
  });

  it('returns a new snapshot object on change so useSyncExternalStore re-renders', () => {
    const store = new WorkspaceStore();
    const before = store.getSnapshot();

    store.pushStatus(StatusSeverity.Info, 'something happened');

    expect(store.getSnapshot()).not.toBe(before);
  });

  it('returns a stable snapshot when nothing changed, so React does not loop', () => {
    const store = new WorkspaceStore();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const store = new WorkspaceStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.selectWorkflow(WorkflowId.Repair);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.selectWorkflow(undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('shows newest status first', () => {
    const store = new WorkspaceStore();

    store.pushStatus(StatusSeverity.Info, 'first');
    store.pushStatus(StatusSeverity.Error, 'second');

    expect(store.getSnapshot().status.map((entry) => entry.message)).toEqual(['second', 'first']);
  });

  it('bounds the status log so a long session cannot grow it without limit', () => {
    const store = new WorkspaceStore();

    for (let index = 0; index < 200; index += 1) {
      store.pushStatus(StatusSeverity.Info, `entry ${String(index)}`);
    }

    const { status } = store.getSnapshot();
    expect(status).toHaveLength(50);
    expect(status[0]?.message).toBe('entry 199');
  });

  it('gives every entry a distinct id, including duplicate messages', () => {
    const store = new WorkspaceStore();

    store.pushStatus(StatusSeverity.Info, 'same');
    store.pushStatus(StatusSeverity.Info, 'same');

    const ids = store.getSnapshot().status.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('tracks runtime self-test state', () => {
    const store = new WorkspaceStore();

    store.setRuntime({ selfTest: SelfTestState.Running, progress: 0.5, detail: 'chunk 8/16' });

    expect(store.getSnapshot().runtime).toEqual({
      selfTest: SelfTestState.Running,
      progress: 0.5,
      detail: 'chunk 8/16',
    });
  });
});

/**
 * Model replacement is a data-integrity concern, not a UI nicety: the model on
 * screen is the user's work in progress, and a failed attempt to open a
 * different file must not take it away from them.
 */
describe('model replacement', () => {
  it('installs a model and marks the import ready', () => {
    const store = new WorkspaceStore();

    store.setModel(sampleModel('first.stl'));

    expect(store.getSnapshot().model?.source.fileName).toBe('first.stl');
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Ready);
  });

  it('replaces the model on a successful second import', () => {
    const store = new WorkspaceStore();
    store.setModel(sampleModel('first.stl'));

    store.setModel(sampleModel('second.stl'));

    expect(store.getSnapshot().model?.source.fileName).toBe('second.stl');
  });

  it('gives each loaded model a new revision so the viewport can tell them apart', () => {
    const store = new WorkspaceStore();

    store.setModel(sampleModel('first.stl'));
    const first = store.getSnapshot().model?.revision;
    store.setModel(sampleModel('second.stl'));
    const second = store.getSnapshot().model?.revision;

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('KEEPS the previous model when a replacement import fails', () => {
    const store = new WorkspaceStore();
    store.setModel(sampleModel('good.stl'));
    const loaded = store.getSnapshot().model;

    store.failImport();

    expect(store.getSnapshot().model).toBe(loaded);
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Error);
  });

  it('KEEPS the previous model when a replacement import is cancelled', () => {
    const store = new WorkspaceStore();
    store.setModel(sampleModel('good.stl'));
    const loaded = store.getSnapshot().model;

    store.setImportProgress({ state: ImportState.Parsing, fraction: 0.4 });
    store.failImport();
    store.resetImportProgress();

    expect(store.getSnapshot().model).toBe(loaded);
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Ready);
  });

  it('returns to idle after a failure when nothing was ever loaded', () => {
    const store = new WorkspaceStore();

    store.failImport();
    store.resetImportProgress();

    expect(store.getSnapshot().model).toBeUndefined();
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Idle);
  });

  it('keeps the model reference stable across unrelated updates', () => {
    // The viewport keys its GPU-buffer rebuild on this reference. If a status
    // message replaced it, every log line would re-upload the whole mesh.
    const store = new WorkspaceStore();
    store.setModel(sampleModel('first.stl'));
    const loaded = store.getSnapshot().model;

    store.pushStatus(StatusSeverity.Info, 'unrelated');
    store.selectWorkflow(WorkflowId.Repair);

    expect(store.getSnapshot().model).toBe(loaded);
  });
});
