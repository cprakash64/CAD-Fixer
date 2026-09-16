import { formatBytes, formatCount, formatRatio } from '@cadfixer/shared';
import { ImportRefusal, importMalformed, importTooLarge } from '../import-errors';

/**
 * A BOUNDED, DEPENDENCY-FREE ZIP READER.
 *
 * WHY NOT A LIBRARY. The properties 3MF import needs are not "does it
 * decompress correctly" — every ZIP library does that. They are: can extraction
 * be stopped at a byte budget, is the ratio checked WHILE inflating rather than
 * after, and are traversal paths refused before any output is produced. A
 * general-purpose reader optimises for reading the archive; this reads it
 * suspiciously. Inflation itself is a platform primitive supplied by the
 * caller, so none of this costs a dependency.
 *
 * NOT A GENERAL ZIP IMPLEMENTATION. It reads what 3MF actually uses: stored and
 * deflated entries in a single-disk archive with a real central directory.
 * Everything else is refused rather than guessed at.
 *
 * Promoted from `experiments/format-io/zip.mjs`, which refused 18/18 hostile
 * archives. The limits are ADR 0013's, unchanged.
 */

export interface ZipLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxCompressionRatio: number;
  readonly maxPathLength: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 4_096,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathLength: 512,
});

export interface ZipEntry {
  readonly name: string;
  /** 0 = stored, 8 = deflate. Nothing else is accepted. */
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** The EOCD sits after an optional comment of at most 65,535 bytes. */
const MAX_EOCD_SEARCH = 66_000;

/**
 * Describes why an archive path is unsafe, or `undefined` if it is not.
 *
 * ARCHIVE-LOCAL ONLY. 3MF relationships name parts inside the package; nothing
 * in an imported file may address the host filesystem, another archive, or a
 * URL. Refusal is by SHAPE, before any content is read, so a hostile name never
 * reaches code that might act on it.
 */
export function describeUnsafePath(raw: string, limits: ZipLimits): string | undefined {
  if (raw.length > limits.maxPathLength) return 'path too long';
  /*
   * ANY CONTROL CHARACTER, not just NUL. A path is a name, and a name with a
   * control character in it is either corrupt or crafted — NUL truncates in C
   * string handling, and the rest have no business in an archive path. Checked
   * on characters the decoder PRESERVED, which is why `decodeAscii` does not
   * sanitise them away first: a check that runs after sanitisation can never
   * fire.
   */
  for (let at = 0; at < raw.length; at += 1) {
    const code = raw.charCodeAt(at);
    if (code < 32 || code === 127) return 'path contains a control character';
  }
  if (raw.startsWith('/') || raw.startsWith('\\')) return 'absolute path';
  if (/^[A-Za-z]:/.test(raw)) return 'drive-letter path';
  // Backslashes are not a ZIP path separator; treating them as one is how
  // `a\..\..\b` slips past a forward-slash-only check on some readers.
  if (raw.includes('\\')) return 'backslash in path';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return 'URL-like path';
  for (const segment of raw.split('/')) {
    if (segment === '..') return 'parent traversal segment';
  }
  // Percent-encoded traversal is REFUSED rather than decoded, because decoding
  // invites a second round of exactly the same argument.
  if (/%2e%2e/i.test(raw) || /%2f/i.test(raw) || /%5c/i.test(raw)) return 'encoded traversal';
  return undefined;
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  const limit = Math.max(0, length - MAX_EOCD_SEARCH);
  for (let at = length - 22; at >= limit; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  throw importMalformed(
    ImportRefusal.ZipNoCentralDirectory,
    'This file is not a readable archive: it has no central directory.',
  );
}

/**
 * Reads the central directory only. NO entry content is touched here.
 *
 * Every refusal below happens before a single byte is inflated, which is what
 * makes the resource ceilings meaningful rather than advisory.
 */
export function readZipDirectory(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): readonly ZipEntry[] {
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw importTooLarge(
      ImportRefusal.ZipArchiveTooLarge,
      `This archive is ${formatBytes(bytes.byteLength)}; CAD Fixer's archive limit is ${formatBytes(limits.maxArchiveBytes)}.`,
      { bytes: bytes.byteLength, limit: limits.maxArchiveBytes },
    );
  }
  if (bytes.byteLength < 22) {
    throw importMalformed(
      ImportRefusal.ZipNotAnArchive,
      'This file is too small to be an archive.',
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view, bytes.byteLength);

  const entryCount = view.getUint16(eocd + 10, true);
  if (entryCount > limits.maxEntries) {
    throw importTooLarge(
      ImportRefusal.ZipTooManyEntries,
      `This archive contains ${formatCount(entryCount)} entries; CAD Fixer's limit is ${formatCount(limits.maxEntries)} entries.`,
      { entries: entryCount, limit: limits.maxEntries },
    );
  }

  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength) {
      throw importMalformed(ImportRefusal.ZipMalformed, 'This archive’s directory is truncated.');
    }
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw importMalformed(ImportRefusal.ZipMalformed, 'This archive’s directory is corrupt.');
    }

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    // Bit 0 is the encryption flag. An encrypted 3MF is not one we can read,
    // and guessing at it is worse than saying so.
    if ((flags & 0x1) !== 0) {
      throw importMalformed(
        ImportRefusal.ZipEncrypted,
        'This archive is encrypted, so CAD Fixer cannot read it.',
      );
    }
    if (method !== 0 && method !== 8) {
      throw importMalformed(
        ImportRefusal.ZipUnsupportedMethod,
        'This archive uses a compression method CAD Fixer does not support.',
        { method },
      );
    }

