import type {
  SelfIntersectionLimits,
  SelfIntersectionReport,
} from '@cadfixer/mesh-self-intersection';

/**
 * THE DIAGNOSTIC CHANNEL PROTOCOL.
 *
 * Three participants and two hops, and the shape exists to keep the page out of
 * the middle:
 *
 *   controller  --('port')-->  authoritative worker
 *   controller  --('port')-->  diagnostic worker
 *   authoritative worker  ==(geometry copy)==>  diagnostic worker
 *
 * The controller creates a `MessageChannel` and hands one port to each worker.
 * Geometry then travels producer-to-consumer directly. The main thread learns
 * only scalars: a face count, counters, a bounded list of face ids.
 */

/** Sent by the controller to either worker: here is your end of the channel. */
export interface DiagnosticPortMessage {
  readonly kind: 'port';
  readonly port: MessagePort;
}

/**
 * Sent by the AUTHORITATIVE worker over the channel, carrying a DISPOSABLE copy.
 *
 * Positions are Float64: canonical storage is Float32 and every stored value is
 * widened exactly, inventing no precision. The buffers are transferred, which is
 * safe precisely because they are a copy — the authoritative worker's own arrays
 * are never detached.
 */
export interface DiagnosticGeometryMessage {
  readonly kind: 'geometry';
  readonly operationId: string;
  readonly modelId: string;
  readonly modelRevision: number;
  readonly positions: Float64Array;
  readonly triangles: Uint32Array;
  readonly limits: SelfIntersectionLimits;
}

/** Diagnostic worker to controller. Scalars and bounded face ids only. */
export type DiagnosticWorkerOutbound =
  | { readonly kind: 'ready' }
  | { readonly kind: 'started'; readonly operationId: string; readonly faceCount: number }
  | {
      readonly kind: 'report';
      readonly operationId: string;
      readonly report: SelfIntersectionReport;
    }
  | { readonly kind: 'failed'; readonly operationId: string; readonly reason: string };
