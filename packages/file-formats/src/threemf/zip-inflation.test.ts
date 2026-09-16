import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import { ImportRefusal, refusalOf } from '../import-errors';
import { inflateRawForTests } from '../test-context';
import { buildZip } from './zip-fixtures';
import {
  createInflationBudget,
  DEFAULT_ZIP_LIMITS,
  readZipDirectory,
  readZipEntry,
  type InflationBudget,
  type ZipEntry,
  type ZipLimits,
} from './zip';

/**
 * ZIP-B1-T01 – T10 — THE SINGLE-DESTINATION INFLATION PATH (Stage 6D-B1).
 *
 * `readZipEntry` used to retain every inflated chunk and then allocate a
 * second, full-size buffer to concatenate them into. Both were live at the
 * copy, so reading an entry cost TWICE the entry — measured at 2.0–2.1× across
 * 128, 250, 295 and 377 MiB. It now fills one destination sized from the
 * central directory's declared uncompressed size.
 *
 * WHAT THAT BUYS AND WHAT IT COSTS. It removes a full-size copy, and it makes
 * the reader depend on a number the archive supplies. These tests exist mostly
 * for the second half: the declared size is used for an allocation ONLY after
 * `maxEntryBytes` has been proven, and it is never believed about what the
 * stream will actually produce.
 *
 * SIZES ARE SMALL ON PURPOSE. Every proposition here is about a comparison
 * against a ceiling, and proving it with hundreds of mebibytes would prove the
 * same thing with three orders of magnitude more memory. The production
 * constants are asserted separately, in `zip.test.ts`, so nothing here can
 * quietly become a statement about a different number.
 */

const KIB = 1024;

/** Compressible but not absurdly so — a real ratio, not a bomb's. */
function payload(bytes: number, seed: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let at = 0; at < bytes; at += 1) out[at] = (at * 7 + seed * 31) % 251;
  return out;
}

function onlyEntry(archive: Uint8Array, limits: ZipLimits): ZipEntry {
  const entry = readZipDirectory(archive, limits)[0];
  if (entry === undefined) throw new Error('fixture has no entries');
  return entry;
}

async function expectRefusal(
  run: () => Promise<unknown>,
  code: AppErrorCode,
  reason: ImportRefusal,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    expect(error.code).toBe(code);
    expect(refusalOf(error)).toBe(reason);
    return;
  }
  throw new Error('expected a refusal');
}

/* --------------------------------------------------------- happy paths -- */