    const name = decodeAscii(bytes, offset + 46, nameLength);
    const unsafe = describeUnsafePath(name, limits);
    if (unsafe !== undefined) {
      throw importMalformed(
        ImportRefusal.ZipUnsafePath,
        'This archive contains an unsafe file path, so CAD Fixer will not open it.',
        { reasonDetail: unsafe },
      );
    }

    // Case-insensitive collision: two entries differing only in case resolve to
    // one file on a case-insensitive host, so which one wins would depend on
    // the platform rather than on the archive.
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw importMalformed(
        ImportRefusal.ZipDuplicatePath,
        'This archive contains two entries with the same path.',
      );
    }
    seen.add(key);

    if (uncompressedSize > limits.maxEntryBytes) {
      throw importTooLarge(
        ImportRefusal.ZipEntryTooLarge,
        `A file inside this archive expands to ${formatBytes(uncompressedSize)}; CAD Fixer's per-entry expansion limit is ${formatBytes(limits.maxEntryBytes)}.`,
        { declared: uncompressedSize, limit: limits.maxEntryBytes },
      );
    }
    /*
     * THE SAME RULE AS THE RUNTIME BUDGET, checked against the DECLARATION so
     * an honest oversized archive is refused before anything is inflated. It is
     * not a substitute for the runtime accounting: a directory that lies about
     * its uncompressed sizes passes here and is stopped by `InflationBudget`.
     */
    declaredTotal += uncompressedSize;
    if (declaredTotal > limits.maxTotalUncompressedBytes) {
      throw importTooLarge(
        ImportRefusal.ZipTotalTooLarge,
        `This archive is ${formatBytes(bytes.byteLength)} on disk but expands to ${formatBytes(declaredTotal)} in total; CAD Fixer's total expansion limit is ${formatBytes(limits.maxTotalUncompressedBytes)}. The limit is on expanded data, not on the size of the file.`,
        {
          archiveBytes: bytes.byteLength,
          declared: declaredTotal,
          limit: limits.maxTotalUncompressedBytes,
        },
      );
    }
    /*
     * THE RATIO IS CHECKED ON THE DECLARATION FIRST, so a bomb is refused before
     * a single byte is inflated. It is checked AGAIN while inflating, because a
     * declaration is only a claim — the research corpus included a header that
     * lied about its uncompressed size for exactly this reason.
     */
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      throw importTooLarge(
        ImportRefusal.ZipRatioExceeded,
        `A file inside this archive expands at ${formatRatio(uncompressedSize, compressedSize)}; CAD Fixer's compression-ratio limit is ${formatCount(limits.maxCompressionRatio)}:1.`,
        { ratio: Math.round(uncompressedSize / compressedSize), limit: limits.maxCompressionRatio },
      );
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Entry names are ASCII in every 3MF the specification describes.
 *
 * Decoded here rather than through the injected text decoder because a PATH is
 * not content. Two rules, and the difference between them matters:
 *
 *   - bytes at or above 128 become a replacement character. They cannot be a
 *     separator, a traversal segment or a drive letter, so preserving them
 *     would add nothing and multi-byte decoding would add a second thing to
 *     reason about.
 *   - CONTROL BYTES ARE PRESERVED EXACTLY, so `describeUnsafePath` can refuse
 *     them. Replacing them here first would make that check unreachable — which
 *     it silently was until a NUL-path fixture proved it.
 */
function decodeAscii(bytes: Uint8Array, from: number, length: number): string {
  let out = '';
  for (let at = from; at < from + length && at < bytes.byteLength; at += 1) {
    const byte = bytes[at] ?? 0;
    out += byte < 128 ? String.fromCharCode(byte) : '\uFFFD';
  }
  return out;
}

