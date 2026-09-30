import { ExportStatus, exportRefusalOf, type ExportMetadata } from '@cadfixer/file-formats';
import type { DocumentHandle } from '@cadfixer/geometry-runtime';
import { AppErrorCode, toAppError, type AppError } from '@cadfixer/shared';
import type { GeometryClient } from './geometry-client';
import type { ExportFileDestination } from './export-file-sink';
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
 * Large OBJ delivery carries one bounded byte chunk at a time. The controller
 * acknowledges completed disk writes, checks the live document before commit,
 * and owns the transactional writable's close/abort lifecycle. Small artifacts
 * retain the automatic-download path.
 */

export const ExportTarget = {
  /** The WHOLE document, flattened. Not `model/export`, which writes one part. */
  Stl: 'stl',
  Obj: 'obj',
  ThreeMf: '3mf',
} as const;

export type ExportTarget = (typeof ExportTarget)[keyof typeof ExportTarget];

export interface DocumentExportRequest {
  readonly handle: DocumentHandle;
  /** Selected under user activation; no worker or snapshot starts before it resolves. */
  readonly destination?: Promise<ExportFileDestination>;
  readonly isCurrent?: () => boolean;
  readonly target: ExportTarget;
  /**
   * What the user stated this document's numbers mean, for this export only.
   *
   * Sent as given; the AUTHORITATIVE worker decides whether it applies, and it
   * applies only to a document that states no unit of its own. The page is not
   * the guard here — it cannot be, because it holds a mirror of the document
   * rather than the document.
   */
  readonly unitAssertion?: string;
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
      readonly bytes: Uint8Array | undefined;
      readonly savedFileName?: string;
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
  private cleanupOutput: (() => Promise<void>) | undefined;
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
   * ONE AT A TIME, deterministically. A second export is refused while the
   * first owns its destination, including abort/cleanup and submitted close.
   * Two concurrent fifty-megabyte serialisations on one workspace would
   * compete for the memory the ceilings were sized against, and both would
   * publish into the same slot with no way to tell which artifact was which.
   */
  public run(request: DocumentExportRequest): DocumentExportSession {
    if (this.activeOperationId !== undefined) {
      return {
        operationId: 'export-busy',
        cancel: (): void => undefined,
        promise: (async (): Promise<DocumentExportOutcome> => {
          try {
            await (await request.destination)?.abort();
          } catch (cause) {
            return outcomeFrom(toAppError(cause), undefined, 0);
          }
          return outcomeFrom(toAppError(new Error('An export is already running.')), undefined, 0);
        })(),
      };
    }
    const operationId = `export-${String(nextOperation++)}`;
    const startedAt = Date.now();
    this.activeOperationId = operationId;
    let destination: ExportFileDestination | undefined;
    let completed = false;
    let stopping = false;
    let writing = false;
    let committing = false;
    const active = (): boolean => this.activeOperationId === operationId && !stopping;
    const current = (): boolean => active() && (request.isCurrent?.() ?? true);
    const clean = async (): Promise<void> => {
      stopping = true;
      if (!completed) {
        // A rejected acquisition already cleaned any placeholder it owned; there is no sink to abort.
        const selected = destination ?? (await request.destination?.catch(() => undefined));
        await selected?.abort();
      }
    };
    this.cleanupOutput = clean;
    const failed = (cause: unknown): void => {
      if (!active()) return;
      const cancelled = cause instanceof DOMException && cause.name === 'AbortError';
      this.settle(
        operationId,
        cancelled
          ? {
              status: ExportStatus.Cancelled,
              reason: undefined,
              message: 'Export was cancelled.',
              durationMs: Date.now() - startedAt,
            }
          : outcomeFrom(
              toAppError(cause),
              exportRefusalOf(toAppError(cause)),
              Date.now() - startedAt,
            ),
      );
    };
    const stale = (): void => {
      this.settle(operationId, {
        status: ExportStatus.StaleRevision,
        reason: 'EXPORT_STALE_REVISION',
        message: 'The model changed while it was being written.',
        durationMs: Date.now() - startedAt,
      });
    };
    const promise = new Promise<DocumentExportOutcome>((resolve) => {
      this.settleCurrent = resolve;
    });
    this.cancelCurrent = (): void => {
      if (!active() || committing) return;
      this.settle(operationId, {
        status: ExportStatus.Cancelled,
        reason: undefined,
        message: 'Export was cancelled.',
        durationMs: Date.now() - startedAt,
      });
    };
    const start = (): void => {
      if (!current()) {
        if (active()) stale();
        return;
      }
      const worker = this.createWorker();
      const channel = new MessageChannel();
      this.worker = worker;
      this.channel = channel;
      worker.addEventListener('error', () => {
        failed(new Error('The export worker failed.'));
      });
      worker.addEventListener('message', (event: MessageEvent<ExportWorkerOutbound>) => {
        if (!active()) return;
        const data = event.data;
        if ('operationId' in data && data.operationId !== operationId) return;
        switch (data.kind) {
          case 'ready':
            return;
          case 'progress':
            request.onProgress?.(data.fraction, data.note);
            return;
          case 'chunk': {
            if (destination === undefined || writing || committing) {
              failed(new Error('The export violated its bounded delivery protocol.'));
              return;
            }
            if (!current()) {
              stale();
              return;
            }
            writing = true;
            void destination
              .write(new Uint8Array(data.bytes))
              .then(() => {
                writing = false;
                if (current()) worker.postMessage({ kind: 'chunk-ack', operationId });
                else if (active()) stale();
              })
              .catch(failed);
            return;
          }
          case 'written':
          case 'file-ready': {
            if (
              !current() ||
              data.documentId !== request.handle.documentId ||
              data.documentRevision !== request.handle.revision
            ) {
              stale();
              return;
            }
            if (data.kind === 'written') {
              if (destination !== undefined) {
                failed(new Error('Expected a streamed export.'));
                return;
              }
              completed = true;
              this.settle(operationId, {
                status: ExportStatus.Success,
                bytes: new Uint8Array(data.bytes as ArrayBuffer),
                metadata: data.metadata,
                handle: request.handle,
                durationMs: Date.now() - startedAt,
              });
            } else {
              if (destination === undefined || writing || committing) {
                failed(new Error('The export destination is not ready to commit.'));
                return;
              }
              // Atomic publication is the transaction's linearization point.
              // Cancel is accepted until here; a committed file is success.
              committing = true;
              const selected = destination;
              void selected
                .close()
                .then(() => {
                  if (!active()) return;
                  completed = true;
                  request.onProgress?.(1, 'complete');
                  this.settle(operationId, {
                    status: ExportStatus.Success,
                    bytes: undefined,
                    savedFileName: selected.name,
                    metadata: data.metadata,
                    handle: request.handle,
                    durationMs: Date.now() - startedAt,
                  });
                })
                .catch(failed);
            }
            return;
          }
          case 'failed':
            this.settle(
              operationId,
              outcomeFrom(toAppError(new Error(data.message)), data.reason, Date.now() - startedAt),
            );
            return;
        }
      });
      worker.postMessage(
        {
          kind: 'port',
          port: channel.port2,
          ...(destination === undefined ? {} : { fileBacked: true }),
        },
        [channel.port2],
      );
      void this.client
        .sendForExport({
          handle: request.handle,
          target: request.target,
          operationId,
          port: channel.port1,
          ...(request.unitAssertion === undefined ? {} : { unitAssertion: request.unitAssertion }),
        })
        .catch(failed);
    };
    if (request.destination === undefined) {
      try {
        start();
      } catch (cause) {
        failed(cause);
      }
    } else {
      void request.destination
        .then(async (selected) => {
          destination = selected;
          if (!current()) {
            await selected.abort();
            if (active()) stale();
            return;
          }
          start();
        })
        .catch(failed);
    }
    return {
      operationId,
      promise,
      cancel: (): void => {
        if (active()) this.cancelCurrent?.();
      },
    };
  }

  private settle(operationId: string, outcome: DocumentExportOutcome): void {
    if (this.activeOperationId !== operationId || this.settleCurrent === undefined) return;
    const resolve = this.settleCurrent;
    this.settleCurrent = undefined;
    const cleanup = this.cleanupOutput;
    this.cleanupOutput = undefined;
    this.teardown();
    void (cleanup?.() ?? Promise.resolve()).then(
      () => {
        this.activeOperationId = undefined;
        resolve(outcome);
      },
      (cause: unknown) => {
        this.activeOperationId = undefined;
        resolve(outcomeFrom(toAppError(cause), undefined, outcome.durationMs));
      },
    );
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
    this.cancelCurrent?.();
  }
}
