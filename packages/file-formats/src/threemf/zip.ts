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
      'This archive is larger than CAD Fixer will open.',
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
      'This archive contains more entries than CAD Fixer will open.',
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
        'This archive contains a file larger than CAD Fixer will extract.',
        { declared: uncompressedSize, limit: limits.maxEntryBytes },
      );
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > limits.maxTotalUncompressedBytes) {
      throw importTooLarge(
        ImportRefusal.ZipArchiveTooLarge,
        'This archive expands to more data than CAD Fixer will extract.',
        { declared: declaredTotal, limit: limits.maxTotalUncompressedBytes },
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
        'This archive is compressed far beyond what CAD Fixer will expand.',
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

export interface ZipReadOptions {
  readonly limits?: ZipLimits;
  /** Supplied by the host; see `FormatReadContext.inflateRaw`. */
  readonly inflateRaw: (compressed: Uint8Array) => AsyncIterable<Uint8Array>;
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

  if (entry.method === 0) {
    if (compressed.byteLength > limits.maxEntryBytes) {
      throw importTooLarge(
        ImportRefusal.ZipEntryTooLarge,
        'This archive contains a file larger than CAD Fixer will extract.',
      );
    }
    return compressed;
  }

  const chunks: Uint8Array[] = [];
  let produced = 0;
  for await (const chunk of options.inflateRaw(compressed)) {
    produced += chunk.byteLength;
    if (produced > limits.maxEntryBytes) {
      throw importTooLarge(
        ImportRefusal.ZipEntryTooLarge,
        'This archive expands to more data than CAD Fixer will extract.',
        { limit: limits.maxEntryBytes },
      );
    }
    if (entry.compressedSize > 0 && produced / entry.compressedSize > limits.maxCompressionRatio) {
      throw importTooLarge(
        ImportRefusal.ZipRatioExceeded,
        'This archive is compressed far beyond what CAD Fixer will expand.',
        { limit: limits.maxCompressionRatio },
      );
    }
    chunks.push(chunk);
    options.throwIfCancelled?.();
  }

  const out = new Uint8Array(produced);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
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
