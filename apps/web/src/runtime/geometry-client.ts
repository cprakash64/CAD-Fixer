import {
  GeometryCoordinator,
  toTransferables,
  type DiagnosticSink,
  type MessageEndpoint,
  type OperationHandle,
  type ProgressUpdate,
  type SelfTestResult,
  type StlExportResult,
  type StlImportResult,
} from '@cadfixer/geometry-runtime';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { internalError } from '@cadfixer/shared';

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
}

export class GeometryClient {
  private readonly worker: Worker;
  private readonly coordinator: GeometryCoordinator;

  public constructor(options: GeometryClientOptions) {
    this.worker = new Worker(new URL('../workers/geometry.worker.ts', import.meta.url), {
      type: 'module',
      name: 'cadfixer-geometry',
    });

    this.coordinator = new GeometryCoordinator(createWorkerEndpoint(this.worker), {
      onDiagnostic: options.onDiagnostic,
    });

    // A worker that fails to load, or a message that cannot be cloned, produces
    // no protocol reply. Without these handlers every pending operation would
    // hang and the interface would wait forever on a result that is not coming.
    this.worker.addEventListener('error', (event: ErrorEvent) => {
      this.coordinator.failAllPending(
        internalError('The geometry worker failed to start or crashed.', {
          details: { detail: event.message },
        }),
      );
    });

    this.worker.addEventListener('messageerror', () => {
      this.coordinator.failAllPending(
        internalError('A message from the geometry worker could not be deserialised.'),
      );
    });
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
   * Parses an STL file in the worker.
   *
   * `bytes` is TRANSFERRED: the caller's buffer is detached as soon as this
   * returns and must not be read again. The parsed mesh and its render normals
   * come back by transfer too, so nothing large is ever cloned on this path.
   */
  public importStl(
    bytes: ArrayBuffer,
    onProgress: (update: ProgressUpdate) => void,
    budget?: Readonly<Record<string, number>>,
  ): OperationHandle<StlImportResult> {
    return this.coordinator.dispatch(
      'stl/import',
      budget === undefined ? { bytes } : { bytes, budget },
      { onProgress, transfer: [bytes] },
    );
  }

  /**
   * Encodes a mesh as STL in the worker.
   *
   * The mesh is CLONED rather than transferred, because the main thread is
   * still displaying it — transferring would detach the buffers the viewport is
   * rendering from. That clone is the one unavoidable copy in the export path,
   * and it is not free: structured-cloning a 2-million-triangle mesh copies
   * about 96 MiB. Eliminating it means keeping canonical geometry worker-side
   * and never handing it to the main thread at all. Recorded under "Not yet
   * measured" in docs/PERFORMANCE_BASELINE.md.
   */
  public exportStl(
    mesh: CanonicalMesh,
    encoding: string,
    onProgress: (update: ProgressUpdate) => void,
  ): OperationHandle<StlExportResult> {
    return this.coordinator.dispatch('stl/export', { mesh, encoding }, { onProgress });
  }

  public dispose(): void {
    this.coordinator.dispose();
  }
}
