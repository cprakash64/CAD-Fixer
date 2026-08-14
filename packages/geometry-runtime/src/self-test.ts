import { malformedFile } from '@cadfixer/shared';
import type { OperationHandler } from './worker-host';

/**
 * Runtime self-test operation.
 *
 * This is a DIAGNOSTIC, not a geometry operation and not a placeholder for one.
 * It exists to prove that the whole boundary actually works end to end in a real
 * browser: module worker startup, buffer transfer in both directions, chunked
 * progress reporting, and cooperative cancellation. Without it, the worker
 * architecture would be asserted rather than demonstrated.
 *
 * It computes a checksum over the transferred bytes, which is deterministic and
 * cheap and has nothing to do with meshes.
 */

export interface SelfTestHandlerOptions {
  /**
   * Yields to the host event loop so queued messages — notably `cancel` — can be
   * processed between chunks.
   *
   * Injected because a macrotask scheduler is a platform concern: this package
   * compiles without the DOM or WebWorker lib so it stays testable outside a
   * browser.
   */
  readonly yieldToEventLoop: () => Promise<void>;
}

const MAX_CHUNKS = 1024;

export function createSelfTestHandler(
  options: SelfTestHandlerOptions,
): OperationHandler<'runtime/self-test'> {
  return async (payload, context) => {
    // The payload arrives as structured-cloned data from another realm, so it is
    // validated rather than trusted, exactly as a future parser must do.
    const bytes = payload.bytes;
    if (!(bytes instanceof ArrayBuffer)) {
      throw malformedFile('Self-test payload did not contain a transferable ArrayBuffer.');
    }

    const chunks = Number.isInteger(payload.chunks) ? payload.chunks : 0;
    if (chunks < 1 || chunks > MAX_CHUNKS) {
      throw malformedFile('Self-test chunk count is out of range.', {
        chunks,
        maxChunks: MAX_CHUNKS,
      });
    }

    const view = new Uint8Array(bytes);
    const chunkSize = Math.ceil(view.length / chunks);
    let checksum = 0;

    for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
      context.throwIfCancelled();

      const start = chunkIndex * chunkSize;
      const end = Math.min(start + chunkSize, view.length);
      for (let offset = start; offset < end; offset += 1) {
        checksum = (checksum + (view[offset] ?? 0)) >>> 0;
      }

      context.reportProgress(
        (chunkIndex + 1) / chunks,
        `chunk ${String(chunkIndex + 1)}/${String(chunks)}`,
      );
      await options.yieldToEventLoop();
    }

    context.throwIfCancelled();

    return {
      value: { bytes, byteLength: view.length, checksum },
      // Move the buffer back rather than copying it. After this returns, the
      // worker's view is detached.
      transfer: [bytes],
    };
  };
}
