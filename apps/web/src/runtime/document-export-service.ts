import { ExportStatus, type ExportMetadata } from '@cadfixer/file-formats';
import type { DocumentHandle } from '@cadfixer/geometry-runtime';
import { AppErrorCode, toAppError, type AppError } from '@cadfixer/shared';
import type { GeometryClient } from './geometry-client';
import type { ExportWorkerOutbound } from '../workers/export-protocol';

/**
 * THE DOCUMENT EXPORT CONTROLLER.
 *
 * It owns three disposable things — a Worker, a MessageChannel and one
 * in-flight operation — and its entire design is about being able to throw all
 * three away at any moment without harming anything that matters.
 *
 * CANCELLATION IS TERMINATION. Serialising fifty megabytes, compressing it and
 * reading it back are long allocating passes, and part of that time is spent
 * inside `CompressionStream`, which polls no flag of ours. A Cancel button
 * backed only by a cooperative token would be honest for the writer loops and a
 * lie for the compressor, so the worker is disposable and Cancel kills it.
 *
 * THE AUTHORITATIVE WORKER IS NEVER TOUCHED. It is a different worker; it only
 * ever hands over a snapshot.
 *
 * WHAT COMES BACK TO THE PAGE is the finished file. That is not a weakening of
 * ADR 0008: a serialised artifact is what the user asked to save, it cannot be
 * edited back into the model, and holding it is exactly as risky as holding the
 * file they already had on disk.
 */

export const ExportTarget = {
  Obj: 'obj',
  ThreeMf: '3mf',
} as const;

export type ExportTarget = (typeof ExportTarget)[keyof typeof ExportTarget];

export interface DocumentExportRequest {
  readonly handle: DocumentHandle;
  readonly target: ExportTarget;
  /** Bounded scalar progress. Never geometry. */
  readonly onProgress?: (fraction: number, note: string | undefined) => void;
}

/**
 * WHAT AN EXPORT PRODUCED, in a shape Stage 4A-2B3 can render.
 *
 * A discriminated union rather than a throw, because most of these are
 * DECISIONS rather than failures: a document with no unit cannot become a 3MF,
 * and that is something the user resolves, not an error to apologise for. The
 * status is the machine-readable fact; the sentence is B3's to write.
 */
export type DocumentExportOutcome =
  | {
      readonly status: typeof ExportStatus.Success;
      readonly bytes: Uint8Array;
      readonly metadata: ExportMetadata;
      readonly handle: DocumentHandle;
      readonly durationMs: number;
    }
  | {
      readonly status: Exclude<ExportStatus, typeof ExportStatus.Success>;
      /** The typed refusal reason, when the worker supplied one. */
      readonly reason: string | undefined;
      readonly message: string;
      readonly durationMs: number;
    };

export interface DocumentExportSession {
  readonly operationId: string;
  readonly promise: Promise<DocumentExportOutcome>;
  /** Terminates the export worker. Idempotent. */
  cancel(): void;
}

/**
 * How the service obtains an export worker.
 *
 * Injectable so the FAILURE path can be exercised against a real worker
 * lifecycle — a `Promise` rejected by hand proves nothing about whether the
 * `error` listener, the port cleanup and the reference release actually work.
 * A construction seam, NOT a fault switch: the default is the only behaviour
 * the application ever uses.
 */
export type ExportWorkerFactory = () => Worker;

const defaultWorkerFactory: ExportWorkerFactory = () =>
  new Worker(new URL('../workers/export.worker.ts', import.meta.url), {
    type: 'module',
    name: 'cadfixer-export',
  });

let nextOperation = 1;

function outcomeFrom(
  error: AppError,
  reason: string | undefined,
  durationMs: number,
): DocumentExportOutcome {
  const status =
    reason === 'EXPORT_UNIT_REQUIRED'
      ? ExportStatus.BlockedUnitRequired
      : reason === 'EXPORT_OUTPUT_TOO_LARGE' || reason === 'EXPORT_SERIALISED_TOO_LARGE'
        ? ExportStatus.ResourceLimit
        : reason === 'EXPORT_VALIDATION_FAILED' || reason === 'EXPORT_VALIDATION_UNREADABLE'
          ? ExportStatus.ValidationFailed
          : error.code === AppErrorCode.ModelUnavailable
            ? // The document was released or replaced while this was queued.
              ExportStatus.StaleRevision
            : ExportStatus.InternalFailure;

  return { status, reason, message: error.message, durationMs };
}

export class DocumentExportService {
  private worker: Worker | undefined;
  private channel: MessageChannel | undefined;
  private activeOperationId: string | undefined;
  private settleCurrent: ((outcome: DocumentExportOutcome) => void) | undefined;
  private cancelCurrent: (() => void) | undefined;
  private readonly client: GeometryClient;
  private readonly createWorker: ExportWorkerFactory;

  public constructor(
    client: GeometryClient,
    createWorker: ExportWorkerFactory = defaultWorkerFactory,
  ) {
    this.client = client;
    this.createWorker = createWorker;
  }

  /** Live disposable workers. An export that leaks one is a leak per run. */
  public get liveWorkerCount(): number {
    return this.worker === undefined ? 0 : 1;
  }

  /** Live message channels. Should track `liveWorkerCount` exactly. */
  public get liveChannelCount(): number {
    return this.channel === undefined ? 0 : 1;
  }

  public get activeOperation(): string | undefined {
    return this.activeOperationId;
  }

