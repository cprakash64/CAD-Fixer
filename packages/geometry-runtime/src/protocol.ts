import type { Diagnostic, OperationId, SerializedAppError } from '@cadfixer/shared';
import type { MeshBounds } from '@cadfixer/mesh-core';
// Type-only, so no topology code is pulled into the main-thread bundle. The
// analysis contract is described here rather than left as `unknown`: this is a
// module boundary, and an unchecked one would let the worker and its consumer
// drift apart silently.
import type { TopologyDetail, TopologyReport } from '@cadfixer/mesh-topology';
import type {
  ConservativeRepairPlan,
  RepairChangeCounts,
  RepairChangeSamples,
  RepairOperation,
  RepairValidation,
} from '@cadfixer/mesh-repair';
import type { ModelHandle } from './resident-models';
import type { RepairCandidateHandle } from './repair-candidates';

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
  'repair/plan': {
    payload: RepairPlanPayload;
    result: RepairPlanOperationResult;
  };
  'repair/create-candidate': {
    payload: RepairCandidatePayload;
    result: RepairCandidateResult;
  };
  'repair/commit': {
    payload: RepairCommitPayload;
    result: RepairCommitResult;
  };
  'repair/discard': {
    payload: RepairDiscardPayload;
    result: RepairDiscardResult;
  };
  'repair/undo': {
    payload: RepairUndoPayload;
    result: RepairUndoResult;
  };
}

/* ------------------------------------------------------------------ repair -- */

/**
 * CONSERVATIVE REPAIR OVER THE WIRE.
 *
 * Deliberately four operations rather than one. Planning must be observable
 * without allocating a candidate, and applying must be a separate, explicitly
 * confirmed act — a single `repair/apply` would make preview impossible and
 * would make an accidental double-send destructive.
 *
 * `model/analyze` is NOT overloaded with any of this. Analysis is read-only and
 * must stay that way; a repair verb hidden inside it would make every analysis
 * a potential mutation.
 *
 * NO GEOMETRY CROSSES for any of these. The main thread sends handles,
 * revisions and operation names; it receives plans, reports, counts and bounded
 * samples. Candidate geometry stays worker-resident exactly as authoritative
 * geometry does.
 */
export interface RepairPlanPayload {
  readonly handle: ModelHandle;
  /** What the caller wants attempted. The plan never widens this. */
  readonly requested: readonly RepairOperation[];
  /** Refuse before allocating if the estimated peak exceeds this. */
  readonly memoryBudgetBytes?: number;
}

export interface RepairPlanOperationResult {
  readonly handle: ModelHandle;
  readonly plan: ConservativeRepairPlan;
}

export interface RepairCandidatePayload {
  readonly handle: ModelHandle;
  readonly requested: readonly RepairOperation[];
  /**
   * The plan the caller previewed.
   *
   * Checked against a freshly computed plan: if the model or the request has
   * changed, the candidate is refused rather than silently built from a
   * different plan than the one that was shown.
   */
  readonly planHash: string;
  readonly memoryBudgetBytes?: number;
  readonly sampleLimit?: number;
}

/**
 * Everything Stage 3B-1B needs to build a preview, and nothing more.
 *
 * The candidate render snapshot is deliberately NOT included by default: it
 * doubles the transfer for a preview the caller may not display. It is
 * requested separately when the UI actually needs to draw the result.
 */
export interface RepairCandidateResult {
  readonly candidate: RepairCandidateHandle | undefined;
  readonly source: ModelHandle;
  readonly plan: ConservativeRepairPlan;
  readonly validation: RepairValidation;
  readonly counts: RepairChangeCounts;
  readonly samples: RepairChangeSamples;
  /** Bytes the inverse patch occupies, for history budgeting. */
  readonly inverseBytes: number;
  readonly candidateBounds: MeshBounds | undefined;
  readonly render: RenderSnapshot | undefined;
}

export interface RepairCommitPayload {
  readonly candidate: RepairCandidateHandle;
  /** The revision the caller believes is authoritative. Re-checked. */
  readonly expectedSource: ModelHandle;
  /** Identity of the validation the caller accepted. */
  readonly planHash: string;
}

export interface RepairCommitResult {
  /** The NEW revision. Same lineage, parent recorded below. */
  readonly handle: ModelHandle;
  readonly parentRevision: number;
  readonly repairRecordId: string;
  readonly appliedOperations: readonly RepairOperation[];
  readonly render: RenderSnapshot;
  readonly residentBytes: number;
  /**
   * Facts about the committed geometry, so the application can update the model
   * it displays without re-deriving anything from the render snapshot.
   *
   * They are computed in the worker, which already holds the mesh. Counting
   * triangles from a Float32Array on the UI thread would be exactly the
   * whole-mesh main-thread work this project forbids.
   */
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly bounds: MeshBounds | undefined;
  /** True when this revision can be reversed by `repair/undo`. */
  readonly undoable: boolean;
}

export interface RepairDiscardPayload {
  readonly candidate: RepairCandidateHandle;
}

export interface RepairDiscardResult {
  /** False when there was nothing left to release. Not an error. */
  readonly released: boolean;
}

/**
 * UNDO IS A TRANSACTION, not a view change.
 *
 * It names the repair it reverses AND the revision it believes is authoritative,
 * exactly as commit does. Reversing "the last thing" without saying which would
 * make undo unsafe the moment two operations can be in flight.
 *
 * The restored geometry becomes a NEW monotonic revision rather than reviving
 * the old one — see docs/adr/0011. A revision number that could go backwards
 * would make every stale-handle check in the runtime ambiguous.
 */
export interface RepairUndoPayload {
  /** The revision the caller believes is authoritative: the repaired one. */
  readonly handle: ModelHandle;
  /** Identity of the commit being reversed. */
  readonly recordId: string;
}

export interface RepairUndoResult {
  /** The NEW revision, holding the restored pre-repair geometry. */
  readonly handle: ModelHandle;
  /** The revision that was authoritative before the undo. */
  readonly revertedRevision: number;
  /** The revision whose geometry has been reproduced. */
  readonly restoredRevision: number;
  readonly recordId: string;
  readonly appliedOperations: readonly RepairOperation[];
  readonly render: RenderSnapshot;
  readonly residentBytes: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly bounds: MeshBounds | undefined;
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
  /**
   * A four-byte shared control word carrying this operation's cancel flag.
   *
   * ON THE ENVELOPE, NOT IN A PAYLOAD, because cancellation is a property of an
   * OPERATION rather than of any particular operation's arguments. Putting it
   * here means the worker host can build an interruptible
   * `OperationContext.cancellation` for every handler uniformly, and no handler
   * has to remember to adopt it.
   *
   * WHY IT EXISTS AT ALL: the `cancel` message below cannot interrupt a
   * synchronous handler, because a worker does not read its message queue while
   * one is running. A polled flag that cannot change is not cancellation. This
   * word is written with `Atomics.store` on the main thread and read with
   * `Atomics.load` inside the worker's own loops, so it crosses threads without
   * the event loop's involvement.
   *
   * SHARED, NOT TRANSFERRED. A `SharedArrayBuffer` must never appear in a
   * transfer list — it is shared by structured clone, and transferring it would
   * detach the sender's view of the very flag it needs to set.
   *
   * Optional so the protocol still describes environments without cross-origin
   * isolation, and so existing operations that never adopted it keep working.
   */
  readonly cancellation?: SharedArrayBuffer;
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
