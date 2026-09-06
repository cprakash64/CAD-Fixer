import { beforeEach, describe, expect, it } from 'vitest';
import { BoundaryLoopRefusal } from '@cadfixer/geometry-runtime';
import type {
  DocumentHandle,
  HoleFillCandidateHandle,
  MeshBounds,
  PartDescriptor,
  RenderSnapshot,
} from '@cadfixer/geometry-runtime';
import {
  HoleFillCommitState,
  HoleFillInventoryState,
  HoleFillWorkState,
  WorkspaceStore,
  type HoleBoundaryRow,
  type HoleFillPreview,
} from './workspace-store';
import type { LoadedModel } from './model';

/**
 * THE WORKFLOW STATE MACHINE.
 *
 * WHAT THIS SUITE PROTECTS. The worker refuses a wrong Apply; this layer decides
 * whether one is ever OFFERED. A guard that fires is a bug the user sees, so the
 * store has to reach the same conclusions the worker would — about the document,
 * the part, the opening and the revision — one step earlier, and it has to drop
 * the preview whenever any of them moves.
 *
 * AND THE LIFECYCLE. Every path that abandons a candidate must RETURN it, so the
 * hook can release the worker's copy. A path that clears the slice and returns
 * nothing leaks a whole part's geometry in the worker, invisibly, once per
 * abandoned preview.
 */

const DOCUMENT = 'doc-1';
const PART = 'part-1';
const SIBLING = 'part-2';

function handle(revision: number, documentId = DOCUMENT): DocumentHandle {
  return { documentId, revision } as DocumentHandle;
}

function descriptor(partId: string, triangleCount = 12): PartDescriptor {
  return {
    partId,
    name: partId,
    triangleCount,
    vertexCount: triangleCount * 3,
    meshResourceIndex: 0,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    bounds: undefined,
  } as unknown as PartDescriptor;
}

function render(): RenderSnapshot {
  return { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 };
}

function bounds(): MeshBounds {
  return {
    min: [0, 0, 0],
    max: [1, 1, 1],
    size: [1, 1, 1],
    center: [0.5, 0.5, 0.5],
    radius: 1,
  };
}

function model(parts: readonly PartDescriptor[], revision = 1): Omit<LoadedModel, 'revision'> {
  return {
    handle: handle(revision),
    parts,
    render: {
      parts: parts.map((part) => ({
        partId: part.partId,
        transform: part.transform,
        positions: new Float32Array(9),
        normals: new Float32Array(9),
        vertexCount: 3,
      })),
    },
    bounds: bounds(),
    triangleCount: 12,
    vertexCount: 36,
    residentBytes: 1024,
    validation: { valid: true, issues: [] },
    source: {
      fileName: 'part.stl',
      fileBytes: 100,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      warnings: [],
    },
  } as unknown as Omit<LoadedModel, 'revision'>;
}

function candidateHandle(
  id = 'hole-fill-candidate-1',
  overrides: Partial<HoleFillCandidateHandle> = {},
): HoleFillCandidateHandle {
  return {
    candidateId: id,
    documentId: DOCUMENT,
    partId: PART,
    sourceRevision: 1,
    boundaryLoopId: 'bl-a',
    sourceFaceCount: 12,
    generation: 1,
    ...overrides,
  } as unknown as HoleFillCandidateHandle;
}

function preview(overrides: Partial<HoleFillPreview> = {}): HoleFillPreview {
  return {
    candidate: candidateHandle(),
    source: handle(1),
    partId: PART,
    boundaryLoopId: 'bl-a',
    summary: {} as HoleFillPreview['summary'],
    patchPositions: undefined,
    patchNormals: undefined,
    patchTriangleCount: 0,
    ...overrides,
  };
}

const ROWS: readonly HoleBoundaryRow[] = [
  {
    boundaryLoopId: 'bl-a',
    displayIndex: 1,
    vertexCount: 4,
    edgeCount: 4,
    fillable: true,
    refusal: undefined,
  },
  {
    boundaryLoopId: 'bl-b',
    displayIndex: 2,
    vertexCount: 9,
    edgeCount: 9,
    fillable: false,
    refusal: BoundaryLoopRefusal.BranchedBoundary,
  },
];

