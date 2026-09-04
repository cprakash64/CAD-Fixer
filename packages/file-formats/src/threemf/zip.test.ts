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
     * THE DECLARATIONS LIE, so this exercises the RUNTIME accounting.
     *
     * With honest sizes the directory check refuses this archive before a byte
     * is inflated, which is the better outcome and is asserted separately
     * below. The attack worth testing here is the one that gets past that:
     * three entries that each claim to be a single byte.
     */
    const archive = await buildZip([
      { name: 'a.bin', content: payload(4 * KIB, 1), method: 8, declaredUncompressedSize: 1 },
      { name: 'b.bin', content: payload(4 * KIB, 2), method: 8, declaredUncompressedSize: 1 },
      { name: 'c.bin', content: payload(4 * KIB, 3), method: 8, declaredUncompressedSize: 1 },
    ]);
    // Each entry is comfortably inside the per-entry cap and the ratio cap.
    const limits: ZipLimits = { ...limitsWithTotal(10 * KIB), maxEntryBytes: 8 * KIB };
    const budget = createInflationBudget(limits);
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
     * satisfied. Only the running count of bytes actually produced can catch
     * this, which is the whole reason it exists.
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
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipTotalTooLarge,
    );
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

    const archive = await buildZip([{ name: 'a.bin', content: payload(64, 1), method: 8 }]);
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
