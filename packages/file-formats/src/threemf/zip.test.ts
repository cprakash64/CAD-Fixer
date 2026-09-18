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
  type ZipLimits,
} from './zip';

/**
 * ZT01–ZT05 — THE CUMULATIVE INFLATION BUDGET.
 *
 * The per-entry cap and the compression ratio bound each entry ON ITS OWN, and
 * an archive can satisfy both while expanding to far more than a session can
 * hold: three entries of two hundred megabytes each are individually fine and
 * collectively six hundred. Nothing above the entry level noticed that until
 * the budget below existed.
 *
 * THE LIMITS ARE NARROWED, NOT THE FIXTURES INFLATED. Proving a 512 MiB ceiling
 * with 512 MiB of test data would make the suite unrunnable and would prove the
 * same proposition — that a running total is compared against a ceiling — with
 * three orders of magnitude more memory. The production constant is asserted
 * separately, so nothing here can quietly become a statement about a different
 * number.
 */

/** Compressible but not absurdly so, and different per entry. */
function payload(bytes: number, seed: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let at = 0; at < bytes; at += 1) out[at] = (at * 7 + seed * 31) % 251;
  return out;
}

const KIB = 1024;

function limitsWithTotal(total: number): ZipLimits {
  return { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: total };
}

async function readAll(
  archive: Uint8Array,
  limits: ZipLimits,
  budget: InflationBudget,
): Promise<number> {
  const entries = readZipDirectory(archive, limits);
  let produced = 0;
  for (const entry of entries) {
    const out = await readZipEntry(archive, entry, {
      limits,
      inflateRaw: inflateRawForTests,
      budget,
    });
    produced += out.byteLength;
  }
  return produced;
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

describe('the total budget is spent across every entry of one archive', () => {
  it('ZT01: combined output just below the limit is permitted', async () => {
    const archive = await buildZip([
      { name: 'a.bin', content: payload(4 * KIB, 1), method: 8 },
      { name: 'b.bin', content: payload(4 * KIB, 2), method: 8 },
    ]);
    const limits = limitsWithTotal(8 * KIB + 1);
    const budget = createInflationBudget(limits);

    expect(await readAll(archive, limits, budget)).toBe(8 * KIB);
    expect(budget.totalProducedBytes).toBe(8 * KIB);
  });

  it('ZT02: output exactly at the limit is permitted — the contract is inclusive', async () => {
    const archive = await buildZip([
      { name: 'a.bin', content: payload(4 * KIB, 1), method: 8 },
      { name: 'b.bin', content: payload(4 * KIB, 2), method: 8 },
    ]);
    const limits = limitsWithTotal(8 * KIB);
    const budget = createInflationBudget(limits);

    // `>` not `>=`: a file that fits exactly fits. Pinned so the boundary
    // cannot drift by one byte without a test saying so.
    expect(await readAll(archive, limits, budget)).toBe(8 * KIB);
    expect(budget.totalProducedBytes).toBe(limits.maxTotalUncompressedBytes);
  });

  it('ZT03: the chunk that would cross the limit is refused, not retained', async () => {
    const archive = await buildZip([
      { name: 'a.bin', content: payload(4 * KIB, 1), method: 8 },
      { name: 'b.bin', content: payload(4 * KIB, 2), method: 8 },
    ]);
    const limits = limitsWithTotal(8 * KIB - 1);
    const budget = createInflationBudget(limits);

    await expectRefusal(
      async () => readAll(archive, limits, budget),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipTotalTooLarge,
    );
    // AND THE BUDGET WAS NEVER OVERSPENT. Accounting after the check rather
    // than before is what makes this true: the refused bytes were never added.
    expect(budget.totalProducedBytes).toBeLessThanOrEqual(limits.maxTotalUncompressedBytes);
  });

  it('ZT04: three entries, each safe alone, refused on the one that crosses', async () => {
    /*
     * THE BUDGET IS NARROWER THAN THE DIRECTORY'S LIMITS, which is what makes
     * this a test of the RUNTIME accounting rather than of the declared-total
     * check. `ZipReadOptions.budget` is independent of `limits` precisely so a
     * caller can spend one allowance across several `readZipEntry` calls — the
     * shape 3MF import already uses and the shape multi-model-part reading
     * needs.
     *
     * STAGE 6D-B1 CHANGED HOW THIS IS WRITTEN, NOT WHAT IT PROVES. It used to
     * reach the runtime path by declaring each 4 KiB entry as one byte. A
     * preallocated destination now catches that lie at the first chunk, which
     * is a better answer and is asserted as `ZT05`. The proposition here —
     * three entries individually fine and collectively not — needs honest
     * metadata to be about the budget at all.
     */
    const archive = await buildZip([
      { name: 'a.bin', content: payload(4 * KIB, 1), method: 8 },
      { name: 'b.bin', content: payload(4 * KIB, 2), method: 8 },
      { name: 'c.bin', content: payload(4 * KIB, 3), method: 8 },
    ]);
    // Each entry is comfortably inside the per-entry cap and the ratio cap, and
    // the declared total of 12 KiB is inside the directory's own ceiling.
    const limits: ZipLimits = { ...limitsWithTotal(16 * KIB), maxEntryBytes: 8 * KIB };
    const budget: InflationBudget = { maxTotalBytes: 10 * KIB, totalProducedBytes: 0 };
    const entries = readZipDirectory(archive, limits);

    const read = async (index: number): Promise<Uint8Array> => {
      const entry = entries[index];
      if (entry === undefined) throw new Error('missing entry');
      return readZipEntry(archive, entry, {
        limits,
        inflateRaw: inflateRawForTests,
        budget,
      });
    };

    // The first two are individually fine and collectively fine.
    expect((await read(0)).byteLength).toBe(4 * KIB);
    expect((await read(1)).byteLength).toBe(4 * KIB);
    expect(budget.totalProducedBytes).toBe(8 * KIB);

    // THE THIRD IS INDIVIDUALLY FINE AND COLLECTIVELY NOT. Nothing about the
    // entry itself is wrong, which is exactly why a per-entry check misses it.
    await expectRefusal(
      async () => read(2),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipTotalTooLarge,
    );
    // It stopped DURING that entry: some of it was accounted, not all of it.
    expect(budget.totalProducedBytes).toBeGreaterThanOrEqual(8 * KIB);
    expect(budget.totalProducedBytes).toBeLessThanOrEqual(10 * KIB);
  });

  it('ZT05: a directory that lies about its sizes is still stopped at runtime', async () => {
    /*
     * THE DECLARATION SAYS EACH ENTRY IS ONE BYTE. The up-front check on the
     * declared totals therefore passes, and every ceiling before inflation is
     * satisfied. Only something counting what is actually produced can catch
     * this, which is the whole reason a runtime check exists.
     *
     * STAGE 6D-B1 MADE THAT CHECK FIRE EARLIER AND SAY MORE. It used to be the
     * cumulative budget, which meant the lie was only caught once the archive
     * had produced 5 KiB across two entries — the lie itself went unremarked,
     * and the user was told the archive was too large when the truth was that
     * it contradicts itself. A destination sized from the declaration catches
     * it on the FIRST chunk of the FIRST entry, and names what is actually
     * wrong.
     *
     * The category changes with it, and correctly: this is a MALFORMED_FILE,
     * not a RESOURCE_LIMIT_EXCEEDED. Nothing here is near any ceiling.
     */
    const archive = await buildZip([
      { name: 'a.bin', content: payload(4 * KIB, 1), method: 8, declaredUncompressedSize: 1 },
      { name: 'b.bin', content: payload(4 * KIB, 2), method: 8, declaredUncompressedSize: 1 },
    ]);
    const limits = limitsWithTotal(5 * KIB);
    const budget = createInflationBudget(limits);

    // The declaration alone would have sailed through.
    expect(() => readZipDirectory(archive, limits)).not.toThrow();

    await expectRefusal(
      async () => readAll(archive, limits, budget),
      AppErrorCode.MalformedFile,
      ImportRefusal.ZipDeclaredSizeOverrun,
    );
    // AND IT STOPPED BEFORE PRODUCING ANYTHING. The refusal precedes the write,
    // so not one byte of the lying entry was retained or charged.
    expect(budget.totalProducedBytes).toBe(0);
  });

  it('refuses an honestly-declared oversized archive before inflating anything', async () => {
    // The cheap half of the same rule. Both halves report the same reason,
    // because it is the same rule seen at two different moments.
    const archive = await buildZip([
      { name: 'a.bin', content: payload(4 * KIB, 1), method: 8 },
      { name: 'b.bin', content: payload(4 * KIB, 2), method: 8 },
    ]);

    await expectRefusal(
      () => Promise.resolve(readZipDirectory(archive, limitsWithTotal(KIB))),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipTotalTooLarge,
    );
  });

  it('charges STORED entries too, which produce output without inflating', async () => {
    // Method 0 needs no work to produce its bytes. That is not a reason to let
    // them past the ceiling uncounted.
    const archive = await buildZip([
      { name: 'a.bin', content: payload(4 * KIB, 1), method: 0, declaredUncompressedSize: 1 },
      { name: 'b.bin', content: payload(4 * KIB, 2), method: 0, declaredUncompressedSize: 1 },
    ]);
    const limits = limitsWithTotal(6 * KIB);
    const budget = createInflationBudget(limits);

    await expectRefusal(
      async () => readAll(archive, limits, budget),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipTotalTooLarge,
    );
    expect(budget.totalProducedBytes).toBe(4 * KIB);
  });

  it('gives each import its own budget, so one archive cannot starve the next', async () => {
    const archive = await buildZip([{ name: 'a.bin', content: payload(4 * KIB, 1), method: 8 }]);
    const limits = limitsWithTotal(5 * KIB);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const budget = createInflationBudget(limits);
      expect(await readAll(archive, limits, budget)).toBe(4 * KIB);
    }
  });

  it('reads the production ceiling from the one place it is defined', () => {
    const budget = createInflationBudget();
    expect(budget.maxTotalBytes).toBe(DEFAULT_ZIP_LIMITS.maxTotalUncompressedBytes);
    expect(budget.totalProducedBytes).toBe(0);
    // ADR 0013's qualified value, restated nowhere else.
    expect(DEFAULT_ZIP_LIMITS.maxTotalUncompressedBytes).toBe(512 * 1024 * 1024);
  });
});

