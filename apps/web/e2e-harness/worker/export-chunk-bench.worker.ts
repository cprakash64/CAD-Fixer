/// <reference lib="webworker" />
import { exportObjToFile } from '../../src/workers/obj-file-export';
import { transferableExportChunk } from '../../src/workers/export-chunk';
import { exportRefusalOf } from '@cadfixer/file-formats';
import { toAppError } from '@cadfixer/shared';
import type { ExportPortMessage, ExportSnapshotMessage } from '../../src/workers/export-protocol';

let size = 256 * 1024;
let acknowledge: (() => void) | undefined;
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (): void => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
async function run(message: ExportSnapshotMessage): Promise<void> {
  try {
    const metadata = await exportObjToFile(
      message.snapshot,
      (bytes) =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
          const buffer = transferableExportChunk(bytes);
          self.postMessage({ kind: 'chunk', operationId: message.operationId, bytes: buffer }, [
            buffer,
          ]);
        }),
      (fraction, note) => {
        self.postMessage({ kind: 'progress', operationId: message.operationId, fraction, note });
      },
      yieldToEventLoop,
      size,
    );
    self.postMessage({
      kind: 'file-ready',
      operationId: message.operationId,
      documentId: message.snapshot.documentId,
      documentRevision: message.snapshot.revision,
      metadata,
    });
  } catch (cause) {
    const error = toAppError(cause);
    self.postMessage({
      kind: 'failed',
      operationId: message.operationId,
      code: error.code,
      reason: exportRefusalOf(error),
      message: error.message,
    });
  }
}
self.onmessage = (
  event: MessageEvent<
    ExportPortMessage | { kind: 'chunk-size'; value: number } | { kind: 'chunk-ack' }
  >,
): void => {
  const message = event.data;
  if (message.kind === 'chunk-size') {
    size = message.value;
    return;
  }
  if (message.kind === 'chunk-ack') {
    const resolve = acknowledge;
    acknowledge = undefined;
    resolve?.();
    return;
  }
  message.port.onmessage = (event: MessageEvent<ExportSnapshotMessage>): void => {
    void run(event.data);
  };
  message.port.start();
  self.postMessage({ kind: 'ready' });
};
