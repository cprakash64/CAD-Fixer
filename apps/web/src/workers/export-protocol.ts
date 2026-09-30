import {
  MeshFormatId,
  type ExportDocumentSnapshot,
  type ExportMetadata,
} from '@cadfixer/file-formats';

/** Geometry travels only from the authoritative worker to a disposable export
 * worker. Small artifacts return one transferred buffer. Large OBJ returns one
 * bounded transferable chunk and waits for a disk-write ACK before sending the
 * next; file-ready authorizes commit only after mandatory EOF validation. */

/** Sent by the controller to either worker: here is your end of the channel. */
export interface ExportPortMessage {
  readonly kind: 'port';
  readonly port: MessagePort;
  readonly fileBacked?: boolean;
}

/**
 * Sent by the AUTHORITATIVE worker over the channel, carrying a DISPOSABLE copy.
 *
 * The snapshot copies each DISTINCT mesh once, so a thousand placements of one
 * mesh travel as one geometry payload and a thousand twelve-number placements.
 * The buffers are transferred, which is safe precisely because they are a copy:
 * the authoritative worker's own arrays are never detached, and a terminated
 * export worker cannot take the user's model with it.
 */
export interface ExportSnapshotMessage {
  readonly kind: 'snapshot';
  readonly operationId: string;
  readonly target: string;
  readonly snapshot: ExportDocumentSnapshot;
}

/** Export worker to controller: progress, bounded delivery, then validated completion. */
export type ExportWorkerOutbound =
  | { readonly kind: 'ready' }
  | { readonly kind: 'chunk'; readonly operationId: string; readonly bytes: ArrayBuffer }
  | {
      readonly kind: 'file-ready';
      readonly operationId: string;
      readonly documentId: string;
      readonly documentRevision: number;
      readonly metadata: ExportMetadata;
    }
  | {
      readonly kind: 'progress';
      readonly operationId: string;
      readonly fraction: number;
      readonly note?: string;
    }
  | {
      readonly kind: 'written';
      readonly operationId: string;
      readonly documentId: string;
      readonly documentRevision: number;
      readonly bytes: ArrayBufferLike;
      readonly metadata: ExportMetadata;
    }
  | {
      readonly kind: 'failed';
      readonly operationId: string;
      /** The typed reason, never a rendered sentence. */
      readonly code: string;
      readonly reason: string | undefined;
      readonly message: string;
    };

/**
 * THE TARGETS THIS BUILD WILL WRITE, and the only place a target STRING becomes
 * a format.
 *
 * The boundary matters more than the table. `target` arrives as text on a
 * message, and `exportDocument` takes a `MeshFormatId` — so this lookup is
 * where an unrecognised target has to be refused. A missing entry returns
 * `undefined` rather than a plausible default, because defaulting an unknown
 * target would write one format while the caller asked for another.
 *
 * `stl` HERE MEANS THE WHOLE DOCUMENT, flattened into one triangle stream. It
 * is NOT `model/export`, which writes the active part and reports what it left
 * out. Two questions, two operations.
 */
export const EXPORT_TARGETS: Readonly<Record<string, MeshFormatId>> = Object.freeze({
  stl: MeshFormatId.Stl,
  obj: MeshFormatId.Obj,
  '3mf': MeshFormatId.ThreeMf,
});

/** Resolves an untrusted target string, or `undefined` when it is not one. */
export function resolveExportTarget(target: string): MeshFormatId | undefined {
  return Object.prototype.hasOwnProperty.call(EXPORT_TARGETS, target)
    ? EXPORT_TARGETS[target]
    : undefined;
}

export interface ExportChunkAck {
  readonly kind: 'chunk-ack';
  readonly operationId: string;
}
