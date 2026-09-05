import { describe, expect, it, vi } from 'vitest';
import {
  ExportState,
  ImportState,
  SelfTestState,
  StatusSeverity,
  WorkspaceStore,
} from './workspace-store';
import { WorkflowId } from './workflows';
import type { LoadedModel } from './model';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type { DocumentId } from '@cadfixer/geometry-runtime';

/** A minimal stand-in model. The store never inspects geometry, only holds it. */
function sampleModel(fileName: string): Omit<LoadedModel, 'revision'> {
  return {
    handle: { documentId: `model-${fileName}` as DocumentId, revision: 1 },
    parts: [
      {
        partId: 'part-1',
        transform: IDENTITY_PART_TRANSFORM,
        triangleCount: 1,
        vertexCount: 3,
        bounds: undefined,
        meshResourceIndex: 0,
        groupCount: 0,
        groupMaterialRefCount: 0,
        hasNormals: false,
        hasUvs: false,
      },
    ],
    render: {
      parts: [
        {
          partId: 'part-1',
          transform: IDENTITY_PART_TRANSFORM,
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          vertexCount: 3,
        },
      ],
    },
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
    residentBytes: 144,
    source: {
      fileName,
      fileBytes: 134,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      unsupportedFeatures: [],
      externalReferences: [],
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
 * Model replacement and import supersession.
 *
 * This is a data-integrity concern, not a UI nicety. The model on screen is the
 * user's work in progress: a failed attempt to open a different file must not
 * take it away, and a slow import that was already superseded must never
 * install itself over the newer one. Both are silent-wrong-answer bugs — the
 * user sees geometry that does not match the filename beside it.
 */
describe('model replacement', () => {
  it('installs a model and marks the import ready', () => {
    const store = new WorkspaceStore();

    const token = store.beginImport('first.stl');
    expect(store.commitImport(token, sampleModel('first.stl'))).toBe(true);

    expect(store.getSnapshot().model?.source.fileName).toBe('first.stl');
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Ready);
  });

  it('replaces the model on a successful second import', () => {
    const store = new WorkspaceStore();
    store.commitImport(store.beginImport('first.stl'), sampleModel('first.stl'));

    store.commitImport(store.beginImport('second.stl'), sampleModel('second.stl'));

    expect(store.getSnapshot().model?.source.fileName).toBe('second.stl');
  });

  it('gives each loaded model a new revision so the viewport can tell them apart', () => {
    const store = new WorkspaceStore();

    store.commitImport(store.beginImport('first.stl'), sampleModel('first.stl'));
    const first = store.getSnapshot().model?.revision;
    store.commitImport(store.beginImport('second.stl'), sampleModel('second.stl'));
    const second = store.getSnapshot().model?.revision;

    expect(first).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('KEEPS the previous model when a replacement import fails', () => {
    const store = new WorkspaceStore();
    store.commitImport(store.beginImport('good.stl'), sampleModel('good.stl'));
    const loaded = store.getSnapshot().model;

    expect(store.failImport(store.beginImport('broken.stl'))).toBe(true);

    expect(store.getSnapshot().model).toBe(loaded);
    // Back to Ready, not Error: there IS a model, and it is fine.
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Ready);
  });

  it('KEEPS the previous model when a replacement import is cancelled', () => {
    const store = new WorkspaceStore();
    store.commitImport(store.beginImport('good.stl'), sampleModel('good.stl'));
    const loaded = store.getSnapshot().model;

    const cancelled = store.beginImport('huge.stl');
    store.reportImportProgress(cancelled, { state: ImportState.Parsing, fraction: 0.4 });
    store.failImport(cancelled);

    expect(store.getSnapshot().model).toBe(loaded);
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Ready);
  });

  it('reports an error state when the very first import fails', () => {
    const store = new WorkspaceStore();

    store.failImport(store.beginImport('broken.stl'));

    expect(store.getSnapshot().model).toBeUndefined();
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Error);
  });

  it('keeps the model reference stable across unrelated updates', () => {
    // The viewport keys its GPU-buffer rebuild on this reference. If a status
    // message replaced it, every log line would re-upload the whole mesh.
    const store = new WorkspaceStore();
    store.commitImport(store.beginImport('first.stl'), sampleModel('first.stl'));
    const loaded = store.getSnapshot().model;

    store.pushStatus(StatusSeverity.Info, 'unrelated');
    store.selectWorkflow(WorkflowId.Repair);

    expect(store.getSnapshot().model).toBe(loaded);
  });
});

describe('import supersession', () => {
  /**
   * The scenario throughout: a model M0 is loaded, import A starts, import B
   * starts before A finishes. Only B may become the current model, whichever
   * order the two actually complete in.
   */
  it('lets the newer import win when the older one finishes LAST', () => {
    const store = new WorkspaceStore();
    store.commitImport(store.beginImport('m0.stl'), sampleModel('m0.stl'));

    const a = store.beginImport('a.stl');
    const b = store.beginImport('b.stl');

    expect(store.commitImport(b, sampleModel('b.stl'))).toBe(true);
    // A arrives late. It must be refused.
    expect(store.commitImport(a, sampleModel('a.stl'))).toBe(false);

    expect(store.getSnapshot().model?.source.fileName).toBe('b.stl');
  });

  it('lets the newer import win when the older one finishes FIRST', () => {
    // The ordering that a boolean "importing" flag gets wrong: A completes
    // while B is still running, so a naive guard would install A.
    const store = new WorkspaceStore();
    store.commitImport(store.beginImport('m0.stl'), sampleModel('m0.stl'));

    const a = store.beginImport('a.stl');
    const b = store.beginImport('b.stl');

    expect(store.commitImport(a, sampleModel('a.stl'))).toBe(false);
    expect(store.getSnapshot().model?.source.fileName).toBe('m0.stl');

    expect(store.commitImport(b, sampleModel('b.stl'))).toBe(true);
    expect(store.getSnapshot().model?.source.fileName).toBe('b.stl');
  });

  it('keeps M0 when the superseding import B fails', () => {
    const store = new WorkspaceStore();
    store.commitImport(store.beginImport('m0.stl'), sampleModel('m0.stl'));

    const a = store.beginImport('a.stl');
    const b = store.beginImport('b.stl');
    store.failImport(b);

    // And A, which was superseded, still cannot install itself afterwards.
    expect(store.commitImport(a, sampleModel('a.stl'))).toBe(false);
    expect(store.getSnapshot().model?.source.fileName).toBe('m0.stl');
  });

  it('keeps M0 when the superseding import B is cancelled', () => {
    const store = new WorkspaceStore();
    store.commitImport(store.beginImport('m0.stl'), sampleModel('m0.stl'));

    store.beginImport('a.stl');
    const b = store.beginImport('b.stl');
    store.failImport(b);

    expect(store.getSnapshot().model?.source.fileName).toBe('m0.stl');
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Ready);
  });

  it('discards progress from a superseded import', () => {
    // Late progress from A must not drive the bar that now belongs to B.
    const store = new WorkspaceStore();
    const a = store.beginImport('a.stl');
    const b = store.beginImport('b.stl');

    store.reportImportProgress(b, { state: ImportState.Parsing, fraction: 0.5, fileName: 'b.stl' });
    store.reportImportProgress(a, {
      state: ImportState.Reading,
      fraction: 0.01,
      fileName: 'a.stl',
    });

    expect(store.getSnapshot().importProgress.fileName).toBe('b.stl');
    expect(store.getSnapshot().importProgress.fraction).toBe(0.5);
  });

  it('discards a stale failure so it cannot show an error for a dead import', () => {
    const store = new WorkspaceStore();
    const a = store.beginImport('a.stl');
    const b = store.beginImport('b.stl');
    store.reportImportProgress(b, { state: ImportState.Parsing, fraction: 0.5, fileName: 'b.stl' });

    expect(store.failImport(a)).toBe(false);

    // B is still running and still owns the indicator.
    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Parsing);
    expect(store.getSnapshot().importProgress.fileName).toBe('b.stl');
  });

  it('treats a committed import as no longer current', () => {
    // Guards against a second result from the same attempt installing twice.
    const store = new WorkspaceStore();
    const token = store.beginImport('a.stl');

    expect(store.commitImport(token, sampleModel('a.stl'))).toBe(true);
    expect(store.isCurrentImport(token)).toBe(false);
    expect(store.commitImport(token, sampleModel('a-again.stl'))).toBe(false);

    expect(store.getSnapshot().model?.source.fileName).toBe('a.stl');
  });

  it('issues strictly increasing tokens', () => {
    const store = new WorkspaceStore();

    const first = store.beginImport('a.stl');
    const second = store.beginImport('b.stl');

    expect(second).toBeGreaterThan(first);
    expect(store.isCurrentImport(first)).toBe(false);
    expect(store.isCurrentImport(second)).toBe(true);
  });
});

