import {
  GeometryCoordinator,
  toTransferables,
  type DiagnosticSink,
  type MessageEndpoint,
  type OperationHandle,
  type ProgressUpdate,
  type SelfTestResult,
  type ModelAnalyzeResult,
  type DocumentHandle,
  type ModelImportResult,
  type ModelReleaseResult,
  type RepairCandidateHandle,
  type RepairCandidateResult,
  type RepairCommitResult,
  type RepairDiscardResult,
  type RepairOperation,
  type RepairPlanOperationResult,
  type RepairUndoResult,
  type SendForDiagnosticResult,
  type HoleFillCandidateHandle,
  type HoleFillDiscardResult,
  type HoleFillLimits,
  type ListBoundaryLoopsResult,
  type SendForFillResult,
  type SendForExportResult,
  type StlExportResult,
} from '@cadfixer/geometry-runtime';
import { modelUnavailable } from '@cadfixer/shared';

/**
 * The browser-side transport adapter and the application's single entry point
 * to the geometry worker.
 *
 * This module is the ONLY main-thread code that knows `Worker` exists. React
 * components talk to this client; they never touch the protocol, and no
 * geometry work is ever scheduled on the UI thread.
 */

function createWorkerEndpoint(worker: Worker): MessageEndpoint {
  return {
    postMessage(message: unknown, transfer: readonly ArrayBufferLike[]): void {
      worker.postMessage(message, toTransferables(transfer));
    },
    addMessageListener(listener: (message: unknown) => void): () => void {
      const handler = (event: MessageEvent): void => {
        listener(event.data);
      };
      worker.addEventListener('message', handler);
      return (): void => {
        worker.removeEventListener('message', handler);
      };
    },
    close(): void {
      worker.terminate();
    },
  };
}

export interface GeometryClientOptions {
  readonly onDiagnostic: DiagnosticSink;
  /**
   * Which worker script this client drives. Defaults to the geometry worker.
   *
   * WHAT THIS IS FOR, and what it deliberately is not. The end-to-end harness
   * needs to exercise the real application against a document that no production
   * codec can produce — STL describes one part, and OBJ and 3MF do not exist
   * yet. The alternatives were both worse: a synthetic-document operation in the
   * PRODUCTION protocol would be a permanent backdoor into authoritative
   * geometry, and reimplementing the workspace in a test page would prove
   * nothing about the code that ships.
   *
   * This chooses a SCRIPT, not a document. It cannot inject geometry, it is
   * reachable only from code already running in the page, there is no query
   * parameter, global or user-visible control that reaches it, and the
   * production entry point does not pass it — a boundary test asserts that.
   */
  readonly createWorker?: () => Worker;
  /**
   * Called when the worker dies, taking every resident model with it.
   *
   * The application must treat this as total loss of authoritative geometry:
   * the worker held the only copy, and nothing is reconstructed from the render
   * snapshot. See docs/adr/0008-worker-resident-geometry.md.
   */
  readonly onWorkerLost?: (reason: string) => void;
}

/**
 * Monotonic across every client this document creates, so a handle from a dead
 * worker can never be mistaken for one from its replacement.
 */
let nextSessionId = 1;

export class GeometryClient {
  private readonly worker: Worker;
  private readonly coordinator: GeometryCoordinator;
  private readonly onWorkerLost: ((reason: string) => void) | undefined;
  private readonly session: number;
  private lost = false;

  public constructor(options: GeometryClientOptions) {
    this.session = nextSessionId;
    nextSessionId += 1;
    this.onWorkerLost = options.onWorkerLost;

    this.worker =
      options.createWorker?.() ??
      new Worker(new URL('../workers/geometry.worker.ts', import.meta.url), {
        type: 'module',
        name: 'cadfixer-geometry',
      });

    this.coordinator = new GeometryCoordinator(createWorkerEndpoint(this.worker), {
      onDiagnostic: options.onDiagnostic,
    });

    this.attachFailureHandlers();
  }

