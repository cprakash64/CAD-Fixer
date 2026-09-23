import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import { GeometryClientProvider } from '../src/runtime/client-context';
import { GeometryClient } from '../src/runtime/geometry-client';
import { WorkspaceProvider } from '../src/state/store-context';
import { StatusSeverity, WorkspaceStore } from '../src/state/workspace-store';
import {
  DocumentExportService,
  type DocumentExportOutcome,
  type ExportTarget,
} from '../src/runtime/document-export-service';
import { deriveDocumentExportName, downloadBytes } from '../src/runtime/download';
import { HoleFillService } from '../src/runtime/hole-fill-service';
import { HarnessBar } from './harness-bar';
import type { GeometryEditCandidateHandle } from '@cadfixer/geometry-runtime';
import { SharedCancellationSource } from '@cadfixer/shared';
import '../src/styles/app.css';

/**
 * THE END-TO-END HARNESS ENTRY POINT. Never shipped.
 *
 * It is `src/main.tsx` with two differences, and no others:
 *
 *   1. the geometry client drives `harness.worker.ts` instead of
 *      `geometry.worker.ts`, so `model/import` can build a synthetic multi-part
 *      document that no production codec can produce;
 *   2. a `HarnessBar` sits beside the real `App` to trigger those imports and
 *      report scalar state.
 *
 * Everything the tests then observe — the viewport, the part selector, Mesh
 * Health, the repair panel, the store, the runtime — is the production
 * application, unmodified.
 *
 * This file is reachable only from `e2e-harness/index.html`, which is built by
 * `vite.harness.config.ts` and is not an input to the application build. A
 * boundary test asserts that nothing under `apps/web/src` imports it.
 */

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root container #root is missing from the harness document.');
}

const store = new WorkspaceStore();

/*
 * Created here rather than inside `GeometryClient` so the harness keeps a
 * reference for the worker-side byte digest below, which travels on its own
 * message kind rather than through the protocol.
 */
const harnessWorker = new Worker(new URL('./worker/harness.worker.ts', import.meta.url), {
  type: 'module',
  name: 'cadfixer-geometry-harness',
});
interface HarnessSplitQualificationEvent {
  readonly documentId: string;
  readonly generation: number;
  readonly booleanIndex: number;
  readonly operation: string;
  readonly phase: string;
  readonly at: number;
  readonly stats: {
    readonly active: number;
    readonly created: number;
    readonly terminated: number;
  };
}
let splitQualificationEvents: HarnessSplitQualificationEvent[] = [];
harnessWorker.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { kind?: string } & Partial<HarnessSplitQualificationEvent>;
  if (
    data.kind !== 'harness/split-qualification' ||
    data.documentId === undefined ||
    data.generation === undefined ||
    data.booleanIndex === undefined ||
    data.operation === undefined ||
    data.phase === undefined ||
    data.at === undefined ||
    data.stats === undefined
  )
    return;
  splitQualificationEvents.push(data as HarnessSplitQualificationEvent);
});

const geometryClient = new GeometryClient({
  createWorker: (): Worker => harnessWorker,
  onDiagnostic: (message, details): void => {
    store.pushStatus(StatusSeverity.Warning, `${message} (${JSON.stringify(details)})`);
  },
  onWorkerLost: (reason): void => {
    store.loseGeometrySession(reason);
    store.pushStatus(StatusSeverity.Error, reason);
  },
});

interface HarnessPartDigest {
  readonly partId: string;
  readonly name?: string | null;
  readonly materialRef?: string | null;
  readonly meshResourceIndex: number;
  readonly transform: readonly number[];
  readonly positionBytes: number;
  readonly indexBytes: number;
  readonly positionDigest: string;
  readonly indexDigest: string;
}

interface HarnessDigest {
  readonly ok: boolean;
  readonly distinctMeshes?: number;
  readonly unit?: string | null;
  readonly parts: readonly HarnessPartDigest[];
}

/**
 * Asks the worker to digest its own authoritative buffers.
 *
 * The canonical arrays never leave the worker: a digest and a byte length come
 * back, which is enough to prove "unchanged" and not enough to make the page an
 * owner of geometry.
 */
