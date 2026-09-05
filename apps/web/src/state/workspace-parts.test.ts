import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentId,
  DocumentRenderSnapshot,
  PartDescriptor,
} from '@cadfixer/geometry-runtime';
import { SelfIntersectionBand } from '@cadfixer/mesh-self-intersection';
import { AnalysisState, WorkspaceStore } from './workspace-store';
import type { LoadedModel } from './model';

/**
 * ACTIVE PART IS WORKSPACE STATE, NOT GEOMETRY IDENTITY.
 *
 * The two properties that matter and would be easy to get wrong: selecting a
 * part must NOT consume a document revision, and it must never leave a
 * diagnostic on screen that describes a different part. The first would
 * invalidate every in-flight result for a UI action; the second is exactly the
 * diagnostic dishonesty the product forbids.
 */

function handle(revision = 1, documentId = 'document-1'): DocumentHandle {
  return { documentId: documentId as DocumentId, revision };
}

function descriptor(partId: string, triangleCount: number, name?: string): PartDescriptor {
  return {
    partId,
    ...(name === undefined ? {} : { name }),
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

function renderFor(parts: readonly PartDescriptor[]): DocumentRenderSnapshot {
  return {
    parts: parts.map((part) => ({
      partId: part.partId,
      transform: part.transform,
      positions: new Float32Array(part.triangleCount * 9),
      normals: new Float32Array(part.triangleCount * 9),
      vertexCount: part.triangleCount * 3,
    })),
  };
}

function modelWith(parts: readonly PartDescriptor[]): Omit<LoadedModel, 'revision'> {
  let triangles = 0;
  for (const part of parts) triangles += part.triangleCount;
  return {
    handle: handle(),
    parts,
    render: renderFor(parts),
    source: {
      fileName: 'assembly.stl',
      fileBytes: 1024,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount: triangles,
    vertexCount: triangles * 3,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 4096,
  };
}

function loaded(parts: readonly PartDescriptor[]): WorkspaceStore {
  const store = new WorkspaceStore();
  const token = store.beginImport('assembly.stl');
  store.commitImport(token, modelWith(parts));
  return store;
}

describe('initial selection', () => {
  it('selects the only part of a single-part document automatically', () => {
    const store = loaded([descriptor('part-1', 4)]);

    expect(store.getSnapshot().activePartId).toBe('part-1');
    expect(store.activePart()?.partId).toBe('part-1');
  });

  it('selects a DETERMINISTIC first part of a multi-part document', () => {
    // Document order, every time. The same file must not open on a different
    // part depending on which mesh happened to be built first.
    const store = loaded([descriptor('a', 4), descriptor('b', 8), descriptor('c', 2)]);

    expect(store.getSnapshot().activePartId).toBe('a');
  });

  it('binds the diagnostic and repair slices to the initial part', () => {
    const store = loaded([descriptor('a', 4), descriptor('b', 8)]);
    const state = store.getSnapshot();

    expect(state.analysis.partId).toBe('a');
    expect(state.selfIntersection.partId).toBe('a');
    expect(state.repair.partId).toBe('a');
  });

  it('derives the self-intersection band from the ACTIVE PART, not the document total', () => {
    /*
     * A small part inside a large document is still auto-eligible, because the
     * check runs on one mesh. Using the document total would refuse a check the
     * product can perfectly well run.
     */
    const store = loaded([descriptor('small', 10), descriptor('huge', 400_000)]);

    expect(store.getSnapshot().selfIntersection.band).toBe(SelfIntersectionBand.AutoEligible);
  });
});

describe('changing the active part', () => {
  it('DF09: does NOT change the document revision or the handle', () => {
    const store = loaded([descriptor('a', 4), descriptor('b', 8)]);
    const before = store.getSnapshot().model;

    store.selectPart('b');

    const after = store.getSnapshot().model;
    // Same handle object identity is not required, but the handle's VALUE must
    // be unchanged: nothing about the authoritative document moved.
    expect(after?.handle).toEqual(before?.handle);
    expect(after?.revision).toBe(before?.revision);
    // And the authoritative render snapshot was not rebuilt.
    expect(after?.render).toBe(before?.render);
    expect(after?.parts).toBe(before?.parts);
  });

  it('re-binds every per-part slice to the new part', () => {
    const store = loaded([descriptor('a', 4), descriptor('b', 8)]);

    store.selectPart('b');

    const state = store.getSnapshot();
    expect(state.activePartId).toBe('b');
    expect(state.analysis.partId).toBe('b');
    expect(state.selfIntersection.partId).toBe('b');
    expect(state.repair.partId).toBe('b');
  });

  it('clears part A’s report rather than showing it beside part B', () => {
    const store = loaded([descriptor('a', 4), descriptor('b', 8)]);
    const token = store.beginAnalysis(handle(), 'a');
    store.commitAnalysis(token, handle(), 'a', { sourceFaceCount: 4 } as never, {} as never, 1);
    expect(store.getSnapshot().analysis.report).toBeDefined();

    store.selectPart('b');

    // Carrying A's boundary-edge count across would be a number beside geometry
    // nothing examined.
    expect(store.getSnapshot().analysis.report).toBeUndefined();
    expect(store.getSnapshot().analysis.state).toBe(AnalysisState.Idle);
  });

  it('re-derives the size band for the newly selected part', () => {
    const store = loaded([descriptor('small', 10), descriptor('huge', 400_000)]);

    store.selectPart('huge');

    expect(store.getSnapshot().selfIntersection.band).toBe(SelfIntersectionBand.SizeLimit);
  });

  it('keeps the user’s repair operation selection across a part change', () => {
    // The chosen operations are a preference about repair, not about a part.
    const store = loaded([descriptor('a', 4), descriptor('b', 8)]);
    store.setRepairSelection(['remove-duplicate-faces']);

    store.selectPart('b');

    expect(store.getSnapshot().repair.selection).toEqual(['remove-duplicate-faces']);
  });

  it('refuses an id that is not a part of this document', () => {
    const store = loaded([descriptor('a', 4), descriptor('b', 8)]);

    expect(store.selectPart('ghost')).toBe(false);
    // The selection is left pointing at something that exists.
    expect(store.getSnapshot().activePartId).toBe('a');
  });

  it('refuses a selection when nothing is loaded', () => {
    const store = new WorkspaceStore();

    expect(store.selectPart('a')).toBe(false);
    expect(store.getSnapshot().activePartId).toBeUndefined();
  });

  it('re-selecting the current part is a no-op, not a state churn', () => {
    const store = loaded([descriptor('a', 4), descriptor('b', 8)]);
    const before = store.getSnapshot();

    expect(store.selectPart('a')).toBe(true);

    expect(store.getSnapshot()).toBe(before);
  });
});

describe('a stale result cannot install itself against another part', () => {
  it('refuses a report that finished after the user switched parts', () => {
    /*
     * THE CASE A HANDLE COMPARISON CANNOT CATCH. Both reports carry the same
     * document handle, because both parts live at the same revision. Only the
     * part distinguishes them.
     */
    const store = loaded([descriptor('a', 4), descriptor('b', 8)]);
    const token = store.beginAnalysis(handle(), 'a');

    store.selectPart('b');
    const installed = store.commitAnalysis(
      token,
      handle(),
      'a',
      { sourceFaceCount: 4 } as never,
      {} as never,
      1,
    );

    expect(installed).toBe(false);
    expect(store.getSnapshot().analysis.report).toBeUndefined();
  });

  it('refuses a self-intersection check requested for a part that is no longer active', () => {
    const store = loaded([descriptor('a', 4), descriptor('b', 8)]);

    // The slice is bound to 'a'; a check naming 'b' has nowhere to publish.
    expect(store.beginSelfIntersection(handle(), 'b', false)).toBeUndefined();
    expect(store.beginSelfIntersection(handle(), 'a', false)).toBeDefined();
  });
});

describe('replacing the document', () => {
  it('resets the selection to the new document’s first part', () => {
    const store = loaded([descriptor('a', 4), descriptor('b', 8)]);
    store.selectPart('b');

    const token = store.beginImport('other.stl');
    store.commitImport(token, modelWith([descriptor('only', 3)]));

    expect(store.getSnapshot().activePartId).toBe('only');
    expect(store.getSnapshot().analysis.partId).toBe('only');
  });
});
