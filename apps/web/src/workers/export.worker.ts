/// <reference lib="webworker" />

import {
  DEFAULT_EXPORT_LIMITS,
  DEFAULT_IMPORT_BUDGET,
  exportDocument,
  exportRefusalOf,
  MeshFormatId,
} from '@cadfixer/file-formats';
import { toAppError, uncancellable } from '@cadfixer/shared';
import type {
  ExportPortMessage,
  ExportSnapshotMessage,
  ExportWorkerOutbound,
} from './export-protocol';

/**
 * THE DISPOSABLE EXPORT WORKER.
 *
 * WHY DISPOSABLE. Serialising fifty megabytes of OBJ, compressing a 3MF and
 * reading the result back are long, allocating passes, and the honest way to
 * cancel them is to stop the thread. `terminate()` from the controller does
 * that wherever the work happens to be — including inside `CompressionStream`,
 * which polls no flag of ours. The writers also yield and poll a token, which
 * gives a clean stop where one is possible; the terminate is what makes Cancel
 * true in every case rather than most of them.
 *
 * WHAT IT NEVER TOUCHES. The authoritative geometry worker is a different
 * worker and is never terminated. This one receives a DISPOSABLE SNAPSHOT
 * directly from it over a `MessageChannel`, so killing this thread can take
 * nothing authoritative with it — and the page never holds a coordinate.
 */

const TARGETS: Readonly<Record<string, MeshFormatId>> = {
  obj: MeshFormatId.Obj,
  '3mf': MeshFormatId.ThreeMf,
};

function post(message: ExportWorkerOutbound, transfer?: Transferable[]): void {
  if (transfer === undefined) self.postMessage(message);
  else self.postMessage(message, transfer);
}

/**
 * A macrotask yield.
 *
 * `MessageChannel` rather than `setTimeout`, which browsers clamp to about four
 * milliseconds once nested — a serialiser yielding every 32,768 triangles would
 * spend most of its life in the clamp.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (): void => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

const encoder = new TextEncoder();

function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Chunked raw DEFLATE. Chunked so the ZIP writer can bound what it retains. */
async function* deflateRaw(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  /*
   * COPIED INTO A PLAIN `ArrayBuffer` VIEW, for the same reason the reader's
   * inflater copies: a subarray of a transferred buffer is typed
   * `ArrayBufferLike`, which may be a `SharedArrayBuffer`, and
   * `WritableStream.write` will not accept one.
   */
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  void writer
    .write(payload)
    .then(() => writer.close())
    .catch(() => undefined);

  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Raw inflate, for reading our own output back during validation. */
async function* inflateRaw(compressed: Uint8Array): AsyncIterable<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const payload = new Uint8Array(compressed.byteLength);
  payload.set(compressed);
  void writer
    .write(payload)
    .then(() => writer.close())
    .catch(() => undefined);

  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const decoder = new TextDecoder('utf-8', { fatal: false });

async function run(message: ExportSnapshotMessage): Promise<void> {
  const target = TARGETS[message.target];
  if (target === undefined) {
    post({
      kind: 'failed',
      operationId: message.operationId,
      code: 'INVALID_STATE',
      reason: 'EXPORT_UNSUPPORTED_TARGET',
      message: 'CAD Fixer cannot write that format.',
    });
    return;
  }

  try {
    const written = await exportDocument({
      snapshot: message.snapshot,
      target,
      write: {
        /*
         * COOPERATIVE CANCELLATION IS NOT WIRED HERE, and that is deliberate.
         * The controller cancels by terminating this worker, which is the only
         * boundary that also stops a platform primitive mid-stream. Passing a
         * token that nothing can ever set would be a flag pretending to be a
         * feature; the writers' own yields still keep this thread responsive to
         * the termination.
         */
        cancellation: uncancellable,
        limits: DEFAULT_EXPORT_LIMITS,
        progress: {
          report: (fraction, note) => {
            post({
              kind: 'progress',
              operationId: message.operationId,
              fraction,
              ...(note === undefined ? {} : { note }),
            });
          },
        },
        yieldToEventLoop,
        encodeText,
        deflateRaw,
      },
      read: {
        cancellation: uncancellable,
        budget: DEFAULT_IMPORT_BUDGET,
        progress: { report: (): void => undefined },
        yieldToEventLoop,
        decodeText: (bytes) => decoder.decode(bytes),
        inflateRaw,
      },
    });

    /*
     * TRANSFERRED, and safe to transfer: these bytes are the artifact and this
     * worker is about to be discarded. Copying them would double the peak at
     * the exact moment it is highest.
     */
    const buffer = written.bytes.buffer;
    post(
      {
        kind: 'written',
        operationId: message.operationId,
        documentId: message.snapshot.documentId,
        documentRevision: message.snapshot.revision,
        bytes: buffer,
        metadata: written.metadata,
      },
      [buffer],
    );
  } catch (cause) {
    const error = toAppError(cause);
    post({
      kind: 'failed',
      operationId: message.operationId,
      code: error.code,
      reason: exportRefusalOf(error),
      message: error.message,
    });
  }
}

self.onmessage = (event: MessageEvent<ExportPortMessage>): void => {
  const message = event.data;

  message.port.onmessage = (snapshotEvent: MessageEvent<ExportSnapshotMessage>): void => {
    void run(snapshotEvent.data);
  };
  message.port.start();
  post({ kind: 'ready' });
};
