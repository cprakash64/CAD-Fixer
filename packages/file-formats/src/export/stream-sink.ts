import { throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import { ExportRefusal, exportTooLarge } from './export-errors';

/** Storage owns bytes after write resolves. One write at a time, including close/abort. */
export interface ExportSink<Result = void> {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<Result>;
  abort(reason?: unknown): Promise<void>;
}

export const OBJ_CHUNK_BYTES = 256 * 1024;
export interface ChunkTextWriter {
  /** Returns a promise only when a bounded batch needs draining. Await it before writing again. */
  write(text: string): void | Promise<void>;
  readonly byteLength: number;
  finish(): Promise<void>;
}

/** Bounds both text and encoded bytes. Never retains previous output chunks. */
export function createChunkTextWriter(
  sink: Pick<ExportSink, 'write'>,
  encode: (text: string) => Uint8Array,
  maxBytes: number,
  cancellation: CancellationToken,
  chunkBytes = OBJ_CHUNK_BYTES,
): ChunkTextWriter {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 4)
    throw new RangeError('Invalid chunk size');
  // UTF-16 text is bounded to C code units; encoding needs at most 3C bytes.
  // Byte delivery is sliced to C. Whole records preserve surrogate pairs.
  const characters = chunkBytes;
  let pending = '';
  let produced = 0;
  let busy = false;
  let finished = false;
  const drain = async (text: string): Promise<void> => {
    busy = true;
    try {
      const bytes = encode(text);
      const encodedLength = bytes.byteLength;
      if (produced + encodedLength > maxBytes)
        throw exportTooLarge(
          ExportRefusal.OutputTooLarge,
          'This export would produce a larger file than Pybrix will write.',
          { produced: produced + encodedLength, limit: maxBytes },
        );
      for (let at = 0; at < encodedLength; at += chunkBytes) {
        throwIfCancelled(cancellation);
        await sink.write(bytes.subarray(at, at + chunkBytes));
        throwIfCancelled(cancellation);
      }
      produced += encodedLength;
    } finally {
      busy = false;
    }
  };
  return {
    write(text): void | Promise<void> {
      if (busy || finished) throw new Error('The chunk writer must be drained before reuse');
      // OBJ records are bounded by names and three numeric values. Reject an
      // accidentally whole-file caller rather than encode an unbounded string.
      if (text.length > chunkBytes) throw new RangeError('Record exceeds chunk bound');
      if (pending.length + text.length > characters) {
        const previous = pending;
        pending = text;
        return drain(previous);
      }
      pending += text;
    },
    get byteLength(): number {
      return produced + encode(pending).byteLength;
    },
    async finish(): Promise<void> {
      if (busy || finished) throw new Error('The chunk writer must be drained before finish');
      finished = true;
      const text = pending;
      pending = '';
      await drain(text);
    },
  };
}
