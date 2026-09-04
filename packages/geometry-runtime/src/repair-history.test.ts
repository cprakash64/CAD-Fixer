import { describe, expect, it } from 'vitest';
import { partId } from '@cadfixer/mesh-core';
import { isAppError, AppErrorCode } from '@cadfixer/shared';
import type { RepairInversePatch } from '@cadfixer/mesh-repair';
import { RepairHistoryStore } from './repair-history';
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

function patch(faceCount = 4, byteLength = 128): RepairInversePatch {
  return {
    schemaVersion: 1,
    sourceFaceCount: faceCount,
    removedFaces: new Uint32Array([0]),
    removedCoordinates: new Float64Array(9),
    flippedFaces: new Uint32Array(0),
    groups: undefined,
    byteLength,
  };
}

function recordOne(store: RepairHistoryStore, from = 1, to = 2, recordId = 'r1'): void {
  store.record({
    recordId,
    part: PART,
    source: handle(from),
    result: handle(to),
    appliedOperations: ['remove-duplicate-faces'],
    planHash: 'abcd1234',
    inverse: patch(),
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

  it('retains exactly one undoable patch per model, releasing the older one', () => {
    const store = new RepairHistoryStore();
    recordOne(store, 1, 2, 'r1');
    expect(store.stats().retainedBytes).toBe(128);

    recordOne(store, 2, 3, 'r2');

    // The newer repair is the undoable one, and the older patch is gone rather
    // than accumulating for the lifetime of the session.
    expect(store.undoableFor('model-1' as DocumentId)?.recordId).toBe('r2');
    expect(store.entryOf('r1')?.undoable).toBe(false);
    expect(store.stats().undoableCount).toBe(1);
    expect(store.stats().retainedBytes).toBe(128);
  });

  it('keeps models independent', () => {
    const store = new RepairHistoryStore();
    recordOne(store, 1, 2, 'r1');
    store.record({
      part: PART,
      recordId: 'other',
      source: handle(1, 'model-2'),
      result: handle(2, 'model-2'),
      appliedOperations: [],
      planHash: 'ffff',
      inverse: patch(),
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
    expect(prepared.patch.sourceFaceCount).toBe(4);
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

  it('refuses a repair a later repair superseded', () => {
    const store = new RepairHistoryStore();
    recordOne(store, 1, 2, 'r1');
    recordOne(store, 2, 3, 'r2');

    const prepared = store.prepareUndo('r1', handle(2), 2);
    expect(isAppError(prepared) && prepared.code).toBe(AppErrorCode.InvalidState);
    expect(isAppError(prepared) && prepared.message).toMatch(/later repair/i);
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
