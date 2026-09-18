/**
 * HOSTILE AND VALID ZIP FIXTURES, built byte by byte. TEST-ONLY.
 *
 * Hand-authored rather than produced by a ZIP library, because a library will
 * not write the archives that matter here: it refuses to emit a traversal path,
 * it will not lie about a declared size, and it has no reason to produce a
 * 1000:1 ratio. The attacks have to be constructed deliberately.
 *
 * Ported from `experiments/format-io/zip-fixtures.mjs`, the corpus the Stage 4A
 * research refused 18/18 of, so production is tested against the same archives
 * rather than against a fresh set that might be easier.
 *
 * Not exported from the package index, and no production path imports it.
 */

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  /*
   * COPIED INTO A PLAIN `ArrayBuffer` VIEW. Under the application's DOM lib the
   * real `WritableStream.write` requires an `ArrayBufferView<ArrayBuffer>`, and
   * a `Uint8Array` over `ArrayBufferLike` may be backed by a
   * `SharedArrayBuffer`. Fixtures are small; the copy costs nothing.
   */
  const payload = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  payload.set(bytes);
  void writer
    .write(payload)
    .then(() => writer.close())
    .catch(() => undefined);

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

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

export interface ZipFixtureEntry {
  readonly name: string;
  readonly content: string | Uint8Array;
  /** 0 stored, 8 deflate. */
  readonly method?: number;
  /** Bit 0 set marks the entry encrypted. */
  readonly flags?: number;
  /** Overrides the real size, so a fixture can LIE about what it holds. */
  readonly declaredUncompressedSize?: number;
  readonly declaredCompressedSize?: number;
}

export interface ZipFixtureOptions {
  /** Overrides the EOCD entry count, independently of the real one. */
  readonly declaredEntryCount?: number;
  /**
   * Writes the archive the way Bambu Studio and OrcaSlicer write theirs: every
   * size and offset replaced by the `0xFFFFFFFF` sentinel, the real values in a
   * Zip64 extended-information extra field, and a Zip64 end-of-central-directory
   * record and locator before the EOCD.
   *
   * NOT A LARGE-ARCHIVE OPTION. Zip64 exists for archives past four gibibytes,
   * but a writer may emit it at any size — and Stage 6D-A3's producer corpus
   * found two mainstream slicers doing so in packages of a few hundred
   * kilobytes. A fixture of a few hundred bytes reproduces it exactly.
   */
  readonly zip64?: boolean;
  /**
   * Writes the Zip64 sentinels and the records, but omits the extra field that
   * is supposed to carry the real values.
   *
   * The malformed case: an entry that promises a 64-bit size it does not carry.
   */
  readonly zip64WithoutExtra?: boolean;
}

/**
 * Builds an archive.
 *
 * Every field is settable so a fixture can lie: declaring a size or a ratio
 * that does not match its own bytes is exactly the attack a bounded reader must
 * survive, and no honest builder would produce it.
 */
