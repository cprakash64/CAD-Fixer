import { operationCancelled } from './errors';

/**
 * Minimal cooperative cancellation primitive.
 *
 * Why not `AbortSignal`? Cancellation in CAD Fixer always has to cross a
 * `postMessage` boundary, and an `AbortSignal` cannot be transferred to a
 * worker. The authoritative cancel path is therefore a protocol message (see
 * `@cadfixer/geometry-runtime`), and this token is the local half that a
 * long-running handler polls. Keeping our own primitive also lets the geometry
 * packages compile without the DOM lib, which keeps them unit-testable outside
 * a browser environment.
 *
 * Cancellation is cooperative: a handler that never polls cannot be interrupted.
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
