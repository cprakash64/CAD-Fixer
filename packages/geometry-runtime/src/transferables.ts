import { internalError } from '@cadfixer/shared';
import type { TransferHandle } from './protocol';

/**
 * Narrows protocol transfer handles to buffers that may legally be moved
 * through `postMessage`.
 *
 * `SharedArrayBuffer` is structurally similar but must never appear in a
 * transfer list: it is shared between realms, not moved, and passing one throws
 * a `DataCloneError` at runtime. Rejecting it here turns that into an explicit,
 * attributable failure instead of an opaque browser error.
 *
 * Returns `ArrayBuffer[]`, which is assignable to `Transferable[]` under both
 * the DOM and WebWorker lib definitions, so the same helper serves the main
 * thread and the worker.
 */
export function toTransferables(handles: readonly TransferHandle[]): TransferHandle[] {
  const transferables: TransferHandle[] = [];
  for (const handle of handles) {
    if (handle instanceof ArrayBuffer) {
      transferables.push(handle);
      continue;
    }
    /*
     * PORTS ARE THE OTHER LEGITIMATE TRANSFERABLE, and the only one added since
     * Stage 0. The self-intersection diagnostic hands one end of a
     * MessageChannel to the authoritative worker so geometry can travel
     * worker-to-worker without passing through the page; a port that was cloned
     * instead of moved would simply not be connected to anything.
     *
     * Recognised structurally rather than by `instanceof MessagePort`, because
     * this module compiles without the DOM lib. `SharedArrayBuffer` still falls
     * through to the rejection below: it has no `close`, and transferring one
     * throws at runtime.
     */
    if ('postMessage' in handle && 'close' in handle) {
      transferables.push(handle);
      continue;
    }
    throw internalError(
      'Only ArrayBuffer values and message ports may be transferred through the geometry protocol.',
    );
  }
  return transferables;
}
