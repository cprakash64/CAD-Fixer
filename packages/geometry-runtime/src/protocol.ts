import type { Diagnostic, OperationId, SerializedAppError } from '@cadfixer/shared';
import type { CanonicalMesh, MeshBounds } from '@cadfixer/mesh-core';

/**
 * Wire protocol between the main thread and geometry workers.
 *
 * Design rules:
 * - Every message carries an `OperationId` so several operations can be in
 *   flight on one worker without ambiguity.
 * - Every message is a plain structured-cloneable object. No class instances,
 *   no functions. Errors cross as `SerializedAppError`.
 * - The channel tag lets a worker ignore messages it does not own, and lets the
 *   protocol be versioned without guessing.
 */

export const PROTOCOL_CHANNEL = 'cadfixer.geometry.v1';

/**
 * Values eligible for a `postMessage` transfer list.
 *
 * Restricted to array buffers for now, which is all the geometry runtime moves.
 * `SharedArrayBuffer` is deliberately NOT transferable and must never be placed
 * in a transfer list — it is shared, not moved.
 */
export type TransferHandle = ArrayBufferLike;

/**
 * Operations the geometry runtime can perform, as a compile-time map from
 * operation name to its payload and result types.
 *
 * Stage 0 declares exactly one entry, and it is a diagnostic rather than a
 * geometry operation. Repair, convert, split, texture, and hollow will be added
 * here as they are implemented.
 */
export interface OperationMap {
  'runtime/self-test': {
    payload: SelfTestPayload;
    result: SelfTestResult;
  };
  'stl/import': {
    payload: StlImportPayload;
    result: StlImportResult;
  };
  'stl/export': {
    payload: StlExportPayload;
    result: StlExportResult;
  };
}

/* -------------------------------------------------------------- stl import -- */

export interface StlImportPayload {
  /**
   * The whole file. Transferred, so the main thread loses access the moment
   * dispatch returns — see docs/ARCHITECTURE.md on transfer ownership.
   */
  readonly bytes: ArrayBufferLike;
  /**
   * Optional limit overrides. Shaped as plain numbers rather than the
   * format layer's `ImportBudget` type so the protocol does not depend on
   * `@cadfixer/file-formats`.
   */
  readonly budget?: Readonly<Record<string, number>>;
}

/**
 * Everything the application needs about an imported model.
 *
 * Statistics are computed IN THE WORKER, during the pass that already has the
 * positions in cache. That is not an optimisation for its own sake: it means
 * the main thread never walks a multi-million-triangle buffer to fill in a
 * details panel.
 */
export interface StlImportResult {
  readonly mesh: CanonicalMesh;
  /** `binary` or `ascii`, as actually detected — never guessed from the name. */
  readonly encoding: string;
  readonly bounds: MeshBounds | undefined;
  readonly triangleCount: number;
  readonly vertexCount: number;
  /**
   * Per-vertex normals derived from the geometry, for display only.
   *
   * Kept out of the `CanonicalMesh` deliberately: they are not what the file
   * said, and canonical data must not be rewritten for presentation. Computed
   * here rather than on the main thread because deriving them is a per-triangle
   * cross product over the whole mesh.
   */
  readonly renderNormals: Float32Array;
  readonly warnings: readonly Diagnostic[];
  /** Structural validation summary. The import already passed the gate. */
  readonly validation: MeshValidationSummary;
}

export interface MeshValidationSummary {
  readonly valid: boolean;
  readonly issueCount: number;
  readonly warningCount: number;
  readonly truncated: boolean;
  /** Issue codes, deduplicated, for display. Never geometry. */
  readonly codes: readonly string[];
}

/* -------------------------------------------------------------- stl export -- */

export interface StlExportPayload {
  readonly mesh: CanonicalMesh;
  readonly encoding: string;
}

export interface StlExportResult {
  /** Encoded file bytes, transferred back to the caller. */
  readonly bytes: ArrayBufferLike;
  readonly byteLength: number;
  readonly encoding: string;
}

export type OperationName = keyof OperationMap;

export type OperationPayload<K extends OperationName> = OperationMap[K]['payload'];
export type OperationResult<K extends OperationName> = OperationMap[K]['result'];

/**
 * Proof-of-life payload. Exercises the full protocol surface — buffer transfer,
 * chunked progress, and cancellation polling — without doing geometry work.
 */
export interface SelfTestPayload {
  /** Buffer transferred to the worker. Ownership moves with it. */
  readonly bytes: ArrayBufferLike;
  /** Number of progress steps to report while scanning. Must be at least 1. */
  readonly chunks: number;
}

export interface SelfTestResult {
  /** The same buffer, transferred back. */
  readonly bytes: ArrayBufferLike;
  readonly byteLength: number;
  /** Sum of all bytes modulo 2^32. Deterministic, so tests can assert on it. */
  readonly checksum: number;
}

export interface RequestMessage {
  readonly channel: typeof PROTOCOL_CHANNEL;
  readonly kind: 'request';
  readonly id: OperationId;
  readonly operation: OperationName;
  readonly payload: unknown;
}

export interface CancelMessage {
  readonly channel: typeof PROTOCOL_CHANNEL;
  readonly kind: 'cancel';
  readonly id: OperationId;
}

export interface ProgressMessage {
  readonly channel: typeof PROTOCOL_CHANNEL;
  readonly kind: 'progress';
  readonly id: OperationId;
  /** Clamped to 0..1 by the sender. */
  readonly fraction: number;
  readonly note?: string;
}

export interface ResultMessage {
  readonly channel: typeof PROTOCOL_CHANNEL;
  readonly kind: 'result';
  readonly id: OperationId;
  readonly value: unknown;
}

export interface ErrorMessage {
  readonly channel: typeof PROTOCOL_CHANNEL;
  readonly kind: 'error';
  readonly id: OperationId;
  readonly error: SerializedAppError;
}

/** Main thread -> worker. */
export type HostBoundMessage = RequestMessage | CancelMessage;

/** Worker -> main thread. */
export type ClientBoundMessage = ProgressMessage | ResultMessage | ErrorMessage;

export type ProtocolMessage = HostBoundMessage | ClientBoundMessage;

function isProtocolEnvelope(value: unknown): value is { kind: string; id: OperationId } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { channel?: unknown; kind?: unknown; id?: unknown };
  return (
    candidate.channel === PROTOCOL_CHANNEL &&
    typeof candidate.kind === 'string' &&
    typeof candidate.id === 'string'
  );
}

export function isHostBoundMessage(value: unknown): value is HostBoundMessage {
  if (!isProtocolEnvelope(value)) return false;
  return value.kind === 'request' || value.kind === 'cancel';
}

export function isClientBoundMessage(value: unknown): value is ClientBoundMessage {
  if (!isProtocolEnvelope(value)) return false;
  return value.kind === 'progress' || value.kind === 'result' || value.kind === 'error';
}
