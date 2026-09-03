import type { CancellationToken } from '@cadfixer/shared';

/**
 * Cancellation polling for the repair engine's synchronous loops.
 *
 * WHY A BATCH INTERVAL AND NOT A CHECK PER ELEMENT. Reading the shared control
 * word costs an `Atomics.load`, which is cheap but not free, and the loops it
 * guards do a handful of integer operations per element. Polling every element
 * would make the guard a measurable fraction of the work it protects. Polling
 * only between phases — which is what the engine did before Stage 3B-1C — makes
 * cancellation latency the length of a whole phase, which on a large model is
 * seconds.
 *
 * THE SHAPE THAT SOLVES BOTH: a bitmask test on the loop counter, which the JIT
 * compiles to an `and` plus a branch, guarding an `Atomics.load` that therefore
 * executes once per `CANCEL_POLL_INTERVAL` elements.
 *
 *     if ((i & CANCEL_POLL_MASK) === 0 && token.isCancelled) throw new RepairCancelled();
 *
 * INTERVAL CHOICE. 32,768 elements. At the engine's measured throughput this
 * bounds cancellation latency to well under a frame on the loops it guards,
 * while the atomic read happens roughly 30 times per million elements — far
 * below measurement noise. It is a power of two so the mask is exact, and it is
 * NOT configurable: a cancellation guarantee that a caller can widen is not a
 * guarantee, and there is no user-meaningful reason to tune it.
 */

export const CANCEL_POLL_INTERVAL = 32_768;

/** `CANCEL_POLL_INTERVAL - 1`. Exact only because the interval is a power of two. */
export const CANCEL_POLL_MASK = CANCEL_POLL_INTERVAL - 1;

/**
 * Thrown when a poll observes cancellation.
 *
 * A distinct class rather than the shared `OPERATION_CANCELLED` error because
 * the engine is platform-free and must not depend on how a host reports things;
 * the worker handler converts it at the boundary. Cancellation is never an
 * internal failure, and keeping it a separate type is what stops it being
 * reported as one.
 */
export class RepairCancelled extends Error {
  public constructor() {
    super('Repair was cancelled.');
    this.name = 'RepairCancelled';
  }
}

/**
 * Polls at a bounded interval. Returns nothing; throws `RepairCancelled`.
 *
 * Call with the loop counter. The mask test is inlined by the caller in the
 * hottest loops; this helper exists for loops where clarity matters more than
 * the last few nanoseconds, and for loops whose counter is not a simple index.
 */
export function pollCancellation(token: CancellationToken, index: number): void {
  if ((index & CANCEL_POLL_MASK) === 0 && token.isCancelled) throw new RepairCancelled();
}