  /**
   * A worker that fails to load, or a message that cannot be cloned, produces no
   * protocol reply. Without these handlers every pending operation would hang
   * and the interface would wait forever on a result that is not coming.
   *
   * Worker death is also LOSS OF ALL GEOMETRY: the worker held the only copy of
   * every resident model. Nothing is reconstructed from the render snapshot —
   * pixels are not geometry — so the application is told, and it clears the
   * model rather than leaving something on screen that no operation can act on.
   */
  private attachFailureHandlers(): void {
    this.worker.addEventListener('error', (event: ErrorEvent) => {
      this.handleWorkerLoss(
        event.message.length > 0
          ? `The geometry worker crashed: ${event.message}`
          : 'The geometry worker crashed.',
      );
    });

    this.worker.addEventListener('messageerror', () => {
      this.handleWorkerLoss('A message from the geometry worker could not be deserialised.');
    });
  }

  private handleWorkerLoss(reason: string): void {
    if (this.lost) return;
    this.lost = true;

    this.coordinator.failAllPending(modelUnavailable(reason));
    this.onWorkerLost?.(reason);
  }

  /**
   * Whether the worker that produced `sessionId` is still the live one.
   *
   * Handles are namespaced per worker session because a replacement worker
   * starts its model ids from scratch: without this, a stale handle naming
   * `model-1` from a dead session would match the FIRST model imported into the
   * replacement. That is precisely the aliasing the revision guard exists to
   * prevent, one level up.
   */
  public get sessionId(): number {
    return this.session;
  }

  public get isLost(): boolean {
    return this.lost;
  }

  /**
   * Runs the runtime self-test.
   *
   * `bytes` is transferred to the worker and returned by transfer, so the
   * buffer passed in is detached as soon as this returns. Callers must use the
   * buffer from the result rather than the one they supplied.
   */
  public runSelfTest(
    bytes: ArrayBuffer,
    chunks: number,
    onProgress: (update: ProgressUpdate) => void,
  ): OperationHandle<SelfTestResult> {
    return this.coordinator.dispatch(
      'runtime/self-test',
      { bytes, chunks },
      { onProgress, transfer: [bytes] },
    );
  }

  /**
   * Parses a model file in the worker and commits it as the resident document.
   *
   * `bytes` is TRANSFERRED: the caller's buffer is detached as soon as this
   * returns and must not be read again. What comes back is a handle plus render
   * snapshots — the authoritative geometry stays in the worker.
   *
   * `fileName` is passed for FORMAT IDENTIFICATION and nothing else. The worker
   * decides what a file is from its bytes; the name only breaks the one
   * ambiguity bytes cannot settle and lets a name/content mismatch be reported.
   */
  public importModel(
    bytes: ArrayBuffer,
    fileName: string,
    onProgress: (update: ProgressUpdate) => void,
    budget?: Readonly<Record<string, number>>,
  ): OperationHandle<ModelImportResult> {
    return this.coordinator.dispatch(
      'model/import',
      budget === undefined ? { bytes, fileName } : { bytes, fileName, budget },
      { onProgress, transfer: [bytes] },
    );
  }

  /**
   * Encodes a resident model as STL.
   *
   * Nothing larger than a handle crosses the boundary. Stage 1 sent the whole
   * canonical mesh back into the worker on every export — about 96 MiB for a
   * two-million-triangle model — because the main thread owned it.
   */
  public exportModel(
    handle: DocumentHandle,
    partId: string,
    encoding: string,
    onProgress: (update: ProgressUpdate) => void,
  ): OperationHandle<StlExportResult> {
    return this.coordinator.dispatch('model/export', { handle, partId, encoding }, { onProgress });
  }

  /**
   * Runs read-only topology analysis on a resident model.
   *
   * Sends a handle and a sample cap; the authoritative geometry never moves.
   * What returns is counts, statuses, and bounded diagnostic samples — the
   * samples ARE geometry-derived, deliberately, because the viewport has to draw
   * the defects somewhere.
   */
  public analyzeModel(
    handle: DocumentHandle,
    partId: string,
    onProgress: (update: ProgressUpdate) => void,
    sampleLimit?: number,
  ): OperationHandle<ModelAnalyzeResult> {
    return this.coordinator.dispatch(
      'model/analyze',
      sampleLimit === undefined ? { handle, partId } : { handle, partId, sampleLimit },
      { onProgress },
    );
  }

