import {
  HOLE_FILL_MAX_BOUNDARY_VERTICES,
  HOLE_FILL_MAX_PART_FACES,
  HoleFillStatus,
  type DocumentHandle,
  type HoleFillLimits,
  type SendForFillResult,
} from '@cadfixer/geometry-runtime';
import { toAppError } from '@cadfixer/shared';
import type { GeometryClient } from './geometry-client';
import type { HoleFillWorkerOutbound } from '../workers/hole-fill-protocol';

/**
 * THE HOLE-FILL CONTROLLER.
 *
 * It owns three disposable things — a Worker, a MessageChannel and one
 * in-flight operation — and its entire design is about being able to throw all
 * three away at any moment without harming anything that matters.
 *
 * CANCELLATION IS TERMINATION, and that is an architectural choice rather than
 * a shortcut. The fill runs as one synchronous pass containing a long sequence
 * of exact C++ narrowphase calls that poll no JavaScript flag, so the
 * cooperative shared-memory cancellation Stage 3B-1C built for repair cannot
 * reach inside it. Offering a Cancel button backed by a flag nothing reads
 * would be exactly the dishonest interface this product forbids. So the worker
 * is disposable and Cancel kills it — AND cancels the authoritative operation,
 * because that side is awaiting a channel the dead worker will never answer.
 *
 * THE AUTHORITATIVE WORKER IS NEVER TERMINATED. It is a different worker; it
 * only ever hands over a copy and takes back a candidate.
 *
 * NO USER-FACING CONTROL REACHES THIS YET. Stage 4B-1B1 builds the engine and
 * its lifecycle; the Fill Hole workflow, the patch preview and Apply are Stage
 * 4B-1B2.
 */

export interface HoleFillRunOptions {
  readonly handle: DocumentHandle;
  /**
   * The part to fill.
   *
   * Hole filling is intra-part, exactly as self-intersection is: it works in
   * part-local coordinates, leaves `PartTransform` untouched, and never
   * examines another part of the document.
   */
  readonly partId: string;
  /** An identity obtained from `listBoundaryLoops`. Never an index. */
  readonly boundaryLoopId: string;
  /** May only NARROW the production ceilings. The worker clamps. */
  readonly limits?: Partial<HoleFillLimits>;
  /** Bounded scalar progress. Never geometry. */
  readonly onStarted?: (faceCount: number) => void;
}

export interface HoleFillSession {
  readonly operationId: string;
  readonly promise: Promise<SendForFillResult>;
  /** Terminates the fill worker and cancels the authoritative side. Idempotent. */
  cancel(): void;
}

/** Raised when the caller cancelled; distinguished so it never reads as failure. */
export class HoleFillCancelled extends Error {
  public constructor() {
    super('Hole filling was cancelled.');
    this.name = 'HoleFillCancelled';
  }
}

let nextOperation = 1;

/**
 * How the service obtains a fill worker.
 *
 * Injectable so the FAILURE path can be exercised against a real worker
 * lifecycle — a `Promise` rejected by hand proves nothing about whether the
 * `error` listener, the port cleanup and the reference release actually work.
 * This is a construction seam, NOT a fault switch: the default is the only
 * behaviour the application ever uses, and nothing in the product can select
 * another.
 */
export type HoleFillWorkerFactory = () => Worker;

const defaultWorkerFactory: HoleFillWorkerFactory = () =>
  new Worker(new URL('../workers/hole-fill.worker.ts', import.meta.url), {
    type: 'module',
    name: 'cadfixer-hole-fill',
  });

export class HoleFillService {
  private worker: Worker | undefined;
  private channel: MessageChannel | undefined;
  private activeOperationId: string | undefined;
  private cancelCurrent: (() => void) | undefined;
  private resolveCurrent: ((value: SendForFillResult) => void) | undefined;
  private rejectCurrent: ((error: unknown) => void) | undefined;
  private cancelAuthoritative: (() => void) | undefined;
  private readonly client: GeometryClient;
  private readonly createWorker: HoleFillWorkerFactory;

  public constructor(
    client: GeometryClient,
    createWorker: HoleFillWorkerFactory = defaultWorkerFactory,
  ) {
    this.client = client;
    this.createWorker = createWorker;
  }

