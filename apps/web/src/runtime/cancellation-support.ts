import { isSharedCancellationSupported } from '@cadfixer/shared';

/**
 * Whether this browsing context can run an INTERRUPTIBLE conservative repair.
 *
 * TWO CONDITIONS, AND BOTH ARE NECESSARY.
 *
 * `SharedArrayBuffer` must exist, because it is the only way to hand a worker a
 * flag it can read while it is inside a synchronous loop. And the document must
 * be CROSS-ORIGIN ISOLATED, because a browser may expose the constructor while
 * refusing to let the buffer cross a `postMessage` boundary — a context that
 * passes the first check and fails the second would let CAD Fixer offer a Cancel
 * control that throws when it is used, which is worse than not offering one.
 *
 * `crossOriginIsolated` is read defensively: it is absent in older engines and
 * in non-window contexts, and a missing property must read as NOT isolated
 * rather than as `undefined` quietly passing a truthiness test.
 *
 * Deliberately NOT cached. It is two property reads, it is called at render
 * time, and a cached answer is a lie waiting for the one context where the value
 * differs between calls.
 */
export function isInterruptibleRepairSupported(): boolean {
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  return isolated === true && isSharedCancellationSupported();
}
