import { internalError, operationCancelled } from './errors';

/**
 * Cooperative cancellation primitives.
 *
 * TWO MECHANISMS, AND THE DIFFERENCE MATTERS.
 *
 * `CancellationSource` below is the MESSAGE-BASED half. Its flag is flipped by a
 * protocol `cancel` message, which means the flag can only change when the
 * worker returns to its event loop. That is fine for a handler built from
 * `await`ed phases; it is NOT cancellation for a handler that runs one long
 * synchronous pass, because the message sits unread in the queue and a polled
 * flag that cannot change is not a poll.
 *
 * `SharedCancellationSource` is the SHARED-MEMORY half, added in Stage 3B-1C for
 * exactly that case. It writes a single `Int32` in a `SharedArrayBuffer` with
 * `Atomics.store`, so the worker observes the change from inside its own
 * synchronous loops without the event loop being involved at all.
 *
 * Both expose the same `CancellationToken`, so every existing polling site keeps
 * working unchanged — and becomes genuinely interruptible the moment a shared
 * signal is what it is polling.
 *
 * Why not `AbortSignal`? It cannot be transferred to a worker, and it has the
 * same event-loop limitation as the message path. Keeping our own primitive also
 * lets the geometry packages compile without the DOM lib, which keeps them
 * unit-testable outside a browser environment.
 *
 * Cancellation remains cooperative in the sense that a handler which never polls
 * cannot be interrupted. What changed is that polling now works.
 */

export interface CancellationToken {
  readonly isCancelled: boolean;
  /** Registers `listener`, returning an unsubscribe function. Fires at most once. */
  onCancelled(listener: () => void): () => void;
}

/**
 * Owns the cancelled state. Handed to the party that may cancel; only the
 * derived `token` is handed to the party that observes cancellation.
 */
export class CancellationSource {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();
  public readonly token: CancellationToken;

  public constructor() {
    const readCancelled = (): boolean => this.cancelled;
    const subscribe = (listener: () => void): (() => void) => this.addListener(listener);

    this.token = {
      get isCancelled(): boolean {
        return readCancelled();
      },
      onCancelled: subscribe,
    };
  }

  public get isCancelled(): boolean {
    return this.cancelled;
  }

  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const pending = [...this.listeners];
    this.listeners.clear();
    for (const listener of pending) listener();
  }

  private addListener(listener: () => void): () => void {
    if (this.cancelled) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * Throws `OPERATION_CANCELLED` if cancellation has been requested.
 *
 * The polling half of cooperative cancellation. Long-running loops call this
 * periodically — per batch rather than per element, so the check does not
 * dominate the work it guards.
 */
export function throwIfCancelled(token: CancellationToken): void {
  if (token.isCancelled) throw operationCancelled();
}

/** A token that is never cancelled, for callers that do not support cancellation. */
export const uncancellable: CancellationToken = {
  isCancelled: false,
  onCancelled: () => () => undefined,
};

/* ------------------------------------------------- shared-memory signal -- */

/**
 * The control word's two states.
 *
 * Deliberately two and not more. A richer state machine — requested, observed,
 * acknowledged — would put protocol in a location where the only correctness
 * requirement is that one bit becomes visible to another thread as fast as the
 * hardware allows. Acknowledgement is a protocol message, where it belongs, and
 * where it can carry a reason.
 */
export const CancelState = {
  Active: 0,
  Cancelled: 1,
} as const;

export type CancelState = (typeof CancelState)[keyof typeof CancelState];

/** The single `Int32` slot the flag occupies. Named so no call site indexes raw. */
export const CANCEL_SIGNAL_INDEX = 0;

/** Bytes one cancellation signal costs. One `Int32`, and nothing else. */
export const SHARED_CANCELLATION_BYTES = 4;

/**
 * Whether this environment can provide a genuinely interruptible signal.
 *
 * `SharedArrayBuffer` requires cross-origin isolation. CAD Fixer's deployment
 * already mandates COOP/COEP (docs/DEPLOYMENT_REQUIREMENTS.md), so this being
 * false is a deployment fault rather than a supported configuration — and the
 * application says so rather than silently degrading to a Cancel button that
 * cannot cancel.
 */
export function isSharedCancellationSupported(): boolean {
  return typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object';
}

/**
 * Owns a cancellation flag in shared memory.
 *
 * THE POINT OF THIS CLASS: `cancel()` is visible to another thread IMMEDIATELY,
 * including while that thread is inside a synchronous loop. It does not depend
 * on a message being delivered, dequeued or handled.
 *
 * Held by the party that may cancel. The party that observes cancellation gets
 * `buffer` (to send across the boundary) or `token` (to poll locally).
 */
export class SharedCancellationSource {
  public readonly buffer: SharedArrayBuffer;
  public readonly token: CancellationToken;
  private readonly view: Int32Array;
  private readonly listeners = new Set<() => void>();

  public constructor() {
    if (!isSharedCancellationSupported()) {
      throw internalError(
        'This browser context cannot create a shared cancellation signal. Cross-origin isolation is required.',
      );
    }
    this.buffer = new SharedArrayBuffer(SHARED_CANCELLATION_BYTES);
    this.view = new Int32Array(this.buffer);
    this.token = readSignal(this.view, (listener) => this.addListener(listener));
  }

  public get isCancelled(): boolean {
    return Atomics.load(this.view, CANCEL_SIGNAL_INDEX) === CancelState.Cancelled;
  }

  /**
   * Flips the flag. Idempotent.
   *
   * `Atomics.store` rather than a plain write: a plain write is not guaranteed
   * to be visible to another agent, and "usually visible" is not a cancellation
   * guarantee.
   */
  public cancel(): void {
    Atomics.store(this.view, CANCEL_SIGNAL_INDEX, CancelState.Cancelled);
    const pending = [...this.listeners];
    this.listeners.clear();
    for (const listener of pending) listener();
  }

  private addListener(listener: () => void): () => void {
    if (this.isCancelled) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * Builds an observing token over a shared buffer received from another thread.
 *
 * `onCancelled` CANNOT fire on the observing side: nothing notifies a thread
 * that a shared word changed, short of `Atomics.wait`, which would block the
 * very loop that is supposed to keep running. Observers poll `isCancelled`; the
 * listener registry exists for the message path, which does deliver an event.
 * Documented rather than silently returning a listener that never fires.
 */
export function adoptSharedCancellation(buffer: SharedArrayBuffer): CancellationToken {
  const view = new Int32Array(buffer);
  return readSignal(view, () => () => undefined);
}

function readSignal(
  view: Int32Array,
  subscribe: (listener: () => void) => () => void,
): CancellationToken {
  return {
    get isCancelled(): boolean {
      return Atomics.load(view, CANCEL_SIGNAL_INDEX) === CancelState.Cancelled;
    },
    onCancelled: subscribe,
  };
}

/**
 * A token that is cancelled when EITHER input is.
 *
 * The worker holds both halves: the shared signal, which interrupts synchronous
 * work, and the message-based source, which still arrives and still carries the
 * lifecycle bookkeeping. Neither replaces the other, and a handler should not
 * have to know which one fired.
 */
export function combineCancellation(
  first: CancellationToken,
  second: CancellationToken,
): CancellationToken {
  return {
    get isCancelled(): boolean {
      return first.isCancelled || second.isCancelled;
    },
    onCancelled(listener: () => void): () => void {
      const offFirst = first.onCancelled(listener);
      const offSecond = second.onCancelled(listener);
      return () => {
        offFirst();
        offSecond();
      };
    },
  };
}