describe('the reader is abandoned when the budget fires', () => {
  it('stops pulling chunks, and does not read the stream to its end', async () => {
    /*
     * THE PROPERTY THAT MATTERS FOR A BOMB. Refusing after consuming every
     * chunk would bound what is RETAINED and not what is PRODUCED, so a
     * quadrillion-byte entry would still be fully decompressed before the
     * refusal. This counts what the consumer actually asked for.
     */
    let chunksPulled = 0;
    let returned = false;
    const CHUNK = 1024;

    async function* countingInflate(): AsyncIterable<Uint8Array> {
      try {
        for (let index = 0; index < 1_000_000; index += 1) {
          chunksPulled += 1;
          // Awaited so the generator genuinely yields to the event loop between
          // chunks, exactly as a real decompression stream does.
          yield await Promise.resolve(new Uint8Array(CHUNK));
        }
      } finally {
        // Reached when the consumer leaves the loop early — the same path on
        // which the real implementation cancels its `ReadableStream` reader.
        returned = true;
      }
    }

    /*
     * THE DECLARED SIZE IS THE BUDGET'S, so the budget is what binds.
     *
     * Since Stage 6D-B1 the destination is sized from the declaration, so an
     * entry declaring 64 bytes would be refused on its first 1 KiB chunk as a
     * declared-size overrun — a true answer to a different question. This test
     * is about the BUDGET abandoning a stream, so the declaration is made large
     * enough that the budget is the first ceiling reached.
     */
    const archive = await buildZip([
      { name: 'a.bin', content: payload(64, 1), method: 8, declaredUncompressedSize: 4 * KIB },
    ]);
    const limits = limitsWithTotal(4 * KIB);
    const budget = createInflationBudget(limits);
    const entry = readZipDirectory(archive, limits)[0];
    if (entry === undefined) throw new Error('missing entry');

    await expectRefusal(
      async () =>
        readZipEntry(archive, entry, {
          limits: { ...limits, maxCompressionRatio: Number.MAX_SAFE_INTEGER },
          inflateRaw: countingInflate,
          budget,
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipTotalTooLarge,
    );

    // Five pulls: four fit the budget, the fifth is refused before retention.
    expect(chunksPulled).toBe(limits.maxTotalUncompressedBytes / CHUNK + 1);
    expect(returned).toBe(true);
    expect(budget.totalProducedBytes).toBe(limits.maxTotalUncompressedBytes);
  });
});

/* ============================================================== Zip64 ==== */

describe('A3: Zip64 directories, which mainstream slicers write at any size', () => {
  /**
   * WHY THIS IS NOT A LARGE-ARCHIVE FEATURE.
   *
   * Zip64 exists for archives past four gibibytes, so a 512 MiB ceiling looks
   * like it makes the whole thing irrelevant. It does not: a writer may emit the
   * Zip64 structures WHATEVER the size, and Stage 6D-A3's producer corpus found
   * Bambu Studio and OrcaSlicer doing exactly that in calibration packages of
   * 140 and 256 kilobytes — every size and offset the sentinel, the real values
   * in the Zip64 records.
   *
   * Before this, CAD Fixer refused all of them with "this archive's directory
   * is truncated", which is both wrong and the worst kind of wrong: it told
   * users their working slicer output was damaged.
   */
  it('reads an archive whose EOCD defers entirely to the Zip64 record', async () => {
    const archive = await buildZip(
      [
        { name: 'a.txt', content: 'alpha', method: 8 },
        { name: 'b.txt', content: 'bravo', method: 8 },
      ],
      { zip64: true },
    );

    const entries = readZipDirectory(archive);
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt']);
    expect(entries[0]?.uncompressedSize).toBe(5);
    expect(entries[1]?.uncompressedSize).toBe(5);
  });

  it('inflates a Zip64 entry through the ordinary path', async () => {
    const archive = await buildZip([{ name: 'a.txt', content: 'alpha', method: 8 }], {
      zip64: true,
    });
    const entries = readZipDirectory(archive);
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const bytes = await readZipEntry(archive, entry, {
      limits: DEFAULT_ZIP_LIMITS,
      inflateRaw: inflateRawForTests,
      budget: createInflationBudget(DEFAULT_ZIP_LIMITS),
    });
    expect(new TextDecoder().decode(bytes)).toBe('alpha');
  });

  it('applies every ceiling to the Zip64 values, not to the sentinels', async () => {
    /*
     * THE DANGEROUS FAILURE WOULD BE SILENT. If the limits were checked against
     * `0xFFFFFFFF` an ordinary entry would look like four gibibytes and be
     * refused; if they were skipped for Zip64 entries a real one would be
     * unbounded. Both are wrong, and only checking the RESOLVED value is right.
     */
    const archive = await buildZip([{ name: 'a.txt', content: 'alpha', method: 8 }], {
      zip64: true,
    });
    expect(() => readZipDirectory(archive, { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 4 })).toThrow();
    expect(readZipDirectory(archive, { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 5 })).toHaveLength(1);
  });

  it('refuses an entry that promises a 64-bit size it does not carry', async () => {
    const archive = await buildZip([{ name: 'a.txt', content: 'alpha', method: 8 }], {
      zip64WithoutExtra: true,
    });
    let caught: unknown;
    try {
      readZipDirectory(archive);
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(caught.code).toBe(AppErrorCode.MalformedFile);
    expect(refusalOf(caught)).toBe(ImportRefusal.ZipMalformed);
    // AND NOT READ AS FOUR GIBIBYTES, which is what a fallback would do.
    expect(caught.message).not.toContain('4 GiB');
  });

  it('leaves an ordinary archive on the 32-bit path', async () => {
    // The Zip64 record is consulted only when a field is the sentinel. An
    // archive that says nothing about Zip64 must not be looking for one.
    const archive = await buildZip([{ name: 'a.txt', content: 'alpha', method: 8 }]);
    const entries = readZipDirectory(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.localOffset).toBe(0);
  });
});
