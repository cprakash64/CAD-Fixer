import { operationCancelled, type Diagnostic } from '@cadfixer/shared';
import type {
  ModelHandle,
  OperationHandle,
  ProgressUpdate,
  StlExportResult,
} from '@cadfixer/geometry-runtime';
import { deriveExportName, downloadBytes } from './download';

/**
 * The one path from a loaded model to a file on the user's disk.
 *
 * WHY THIS EXISTS AS A SERVICE. Export orchestration previously lived inside
 * `ModelPanel`: the component dispatched the worker operation, derived the
 * filename, triggered the download, and pushed status. That put geometry-
 * operation sequencing in a presentation component, which is the boundary this
 * project is built around — and it made progress and cancellation awkward
 * enough that neither was implemented.
 *
 * Shaped deliberately like `import-service`: start it, watch progress, cancel
 * it, await the outcome. The component decides *that* an export happens; this
 * decides *how*.
 *
 * Nothing here touches the network. The bytes come back from the worker and go
 * straight into a local `Blob`.
 */

export const ExportPhase = {
  Writing: 'writing',
  Saving: 'saving',
  Complete: 'complete',
} as const;

export type ExportPhase = (typeof ExportPhase)[keyof typeof ExportPhase];

export interface ExportProgress {
  readonly phase: ExportPhase;
  /** 0..1, monotonic across the whole export. */
  readonly fraction: number;
}

export interface ExportOutcome {
  readonly fileName: string;
  readonly byteLength: number;
  readonly encoding: string;
  readonly warnings: readonly Diagnostic[];
}

export interface ExportSession {
  readonly promise: Promise<ExportOutcome>;
  /** Cooperative. The writer polls between batches. */
  cancel(): void;
}

/**
 * The slice of the geometry client this service needs.
 *
 * Declared structurally rather than importing the concrete client so the
 * service can be tested against a stand-in without constructing a real
 * `Worker` — and so the dependency is visibly one method wide.
 */
export interface ExportCapableClient {
  exportModel(
    handle: ModelHandle,
    encoding: string,
    onProgress: (update: ProgressUpdate) => void,
  ): OperationHandle<StlExportResult>;
}

export interface ExportRequest {
  /**
   * Names the resident model; the request carries no geometry into the worker.
   *
   * The RESULT does carry geometry back — encoded STL bytes are the whole point
   * of an export. What never crosses is the authoritative canonical mesh, which
   * stays worker-resident.
   */
  readonly handle: ModelHandle;
  readonly sourceFileName: string;
  readonly encoding: 'binary' | 'ascii';
  readonly client: ExportCapableClient;
  onProgress?(progress: ExportProgress): void;
}

const MIME_TYPE = 'model/stl';

export function exportStlFile(request: ExportRequest): ExportSession {
  const { handle: modelHandle, sourceFileName, encoding, client } = request;

  let cancelled = false;
  let dispatchCancel: (() => void) | undefined;

  // Read through a function so TypeScript does not narrow the flag to
  // permanently false across the closure boundary — it is set from `cancel()`
  // and read inside `run()`.
  const isCancelled = (): boolean => cancelled;

  const run = async (): Promise<ExportOutcome> => {
    request.onProgress?.({ phase: ExportPhase.Writing, fraction: 0 });

    const handle = client.exportModel(modelHandle, encoding, (update) => {
      // The worker's 0..1 covers writing, which is nearly all of the work.
      // The remaining sliver is handing the bytes to the browser.
      request.onProgress?.({
        phase: ExportPhase.Writing,
        fraction: Math.min(0.98, update.fraction * 0.98),
      });
    });

    dispatchCancel = (): void => {
      handle.cancel();
    };
    if (isCancelled()) handle.cancel();

    const result = await handle.promise;

    // Checked again after the await: a cancel that lands while the result is in
    // flight must not produce a download. A partial file is worse than none —
    // the user would have a truncated STL with no indication it is truncated.
    if (isCancelled()) throw operationCancelled();

    request.onProgress?.({ phase: ExportPhase.Saving, fraction: 0.99 });

    const fileName = deriveExportName(sourceFileName, encoding === 'binary' ? '' : '-ascii');
    downloadBytes(new Uint8Array(result.bytes), fileName, MIME_TYPE);

    request.onProgress?.({ phase: ExportPhase.Complete, fraction: 1 });

    return {
      fileName,
      byteLength: result.byteLength,
      encoding: result.encoding,
      warnings: result.warnings,
    };
  };

  return {
    promise: run(),
    cancel(): void {
      cancelled = true;
      dispatchCancel?.();
    },
  };
}