/** Loads one part, lists two openings and selects the fillable one. */
function readyStore(): WorkspaceStore {
  const store = new WorkspaceStore();
  const token = store.beginImport('part.stl');
  store.commitImport(token, model([descriptor(PART)]));

  const listing = store.beginHoleFillListing(handle(1), PART);
  store.commitHoleFillListing(listing, {
    handle: handle(1),
    partId: PART,
    loopCount: 2,
    rows: ROWS,
    truncated: false,
    partFaceCount: 12,
  });
  store.selectBoundaryLoop('bl-a');
  return store;
}

function withCandidate(store: WorkspaceStore): HoleFillPreview {
  const token = store.beginHoleFillCandidate(handle(1), PART, 'bl-a');
  expect(token).toBeDefined();
  if (token === undefined) throw new Error('no token');
  const built = preview();
  expect(store.commitHoleFillCandidate(token, built)).toBe(true);
  return built;
}

describe('the inventory', () => {
  it('starts unavailable and becomes ready with a bounded, exact listing', () => {
    const store = new WorkspaceStore();
    expect(store.getSnapshot().holeFill.inventory.state).toBe(HoleFillInventoryState.Unavailable);

    const token = store.beginImport('part.stl');
    store.commitImport(token, model([descriptor(PART)]));
    const listing = store.beginHoleFillListing(handle(1), PART);
    expect(store.getSnapshot().holeFill.inventory.state).toBe(HoleFillInventoryState.Listing);

    store.commitHoleFillListing(listing, {
      handle: handle(1),
      partId: PART,
      loopCount: 20_165,
      rows: ROWS,
      truncated: true,
      partFaceCount: 400_000,
    });

    const inventory = store.getSnapshot().holeFill.inventory;
    expect(inventory.state).toBe(HoleFillInventoryState.Ready);
    // THE COUNT IS EXACT AND THE LIST IS NOT. §9.
    expect(inventory.loopCount).toBe(20_165);
    expect(inventory.rows).toHaveLength(2);
    expect(inventory.truncated).toBe(true);
    expect(inventory.partFaceCount).toBe(400_000);
  });

  it('discards a listing that arrived for a superseded attempt', () => {
    const store = readyStore();
    const stale = store.beginHoleFillListing(handle(1), PART);
    const current = store.beginHoleFillListing(handle(1), SIBLING);

    expect(
      store.commitHoleFillListing(stale, {
        handle: handle(1),
        partId: PART,
        loopCount: 99,
        rows: [],
        truncated: false,
        partFaceCount: 1,
      }),
    ).toBe(false);
    expect(store.getSnapshot().holeFill.inventory.loopCount).toBe(0);
    expect(store.isCurrentHoleFill(current)).toBe(true);
  });
});

describe('selection', () => {
  it('selects by IDENTITY and drops the rim of the previous opening', () => {
    const store = readyStore();
    store.installBoundaryRim({
      boundaryLoopId: 'bl-a',
      partId: PART,
      source: handle(1),
      positions: new Float32Array(6),
      edgeCount: 1,
    });
    expect(store.getSnapshot().holeFill.rim?.boundaryLoopId).toBe('bl-a');

    store.selectBoundaryLoop('bl-b');
    expect(store.getSnapshot().holeFill.selectedLoopId).toBe('bl-b');
    // The rim buffer describes a DIFFERENT opening; carrying it across would
    // highlight the wrong rim.
    expect(store.getSnapshot().holeFill.rim).toBeUndefined();
  });

  it('returns the candidate it abandoned so the worker copy can be released', () => {
    const store = readyStore();
    const built = withCandidate(store);

    const dropped = store.selectBoundaryLoop('bl-b');
    expect(dropped?.candidate.candidateId).toBe(built.candidate.candidateId);
    expect(store.getSnapshot().holeFill.candidate).toBeUndefined();
    expect(store.getSnapshot().holeFill.workState).toBe(HoleFillWorkState.Idle);
  });

  it('refuses a rim for the wrong revision, part or opening', () => {
    const store = readyStore();

    // Wrong revision.
    expect(
      store.installBoundaryRim({
        boundaryLoopId: 'bl-a',
        partId: PART,
        source: handle(9),
        positions: new Float32Array(6),
        edgeCount: 1,
      }),
    ).toBe(false);

    // Wrong part.
    expect(
      store.installBoundaryRim({
        boundaryLoopId: 'bl-a',
        partId: SIBLING,
        source: handle(1),
        positions: new Float32Array(6),
        edgeCount: 1,
      }),
    ).toBe(false);

    // Wrong opening.
    expect(
      store.installBoundaryRim({
        boundaryLoopId: 'bl-b',
        partId: PART,
        source: handle(1),
        positions: new Float32Array(6),
        edgeCount: 1,
      }),
    ).toBe(false);

    expect(store.getSnapshot().holeFill.rim).toBeUndefined();
  });
});