  /**
   * Asks the authoritative worker to push a DISPOSABLE geometry copy to a
   * diagnostic worker through `port`.
   *
   * The port is transferred; the geometry is not returned. That asymmetry is
   * the architecture: coordinates travel worker-to-worker, and the page learns
   * only how many faces were sent (ADR 0008). A `Promise` rather than an
   * `OperationHandle` because there is nothing here worth cancelling — the
   * expensive part happens in the diagnostic worker, which is cancelled by
   * being terminated.
   */
  public async sendForDiagnostic(request: {
    handle: DocumentHandle;
    partId: string;
    operationId: string;
    port: MessagePort;
    limits: { maxCandidatePairs: number; maxTestedPairs: number; maxSamples: number };
  }): Promise<SendForDiagnosticResult> {
    return this.coordinator.dispatch(
      'model/send-for-diagnostic',
      {
        handle: request.handle,
        partId: request.partId,
        operationId: request.operationId,
        port: request.port,
        limits: request.limits,
      },
      { transfer: [request.port] },
    ).promise;
  }

  /**
   * Hands the export worker a disposable snapshot of the whole document.
   *
   * The page never sees it: one port goes to the authoritative worker and the
   * other to the export worker, and the snapshot travels directly between them.
   * What comes back here is a part count and a triangle count.
   */
  public async sendForExport(request: {
    handle: DocumentHandle;
    target: string;
    operationId: string;
    port: MessagePort;
    /** Applied only when the DOCUMENT states no unit. The worker decides that. */
    unitAssertion?: string;
  }): Promise<SendForExportResult> {
    return this.coordinator.dispatch(
      'document/send-for-export',
      {
        handle: request.handle,
        target: request.target,
        operationId: request.operationId,
        port: request.port,
        ...(request.unitAssertion === undefined ? {} : { unitAssertion: request.unitAssertion }),
      },
      { transfer: [request.port] },
    ).promise;
  }

  /**
   * Lists a part's boundary components as ORDERED, TARGETABLE loops.
   *
   * READ-ONLY, and the only way the application can obtain a `boundaryLoopId`.
   * A fill names a loop by an identity the authoritative worker derived from
   * the geometry it holds — never by an index the interface chose, which would
   * silently become a different loop the moment the mesh changed.
   */
  public listBoundaryLoops(
    handle: DocumentHandle,
    partId: string,
    limit?: number,
  ): OperationHandle<ListBoundaryLoopsResult> {
    return this.coordinator.dispatch(
      'holefill/list-loops',
      limit === undefined ? { handle, partId } : { handle, partId, limit },
      {},
    );
  }

  /**
   * Asks the authoritative worker to fill one boundary loop through `port`.
   *
   * The port is transferred; the geometry is not returned. Coordinates travel
   * worker-to-worker in BOTH directions — a disposable copy out, a validated
   * candidate back — and the page receives a candidate HANDLE and a summary of
   * scalars (ADR 0008).
   *
   * An `OperationHandle` rather than a bare `Promise`, unlike
   * `sendForDiagnostic`: this operation stays pending while the fill worker
   * runs, so the controller must be able to cancel it when it terminates that
   * worker.
   */
  public sendForFill(request: {
    handle: DocumentHandle;
    partId: string;
    boundaryLoopId: string;
    operationId: string;
    port: MessagePort;
    limits?: Partial<HoleFillLimits>;
  }): OperationHandle<SendForFillResult> {
    return this.coordinator.dispatch(
      'holefill/send-for-fill',
      {
        handle: request.handle,
        partId: request.partId,
        boundaryLoopId: request.boundaryLoopId,
        operationId: request.operationId,
        port: request.port,
        ...(request.limits === undefined ? {} : { limits: request.limits }),
      },
      { transfer: [request.port] },
    );
  }

  /** Releases a hole-fill candidate's worker-resident geometry. */
  public discardHoleFillCandidate(
    candidate: HoleFillCandidateHandle,
  ): OperationHandle<HoleFillDiscardResult> {
    return this.coordinator.dispatch('holefill/discard', { candidate }, {});
  }

