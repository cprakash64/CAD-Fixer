/**
 * DETERMINISTIC QUANTITY FORMATTING FOR REFUSAL MESSAGES.
 *
 * A refusal that says only "this archive expands to more data than CAD Fixer
 * will extract" leaves the user unable to tell WHICH of six ceilings fired, or
 * by how much. The numbers already exist at every refusal site; these helpers
 * are what puts them into the sentence.
 *
 * A LEAF MODULE THAT IMPORTS NOTHING. It is reached from `screening.ts`, which
 * runs on the MAIN THREAD, so anything it pulled in would follow it into the
 * application bundle — the rule `export/stl-layout.ts` and `threemf/units.ts`
 * already follow.
 *
 * NO `toLocaleString`, ANYWHERE. Its output depends on the host's locale, so
 * the same refusal would read `65 536` in one browser, `65,536` in another and
 * `65.536` in a third — and a test asserting any of them would be asserting the
 * test machine's locale rather than the product's behaviour. Grouping is done
 * here so every user reads the same sentence.
 */

/**
 * IEC units, because the constants they describe are binary.
 *
 * `512 * 1024 * 1024` is 512 MiB and is NOT 512 MB. Labelling it "MB" would
 * misstate the limit by 7% in the user's favour, which is precisely the kind of
 * small dishonesty that turns into a support thread about why a "500 MB" file
 * was refused.
 */
const IEC_UNITS: readonly string[] = Object.freeze(['B', 'KiB', 'MiB', 'GiB', 'TiB']);

const BYTES_PER_STEP = 1024;

/**
 * Groups an integer with commas: `20000000` becomes `20,000,000`.
 *
 * Non-finite input is rendered as-is rather than being coerced: a caller that
 * has lost track of a count should produce visibly wrong output, not a
 * confident `0`.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const whole = Math.trunc(value);
  const digits = String(Math.abs(whole));
  let grouped = '';
  for (let at = 0; at < digits.length; at += 1) {
    if (at > 0 && (digits.length - at) % 3 === 0) grouped += ',';
    grouped += digits[at] ?? '';
  }
  return whole < 0 ? `-${grouped}` : grouped;
}

/** Drops a trailing `.0`, so one mebibyte reads `1 MiB` rather than `1.0 MiB`. */
function trimTrailingZero(rendered: string): string {
  return rendered.endsWith('.0') ? rendered.slice(0, -2) : rendered;
}

/**
 * Renders a byte count in IEC units.
 *
 * One decimal below ten and whole numbers above: `4.3 MiB` carries information
 * that `4 MiB` loses, and `620.3 MiB` carries none that `620 MiB` does not.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${String(bytes)} B`;

  let value = bytes;
  let step = 0;
  while (value >= BYTES_PER_STEP && step < IEC_UNITS.length - 1) {
    value /= BYTES_PER_STEP;
    step += 1;
  }

  const unit = IEC_UNITS[step] ?? 'B';
  if (step === 0) return `${formatCount(Math.round(value))} ${unit}`;
  const rendered = value < 10 ? trimTrailingZero(value.toFixed(1)) : formatCount(Math.round(value));
  return `${rendered} ${unit}`;
}

/**
 * Renders `bytes` so it cannot read as EQUAL to the limit it is being refused
 * against.
 *
 * WHY THIS EXISTS — Stage 6E-A4. `formatBytes` rounds to whole units above ten,
 * which is the right answer almost everywhere and the wrong one in exactly one
 * place: a refusal that names a value and the ceiling it crossed. A model entry
 * of 402,704,688 bytes refused against a 402,653,184-byte ceiling rendered as
 * "expands to 384 MiB; CAD Fixer's per-entry expansion limit is 384 MiB" — a
 * true sentence that reads as a contradiction and makes the product look
 * broken to the person whose file was refused.
 *
 * Two decimals only when the plain rendering would collide, so every refusal
 * that is not near its ceiling keeps the shorter wording. It never claims the
 * values differ when they do not: an exact tie renders as a tie.
 */
export function formatBytesAgainst(bytes: number, limit: number): string {
  const plain = formatBytes(bytes);
  if (bytes === limit || plain !== formatBytes(limit)) return plain;
  if (!Number.isFinite(bytes) || bytes < BYTES_PER_STEP) return plain;
  let value = bytes;
  let step = 0;
  while (value >= BYTES_PER_STEP && step < IEC_UNITS.length - 1) {
    value /= BYTES_PER_STEP;
    step += 1;
  }
  return `${value.toFixed(2)} ${IEC_UNITS[step] ?? 'B'}`;
}

/**
 * Renders an expansion ratio as `243:1`.
 *
 * Rounded, because the exact quotient is a float whose extra digits say nothing
 * a user can act on. A compressed size of zero has no ratio and is reported as
 * unbounded rather than as `Infinity:1`.
 */
export function formatRatio(uncompressedBytes: number, compressedBytes: number): string {
  if (compressedBytes <= 0 || !Number.isFinite(uncompressedBytes)) return 'an unbounded ratio';
  return `${formatCount(Math.round(uncompressedBytes / compressedBytes))}:1`;
}