  /** Live disposable workers. A fill that leaks one is a leak per run. */
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
   * Starts a fill.
   *
   * ONE AT A TIME, deterministically. Starting a second fill disposes the
   * first: two concurrent fills on one document would race to register into the
   * same candidate slot, and the loser's candidate would be indistinguishable
   * from the winner's.
   */
  public run(options: HoleFillRunOptions): HoleFillSession {
    this.dispose();

    const operationId = `hole-fill-${String(nextOperation)}`;
    nextOperation += 1;
    this.activeOperationId = operationId;

    const worker = this.createWorker();
    const channel = new MessageChannel();
    this.worker = worker;
    this.channel = channel;

    const promise = new Promise<SendForFillResult>((resolve, reject) => {
      this.resolveCurrent = resolve;
      this.rejectCurrent = reject;

      worker.addEventListener('message', (event: MessageEvent<HoleFillWorkerOutbound>) => {
        const data = event.data;
        if (data.kind === 'started') {
          if (data.operationId !== operationId) return;
          options.onStarted?.(data.faceCount);
        }
      });

      /*
       * A worker that dies without answering must not leave the caller waiting
       * forever. `error` covers a load or runtime failure; `terminate()` from
       * `cancel()` fires nothing at all, which is why cancellation rejects
       * explicitly rather than relying on an event.
       */
      worker.addEventListener('error', () => {
        if (this.activeOperationId !== operationId) return;
        // SETTLED FIRST, THEN TORN DOWN. `dispose` rejects whatever is still
        // pending, and a settle arriving afterwards would be ignored.
        this.rejectCurrent?.(toAppError(new Error('The hole-fill worker failed.')));
        this.dispose();
      });

      this.cancelCurrent = (): void => {
        if (this.activeOperationId !== operationId) return;
        this.rejectCurrent?.(new HoleFillCancelled());
        this.dispose();
      };
    });

    // Hand each worker its end of the channel, then ask the authoritative
    // worker to push a disposable copy across it and await the candidate.
    worker.postMessage({ kind: 'port', port: channel.port2 }, [channel.port2]);

    const authoritative = this.client.sendForFill({
      handle: options.handle,
      partId: options.partId,
      boundaryLoopId: options.boundaryLoopId,
      operationId,
      port: channel.port1,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
    // Wrapped rather than stored by reference: an unbound method would carry
    // the handle's `this` if the coordinator ever made `cancel` a method.
    this.cancelAuthoritative = (): void => {
      authoritative.cancel();
    };

    void authoritative.promise.then(
      (value) => {
        if (this.activeOperationId !== operationId) return;
        this.resolveCurrent?.(value);
        this.dispose();
      },
      (cause: unknown) => {
        if (this.activeOperationId !== operationId) return;
        /*
         * SETTLED BEFORE THE TEARDOWN, and the order is the whole point.
         * `dispose` settles whatever is still pending as a cancellation, so a
         * genuine failure has to be delivered first or it would be reported as
         * a cancellation instead — and settling after `dispose` would call
         * nothing at all, leaving the promise pending forever. That is the
         * exact defect the export and diagnostic controllers were corrected
         * for.
         */
        this.rejectCurrent?.(toAppError(cause));
        this.dispose();
      },
    );

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
   * ALSO CANCELS THE AUTHORITATIVE OPERATION, which is what makes termination
   * honest: that side is awaiting a channel a dead worker will never answer, so
   * without this its handler would stay pending and its candidate slot would
   * never be freed.
   */
  public dispose(): void {
    /*
     * SETTLES A STILL-PENDING OPERATION, and that is not optional.
     *
     * Superseding a run — starting a second fill, or unmounting — used to
     * terminate the worker and drop the settlers, leaving the first operation's
     * promise pending forever. Nothing user-visible waited on it, but a promise
     * that can never settle is a retained object with a retained closure, and
     * "nobody happens to await it" is not a lifecycle guarantee. Settling is a
     * no-op when the promise has already resolved, which is why every other
     * path settles BEFORE calling this.
     */
    const abandoned = this.rejectCurrent;
    this.rejectCurrent = undefined;
    this.resolveCurrent = undefined;
    abandoned?.(new HoleFillCancelled());

    this.cancelAuthoritative?.();
    this.cancelAuthoritative = undefined;

    this.worker?.terminate();
    this.worker = undefined;
    this.channel?.port1.close();
    this.channel?.port2.close();
    this.channel = undefined;
    this.activeOperationId = undefined;
    this.cancelCurrent = undefined;
  }
}

/** The ceilings and the status taxonomy, re-exported so callers need not reach past the service. */
export { HOLE_FILL_MAX_BOUNDARY_VERTICES, HOLE_FILL_MAX_PART_FACES, HoleFillStatus };