  /**
   * Asks what a conservative repair WOULD do, without allocating anything.
   *
   * Planning is separate from creating a candidate on purpose: the user must be
   * able to see which operations apply, which are refused and why, and what the
   * repair would cost, before any memory is committed.
   *
   * `memoryBudgetBytes` may only NARROW the worker's own ceiling. The worker
   * enforces that; a message cannot buy itself more memory.
   */
  public planRepair(
    handle: DocumentHandle,
    partId: string,
    requested: readonly RepairOperation[],
    onProgress: (update: ProgressUpdate) => void,
    memoryBudgetBytes?: number,
  ): OperationHandle<RepairPlanOperationResult> {
    return this.coordinator.dispatch(
      'repair/plan',
      memoryBudgetBytes === undefined
        ? { handle, partId, requested }
        : { handle, partId, requested, memoryBudgetBytes },
      // Planning builds connectivity and can be seconds on a large model, so it
      // gets a signal that can interrupt it rather than one that waits for the
      // event loop.
      { onProgress, interruptible: true },
    );
  }

  /**
   * Builds and validates a repair CANDIDATE. The model is not touched.
   *
   * What returns is a candidate handle, the validation verdict, exact change
   * counts, bounded change samples, and a render snapshot for the preview. The
   * candidate's canonical geometry stays worker-resident exactly as the
   * authoritative model's does.
   */
  public createRepairCandidate(
    handle: DocumentHandle,
    partId: string,
    requested: readonly RepairOperation[],
    planHash: string,
    onProgress: (update: ProgressUpdate) => void,
    options: { readonly memoryBudgetBytes?: number; readonly sampleLimit?: number } = {},
  ): OperationHandle<RepairCandidateResult> {
    return this.coordinator.dispatch(
      'repair/create-candidate',
      {
        handle,
        partId,
        requested,
        planHash,
        ...(options.memoryBudgetBytes === undefined
          ? {}
          : { memoryBudgetBytes: options.memoryBudgetBytes }),
        ...(options.sampleLimit === undefined ? {} : { sampleLimit: options.sampleLimit }),
      },
      // THE OPERATION THIS STAGE EXISTS FOR. The repair pipeline is one long
      // synchronous pass; without a shared signal its Cancel could only discard
      // a finished result, never stop the work.
      { onProgress, interruptible: true },
    );
  }

  /**
   * Applies a validated candidate, producing a new revision.
   *
   * THE TRANSACTION LIVES IN THE WORKER. This method sends four identifiers and
   * nothing else; every guard — revision currency, candidate state, validation
   * acceptance, plan identity, single use — is re-checked there. The UI cannot
   * talk its way past any of them, which is the point.
   */
  public commitRepair(
    candidate: RepairCandidateHandle,
    expectedSource: DocumentHandle,
    expectedPart: string,
    planHash: string,
    onProgress: (update: ProgressUpdate) => void,
  ): OperationHandle<RepairCommitResult> {
    return this.coordinator.dispatch(
      'repair/commit',
      { candidate, expectedSource, expectedPart, planHash },
      { onProgress },
    );
  }

  /** Releases a candidate's worker-resident geometry. */
  public discardRepairCandidate(
    candidate: RepairCandidateHandle,
  ): OperationHandle<RepairDiscardResult> {
    return this.coordinator.dispatch('repair/discard', { candidate });
  }

  /**
   * Reverses a committed repair, producing another new revision.
   *
   * Not a view change and not a React-held copy: the worker rebuilds the
   * previous geometry from the inverse patch it retained, validates it, and
   * swaps it in as a new monotonic revision. See ADR 0011.
   */
  public undoRepair(
    handle: DocumentHandle,
    recordId: string,
    onProgress: (update: ProgressUpdate) => void,
  ): OperationHandle<RepairUndoResult> {
    return this.coordinator.dispatch('repair/undo', { handle, recordId }, { onProgress });
  }

  /** Frees a model the application no longer displays. */
  public releaseModel(documentId: string): OperationHandle<ModelReleaseResult> {
    return this.coordinator.dispatch('model/release', { documentId });
  }

  public dispose(): void {
    this.coordinator.dispose();
  }
}