function requestDigest(documentId: string, revision: number): Promise<HarnessDigest> {
  return new Promise<HarnessDigest>((resolve) => {
    const listener = (event: MessageEvent): void => {
      const data: unknown = event.data;
      if (
        typeof data !== 'object' ||
        data === null ||
        (data as { kind?: unknown }).kind !== 'harness/digest-result'
      ) {
        return;
      }
      harnessWorker.removeEventListener('message', listener);
      resolve(data as HarnessDigest);
    };
    harnessWorker.addEventListener('message', listener);
    harnessWorker.postMessage({ kind: 'harness/digest', documentId, revision });
  });
}

/*
 * THE EXPORT SERVICE, DRIVEN FROM THE HARNESS AS WELL AS FROM THE PRODUCT.
 *
 * Stage 4A-2B2 built the export ENGINE and this bridge was its only caller;
 * Stage 4A-2B3 built the workflow, so the application now drives the same
 * service through `use-document-conversion.ts`. The bridge stays because it can
 * do something the product deliberately cannot: put a SYNTHETIC multi-part
 * document in front of the exporter — a thousand placements of one mesh, a
 * reflection, a shared resource — none of which any production import can
 * produce for a browser test to export.
 *
 * It is still not in the application build, and there is still no production
 * URL, query parameter or hidden button that reaches it.
 */
const exportService = new DocumentExportService(geometryClient);

/**
 * One progress report, with the moment it arrived.
 *
 * The TIMELINE is what makes a responsiveness measurement checkable. A busy
 * window that ends when the bytes exist would exclude parse-back validation —
 * which Stage 4A-2B2 measured at 37–45% of an export — so a test has to be able
 * to see that the window it sampled reached `validating` and then `complete`.
 */
interface HarnessExportPhase {
  readonly fraction: number;
  readonly note?: string;
  /** Milliseconds since the export was requested. */
  readonly at: number;
}

interface HarnessExportResult {
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly byteLength?: number;
  readonly fileName?: string;
  readonly observations?: readonly string[];
  readonly triangleCount?: number;
  readonly partCount?: number;
  readonly meshResourceCount?: number;
  readonly durationMs: number;
  /** First bytes, so a test can identify the format without holding the file. */
  readonly head?: string;
  readonly progressUpdates: number;
  readonly phases: readonly HarnessExportPhase[];
  /** Milliseconds from the cancel request to the terminal outcome. */
  readonly cancelLatencyMs?: number;
}

interface PendingExport {
  readonly session: { cancel(): void };
  readonly result: Promise<HarnessExportResult>;
  readonly cancelAt: { requestedAt?: number };
}

let activeExport: PendingExport | undefined;

function beginExport(
  documentId: string,
  revision: number,
  target: ExportTarget,
  sourceName: string,
  options: { readonly download?: boolean; readonly cancelAfterMs?: number } = {},
): void {
  const startedAt = performance.now();
  const phases: HarnessExportPhase[] = [];
  let progressUpdates = 0;

  const session = exportService.run({
    handle: { documentId, revision } as never,
    target,
    onProgress: (fraction, note) => {
      progressUpdates += 1;
      /*
       * CAPPED. This array is read once at the end and never rendered, but an
       * unbounded push per progress report would make the probe a participant
       * in the thing it measures. The writers report every 32,768 triangles, so
       * a few hundred entries covers any document that fits the ceilings.
       */
      if (phases.length < 512) {
        phases.push({
          fraction,
          ...(note === undefined ? {} : { note }),
          at: performance.now() - startedAt,
        });
      }
    },
  });

  /*
   * The cancel timestamp lives in its own holder rather than on `pending`,
   * because the async body below closes over it BEFORE `pending` is assigned.
   * A closure that reads a `const` declared after it is a temporal-dead-zone
   * error at run time, not a style preference.
   */
  const cancelAt: { requestedAt?: number } = {};

  const pending: PendingExport = {
    session,
    cancelAt,
    result: (async (): Promise<HarnessExportResult> => {
      const outcome: DocumentExportOutcome = await session.promise;
      const cancelLatency =
        cancelAt.requestedAt === undefined ? undefined : performance.now() - cancelAt.requestedAt;

      if (outcome.status !== 'SUCCESS') {
        return {
          status: outcome.status,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          message: outcome.message,
          durationMs: outcome.durationMs,
          progressUpdates,
          phases,
          ...(cancelLatency === undefined ? {} : { cancelLatencyMs: cancelLatency }),
        };
      }

      const fileName = deriveDocumentExportName(sourceName, target);
      if (options.download === true) {
        downloadBytes(outcome.bytes, fileName, 'application/octet-stream');
      }

      const head = new TextDecoder('utf-8', { fatal: false }).decode(outcome.bytes.subarray(0, 24));
      return {
        status: outcome.status,
        byteLength: outcome.bytes.byteLength,
        fileName,
        observations: outcome.metadata.observations,
        triangleCount: outcome.metadata.triangleCount,
        partCount: outcome.metadata.partCount,
        meshResourceCount: outcome.metadata.meshResourceCount,
        durationMs: outcome.durationMs,
        head,
        progressUpdates,
        phases,
        ...(cancelLatency === undefined ? {} : { cancelLatencyMs: cancelLatency }),
      };
    })(),
  };
  activeExport = pending;

  if (options.cancelAfterMs !== undefined) {
    setTimeout(() => {
      cancelAt.requestedAt = performance.now();
      session.cancel();
    }, options.cancelAfterMs);
  }
}

