import { uncancellable, type CancellationToken } from '@cadfixer/shared';
import { decodeUtf8, inflateRawForTests } from '../test-context';
import { DEFAULT_IMPORT_BUDGET } from '../budget';
import type { FormatReadContext } from '../context';
import {
  DEFAULT_EXPORT_LIMITS,
  type ExportLimits,
  type ExportProgressReporter,
  type FormatWriteDocumentContext,
} from './export-contract';

/**
 * Write and read contexts for the export tests.
 *
 * TEST-ONLY, for the same reason `../test-context.ts` is: `file-formats`
 * compiles with `lib: ES2023` and no DOM or Node types, so the platform
 * primitives a writer needs — `TextEncoder`, `CompressionStream` — are injected
 * rather than imported. The production worker injects the same shapes.
 */

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Chunked raw DEFLATE, matching the production worker's shape. */
export async function* deflateRawForTests(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
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
      if (value !== undefined) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export interface WriteContextOptions {
  readonly cancellation?: CancellationToken;
  readonly limits?: ExportLimits;
  readonly progress?: ExportProgressReporter;
  readonly yieldToEventLoop?: () => Promise<void>;
  /** Omit to test a caller that forgot to supply a compressor. */
  readonly withDeflater?: boolean;
}

export function testWriteContext(options: WriteContextOptions = {}): FormatWriteDocumentContext {
  return {
    cancellation: options.cancellation ?? uncancellable,
    limits: options.limits ?? DEFAULT_EXPORT_LIMITS,
    progress: options.progress ?? { report: (): void => undefined },
    yieldToEventLoop: options.yieldToEventLoop ?? ((): Promise<void> => Promise.resolve()),
    encodeText: encodeUtf8,
  };
}

export function testWriteContextWithDeflate(
  options: WriteContextOptions = {},
): FormatWriteDocumentContext {
  return {
    ...testWriteContext(options),
    ...(options.withDeflater === false ? {} : { deflateRaw: deflateRawForTests }),
  };
}

/** The read context parse-back validation uses. Production limits, no leniency. */
export function testExportReadContext(): FormatReadContext {
  return {
    cancellation: uncancellable,
    budget: DEFAULT_IMPORT_BUDGET,
    progress: { report: (): void => undefined },
    yieldToEventLoop: (): Promise<void> => Promise.resolve(),
    decodeText: decodeUtf8,
    inflateRaw: inflateRawForTests,
  };
}
