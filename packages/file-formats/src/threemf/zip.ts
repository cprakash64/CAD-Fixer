import { formatBytes, formatCount, formatRatio, isAppError } from '@cadfixer/shared';
import { ImportRefusal, importMalformed, importTooLarge, internalRefusal } from '../import-errors';
import type { TwoPassByteSource } from './xml-stream';

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
/**
 * ZIP64, AND WHY A 3MF READER NEEDS IT AT 140 KIB.
 *
 * Zip64 exists for archives past four gibibytes, so it looks like something a
 * 512 MiB ceiling makes irrelevant. It is not: a writer may emit the Zip64
 * structures WHATEVER the size, and Stage 6D-A3's producer corpus found that
 * Bambu Studio and OrcaSlicer do exactly that — their calibration packages are
 * a few hundred kilobytes and every size and offset in them is the
 * `0xFFFFFFFF` sentinel, with the real values in the Zip64 records.
 *
 * Without this CAD Fixer refused every one of those files as a corrupt
 * archive, which is both wrong and the worst kind of wrong: it told users their
 * working slicer output was damaged.
 */
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_BYTES = 20;
/** The sentinel a 32-bit field carries when its real value is in a Zip64 record. */
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;
/** Zip64 extended information, in the extra field. */
const ZIP64_EXTRA_TAG = 0x0001;
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

/**
 * A 64-bit little-endian value, as a `number`, refusing anything beyond exact
 * integer range.
 *
 * READ AS TWO 32-BIT HALVES RATHER THAN AS A `BigInt`. Every quantity it can
 * describe here is bounded by `maxArchiveBytes` at 512 MiB, so a value needing
 * more than 53 bits is not a large archive — it is a claim this reader should
 * refuse before it becomes an offset. Returning `undefined` makes the caller
 * say so rather than silently producing a rounded number.
 */
function readUint64(view: DataView, at: number): number | undefined {
  const low = view.getUint32(at, true);
  const high = view.getUint32(at + 4, true);
  // 2^53 - 1 total, so the high word may not exceed 2^21 - 1.
  if (high > 0x001fffff) return undefined;
  return high * 0x1_0000_0000 + low;
}

/** What the Zip64 records say about the central directory, when they exist. */
interface Zip64Directory {
  readonly entryCount: number;
  readonly offset: number;
}

/** Refuses an archive split across several files. OPC packages are one file. */
function refuseMultiDisk(detail: string): never {
  throw importMalformed(
    ImportRefusal.ZipMalformed,
    'This archive is split across several files, which a 3MF package cannot be.',
    { reasonDetail: `multi-disk archive: ${detail}` },
  );
}

/**
 * The Zip64 end-of-central-directory record, when the EOCD defers to one.
 *
 * ONLY CONSULTED WHEN A FIELD IS THE SENTINEL. A reader that always looked
 * would be reading structures most archives do not have; one that never looked
 * refuses the archives that do. Every offset below is bounds-checked before it
 * is followed, because all three of them come from the file.
 *
 * NO LOCATOR MEANS NO ZIP64, and the caller then reads the fixed fields as the
 * literal values they are. A LOCATOR THAT LEADS NOWHERE IS CORRUPTION — Stage
 * 6D-A4. It used to fall back to the fixed fields too, so a damaged record was
 * reported as an archive of 65,535 entries (a resource refusal) or followed to
 * an offset of 0xFFFFFFFF (a "truncated" one): a statement about the user's
 * archive that was not true.
 */
