import { invalidState, modelUnavailable, type AppError } from '@cadfixer/shared';
import type { RepairInversePatch, RepairOperation } from '@cadfixer/mesh-repair';
import type { PartId } from '@cadfixer/mesh-core';
import type { DocumentHandle, DocumentId } from './resident-documents';

/**
 * WORKER-RESIDENT REPAIR HISTORY.
 *
 * Stage 3B-1A produced an inverse patch for every accepted repair but had
 * nowhere to keep it. This is that place, and it is deliberately in the worker
 * rather than in React state: undo must restore AUTHORITATIVE geometry, and the
 * main thread does not hold any. A React-held copy of the pre-repair mesh would
 * make the UI a second owner of the user's data and would defeat the resident
 * design entirely — see docs/adr/0008.
 *
 * WHAT IS RETAINED, and what is not. Exactly ONE undoable patch per model: the
 * most recent repair. A deeper stack would retain a patch per step for the
 * lifetime of the session, and a patch is proportional to what its repair
 * removed rather than to a fixed cost. Superseded records survive as
 * DESCRIPTORS — what was applied, and between which revisions — with their patch
 * released, so the trail stays readable without holding geometry for it.
 *
 * REDO IS NOT IMPLEMENTED. Undoing retains no forward patch, and nothing here
 * pretends otherwise. See docs/adr/0011.
 */

/** What a committed repair did. Never carries geometry. */
export interface RepairHistoryEntry {
  readonly recordId: string;
  readonly documentId: DocumentId;
  /**
   * The part whose mesh this repair replaced.
   *
   * Undo has to put geometry back where it came from. Without the part id an
   * undo could only say "restore the previous mesh" and would have to guess
   * which part that was — and in a multi-part document a wrong guess overwrites
   * a part the user never repaired.
   */
  readonly partId: PartId;
  /** Revision the repair was computed from. */
  readonly parentRevision: number;
  /** Revision the repair produced. */
  readonly resultRevision: number;
  readonly appliedOperations: readonly RepairOperation[];
  readonly planHash: string;
  /** Bytes the inverse patch occupies while it is still retained. */
  readonly inverseBytes: number;
  /**
   * Whether this record can still be reversed.
   *
   * False once it has been undone, once a later repair superseded it, or once
   * it was registered without an inverse patch.
   */
  readonly undoable: boolean;
}

interface HistoryRecord {
  entry: RepairHistoryEntry;
  patch: RepairInversePatch | undefined;
  undone: boolean;
  superseded: boolean;
}

export interface RepairHistoryStats {
  readonly recordCount: number;
  readonly undoableCount: number;
  readonly retainedBytes: number;
}

export interface RepairUndoPreparation {
  readonly patch: RepairInversePatch;
  readonly entry: RepairHistoryEntry;
}

/**
 * Descriptors kept per store.
 *
 * Bounded so a long session of repairs cannot grow the list without limit. Only
 * the newest record per model ever holds a patch, so this caps descriptors, not
 * geometry.
 */
const MAX_RETAINED_DESCRIPTORS = 64;

export class RepairHistoryStore {
  private readonly records = new Map<string, HistoryRecord>();
  /** Newest undoable record id per document. At most one — see the header. */
  private readonly undoableByDocument = new Map<DocumentId, string>();
  /** Insertion order, so the oldest descriptors can be evicted first. */
  private readonly order: string[] = [];

  /**
   * Registers a committed repair and its inverse patch.
   *
   * Supersedes any earlier undoable record for the same model and releases that
   * patch immediately. One step of undo is a promise this store can keep; an
   * unbounded stack is not.
   */
  public record(input: {
    readonly recordId: string;
    readonly source: DocumentHandle;
    readonly part: PartId;
    readonly result: DocumentHandle;
    readonly appliedOperations: readonly RepairOperation[];
    readonly planHash: string;
    readonly inverse: RepairInversePatch | undefined;
  }): RepairHistoryEntry {
    const previous = this.undoableByDocument.get(input.source.documentId);
    if (previous !== undefined) this.release(previous, 'superseded');

    const entry: RepairHistoryEntry = {
      recordId: input.recordId,
      documentId: input.source.documentId,
      partId: input.part,
      parentRevision: input.source.revision,
      resultRevision: input.result.revision,
      appliedOperations: [...input.appliedOperations],
      planHash: input.planHash,
      inverseBytes: input.inverse?.byteLength ?? 0,
      undoable: input.inverse !== undefined,
    };

    this.records.set(input.recordId, {
      entry,
      patch: input.inverse,
      undone: false,
      superseded: false,
    });
    this.order.push(input.recordId);
    if (input.inverse !== undefined) {
      this.undoableByDocument.set(input.source.documentId, input.recordId);
    }
    this.trim();
    return entry;
  }

