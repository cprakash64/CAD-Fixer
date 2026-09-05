import type { ExportDocumentSnapshot, ExportMetadata } from '@cadfixer/file-formats';

/**
 * THE EXPORT CHANNEL PROTOCOL.
 *
 * Three participants and two hops, the same shape the diagnostic channel uses
 * and for the same reason — the page stays out of the middle:
 *
 *   controller  --('port')-->  authoritative worker
 *   controller  --('port')-->  export worker
 *   authoritative worker  ==(document snapshot)==>  export worker
 *   export worker  --(finished bytes)-->  controller
 *
 * GEOMETRY ONLY EVER TRAVELS WORKER TO WORKER. What comes back to the page is
 * the finished artifact — which is the one thing the page legitimately needs,
 * because it is what the user asked to save. It is a serialised file, not the
 * authoritative document: it cannot be edited back into the model, and holding
 * it is exactly as risky as holding the file the user already had.
 */

/** Sent by the controller to either worker: here is your end of the channel. */
export interface ExportPortMessage {
  readonly kind: 'port';
  readonly port: MessagePort;
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

/** Export worker to controller. Progress scalars, then the artifact. */
export type ExportWorkerOutbound =
  | { readonly kind: 'ready' }
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
