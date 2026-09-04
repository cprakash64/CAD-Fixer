import {
  SELF_INTERSECTION_MAX_FACES,
  SelfIntersectionStatus,
  DEFAULT_SELF_INTERSECTION_LIMITS,
  type SelfIntersectionLimits,
  type SelfIntersectionReport,
} from '@cadfixer/mesh-self-intersection';
import type { ModelHandle } from '@cadfixer/geometry-runtime';
import { toAppError } from '@cadfixer/shared';
import type { GeometryClient } from './geometry-client';
import type { DiagnosticWorkerOutbound } from '../workers/self-intersection-protocol';

/**
 * THE DIAGNOSTIC CONTROLLER.
 *
 * It owns three disposable things — a Worker, a MessageChannel and one
 * in-flight operation — and its entire design is about being able to throw all
 * three away at any moment without harming anything that matters.
 *
 * CANCELLATION IS TERMINATION, and that is a deliberate architectural choice
 * rather than a shortcut. Geogram's narrowphase is a long synchronous C++ call
 * that does not poll a JavaScript flag, so the cooperative shared-memory
 * cancellation Stage 3B-1C built for repair cannot reach inside it. Offering a
 * Cancel button backed by a flag the kernel never reads would be exactly the
 * dishonest interface this product forbids. So the worker is disposable and
 * Cancel kills it.
 *
 * THE AUTHORITATIVE WORKER IS NEVER TOUCHED. It is a different worker; it only
 * ever hands over a copy.
 */

export interface SelfIntersectionRunOptions {
  readonly handle: ModelHandle;
  readonly limits?: SelfIntersectionLimits;
  /** Bounded scalar progress. Never geometry. */
  readonly onStarted?: (faceCount: number) => void;
}

export interface SelfIntersectionSession {
  readonly operationId: string;
  readonly promise: Promise<SelfIntersectionReport>;
  /** Terminates the diagnostic worker. Idempotent. */
  cancel(): void;
}

/** Raised when the caller cancelled; distinguished so it never reads as failure. */
export class SelfIntersectionCancelled extends Error {
  public constructor() {
    super('Self-intersection check was cancelled.');
    this.name = 'SelfIntersectionCancelled';
  }
}

let nextOperation = 1;

/**
 * How the service obtains a diagnostic worker.
 *
 * Injectable so the FAILURE path can be exercised against a real worker
 * lifecycle — a `Promise` rejected by hand proves nothing about whether the
 * `error` listener, the port cleanup and the reference release actually work.
 * This is a construction seam, NOT a fault switch: the default is the only
 * behaviour the application ever uses, and nothing in the product can select
 * another.
 */
export type DiagnosticWorkerFactory = () => Worker;

const defaultWorkerFactory: DiagnosticWorkerFactory = () =>
  new Worker(new URL('../workers/self-intersection.worker.ts', import.meta.url), {
    type: 'module',
    name: 'cadfixer-self-intersection',
  });

export class SelfIntersectionService {
  private worker: Worker | undefined;
  private channel: MessageChannel | undefined;
  private activeOperationId: string | undefined;
  private readonly client: GeometryClient;
  private readonly createWorker: DiagnosticWorkerFactory;

  public constructor(
    client: GeometryClient,
    createWorker: DiagnosticWorkerFactory = defaultWorkerFactory,
  ) {
    this.client = client;
    this.createWorker = createWorker;
  }

  /** Live disposable workers. A diagnostic that leaks one is a leak per run. */
  public get liveWorkerCount(): number {
    return this.worker === undefined ? 0 : 1;
  }

  /** Live message channels. Should track `liveWorkerCount` exactly. */
  public get liveChannelCount(): number {
    return this.channel === undefined ? 0 : 1;
  }

  /** The operation currently in flight, if any. Used to prove release. */
  public get activeOperation(): string | undefined {
    return this.activeOperationId;
  }

