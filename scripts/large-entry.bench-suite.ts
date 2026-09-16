import { deflateRawSync } from 'node:zlib';
import { constants as bufferConstants } from 'node:buffer';
import { getHeapStatistics } from 'node:v8';
import { performance } from 'node:perf_hooks';
import { it } from 'vitest';
import { uncancellable } from '@cadfixer/shared';
import {
  assertGeometryDocument,
  assertMeshStructure,
  distinctMeshes,
  documentTriangleCount,
} from '@cadfixer/mesh-core';
import {
  DEFAULT_3MF_LIMITS,
  DEFAULT_IMPORT_BUDGET,
  DEFAULT_XML_LIMITS,
  DEFAULT_ZIP_LIMITS,
  createInflationBudget,
  describeUnsafeXml,
  parseModelXml,
  read3mf,
  readZipDirectory,
  readZipEntry,
  type FormatReadContext,
  type ZipLimits,
} from '@cadfixer/file-formats';

/**
 * STAGE 6D DIAGNOSTIC — the memory lifetime of ONE large 3MF model entry.
 *
 * NOT PART OF CI, NOT PART OF THE PRODUCT. This exists to answer a single
 * architectural question with numbers instead of intuition: what does a 3MF
 * whose model part expands to a few hundred mebibytes actually cost, and which
 * of those costs are simultaneous rather than sequential.
 *
 * It measures the production path — `readZipDirectory`, `readZipEntry`,
 * `TextDecoder`, `parseModelXml` — stage by stage, with the intermediate
 * values deliberately held alive so the reported peak is the real one rather
 * than whatever the collector happened to have reclaimed.
 *
 * Run with `npm run bench:large-entry`. Sizes: `CADFIXER_ENTRY_MB=128,256,297`.
 * NOTHING IS WRITTEN TO DISK; the fixture is synthesised in memory each run.
 */

/* ------------------------------------------------------------ platform -- */

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

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

/* ----------------------------------------------------------- measuring -- */

interface Sample {
  readonly label: string;
  readonly rss: number;
  readonly heapUsed: number;
  readonly arrayBuffers: number;
  readonly at: number;
}

/**
 * The metric this harness actually trusts.
 *
 * RSS ON macOS IS NOT A PEAK. The allocator returns pages lazily and the kernel
 * accounts them lazily again, so a 250 MiB buffer that is allocated and freed
 * inside one stage can leave RSS looking flat. `heapUsed + arrayBuffers` is the
 * sum of what V8 says it is holding right now — on-heap objects (JS strings and
 * `number[]` backing stores) plus off-heap typed-array memory — which is
 * exactly the quantity an architecture decision needs. RSS is still reported
 * beside it, as corroboration rather than as the number.
 */
function held(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

const samples: Sample[] = [];

function sample(label: string): Sample {
  const usage = process.memoryUsage();
  const entry: Sample = {
    label,
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    arrayBuffers: usage.arrayBuffers,
    at: performance.now(),
  };
  samples.push(entry);
  return entry;
}

/**
 * Runs one stage while sampling what is held, and reports the stage's own peak.
 *
 * The sampler is a timer, so it only sees a synchronous stage at its
 * boundaries. `parseModelXml` is synchronous by design and its peak is
 * therefore reconstructed from the before/after readings plus the known
 * allocation shape; the inflate stage is genuinely asynchronous and IS sampled
 * through, which is the one that matters — it is where the duplication is.
 */
async function timed<T>(
  label: string,
  run: () => Promise<T> | T,
): Promise<{ value: T; ms: number; peakHeld: number; floorHeld: number }> {
  global.gc?.();
  const floor = held();
  let peak = floor;
  const ticker = setInterval(() => {
    peak = Math.max(peak, held());
  }, 4);
  const started = performance.now();
  try {
    const value = await run();
    // READ SYNCHRONOUSLY ON THE WAY OUT, not only from the timer. A 4 ms timer
    // cannot fire inside a synchronous span, and `parseModelXml` is one long
    // synchronous span — relying on the timer alone reported peaks BELOW
    // readings the loop body had already taken.
    peak = Math.max(peak, held());
    return { value, ms: performance.now() - started, peakHeld: peak, floorHeld: floor };
  } finally {
    clearInterval(ticker);
    sample(label);
  }
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).padStart(8);
}

