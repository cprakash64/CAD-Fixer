import { describe, expect, it } from 'vitest';
import { meshByteLength, partId } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { isAppError, AppErrorCode } from '@cadfixer/shared';
import { RepairHistoryStore, UndoableChangeKind, type UndoableInverse } from './repair-history';
import type { DocumentHandle, DocumentId } from './resident-documents';

/**
 * UNDO IS A TRANSACTION, so its guards are tested like a transaction's: every
 * refusal path has a case, and every one of them must produce a TYPED error
 * rather than an `undefined` a caller could read as "nothing to do".
 *
 * The failures these cover are all the same shape — applying an inverse patch to
 * geometry it was not computed against — and all of them would silently corrupt
 * the user's model rather than failing loudly.
 */

/** The part every fixture record names. Undo restores geometry to one part. */
const PART = partId('part-1');

function handle(revision: number, documentId = 'model-1'): DocumentHandle {
  return { documentId: documentId as DocumentId, revision };
}

/**
 * AN INVERSE IS THE MESH THE PART HELD — Stage 4B-1C, for BOTH kinds of change.
 *
 * It was two shapes: a hole fill retained a reference and a repair retained a
 * PATCH of removed triangles to rebuild from. The rebuild was the defect — it
 * returned an indexed mesh as soup and a shared mesh as a new object — so there
 * is now one shape and one reconstruction, which cannot drift.
 */
function inverseOf(sourceFaceCount = 4, mesh = meshOf(sourceFaceCount)): UndoableInverse {
  return {
    previousMesh: mesh,
    sourceFaceCount,
    sourceIndexCount: mesh.indices.length,
    byteLength: meshByteLength(mesh),
  };
}

/** A soup mesh of `faces` triangles. Distinct objects for distinct calls. */
function meshOf(faces: number): CanonicalMesh {
  const positions = new Float32Array(faces * 9);
  const indices = new Uint32Array(faces * 3);
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;
  return { positions, indices, metadata: {} };
}

function recordOne(store: RepairHistoryStore, from = 1, to = 2, recordId = 'r1'): void {
  store.record({
    recordId,
    kind: UndoableChangeKind.ConservativeRepair,
    part: PART,
    source: handle(from),
    result: handle(to),
    appliedOperations: ['remove-duplicate-faces'],
    planHash: 'abcd1234',
    inverse: inverseOf(),
  });
}

describe('recording a committed repair', () => {
  it('describes what happened without carrying geometry', () => {
    const store = new RepairHistoryStore();
    recordOne(store);

    const entry = store.undoableFor('model-1' as DocumentId);
    expect(entry).toBeDefined();
    expect(entry?.parentRevision).toBe(1);
    expect(entry?.resultRevision).toBe(2);
    expect(entry?.appliedOperations).toEqual(['remove-duplicate-faces']);
    expect(entry?.undoable).toBe(true);
    // The entry is a descriptor. Nothing on it is a typed array.
    for (const value of Object.values(entry ?? {})) {
      expect(ArrayBuffer.isView(value)).toBe(false);
    }
  });

  it('is not undoable when no inverse patch was produced', () => {
    const store = new RepairHistoryStore();
    store.record({
      part: PART,
      kind: UndoableChangeKind.ConservativeRepair,
      recordId: 'r1',
      source: handle(1),
      result: handle(2),
      appliedOperations: [],
      planHash: 'abcd1234',
      inverse: undefined,
    });

    expect(store.undoableFor('model-1' as DocumentId)).toBeUndefined();
    expect(store.entryOf('r1')?.undoable).toBe(false);
  });

  it('retains exactly one undoable record per model, releasing the older one', () => {
    /*
     * ONE MESH RETAINED, NOT ONE PER STEP. The figure is DERIVED from the mesh
     * the record holds rather than written as a literal — since Stage 4B-1C the
     * inverse is the previous `CanonicalMesh`, so a hard-coded number would say
     * nothing about what is actually kept and would have to be edited every time
     * the fixture changed.
     */
    const retained = meshByteLength(meshOf(4));
    const store = new RepairHistoryStore();
    recordOne(store, 1, 2, 'r1');
    expect(store.stats().retainedBytes).toBe(retained);

    recordOne(store, 2, 3, 'r2');

    // The newer change is the undoable one, and the older record's mesh is
    // released rather than accumulating for the lifetime of the session.
    expect(store.undoableFor('model-1' as DocumentId)?.recordId).toBe('r2');
    expect(store.entryOf('r1')?.undoable).toBe(false);
    expect(store.stats().undoableCount).toBe(1);
    expect(store.stats().retainedBytes).toBe(retained);
  });

  it('keeps models independent', () => {
    const store = new RepairHistoryStore();
    recordOne(store, 1, 2, 'r1');
    store.record({
      part: PART,
      kind: UndoableChangeKind.ConservativeRepair,
      recordId: 'other',
      source: handle(1, 'model-2'),
      result: handle(2, 'model-2'),
      appliedOperations: [],
      planHash: 'ffff',
      inverse: inverseOf(),
    });

    expect(store.undoableFor('model-1' as DocumentId)?.recordId).toBe('r1');
    expect(store.undoableFor('model-2' as DocumentId)?.recordId).toBe('other');
    expect(store.stats().undoableCount).toBe(2);
  });
});