  /**
   * Starts a check.
   *
   * ONE AT A TIME, deterministically. Starting a second check disposes the
   * first: two concurrent diagnostics on one workspace would race to publish
   * into the same slot, and the loser's result would be indistinguishable from
   * the winner's.
   */
  public run(options: SelfIntersectionRunOptions): SelfIntersectionSession {
    this.dispose();

    const operationId = `si-${String(nextOperation)}`;
    nextOperation += 1;
    this.activeOperationId = operationId;

    const worker = this.createWorker();
    const channel = new MessageChannel();
    this.worker = worker;
    this.channel = channel;

    const limits = options.limits ?? DEFAULT_SELF_INTERSECTION_LIMITS;

    const promise = new Promise<SelfIntersectionReport>((resolve, reject) => {
      this.rejectCurrent = reject;
      const settleCancelled = (): void => {
        reject(new SelfIntersectionCancelled());
      };

      worker.addEventListener('message', (event: MessageEvent<DiagnosticWorkerOutbound>) => {
        const data = event.data;
        // A message for a superseded operation is DISCARDED, never published.
        if ('operationId' in data && data.operationId !== operationId) return;

        switch (data.kind) {
          case 'ready':
            return;
          case 'started':
            options.onStarted?.(data.faceCount);
            return;
          case 'report':
            // Settled first, then torn down: `dispose` rejects whatever is still
            // pending, and a resolve arriving afterwards would be ignored.
            resolve(data.report);
            this.finish(operationId);
            return;
          case 'failed':
            reject(toAppError(new Error(data.reason)));
            this.finish(operationId);
            return;
          default:
            return;
        }
      });

      /*
       * A worker that dies without answering must not leave the caller waiting
       * forever. `error` covers a load or runtime failure; `terminate()` from
       * `cancel()` fires nothing at all, which is why cancellation rejects
       * explicitly rather than relying on an event.
       */
      worker.addEventListener('error', () => {
        reject(toAppError(new Error('The self-intersection worker failed.')));
        this.finish(operationId);
      });

      this.cancelCurrent = (): void => {
        if (this.activeOperationId !== operationId) return;
        this.dispose();
        settleCancelled();
      };
    });

    // Hand each worker its end of the channel, then ask the authoritative
    // worker to push a disposable copy across it.
    worker.postMessage({ kind: 'port', port: channel.port2 }, [channel.port2]);

    void this.client
      .sendForDiagnostic({
        handle: options.handle,
        operationId,
        port: channel.port1,
        limits,
      })
      .catch((cause: unknown) => {
        if (this.activeOperationId !== operationId) return;
        /*
         * THE REJECTION IS CAPTURED BEFORE THE TEARDOWN, and the order is the
         * whole fix. `finish` disposes the operation, and disposal clears
         * `rejectCurrent` — so rejecting afterwards called nothing at all and
         * the promise stayed pending forever. A producer-side refusal (an
         * above-ceiling model, a released handle) then left the panel saying
         * "Checking…" with no worker running and no way out.
         */
        const rejectProducerFailure = this.rejectCurrent;
        rejectProducerFailure?.(toAppError(cause));
        this.finish(operationId);
      });

    return {
      operationId,
      promise,
      cancel: (): void => {
        this.cancelCurrent?.();
      },
    };
  }

  /**
   * Releases the worker and the channel. Safe to call repeatedly.
   *
   * ALSO SETTLES A STILL-PENDING OPERATION. Superseding a run — starting a
   * second check, or unmounting — used to terminate the worker and drop the
   * reject function, leaving the first operation's promise pending forever.
   * Nothing user-visible waited on it, but a promise that can never settle is a
   * retained object with a retained closure, and "nobody happens to await it"
   * is not a lifecycle guarantee. Settling is a no-op when the promise already
   * resolved.
   */
  public dispose(): void {
    const abandoned = this.rejectCurrent;
    this.rejectCurrent = undefined;
    abandoned?.(new SelfIntersectionCancelled());

    this.worker?.terminate();
    this.worker = undefined;
    this.channel?.port1.close();
    this.channel?.port2.close();
    this.channel = undefined;
    this.activeOperationId = undefined;
    this.cancelCurrent = undefined;
  }

  private finish(operationId: string): void {
    if (this.activeOperationId !== operationId) return;
    this.dispose();
  }

  private cancelCurrent: (() => void) | undefined;
  private rejectCurrent: ((error: unknown) => void) | undefined;
}

/** The ceiling, re-exported so callers need not reach past the service. */
export { SELF_INTERSECTION_MAX_FACES, SelfIntersectionStatus };
