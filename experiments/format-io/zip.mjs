/**
 * Stage 4A-1 — a BOUNDED, dependency-free ZIP reader. RESEARCH ONLY.
 *
 * WHY WRITE ONE RATHER THAN TAKE A DEPENDENCY. The security properties 3MF
 * import needs are not "does it decompress correctly" — every ZIP library does
 * that. They are: can extraction be stopped at a byte budget, is the ratio
 * checked while inflating rather than after, are traversal paths refused before
 * any output is produced. A general-purpose library optimises for reading the
 * archive; this reads it *suspiciously*. `DecompressionStream('deflate-raw')`
 * is a platform primitive in every target browser, so the compression itself
 * costs no dependency at all.
 *
 * NOT A GENERAL ZIP IMPLEMENTATION. It reads what 3MF actually uses: stored and
 * deflated entries in a single-disk archive with a real central directory.
 * Everything else is refused rather than guessed at.
 */

export const ZipRefusal = {
  NotZip: 'NOT_ZIP',
  NoCentralDirectory: 'NO_CENTRAL_DIRECTORY',
  TooManyEntries: 'TOO_MANY_ENTRIES',
  EntryTooLarge: 'ENTRY_TOO_LARGE',
  ArchiveTooLarge: 'ARCHIVE_TOO_LARGE',
  RatioExceeded: 'COMPRESSION_RATIO_EXCEEDED',
  Encrypted: 'ENCRYPTED_ENTRY',
  UnsupportedMethod: 'UNSUPPORTED_COMPRESSION_METHOD',
  UnsafePath: 'UNSAFE_PATH',
  DuplicatePath: 'DUPLICATE_PATH',
  Malformed: 'MALFORMED_ARCHIVE',
};

export class ZipError extends Error {
  constructor(refusal, detail) {
    super(`${refusal}${detail === undefined ? '' : `: ${detail}`}`);
    this.name = 'ZipError';
    this.refusal = refusal;
  }
}

export const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 4_096,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathLength: 512,
});

const EOCD = 0x06054b50;
const CEN = 0x02014b50;

/**
 * Refuses a path that could escape the archive or collide once normalised.
 *
 * ARCHIVE-LOCAL ONLY. 3MF relationships name parts inside the package; nothing
 * in an imported file may address the host filesystem, another archive, or a
 * URL. Refusal is by SHAPE, before any content is read, so a hostile name never
 * reaches code that might act on it.
 */
export function describeUnsafePath(raw, limits = DEFAULT_ZIP_LIMITS) {
  if (raw.length > limits.maxPathLength) return 'path too long';
  if (raw.includes('\0')) return 'path contains NUL';
  if (raw.startsWith('/') || raw.startsWith('\\')) return 'absolute path';
  if (/^[A-Za-z]:/.test(raw)) return 'drive-letter path';
  // Backslashes are not a ZIP path separator; treating them as one is how
  // "a\..\..\b" slips past a forward-slash-only check on some readers.
  if (raw.includes('\\')) return 'backslash in path';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return 'URL-like path';
  for (const segment of raw.split('/')) {
    if (segment === '..') return 'parent traversal segment';
  }
  // Percent-encoded traversal: refused rather than decoded, because decoding
  // invites a second round of the same argument.
  if (/%2e%2e/i.test(raw) || /%2f/i.test(raw) || /%5c/i.test(raw)) {
    return 'encoded traversal';
  }
  return undefined;
}

function findEndOfCentralDirectory(view, bytes) {
  // The EOCD is at the end, after an optional comment. Bounded backward scan.
  const limit = Math.max(0, bytes.length - 66_000);
  for (let i = bytes.length - 22; i >= limit; i -= 1) {
    if (view.getUint32(i, true) === EOCD) return i;
  }
  throw new ZipError(ZipRefusal.NoCentralDirectory);
}