export async function buildZip(
  entries: readonly ZipFixtureEntry[],
  options: ZipFixtureOptions = {},
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
    const method = entry.method ?? 0;
    const payload = method === 8 ? await deflateRaw(raw) : raw;

    const declaredUncompressed = entry.declaredUncompressedSize ?? raw.byteLength;
    const declaredCompressed = entry.declaredCompressedSize ?? payload.byteLength;
    const flags = entry.flags ?? 0;

    const local = new Uint8Array(30 + nameBytes.byteLength + payload.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc32(raw), true);
    localView.setUint32(18, declaredCompressed, true);
    localView.setUint32(22, declaredUncompressed, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.byteLength);
    locals.push(local);

    /*
     * ZIP64 REPLACES THE THREE 32-BIT FIELDS WITH SENTINELS and carries the
     * real values, in the order uncompressed, compressed, local offset, in a
     * tag-1 extra field. `zip64WithoutExtra` writes the sentinels and no extra
     * field at all, which is the malformed shape a reader must refuse rather
     * than read as four gibibytes.
     */
    const wantsZip64 = options.zip64 === true || options.zip64WithoutExtra === true;
    const extraBytes = options.zip64 === true ? 4 + 24 : 0;
    const central = new Uint8Array(46 + nameBytes.byteLength + extraBytes);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 45, true);
    centralView.setUint16(6, 45, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc32(raw), true);
    centralView.setUint32(20, wantsZip64 ? 0xffffffff : declaredCompressed, true);
    centralView.setUint32(24, wantsZip64 ? 0xffffffff : declaredUncompressed, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint16(30, extraBytes, true);
    centralView.setUint32(42, wantsZip64 ? 0xffffffff : offset, true);
    central.set(nameBytes, 46);
    if (options.zip64 === true) {
      const at = 46 + nameBytes.byteLength;
      centralView.setUint16(at, 0x0001, true);
      centralView.setUint16(at + 2, 24, true);
      setUint64(centralView, at + 4, declaredUncompressed);
      setUint64(centralView, at + 12, declaredCompressed);
      setUint64(centralView, at + 20, offset);
    }
    centrals.push(central);

    offset += local.byteLength;
  }

  const centralSize = centrals.reduce((total, entry) => total + entry.byteLength, 0);
  const zip64 = options.zip64 === true || options.zip64WithoutExtra === true;
  const tail = zip64 ? 56 + 20 + 22 : 22;

  const out = new Uint8Array(offset + centralSize + tail);
  let at = 0;
  for (const local of locals) {
    out.set(local, at);
    at += local.byteLength;
  }
  const centralStart = at;
  for (const central of centrals) {
    out.set(central, at);
    at += central.byteLength;
  }

  const view = new DataView(out.buffer);
  if (zip64) {
    // Zip64 end of central directory record: 56 bytes for version 1.
    const record = at;
    view.setUint32(record, 0x06064b50, true);
    setUint64(view, record + 4, 44);
    view.setUint16(record + 12, 45, true);
    view.setUint16(record + 14, 45, true);
    setUint64(view, record + 24, entries.length);
    setUint64(view, record + 32, entries.length);
    setUint64(view, record + 40, centralSize);
    setUint64(view, record + 48, centralStart);
    at += 56;

    // Zip64 end of central directory locator.
    view.setUint32(at, 0x07064b50, true);
    setUint64(view, at + 8, record);
    view.setUint32(at + 16, 1, true);
    at += 20;
  }

  view.setUint32(at, 0x06054b50, true);
  const declared = options.declaredEntryCount ?? entries.length;
  view.setUint16(at + 8, zip64 ? 0xffff : declared, true);
  view.setUint16(at + 10, zip64 ? 0xffff : declared, true);
  view.setUint32(at + 12, zip64 ? 0xffffffff : centralSize, true);
  view.setUint32(at + 16, zip64 ? 0xffffffff : centralStart, true);
  return out;
}

/** A 64-bit little-endian write, in two halves. Fixtures never need BigInt. */
function setUint64(view: DataView, at: number, value: number): void {
  view.setUint32(at, value >>> 0, true);
  view.setUint32(at + 4, Math.floor(value / 0x1_0000_0000), true);
}

export const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

export const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/** A closed tetrahedron: four faces, no defects. The control geometry. */
export const TETRAHEDRON_MESH = `<mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>
     <vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
     <triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
    </triangles>
   </mesh>`;

export interface ModelXmlOptions {
  readonly unit?: string;
  /** Raw `<object>` elements. Defaults to one tetrahedron with id 1. */
  readonly resources?: string;
  /** Raw `<item>` elements. Defaults to one item on object 1. */
  readonly build?: string;
  /** Extra text placed before `<model>`, for prolog attacks. */
  readonly prolog?: string;
}

export function modelXml(options: ModelXmlOptions = {}): string {
  const unit = options.unit === undefined ? '' : ` unit="${options.unit}"`;
  const resources = options.resources ?? `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`;
  const build = options.build ?? '<item objectid="1"/>';
  return `<?xml version="1.0" encoding="UTF-8"?>
${options.prolog ?? ''}<model${unit} xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>${resources}</resources>
 <build>${build}</build>
</model>`;
}

/** A well-formed, minimal 3MF around the given model XML. The control case. */
export async function valid3mf(
  model: string = modelXml({ unit: 'millimeter' }),
): Promise<Uint8Array> {
  return buildZip([
    { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
    { name: '_rels/.rels', method: 8, content: RELS },
    { name: '3D/3dmodel.model', method: 8, content: model },
  ]);
}

/** A genuine compression bomb: 64 MiB of zeros, which deflates to a few KiB. */
export async function compressionBomb(): Promise<Uint8Array> {
  return buildZip([
    { name: '3D/3dmodel.model', method: 8, content: new Uint8Array(64 * 1024 * 1024) },
  ]);
}