describe('the candidate', () => {
  it('HFUX13: no lifecycle step before Apply moves the model revision', () => {
    const store = readyStore();
    const before = store.getSnapshot().model?.revision;

    store.selectBoundaryLoop('bl-a');
    store.installBoundaryRim({
      boundaryLoopId: 'bl-a',
      partId: PART,
      source: handle(1),
      positions: new Float32Array(6),
      edgeCount: 1,
    });
    const built = withCandidate(store);
    store.installPatchPreview(built.candidate.candidateId, {
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      triangleCount: 1,
    });
    store.clearHoleFillCandidate();

    expect(store.getSnapshot().model?.revision).toBe(before);
    expect(store.getSnapshot().model?.handle.revision).toBe(1);
  });

  it('refuses a candidate that describes a different revision, part or opening', () => {
    const store = readyStore();
    const token = store.beginHoleFillCandidate(handle(1), PART, 'bl-a');
    if (token === undefined) throw new Error('no token');

    expect(store.commitHoleFillCandidate(token, preview({ source: handle(2) }))).toBe(false);
    expect(store.commitHoleFillCandidate(token, preview({ partId: SIBLING }))).toBe(false);
    expect(store.commitHoleFillCandidate(token, preview({ boundaryLoopId: 'bl-b' }))).toBe(false);
    expect(store.getSnapshot().holeFill.candidate).toBeUndefined();
  });

  it('attaches a patch snapshot only to the candidate it belongs to', () => {
    const store = readyStore();
    const built = withCandidate(store);

    expect(
      store.installPatchPreview('hole-fill-candidate-other', {
        positions: new Float32Array(9),
        normals: new Float32Array(9),
        triangleCount: 1,
      }),
    ).toBe(false);
    expect(store.getSnapshot().holeFill.candidate?.patchPositions).toBeUndefined();

    expect(
      store.installPatchPreview(built.candidate.candidateId, {
        positions: new Float32Array(18),
        normals: new Float32Array(18),
        triangleCount: 2,
      }),
    ).toBe(true);
    expect(store.getSnapshot().holeFill.candidate?.patchTriangleCount).toBe(2);
  });

  it('moves through Cancelling before it reports Cancelled', () => {
    /*
     * A REAL STATE, not a cosmetic one. Cancellation is termination, and the
     * promise has not settled at the moment Cancel is pressed. Saying
     * "Cancelled" then would claim the work had stopped while it had not.
     */
    const store = readyStore();
    const token = store.beginHoleFillCandidate(handle(1), PART, 'bl-a');
    if (token === undefined) throw new Error('no token');
    expect(store.getSnapshot().holeFill.workState).toBe(HoleFillWorkState.Generating);

    expect(store.beginHoleFillCancellation(token)).toBe(true);
    expect(store.getSnapshot().holeFill.workState).toBe(HoleFillWorkState.Cancelling);

    expect(store.cancelHoleFillCandidate(token)).toBe(true);
    expect(store.getSnapshot().holeFill.workState).toBe(HoleFillWorkState.Cancelled);
    expect(store.getSnapshot().holeFill.candidate).toBeUndefined();
  });

  it('HFUX12: discarding returns the candidate and keeps the selection', () => {
    const store = readyStore();
    const built = withCandidate(store);

    const dropped = store.clearHoleFillCandidate();
    expect(dropped?.candidate.candidateId).toBe(built.candidate.candidateId);
    // DISCARD IS NOT DESELECT. The user asked to drop the proposal, not to stop
    // looking at the opening.
    expect(store.getSnapshot().holeFill.selectedLoopId).toBe('bl-a');
    expect(store.getSnapshot().holeFill.candidate).toBeUndefined();
  });
});

