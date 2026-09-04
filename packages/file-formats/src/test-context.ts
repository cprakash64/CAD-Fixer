import { uncancellable, type CancellationToken } from '@cadfixer/shared';
import { DEFAULT_IMPORT_BUDGET, type ImportBudget } from './budget';
import type { FormatReadContext, FormatProgressReporter } from './context';

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

/** Chunked raw-DEFLATE inflation, matching the production worker's shape. */
export async function* inflateRawForTests(compressed: Uint8Array): AsyncIterable<Uint8Array> {
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
      if (value !== undefined) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export interface TestContextOptions {
  readonly cancellation?: CancellationToken;
  readonly budget?: ImportBudget;
  readonly progress?: FormatProgressReporter;
  readonly yieldToEventLoop?: () => Promise<void>;
  /** Omit to test a caller that forgot to supply a decompressor. */
  readonly withInflater?: boolean;
}

export function testReadContext(options: TestContextOptions = {}): FormatReadContext {
  return {
    cancellation: options.cancellation ?? uncancellable,
    budget: options.budget ?? DEFAULT_IMPORT_BUDGET,
    progress: options.progress ?? { report: (): void => undefined },
    yieldToEventLoop: options.yieldToEventLoop ?? ((): Promise<void> => Promise.resolve()),
    decodeText: decodeUtf8,
    ...(options.withInflater === false ? {} : { inflateRaw: inflateRawForTests }),
  };
}
