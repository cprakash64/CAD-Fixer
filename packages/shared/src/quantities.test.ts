import { describe, expect, it } from 'vitest';
import { formatBytesAgainst, formatBytes, formatCount, formatRatio } from './quantities';

/**
 * The formatter that puts numbers into refusal messages.
 *
 * Worth its own tests because every resource refusal in the product now reads
 * through it, and because its two rules — IEC units and locale independence —
 * are both the kind that quietly stop holding.
 */

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1,023 B'],
    [1024, '1 KiB'],
    [4096, '4 KiB'],
    [1024 * 1024, '1 MiB'],
    [4.3 * 1024 * 1024, '4.3 MiB'],
    [256 * 1024 * 1024, '256 MiB'],
    [512 * 1024 * 1024, '512 MiB'],
    [1024 * 1024 * 1024, '1 GiB'],
  ])('renders %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  /**
   * THE BINARY CONSTANTS MUST NOT BE LABELLED DECIMAL. `512 * 1024 * 1024` is
   * 536,870,912 bytes; calling that "512 MB" overstates the allowance by 7%.
   */
  it('never emits a decimal unit label', () => {
    for (const bytes of [1024, 1024 ** 2, 1024 ** 3, 1024 ** 4, 537_000_000]) {
      expect(formatBytes(bytes)).not.toMatch(/\d\s?[KMGT]B\b/);
    }
  });

  it('drops a trailing .0 rather than writing 1.0 MiB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MiB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MiB');
  });

  it('keeps one decimal only where it carries information', () => {
    // Below ten the fraction matters; above it, it is noise.
    expect(formatBytes(1536 * 1024)).toBe('1.5 MiB');
    expect(formatBytes(620 * 1024 * 1024 + 300 * 1024)).toBe('620 MiB');
  });

  it('does not invent a number for a nonsensical input', () => {
    expect(formatBytes(Number.NaN)).toBe('NaN B');
    expect(formatBytes(-1)).toBe('-1 B');
  });
});

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [999, '999'],
    [1000, '1,000'],
    [4096, '4,096'],
    [65_536, '65,536'],
    [20_000_000, '20,000,000'],
  ])('groups %i as %s', (value, expected) => {
    expect(formatCount(value)).toBe(expected);
  });

  /**
   * NOT `toLocaleString`. Its separator depends on the host, so the same refusal
   * would read `65 536` in one browser and `65.536` in another — and a test
   * asserting either would be asserting the test machine's locale.
   */
  it('is independent of the host locale', () => {
    expect(formatCount(1_234_567)).toBe('1,234,567');
    expect(formatCount(1_234_567)).not.toBe((1_234_567).toLocaleString('de-DE'));
  });

  it('handles negatives and non-finite values without lying', () => {
    expect(formatCount(-4096)).toBe('-4,096');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});

describe('formatRatio', () => {
  it('rounds to a whole ratio', () => {
    expect(formatRatio(1000, 4)).toBe('250:1');
    expect(formatRatio(64 * 1024 * 1024, 65_362)).toBe('1,027:1');
  });

  it('reports an unbounded ratio rather than Infinity:1', () => {
    expect(formatRatio(1000, 0)).toBe('an unbounded ratio');
  });
});

describe('formatBytesAgainst: a refusal may not read as a contradiction', () => {
  const MIB = 1024 * 1024;
  const CEILING = 384 * MIB;

  it('renders more precisely ONLY when the plain rendering would collide', () => {
    /*
     * STAGE 6E-A4. A model entry of 402,704,688 bytes refused against a
     * 402,653,184-byte ceiling used to render as "expands to 384 MiB; CAD
     * Fixer's per-entry expansion limit is 384 MiB" — true, and unreadable as
     * anything but a bug by the person whose file was refused.
     */
    expect(formatBytes(402_704_688)).toBe(formatBytes(CEILING));
    expect(formatBytesAgainst(402_704_688, CEILING)).toBe('384.05 MiB');
    expect(formatBytesAgainst(402_704_688, CEILING)).not.toBe(formatBytes(CEILING));
  });

  it('leaves every refusal that is not near its ceiling exactly as it was', () => {
    // The shorter wording is the right one almost everywhere, and this must not
    // quietly add decimals to it.
    for (const bytes of [0, 512, 4 * MIB, 100 * MIB, 512 * MIB, 1024 * MIB]) {
      expect(formatBytesAgainst(bytes, CEILING)).toBe(formatBytes(bytes));
    }
  });

  it('renders an exact tie as a tie, and never invents a difference', () => {
    // A value EQUAL to the limit is not a contradiction; it is equality, and
    // saying "384.00 MiB against 384 MiB" would imply a difference there is not.
    expect(formatBytesAgainst(CEILING, CEILING)).toBe(formatBytes(CEILING));
  });

  it('works below the ceiling as well as above it', () => {
    // The collision is symmetric: a value a little UNDER the limit rounds to
    // the same string just as one a little over does.
    const justUnder = CEILING - 40_000;
    expect(formatBytes(justUnder)).toBe(formatBytes(CEILING));
    expect(formatBytesAgainst(justUnder, CEILING)).not.toBe(formatBytes(CEILING));
  });
});
