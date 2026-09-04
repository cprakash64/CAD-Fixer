/**
 * Stage 4A-1 — hostile ZIP fixtures, built byte by byte. RESEARCH ONLY.
 *
 * Hand-authored rather than produced by a ZIP library, because a library will
 * not write the archives that matter here: it refuses to emit a traversal path,
 * it will not lie about a size, and it has no reason to produce a 1000:1 ratio.
 * The attacks have to be constructed deliberately.
 */
/**
 * ISOMORPHIC BY CONSTRUCTION. `CompressionStream` exists in both Node and every
 * target browser, so the same fixtures build in both places and the ZIP reader
 * can be shown to behave identically. A Node-only `zlib` import would have made
 * the browser half of this qualification impossible.
 */
async function deflateRaw(bytes) {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(bytes).then(() => writer.close());
  const chunks = [];
  const reader = stream.readable.getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Builds an archive. Every field is settable so a fixture can LIE — declaring a
 * size or ratio that does not match its own bytes is exactly the attack a real
 * reader must survive.
 */
export async function buildZip(entries, options = {}) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const raw = typeof entry.content === 'string' ? enc.encode(entry.content) : entry.content;
    const deflate = entry.method === 8;
    const payload = deflate ? await deflateRaw(raw) : raw;

    const declaredUncompressed = entry.declaredUncompressedSize ?? raw.length;
    const declaredCompressed = entry.declaredCompressedSize ?? payload.length;
    const flags = entry.flags ?? 0;

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, entry.method ?? 0, true);
    lv.setUint32(14, crc32(raw), true);
    lv.setUint32(18, declaredCompressed, true);
    lv.setUint32(22, declaredUncompressed, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, entry.method ?? 0, true);
    cv.setUint32(16, crc32(raw), true);
    cv.setUint32(20, declaredCompressed, true);
    cv.setUint32(24, declaredUncompressed, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, options.declaredEntryCount ?? entries.length, true);
  ev.setUint16(10, options.declaredEntryCount ?? entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const l of locals) {
    out.set(l, at);
    at += l.length;
  }
  for (const c of centrals) {
    out.set(c, at);
    at += c.length;
  }
  out.set(eocd, at);
  return out;
}

/** A genuine compression bomb: 64 MiB of zeros, which deflates to a few KiB. */
export async function compressionBomb() {
  return buildZip([
    { name: '3D/3dmodel.model', method: 8, content: new Uint8Array(64 * 1024 * 1024) },
  ]);
}

export const MINIMAL_3MF_MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>
     <vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
     <triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
    </triangles>
   </mesh>
  </object>
 </resources>
 <build><item objectid="1"/></build>
</model>`;

export const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

export const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/** A well-formed, minimal, valid 3MF. The control case. */
export async function valid3mf(model = MINIMAL_3MF_MODEL) {
  return buildZip([
    { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
    { name: '_rels/.rels', method: 8, content: RELS },
    { name: '3D/3dmodel.model', method: 8, content: model },
  ]);
}
