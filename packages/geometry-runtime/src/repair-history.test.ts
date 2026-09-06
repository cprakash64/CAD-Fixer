import { describe, expect, it } from 'vitest';
import { partId } from '@cadfixer/mesh-core';
import { isAppError, AppErrorCode } from '@cadfixer/shared';
import type { RepairInversePatch } from '@cadfixer/mesh-repair';
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

/** A repair's inverse, in the discriminated shape the store now holds. */
function repairInverse(faceCount = 4, byteLength = 128): UndoableInverse {
  return {
    kind: UndoableChangeKind.ConservativeRepair,
    patch: patch(faceCount, byteLength),
    byteLength,
  };
}

/**
 * A hole fill's inverse: two counts and nothing else.
 *
 * The append-only contract is what makes this exact. Storing coordinates for it
 * would be retaining a copy of bytes the preservation gate has already proven
 * unchanged.
 */
function holeFillInverse(sourceFaceCount = 4): UndoableInverse {
  return {
    kind: UndoableChangeKind.HoleFill,
    sourceFaceCount,
    sourceIndexCount: sourceFaceCount * 3,
    byteLength: 0,
  };
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
    inverse: repairInverse(),
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
      kind: UndoableChangeKind.ConservativeRepair,
      recordId: 'other',
      source: handle(1, 'model-2'),
      result: handle(2, 'model-2'),
      appliedOperations: [],
      planHash: 'ffff',
      inverse: repairInverse(),
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
    expect(prepared.inverse.kind).toBe(UndoableChangeKind.ConservativeRepair);
    if (prepared.inverse.kind !== UndoableChangeKind.ConservativeRepair) return;
    expect(prepared.inverse.patch.sourceFaceCount).toBe(4);
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
      inverse: holeFillInverse(12),
    });
  }

  it('records the kind, the opening and a zero-byte inverse', () => {
    const store = new RepairHistoryStore();
    recordFill(store);

    const entry = store.undoableFor('model-1' as DocumentId);
    expect(entry?.kind).toBe(UndoableChangeKind.HoleFill);
    expect(entry?.boundaryLoopId).toBe('bl-7-4-abcdef0123456789');
    expect(entry?.appliedOperations).toEqual([]);
    expect(entry?.undoable).toBe(true);
    // Reversing an append costs nothing to retain: the positions and the index
    // prefix are provably unchanged, so there is nothing to keep a copy of.
    expect(entry?.inverseBytes).toBe(0);
    expect(store.stats().retainedBytes).toBe(0);
  });

  it('resolves the truncation counts when everything still holds', () => {
    const store = new RepairHistoryStore();
    recordFill(store);

    const prepared = store.prepareUndo('f1', handle(2), 2);
    expect(isAppError(prepared)).toBe(false);
    if (isAppError(prepared)) return;
    expect(prepared.inverse.kind).toBe(UndoableChangeKind.HoleFill);
    if (prepared.inverse.kind !== UndoableChangeKind.HoleFill) return;
    expect(prepared.inverse.sourceFaceCount).toBe(12);
    expect(prepared.inverse.sourceIndexCount).toBe(36);
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
      inverse: repairInverse(),
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