async function awaitExport(): Promise<HarnessExportResult> {
  const pending = activeExport;
  if (pending === undefined) throw new Error('no export is running');
  const result = await pending.result;
  activeExport = undefined;
  return result;
}

async function runExport(
  documentId: string,
  revision: number,
  target: ExportTarget,
  sourceName: string,
  options: { readonly download?: boolean; readonly cancelAfterMs?: number } = {},
): Promise<HarnessExportResult> {
  beginExport(documentId, revision, target, sourceName, options);
  return awaitExport();
}

/* ------------------------------------------------------- hole fill -- */

/**
 * THE HOLE-FILL ENGINE, DRIVEN FROM THE HARNESS AND FROM NOWHERE ELSE.
 *
 * Stage 4B-1B1 builds the ENGINE and deliberately ships no user-facing control:
 * selection, patch preview and Apply are Stage 4B-1B2. That leaves the engine
 * with no way to be exercised in a real browser — which is exactly the evidence
 * gap the harness exists to close, the same way it closed the multi-part
 * document gap and the document-export gap before it.
 *
 * It drives the PRODUCTION `HoleFillService`, which builds the production
 * disposable worker, which loads the production kernel. Nothing about the
 * operation is reimplemented here; the bridge only starts it, times it, and
 * reports scalars.
 *
 * It is not in the application build, and there is still no production URL,
 * query parameter or hidden button that reaches it.
 */
const holeFillService = new HoleFillService(geometryClient);

interface HarnessHoleFillResult {
  readonly status: string;
  readonly message?: string;
  readonly candidateId?: string;
  readonly candidatePartId?: string;
  readonly candidateRevision?: number;
  readonly candidateLoopId?: string;
  readonly summary?: Record<string, unknown>;
  /** The authoritative worker's byte-preservation verdict. Stage 4B-1B1-R1. */
  readonly sourcePositionsPreserved?: boolean;
  readonly sourceFacePrefixPreserved?: boolean;
  readonly durationMs: number;
  /** Milliseconds from the cancel request to the terminal outcome. */
  readonly cancelLatencyMs?: number;
  readonly startedFaceCount?: number;
}

interface PendingHoleFill {
  readonly session: { cancel(): void };
  readonly result: Promise<HarnessHoleFillResult>;
  readonly cancelAt: { requestedAt?: number };
}

let activeHoleFill: PendingHoleFill | undefined;

