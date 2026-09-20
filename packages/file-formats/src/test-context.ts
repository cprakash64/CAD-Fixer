import { uncancellable, type CancellationToken } from '@cadfixer/shared';
import { DEFAULT_IMPORT_BUDGET, type ImportBudget } from './budget';
import type { FormatReadContext, FormatProgressReporter, TextStreamDecoder } from './context';
import { createSlicedInflater, type RawInflater } from './threemf/inflate';

/**
 * A read context for tests, supplying the platform primitives the package
 * itself cannot name.
 *
 * `file-formats` compiles with `lib: ES2023` and no DOM or Node types, on
 * purpose — a codec that could reach for `TextDecoder` or
 * `DecompressionStream` directly would stop being testable under plain Node and
 * would drift towards a browser dependency. The production worker injects them;
 * so does this.
 *
 * TEST-ONLY. Not exported from the package index, and no production path
 * imports it.
 */

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * The PRODUCTION inflater shape (`createSlicedInflater`), over the platform's
 * `DecompressionStream`, at the production slice size.
 */
export const inflateRawForTests: RawInflater = createSlicedInflater(
  () => new DecompressionStream('deflate-raw'),
);

/** The same inflater at a chosen input slice size, to move chunk boundaries. */
export function inflateRawSlicedForTests(sliceBytes: number): RawInflater {
  return createSlicedInflater(() => new DecompressionStream('deflate-raw'), sliceBytes);
}

/**
 * The shape every inflater had BEFORE Stage 6E-A2: the whole compressed payload
 * in one write. Kept so a test can prove the buffered reader's output, refusals
 * and accounting did not change when production moved to sliced writes.
 */
export async function* inflateRawWholeWriteForTests(
  compressed: Uint8Array,
): AsyncIterable<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const payload = new Uint8Array(compressed.byteLength);
  payload.set(compressed);
  // A rejected write means the stream errored, which `read()` reports; it is
  // recorded so a stream that nevertheless ended cleanly is not called whole.
  let writeFailure: unknown = undefined;
  void writer
    .write(payload)
    .then(() => writer.close())
    .catch((error: unknown) => {
      writeFailure = error;
    });
  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) yield value;
    }
    if (writeFailure !== undefined) {
      throw writeFailure instanceof Error
        ? writeFailure
        : new Error('The decompressor input could not be written.');
    }
  } finally {
    // Settled, not awaited for success: cancelling an errored stream rejects
    // with the error `read()` already raised.
    await Promise.allSettled([reader.cancel()]);
  }
}

/** A fresh streaming UTF-8 decoder, as the production worker supplies one. */
export function createTextDecoderForTests(): TextStreamDecoder {
  return new TextDecoder('utf-8', { fatal: false });
}

export interface TestContextOptions {
  readonly cancellation?: CancellationToken;
  readonly budget?: ImportBudget;
  readonly progress?: FormatProgressReporter;
  readonly yieldToEventLoop?: () => Promise<void>;
  /** Omit to test a caller that forgot to supply a decompressor. */
  readonly withInflater?: boolean;
  /** Replaces the production-shaped inflater, e.g. to move chunk boundaries. */
  readonly inflateRaw?: RawInflater;
  /** Omit to test a streamed read whose caller forgot the decoder. */
  readonly withTextDecoder?: boolean;
}

export function testReadContext(options: TestContextOptions = {}): FormatReadContext {
  return {
    cancellation: options.cancellation ?? uncancellable,
    budget: options.budget ?? DEFAULT_IMPORT_BUDGET,
    progress: options.progress ?? { report: (): void => undefined },
    yieldToEventLoop: options.yieldToEventLoop ?? ((): Promise<void> => Promise.resolve()),
    decodeText: decodeUtf8,
    ...(options.withInflater === false
      ? {}
      : { inflateRaw: options.inflateRaw ?? inflateRawForTests }),
    ...(options.withTextDecoder === false ? {} : { createTextDecoder: createTextDecoderForTests }),
  };
}