function readZip64Directory(
  view: DataView,
  length: number,
  eocd: number,
): Zip64Directory | undefined {
  const locator = eocd - ZIP64_EOCD_LOCATOR_BYTES;
  if (locator < 0) return undefined;
  if (view.getUint32(locator, true) !== ZIP64_EOCD_LOCATOR_SIGNATURE) return undefined;

  const corrupt = (detail: string): never => {
    throw importMalformed(
      ImportRefusal.ZipMalformed,
      'This archive’s directory is corrupt: its 64-bit directory record cannot be read.',
      { reasonDetail: `zip64 record: ${detail}` },
    );
  };

  // Disk holding the record, and the total number of disks. Writers put 0 or 1
  // in the total for a single-file archive; anything else is a split archive.
  if (view.getUint32(locator + 4, true) !== 0) refuseMultiDisk('locator disk');
  if (view.getUint32(locator + 16, true) > 1) refuseMultiDisk('locator disk count');

  const recordAt = readUint64(view, locator + 8);
  // The 56-byte record must sit wholly BEFORE its locator. `readUint64` cannot
  // return a negative, and a value past 2^53 is refused rather than rounded.
  if (recordAt === undefined) return corrupt('offset beyond exact integer range');
  if (recordAt + 56 > locator) return corrupt('offset outside the archive');
  if (view.getUint32(recordAt, true) !== ZIP64_EOCD_SIGNATURE) return corrupt('signature');

  if (view.getUint32(recordAt + 16, true) !== 0) refuseMultiDisk('record disk');
  if (view.getUint32(recordAt + 20, true) !== 0) refuseMultiDisk('directory disk');

  const onThisDisk = readUint64(view, recordAt + 24);
  const entryCount = readUint64(view, recordAt + 32);
  const offset = readUint64(view, recordAt + 48);
  if (onThisDisk === undefined || entryCount === undefined || offset === undefined) {
    return corrupt('field beyond exact integer range');
  }
  if (onThisDisk !== entryCount) refuseMultiDisk('entries on this disk');
  if (offset > length) return corrupt('directory offset outside the archive');
  return { entryCount, offset };
}

/**
 * A Zip64 extended-information extra field's replacement values.
 *
 * THE FIELDS ARE POSITIONAL AND CONDITIONAL. Only those whose 32-bit
 * counterpart is the sentinel are present, in the order uncompressed,
 * compressed, local offset, disk — so which eight bytes mean what depends on
 * what the fixed record already said. Reading them in a fixed order regardless
 * is the classic way to end up with a compressed size in an offset.
 */
function readZip64Extra(
  view: DataView,
  at: number,
  extraLength: number,
  needs: { uncompressed: boolean; compressed: boolean; localOffset: boolean },
): { uncompressed?: number; compressed?: number; localOffset?: number } | undefined {
  let cursor = at;
  const end = at + extraLength;
  while (cursor + 4 <= end) {
    const tag = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    if (cursor + 4 + size > end) return undefined;
    if (tag !== ZIP64_EXTRA_TAG) {
      cursor += 4 + size;
      continue;
    }

    let field = cursor + 4;
    const remaining = (): number => cursor + 4 + size - field;
    const out: { uncompressed?: number; compressed?: number; localOffset?: number } = {};
    for (const [wanted, key] of [
      [needs.uncompressed, 'uncompressed'],
      [needs.compressed, 'compressed'],
      [needs.localOffset, 'localOffset'],
    ] as const) {
      if (!wanted) continue;
      if (remaining() < 8) return undefined;
      const value = readUint64(view, field);
      if (value === undefined) return undefined;
      out[key] = value;
      field += 8;
    }
    return out;
  }
  return undefined;
}

/**
 * The end-of-central-directory record.
 *
 * THE ONE WHOSE COMMENT ENDS THE FILE WINS — Stage 6D-A4. Searching backwards
 * for the signature alone takes the LAST four bytes that spell it, and an
 * archive comment may contain those bytes; the real record is the one whose
 * declared comment length reaches exactly the end of the file. When no
 * candidate does — some writers leave trailing bytes after the record — the
 * last signature is used, which is what this always did.
 */