/**
 * The uncompressed bytes ONE archive is allowed to produce, in total.
 *
 * WHY THIS IS NOT A PER-ENTRY LIMIT. Per-entry and ratio caps bound each entry
 * on its own, and an archive can satisfy both while still expanding to far more
 * than a session may hold: three entries of two hundred megabytes each are
 * individually fine and collectively six hundred. The directory's declared
 * sizes are checked for the same total up front, but a declaration is a claim
 * by whoever wrote the archive — this is the accounting that does not depend on
 * the file telling the truth.
 *
 * MUTABLE ON PURPOSE. The budget is spent across several calls to
 * `readZipEntry`, and it must be readable after a refusal has unwound them.
 */
export interface InflationBudget {
  readonly maxTotalBytes: number;
  /** Produced so far, across every entry inflated under this budget. */
  totalProducedBytes: number;
}

/** One budget per archive, per import. Never shared between imports. */
export function createInflationBudget(limits: ZipLimits = DEFAULT_ZIP_LIMITS): InflationBudget {
  return { maxTotalBytes: limits.maxTotalUncompressedBytes, totalProducedBytes: 0 };
}

export interface ZipReadOptions {
  readonly limits?: ZipLimits;
  /** Supplied by the host; see `FormatReadContext.inflateRaw`. */
  readonly inflateRaw: (compressed: Uint8Array) => AsyncIterable<Uint8Array>;
  /**
   * The archive-wide byte budget. REQUIRED, so it cannot be forgotten.
   *
   * An optional budget is a budget that is not enforced the first time someone
   * adds a second `readZipEntry` call and does not notice the parameter.
   */
  readonly budget: InflationBudget;
  /** Polled between inflated chunks so a large entry can be abandoned. */
  readonly throwIfCancelled?: () => void;
}

