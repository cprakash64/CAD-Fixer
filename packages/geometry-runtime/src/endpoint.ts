import type { TransferHandle } from './protocol';

/**
 * The minimum surface the runtime needs from a message transport.
 *
 * The geometry runtime is written against this interface rather than against
 * `Worker` directly, for three reasons: the package compiles without the DOM
 * lib, the coordinator is unit-testable with a pair of in-memory endpoints, and
 * the transport can later become a `MessagePort`, a worker pool, or a
 * `SharedWorker` without touching protocol or coordination logic.
 *
 * The concrete `Worker`-backed adapter lives in the web application, which is
 * the only layer that should know the DOM exists.
 */
export interface MessageEndpoint {
  /**
   * Sends a message. Buffers named in `transfer` are MOVED: after this call
   * they are detached in the sending realm and reading them throws. Callers
   * must not retain a reference to transferred data.
   */
  postMessage(message: unknown, transfer: readonly TransferHandle[]): void;

  /** Subscribes to inbound messages. Returns an unsubscribe function. */
  addMessageListener(listener: (message: unknown) => void): () => void;

  /** Tears down the underlying transport, if it owns one. */
  close?(): void;
}