function beginHoleFill(
  documentId: string,
  revision: number,
  partIdentifier: string,
  boundaryLoopId: string,
  options: { readonly cancelAfterMs?: number } = {},
): void {
  const startedAt = performance.now();
  const cancelAt: { requestedAt?: number } = {};
  let startedFaceCount: number | undefined;

  const session = holeFillService.run({
    handle: { documentId, revision } as never,
    partId: partIdentifier,
    boundaryLoopId,
    onStarted: (faceCount) => {
      startedFaceCount = faceCount;
    },
  });

  activeHoleFill = {
    session,
    cancelAt,
    result: (async (): Promise<HarnessHoleFillResult> => {
      try {
        const outcome = await session.promise;
        return {
          status: outcome.status,
          ...(outcome.candidate === undefined
            ? {}
            : {
                candidateId: outcome.candidate.candidateId,
                candidatePartId: outcome.candidate.partId,
                candidateRevision: outcome.candidate.sourceRevision,
                candidateLoopId: outcome.candidate.boundaryLoopId,
              }),
          summary: outcome.summary as unknown as Record<string, unknown>,
          ...(outcome.sourcePositionsPreserved === undefined
            ? {}
            : { sourcePositionsPreserved: outcome.sourcePositionsPreserved }),
          ...(outcome.sourceFacePrefixPreserved === undefined
            ? {}
            : { sourceFacePrefixPreserved: outcome.sourceFacePrefixPreserved }),
          durationMs: performance.now() - startedAt,
          ...(cancelAt.requestedAt === undefined
            ? {}
            : { cancelLatencyMs: performance.now() - cancelAt.requestedAt }),
          ...(startedFaceCount === undefined ? {} : { startedFaceCount }),
        };
      } catch (cause) {
        return {
          status: cause instanceof Error ? cause.name : 'UNKNOWN',
          message: cause instanceof Error ? cause.message : String(cause),
          durationMs: performance.now() - startedAt,
          ...(cancelAt.requestedAt === undefined
            ? {}
            : { cancelLatencyMs: performance.now() - cancelAt.requestedAt }),
          ...(startedFaceCount === undefined ? {} : { startedFaceCount }),
        };
      }
    })(),
  };

  if (options.cancelAfterMs !== undefined) {
    setTimeout(() => {
      cancelAt.requestedAt = performance.now();
      session.cancel();
    }, options.cancelAfterMs);
  }
}

async function awaitHoleFill(): Promise<HarnessHoleFillResult> {
  const pending = activeHoleFill;
  if (pending === undefined) throw new Error('no hole fill is running');
  const result = await pending.result;
  activeHoleFill = undefined;
  return result;
}

async function listBoundaryLoops(
  documentId: string,
  revision: number,
  partIdentifier: string,
): Promise<unknown> {
  return geometryClient.listBoundaryLoops({ documentId, revision } as never, partIdentifier)
    .promise;
}

let nextEditRequestId = 1;
function beginTestEdit(
  documentId: string,
  revision: number,
  partId: string,
  dx: number,
): Promise<GeometryEditCandidateHandle> {
  const requestId = nextEditRequestId++;
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent): void => {
      const result = event.data as {
        kind?: string;
        requestId?: number;
        ok?: boolean;
        candidate?: GeometryEditCandidateHandle;
        message?: string;
      };
      if (result.kind !== 'harness/edit-result' || result.requestId !== requestId) return;
      harnessWorker.removeEventListener('message', listener);
      if (result.ok && result.candidate) resolve(result.candidate);
      else reject(new Error(result.message ?? 'Test edit failed.'));
    };
    harnessWorker.addEventListener('message', listener);
    harnessWorker.postMessage({
      kind: 'harness/edit-translate',
      requestId,
      documentId,
      revision,
      partId,
      dx,
    });
  });
}