  /**
   * Starts an export.
   *
   * ONE AT A TIME, deterministically. Starting a second export disposes the
   * first: two concurrent fifty-megabyte serialisations on one workspace would
   * compete for the memory the ceilings were sized against, and both would
   * publish into the same slot with no way to tell which artifact was which.
   */
  public run(request: DocumentExportRequest): DocumentExportSession {
    this.dispose();

    const operationId = `export-${String(nextOperation)}`;
    nextOperation += 1;
    this.activeOperationId = operationId;

    const worker = this.createWorker();
    const channel = new MessageChannel();
    this.worker = worker;
    this.channel = channel;
    const startedAt = Date.now();

    const promise = new Promise<DocumentExportOutcome>((resolve) => {
      this.settleCurrent = resolve;

      worker.addEventListener('message', (event: MessageEvent<ExportWorkerOutbound>) => {
        const data = event.data;
        // A message for a superseded operation is DISCARDED, never published.
        if ('operationId' in data && data.operationId !== operationId) return;

        switch (data.kind) {
          case 'ready':
            return;
          case 'progress':
            request.onProgress?.(data.fraction, data.note);
            return;
          case 'written': {
            /*
             * THE REVISION IS RE-CHECKED HERE, against the handle the caller
             * asked for. The snapshot carries the revision it was built from,
             * so an artifact produced from a document that has since been
             * repaired, undone or replaced is DISCARDED rather than handed
             * back — a user must never be given a file of geometry they are no
             * longer looking at.
             */
            if (
              data.documentId !== request.handle.documentId ||
              data.documentRevision !== request.handle.revision
            ) {
              this.settle(operationId, {
                status: ExportStatus.StaleRevision,
                reason: 'EXPORT_STALE_REVISION',
                message: 'The model changed while it was being written, so the file was discarded.',
                durationMs: Date.now() - startedAt,
              });
              return;
            }
            this.settle(operationId, {
              status: ExportStatus.Success,
              bytes: new Uint8Array(data.bytes as ArrayBuffer),
              metadata: data.metadata,
              handle: request.handle,
              durationMs: Date.now() - startedAt,
            });
            return;
          }
          case 'failed':
            this.settle(
              operationId,
              outcomeFrom(toAppError(new Error(data.message)), data.reason, Date.now() - startedAt),
            );
            return;
          default:
            return;
        }
      });

      /*
       * A worker that dies without answering must not leave the caller waiting
       * forever. `error` covers a load or runtime failure; `terminate()` from
       * `cancel()` fires nothing at all, which is why cancellation settles
       * explicitly rather than relying on an event.
       */
      worker.addEventListener('error', () => {
        this.settle(operationId, {
          status: ExportStatus.InternalFailure,
          reason: undefined,
          message: 'The export worker failed.',
          durationMs: Date.now() - startedAt,
        });
      });

      this.cancelCurrent = (): void => {
        if (this.activeOperationId !== operationId) return;
        const cancelled: DocumentExportOutcome = {
          status: ExportStatus.Cancelled,
          reason: undefined,
          message: 'Export was cancelled.',
          durationMs: Date.now() - startedAt,
        };
        /*
         * THE RESOLVER IS TAKEN BEFORE THE TEARDOWN, and the order is the whole
         * fix. `dispose` settles whatever is still pending with a zeroed
         * record, so disposing first meant the promise had ALREADY resolved
         * with `durationMs: 0` by the time the real outcome arrived — and a
         * promise settles once, so the second call did nothing.
         *
         * Nothing user-visible depended on the number, which is exactly why it
         * went unnoticed: a test comparing a cancelled export's duration
         * against an uncancelled one was comparing against zero and passing for
         * the wrong reason.
         */
        const settle = this.settleCurrent;
        this.settleCurrent = undefined;
        this.dispose();
        settle?.(cancelled);
      };
    });

    // Hand each worker its end of the channel, then ask the authoritative
    // worker to push a disposable snapshot across it.
    worker.postMessage({ kind: 'port', port: channel.port2 }, [channel.port2]);

    void this.client
      .sendForExport({
        handle: request.handle,
        target: request.target,
        operationId,
        port: channel.port1,
      })
      .catch((cause: unknown) => {
        if (this.activeOperationId !== operationId) return;
        /*
         * SETTLED BEFORE THE TEARDOWN, and the order is load-bearing.
         * `settle` disposes the operation, and disposal clears the resolver —
         * so settling afterwards would call nothing and the promise would stay
         * pending forever. A producer-side refusal (a released handle, a stale
         * revision) would then leave a panel saying "Writing…" with no worker
         * running and no way out.
         */
        const error = toAppError(cause);
        this.settle(operationId, outcomeFrom(error, undefined, Date.now() - startedAt));
      });

    return {
      operationId,
      promise,
      cancel: (): void => {
        this.cancelCurrent?.();
      },
    };
  }

  private settle(operationId: string, outcome: DocumentExportOutcome): void {
    if (this.activeOperationId !== operationId) return;
    const resolve = this.settleCurrent;
    this.settleCurrent = undefined;
    this.teardown();
    this.activeOperationId = undefined;
    resolve?.(outcome);
  }

  private teardown(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.channel?.port1.close();
    this.channel?.port2.close();
    this.channel = undefined;
    this.cancelCurrent = undefined;
  }

  /**
   * Releases the worker and the channel. Safe to call repeatedly.
   *
   * ALSO SETTLES A STILL-PENDING OPERATION. Superseding a run used to terminate
   * the worker and drop the resolver, leaving the first operation's promise
   * pending forever — a retained object with a retained closure, which "nobody
   * happens to await it" is not a defence against.
   */
  public dispose(): void {
    const abandoned = this.settleCurrent;
    this.settleCurrent = undefined;
    this.teardown();
    this.activeOperationId = undefined;
    abandoned?.({
      status: ExportStatus.Cancelled,
      reason: undefined,
      message: 'Export was cancelled.',
      durationMs: 0,
    });
  }
}
