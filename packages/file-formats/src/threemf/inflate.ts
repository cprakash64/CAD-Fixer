/**
 * THE ONE RAW-DEFLATE INFLATER SHAPE, for every caller — Stage 6E-A2.
 *
 * The decompressor itself is a platform primitive (`DecompressionStream`), so it
 * is still INJECTED: this package compiles with `lib: ES2023` and must never
 * name it. What lives here is everything around it that used to be copied into
 * the import worker, the export worker and the test context — and that got one
 * thing wrong in all three.
 *
 * FEED THE INPUT IN SLICES. Each of those copies wrote the whole compressed
 * payload in ONE `write`. Chromium's `DecompressionStream` then inflates that
 * entire write into its readable queue without waiting for a reader — Stage
 * 6E-A1 measured 109 MiB queued from one write of a 109 MiB entry — so the
 * "chunked" inflater held the whole entry a second time, beside the
 * preallocated buffer `readZipEntry` was filling. Here a slice is written only
 * after the previous write has resolved, and a TransformStream resolves a write
 * only once its readable side has room, so the queue stays about one slice's
 * output ahead of the consumer.
 *
 * AN EXPLICIT ITERATOR, NOT AN `async function*`. Stage 6D-A4 measured an
 * async-generator hop between the decompressor and `readZipEntry` letting
 * inflated chunks queue beside the destination buffer. This object forwards
 * each `next()` straight to the stream reader and adds no buffering of its own.
 */

/** Compressed bytes written per `write` call. The single production default. */
export const INFLATE_INPUT_SLICE_BYTES = 65_536;

/** The slice of the platform's `DecompressionStream` this module uses. */
export interface DecompressorLike {
  readonly readable: {
    getReader(): {
      read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
      cancel(reason?: unknown): Promise<void>;
      releaseLock(): void;
    };
  };
  readonly writable: {
    getWriter(): {
      /** Always handed a fresh `ArrayBuffer`-backed copy; see the pump. */
      write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
      close(): Promise<void>;
      abort(reason?: unknown): Promise<void>;
      releaseLock(): void;
    };
  };
}

export type RawInflater = (compressed: Uint8Array) => AsyncIterable<Uint8Array>;

/**
 * A raw-DEFLATE inflater over `open()`, fed `sliceBytes` of input at a time.
 *
 * `open` must return a FRESH raw-deflate decompressor on every call — in the
 * browser, `() => new DecompressionStream('deflate-raw')`.
 */
export function createSlicedInflater(
  open: () => DecompressorLike,
  sliceBytes: number = INFLATE_INPUT_SLICE_BYTES,
): RawInflater {
  if (!Number.isSafeInteger(sliceBytes) || sliceBytes < 1) {
    throw new RangeError(
      `Inflater slice size must be a positive integer, not ${String(sliceBytes)}.`,
    );
  }
  return (compressed: Uint8Array): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> =>
      new SlicedInflation(open(), compressed, sliceBytes),
  });
}

class SlicedInflation implements AsyncIterator<Uint8Array> {
  private readonly reader: ReturnType<DecompressorLike['readable']['getReader']>;
  private readonly writer: ReturnType<DecompressorLike['writable']['getWriter']>;
  private finished = false;
  /** Why the pump stopped early, if it did. See the constructor. */
  private pumpFailure: Error | undefined = undefined;

  public constructor(stream: DecompressorLike, compressed: Uint8Array, sliceBytes: number) {
    this.reader = stream.readable.getReader();
    this.writer = stream.writable.getWriter();
    /*
     * THE PUMP. Each slice is COPIED into a fresh buffer: `compressed` is a view
     * of the transferred file, whose buffer may be a `SharedArrayBuffer`, and
     * `WritableStream.write` refuses one. A slice is at most `sliceBytes`.
     *
     * Its rejection is RECORDED, not thrown from here. A write rejects because
     * the stream errored — damaged data — or because `return()` cancelled it; in
     * the first case `read()` rejects with the stream's own error, which is
     * where the ZIP layer converts it into a typed refusal, and in the second
     * the consumer has already left. If the readable nevertheless ended cleanly
     * after the pump failed, `next()` rethrows the recorded failure rather than
     * reporting a short stream as complete.
     */
    const pump = async (): Promise<void> => {
      for (let at = 0; at < compressed.byteLength; at += sliceBytes) {
        await this.writer.write(
          compressed.slice(at, Math.min(at + sliceBytes, compressed.byteLength)),
        );
      }
      await this.writer.close();
    };
    pump().catch((error: unknown): void => {
      this.pumpFailure =
        error instanceof Error ? error : new Error('The decompressor input could not be written.');
    });
  }

  public async next(): Promise<IteratorResult<Uint8Array>> {
    if (this.finished) return { done: true, value: undefined };
    for (;;) {
      let step: { readonly done: boolean; readonly value?: Uint8Array | undefined };
      try {
        step = await this.reader.read();
      } catch (error) {
        await this.release();
        throw error;
      }
      if (step.done) {
        this.finished = true;
        this.unlock();
        if (this.pumpFailure !== undefined) throw this.pumpFailure;
        return { done: true, value: undefined };
      }
      // An empty chunk carries nothing; the ZIP layer's accounting assumes each
      // yielded chunk made progress, and a zero-length one would be polled for
      // cancellation for no benefit.
      if (step.value !== undefined && step.value.byteLength > 0) {
        return { done: false, value: step.value };
      }
    }
  }

  /** Early exit: cancel both sides so nothing keeps inflating. */
  public async return(): Promise<IteratorResult<Uint8Array>> {
    await this.release();
    return { done: true, value: undefined };
  }

  private async release(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    /*
     * Cancelling the readable errors the transform, which rejects any write the
     * pump has pending and so ends it; aborting the writer covers the case where
     * the pump is between writes. Both reject if the stream has already
     * errored — that is the state being cleaned up, not a new failure.
     */
    await Promise.allSettled([this.reader.cancel(), this.writer.abort()]);
    this.unlock();
  }

  /** Nothing holds either side's lock once this inflation is over. */
  private unlock(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }
}