/* ------------------------------------------------------------ fixtures -- */

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

function buildZip(entries: readonly { name: string; content: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.content, { level: 6 });
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

const HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
  '<resources><object id="1" type="model" name="Large"><mesh><vertices>';

const MID = '</vertices><triangles>';
const TAIL = '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>';

/**
 * A 3MF model entry of a chosen UNCOMPRESSED size, built straight into a
 * Buffer.
 *
 * Built block by block rather than by joining strings: a 384 MiB model
 * assembled through `Array.join` costs the array, the joined string AND the
 * encoded bytes at once, which would make the generator's own peak larger than
 * the thing being measured.
 */
function buildLargeModelXml(targetBytes: number): { buffer: Buffer; triangles: number } {
  const vertexBlock = (index: number): string => {
    const x = (index % 512) * 0.5;
    const y = Math.floor(index / 512) * 0.5;
    return (
      `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
      `<vertex x="${(x + 0.4).toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
      `<vertex x="${x.toFixed(4)}" y="${(y + 0.4).toFixed(4)}" z="0.0000"/>`
    );
  };
  const faceBlock = (index: number): string => {
    const base = index * 3;
    return `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`;
  };

  /*
   * SOLVED AGAINST THE LARGEST INDEX, then re-solved once.
   *
   * Block width grows with the index — `732.0000` is two characters wider than
   * `0.0000`, and a seven-digit vertex index one wider than a six-digit one —
   * so a count solved from a block sampled early UNDERCOUNTS the bytes and
   * overruns the buffer. Sizing from the last block and iterating once
   * converges from above, which is the safe direction.
   */
  const overhead = Buffer.byteLength(HEAD + MID + TAIL, 'utf8');
  const costAt = (index: number): number =>
    Buffer.byteLength(vertexBlock(index), 'utf8') + Buffer.byteLength(faceBlock(index), 'utf8');
  let triangles = Math.max(64, Math.floor((targetBytes - overhead) / costAt(100_000)));
  triangles = Math.max(64, Math.floor((targetBytes - overhead) / costAt(triangles)));

  const out = Buffer.allocUnsafe(targetBytes + 4 * 1024 * 1024);
  let at = out.write(HEAD, 0, 'utf8');

  const BATCH = 4096;
  for (let index = 0; index < triangles; index += BATCH) {
    const upto = Math.min(index + BATCH, triangles);
    let block = '';
    for (let n = index; n < upto; n += 1) block += vertexBlock(n);
    at += out.write(block, at, 'utf8');
  }
  at += out.write(MID, at, 'utf8');
  for (let index = 0; index < triangles; index += BATCH) {
    const upto = Math.min(index + BATCH, triangles);
    let block = '';
    for (let n = index; n < upto; n += 1) block += faceBlock(n);
    at += out.write(block, at, 'utf8');
  }
  at += out.write(TAIL, at, 'utf8');

  return { buffer: out.subarray(0, at), triangles };
}

/* -------------------------------------------------------------- suites -- */

function parseSizes(): number[] {
  const raw = process.env.CADFIXER_ENTRY_MB;
  if (raw === undefined || raw.trim().length === 0) return [128];
  return raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

/** Limits identical to production except for the one ceiling under study. */
function limitsWithEntryCap(maxEntryBytes: number): ZipLimits {
  return {
    ...DEFAULT_ZIP_LIMITS,
    maxEntryBytes,
    maxTotalUncompressedBytes: Math.max(
      DEFAULT_ZIP_LIMITS.maxTotalUncompressedBytes,
      maxEntryBytes + 64 * 1024,
    ),
  };
}

it('measures the memory lifetime of one large 3MF model entry', async () => {
  process.stdout.write(
    `\nnode ${process.version} on ${process.platform}/${process.arch}\n` +
      `heap limit ${mib(getHeapStatistics().heap_size_limit)} MiB, ` +
      `V8 max string ${mib(bufferConstants.MAX_STRING_LENGTH)} MiB\n` +
      `run at ${new Date().toISOString()}\n`,
  );

  for (const sizeMb of parseSizes()) {
    samples.length = 0;
    const targetBytes = Math.floor(sizeMb * 1024 * 1024);

    global.gc?.();
    const baselineHeld = held();
    sample('baseline');

    const built = buildLargeModelXml(targetBytes);
    const archive = buildZip([
      { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
      { name: '_rels/.rels', content: Buffer.from(RELS, 'utf8') },
      { name: '3D/3dmodel.model', content: built.buffer },
    ]);
    const bytes = new Uint8Array(archive);
    const entryBytes = built.buffer.byteLength;
    const archiveBytes = bytes.byteLength;
    const limits = limitsWithEntryCap(Math.max(entryBytes + 1024, 256 * 1024 * 1024));

    global.gc?.();
    const fixtureHeld = held();
    sample('fixture built');

    process.stdout.write(
      `\n\u2500\u2500 entry ${(entryBytes / (1024 * 1024)).toFixed(1)} MiB uncompressed, ` +
        `archive ${(archiveBytes / (1024 * 1024)).toFixed(1)} MiB on disk, ` +
        `ratio ${(entryBytes / archiveBytes).toFixed(1)}:1, ` +
        `${built.triangles.toLocaleString('en-US')} triangles \u2500\u2500\n`,
    );

    /* -- stage 1: central directory ----------------------------------- */
    const directory = await timed('after readZipDirectory', () => {
      const entries = readZipDirectory(bytes, limits);
      const modelEntry = entries.find((entry) => entry.name.toLowerCase() === '3d/3dmodel.model');
      if (modelEntry === undefined) throw new Error('fixture lost its model part');
      return modelEntry;
    });

    /* -- stage 2: inflate --------------------------------------------- */
    const inflated = await timed('after readZipEntry', () =>
      readZipEntry(bytes, directory.value, {
        limits,
        inflateRaw,
        budget: createInflationBudget(limits),
      }),
    );
    const modelBytes = inflated.value;

    /* -- stage 3: decode ---------------------------------------------- */
    const decoded = await timed('after decodeText', () => decodeUtf8(modelBytes));
    const xml = decoded.value;

    /* -- stage 4: parse ----------------------------------------------- */
    const parsed = await timed('after parseModelXml', () =>
      parseModelXml(xml, DEFAULT_3MF_LIMITS, DEFAULT_XML_LIMITS),
    );
    const object = parsed.value.objects.get('1');
    const positionsLength = object === undefined ? 0 : object.positions.length;
    const trianglesLength = object === undefined ? 0 : object.triangles.length;

    for (const line of samples) {
      process.stdout.write(
        `   ${line.label.padEnd(26)} held ${mib(line.heapUsed + line.arrayBuffers)}  ` +
          `(heap ${mib(line.heapUsed)} + ab ${mib(line.arrayBuffers)})  rss ${mib(line.rss)}\n`,
      );
    }
    process.stdout.write(
      `   stage peaks HELD, over the fixture-built reading of ` +
        `${(fixtureHeld / (1024 * 1024)).toFixed(1)} MiB:\n` +
        `      readZipDirectory  ${mib(directory.peakHeld - fixtureHeld)} MiB  ` +
        `${directory.ms.toFixed(0)} ms\n` +
        `      readZipEntry      ${mib(inflated.peakHeld - fixtureHeld)} MiB  ` +
        `${inflated.ms.toFixed(0)} ms   ` +
        `= ${((inflated.peakHeld - fixtureHeld) / entryBytes).toFixed(2)}x the entry\n` +
        `      decodeText        ${mib(decoded.peakHeld - fixtureHeld)} MiB  ` +
        `${decoded.ms.toFixed(0)} ms   ` +
        `= ${((decoded.peakHeld - fixtureHeld) / entryBytes).toFixed(2)}x the entry\n` +
        `      parseModelXml     ${mib(parsed.peakHeld - fixtureHeld)} MiB  ` +
        `${parsed.ms.toFixed(0)} ms   ` +
        `= ${((parsed.peakHeld - fixtureHeld) / entryBytes).toFixed(2)}x the entry\n`,
    );
    process.stdout.write(
      `   scratch number[] after parse: positions ${positionsLength.toLocaleString('en-US')}, ` +
        `triangles ${trianglesLength.toLocaleString('en-US')} ` +
        `(\u2248 ${((positionsLength * 8 + trianglesLength * 8) / (1024 * 1024)).toFixed(1)} MiB ` +
        `if every element is a double)\n` +
        `   baseline held ${(baselineHeld / (1024 * 1024)).toFixed(1)} MiB, ` +
        `fixture held ${(fixtureHeld / (1024 * 1024)).toFixed(1)} MiB\n`,
    );

    // Held to the end on purpose: a collector that reclaims these mid-run would
    // report a peak that the real import never enjoys.
    void [modelBytes.byteLength, xml.length, positionsLength, trianglesLength];
  }
}, 1_800_000);

it('measures the whole read3mf path end to end', async () => {
  for (const sizeMb of parseSizes()) {
    const targetBytes = Math.floor(sizeMb * 1024 * 1024);
    global.gc?.();

    const built = buildLargeModelXml(targetBytes);
    const entryBytes = built.buffer.byteLength;
    const archive = buildZip([
      { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
      { name: '_rels/.rels', content: Buffer.from(RELS, 'utf8') },
      { name: '3D/3dmodel.model', content: built.buffer },
    ]);
    const bytes = new Uint8Array(archive);
    global.gc?.();
    const fixtureHeld = held();

    let peak = fixtureHeld;
    let peakRss = process.memoryUsage().rss;
    const ticker = setInterval(() => {
      peak = Math.max(peak, held());
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 4);

    const started = performance.now();
    let outcome: string;
    let triangles = 0;
    let meshes = 0;
    try {
      const result = await read3mf(bytes, context, {
        zipLimits: limitsWithEntryCap(Math.max(entryBytes + 1024, 256 * 1024 * 1024)),
      });
      triangles = documentTriangleCount(result.document);
      meshes = [...distinctMeshes(result.document)].length;
      outcome = 'imported';
    } catch (error) {
      outcome = `refused: ${error instanceof Error ? error.message.slice(0, 110) : 'unknown'}`;
    }
    const elapsed = performance.now() - started;
    clearInterval(ticker);
    peak = Math.max(peak, held());

    process.stdout.write(
      `\n\u2500\u2500 read3mf, entry ${(entryBytes / (1024 * 1024)).toFixed(1)} MiB: ${outcome}\n` +
        `   ${triangles.toLocaleString('en-US')} triangles in ${String(meshes)} mesh(es), ` +
        `${elapsed.toFixed(0)} ms\n` +
        `   held: fixture ${(fixtureHeld / (1024 * 1024)).toFixed(1)} MiB, ` +
        `peak during read ${(peak / (1024 * 1024)).toFixed(1)} MiB, ` +
        `peak rss ${(peakRss / (1024 * 1024)).toFixed(1)} MiB\n` +
        `   import cost over fixture: ${((peak - fixtureHeld) / (1024 * 1024)).toFixed(1)} MiB ` +
        `= ${((peak - fixtureHeld) / entryBytes).toFixed(2)}x the entry\n`,
    );
  }
}, 1_800_000);

/* ------------------------------------------------- what the shape costs -- */

/**
 * WHAT EACH DUPLICATION COSTS, measured against the production path.
 *
 * Written in Stage 6D as prototypes of changes not yet made. Since Stage
 * 6D-B1 the FIRST of them has shipped: `readZipEntry` fills one preallocated
 * destination, so the `current` variant and the `single` prototype now measure
 * the same shape and should agree — which is the cheapest possible check that
 * production actually got what the prototype promised. The `stream` variant
 * remains a prototype and is the Track B-2 floor.
 */

/** Inflate straight into ONE buffer sized from the directory's declaration. */
async function inflateSingleAllocation(
  compressed: Uint8Array,
  declaredSize: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(declaredSize);
  let at = 0;
  for await (const chunk of inflateRaw(compressed)) {
    // A DECLARATION IS A CLAIM, so output beyond it is refused rather than
    // grown into. This is the check the chunk-list shape gets for free and a
    // preallocated one has to make explicitly.
    if (at + chunk.byteLength > declaredSize) throw new Error('entry exceeded its declared size');
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  if (at !== declaredSize) throw new Error('entry fell short of its declared size');
  return out;
}

/** Inflate and decode without ever retaining either whole representation. */
async function streamingFloor(
  compressed: Uint8Array,
): Promise<{ bytes: number; characters: number }> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let bytes = 0;
  let characters = 0;
  for await (const chunk of inflateRaw(compressed)) {
    bytes += chunk.byteLength;
    // Decoded and immediately discarded. A real streaming reader would hand
    // this to a resumable scanner; what it would NOT do is keep it.
    characters += decoder.decode(chunk, { stream: true }).length;
  }
  characters += decoder.decode().length;
  return { bytes, characters };
}

it('measures what removing each duplication would be worth', async () => {
  for (const sizeMb of parseSizes()) {
    const targetBytes = Math.floor(sizeMb * 1024 * 1024);
    global.gc?.();

    const built = buildLargeModelXml(targetBytes);
    const entryBytes = built.buffer.byteLength;
    const archive = buildZip([
      { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
      { name: '_rels/.rels', content: Buffer.from(RELS, 'utf8') },
      { name: '3D/3dmodel.model', content: built.buffer },
    ]);
    const bytes = new Uint8Array(archive);
    const limits = limitsWithEntryCap(Math.max(entryBytes + 1024, 256 * 1024 * 1024));
    const entries = readZipDirectory(bytes, limits);
    const modelEntry = entries.find((entry) => entry.name.toLowerCase() === '3d/3dmodel.model');
    if (modelEntry === undefined) throw new Error('fixture lost its model part');

    // The compressed span, located the way `readZipEntry` locates it.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nameLength = view.getUint16(modelEntry.localOffset + 26, true);
    const extraLength = view.getUint16(modelEntry.localOffset + 28, true);
    const start = modelEntry.localOffset + 30 + nameLength + extraLength;
    const compressed = bytes.subarray(start, start + modelEntry.compressedSize);

    process.stdout.write(
      `\n── shape cost, entry ${(entryBytes / (1024 * 1024)).toFixed(1)} MiB ──\n`,
    );

    const variant = process.env.CADFIXER_SHAPE ?? 'all';
    if (variant === 'all' || variant === 'current') {
      const current = await timed('current readZipEntry', () =>
        readZipEntry(bytes, modelEntry, {
          limits,
          inflateRaw,
          budget: createInflationBudget(limits),
        }),
      );
      process.stdout.write(
        `   production readZipEntry   floor ${mib(current.floorHeld)} peak ${mib(current.peakHeld)} MiB  ` +
          `${current.ms.toFixed(0)} ms  = ${((current.peakHeld - current.floorHeld) / entryBytes).toFixed(2)}x\n`,
      );
      void current.value.byteLength;
    }

    if (variant === 'all' || variant === 'single') {
      const single = await timed('single-allocation inflate', () =>
        inflateSingleAllocation(compressed, modelEntry.uncompressedSize),
      );
      process.stdout.write(
        `   one preallocated buffer  floor ${mib(single.floorHeld)} peak ${mib(single.peakHeld)} MiB  ` +
          `${single.ms.toFixed(0)} ms  = ${((single.peakHeld - single.floorHeld) / entryBytes).toFixed(2)}x\n`,
      );
      void single.value.byteLength;
    }

    if (variant === 'all' || variant === 'stream') {
      const streamed = await timed('streaming floor', () => streamingFloor(compressed));
      process.stdout.write(
        `   inflate+decode, keep none floor ${mib(streamed.floorHeld)} peak ${mib(streamed.peakHeld)} MiB  ` +
          `${streamed.ms.toFixed(0)} ms  = ${((streamed.peakHeld - streamed.floorHeld) / entryBytes).toFixed(2)}x` +
          `  (${streamed.value.bytes.toLocaleString('en-US')} bytes, ` +
          `${streamed.value.characters.toLocaleString('en-US')} characters)\n`,
      );
    }
  }
}, 1_800_000);

/* --------------------------------------- track A meets track B: N parts -- */

/**
 * A non-root model part.
 *
 * A CONFORMANT ONE WOULD CARRY AN EMPTY `<build/>` — the specification says
 * non-root streams SHOULD, and that every consumer MUST ignore their build
 * entries. `parseModelXml` REFUSES a model with no build items
 * (`THREEMF_NO_BUILD_ITEMS`), which is correct for the single-part reader it
 * is and wrong for a referenced part, so this fixture keeps a build item purely
 * so the memory measurement can run against today's parser. That the empty
 * form cannot be parsed at all is itself a Track A finding, recorded rather
 * than worked around in production.
 */
function buildObjectPartXml(objectId: string, targetBytes: number): Buffer {
  const built = buildLargeModelXml(targetBytes);
  const text = built.buffer.toString('utf8');
  return Buffer.from(
    text
      .replace('<object id="1"', `<object id="${objectId}"`)
      .replace('<item objectid="1"/>', `<item objectid="${objectId}"/>`),
    'utf8',
  );
}

/**
 * Peak cost of reading several model parts ONE AT A TIME.
 *
 * The question this answers is §31's: whether a package whose reachable model
 * parts total more than any single ceiling is bounded by the LARGEST part or by
 * their SUM. It is bounded by the largest only if each part's scratch — the
 * inflated bytes, the decoded string, the `number[]` accumulators — is released
 * before the next part is opened, and the canonical geometry that survives is
 * the only thing that accumulates.
 */
it('measures a multi-model-part package read sequentially', async () => {
  const raw = process.env.CADFIXER_PART_MB ?? '100,150,200';
  const partSizes = raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);

  global.gc?.();
  const entries: { name: string; content: Buffer }[] = [
    { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', content: Buffer.from(RELS, 'utf8') },
  ];
  const paths: string[] = [];
  partSizes.forEach((sizeMb, index) => {
    const name = `3D/Objects/object_${String(index + 1)}.model`;
    paths.push(name);
    entries.push({
      name,
      content: buildObjectPartXml(String(index + 1), Math.floor(sizeMb * 1024 * 1024)),
    });
  });
  const rootXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
    'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" ' +
    'requiredextensions="p"><resources/><build>' +
    paths
      .map(
        (path, index) =>
          `<item objectid="${String(index + 1)}" p:path="/${path}" transform="1 0 0 0 1 0 0 0 1 ${String(index * 100)} 0 0"/>`,
      )
      .join('') +
    '</build></model>';
  entries.splice(2, 0, { name: '3D/3dmodel.model', content: Buffer.from(rootXml, 'utf8') });

  const archive = buildZip(entries);
  const bytes = new Uint8Array(archive);
  const reachable = entries
    .filter((entry) => entry.name.endsWith('.model'))
    .reduce((total, entry) => total + entry.content.byteLength, 0);

  global.gc?.();
  const fixtureHeld = held();
  const limits = limitsWithEntryCap(256 * 1024 * 1024);
  const directory = readZipDirectory(bytes, {
    ...limits,
    maxTotalUncompressedBytes: reachable + 64 * 1024,
  });
  const budget = createInflationBudget({
    ...limits,
    maxTotalUncompressedBytes: reachable + 64 * 1024,
  });

  process.stdout.write(
    `\n── ${String(paths.length)} model parts, ` +
      `${(reachable / (1024 * 1024)).toFixed(1)} MiB reachable, ` +
      `archive ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MiB on disk ──\n`,
  );

  let peak = fixtureHeld;
  const ticker = setInterval(() => {
    peak = Math.max(peak, held());
  }, 4);

  // The geometry that SURVIVES each part, which is the only thing that should
  // accumulate. Scratch is left to fall out of scope between iterations.
  const canonical: { positions: Float32Array; indices: Uint32Array }[] = [];
  const started = performance.now();
  for (const path of paths) {
    const entry = directory.find((candidate) => candidate.name === path);
    if (entry === undefined) throw new Error(`fixture lost ${path}`);
    const partBytes = await readZipEntry(bytes, entry, { limits, inflateRaw, budget });
    const partXml = decodeUtf8(partBytes);
    const parsed = parseModelXml(partXml, DEFAULT_3MF_LIMITS, DEFAULT_XML_LIMITS);
    for (const object of parsed.objects.values()) {
      const positions = new Float32Array(object.positions.length);
      for (let at = 0; at < object.positions.length; at += 1)
        positions[at] = object.positions[at] ?? 0;
      const indices = new Uint32Array(object.triangles.length);
      for (let at = 0; at < object.triangles.length; at += 1)
        indices[at] = object.triangles[at] ?? 0;
      canonical.push({ positions, indices });
    }
    const afterPart = held();
    peak = Math.max(peak, afterPart);
    process.stdout.write(
      `   after ${path.padEnd(30)} held ${mib(afterPart - fixtureHeld)} MiB over fixture\n`,
    );
    // Yielding lets the collector run between parts, which is exactly what a
    // sequential design depends on and what a test must not paper over.
    await yieldToEventLoop();
    global.gc?.();
  }
  const elapsed = performance.now() - started;
  clearInterval(ticker);

  const surviving = canonical.reduce(
    (total, mesh) => total + mesh.positions.byteLength + mesh.indices.byteLength,
    0,
  );
  const largestPart = Math.max(
    ...entries.filter((e) => e.name.startsWith('3D/Objects')).map((e) => e.content.byteLength),
  );
  process.stdout.write(
    `   peak over fixture ${((peak - fixtureHeld) / (1024 * 1024)).toFixed(1)} MiB in ` +
      `${elapsed.toFixed(0)} ms\n` +
      `   surviving canonical geometry ${(surviving / (1024 * 1024)).toFixed(1)} MiB ` +
      `across ${String(canonical.length)} mesh(es)\n` +
      `   peak / largest part  = ${((peak - fixtureHeld) / largestPart).toFixed(2)}x\n` +
      `   peak / reachable sum = ${((peak - fixtureHeld) / reachable).toFixed(2)}x\n`,
  );
}, 1_800_000);

/* ------------------------------------------------ stage 6D-B2: phases -- */

/**
 * HOW LONG EACH IMPORT PHASE RUNS, which is what decides where a cancellation
 * poll is worth adding.
 *
 * Stage 6D-B2 needs this before touching anything: a poll inside a phase that
 * takes four milliseconds costs maintenance and buys nothing, and a phase that
 * runs for seconds without one is the whole defect. Measured rather than
 * guessed.
 *
 * `read3mf`'s own progress notes bracket the phases it does not export, so the
 * timestamps below decompose the whole import without instrumenting production
 * code.
 */
it('measures how long each 3MF import phase runs', async () => {
  for (const sizeMb of parseSizes()) {
    const targetBytes = Math.floor(sizeMb * 1024 * 1024);
    global.gc?.();

    const built = buildLargeModelXml(targetBytes);
    const entryBytes = built.buffer.byteLength;
    const archive = buildZip([
      { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
      { name: '_rels/.rels', content: Buffer.from(RELS, 'utf8') },
      { name: '3D/3dmodel.model', content: built.buffer },
    ]);
    const bytes = new Uint8Array(archive);
    const zipLimits = limitsWithEntryCap(Math.max(entryBytes + 1024, 256 * 1024 * 1024));

    // Phase boundaries, taken from read3mf's own progress reports.
    const marks: { note: string; at: number }[] = [];
    const started = performance.now();
    await read3mf(
      bytes,
      {
        ...context,
        progress: {
          report: (_fraction: number, note?: string): void => {
            if (note !== undefined) marks.push({ note, at: performance.now() });
          },
        },
      },
      { zipLimits },
    );
    const total = performance.now() - started;

    const spans: string[] = [];
    let previous = started;
    for (const mark of marks) {
      spans.push(`${mark.note}: ${(mark.at - previous).toFixed(0)} ms`);
      previous = mark.at;
    }

    /* -- the sub-phases the progress notes cannot separate ----------------- */
    const modelEntry = readZipDirectory(bytes, zipLimits).find(
      (entry) => entry.name.toLowerCase() === '3d/3dmodel.model',
    );
    if (modelEntry === undefined) throw new Error('fixture lost its model part');
    const modelBytes = await readZipEntry(bytes, modelEntry, {
      limits: zipLimits,
      inflateRaw,
      budget: createInflationBudget(zipLimits),
    });

    let at = performance.now();
    const xml = decodeUtf8(modelBytes);
    const decodeMs = performance.now() - at;

    at = performance.now();
    const unsafe = describeUnsafeXml(xml);
    const safetyMs = performance.now() - at;

    at = performance.now();
    parseModelXml(xml, DEFAULT_3MF_LIMITS, DEFAULT_XML_LIMITS);
    const parseMs = performance.now() - at;

    /* -- the gates the worker runs AFTER read3mf returns ------------------ */
    const parsed = await read3mf(bytes, context, { zipLimits });
    at = performance.now();
    for (const mesh of distinctMeshes(parsed.document)) assertMeshStructure(mesh, 'bench');
    const meshGateMs = performance.now() - at;

    at = performance.now();
    assertGeometryDocument(parsed.document, 'bench');
    const documentGateMs = performance.now() - at;

    process.stdout.write(
      `   assertMeshStructure    ${meshGateMs.toFixed(0)} ms   (polled once per DISTINCT mesh)\n` +
        `   assertGeometryDocument ${documentGateMs.toFixed(0)} ms   (no poll inside)\n`,
    );

    process.stdout.write(
      `\n── phases, entry ${(entryBytes / (1024 * 1024)).toFixed(1)} MiB, ` +
        `${built.triangles.toLocaleString('en-US')} triangles ──\n` +
        `   progress spans: ${spans.join(', ')}\n` +
        `   total read3mf ${total.toFixed(0)} ms\n` +
        `   decodeText        ${decodeMs.toFixed(0)} ms   (synchronous, whole buffer)\n` +
        `   describeUnsafeXml ${safetyMs.toFixed(0)} ms   (synchronous, whole text; unsafe=${String(unsafe)})\n` +
        `   parseModelXml     ${parseMs.toFixed(0)} ms   (polls every 65,536 elements)\n`,
    );
  }
}, 1_800_000);