describe('the undo guards', () => {
  it('resolves the patch when everything still holds', () => {
    const store = new RepairHistoryStore();
    recordOne(store);

    const prepared = store.prepareUndo('r1', handle(2), 2);
    expect(isAppError(prepared)).toBe(false);
    if (isAppError(prepared)) return;
    expect(prepared.inverse.sourceFaceCount).toBe(4);
    expect(prepared.entry.parentRevision).toBe(1);
  });

  it('refuses an unknown record', () => {
    const store = new RepairHistoryStore();
    const prepared = store.prepareUndo('nope', handle(2), 2);
    expect(isAppError(prepared) && prepared.code).toBe(AppErrorCode.ModelUnavailable);
  });

  it('refuses a second undo of the same repair', () => {
    const store = new RepairHistoryStore();
    recordOne(store);
    store.markUndone('r1');

    const prepared = store.prepareUndo('r1', handle(2), 2);
    expect(isAppError(prepared) && prepared.code).toBe(AppErrorCode.InvalidState);
    expect(isAppError(prepared) && prepared.message).toMatch(/already been undone/i);
  });

  it('refuses a repair a later change superseded', () => {
    const store = new RepairHistoryStore();
    recordOne(store, 1, 2, 'r1');
    recordOne(store, 2, 3, 'r2');

    const prepared = store.prepareUndo('r1', handle(2), 2);
    expect(isAppError(prepared) && prepared.code).toBe(AppErrorCode.InvalidState);
    /*
     * "CHANGE", NOT "REPAIR" — Stage 4B-1B2. The sentence widened when the
     * store started holding hole fills as well as repairs, and it had to: the
     * change that supersedes a repair is now just as likely to be a fill, and
     * telling the user "a later repair replaced that one" when a fill did would
     * name an operation that never ran. Asserted exactly rather than loosened.
     */
    expect(isAppError(prepared) && prepared.message).toBe(
      'A later change replaced that one, so it can no longer be undone.',
    );
  });

  it('refuses a record belonging to a different model', () => {
    const store = new RepairHistoryStore();
    recordOne(store);

    const prepared = store.prepareUndo('r1', handle(2, 'model-9'), 2);
    expect(isAppError(prepared) && prepared.code).toBe(AppErrorCode.InvalidState);
    expect(isAppError(prepared) && prepared.message).toMatch(/different model/i);
  });

  it('refuses when the CALLER believes a different revision is current', () => {
    // The stale-handle case: the caller is a revision behind.
    const store = new RepairHistoryStore();
    recordOne(store);

    const prepared = store.prepareUndo('r1', handle(1), 2);
    expect(isAppError(prepared) && prepared.code).toBe(AppErrorCode.ModelUnavailable);
  });

  it('refuses when the STORE has moved past the repaired revision', () => {
    // Both checks matter: the caller can be right about what it saw while the
    // model has already moved on underneath it.
    const store = new RepairHistoryStore();
    recordOne(store);

    const prepared = store.prepareUndo('r1', handle(2), 3);
    expect(isAppError(prepared) && prepared.code).toBe(AppErrorCode.ModelUnavailable);
    expect(isAppError(prepared) && prepared.message).toMatch(/changed since/i);
  });

  it('leaves the record undoable when preparation is not followed by markUndone', () => {
    // The commit path marks a record undone only AFTER the resident store has
    // accepted the swap, so a refused swap must leave it retryable.
    const store = new RepairHistoryStore();
    recordOne(store);

    expect(isAppError(store.prepareUndo('r1', handle(2), 2))).toBe(false);
    expect(isAppError(store.prepareUndo('r1', handle(2), 2))).toBe(false);
    expect(store.undoableFor('model-1' as DocumentId)?.undoable).toBe(true);
  });
});

