/// <reference lib="webworker" />
import {
  exportObjDocumentStream,
  DEFAULT_EXPORT_LIMITS,
  DEFAULT_IMPORT_BUDGET,
  OBJ_CHUNK_BYTES,
  type ExportMetadata,
  type ExportDocumentSnapshot,
} from '@cadfixer/file-formats';
import { uncancellable } from '@cadfixer/shared';

/** Browser adapters only. The format package owns serialization and mandatory
 * production-reader validation; the controller owns transaction commit/abort. */
export function exportObjToFile(
  snapshot: ExportDocumentSnapshot,
  writeChunk: (bytes: Uint8Array) => Promise<void>,
  progress: (fraction: number, note: string) => void,
  yieldToEventLoop: () => Promise<void>,
  chunkBytes = OBJ_CHUNK_BYTES,
): Promise<ExportMetadata> {
  const encoder = new TextEncoder();
  return exportObjDocumentStream({
    snapshot,
    chunkBytes,
    sink: { write: writeChunk },
    write: {
      cancellation: uncancellable,
      limits: DEFAULT_EXPORT_LIMITS,
      encodeText: (text) => encoder.encode(text),
      yieldToEventLoop,
      progress: {
        report: (fraction, note) => {
          progress(fraction, note ?? 'writing');
        },
      },
    },
    read: {
      cancellation: uncancellable,
      budget: DEFAULT_IMPORT_BUDGET,
      decodeText: (bytes) => new TextDecoder('utf-8', { fatal: false }).decode(bytes),
      createTextDecoder: () => new TextDecoder('utf-8', { fatal: false }),
      progress: { report: () => undefined },
      yieldToEventLoop,
    },
  });
}
