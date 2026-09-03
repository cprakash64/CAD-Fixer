import {
  adoptSharedCancellation,
  CancellationSource,
  combineCancellation,
  internalError,
  operationCancelled,
  toAppError,
  type CancellationToken,
  type OperationId,
} from '@cadfixer/shared';
import type { MessageEndpoint } from './endpoint';
import {
  isHostBoundMessage,
  PROTOCOL_CHANNEL,
  type OperationName,
  type OperationPayload,
  type OperationResult,
  type TransferHandle,
} from './protocol';

/**
 * Worker-thread half of the boundary.
 *
 * Dispatches inbound requests to registered handlers and guarantees exactly one
 * terminal message (`result` or `error`) per operation, including when a
 * handler throws or rejects.
 */

export interface OperationContext {
  readonly cancellation: CancellationToken;
  /**
   * Whether `cancellation` is backed by a SHARED control word, and therefore
   * whether it can be observed from inside synchronous work.
   *
   * FALSE MEANS MESSAGE-ONLY, which for a long synchronous handler means no
   * usable cancellation at all: the flag cannot change until the handler
   * returns. Handlers whose contract PROMISES interruptibility must refuse
   * rather than run — see the repair handlers. Exposed as a fact about the
   * operation rather than inferred by a handler poking at the token, because a
   * combined token looks identical either way.
   */
  readonly interruptible: boolean;
  /** Reports progress. `fraction` is clamped to 0..1. */
  reportProgress(fraction: number, note?: string): void;
  /** Throws `OPERATION_CANCELLED` if cancellation has been requested. */
  throwIfCancelled(): void;
}

export interface HandlerOutcome<T> {
  readonly value: T;
  /** Buffers to move back to the caller instead of copying. */
  readonly transfer?: readonly TransferHandle[];
}

export type OperationHandler<K extends OperationName> = (
  payload: OperationPayload<K>,
  context: OperationContext,
) => Promise<HandlerOutcome<OperationResult<K>>>;

/**
 * Erased handler signature used by the internal registry. The public `register`
 * method is generic, so registration stays type-checked at every call site;
 * only the storage is widened.
 */
type ErasedHandler = (
  payload: unknown,
  context: OperationContext,
) => Promise<HandlerOutcome<unknown>>;

export class GeometryWorkerHost {
  private readonly handlers = new Map<OperationName, ErasedHandler>();
  private readonly running = new Map<OperationId, CancellationSource>();
  private readonly endpoint: MessageEndpoint;
  private unsubscribe: (() => void) | undefined;

  public constructor(endpoint: MessageEndpoint) {
    this.endpoint = endpoint;
  }

  public register<K extends OperationName>(operation: K, handler: OperationHandler<K>): void {
    if (this.handlers.has(operation)) {
      throw internalError('Duplicate geometry operation handler registration.', {
        details: { operation },
      });
    }
    this.handlers.set(operation, handler as ErasedHandler);
  }

  /** Begins accepting requests. Returns a disposer. */
  public start(): () => void {
    if (this.unsubscribe !== undefined) {
      throw internalError('GeometryWorkerHost was started twice.');
    }
    this.unsubscribe = this.endpoint.addMessageListener((message) => {
      this.handleMessage(message);
    });
    return () => {
      this.stop();
    };
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const source of this.running.values()) source.cancel();
    this.running.clear();
  }

  private handleMessage(message: unknown): void {
    // Dropped without comment, unlike on the coordinator side, and deliberately
    // so: a worker's message port is shared with the host environment — Vite's
    // dev tooling posts to it — so foreign messages are expected traffic here
    // rather than a protocol anomaly.
    if (!isHostBoundMessage(message)) return;

    if (message.kind === 'cancel') {
      this.running.get(message.id)?.cancel();
      return;
    }

    // Deliberately not awaited: `run` converts every failure into an error
    // message, so there is no rejection to leak. `void` documents that.
    void this.run(message.id, message.operation, message.payload, message.cancellation);
  }

  private async run(
    id: OperationId,
    operation: OperationName,
    payload: unknown,
    cancellationBuffer: SharedArrayBuffer | undefined,
  ): Promise<void> {
    if (this.running.has(id)) {
      this.postError(id, internalError('Duplicate operation id received by worker.'));
      return;
    }

    const handler = this.handlers.get(operation);
    if (handler === undefined) {
      this.postError(
        id,
        internalError('No handler is registered for this geometry operation.', {
          details: { operation },
        }),
      );
      return;
    }

    const source = new CancellationSource();
    this.running.set(id, source);

    /*
     * BOTH HALVES, COMBINED.
     *
     * The shared word is what a synchronous loop can actually observe: the main
     * thread writes it with `Atomics.store` and it is visible here immediately,
     * without this worker returning to its event loop. The message-based source
     * is kept alongside it because it still arrives, it still drives the
     * lifecycle bookkeeping, and it is what an environment without cross-origin
     * isolation is left with.
     *
     * Handlers see one `CancellationToken` and do not care which half fired,
     * which is why every polling site written before this stage became genuinely
     * interruptible without being touched.
     */
    const cancellation: CancellationToken =
      cancellationBuffer === undefined
        ? source.token
        : combineCancellation(adoptSharedCancellation(cancellationBuffer), source.token);

    const context: OperationContext = {
      cancellation,
      interruptible: cancellationBuffer !== undefined,
      reportProgress: (fraction, note) => {
        if (cancellation.isCancelled) return;
        this.endpoint.postMessage(
          {
            channel: PROTOCOL_CHANNEL,
            kind: 'progress',
            id,
            fraction: clampFraction(fraction),
            ...(note === undefined ? {} : { note }),
          },
          [],
        );
      },
      throwIfCancelled: () => {
        if (cancellation.isCancelled) throw operationCancelled();
      },
    };

    try {
      const outcome = await handler(payload, context);
      // A handler can return normally after cancellation was requested. The
      // cancellation is authoritative, so the result is discarded.
      if (cancellation.isCancelled) {
        this.postError(id, operationCancelled());
        return;
      }
      this.endpoint.postMessage(
        { channel: PROTOCOL_CHANNEL, kind: 'result', id, value: outcome.value },
        outcome.transfer ?? [],
      );
    } catch (cause) {
      this.postError(id, toAppError(cause));
    } finally {
      this.running.delete(id);
    }
  }

  private postError(id: OperationId, error: ReturnType<typeof toAppError>): void {
    this.endpoint.postMessage(
      { channel: PROTOCOL_CHANNEL, kind: 'error', id, error: error.toSerializable() },
      [],
    );
  }
}

function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}
