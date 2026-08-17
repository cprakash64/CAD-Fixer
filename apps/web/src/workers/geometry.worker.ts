import {
  createSelfTestHandler,
  GeometryWorkerHost,
  toTransferables,
  type MessageEndpoint,
} from '@cadfixer/geometry-runtime';
import {
  modelAnalyzeHandler,
  modelExportHandler,
  modelImportHandler,
  modelReleaseHandler,
} from './stl-handlers';
import {
  repairCommitHandler,
  repairCreateCandidateHandler,
  repairDiscardHandler,
  repairPlanHandler,
  repairUndoHandler,
} from './repair-handlers';

/**
 * The geometry worker entry point.
 *
 * This is the ONLY place in the worker that touches worker globals. All
 * coordination logic lives in `@cadfixer/geometry-runtime`, which is
 * platform-free and unit-tested outside a browser.
 *
 * Stage 0 registers a single diagnostic handler. Format codecs and geometry
 * operations will register here as they are implemented.
 */

// `self` is already typed as DedicatedWorkerGlobalScope under the WebWorker lib
// that this directory's tsconfig selects. Aliasing it keeps the intent explicit.
const workerScope: DedicatedWorkerGlobalScope = self;

const endpoint: MessageEndpoint = {
  postMessage(message, transfer) {
    workerScope.postMessage(message, toTransferables(transfer));
  },
  addMessageListener(listener) {
    const handler = (event: MessageEvent): void => {
      listener(event.data);
    };
    workerScope.addEventListener('message', handler);
    return () => {
      workerScope.removeEventListener('message', handler);
    };
  },
};

const host = new GeometryWorkerHost(endpoint);

host.register('model/import', modelImportHandler);
host.register('model/export', modelExportHandler);
host.register('model/release', modelReleaseHandler);
host.register('model/analyze', modelAnalyzeHandler);

// Conservative repair. Five operations so planning, preview, apply and undo
// stay separate acts; see apps/web/src/workers/repair-handlers.ts. No geometry
// kernel is involved.
host.register('repair/plan', repairPlanHandler);
host.register('repair/create-candidate', repairCreateCandidateHandler);
host.register('repair/commit', repairCommitHandler);
host.register('repair/discard', repairDiscardHandler);
host.register('repair/undo', repairUndoHandler);

host.register(
  'runtime/self-test',
  createSelfTestHandler({
    // A macrotask, not a microtask: only a macrotask boundary lets the worker's
    // message queue deliver a pending `cancel` between chunks.
    yieldToEventLoop: () =>
      new Promise<void>((resolve) => {
        workerScope.setTimeout(resolve, 0);
      }),
  }),
);

host.start();
