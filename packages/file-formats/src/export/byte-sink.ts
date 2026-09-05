import { exportTooLarge, type ExportRefusal } from './export-errors';

/**
 * A BOUNDED, NON-QUADRATIC TEXT SINK.
 *
 * `output += line` over a hundred megabytes is the naive shape, and on a rope
 * implementation it is fine right up until something forces a flatten — at
 * which point the cost is the whole string again, repeatedly. Worse, it makes
 * the peak the FINISHED artifact plus whatever intermediate the engine chose,
 * with no way to observe either.
 *
 * This accumulates into a small text buffer, encodes it to UTF-8 when it fills,
 * and keeps the encoded chunks. Peak is therefore the finished bytes plus one
 * buffer, the total is counted as it goes, and the ceiling is checked BEFORE a
 * chunk is retained rather than after the artifact exists.
 */

/** Flushed at roughly this many characters. Small enough to stay in cache. */
const FLUSH_AT = 64 * 1024;

export interface ByteSink {
  write(text: string): void;
  /** Encoded bytes written so far, including anything still buffered. */
  readonly byteLength: number;
  /** Concatenates and returns the artifact. The sink must not be used after. */
  finish(): Uint8Array;
}

export function createByteSink(
  encodeText: (text: string) => Uint8Array,
  maxBytes: number,
  reason: ExportRefusal,
): ByteSink {
  const chunks: Uint8Array[] = [];
  let pending = '';
  let produced = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    const encoded = encodeText(pending);
    pending = '';

    /*
     * CHECKED BEFORE THE CHUNK IS KEPT. Accounting first and refusing afterwards
     * would hold the offending chunk for as long as it took to throw, and would
     * make the real peak one buffer larger than the ceiling claims.
     */
    if (produced + encoded.byteLength > maxBytes) {
      throw exportTooLarge(
        reason,
        'This export would produce a larger file than CAD Fixer will write.',
        { produced: produced + encoded.byteLength, limit: maxBytes },
      );
    }
    produced += encoded.byteLength;
    chunks.push(encoded);
  };

  return {
    write(text: string): void {
      pending += text;
      if (pending.length >= FLUSH_AT) flush();
    },
    get byteLength(): number {
      return produced + pending.length;
    },
    finish(): Uint8Array {
      flush();
      const out = new Uint8Array(produced);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
      }
      // Released so the finished array is the only copy held.
      chunks.length = 0;
      return out;
    },
  };
}
