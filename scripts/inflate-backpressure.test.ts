import { describe, expect, it } from 'vitest';
import {
  createSlicedInflater,
  INFLATE_INPUT_SLICE_BYTES,
  type DecompressorLike,
} from '../packages/file-formats/src/threemf/inflate';
import { readZipDirectory, type ZipEntry } from '../packages/file-formats/src/threemf/zip';
import { buildZip } from '../packages/file-formats/src/threemf/zip-fixtures';

/**
 * STAGE 6E-A2, FINDING R3 — BACKPRESSURE, MEASURED ON A REAL DECOMPRESSOR.
 *
 * Every inflater CAD Fixer shipped wrote the whole compressed payload in one
 * `write`, and a `DecompressionStream` inflates an entire write into its queue
 * without waiting for a reader. `createSlicedInflater` writes bounded slices,
 * each only after the previous one resolved. This test pauses the consumer,
 * stops the input, and counts the output that had ALREADY been produced ahead
 * of it — the queue — for both shapes.
 *
 * In `scripts/` because it needs timers, which `@cadfixer/file-formats`'s
 * ES2023 lib deliberately does not declare.
 */

function entryOf(archive: Uint8Array, name: string): ZipEntry {
  const entry = readZipDirectory(archive).find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no ${name}`);
  return entry;
}

function dataStart(archive: Uint8Array, entry: ZipEntry): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  return (
    entry.localOffset +
    30 +
    view.getUint16(entry.localOffset + 26, true) +
    view.getUint16(entry.localOffset + 28, true)
  );
}

describe('R3: the production inflater keeps the decompressor queue bounded', () => {
  it('keeps the decompressor queue bounded while the consumer is paused', async () => {
    // A real `DecompressionStream`. Pause after the first chunk, then stop
    // feeding input and count what the decompressor had ALREADY produced: that
    // is the output queued ahead of the consumer.
    // Varied numbers, so the entry deflates like a real model part (~7:1)
    // rather than tripping the directory's ratio ceiling.
    let seed = 0x6e2;
    const vertices: string[] = [];
    for (let n = 0; n < 400_000; n += 1) {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      vertices.push(`<v x="${String(seed % 9973)}" y="${String((seed >>> 7) % 9967)}" z="1"/>`);
    }
    const content = new TextEncoder().encode(vertices.join(''));
    const archive = await buildZip([{ name: 'a', content, method: 8 }]);
    const entry = entryOf(archive, 'a');
    const start = dataStart(archive, entry);
    const compressed = archive.slice(start, start + entry.compressedSize);

    const queued = async (sliceBytes: number): Promise<number> => {
      let gate = false;
      let release: () => void = () => undefined;
      const gated = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = (): DecompressorLike => {
        const real = new DecompressionStream('deflate-raw');
        const writer = real.writable.getWriter();
        return {
          readable: real.readable,
          writable: {
            getWriter: (): ReturnType<DecompressorLike['writable']['getWriter']> => ({
              write: async (chunk: Uint8Array<ArrayBuffer>): Promise<void> => {
                if (gate) await gated;
                await writer.write(chunk);
              },
              close: (): Promise<void> => writer.close(),
              abort: (reason?: unknown): Promise<void> => writer.abort(reason),
              releaseLock: (): void => {
                writer.releaseLock();
              },
            }),
          },
        };
      };
      const iterator = createSlicedInflater(open, sliceBytes)(compressed)[Symbol.asyncIterator]();
      await iterator.next();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      gate = true;
      let bytes = 0;
      for (;;) {
        const step = await Promise.race([
          iterator.next(),
          new Promise<'idle'>((resolve) => {
            setTimeout(() => {
              resolve('idle');
            }, 100);
          }),
        ]);
        if (step === 'idle' || step.done === true) break;
        bytes += step.value.byteLength;
      }
      release();
      await iterator.return?.();
      return bytes;
    };

    const oneWrite = await queued(compressed.byteLength);
    const sliced = await queued(INFLATE_INPUT_SLICE_BYTES);
    // One write of the whole payload queues the whole entry behind the reader.
    expect(oneWrite).toBeGreaterThan(content.byteLength * 0.9);
    // Slices queue a few slices' worth of output at most.
    expect(sliced).toBeLessThan(content.byteLength / 10);
  });
});