describe('release', () => {
  it('drops a model’s undo when the model itself is released', () => {
    const store = new RepairHistoryStore();
    recordOne(store);

    store.releaseDocument('model-1' as DocumentId);

    expect(store.undoableFor('model-1' as DocumentId)).toBeUndefined();
    expect(store.stats().retainedBytes).toBe(0);
    expect(isAppError(store.prepareUndo('r1', handle(2), 2))).toBe(true);
  });

  it('releases everything when the session ends', () => {
    const store = new RepairHistoryStore();
    recordOne(store, 1, 2, 'r1');
    recordOne(store, 1, 2, 'r2');

    store.releaseAll();

    expect(store.stats()).toEqual({ recordCount: 0, undoableCount: 0, retainedBytes: 0 });
  });

  it('bounds the descriptor list without evicting a live undo', () => {
    const store = new RepairHistoryStore();
    // One live undo for model-1, then many completed ones for other models.
    recordOne(store, 1, 2, 'keep-me');
    for (let index = 0; index < 200; index += 1) {
      store.record({
        part: PART,
        kind: UndoableChangeKind.ConservativeRepair,
        recordId: `noise-${String(index)}`,
        source: handle(1, `model-${String(index + 10)}`),
        result: handle(2, `model-${String(index + 10)}`),
        appliedOperations: [],
        planHash: 'x',
        inverse: undefined,
      });
    }

    expect(store.stats().recordCount).toBeLessThanOrEqual(64);
    // The user's one reversible repair survived the cap.
    expect(store.undoableFor('model-1' as DocumentId)?.recordId).toBe('keep-me');
  });
});

/**
 * ONE HISTORY, TWO KINDS OF CHANGE — Stage 4B-1B2.
 *
 * The guards are shared deliberately, so these cases prove the SHARING rather
 * than re-proving the guards: a hole fill is recorded, reversed and superseded
 * by exactly the machinery a repair is. A second hole-specific store would have
 * had to re-establish every one of the cases above, and the two would have
 * drifted the first time one was corrected.
 */