/**
 * Inflates one entry, enforcing the byte budget DURING inflation.
 *
 * The loop below is the difference between a bounded reader and a library with
 * a size check bolted on: a quadrillion-byte bomb is abandoned after the first
 * chunk that takes the total past budget, so peak memory is the limit rather
 * than whatever the archive claimed. The research measured a 65,362-byte entry
 * that inflates to 67,108,864 bytes — 1027:1 — and this refuses it twice.
 *
 * ONE DESTINATION, ALLOCATED ONCE — Stage 6D-B1.
 *
 * This used to retain every inflated chunk in an array and then allocate a
 * second, full-size buffer to concatenate them into. Both were live at the
 * moment of the copy, so reading an entry cost TWICE the entry — measured at
 * 2.0–2.1× across 128, 250, 295 and 377 MiB fixtures, which is 615 MiB of live
 * buffers for an entry the size of the one BETA-002 reported.
 *
 * Filling one preallocated destination measures 1.09–1.17× of the entry on the
 * same fixtures, and is never slower: the concatenating copy stops existing, so
 * inflation of a 250 MiB entry fell from 927 ms to 373 ms. Numbers and method
 * are in docs/design, reproducible with `npm run bench:large-entry`.
 *
 * THE DECLARED SIZE IS ATTACKER-CONTROLLED AND IS TREATED THAT WAY. It is used
 * for the allocation ONLY after it has been proven to be within
 * `maxEntryBytes` — re-checked HERE rather than inherited from
 * `readZipDirectory`, because a caller may read the directory under different
 * limits and an allocation must not depend on that having matched. It is never
 * treated as proof of what the stream will actually produce: `InflationBudget`
 * still counts real bytes, chunk by chunk, and a stream that disagrees with the
 * declaration in EITHER direction is refused rather than reconciled.
 *
 * That disagreement check is also the first integrity check this reader has
 * ever had. No CRC is verified, so a truncated entry previously returned short
 * bytes that looked like a successful read and surfaced later as malformed XML
 * — telling the user their model was broken when the archive was.
 */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  options: ZipReadOptions,
): Promise<Uint8Array> {
  const limits = options.limits ?? DEFAULT_ZIP_LIMITS;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (entry.localOffset + 30 > bytes.byteLength) {
    throw importMalformed(ImportRefusal.ZipMalformed, 'This archive’s file header is truncated.');
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > bytes.byteLength) {
    throw importMalformed(ImportRefusal.ZipMalformed, 'This archive’s file data is truncated.');
  }
  const compressed = bytes.subarray(start, start + entry.compressedSize);

  const budget = options.budget;
  const refuseTotal = (prospective: number): never => {
    throw importTooLarge(
      ImportRefusal.ZipTotalTooLarge,
      `This archive expands beyond the ${formatBytes(budget.maxTotalBytes)} of data CAD Fixer will extract in total. That limit is on expanded data, not on the size of the file.`,
      { produced: prospective, limit: budget.maxTotalBytes, entry: entry.name.slice(0, 128) },
    );
  };

  if (entry.method === 0) {
    if (compressed.byteLength > limits.maxEntryBytes) {
      throw importTooLarge(
        ImportRefusal.ZipEntryTooLarge,
        `A file inside this archive is ${formatBytes(compressed.byteLength)}; CAD Fixer's per-entry expansion limit is ${formatBytes(limits.maxEntryBytes)}.`,
        { declared: compressed.byteLength, limit: limits.maxEntryBytes },
      );
    }
    // A STORED ENTRY STILL SPENDS THE BUDGET. Its bytes are output the same way
    // an inflated entry's are; that they needed no work to produce is not a
    // reason to let them past the ceiling uncounted.
    const prospectiveTotal = budget.totalProducedBytes + compressed.byteLength;
    if (prospectiveTotal > budget.maxTotalBytes) refuseTotal(prospectiveTotal);
    budget.totalProducedBytes = prospectiveTotal;
    return compressed;
  }

  /*
   * PROVEN BEFORE THE ALLOCATION, not after and not elsewhere.
   *
   * `readZipDirectory` already applies this ceiling, but it is applied again
   * here because THIS is the line that turns the number into an allocation.
   * A caller that read the directory under wider limits — the Stage 6D
   * benchmark does exactly that — must not be able to hand this function a
   * declared size it is then asked to allocate.
   */
  const declared = entry.uncompressedSize;
  if (declared > limits.maxEntryBytes) {
    throw importTooLarge(
      ImportRefusal.ZipEntryTooLarge,
      `A file inside this archive expands to ${formatBytes(declared)}; CAD Fixer's per-entry expansion limit is ${formatBytes(limits.maxEntryBytes)}.`,
      { declared, limit: limits.maxEntryBytes },
    );
  }

  const out = new Uint8Array(declared);
  let produced = 0;
  for await (const chunk of options.inflateRaw(compressed)) {
    /*
     * EVERY CHECK IS ON THE PROSPECTIVE TOTAL, BEFORE THE CHUNK IS RETAINED.
     *
     * Accounting first and checking afterwards would make the peak one chunk
     * larger than the limit says it is. Refusing before the write means the
     * budget is the actual bound on what this holds.
     *
     * Throwing here also abandons the stream: leaving the `for await` calls the
     * async iterator's `return()`, whose `finally` cancels the underlying
     * reader, so the remaining chunks are never produced at all.
     */
    const prospectiveEntry = produced + chunk.byteLength;
    if (prospectiveEntry > limits.maxEntryBytes) {
      throw importTooLarge(
        ImportRefusal.ZipEntryTooLarge,
        `A file inside this archive expands beyond CAD Fixer's per-entry expansion limit of ${formatBytes(limits.maxEntryBytes)}.`,
        { limit: limits.maxEntryBytes },
      );
    }
    const prospectiveTotal = budget.totalProducedBytes + chunk.byteLength;
    if (prospectiveTotal > budget.maxTotalBytes) refuseTotal(prospectiveTotal);
    if (
      entry.compressedSize > 0 &&
      prospectiveEntry / entry.compressedSize > limits.maxCompressionRatio
    ) {
      throw importTooLarge(
        ImportRefusal.ZipRatioExceeded,
        `A file inside this archive expands beyond CAD Fixer's compression-ratio limit of ${formatCount(limits.maxCompressionRatio)}:1.`,
        { limit: limits.maxCompressionRatio },
      );
    }
    /*
     * THE ARCHIVE HAS CONTRADICTED ITSELF, and neither side is believed.
     *
     * Checked AFTER the resource ceilings so that an entry which is both over
     * budget and over its declaration still reports the ceiling it crossed —
     * the resource ceilings are policy the user can act on, and this is a
     * statement about the file. Checked BEFORE the write, because the write is
     * what would go out of bounds.
     *
     * The buffer is NOT grown and a second one is NOT allocated: growing would
     * hand an attacker the doubling this change exists to remove, and it would
     * mean the declared size bounded nothing at all.
     */
    if (prospectiveEntry > declared) {
      throw importMalformed(
        ImportRefusal.ZipDeclaredSizeOverrun,
        'A file inside this archive contains more data than the archive says it does, so CAD Fixer will not read it.',
        { declared, atLeast: prospectiveEntry },
      );
    }

    out.set(chunk, produced);
    produced = prospectiveEntry;
    budget.totalProducedBytes = prospectiveTotal;
    options.throwIfCancelled?.();
  }

  /*
   * A SHORT STREAM IS A CORRUPT ENTRY, NOT A SMALL ONE.
   *
   * Returning `out.subarray(0, produced)` here would be the tempting answer and
   * the wrong one: it presents truncated data as a successful read, and the
   * failure then appears somewhere downstream as malformed content. `subarray`
   * would also be a second view over a buffer whose tail is zeroes, which is
   * data the entry never contained.
   */
  if (produced !== declared) {
    throw importMalformed(
      ImportRefusal.ZipDeclaredSizeShortfall,
      'A file inside this archive is smaller than the archive says it is, so CAD Fixer will not read it.',
      { declared, produced },
    );
  }
  return out;
}

/** True when the bytes begin with a local file header or an empty-archive EOCD. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}