/**
 * Worker loss is total loss of authoritative geometry: the worker held the only
 * copy. The store must discard the model rather than leave a render snapshot on
 * screen that no operation can act on.
 */
describe('geometry session loss', () => {
  it('discards the model when the worker dies', () => {
    const store = new WorkspaceStore();
    store.commitImport(store.beginImport('part.stl'), sampleModel('part.stl'));

    store.loseGeometrySession('The geometry worker crashed.');

    expect(store.getSnapshot().model).toBeUndefined();
    expect(store.getSnapshot().geometrySessionLost).toBe('The geometry worker crashed.');
  });

  it('clears any in-flight import and export indicators', () => {
    const store = new WorkspaceStore();
    const importToken = store.beginImport('part.stl');
    const exportToken = store.beginExport('binary');

    store.loseGeometrySession('worker gone');

    expect(store.getSnapshot().importProgress.state).toBe(ImportState.Idle);
    expect(store.getSnapshot().exportProgress.state).toBe(ExportState.Idle);
    // And neither operation can install anything afterwards.
    expect(store.commitImport(importToken, sampleModel('late.stl'))).toBe(false);
    expect(store.finishExport(exportToken)).toBe(false);
  });

  it('a late result from the dead worker cannot install a model', () => {
    const store = new WorkspaceStore();
    const token = store.beginImport('part.stl');

    store.loseGeometrySession('worker gone');

    expect(store.commitImport(token, sampleModel('part.stl'))).toBe(false);
    expect(store.getSnapshot().model).toBeUndefined();
  });

  it('clears the loss notice once a new import succeeds', () => {
    const store = new WorkspaceStore();
    store.loseGeometrySession('worker gone');

    store.commitImport(store.beginImport('again.stl'), sampleModel('again.stl'));

    expect(store.getSnapshot().geometrySessionLost).toBeUndefined();
    expect(store.getSnapshot().model?.source.fileName).toBe('again.stl');
  });

  it('does not resurrect a model from the render snapshot', () => {
    // Explicit: pixels are not geometry. Nothing reconstructs the authoritative
    // mesh from what happened to be on screen.
    const store = new WorkspaceStore();
    store.commitImport(store.beginImport('part.stl'), sampleModel('part.stl'));

    store.loseGeometrySession('worker gone');

    expect(store.getSnapshot().model).toBeUndefined();
  });
});
