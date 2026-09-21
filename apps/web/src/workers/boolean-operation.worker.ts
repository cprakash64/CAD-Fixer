/// <reference lib="webworker" />

import { uncancellable } from '@cadfixer/shared';
import { createManifoldBooleanBackend } from './manifold-boolean-backend';
import type { BooleanOperationReply, BooleanOperationRequest } from './boolean-operation-protocol';

const scope: DedicatedWorkerGlobalScope = self;
const post = (message: BooleanOperationReply, transfer: Transferable[] = []): void => {
  scope.postMessage(message, transfer);
};

scope.addEventListener('message', (event: MessageEvent<BooleanOperationRequest>) => {
  const request = event.data;
  const id = request.operationId;
  void (async (): Promise<void> => {
    try {
      post({ kind: 'phase', operationId: id, phase: 'WORKER_READY', at: performance.now() });
      if (request.testCrash === true) throw new Error('Test-only boolean worker crash.');
      const backend = await createManifoldBooleanBackend(undefined, {
        onInitialized: () => {
          post({ kind: 'phase', operationId: id, phase: 'WASM_READY', at: performance.now() });
        },
        onEnter: () => {
          post({ kind: 'phase', operationId: id, phase: 'MANIFOLD_ENTER', at: performance.now() });
        },
        onReturn: () => {
          post({ kind: 'phase', operationId: id, phase: 'MANIFOLD_RETURN', at: performance.now() });
        },
      });
      const mesh = await backend.operate(
        request.operation,
        { positions: request.aPositions, indices: request.aIndices, metadata: {} },
        { positions: request.bPositions, indices: request.bIndices, metadata: {} },
        uncancellable,
      );
      post({ kind: 'result', operationId: id, positions: mesh.positions, indices: mesh.indices }, [
        mesh.positions.buffer,
        mesh.indices.buffer,
      ]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Boolean worker failed.';
      post({
        kind: 'failed',
        operationId: id,
        message,
        expected: message.startsWith('Manifold refused '),
      });
    }
  })();
});
