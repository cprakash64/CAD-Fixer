import {
  assertNever,
  createOperationId,
  deserializeAppError,
  internalError,
  operationCancelled,
  type AppError,
  type ErrorDetails,
  type OperationId,
} from '@cadfixer/shared';
import type { MessageEndpoint } from './endpoint';
import {
  isClientBoundMessage,
  PROTOCOL_CHANNEL,
  type OperationName,
  type OperationPayload,
  type OperationResult,
  type TransferHandle,
} from './protocol';

/**
 * Main-thread half of the worker boundary.
 *
 * Owns request/response correlation, progress fan-out, cancellation, and
 * teardown. It performs no geometry work itself and holds no mesh state.
 */

export interface ProgressUpdate {
  readonly fraction: number;
  readonly note?: string;
}

export interface DispatchOptions {
  readonly onProgress?: (update: ProgressUpdate) => void;
  /**
   * Buffers to move to the worker rather than copy. These are detached once
   * dispatch returns; the caller must not read them afterwards.
   */
  readonly transfer?: readonly TransferHandle[];
}

export interface OperationHandle<T> {
  readonly id: OperationId;
  readonly promise: Promise<T>;
  /**
   * Requests cancellation. Cancellation is cooperative, so the operation ends
   * only when the worker's handler next polls. The promise rejects with an
   * `OPERATION_CANCELLED` error.
   */
  cancel(): void;
}

/** Reports protocol anomalies that have no operation to reject. */
export type DiagnosticSink = (message: string, details: ErrorDetails) => void;

export interface GeometryCoordinatorOptions {
  /**
   * Required rather than optional: an unroutable message is a real defect, and
   * defaulting to a silent no-op would hide it. The application supplies a sink
   * that logs; tests supply one that records.
   */
  readonly onDiagnostic: DiagnosticSink;
}

interface PendingOperation {
  readonly operation: OperationName;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AppError) => void;
  readonly onProgress?: (update: ProgressUpdate) => void;
}

export class GeometryCoordinator {
  private readonly pending = new Map<OperationId, PendingOperation>();
  private readonly endpoint: MessageEndpoint;
  private readonly unsubscribe: () => void;
  private readonly onDiagnostic: DiagnosticSink;
  private disposed = false;

  public constructor(endpoint: MessageEndpoint, options: GeometryCoordinatorOptions) {
    this.endpoint = endpoint;
    this.onDiagnostic = options.onDiagnostic;
    this.unsubscribe = endpoint.addMessageListener((message) => {
      this.handleMessage(message);
    });
  }

  public get pendingCount(): number {
    return this.pending.size;
  }

  public dispatch<K extends OperationName>(
    operation: K,
    payload: OperationPayload<K>,
    options: DispatchOptions = {},
  ): OperationHandle<OperationResult<K>> {
    if (this.disposed) {
      throw internalError('Cannot dispatch on a disposed GeometryCoordinator.', {
        details: { operation },
      });
    }

    const id = createOperationId();
    let settle: PendingOperation | undefined;

    const promise = new Promise<OperationResult<K>>((resolve, reject) => {
      settle = {
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      };
    });

    // The executor above runs synchronously, so this is always defined. The
    // check exists so the invariant is enforced rather than assumed.
    if (settle === undefined) {
      throw internalError('Promise executor did not run synchronously.', {
        details: { operation },
      });
    }

    this.pending.set(id, settle);
    this.endpoint.postMessage(
      { channel: PROTOCOL_CHANNEL, kind: 'request', id, operation, payload },
      options.transfer ?? [],
    );

    return {
      id,
      promise,
      cancel: (): void => {
        this.requestCancel(id);
      },
    };
  }

  /**
   * Rejects every in-flight operation with `error`.
   *
   * Required because some transport failures produce no protocol message at
   * all — a worker script that fails to load, a structured-clone failure, or a
   * crashed worker. Without this, those operations would hang forever and the
   * interface would sit on a spinner. The transport adapter is responsible for
   * calling it when it observes such a failure.
   */
  public failAllPending(error: AppError): void {
    const abandoned = [...this.pending.values()];
    this.pending.clear();
    for (const operation of abandoned) operation.reject(error);
  }

  /**
   * Rejects every in-flight operation and detaches from the endpoint.
   *
   * Callers own the endpoint's lifetime; `dispose` closes it only if the
   * endpoint exposes `close`.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();

    const abandoned = [...this.pending.values()];
    this.pending.clear();
    for (const operation of abandoned) {
      operation.reject(
        operationCancelled('Geometry runtime shut down before the operation completed.'),
      );
    }

    this.endpoint.close?.();
  }

  private requestCancel(id: OperationId): void {
    if (!this.pending.has(id) || this.disposed) return;
    // The pending entry is intentionally kept: the worker still owes a terminal
    // message, and removing it here would make that message unroutable.
    this.endpoint.postMessage({ channel: PROTOCOL_CHANNEL, kind: 'cancel', id }, []);
  }

  private handleMessage(message: unknown): void {
    if (!isClientBoundMessage(message)) {
      this.onDiagnostic('Geometry worker sent a message outside the protocol.', {
        received: describeShape(message),
      });
      return;
    }

    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      this.onDiagnostic('Geometry worker sent a message for an unknown operation.', {
        operationId: message.id,
        kind: message.kind,
      });
      return;
    }

    switch (message.kind) {
      case 'progress':
        pending.onProgress?.({
          fraction: message.fraction,
          ...(message.note === undefined ? {} : { note: message.note }),
        });
        return;
      case 'result':
        this.pending.delete(message.id);
        pending.resolve(message.value);
        return;
      case 'error':
        this.pending.delete(message.id);
        pending.reject(deserializeAppError(message.error));
        return;
      default:
        assertNever(message, 'GeometryCoordinator.handleMessage');
    }
  }
}

/** Describes an unexpected value without echoing its contents into a log. */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
