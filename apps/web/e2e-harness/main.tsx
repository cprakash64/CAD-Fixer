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
import { HarnessBar } from './harness-bar';
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
 * THE EXPORT SERVICE, DRIVEN FROM THE HARNESS AND NOWHERE ELSE.
 *
 * Stage 4A-2B2 builds the export ENGINE; Stage 4A-2B3 builds the workflow that
 * lets a user reach it. Until then the only thing that calls it is this bridge,
 * which is not in the application build — so a browser test can prove the whole
 * path works without the product claiming a feature it has not finished
 * designing. There is deliberately no production URL, query parameter or hidden
 * button that reaches this.
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

declare global {
  interface Window {
    cadfixerHarness?: {
      digest(documentId: string, revision: number): Promise<HarnessDigest>;
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
    };
  }
}

window.cadfixerHarness = {
  digest: requestDigest,
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
