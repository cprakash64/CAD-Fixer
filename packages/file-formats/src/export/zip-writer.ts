import { ExportRefusal, exportTooLarge } from './export-errors';

/**
 * THE PRODUCTION ZIP WRITER.
 *
 * Dependency-free, and it writes exactly one shape of archive: a small fixed
 * list of deflate entries with a local header each, a central directory, and an
 * end-of-central-directory record. No ZIP64, no encryption, no data descriptors,
 * no directory entries, no extra fields.
 *
 * ENTRY PATHS COME FROM A FIXED LIST DECIDED BY THE CALLER, never from document
 * data. That is what stops a part named `../../evil` from becoming a file: it
 * is not that such a name is escaped, it is that no name reaches this at all.
 * `describeUnsafePath` in the reader is the belt; this is the braces.
 *
 * Every archive it produces must be readable by OUR OWN reader under the same
 * rules an imported file faces — deflate or stored, no encryption flag, safe
 * paths, sizes that match. A writer whose output our reader would refuse is a
 * writer that has produced a file the user cannot open.
 */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Deflate method 8. Stored (0) is never chosen: our reader accepts both. */
const METHOD_DEFLATE = 8;
/** PKZip 2.0, the version that introduced deflate. Nothing later is used. */
const VERSION = 20;

export interface ZipWriteEntry {
  /** A FIXED path chosen by the caller. Never derived from document data. */
  readonly name: string;
  readonly content: Uint8Array;
}

export interface ZipWriteOptions {
  /** Raw DEFLATE, chunked, injected by the host. */
  readonly deflateRaw: (bytes: Uint8Array) => AsyncIterable<Uint8Array>;
  /** Ceiling on the finished archive. Checked while it is being built. */
  readonly maxOutputBytes: number;
  readonly throwIfCancelled?: () => void;
}

/**
 * Compresses one entry, refusing before the budget is exceeded.
 *
 * The check is on the PROSPECTIVE total, exactly as the reader's inflation
 * budget is, and for the same reason: accounting first and refusing afterwards
 * makes the real peak one chunk larger than the ceiling claims.
 */
async function deflateBounded(
  bytes: Uint8Array,
  options: ZipWriteOptions,
  alreadyProduced: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let produced = 0;

  for await (const chunk of options.deflateRaw(bytes)) {
    if (alreadyProduced + produced + chunk.byteLength > options.maxOutputBytes) {
      throw exportTooLarge(
        ExportRefusal.OutputTooLarge,
        'This export would produce a larger file than CAD Fixer will write.',
        { limit: options.maxOutputBytes },
      );
    }
    produced += chunk.byteLength;
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

export async function buildZipArchive(
  entries: readonly ZipWriteEntry[],
  options: ZipWriteOptions,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = entry.content;
    const payload = await deflateBounded(raw, options, offset);
    const crc = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.byteLength + payload.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, VERSION, true);
    // Flags 0: not encrypted, no data descriptor, no UTF-8 name flag needed for
    // the ASCII paths this writer uses.
    localView.setUint16(6, 0, true);
    localView.setUint16(8, METHOD_DEFLATE, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.byteLength, true);
    localView.setUint32(22, raw.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, VERSION, true);
    centralView.setUint16(6, VERSION, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, METHOD_DEFLATE, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, payload.byteLength, true);
    centralView.setUint32(24, raw.byteLength, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.byteLength;
    options.throwIfCancelled?.();
  }

  let centralSize = 0;
  for (const central of centrals) centralSize += central.byteLength;

  const total = offset + centralSize + 22;
  if (total > options.maxOutputBytes) {
    throw exportTooLarge(
      ExportRefusal.OutputTooLarge,
      'This export would produce a larger file than CAD Fixer will write.',
      { produced: total, limit: options.maxOutputBytes },
    );
  }

  /*
   * NO ZIP64, AND THAT IS CHECKED RATHER THAN ASSUMED. Every size and offset
   * field here is 32 bits; an archive past four gigabytes would silently wrap
   * and produce a directory pointing at the wrong bytes. The output ceiling is
   * far below that, so this can only fire if someone raises the ceiling without
   * adding ZIP64 — which is exactly when it should.
   */
  if (total > 0xffffffff || offset > 0xffffffff) {
    throw exportTooLarge(
      ExportRefusal.OutputTooLarge,
      'This export is too large for the archive format CAD Fixer writes.',
      { produced: total },
    );
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const out = new Uint8Array(total);
  let at = 0;
  for (const local of locals) {
    out.set(local, at);
    at += local.byteLength;
  }
  for (const central of centrals) {
    out.set(central, at);
    at += central.byteLength;
  }
  out.set(eocd, at);
  return out;
}