  /** The record `undo` would reverse for this document, if there is one. */
  public undoableFor(documentId: DocumentId): RepairHistoryEntry | undefined {
    const recordId = this.undoableByDocument.get(documentId);
    if (recordId === undefined) return undefined;
    return this.records.get(recordId)?.entry;
  }

  public entryOf(recordId: string): RepairHistoryEntry | undefined {
    return this.records.get(recordId)?.entry;
  }

  /**
   * Resolves an undo request, applying every guard.
   *
   * The guards mirror `RepairCandidateStore.prepareCommit`, for the same reason:
   * undo replaces authoritative geometry, so it is a transaction and not a
   * convenience. Every rejection is a typed `AppError` rather than an `undefined`
   * a caller could mistake for "nothing to do".
   */
  public prepareUndo(
    recordId: string,
    expected: DocumentHandle,
    currentRevision: number | undefined,
  ): RepairUndoPreparation | AppError {
    const record = this.records.get(recordId);
    if (record === undefined) {
      return modelUnavailable('That repair is no longer available to undo.', { recordId });
    }
    if (record.undone) {
      return invalidState('That repair has already been undone.', { recordId });
    }
    if (record.superseded) {
      return invalidState('A later repair replaced that one, so it can no longer be undone.', {
        recordId,
      });
    }
    if (record.entry.documentId !== expected.documentId) {
      return invalidState('That repair belongs to a different model.', {
        recordId,
        recordDocumentId: record.entry.documentId,
        requestedDocumentId: expected.documentId,
      });
    }
    /*
     * THE STALENESS GUARD. Undo reverses one specific revision transition. If the
     * model has moved past `resultRevision` — another repair, another undo — then
     * applying this patch would reconstruct a mesh from geometry the patch was
     * never computed against.
     */
    if (
      record.entry.resultRevision !== expected.revision ||
      currentRevision !== record.entry.resultRevision
    ) {
      return modelUnavailable('The model changed since that repair was applied.', {
        recordId,
        resultRevision: record.entry.resultRevision,
        requestedRevision: expected.revision,
        currentRevision: currentRevision ?? -1,
      });
    }
    const patch = record.patch;
    if (patch === undefined) {
      return modelUnavailable('The information needed to undo that repair is no longer held.', {
        recordId,
      });
    }
    return { patch, entry: record.entry };
  }

  /**
   * Marks a record undone and releases its patch.
   *
   * Called only AFTER the resident store accepted the replacement, so a refused
   * swap leaves the record undoable and retryable rather than consumed.
   */
  public markUndone(recordId: string): void {
    this.release(recordId, 'undone');
  }

  /**
   * Invalidates the undoable record for a model.
   *
   * Used when a model is released or the session is lost: the history describes
   * geometry that no longer exists, and the patch would hold bytes for a repair
   * nothing can reverse.
   */
  public releaseDocument(documentId: DocumentId): void {
    const recordId = this.undoableByDocument.get(documentId);
    if (recordId !== undefined) this.release(recordId, 'superseded');
  }

  /** Releases everything. Worker teardown; Policy A applies. */
  public releaseAll(): void {
    for (const record of this.records.values()) record.patch = undefined;
    this.records.clear();
    this.undoableByDocument.clear();
    this.order.length = 0;
  }

  public stats(): RepairHistoryStats {
    let retainedBytes = 0;
    let undoableCount = 0;
    for (const record of this.records.values()) {
      if (record.patch === undefined) continue;
      undoableCount += 1;
      retainedBytes += record.entry.inverseBytes;
    }
    return { recordCount: this.records.size, undoableCount, retainedBytes };
  }

  private release(recordId: string, cause: 'undone' | 'superseded'): void {
    const record = this.records.get(recordId);
    if (record === undefined) return;
    record.patch = undefined;
    if (cause === 'undone') record.undone = true;
    else record.superseded = true;
    record.entry = { ...record.entry, undoable: false };
    if (this.undoableByDocument.get(record.entry.documentId) === recordId) {
      this.undoableByDocument.delete(record.entry.documentId);
    }
  }

  /**
   * Evicts the oldest descriptors once the cap is reached.
   *
   * A record that is still its model's undoable one is never evicted: the cap
   * bounds descriptors, and silently discarding the user's undo to satisfy it
   * would be the wrong trade.
   */
  private trim(): void {
    let scanned = 0;
    while (this.order.length > MAX_RETAINED_DESCRIPTORS && scanned < this.order.length) {
      const oldest = this.order[0];
      if (oldest === undefined) return;
      const record = this.records.get(oldest);
      if (record !== undefined && this.undoableByDocument.get(record.entry.documentId) === oldest) {
        // Keep it; move it behind the others so the scan makes progress.
        this.order.shift();
        this.order.push(oldest);
        scanned += 1;
        continue;
      }
      this.order.shift();
      this.records.delete(oldest);
    }
  }
}