describe('applying', () => {
  it('HFUX14: increments the workspace revision exactly once', () => {
    const store = readyStore();
    withCandidate(store);
    expect(store.beginHoleFillCommit()).toBe(true);

    const before = store.getSnapshot().model?.revision ?? 0;
    expect(
      store.applyHoleFillResult({
        handle: handle(2),
        parentRevision: 1,
        recordId: 'r-1',
        partId: PART,
        boundaryLoopId: 'bl-a',
        patchFaceCount: 2,
        undoable: true,
        render: render(),
        parts: [descriptor(PART, 14)],
        bounds: bounds(),
        triangleCount: 14,
        vertexCount: 42,
        residentBytes: 2048,
      }),
    ).toBe(true);

    expect(store.getSnapshot().model?.revision).toBe(before + 1);
    expect(store.getSnapshot().model?.handle.revision).toBe(2);
  });

  it('clears the preview, the selection and the inventory, and records what was applied', () => {
    const store = readyStore();
    withCandidate(store);
    store.beginHoleFillCommit();
    store.applyHoleFillResult({
      handle: handle(2),
      parentRevision: 1,
      recordId: 'r-1',
      partId: PART,
      boundaryLoopId: 'bl-a',
      patchFaceCount: 2,
      undoable: true,
      render: render(),
      parts: [descriptor(PART, 14)],
      bounds: bounds(),
      triangleCount: 14,
      vertexCount: 42,
      residentBytes: 2048,
    });

    const holeFill = store.getSnapshot().holeFill;
    // HFUX16 at this layer: nothing on screen still offers to apply it.
    expect(holeFill.candidate).toBeUndefined();
    expect(holeFill.selectedLoopId).toBeUndefined();
    expect(holeFill.workState).toBe(HoleFillWorkState.Idle);
    expect(holeFill.commitState).toBe(HoleFillCommitState.Idle);
    // THE INVENTORY IS NOT DECREMENTED BY HAND. It is cleared, so the hook
    // re-lists against the new revision and the count comes from analysis of
    // the geometry the user now has. §40, §73.
    expect(holeFill.inventory.state).toBe(HoleFillInventoryState.Unavailable);
    expect(holeFill.inventory.loopCount).toBe(0);

    expect(holeFill.lastApplied).toMatchObject({
      recordId: 'r-1',
      partId: PART,
      boundaryLoopId: 'bl-a',
      patchFaceCount: 2,
      undoable: true,
    });
  });

  it('refuses a second commit while one is running', () => {
    const store = readyStore();
    withCandidate(store);
    expect(store.beginHoleFillCommit()).toBe(true);
    expect(store.beginHoleFillCommit()).toBe(false);
  });

  it('refuses a commit with no ready candidate', () => {
    const store = readyStore();
    expect(store.beginHoleFillCommit()).toBe(false);
  });

  it('discards a result for a document that is no longer loaded', () => {
    const store = readyStore();
    withCandidate(store);
    store.beginHoleFillCommit();
    expect(
      store.applyHoleFillResult({
        handle: handle(2, 'other-document'),
        parentRevision: 1,
        recordId: 'r-1',
        partId: PART,
        boundaryLoopId: 'bl-a',
        patchFaceCount: 2,
        undoable: true,
        render: render(),
        parts: [descriptor(PART)],
        bounds: bounds(),
        triangleCount: 14,
        vertexCount: 42,
        residentBytes: 2048,
      }),
    ).toBe(false);
    expect(store.getSnapshot().model?.handle.revision).toBe(1);
  });
});

