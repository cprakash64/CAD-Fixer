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
 *
 * ONE STACK FOR EVERY DOCUMENT MUTATION — Stage 4B-1B2. A hole fill is recorded
 * here too, and reversed by the same `repair/undo` transaction. A second,
 * hole-specific history would be a second answer to "what does Undo do next",
 * and the two would eventually disagree about which change is the most recent
 * one. What differs between the two kinds of change is only HOW the previous
 * geometry is reconstructed, so that is the only thing the record varies: the
 * inverse is a discriminated union and everything else — the guards, the
 * supersession rule, the one-per-document cap, the descriptor trail — is shared.
 */

/**
 * How a recorded change is reversed.
 *
 * TWO SHAPES, BECAUSE THE TWO OPERATIONS ARE GENUINELY DIFFERENT, not because
 * the union looked tidy:
 *
 *   - a conservative repair REMOVES faces and reorders corners within a face,
 *     so reversing it needs the removed triangles' coordinates back;
 *   - a hole fill is APPEND-ONLY. The authoritative preservation gate proves the
 *     candidate's positions are the source's bytes and its index prefix is the
 *     source's index bytes, so the exact inverse is a single number: the face
 *     count to truncate back to. Retaining coordinates for it would be storing a
 *     copy of data that demonstrably has not changed.
 */
export const UndoableChangeKind = {
  ConservativeRepair: 'conservative-repair',
  HoleFill: 'hole-fill',
} as const;

export type UndoableChangeKind = (typeof UndoableChangeKind)[keyof typeof UndoableChangeKind];

export type UndoableInverse =
  | {
      readonly kind: typeof UndoableChangeKind.ConservativeRepair;
      readonly patch: RepairInversePatch;
      readonly byteLength: number;
    }
  | {
      readonly kind: typeof UndoableChangeKind.HoleFill;
      /** Faces the part had before the patch was appended. The whole inverse. */
      readonly sourceFaceCount: number;
      /** Index entries the part had before the patch. Truncation is exact on these. */
      readonly sourceIndexCount: number;
      readonly byteLength: number;
    };

/** What a committed change did. Never carries geometry. */
export interface RepairHistoryEntry {
  readonly recordId: string;
  /**
   * Which kind of change this was.
   *
   * The interface needs it to say what Undo would reverse, and the undo handler
   * needs it to choose a reconstruction. Never inferred from the presence or
   * absence of a field — an inference is a guess, and this decides which
   * geometry replaces the user's model.
   */
  readonly kind: UndoableChangeKind;
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
  /** Empty for a hole fill: filling an opening is not one of the four operations. */
  readonly appliedOperations: readonly RepairOperation[];
  readonly planHash: string;
  /** The opening that was filled. Present only for a hole fill. */
  readonly boundaryLoopId?: string;
  /** Bytes the inverse occupies while it is still retained. Zero for a hole fill. */
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
  inverse: UndoableInverse | undefined;
  undone: boolean;
  superseded: boolean;
}

export interface RepairHistoryStats {
  readonly recordCount: number;
  readonly undoableCount: number;
  readonly retainedBytes: number;
}

export interface RepairUndoPreparation {
  readonly inverse: UndoableInverse;
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
    readonly kind: UndoableChangeKind;
    readonly source: DocumentHandle;
    readonly part: PartId;
    readonly result: DocumentHandle;
    readonly appliedOperations: readonly RepairOperation[];
    readonly planHash: string;
    readonly boundaryLoopId?: string;
    readonly inverse: UndoableInverse | undefined;
  }): RepairHistoryEntry {
    const previous = this.undoableByDocument.get(input.source.documentId);
    if (previous !== undefined) this.release(previous, 'superseded');

    const entry: RepairHistoryEntry = {
      recordId: input.recordId,
      kind: input.kind,
      documentId: input.source.documentId,
      partId: input.part,
      parentRevision: input.source.revision,
      resultRevision: input.result.revision,
      appliedOperations: [...input.appliedOperations],
      planHash: input.planHash,
      ...(input.boundaryLoopId === undefined ? {} : { boundaryLoopId: input.boundaryLoopId }),
      inverseBytes: input.inverse?.byteLength ?? 0,
      undoable: input.inverse !== undefined,
    };

    this.records.set(input.recordId, {
      entry,
      inverse: input.inverse,
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
      return modelUnavailable('That change is no longer available to undo.', { recordId });
    }
    if (record.undone) {
      return invalidState('That change has already been undone.', { recordId });
    }
    if (record.superseded) {
      return invalidState('A later change replaced that one, so it can no longer be undone.', {
        recordId,
      });
    }
    if (record.entry.documentId !== expected.documentId) {
      return invalidState('That change belongs to a different model.', {
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
      return modelUnavailable('The model changed since that change was applied.', {
        recordId,
        resultRevision: record.entry.resultRevision,
        requestedRevision: expected.revision,
        currentRevision: currentRevision ?? -1,
      });
    }
    const inverse = record.inverse;
    if (inverse === undefined) {
      return modelUnavailable('The information needed to undo that change is no longer held.', {
        recordId,
      });
    }
    return { inverse, entry: record.entry };
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
    for (const record of this.records.values()) record.inverse = undefined;
    this.records.clear();
    this.undoableByDocument.clear();
    this.order.length = 0;
  }

  public stats(): RepairHistoryStats {
    let retainedBytes = 0;
    let undoableCount = 0;
    for (const record of this.records.values()) {
      if (record.inverse === undefined) continue;
      undoableCount += 1;
      retainedBytes += record.entry.inverseBytes;
    }
    return { recordCount: this.records.size, undoableCount, retainedBytes };
  }

  private release(recordId: string, cause: 'undone' | 'superseded'): void {
    const record = this.records.get(recordId);
    if (record === undefined) return;
    record.inverse = undefined;
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
