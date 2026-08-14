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
export function toTransferables(handles: readonly TransferHandle[]): ArrayBuffer[] {
  const transferables: ArrayBuffer[] = [];
  for (const handle of handles) {
    if (!(handle instanceof ArrayBuffer)) {
      throw internalError(
        'Only ArrayBuffer values may be transferred through the geometry protocol.',
      );
    }
    transferables.push(handle);
  }
  return transferables;
}
