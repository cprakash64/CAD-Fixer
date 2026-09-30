import { isAppError } from '@cadfixer/shared';
import type { FormatReadContext } from '../context';
import type {
  ExportDocumentSnapshot,
  ExportMetadata,
  FormatWriteDocumentContext,
} from './export-contract';
import { ExportRefusal, exportInternal, exportRefusalOf } from './export-errors';
import { serializeObjDocument } from './obj-writer';
import { validateObjRecordStream } from './obj-stream-validation';
import { createBoundedChannel } from './stream-channel';
import { createChunkTextWriter, OBJ_CHUNK_BYTES, type ExportSink } from './stream-sink';
import { assertExportSnapshot } from './validate';

export interface ExportObjStreamOptions {
  readonly snapshot: ExportDocumentSnapshot;
  readonly write: FormatWriteDocumentContext;
  readonly read: FormatReadContext;
  readonly sink: Pick<ExportSink, 'write'>;
  readonly chunkBytes?: number;
}
/** The same export transaction as buffered exportDocument: production parsing
 * and source-semantic comparison are mandatory. Storage may commit only after
 * this returns. The reader consumes every encoded byte before delivery; its
 * final EOF checks must succeed before a destination is closed. */
export async function exportObjDocumentStream(
  options: ExportObjStreamOptions,
): Promise<ExportMetadata> {
  const { snapshot, write, read, sink, chunkBytes = OBJ_CHUNK_BYTES } = options;
  assertExportSnapshot(snapshot);
  if (read.createTextDecoder === undefined)
    throw exportInternal(
      ExportRefusal.ValidationUnreadable,
      'Streaming OBJ validation requires a fresh UTF-8 decoder.',
    );
  const decoder = read.createTextDecoder();
  const records = createBoundedChannel<string>();
  const validation = validateObjRecordStream(snapshot, records, read).catch((cause: unknown) => {
    if (
      isAppError(cause) &&
      (cause.code === 'OPERATION_CANCELLED' ||
        exportRefusalOf(cause) === ExportRefusal.ValidationFailed)
    )
      throw cause;
    throw exportInternal(
      ExportRefusal.ValidationUnreadable,
      'Pybrix wrote bytes its production reader could not read, so the export was refused.',
      { cause: isAppError(cause) ? cause.code : 'unknown' },
    );
  });
  // Reader failure wakes a producer blocked on record consumption immediately.
  void validation.catch((cause: unknown) => {
    records.fail(cause);
  });
  const writer = createChunkTextWriter(
    {
      write: async (bytes) => {
        await records.send(decoder.decode(bytes, { stream: true }));
        await sink.write(bytes);
      },
    },
    write.encodeText,
    write.limits.maxOutputBytes,
    write.cancellation,
    chunkBytes,
  );
  try {
    const metadata = await serializeObjDocument(
      snapshot,
      {
        ...write,
        progress: {
          report: (fraction) => {
            write.progress.report(fraction * 0.94, 'writing');
          },
        },
      },
      writer,
    );
    await writer.finish();
    const tail = decoder.decode();
    if (tail.length > 0) await records.send(tail);
    write.progress.report(0.95, 'validating');
    records.end();
    await validation;
    write.progress.report(0.99, 'saving');
    return { ...metadata, outputBytes: writer.byteLength };
  } catch (cause) {
    records.fail(cause);
    await validation.catch(() => undefined);
    throw cause;
  }
}
