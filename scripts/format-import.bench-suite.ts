import { deflateRawSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { it } from 'vitest';
import { uncancellable } from '@cadfixer/shared';
import { distinctMeshes, documentTriangleCount } from '@cadfixer/mesh-core';
import {
  DEFAULT_IMPORT_BUDGET,
  identifyFormat,
  read3mf,
  readObj,
  type FormatReadContext,
} from '@cadfixer/file-formats';
import { documentByteLength } from '@cadfixer/geometry-runtime';

/**
 * OBJ and 3MF import, measured at realistic sizes. NOT part of CI.
 *
 * The STL pipeline benchmark answers "how long does a user wait"; this answers
 * the same question for the two formats added in Stage 4A-2B1, whose costs are
 * shaped completely differently. An OBJ is a character scan with per-part vertex
 * remapping. A 3MF is an archive that must be inflated in bounded chunks and
 * then scanned as XML, where a single triangle costs roughly ninety bytes of
 * markup rather than fifty of binary.
 *
 * WHAT THIS IS NOT. Node, not a browser, and no claim about process memory —
 * the same reasoning recorded on `pipeline.bench-suite.ts`. Memory here is
 * MODELLED from the byte lengths of the arrays actually produced, which is a
 * number that can be checked rather than scraped.
 *
 * Run with `npm run bench:formats`. Sizes: `CADFIXER_FORMAT_MB=1,10,50`.
 */

/* -------------------------------------------------------------- context -- */

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Chunked raw-DEFLATE inflation, the same shape the production worker injects. */
async function* inflateRaw(compressed: Uint8Array): AsyncIterable<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const payload = new Uint8Array(compressed.byteLength);
  payload.set(compressed);
  void writer
    .write(payload)
    .then(() => writer.close())
    .catch(() => undefined);

  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const context: FormatReadContext = {
  cancellation: uncancellable,
  budget: DEFAULT_IMPORT_BUDGET,
  progress: { report: (): void => undefined },
  yieldToEventLoop,
  decodeText: decodeUtf8,
  inflateRaw,
};

/* ------------------------------------------------------------- fixtures -- */

/**
 * An OBJ of roughly `targetBytes`, split across ten objects.
 *
 * Ten rather than one because the per-part vertex remapping is a real cost that
 * a single-object file would not exercise, and a ten-part assembly is an
 * entirely ordinary OBJ.
 */
function buildObj(targetBytes: number): { bytes: Uint8Array; triangles: number } {
  // ~60 bytes of vertex lines plus ~22 of face line, per triangle.
  const triangles = Math.max(64, Math.floor(targetBytes / 82));
  const perObject = Math.ceil(triangles / 10);

  const chunks: string[] = [];
  let emitted = 0;
  for (let object = 0; object < 10 && emitted < triangles; object += 1) {
    const count = Math.min(perObject, triangles - emitted);
    const lines: string[] = [`o Part ${String(object + 1)}`];
    for (let index = 0; index < count; index += 1) {
      const x = (index % 512) * 0.5;
      const y = Math.floor(index / 512) * 0.5;
      lines.push(`v ${x.toFixed(4)} ${y.toFixed(4)} 0.0000`);
      lines.push(`v ${(x + 0.4).toFixed(4)} ${y.toFixed(4)} 0.0000`);
      lines.push(`v ${x.toFixed(4)} ${(y + 0.4).toFixed(4)} 0.0000`);
    }
    for (let index = 0; index < count; index += 1) {
      const base = index * 3 + 1;
      lines.push(`f ${String(base)} ${String(base + 1)} ${String(base + 2)}`);
    }
    chunks.push(lines.join('\n'));
    emitted += count;
  }

  return { bytes: new TextEncoder().encode(`${chunks.join('\n')}\n`), triangles: emitted };
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

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A minimal deflate-only ZIP. Enough for the reader, and honest about cost. */
function buildZip(entries: readonly { name: string; content: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.content);
    const crc = crc32(entry.content);

    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.content.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.content.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.byteLength + compressed.byteLength;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  '</Types>';

const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rel0" Target="/3D/3dmodel.model" ' +
  'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
  '</Relationships>';

/** A 3MF whose MODEL XML is roughly `targetBytes` before compression. */
function build3mf(targetBytes: number): { bytes: Uint8Array; triangles: number; xml: number } {
  // ~130 bytes of vertex markup plus ~48 of triangle markup, per triangle.
  const triangles = Math.max(64, Math.floor(targetBytes / 178));

  const vertices: string[] = [];
  const faces: string[] = [];
  for (let index = 0; index < triangles; index += 1) {
    const x = (index % 512) * 0.5;
    const y = Math.floor(index / 512) * 0.5;
    const base = index * 3;
    vertices.push(
      `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
        `<vertex x="${(x + 0.4).toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
        `<vertex x="${x.toFixed(4)}" y="${(y + 0.4).toFixed(4)}" z="0.0000"/>`,
    );
    faces.push(
      `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`,
    );
  }

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<resources><object id="1" type="model" name="Bench"><mesh>' +
    `<vertices>${vertices.join('')}</vertices>` +
    `<triangles>${faces.join('')}</triangles>` +
    '</mesh></object></resources>' +
    '<build><item objectid="1"/></build></model>';

  const archive = buildZip([
    { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', content: Buffer.from(RELS, 'utf8') },
    { name: '3D/3dmodel.model', content: Buffer.from(xml, 'utf8') },
  ]);

  return { bytes: new Uint8Array(archive), triangles, xml: Buffer.byteLength(xml, 'utf8') };
}

/* --------------------------------------------------------------- report -- */

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function ms(value: number): string {
  return `${value.toFixed(0).padStart(6)} ms`;
}

function parseSizes(): number[] {
  const raw = process.env.CADFIXER_FORMAT_MB;
  if (raw === undefined || raw.trim().length === 0) return [1, 10, 50];
  return raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

it('measures OBJ and 3MF import across representative sizes', async () => {
  process.stdout.write(
    `\nnode ${process.version} on ${process.platform}/${process.arch}\n` +
      `run at ${new Date().toISOString()}\n\n`,
  );

  for (const sizeMb of parseSizes()) {
    const targetBytes = Math.floor(sizeMb * 1024 * 1024);

    /* --- OBJ ------------------------------------------------------- */
    const obj = buildObj(targetBytes);
    const objIdStart = performance.now();
    const objFormat = identifyFormat(obj.bytes, 'bench.obj');
    const objIdMs = performance.now() - objIdStart;

    const objStart = performance.now();
    const objResult = await readObj(obj.bytes, context);
    const objMs = performance.now() - objStart;

    process.stdout.write(
      `=== OBJ ~${String(sizeMb)} MiB (${mib(obj.bytes.byteLength)} actual, ` +
        `${obj.triangles.toLocaleString()} triangles) ===\n` +
        `  identify                 ${ms(objIdMs)}  -> ${objFormat.formatId} (${objFormat.evidence})\n` +
        `  parse                    ${ms(objMs)}\n` +
        `  parts                    ${objResult.document.parts.length.toLocaleString()}\n` +
        `  distinct meshes          ${distinctMeshes(objResult.document).length.toLocaleString()}\n` +
        `  triangles                ${documentTriangleCount(objResult.document).toLocaleString()}\n` +
        `  resident geometry        ${mib(documentByteLength(objResult.document))}\n` +
        `  throughput               ${(obj.bytes.byteLength / 1024 / 1024 / (objMs / 1000)).toFixed(1)} MiB/s\n\n`,
    );

    /* --- 3MF ------------------------------------------------------- */
    const threeMf = build3mf(targetBytes);
    const mfIdStart = performance.now();
    const mfFormat = identifyFormat(threeMf.bytes, 'bench.3mf');
    const mfIdMs = performance.now() - mfIdStart;

    const mfStart = performance.now();
    const mfResult = await read3mf(threeMf.bytes, context);
    const mfMs = performance.now() - mfStart;

    process.stdout.write(
      `=== 3MF ~${String(sizeMb)} MiB of XML (${mib(threeMf.xml)} XML, ` +
        `${mib(threeMf.bytes.byteLength)} archive, ${threeMf.triangles.toLocaleString()} triangles) ===\n` +
        `  identify                 ${ms(mfIdMs)}  -> ${mfFormat.formatId} (${mfFormat.evidence})\n` +
        `  inflate + scan + build   ${ms(mfMs)}\n` +
        `  parts                    ${mfResult.document.parts.length.toLocaleString()}\n` +
        `  triangles                ${documentTriangleCount(mfResult.document).toLocaleString()}\n` +
        `  resident geometry        ${mib(documentByteLength(mfResult.document))}\n` +
        `  compression              ${(threeMf.xml / threeMf.bytes.byteLength).toFixed(1)}:1\n` +
        `  throughput (XML)         ${(threeMf.xml / 1024 / 1024 / (mfMs / 1000)).toFixed(1)} MiB/s\n\n`,
    );
  }
}, 900_000);