/** Reads the central directory only. No entry content is touched here. */
export function readDirectory(bytes, limits = DEFAULT_ZIP_LIMITS) {
  if (bytes.length > limits.maxArchiveBytes) {
    throw new ZipError(ZipRefusal.ArchiveTooLarge, `${String(bytes.length)} bytes`);
  }
  if (bytes.length < 22) throw new ZipError(ZipRefusal.NotZip, 'too short');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view, bytes);

  const entryCount = view.getUint16(eocd + 10, true);
  if (entryCount > limits.maxEntries) {
    throw new ZipError(ZipRefusal.TooManyEntries, String(entryCount));
  }
  let offset = view.getUint32(eocd + 16, true);

  const entries = [];
  const seen = new Set();
  let totalDeclared = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length) throw new ZipError(ZipRefusal.Malformed, 'directory overruns');
    if (view.getUint32(offset, true) !== CEN) {
      throw new ZipError(ZipRefusal.Malformed, 'bad central header signature');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    // Bit 0 is the encryption flag. Refused: an encrypted 3MF is not a 3MF we
    // can read, and guessing at it is worse than saying so.
    if ((flags & 0x1) !== 0) throw new ZipError(ZipRefusal.Encrypted);
    if (method !== 0 && method !== 8) {
      throw new ZipError(ZipRefusal.UnsupportedMethod, `method ${String(method)}`);
    }

    const name = new TextDecoder('utf-8', { fatal: false }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    const unsafe = describeUnsafePath(name, limits);
    if (unsafe !== undefined) throw new ZipError(ZipRefusal.UnsafePath, `${name} (${unsafe})`);

    // Case-insensitive collision check: two entries differing only in case
    // resolve to one file on a case-insensitive host, so which one wins would
    // depend on the platform.
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipError(ZipRefusal.DuplicatePath, name);
    seen.add(key);

    if (uncompressedSize > limits.maxEntryBytes) {
      throw new ZipError(ZipRefusal.EntryTooLarge, `${name} declares ${String(uncompressedSize)}`);
    }
    totalDeclared += uncompressedSize;
    if (totalDeclared > limits.maxTotalUncompressedBytes) {
      throw new ZipError(ZipRefusal.ArchiveTooLarge, 'declared total');
    }
    // THE RATIO IS CHECKED ON THE DECLARATION FIRST, so a bomb is refused before
    // a single byte is inflated. It is checked AGAIN while inflating, because a
    // declaration is only a claim.
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      throw new ZipError(
        ZipRefusal.RatioExceeded,
        `${name} declares ${(uncompressedSize / compressedSize).toFixed(0)}:1`,
      );
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, declaredUncompressedBytes: totalDeclared };
}

/** Inflates one entry, enforcing the byte budget DURING inflation. */
export async function readEntry(bytes, entry, limits = DEFAULT_ZIP_LIMITS) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localOffset;
  if (local + 30 > bytes.length) throw new ZipError(ZipRefusal.Malformed, 'local header overruns');
  const nameLength = view.getUint16(local + 26, true);
  const extraLength = view.getUint16(local + 28, true);
  const start = local + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) {
    if (compressed.length > limits.maxEntryBytes)
      throw new ZipError(ZipRefusal.EntryTooLarge, entry.name);
    return compressed;
  }

  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer
    .write(compressed)
    .then(() => writer.close())
    .catch(() => undefined);

  const reader = stream.readable.getReader();
  const chunks = [];
  let produced = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    produced += value.length;
    // THE BUDGET IS ENFORCED PER CHUNK, not after. A quadrillion-byte bomb is
    // abandoned after one chunk over budget, so peak memory stays bounded by
    // the limit rather than by whatever the archive claimed.
    if (produced > limits.maxEntryBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ZipError(ZipRefusal.EntryTooLarge, `${entry.name} exceeded while inflating`);
    }
    if (entry.compressedSize > 0 && produced / entry.compressedSize > limits.maxCompressionRatio) {
      await reader.cancel().catch(() => undefined);
      throw new ZipError(ZipRefusal.RatioExceeded, `${entry.name} exceeded while inflating`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(produced);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