describe('ONE undo history', () => {
  function applyFill(store: WorkspaceStore): void {
    withCandidate(store);
    store.beginHoleFillCommit();
    store.applyHoleFillResult({
      handle: handle(2),
      parentRevision: 1,
      recordId: 'fill-1',
      partId: PART,
      boundaryLoopId: 'bl-a',
      patchFaceCount: 2,
      undoable: true,
      render: render(),
      parts: [descriptor(PART, 14)],
      bounds: bounds(),
      triangleCount: 14,
      vertexCount: 42,
      residentBytes: 2048,
    });
  }

  it('lets a fill be undone, once', () => {
    const store = readyStore();
    applyFill(store);
    expect(store.beginHoleFillUndo()).toBe(true);
    expect(store.getSnapshot().holeFill.commitState).toBe(HoleFillCommitState.Undoing);

    store.applyUndoResult({
      handle: handle(3),
      partId: PART,
      render: render(),
      parts: [descriptor(PART, 12)],
      bounds: bounds(),
      triangleCount: 12,
      vertexCount: 36,
      residentBytes: 1024,
    });

    // The change it named has been reversed, so it is no longer reversible.
    expect(store.getSnapshot().holeFill.lastApplied).toBeUndefined();
    expect(store.beginHoleFillUndo()).toBe(false);
  });

  it('drops a repair Undo when a fill supersedes it, and the reverse', () => {
    /*
     * THE WORKER HOLDS ONE UNDOABLE RECORD PER DOCUMENT, so the interface must
     * offer one Undo. Leaving the repair's button enabled after a fill would
     * offer to reverse something the worker has already marked superseded — a
     * guard that fires is a bug the user sees.
     */
    const store = readyStore();
    store.applyRepairResult({
      handle: handle(2),
      parentRevision: 1,
      recordId: 'repair-1',
      appliedOperations: ['unify-winding'],
      counts: {} as never,
      undoable: true,
      partId: PART,
      render: render(),
      parts: [descriptor(PART)],
      bounds: bounds(),
      triangleCount: 12,
      vertexCount: 36,
      residentBytes: 1024,
    });
    expect(store.getSnapshot().repair.lastApplied?.undoable).toBe(true);
    // A repair supersedes any fill record.
    expect(store.getSnapshot().holeFill.lastApplied).toBeUndefined();

    // Now a fill supersedes the repair.
    const listing = store.beginHoleFillListing(handle(2), PART);
    store.commitHoleFillListing(listing, {
      handle: handle(2),
      partId: PART,
      loopCount: 1,
      rows: ROWS.slice(0, 1),
      truncated: false,
      partFaceCount: 12,
    });
    store.selectBoundaryLoop('bl-a');
    const token = store.beginHoleFillCandidate(handle(2), PART, 'bl-a');
    if (token === undefined) throw new Error('no token');
    store.commitHoleFillCandidate(token, preview({ source: handle(2) }));
    store.beginHoleFillCommit();
    store.applyHoleFillResult({
      handle: handle(3),
      parentRevision: 2,
      recordId: 'fill-1',
      partId: PART,
      boundaryLoopId: 'bl-a',
      patchFaceCount: 2,
      undoable: true,
      render: render(),
      parts: [descriptor(PART, 14)],
      bounds: bounds(),
      triangleCount: 14,
      vertexCount: 42,
      residentBytes: 2048,
    });

    expect(store.getSnapshot().holeFill.lastApplied?.recordId).toBe('fill-1');
    expect(store.getSnapshot().repair.lastApplied).toBeUndefined();
  });

  it('never runs a fill commit while a repair commit is running', () => {
    const store = readyStore();
    withCandidate(store);
    expect(store.beginRepairCommit()).toBe(false); // no repair candidate
    // With a repair undo claimed, the fill commit must stand down.
    store.applyRepairResult({
      handle: handle(2),
      parentRevision: 1,
      recordId: 'repair-1',
      appliedOperations: [],
      counts: {} as never,
      undoable: true,
      partId: PART,
      render: render(),
      parts: [descriptor(PART)],
      bounds: bounds(),
      triangleCount: 12,
      vertexCount: 36,
      residentBytes: 1024,
    });
    expect(store.beginRepairUndo()).toBe(true);
    expect(store.beginHoleFillUndo()).toBe(false);
  });
});