describe('ZIP-B1: the inflation path returns exactly the entry’s bytes', () => {
  it('ZIP-B1-T01: a deflated entry returns its exact bytes', async () => {
    const content = payload(6 * KIB, 11);
    const archive = await buildZip([{ name: 'a.bin', content, method: 8 }]);
    const limits = DEFAULT_ZIP_LIMITS;

    const out = await readZipEntry(archive, onlyEntry(archive, limits), {
      limits,
      inflateRaw: inflateRawForTests,
      budget: createInflationBudget(limits),
    });

    expect(out.byteLength).toBe(content.byteLength);
    // Byte-for-byte, not merely the same length. A destination filled at the
    // wrong offsets would pass a length assertion and fail this one.
    expect([...out]).toEqual([...content]);
  });

  it('ZIP-B1-T02: a stored entry returns its exact bytes', async () => {
    const content = payload(3 * KIB, 12);
    const archive = await buildZip([{ name: 'a.bin', content, method: 0 }]);
    const limits = DEFAULT_ZIP_LIMITS;

    const out = await readZipEntry(archive, onlyEntry(archive, limits), {
      limits,
      inflateRaw: inflateRawForTests,
      budget: createInflationBudget(limits),
    });

    expect([...out]).toEqual([...content]);
  });

  it('ZIP-B1-T02b: a stored entry is a view of the archive, and still copies nothing', async () => {
    /*
     * THE STORED PATH WAS ALREADY ZERO-COPY AND STAYS ZERO-COPY.
     *
     * Stage 6D-B1 changed the DEFLATE assembly only. A stored entry's bytes are
     * already contiguous inside the archive, so returning a view is both
     * correct and free; allocating a destination for it would have added the
     * very copy this stage exists to remove.
     */
    const content = payload(2 * KIB, 13);
    const archive = await buildZip([{ name: 'a.bin', content, method: 0 }]);
    const limits = DEFAULT_ZIP_LIMITS;

    const out = await readZipEntry(archive, onlyEntry(archive, limits), {
      limits,
      inflateRaw: inflateRawForTests,
      budget: createInflationBudget(limits),
    });

    expect(out.buffer).toBe(archive.buffer);
    expect(out.byteOffset).toBeGreaterThan(0);
  });

  it('ZIP-B1-T03: a zero-length entry returns an empty buffer, not a refusal', async () => {
    // An empty part is ordinary in a package — an empty `<build/>` model part,
    // a placeholder. Declared zero and producing zero AGREE, so nothing here is
    // a mismatch.
    for (const method of [0, 8]) {
      const archive = await buildZip([{ name: 'empty.bin', content: new Uint8Array(0), method }]);
      const limits = DEFAULT_ZIP_LIMITS;
      const budget = createInflationBudget(limits);

      const out = await readZipEntry(archive, onlyEntry(archive, limits), {
        limits,
        inflateRaw: inflateRawForTests,
        budget,
      });

      expect(out.byteLength).toBe(0);
      expect(budget.totalProducedBytes).toBe(0);
    }
  });

  it('ZIP-B1-T04: many chunks assemble into exact output at the right offsets', async () => {
    /*
     * THE ASSEMBLY IS THE THING UNDER TEST, so the chunking is forced rather
     * than left to whatever `DecompressionStream` happens to do. Deliberately
     * ragged — 1, 7, 333 — because a uniform chunk size would let an
     * off-by-a-chunk offset bug produce correct output by coincidence.
     */
    const content = payload(4 * KIB, 14);
    const archive = await buildZip([{ name: 'a.bin', content, method: 8 }]);
    const limits = DEFAULT_ZIP_LIMITS;
    const sizes = [1, 7, 333, 1024, 2, 900];

    async function* raggedInflate(): AsyncIterable<Uint8Array> {
      let at = 0;
      let index = 0;
      while (at < content.byteLength) {
        const size = Math.min(sizes[index % sizes.length] ?? 1, content.byteLength - at);
        yield await Promise.resolve(content.subarray(at, at + size));
        at += size;
        index += 1;
      }
    }

    const out = await readZipEntry(archive, onlyEntry(archive, limits), {
      limits,
      inflateRaw: raggedInflate,
      budget: createInflationBudget(limits),
    });

    expect([...out]).toEqual([...content]);
  });
});

/* ----------------------------------------------- declaration mismatches -- */

