import type {
  HoleFillStatus,
  HoleFillValidationSummary,
  HoleFillLimits,
} from '@cadfixer/geometry-runtime';

/**
 * THE HOLE-FILL CHANNEL PROTOCOL.
 *
 * Three participants and one bidirectional hop, and the shape exists to keep
 * the page out of the middle:
 *
 *   controller            --('port')-->        authoritative worker
 *   controller            --('port')-->        fill worker
 *   authoritative worker  ==(copy)==>          fill worker
 *   fill worker           ==(candidate)==>     authoritative worker
 *
 * THE CHANNEL CARRIES GEOMETRY IN BOTH DIRECTIONS AND THE PAGE SEES NEITHER.
 * The source copy goes out, the validated candidate comes back, and the
 * authoritative worker takes ownership of it. What reaches the main thread is a
 * candidate HANDLE and a summary of scalars — the same rule ADR 0008 states for
 * every other operation, applied to a result rather than only to an input.
 *
 * THIS DIFFERS FROM `model/send-for-diagnostic` IN ONE WAY. That operation
 * resolves as soon as the copy is posted, because a diagnostic produces only
 * numbers and the page can receive them from the diagnostic worker directly.
 * This one stays pending until the candidate arrives, because a candidate is
 * geometry and geometry has to be handed to an owner.
 */

/** Sent by the controller to either worker: here is your end of the channel. */
export interface HoleFillPortMessage {
  readonly kind: 'port';
  readonly port: MessagePort;
}

/**
 * Sent by the AUTHORITATIVE worker over the channel, carrying a DISPOSABLE copy.
 *
 * POSITIONS ARE CANONICAL Float32, not widened doubles, and that is
 * deliberate: the fill engine judges its candidate on the representation that
 * would become authoritative, and its byte-level source-preservation check
 * compares against these exact bytes. Widening here would mean validating
 * something the model never is.
 *
 * The buffers are transferred, which is safe precisely because they are a COPY.
 * The authoritative worker's own arrays are never detached.
 */
export interface HoleFillGeometryMessage {
  readonly kind: 'fill';
  readonly operationId: string;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly partId: string;
  readonly boundaryLoopId: string;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly limits: Partial<HoleFillLimits> | undefined;
}

/**
 * Sent by the FILL worker back over the channel.
 *
 * `positions` and `indices` are present ONLY for a valid candidate. Every other
 * status carries scalars alone, because every other status means no candidate
 * exists — a refusal is non-destructive, and a refusal that shipped geometry
 * would be inviting someone to use it.
 */
export type HoleFillWorkerReply =
  | {
      readonly kind: 'result';
      readonly operationId: string;
      readonly status: HoleFillStatus;
      readonly summary: HoleFillValidationSummary;
      readonly intersectionSamples: Uint32Array;
      readonly samplesTruncated: boolean;
      readonly positions?: Float32Array;
      readonly indices?: Uint32Array;
    }
  | {
      readonly kind: 'failed';
      readonly operationId: string;
      readonly reason: string;
    };

/** Fill worker to CONTROLLER. Lifecycle only; never a result, never geometry. */
export type HoleFillWorkerOutbound =
  | { readonly kind: 'ready' }
  | { readonly kind: 'started'; readonly operationId: string; readonly faceCount: number };