describe('lifecycle: nothing survives a context change', () => {
  beforeEach(() => {
    // Nothing global to reset; each case builds its own store.
  });

  it('HFUX19: switching parts clears the workflow but keeps the applied record', () => {
    const store = new WorkspaceStore();
    const token = store.beginImport('two.stl');
    store.commitImport(token, model([descriptor(PART), descriptor(SIBLING)]));
    const listing = store.beginHoleFillListing(handle(1), PART);
    store.commitHoleFillListing(listing, {
      handle: handle(1),
      partId: PART,
      loopCount: 2,
      rows: ROWS,
      truncated: false,
      partFaceCount: 12,
    });
    store.selectBoundaryLoop('bl-a');
    withCandidate(store);

    expect(store.selectPart(SIBLING)).toBe(true);

    const holeFill = store.getSnapshot().holeFill;
    // NO APPLY FOR PART A REMAINS ON SCREEN. §52.
    expect(holeFill.candidate).toBeUndefined();
    expect(holeFill.selectedLoopId).toBeUndefined();
    expect(holeFill.rim).toBeUndefined();
    expect(holeFill.inventory.state).toBe(HoleFillInventoryState.Unavailable);
    expect(holeFill.partId).toBe(SIBLING);
  });

  it('HFUX20: importing a different model clears everything, applied record included', () => {
    const store = readyStore();
    withCandidate(store);
    store.beginHoleFillCommit();
    store.applyHoleFillResult({
      handle: handle(2),
      parentRevision: 1,
      recordId: 'fill-1',
      partId: PART,
      boundaryLoopId: 'bl-a',
      patchFaceCount: 2,
      undoable: true,
      render: render(),
      parts: [descriptor(PART, 14)],
      bounds: bounds(),
      triangleCount: 14,
      vertexCount: 42,
      residentBytes: 2048,
    });

    const second = store.beginImport('other.stl');
    store.commitImport(second, {
      ...model([descriptor(PART)]),
      handle: handle(1, 'doc-2'),
    });

    const holeFill = store.getSnapshot().holeFill;
    expect(holeFill.candidate).toBeUndefined();
    expect(holeFill.selectedLoopId).toBeUndefined();
    // The applied record named the PREVIOUS document; it cannot be undone now.
    expect(holeFill.lastApplied).toBeUndefined();
    expect(holeFill.handle?.documentId).toBe('doc-2');
  });

  it('a repair invalidates the fill workflow, because the revision moved', () => {
    const store = readyStore();
    withCandidate(store);

    store.applyRepairResult({
      handle: handle(2),
      parentRevision: 1,
      recordId: 'repair-1',
      appliedOperations: ['unify-winding'],
      counts: {} as never,
      undoable: true,
      partId: PART,
      render: render(),
      parts: [descriptor(PART)],
      bounds: bounds(),
      triangleCount: 12,
      vertexCount: 36,
      residentBytes: 1024,
    });

    const holeFill = store.getSnapshot().holeFill;
    expect(holeFill.candidate).toBeUndefined();
    expect(holeFill.selectedLoopId).toBeUndefined();
    expect(holeFill.inventory.state).toBe(HoleFillInventoryState.Unavailable);
    expect(holeFill.handle?.revision).toBe(2);
  });

  it('an undo invalidates it too', () => {
    const store = readyStore();
    withCandidate(store);

    store.applyUndoResult({
      handle: handle(2),
      partId: PART,
      render: render(),
      parts: [descriptor(PART)],
      bounds: bounds(),
      triangleCount: 12,
      vertexCount: 36,
      residentBytes: 1024,
    });

    expect(store.getSnapshot().holeFill.candidate).toBeUndefined();
    expect(store.getSnapshot().holeFill.inventory.state).toBe(HoleFillInventoryState.Unavailable);
  });

  it('losing the geometry session clears every part of it', () => {
    const store = readyStore();
    withCandidate(store);
    store.loseGeometrySession('The geometry worker stopped.');

    const holeFill = store.getSnapshot().holeFill;
    expect(holeFill.candidate).toBeUndefined();
    expect(holeFill.selectedLoopId).toBeUndefined();
    expect(holeFill.lastApplied).toBeUndefined();
    expect(holeFill.handle).toBeUndefined();
    expect(holeFill.inventory.state).toBe(HoleFillInventoryState.Unavailable);
  });
});