describe('ZIP-B1: the archive is not believed about its own sizes', () => {
  it('ZIP-B1-T05: output beyond the declared size is a typed refusal', async () => {
    const content = payload(4 * KIB, 21);
    // Declares half of what it holds. Every ceiling is satisfied; the archive
    // simply contradicts itself.
    const archive = await buildZip([
      { name: 'a.bin', content, method: 8, declaredUncompressedSize: 2 * KIB },
    ]);
    const limits = DEFAULT_ZIP_LIMITS;
    const budget = createInflationBudget(limits);

    await expectRefusal(
      async () =>
        readZipEntry(archive, onlyEntry(archive, limits), {
          limits,
          inflateRaw: inflateRawForTests,
          budget,
        }),
      // MALFORMED, NOT A RESOURCE LIMIT. 4 KiB is nowhere near any ceiling —
      // what is wrong is the file, not its size.
      AppErrorCode.MalformedFile,
      ImportRefusal.ZipDeclaredSizeOverrun,
    );
    // AND NOTHING PARTIAL CAME BACK. The refusal precedes the write, so the
    // budget never saw the bytes that would have overrun.
    expect(budget.totalProducedBytes).toBeLessThanOrEqual(2 * KIB);
  });

  it('ZIP-B1-T05b: a one-byte overrun is refused, not absorbed', async () => {
    // The interesting boundary is the smallest possible disagreement, because
    // that is the one a `>=`/`>` slip would swallow.
    const content = payload(2 * KIB, 22);
    const archive = await buildZip([
      {
        name: 'a.bin',
        content,
        method: 8,
        declaredUncompressedSize: content.byteLength - 1,
      },
    ]);
    const limits = DEFAULT_ZIP_LIMITS;

    await expectRefusal(
      async () =>
        readZipEntry(archive, onlyEntry(archive, limits), {
          limits,
          inflateRaw: inflateRawForTests,
          budget: createInflationBudget(limits),
        }),
      AppErrorCode.MalformedFile,
      ImportRefusal.ZipDeclaredSizeOverrun,
    );
  });

  it('ZIP-B1-T06: a stream shorter than the declared size is a typed refusal', async () => {
    /*
     * TRUNCATION USED TO LOOK LIKE SUCCESS. The reader verifies no CRC, so a
     * short entry previously returned short bytes and the damage surfaced much
     * later as malformed XML — which told the user their MODEL was broken when
     * the ARCHIVE was.
     */
    const content = payload(4 * KIB, 23);
    const archive = await buildZip([
      { name: 'a.bin', content, method: 8, declaredUncompressedSize: 8 * KIB },
    ]);
    const limits = DEFAULT_ZIP_LIMITS;

    await expectRefusal(
      async () =>
        readZipEntry(archive, onlyEntry(archive, limits), {
          limits,
          inflateRaw: inflateRawForTests,
          budget: createInflationBudget(limits),
        }),
      AppErrorCode.MalformedFile,
      ImportRefusal.ZipDeclaredSizeShortfall,
    );
  });

  it('ZIP-B1-T06b: a shortfall never returns the zero-padded destination', async () => {
    /*
     * THE TEMPTING WRONG ANSWER, pinned. `out.subarray(0, produced)` would
     * present truncated data as a successful read, and the untouched tail of a
     * preallocated buffer is zeroes the entry never contained.
     */
    const content = payload(1 * KIB, 24);
    const archive = await buildZip([
      { name: 'a.bin', content, method: 8, declaredUncompressedSize: 4 * KIB },
    ]);
    const limits = DEFAULT_ZIP_LIMITS;

    let returned: Uint8Array | undefined;
    try {
      returned = await readZipEntry(archive, onlyEntry(archive, limits), {
        limits,
        inflateRaw: inflateRawForTests,
        budget: createInflationBudget(limits),
      });
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });

  it('ZIP-B1-T05c: a declared size above the entry cap is refused BEFORE allocating', async () => {
    /*
     * THE ALLOCATION MUST NOT DEPEND ON THE CALLER HAVING USED MATCHING LIMITS.
     *
     * The directory is read under wide limits and the entry under narrow ones,
     * which is a real shape — the Stage 6D benchmark does exactly this. If the
     * ceiling were only applied at directory time, `readZipEntry` would be
     * asked to allocate a size nothing in its own call had checked.
     */
    const content = payload(8 * KIB, 25);
    const archive = await buildZip([{ name: 'a.bin', content, method: 8 }]);
    const wide = DEFAULT_ZIP_LIMITS;
    const narrow: ZipLimits = { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 2 * KIB };

    await expectRefusal(
      async () =>
        readZipEntry(archive, onlyEntry(archive, wide), {
          limits: narrow,
          inflateRaw: inflateRawForTests,
          budget: createInflationBudget(narrow),
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipEntryTooLarge,
    );
  });
});

/* --------------------------------------------- budget, ratio, cancel ----- */

describe('ZIP-B1: the existing protections are unchanged', () => {
  it('ZIP-B1-T07: the runtime budget still fires before uncontrolled retention', async () => {
    /*
     * HONEST METADATA, so the budget is what binds rather than the declaration
     * check. The budget is narrower than the directory's limits, which is the
     * supported shape: one allowance spent across several `readZipEntry` calls.
     */
    let chunksPulled = 0;
    let abandoned = false;
    const CHUNK = 512;
    const DECLARED = 8 * KIB;

    async function* countingInflate(): AsyncIterable<Uint8Array> {
      try {
        for (let index = 0; index < 1_000_000; index += 1) {
          chunksPulled += 1;
          yield await Promise.resolve(new Uint8Array(CHUNK));
        }
      } finally {
        abandoned = true;
      }
    }

    const archive = await buildZip([
      { name: 'a.bin', content: payload(64, 31), method: 8, declaredUncompressedSize: DECLARED },
    ]);
    const limits: ZipLimits = {
      ...DEFAULT_ZIP_LIMITS,
      maxCompressionRatio: Number.MAX_SAFE_INTEGER,
    };
    const budget: InflationBudget = { maxTotalBytes: 2 * KIB, totalProducedBytes: 0 };

    await expectRefusal(
      async () =>
        readZipEntry(archive, onlyEntry(archive, limits), {
          limits,
          inflateRaw: countingInflate,
          budget,
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipTotalTooLarge,
    );

    // Four chunks fit the 2 KiB budget; the fifth is refused before retention.
    expect(chunksPulled).toBe((2 * KIB) / CHUNK + 1);
    // THE STREAM IS ABANDONED, not drained. Refusing after consuming every
    // chunk would bound what is RETAINED and not what is PRODUCED.
    expect(abandoned).toBe(true);
    expect(budget.totalProducedBytes).toBe(2 * KIB);
  });

  it('ZIP-B1-T08: the compression-ratio refusal is unchanged', async () => {
    // Highly compressible: 64 KiB of zeroes deflates to a few dozen bytes.
    const archive = await buildZip([
      { name: 'bomb.bin', content: new Uint8Array(64 * KIB), method: 8 },
    ]);
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, maxCompressionRatio: 4 };

    await expectRefusal(
      async () =>
        readZipEntry(archive, onlyEntry(archive, DEFAULT_ZIP_LIMITS), {
          limits,
          inflateRaw: inflateRawForTests,
          budget: createInflationBudget(limits),
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipRatioExceeded,
    );
  });

  it('ZIP-B1-T09: cancellation during inflation returns nothing at all', async () => {
    /*
     * NO PARTIAL OUTPUT, and that is the property that matters. A preallocated
     * destination is a whole buffer from its first byte, so "return what we
     * have" is a much more available mistake than it was with a chunk list —
     * and a half-filled buffer whose tail is zeroes would be geometry the file
     * never contained.
     */
    const content = payload(8 * KIB, 41);
    const archive = await buildZip([{ name: 'a.bin', content, method: 8 }]);
    const limits = DEFAULT_ZIP_LIMITS;
    const budget = createInflationBudget(limits);

    let pulled = 0;
    async function* slowInflate(): AsyncIterable<Uint8Array> {
      let at = 0;
      while (at < content.byteLength) {
        pulled += 1;
        const size = Math.min(KIB, content.byteLength - at);
        yield await Promise.resolve(content.subarray(at, at + size));
        at += size;
      }
    }

    let cancelledAfter = 0;
    let returned: Uint8Array | undefined;
    let thrown: unknown;
    try {
      returned = await readZipEntry(archive, onlyEntry(archive, limits), {
        limits,
        inflateRaw: slowInflate,
        budget,
        throwIfCancelled: () => {
          cancelledAfter += 1;
          if (cancelledAfter >= 3) throw new Error('OPERATION_CANCELLED');
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(Error);
    // It stopped where the cancel landed rather than running to completion.
    expect(pulled).toBe(3);
    expect(budget.totalProducedBytes).toBe(3 * KIB);
  });
});

/* ----------------------------------------------- one destination, once -- */

describe('ZIP-B1-T10: exactly one destination, and no chunk list', () => {
  it('copies each chunk immediately, so a decompressor may reuse its buffer', async () => {
    /*
     * THE BEHAVIOURAL PROOF THAT THE CHUNK LIST IS GONE.
     *
     * The old implementation retained chunk REFERENCES and concatenated them
     * after the stream finished, so a decompressor that yields views over one
     * reused scratch buffer — which a streaming decompressor is entitled to do
     * — would have produced output where every chunk held the LAST chunk's
     * bytes. Copying on arrival is what makes this correct, and it is a
     * property a concatenating implementation cannot have.
     */
    const content = payload(4 * KIB, 51);
    const archive = await buildZip([{ name: 'a.bin', content, method: 8 }]);
    const limits = DEFAULT_ZIP_LIMITS;
    const CHUNK = 512;
    const scratch = new Uint8Array(CHUNK);

    async function* reusingInflate(): AsyncIterable<Uint8Array> {
      for (let at = 0; at < content.byteLength; at += CHUNK) {
        const size = Math.min(CHUNK, content.byteLength - at);
        scratch.set(content.subarray(at, at + size));
        yield await Promise.resolve(scratch.subarray(0, size));
      }
    }

    const out = await readZipEntry(archive, onlyEntry(archive, limits), {
      limits,
      inflateRaw: reusingInflate,
      budget: createInflationBudget(limits),
    });

    expect([...out]).toEqual([...content]);
  });

  it('owns its whole buffer exactly, with no slack and no second view', async () => {
    const content = payload(5 * KIB, 52);
    const archive = await buildZip([{ name: 'a.bin', content, method: 8 }]);
    const limits = DEFAULT_ZIP_LIMITS;

    const out = await readZipEntry(archive, onlyEntry(archive, limits), {
      limits,
      inflateRaw: inflateRawForTests,
      budget: createInflationBudget(limits),
    });

    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(content.byteLength);
    expect(out.buffer).not.toBe(archive.buffer);
  });
});
