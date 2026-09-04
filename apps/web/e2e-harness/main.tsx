import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import { GeometryClientProvider } from '../src/runtime/client-context';
import { GeometryClient } from '../src/runtime/geometry-client';
import { WorkspaceProvider } from '../src/state/store-context';
import { StatusSeverity, WorkspaceStore } from '../src/state/workspace-store';
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

declare global {
  interface Window {
    cadfixerHarness?: {
      digest(documentId: string, revision: number): Promise<HarnessDigest>;
    };
  }
}

window.cadfixerHarness = { digest: requestDigest };

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