interface HarnessBooleanResult {
  readonly status: string;
  readonly triangles?: number;
  readonly elapsedMs: number;
  readonly stats: {
    readonly active: number;
    readonly created: number;
    readonly terminated: number;
  };
  readonly phases: readonly { readonly phase: string; readonly at: number }[];
}
let nextBooleanRequestId = 1;
let activeBooleanResult: Promise<HarnessBooleanResult> | undefined;
let cancelActiveBoolean: (() => void) | undefined;
let activeBooleanPhases: readonly { phase: string; at: number }[] = [];
function beginTestBoolean(
  operation: 'union' | 'difference' | 'intersection',
  segments = 20,
  rings = 12,
  testCrash = false,
): void {
  const requestId = nextBooleanRequestId++;
  const phases: { phase: string; at: number }[] = [];
  const cancellation = new SharedCancellationSource();
  activeBooleanPhases = phases;
  activeBooleanResult = new Promise((resolve) => {
    const listener = (event: MessageEvent): void => {
      const data = event.data as {
        kind?: string;
        requestId?: number;
        phase?: string;
        at?: number;
        status?: string;
        triangles?: number;
        elapsedMs?: number;
        stats?: HarnessBooleanResult['stats'];
      };
      if (data.requestId !== requestId) return;
      if (
        data.kind === 'harness/boolean-phase' &&
        data.phase !== undefined &&
        data.at !== undefined
      ) {
        phases.push({ phase: data.phase, at: data.at });
        return;
      }
      if (
        data.kind !== 'harness/boolean-result' ||
        data.status === undefined ||
        data.elapsedMs === undefined ||
        data.stats === undefined
      )
        return;
      harnessWorker.removeEventListener('message', listener);
      resolve({
        status: data.status,
        ...(data.triangles === undefined ? {} : { triangles: data.triangles }),
        elapsedMs: data.elapsedMs,
        stats: data.stats,
        phases,
      });
    };
    harnessWorker.addEventListener('message', listener);
    harnessWorker.postMessage({
      kind: 'harness/boolean-run',
      requestId,
      operation,
      segments,
      rings,
      testCrash,
      cancellation: cancellation.buffer,
    });
  });
  cancelActiveBoolean = (): void => {
    cancellation.cancel();
    harnessWorker.postMessage({ kind: 'harness/boolean-cancel', requestId });
  };
}
async function awaitTestBoolean(): Promise<HarnessBooleanResult> {
  if (activeBooleanResult === undefined) throw new Error('No Boolean operation is active.');
  const result = await activeBooleanResult;
  activeBooleanResult = undefined;
  cancelActiveBoolean = undefined;
  activeBooleanPhases = result.phases;
  return result;
}

declare global {
  interface Window {
    cadfixerHarness?: {
      digest(documentId: string, revision: number): Promise<HarnessDigest>;
      beginTestEdit(
        documentId: string,
        revision: number,
        partId: string,
        dx: number,
      ): Promise<GeometryEditCandidateHandle>;
      previewTestEdit(candidate: GeometryEditCandidateHandle): Promise<{ vertexCount: number }>;
      commitTestEdit(
        candidate: GeometryEditCandidateHandle,
        documentId: string,
        revision: number,
        partId: string,
      ): Promise<{ revision: number; recordId: string }>;
      discardTestEdit(candidate: GeometryEditCandidateHandle): Promise<boolean>;
      undoTestEdit(documentId: string, revision: number, recordId: string): Promise<number>;
      beginTestBoolean(
        operation: 'union' | 'difference' | 'intersection',
        segments?: number,
        rings?: number,
        testCrash?: boolean,
      ): void;
      awaitTestBoolean(): Promise<HarnessBooleanResult>;
      cancelTestBoolean(): void;
      testBooleanPhases(): readonly { phase: string; at: number }[];
      resetSplitQualification(): void;
      splitQualificationEvents(): readonly HarnessSplitQualificationEvent[];
      /** Stage 6E-A2: which 3MF reader the harness worker's real import uses. */
      setIngestion(mode: 'buffered' | 'streaming' | 'auto', maxEntryBytes?: number): Promise<void>;
      exportDocument(
        documentId: string,
        revision: number,
        target: ExportTarget,
        sourceName: string,
        options?: { readonly download?: boolean; readonly cancelAfterMs?: number },
      ): Promise<HarnessExportResult>;
      beginExport(
        documentId: string,
        revision: number,
        target: ExportTarget,
        sourceName: string,
        options?: { readonly download?: boolean; readonly cancelAfterMs?: number },
      ): void;
      awaitExport(): Promise<HarnessExportResult>;
      cancelExport(): void;
      exportActiveOperation(): string | undefined;
      exportLiveWorkers(): number;
      exportLiveChannels(): number;
      listBoundaryLoops(documentId: string, revision: number, partId: string): Promise<unknown>;
      beginHoleFill(
        documentId: string,
        revision: number,
        partId: string,
        boundaryLoopId: string,
        options?: { readonly cancelAfterMs?: number },
      ): void;
      awaitHoleFill(): Promise<HarnessHoleFillResult>;
      cancelHoleFill(): void;
      holeFillActiveOperation(): string | undefined;
      holeFillLiveWorkers(): number;
      holeFillLiveChannels(): number;
    };
  }
}

