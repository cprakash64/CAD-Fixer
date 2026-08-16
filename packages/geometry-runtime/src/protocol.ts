import type { Diagnostic, OperationId, SerializedAppError } from '@cadfixer/shared';
import type { MeshBounds } from '@cadfixer/mesh-core';
// Type-only, so no topology code is pulled into the main-thread bundle. The
// analysis contract is described here rather than left as `unknown`: this is a
// module boundary, and an unchecked one would let the worker and its consumer
// drift apart silently.
import type { TopologyDetail, TopologyReport } from '@cadfixer/mesh-topology';
import type { ModelHandle } from './resident-models';

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
  'model/import': {
    payload: StlImportPayload;
    result: ModelImportResult;
  };
  'model/export': {
    payload: ModelExportPayload;
    result: StlExportResult;
  };
  'model/release': {
    payload: ModelReleasePayload;
    result: ModelReleaseResult;
  };
  'model/analyze': {
    payload: ModelAnalyzePayload;
    result: ModelAnalyzeResult;
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
 * Geometry the UI needs in order to DRAW a model — and nothing more.
 *
 * THE DISTINCTION THAT MATTERS: the authoritative `CanonicalMesh` stays in the
 * worker. This is a derived, read-only view of it, safe to transfer to the main
 * thread and hand to the GPU. The two must not be confused: the snapshot is
 * regenerable at any time, whereas the canonical mesh is the user's data.
 *
 * Positions are NON-INDEXED. STL is triangle soup, so its indices are the
 * sequence 0,1,2,3,… and carry no information; sending them would cost 24 MiB
 * per two million triangles to tell the GPU what it already assumes. The worker
 * keeps the real index buffer because later operations need it.
 */
export interface RenderSnapshot {
  /** Interleaved XYZ, three vertices per triangle, drawn non-indexed. */
  readonly positions: Float32Array;
  /**
   * Per-vertex normals derived from the geometry, for display only.
   *
   * They are not what the file said, and canonical data is never rewritten for
   * presentation. Computed in the worker because deriving them is a
   * per-triangle cross product over the whole mesh.
   */
  readonly normals: Float32Array;
  readonly vertexCount: number;
}

/**
 * Everything the application needs about an imported model.
 *
 * Statistics are computed IN THE WORKER, during the pass that already has the
 * positions in cache, so the main thread never walks a multi-million-triangle
 * buffer to fill in a details panel.
 */
export interface ModelImportResult {
  /** Identifies the geometry that now lives in the worker. */
  readonly handle: ModelHandle;
  /** `binary` or `ascii`, as actually detected — never guessed from the name. */
  readonly encoding: string;
  /**
   * The unit the source stated, or `undefined` when it stated none.
   *
   * Carried explicitly because the main thread no longer holds the mesh and so
   * cannot read its metadata. `undefined` is meaningful — STL has no unit field
   * — and must not be flattened into a default on the way across.
   */
  readonly unit: string | undefined;
  readonly bounds: MeshBounds | undefined;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly render: RenderSnapshot;
  readonly warnings: readonly Diagnostic[];
  /** Structural validation summary. The import already passed the gate. */
  readonly validation: MeshValidationSummary;
  /** Bytes of authoritative geometry the worker now holds for this model. */
  readonly residentBytes: number;
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

/**
 * Export names a resident model rather than carrying geometry.
 *
 * This is the whole point of the resident runtime: Stage 1 structured-cloned
 * the entire canonical mesh from the main thread into the worker on every
 * export — about 96 MiB for a two-million-triangle model. Now nothing larger
 * than a handle crosses the boundary.
 */
export interface ModelExportPayload {
  readonly handle: ModelHandle;
  readonly encoding: string;
}

/**
 * Topology analysis names a resident model rather than sending one.
 *
 * WHAT ACTUALLY CROSSES, precisely:
 *
 *   main → worker   a handle, a revision, and configuration. Nothing else. The
 *                   main thread never sends canonical geometry into the worker
 *                   for analysis, because it does not hold any.
 *   worker → main   counts, statuses, and BOUNDED DIAGNOSTIC SAMPLES. The
 *                   samples are geometry-derived on purpose — sampled vertex
 *                   positions and edge endpoints exist so the viewport can draw
 *                   the defects — and they are capped by `sampleLimit`, not by
 *                   mesh size.
 *
 * Authoritative canonical geometry stays worker-resident throughout and is never
 * returned by this operation. Render snapshots are a separate, separately
 * defined transfer and are likewise not the authoritative geometry.
 *
 * "No geometry crosses the boundary" would be a convenient thing to say here
 * and it would be false: bounded samples are geometry, deliberately.
 *
 * The handle carries the revision the caller believes it is analysing, so an
 * analysis queued against a model that has since been replaced fails rather
 * than silently producing a report for different geometry.
 */
export interface ModelAnalyzePayload {
  readonly handle: ModelHandle;
  /** Caps retained detail samples per category. */
  readonly sampleLimit?: number;
}

/**
 * The report, plus the identity it was computed for.
 *
 * `handle` is echoed so a consumer can discard a late report belonging to a
 * model it has already replaced — the application cannot rely on arrival order.
 */
export interface ModelAnalyzeResult {
  readonly handle: ModelHandle;
  readonly report: TopologyReport;
  readonly detail: TopologyDetail;
}

export interface ModelReleasePayload {
  readonly modelId: string;
}

export interface ModelReleaseResult {
  readonly released: boolean;
}

export interface StlExportResult {
  /** Encoded file bytes, transferred back to the caller. */
  readonly bytes: ArrayBufferLike;
  readonly byteLength: number;
  readonly encoding: string;
  /** Non-fatal findings, e.g. grouping that the chosen encoding cannot carry. */
  readonly warnings: readonly Diagnostic[];
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