function findEndOfCentralDirectory(view: DataView, length: number): number {
  const limit = Math.max(0, length - MAX_EOCD_SEARCH);
  let fallback: number | undefined;
  for (let at = length - 22; at >= limit; at -= 1) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    if (at + 22 + view.getUint16(at + 20, true) === length) return at;
    fallback ??= at;
  }
  if (fallback !== undefined) return fallback;
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

  /*
   * THE EOCD MAY DEFER TO A ZIP64 RECORD, and Stage 6D-A3's producer corpus
   * showed it doing so in packages of a few hundred kilobytes. When any of the
   * three fields is its sentinel the authoritative values live in the Zip64
   * end-of-central-directory record; when none is, that record is not consulted
   * even if it exists, because the fixed fields are then complete and
   * self-consistent.
   */
  /*
   * ONE FILE, ONE DISK. A spanned or split archive numbers its disks here, and
   * its offsets are relative to a disk this file is not; following them as if
   * they were this file's is how a split archive becomes "truncated". Sentinel
   * values defer to the Zip64 record, which is checked the same way.
   */
  const thisDisk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  if (thisDisk !== 0 && thisDisk !== ZIP64_SENTINEL_16) refuseMultiDisk('disk number');
  if (directoryDisk !== 0 && directoryDisk !== ZIP64_SENTINEL_16) {
    refuseMultiDisk('directory disk');
  }
  if (entriesOnDisk !== totalEntries) refuseMultiDisk('entries on this disk');

  const zip64 =
    view.getUint16(eocd + 10, true) === ZIP64_SENTINEL_16 ||
    view.getUint32(eocd + 12, true) === ZIP64_SENTINEL_32 ||
    view.getUint32(eocd + 16, true) === ZIP64_SENTINEL_32
      ? readZip64Directory(view, bytes.byteLength, eocd)
      : undefined;

  const entryCount = zip64?.entryCount ?? view.getUint16(eocd + 10, true);
  if (entryCount > limits.maxEntries) {
    throw importTooLarge(
      ImportRefusal.ZipTooManyEntries,
      `This archive contains ${formatCount(entryCount)} entries; CAD Fixer's limit is ${formatCount(limits.maxEntries)} entries.`,
      { entries: entryCount, limit: limits.maxEntries },
    );
  }

  let offset = zip64?.offset ?? view.getUint32(eocd + 16, true);
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
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);

    /*
     * A SENTINEL MEANS "READ THIS FROM THE EXTRA FIELD", per field. The three
     * quantities are independent — an archive may carry a Zip64 local offset
     * with ordinary 32-bit sizes — so each is resolved on its own and the extra
     * field is only consulted when at least one of them asks for it.
     */
    const fixedCompressed = view.getUint32(offset + 20, true);
    const fixedUncompressed = view.getUint32(offset + 24, true);
    const fixedLocalOffset = view.getUint32(offset + 42, true);
    const needs = {
      uncompressed: fixedUncompressed === ZIP64_SENTINEL_32,
      compressed: fixedCompressed === ZIP64_SENTINEL_32,
      localOffset: fixedLocalOffset === ZIP64_SENTINEL_32,
    };

    let extended: ReturnType<typeof readZip64Extra>;
    if (needs.uncompressed || needs.compressed || needs.localOffset) {
      if (offset + 46 + nameLength + extraLength > bytes.byteLength) {
        throw importMalformed(ImportRefusal.ZipMalformed, 'This archive’s directory is truncated.');
      }
      extended = readZip64Extra(view, offset + 46 + nameLength, extraLength, needs);
      if (
        extended === undefined ||
        (needs.uncompressed && extended.uncompressed === undefined) ||
        (needs.compressed && extended.compressed === undefined) ||
        (needs.localOffset && extended.localOffset === undefined)
      ) {
        /*
         * THE SENTINEL PROMISED A VALUE THAT IS NOT THERE. Falling back to
         * `0xFFFFFFFF` would turn a missing size into a 4 GiB one and a missing
         * offset into a read far outside the archive.
         */
        throw importMalformed(
          ImportRefusal.ZipMalformed,
          'This archive’s directory is corrupt: an entry promises a 64-bit size it does not carry.',
        );
      }
    }

    const compressedSize = extended?.compressed ?? fixedCompressed;
    const uncompressedSize = extended?.uncompressed ?? fixedUncompressed;
    const localOffset = extended?.localOffset ?? fixedLocalOffset;

    /*
     * WHERE THE DATA IS, CHECKED BEFORE ANYTHING IS SIZED FROM IT — Stage 6D-A4.
     * A resolved Zip64 value can be anything up to 2^53, so an offset or a
     * compressed size that points past the archive is refused here, as a
     * statement about the archive, rather than being carried into arithmetic
     * further down.
     */
    if (localOffset + 30 > bytes.byteLength || compressedSize > bytes.byteLength) {
      throw importMalformed(
        ImportRefusal.ZipMalformed,
        'This archive’s directory points outside the archive.',
        { reasonDetail: 'entry extent' },
      );
    }

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
    /*
     * A STORED ENTRY'S TWO SIZES ARE THE SAME NUMBER. One that says otherwise
     * has contradicted itself, and neither side is believed — Stage 6D-A4.
     */
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw importMalformed(
        ImportRefusal.ZipMalformed,
        'This archive’s directory is corrupt: a stored file declares two different sizes.',
        { reasonDetail: 'stored sizes disagree' },
      );
    }
    /*
     * NOTHING INFLATES TO SOMETHING. A deflated entry with no compressed bytes
     * cannot produce any output, so a nonzero declared size is an unbounded
     * ratio — and `readZipEntry` sizes its one allocation from that declaration.
     * The ratio check below skipped a zero divisor, which let a few hundred
     * bytes of directory ask for a full per-entry allocation before the stream
     * proved it empty. Stage 6D-A4.
     */
    const unboundedRatio = compressedSize === 0 && uncompressedSize > 0;
    if (
      unboundedRatio ||
      (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio)
    ) {
      throw importTooLarge(
        ImportRefusal.ZipRatioExceeded,
        unboundedRatio
          ? `A file inside this archive declares ${formatBytes(uncompressedSize)} of data from no compressed bytes at all; CAD Fixer's compression-ratio limit is ${formatCount(limits.maxCompressionRatio)}:1.`
          : `A file inside this archive expands at ${formatRatio(uncompressedSize, compressedSize)}; CAD Fixer's compression-ratio limit is ${formatCount(limits.maxCompressionRatio)}:1.`,
        {
          ...(unboundedRatio
            ? { declared: uncompressedSize, compressed: 0 }
            : { ratio: Math.round(uncompressedSize / compressedSize) }),
          limit: limits.maxCompressionRatio,
        },
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
  /*
   * A DECOMPRESSOR FAILURE IS A DAMAGED FILE, NOT AN INTERNAL ERROR — Stage
   * 6D-A4. The platform inflater rejects a damaged stream with a bare
   * `TypeError` (`Z_DATA_ERROR`), which used to leave the worker as an INTERNAL
   * error: the user saw the file name followed by an empty message. Only
   * `next()` is inside the conversion's `try`, so only the decompressor's own
   * failures are converted; an `AppError` passes through untouched, and nothing
   * thrown by the code below can be mistaken for corruption.
   *
   * A DIRECT PULL, NEVER AN ASYNC GENERATOR LAYER. The first version wrapped the
   * stream in an `async function*` that converted the error and re-yielded each
   * chunk. That extra hop per chunk let the decompressor run ahead of this loop,
   * and inflated chunks queued beside the preallocated `out`: measured in
   * Chromium on the 8 GiB host, a 2 x 1.2 M-triangle production package peaked at
   * 1,600 MiB against 1,221-1,242 MiB for this loop and 1,241 MiB for Stage
   * 6D-A3. A boundary test keeps `async function*` out of this file.
   *
   * Leaving early still releases the stream: `return()` is forwarded in the
   * `finally`, exactly as `for await` forwarded it.
   */
  const chunks = options.inflateRaw(compressed)[Symbol.asyncIterator]();
  let drained = false;
  try {
    for (;;) {
      let step: IteratorResult<Uint8Array>;
      try {
        step = await chunks.next();
      } catch (error) {
        drained = true;
        if (isAppError(error)) throw error;
        throw importMalformed(
          ImportRefusal.ZipMalformed,
          'A file inside this archive is damaged: its compressed data cannot be decompressed.',
          { reasonDetail: 'corrupt compressed data', entry: entry.name.slice(0, 128) },
        );
      }
      if (step.done === true) {
        drained = true;
        break;
      }
      const chunk = step.value;
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
  } finally {
    if (!drained) await chunks.return?.();
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

/* ==================================================== streaming reads === */

/**
 * ONE ENTRY, READ TWICE, IN ORDER — the streamed model-part read, Stage 6E.
 *
 * The streamed XML path reads a model part twice: a SECURITY pass over the
 * whole part, then — only if that pass cleared — a SEMANTIC pass for elements
 * (`scanXmlByteStream` records why). This object is the only way to obtain
 * those reads, and it owns the two rules that make reading twice safe:
 *
 * 1. THE FIRST READ IS CHARGED TO THE PACKAGE BUDGET; THE SECOND IS NOT. The
 *    budget bounds what the ARCHIVE expands to, not how many times CAD Fixer
 *    chooses to look at it. Not charging the replay is safe because:
 *      - the archive bytes are immutable for the life of the import — they are
 *        the transferred file, which nothing writes;
 *      - raw DEFLATE is deterministic, so the same compressed bytes inflate to
 *        the same output;
 *      - the first read charged the bytes it ACTUALLY produced, chunk by chunk,
 *        not the declaration;
 *      - the second read is still held to every per-entry rule — per-entry
 *        ceiling, ratio, overrun, and an EXACT-size end — so if it were somehow a
 *        different stream it would be refused, not silently larger;
 *      - nothing resets or credits the budget between the two reads.
 * 2. THE SECOND READ CANNOT BEGIN UNTIL THE FIRST HAS REACHED ITS VERIFIED END.
 *    `semantic()` refuses as an internal fault unless `security()` was read to
 *    completion — its shortfall check included. That is what makes "no element
 *    event before the security verdict" a property of this object rather than
 *    of its caller's discipline.
 *
 * Every entry is opened with `readZipEntry`'s rules except the allocation: the
 * declared size is bounded by `maxEntryBytes` before anything is inflated, and
 * a STORED entry is refused and charged exactly as `readZipEntry` refuses and
 * charges it, all at once, before its first slice.
 */
export function openTwoPassEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  options: ZipReadOptions,
): TwoPassByteSource {
  return new TwoPassEntry(bytes, entry, options);
}

type PassState = 'unopened' | 'security' | 'cleared' | 'semantic';

class TwoPassEntry implements TwoPassByteSource {
  private readonly bytes: Uint8Array;
  private readonly entry: ZipEntry;
  private readonly options: ZipReadOptions;
  private state: PassState = 'unopened';

  public constructor(bytes: Uint8Array, entry: ZipEntry, options: ZipReadOptions) {
    this.bytes = bytes;
    this.entry = entry;
    this.options = options;
  }

  public security(): AsyncIterable<Uint8Array> {
    if (this.state !== 'unopened') {
      throw internalRefusal('A model part’s security pass was opened more than once.');
    }
    this.state = 'security';
    return streamZipEntry(this.bytes, this.entry, this.options, true, () => {
      this.state = 'cleared';
    });
  }

  public semantic(): AsyncIterable<Uint8Array> {
    if (this.state !== 'cleared') {
      throw internalRefusal(
        'A model part’s element pass was opened before its security pass had read the whole part.',
      );
    }
    this.state = 'semantic';
    return streamZipEntry(this.bytes, this.entry, this.options, false, undefined);
  }
}

/** Slice length for a STORED entry, which needs no inflater. */
const STORED_SLICE_BYTES = 65_536;

/**
 * One entry's inflated bytes, as a sequence of chunks.
 *
 * EVERY RULE `readZipEntry` APPLIES, EXCEPT THE ALLOCATION: the declared size
 * bounded before anything is inflated; per chunk, the per-entry ceiling, the
 * package budget (when `charge`), the ratio against the compressed size, and
 * overrun past the declaration, in `readZipEntry`'s order; a shortfall at the
 * end; a damaged stream as a typed "damaged" refusal. What is gone is the one
 * buffer of the declared size — each chunk is handed on and released.
 *
 * NOT EXPORTED. Reached only through `openTwoPassEntry`, which decides `charge`.
 */
function streamZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  options: ZipReadOptions,
  charge: boolean,
  onComplete: (() => void) | undefined,
): AsyncIterable<Uint8Array> {
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

  if (entry.method === 0) {
    // `readZipEntry`'s stored-entry checks, word for word, and its charge: the
    // whole entry at once, before a byte is handed on.
    if (compressed.byteLength > limits.maxEntryBytes) {
      throw importTooLarge(
        ImportRefusal.ZipEntryTooLarge,
        `A file inside this archive is ${formatBytes(compressed.byteLength)}; CAD Fixer's per-entry expansion limit is ${formatBytes(limits.maxEntryBytes)}.`,
        { declared: compressed.byteLength, limit: limits.maxEntryBytes },
      );
    }
    if (charge) {
      const budget = options.budget;
      const prospectiveTotal = budget.totalProducedBytes + compressed.byteLength;
      if (prospectiveTotal > budget.maxTotalBytes) {
        throw totalTooLarge(budget, prospectiveTotal, entry);
      }
      budget.totalProducedBytes = prospectiveTotal;
    }
    return {
      [Symbol.asyncIterator]: () =>
        new StoredEntryChunks(compressed, options.throwIfCancelled, onComplete),
    };
  }

  const declared = entry.uncompressedSize;
  if (declared > limits.maxEntryBytes) {
    throw importTooLarge(
      ImportRefusal.ZipEntryTooLarge,
      `A file inside this archive expands to ${formatBytes(declared)}; CAD Fixer's per-entry expansion limit is ${formatBytes(limits.maxEntryBytes)}.`,
      { declared, limit: limits.maxEntryBytes },
    );
  }
  return {
    [Symbol.asyncIterator]: () =>
      new InflatedEntryChunks(compressed, entry, declared, limits, options, charge, onComplete),
  };
}

function totalTooLarge(budget: InflationBudget, prospective: number, entry: ZipEntry): Error {
  return importTooLarge(
    ImportRefusal.ZipTotalTooLarge,
    `This archive expands beyond the ${formatBytes(budget.maxTotalBytes)} of data CAD Fixer will extract in total. That limit is on expanded data, not on the size of the file.`,
    { produced: prospective, limit: budget.maxTotalBytes, entry: entry.name.slice(0, 128) },
  );
}

/** A stored entry, in slices of its own bytes. Already charged, if charged. */
class StoredEntryChunks implements AsyncIterator<Uint8Array> {
  private readonly bytes: Uint8Array;
  private readonly throwIfCancelled: (() => void) | undefined;
  private readonly onComplete: (() => void) | undefined;
  private at = 0;
  private finished = false;

  public constructor(
    bytes: Uint8Array,
    throwIfCancelled: (() => void) | undefined,
    onComplete: (() => void) | undefined,
  ) {
    this.bytes = bytes;
    this.throwIfCancelled = throwIfCancelled;
    this.onComplete = onComplete;
  }

  public next(): Promise<IteratorResult<Uint8Array>> {
    if (this.finished) return Promise.resolve({ done: true, value: undefined });
    if (this.at >= this.bytes.byteLength) {
      this.finished = true;
      this.onComplete?.();
      return Promise.resolve({ done: true, value: undefined });
    }
    const chunk = this.bytes.subarray(this.at, this.at + STORED_SLICE_BYTES);
    this.at += chunk.byteLength;
    try {
      this.throwIfCancelled?.();
    } catch (error) {
      this.finished = true;
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve({ done: false, value: chunk });
  }

  public return(): Promise<IteratorResult<Uint8Array>> {
    this.finished = true;
    return Promise.resolve({ done: true, value: undefined });
  }
}

/**
 * A deflated entry, chunk by chunk from the injected inflater.
 *
 * A CLASS, NOT AN ASYNC GENERATOR, and a direct `next()` pull — the reasoning
 * `readZipEntry` records for its loop, and the boundary test that keeps async
 * generators out of this file.
 */
class InflatedEntryChunks implements AsyncIterator<Uint8Array> {
  private readonly entry: ZipEntry;
  private readonly declared: number;
  private readonly limits: ZipLimits;
  private readonly options: ZipReadOptions;
  private readonly charge: boolean;
  private readonly onComplete: (() => void) | undefined;
  private readonly source: AsyncIterator<Uint8Array>;
  private produced = 0;
  private finished = false;

  public constructor(
    compressed: Uint8Array,
    entry: ZipEntry,
    declared: number,
    limits: ZipLimits,
    options: ZipReadOptions,
    charge: boolean,
    onComplete: (() => void) | undefined,
  ) {
    this.entry = entry;
    this.declared = declared;
    this.limits = limits;
    this.options = options;
    this.charge = charge;
    this.onComplete = onComplete;
    this.source = options.inflateRaw(compressed)[Symbol.asyncIterator]();
  }

  public async next(): Promise<IteratorResult<Uint8Array>> {
    if (this.finished) return { done: true, value: undefined };
    let step: IteratorResult<Uint8Array>;
    try {
      step = await this.source.next();
    } catch (error) {
      // The inflater releases its own stream when its `next()` rejects.
      this.finished = true;
      if (isAppError(error)) throw error;
      throw importMalformed(
        ImportRefusal.ZipMalformed,
        'A file inside this archive is damaged: its compressed data cannot be decompressed.',
        { reasonDetail: 'corrupt compressed data', entry: this.entry.name.slice(0, 128) },
      );
    }
    if (step.done === true) {
      this.finished = true;
      if (this.produced !== this.declared) {
        throw importMalformed(
          ImportRefusal.ZipDeclaredSizeShortfall,
          'A file inside this archive is smaller than the archive says it is, so CAD Fixer will not read it.',
          { declared: this.declared, produced: this.produced },
        );
      }
      this.onComplete?.();
      return { done: true, value: undefined };
    }
    try {
      this.account(step.value);
    } catch (error) {
      await this.return();
      throw error;
    }
    return { done: false, value: step.value };
  }

  /** Early exit — a refusal, a cancel, a consumer that stopped reading. */
  public async return(): Promise<IteratorResult<Uint8Array>> {
    if (!this.finished) {
      this.finished = true;
      await this.source.return?.();
    }
    return { done: true, value: undefined };
  }

  /** The `readZipEntry` checks, in its order, on the prospective totals. */
  private account(chunk: Uint8Array): void {
    const prospective = this.produced + chunk.byteLength;
    if (prospective > this.limits.maxEntryBytes) {
      throw importTooLarge(
        ImportRefusal.ZipEntryTooLarge,
        `A file inside this archive expands beyond CAD Fixer's per-entry expansion limit of ${formatBytes(this.limits.maxEntryBytes)}.`,
        { limit: this.limits.maxEntryBytes },
      );
    }
    const budget = this.options.budget;
    const prospectiveTotal = budget.totalProducedBytes + chunk.byteLength;
    if (this.charge && prospectiveTotal > budget.maxTotalBytes) {
      throw totalTooLarge(budget, prospectiveTotal, this.entry);
    }
    if (
      this.entry.compressedSize > 0 &&
      prospective / this.entry.compressedSize > this.limits.maxCompressionRatio
    ) {
      throw importTooLarge(
        ImportRefusal.ZipRatioExceeded,
        `A file inside this archive expands beyond CAD Fixer's compression-ratio limit of ${formatCount(this.limits.maxCompressionRatio)}:1.`,
        { limit: this.limits.maxCompressionRatio },
      );
    }
    if (prospective > this.declared) {
      throw importMalformed(
        ImportRefusal.ZipDeclaredSizeOverrun,
        'A file inside this archive contains more data than the archive says it does, so CAD Fixer will not read it.',
        { declared: this.declared, atLeast: prospective },
      );
    }
    this.produced = prospective;
    if (this.charge) budget.totalProducedBytes = prospectiveTotal;
    this.options.throwIfCancelled?.();
  }
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