/**
 * Chooses the 3MF reader the harness worker's REAL import uses — Stage 6E-A2.
 *
 * Only here, on the harness page, on a message kind of its own: the shipped
 * application has no way to send it and the shipped worker no listener for it.
 */
function setIngestion(
  mode: 'buffered' | 'streaming' | 'auto',
  maxEntryBytes?: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const listener = (event: MessageEvent): void => {
      const data: unknown = event.data;
      if (
        typeof data !== 'object' ||
        data === null ||
        (data as { kind?: unknown }).kind !== 'harness/ingestion-set'
      ) {
        return;
      }
      harnessWorker.removeEventListener('message', listener);
      resolve();
    };
    harnessWorker.addEventListener('message', listener);
    harnessWorker.postMessage({
      kind: 'harness/ingestion',
      mode,
      ...(maxEntryBytes === undefined ? {} : { maxEntryBytes }),
    });
  });
}

window.cadfixerHarness = {
  digest: requestDigest,
  beginTestEdit,
  previewTestEdit: async (candidate): Promise<{ vertexCount: number }> => {
    const result = await geometryClient.previewGeometryEdit(candidate).promise;
    return { vertexCount: result.render.vertexCount };
  },
  commitTestEdit: async (
    candidate,
    documentId,
    revision,
    partId,
  ): Promise<{ revision: number; recordId: string }> => {
    const result = await geometryClient.commitGeometryEdit(
      candidate,
      { documentId, revision } as never,
      partId,
    ).promise;
    store.applyGeometryEditResult(result);
    return { revision: result.handle.revision, recordId: result.recordId };
  },
  discardTestEdit: async (candidate): Promise<boolean> => {
    const result = await geometryClient.discardGeometryEdit(candidate).promise;
    return result.released;
  },
  undoTestEdit: async (documentId, revision, recordId): Promise<number> => {
    const result = await geometryClient.undoRepair(
      { documentId, revision } as never,
      recordId,
      () => undefined,
    ).promise;
    return result.handle.revision;
  },
  beginTestBoolean,
  awaitTestBoolean,
  cancelTestBoolean: (): void => cancelActiveBoolean?.(),
  testBooleanPhases: (): readonly { phase: string; at: number }[] => activeBooleanPhases,
  resetSplitQualification: (): void => {
    splitQualificationEvents = [];
  },
  splitQualificationEvents: (): readonly HarnessSplitQualificationEvent[] =>
    splitQualificationEvents,
  setIngestion,
  exportDocument: runExport,
  beginExport,
  awaitExport,
  cancelExport: (): void => {
    const pending = activeExport;
    if (pending === undefined) return;
    pending.cancelAt.requestedAt = performance.now();
    pending.session.cancel();
  },
  exportActiveOperation: (): string | undefined => exportService.activeOperation,
  exportLiveWorkers: (): number => exportService.liveWorkerCount,
  exportLiveChannels: (): number => exportService.liveChannelCount,

  listBoundaryLoops,
  beginHoleFill,
  awaitHoleFill,
  cancelHoleFill: (): void => {
    const pending = activeHoleFill;
    if (pending === undefined) return;
    pending.cancelAt.requestedAt = performance.now();
    pending.session.cancel();
  },
  holeFillActiveOperation: (): string | undefined => holeFillService.activeOperation,
  holeFillLiveWorkers: (): number => holeFillService.liveWorkerCount,
  holeFillLiveChannels: (): number => holeFillService.liveChannelCount,
};

createRoot(container).render(
  <StrictMode>
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={geometryClient}>
        <HarnessBar />
        <App />
      </GeometryClientProvider>
    </WorkspaceProvider>
  </StrictMode>,
);
