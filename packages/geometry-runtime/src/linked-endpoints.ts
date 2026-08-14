import type { MessageEndpoint } from './endpoint';

/**
 * A pair of endpoints wired directly to each other in one realm.
 *
 * Used to exercise the coordinator and worker host without a browser. Messages
 * are delivered asynchronously via microtask so ordering resembles a real port.
 *
 * IMPORTANT LIMITATION: this does NOT emulate structured clone and does NOT
 * detach transferred buffers — both sides see the same object references. Tests
 * built on it therefore prove protocol and coordination logic, not transfer
 * semantics. Real transfer and detachment are covered by the end-to-end test
 * that runs against an actual module worker.
 */
export function createLinkedEndpoints(): readonly [MessageEndpoint, MessageEndpoint] {
  const listenersA = new Set<(message: unknown) => void>();
  const listenersB = new Set<(message: unknown) => void>();

  const makeEndpoint = (
    own: Set<(message: unknown) => void>,
    peer: Set<(message: unknown) => void>,
  ): MessageEndpoint => ({
    postMessage(message: unknown): void {
      void Promise.resolve().then(() => {
        for (const listener of [...peer]) listener(message);
      });
    },
    addMessageListener(listener: (message: unknown) => void): () => void {
      own.add(listener);
      return () => {
        own.delete(listener);
      };
    },
    close(): void {
      own.clear();
    },
  });

  return [makeEndpoint(listenersA, listenersB), makeEndpoint(listenersB, listenersA)] as const;
}