describe('a hole fill uses the same one-step history', () => {
  function recordFill(store: RepairHistoryStore, from = 1, to = 2, recordId = 'f1'): void {
    store.record({
      recordId,
      kind: UndoableChangeKind.HoleFill,
      part: PART,
      source: handle(from),
      result: handle(to),
      appliedOperations: [],
      planHash: 'loop-hash',
      boundaryLoopId: 'bl-7-4-abcdef0123456789',
      inverse: inverseOf(12),
    });
  }

  it('records the kind, the opening, and what the retained mesh costs', () => {
    const store = new RepairHistoryStore();
    recordFill(store);

    const entry = store.undoableFor('model-1' as DocumentId);
    expect(entry?.kind).toBe(UndoableChangeKind.HoleFill);
    expect(entry?.boundaryLoopId).toBe('bl-7-4-abcdef0123456789');
    expect(entry?.appliedOperations).toEqual([]);
    expect(entry?.undoable).toBe(true);
    /*
     * REPORTED, NOT HIDDEN — Stage 4B-1B2-R1. The record retains the mesh the
     * part held, because restoring bytes is not restoring a shared document.
     * `retainedBytes` is that mesh's size: an upper bound on what the record
     * costs, which is zero extra when a sibling still references it.
     */
    expect(entry?.retainedBytes).toBe(meshByteLength(meshOf(12)));
    expect(store.stats().retainedBytes).toBe(entry?.retainedBytes);
  });

  it('resolves THE SAME MESH OBJECT, not a description of one', () => {
    const store = new RepairHistoryStore();
    const original = meshOf(12);
    store.record({
      recordId: 'f1',
      kind: UndoableChangeKind.HoleFill,
      part: PART,
      source: handle(1),
      result: handle(2),
      appliedOperations: [],
      planHash: 'loop-hash',
      boundaryLoopId: 'bl-7-4-abcdef0123456789',
      inverse: inverseOf(12, original),
    });

    const prepared = store.prepareUndo('f1', handle(2), 2);
    expect(isAppError(prepared)).toBe(false);
    if (isAppError(prepared)) return;
    // REFERENCE IDENTITY. A byte-equal copy would satisfy every other assertion
    // in this file and would still lose the document's sharing.
    expect(prepared.inverse.previousMesh).toBe(original);
    expect(prepared.inverse.sourceFaceCount).toBe(12);
    expect(prepared.inverse.sourceIndexCount).toBe(36);
  });

  it('US11: releases the retained mesh when the record stops being undoable', () => {
    const store = new RepairHistoryStore();
    recordFill(store);
    expect(store.stats().retainedBytes).toBeGreaterThan(0);

    store.markUndone('f1');

    /*
     * DETERMINISTIC OWNERSHIP, not a GC claim. The store holds no inverse, so it
     * holds no mesh — that is a statement about references this code owns, which
     * is the only kind of memory statement worth making.
     */
    expect(store.stats().retainedBytes).toBe(0);
    expect(store.stats().undoableCount).toBe(0);
  });

  it('US11: releases the retained mesh when a later change supersedes it', () => {
    const store = new RepairHistoryStore();
    recordFill(store, 1, 2, 'f1');
    recordFill(store, 2, 3, 'f2');

    // One undoable record per document, so the first record's mesh is dropped
    // the moment the second is written — not left pinned until the session ends.
    expect(store.entryOf('f1')?.undoable).toBe(false);
    expect(store.stats().undoableCount).toBe(1);
    expect(store.stats().retainedBytes).toBe(store.entryOf('f2')?.retainedBytes);
  });

  it('US13: releases the retained mesh when the document goes away', () => {
    const store = new RepairHistoryStore();
    recordFill(store);
    store.releaseDocument('model-1' as DocumentId);
    expect(store.stats().retainedBytes).toBe(0);

    recordFill(store, 1, 2, 'f2');
    store.releaseAll();
    expect(store.stats().retainedBytes).toBe(0);
    expect(store.stats().recordCount).toBe(0);
  });

  it('is refused once the model has moved past the revision it produced', () => {
    const store = new RepairHistoryStore();
    recordFill(store);

    const prepared = store.prepareUndo('f1', handle(2), 3);
    expect(isAppError(prepared)).toBe(true);
    if (!isAppError(prepared)) return;
    expect(prepared.code).toBe(AppErrorCode.ModelUnavailable);
  });

  it('supersedes an earlier repair, and is superseded by a later repair', () => {
    const store = new RepairHistoryStore();
    recordOne(store, 1, 2, 'r1');
    recordFill(store, 2, 3, 'f1');

    // ONE undoable change per document. The repair is no longer reversible,
    // because the geometry its patch was computed against is not authoritative
    // any more.
    expect(store.undoableFor('model-1' as DocumentId)?.recordId).toBe('f1');
    expect(store.entryOf('r1')?.undoable).toBe(false);

    store.record({
      recordId: 'r2',
      kind: UndoableChangeKind.ConservativeRepair,
      part: PART,
      source: handle(3),
      result: handle(4),
      appliedOperations: ['unify-winding'],
      planHash: 'zzzz',
      inverse: inverseOf(),
    });
    expect(store.undoableFor('model-1' as DocumentId)?.recordId).toBe('r2');
    expect(store.entryOf('f1')?.undoable).toBe(false);
  });

  it('cannot be undone twice', () => {
    const store = new RepairHistoryStore();
    recordFill(store);
    store.markUndone('f1');

    const prepared = store.prepareUndo('f1', handle(2), 2);
    expect(isAppError(prepared)).toBe(true);
    if (!isAppError(prepared)) return;
    expect(prepared.code).toBe(AppErrorCode.InvalidState);
  });
});
