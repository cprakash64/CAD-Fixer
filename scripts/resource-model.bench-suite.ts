import { deflateRawSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { it } from 'vitest';
import { uncancellable } from '@cadfixer/shared';
import { distinctMeshes, documentTriangleCount, documentVertexCount } from '@cadfixer/mesh-core';
import {
  DEFAULT_IMPORT_BUDGET,
  read3mf,
  type DocumentReadResult,
  type FormatReadContext,
} from '@cadfixer/file-formats';
import { estimateImportPeak, renderBytesFor } from '@cadfixer/geometry-runtime';

/**
 * STAGE 6D-R1 — WHAT THE IMPORT RESOURCE MODEL ACTUALLY COVERS.
 *
 * Stage 6D-B3 measured a renderer peak of 2.7-3.1 GiB for a 376 MiB entry
 * against a modelled 271 MiB. This suite answers WHY, per memory domain, and
 * then asks the two questions A2 depends on: whether a conservative estimator
 * could be built from quantities known before the allocation, and whether a
 * second model part costs the SUM of two parts or the LARGER of them.
 *
 * NODE, NOT A BROWSER, AND DELIBERATELY SO. The Chromium harness
 * (`qualify:chromium-memory`) measures the envelope; this measures the
 * BREAKDOWN, because `heapUsed + arrayBuffers` under Node can be sampled
 * between individual statements with a forced collection in between, which is
 * what isolating one domain from another requires. Neither replaces the other
 * and the report states which number came from which.
 *
 * Run with `npm run bench:resource-model`. Nothing is written to disk.
 */

/* ------------------------------------------------------------ platform -- */

const MIB = 1024 * 1024;
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

/** `heapUsed + arrayBuffers`: on-heap strings and scratch, plus off-heap buffers. */
function held(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/** A collected floor. Retention measured without this is uncollected garbage. */
async function collected(): Promise<number> {
  // Repeated, with a turn of the loop between: one `gc()` performs a major
  // collection but does not reliably compact or return pages, and a single
  // reading after it has been observed to attribute 0 MiB to a document that
  // demonstrably held 45 MiB of geometry. Even so this metric resolves
  // retention only coarsely, which is why the lifetime conclusion below rests
  // on whether PEAK plateaus rather than on a retention subtraction.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    global.gc?.();
    await yieldToEventLoop();
  }
  return held();
}

function mib(bytes: number): string {
  return (bytes / MIB).toFixed(1).padStart(8);
}

/* ------------------------------------------------------------ archives -- */

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
const MODEL_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">';

function packageOf(model: Buffer): Uint8Array {
  return new Uint8Array(
    buildZip([
      { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
      { name: '_rels/.rels', content: Buffer.from(RELS, 'utf8') },
      { name: '3D/3dmodel.model', content: model },
    ]),
  );
}

/* ------------------------------------------------- fixture families ----- */

export interface Fixture {
  readonly family: string;
  readonly bytes: Uint8Array;
  readonly entryBytes: number;
  readonly triangles: number;
}

/**
 * Assembles a model part block by block into one preallocated buffer.
 *
 * Never through `Array.join`: a 250 MiB model built that way costs the array,
 * the joined string AND the encoded bytes at once, which would make the
 * generator's own peak larger than the thing being measured.
 */
function assemble(
  target: number,
  head: string,
  tail: string,
  block: (index: number) => string,
  count: number,
): Buffer {
  const out = Buffer.allocUnsafe(target + 8 * MIB);
  let at = out.write(head, 0, 'utf8');
  const BATCH = 2048;
  for (let index = 0; index < count; index += BATCH) {
    const upto = Math.min(index + BATCH, count);
    let chunk = '';
    for (let n = index; n < upto; n += 1) chunk += block(n);
    at += out.write(chunk, at, 'utf8');
  }
  at += out.write(tail, at, 'utf8');
  return out.subarray(0, at);
}

/** F1 — GEOMETRY DENSE. Short elements, maximum triangles per XML byte. */
function geometryDense(targetBytes: number): Fixture {
  const vertex = (index: number): string => {
    const base = index * 3;
    return (
      `<vertex x="${String(index % 512)}" y="${String(index % 97)}" z="0"/>` +
      `<vertex x="${String((index % 512) + 1)}" y="${String(index % 97)}" z="0"/>` +
      `<vertex x="${String(index % 512)}" y="${String((index % 97) + 1)}" z="0"/>` +
      `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`
    );
  };
  // Vertices and triangles must be in separate elements, so emit two passes.
  const perTriangle = Buffer.byteLength(vertex(100_000), 'utf8');
  const triangles = Math.max(64, Math.floor(targetBytes / perTriangle));
  const head = `${MODEL_OPEN}<resources><object id="1" type="model" name="F1"><mesh><vertices>`;
  const vertexOnly = (index: number): string => {
    const x = index % 512;
    const y = index % 97;
    return (
      `<vertex x="${String(x)}" y="${String(y)}" z="0"/>` +
      `<vertex x="${String(x + 1)}" y="${String(y)}" z="0"/>` +
      `<vertex x="${String(x)}" y="${String(y + 1)}" z="0"/>`
    );
  };
  const vertexPart = assemble(targetBytes, head, '</vertices><triangles>', vertexOnly, triangles);
  const trianglePart = assemble(
    targetBytes,
    '',
    '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>',
    (index) => {
      const base = index * 3;
      return `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`;
    },
    triangles,
  );
  const model = Buffer.concat([vertexPart, trianglePart]);
  return {
    family: 'F1 geometry-dense',
    bytes: packageOf(model),
    entryBytes: model.byteLength,
    triangles,
  };
}

/**
 * F2 — TEXT HEAVY. Valid XML whose bulk is COMMENT, not geometry.
 *
 * Comments are skipped wholesale by `scanXml` (`indexOf('-->')`), so this
 * isolates the cost of the inflated bytes and the decoded STRING from the cost
 * of scanning elements and building scratch — the two are otherwise impossible
 * to tell apart in a single measurement.
 */
function textHeavy(targetBytes: number): Fixture {
  const triangles = 4_096;
  const geometryHead = `${MODEL_OPEN}<resources><object id="1" type="model" name="F2"><mesh><vertices>`;
  let geometry = geometryHead;
  for (let index = 0; index < triangles; index += 1) {
    const x = index % 512;
    geometry +=
      `<vertex x="${String(x)}" y="0" z="0"/>` +
      `<vertex x="${String(x + 1)}" y="0" z="0"/>` +
      `<vertex x="${String(x)}" y="1" z="0"/>`;
  }
  geometry += '</vertices><triangles>';
  for (let index = 0; index < triangles; index += 1) {
    const base = index * 3;
    geometry += `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`;
  }
  geometry += '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>';

  /*
   * THE FILLER MUST NOT BE A COMPRESSION BOMB.
   *
   * A repeated character deflates at about 432:1, which the product correctly
   * refuses at its 200:1 ratio cap — so a fixture built that way would measure
   * the refusal path rather than the parse path. This generates low-redundancy
   * text from a counter so the archive stays inside the envelope the product
   * actually accepts, which is the only envelope worth characterising.
   */
  const CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
  const fillerBlock = (index: number): string => {
    let out = '<!-- ';
    let state = (index * 2_654_435_761) >>> 0;
    for (let n = 0; n < 4_000; n += 1) {
      state = (state * 1_103_515_245 + 12_345) >>> 0;
      out += CHARSET[(state >>> 16) % CHARSET.length] ?? 'x';
    }
    return `${out} -->`;
  };
  const fillerCount = Math.max(
    1,
    Math.floor(targetBytes / Buffer.byteLength(fillerBlock(0), 'utf8')),
  );
  const comments = assemble(targetBytes, '', '', fillerBlock, fillerCount);
  // The comment block sits INSIDE the model element, before `</model>`.
  const model = Buffer.concat([
    Buffer.from(geometry.slice(0, geometry.length - '</model>'.length), 'utf8'),
    comments,
    Buffer.from('</model>', 'utf8'),
  ]);
  return {
    family: 'F2 text-heavy',
    bytes: packageOf(model),
    entryBytes: model.byteLength,
    triangles,
  };
}

/** F3 — OBJECT HEAVY. Many small mesh objects, all placed. */
function objectHeavy(targetBytes: number, objects: number): Fixture {
  const perObject = Math.max(2, Math.floor(targetBytes / objects / 180));
  const object = (index: number): string => {
    let out = `<object id="${String(index + 1)}" type="model" name="o${String(index)}"><mesh><vertices>`;
    for (let n = 0; n < perObject; n += 1) {
      out +=
        `<vertex x="${String(n % 64)}" y="0" z="0"/>` +
        `<vertex x="${String((n % 64) + 1)}" y="0" z="0"/>` +
        `<vertex x="${String(n % 64)}" y="1" z="0"/>`;
    }
    out += '</vertices><triangles>';
    for (let n = 0; n < perObject; n += 1) {
      const base = n * 3;
      out += `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`;
    }
    return `${out}</triangles></mesh></object>`;
  };
  const resources = assemble(
    targetBytes,
    `${MODEL_OPEN}<resources>`,
    '</resources><build>',
    object,
    objects,
  );
  let build = '';
  for (let index = 0; index < objects; index += 1)
    build += `<item objectid="${String(index + 1)}"/>`;
  const model = Buffer.concat([resources, Buffer.from(`${build}</build></model>`, 'utf8')]);
  return {
    family: `F3 object-heavy (${String(objects)} objects)`,
    bytes: packageOf(model),
    entryBytes: model.byteLength,
    triangles: objects * perObject,
  };
}

/** F4 — PLACEMENT HEAVY. One mesh, many build items. Shared geometry. */
function placementHeavy(meshTriangles: number, placements: number): Fixture {
  let model = `${MODEL_OPEN}<resources><object id="1" type="model" name="F4"><mesh><vertices>`;
  for (let index = 0; index < meshTriangles; index += 1) {
    const x = index % 512;
    model +=
      `<vertex x="${String(x)}" y="0" z="0"/>` +
      `<vertex x="${String(x + 1)}" y="0" z="0"/>` +
      `<vertex x="${String(x)}" y="1" z="0"/>`;
  }
  model += '</vertices><triangles>';
  for (let index = 0; index < meshTriangles; index += 1) {
    const base = index * 3;
    model += `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`;
  }
  model += '</triangles></mesh></object></resources><build>';
  for (let index = 0; index < placements; index += 1) {
    model += `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${String(index)} 0 0"/>`;
  }
  model += '</build></model>';
  const buffer = Buffer.from(model, 'utf8');
  return {
    family: `F4 placement-heavy (${String(placements)} placements)`,
    bytes: packageOf(buffer),
    entryBytes: buffer.byteLength,
    triangles: meshTriangles * placements,
  };
}

/* --------------------------------------------------------- measurement -- */

interface DomainReading {
  readonly fixture: Fixture;
  readonly archive: number;
  readonly importPeak: number;
  readonly retained: number;
  readonly modelled: number;
  readonly canonicalBytes: number;
  readonly elapsedMs: number;
  readonly documentTriangles: number;
}

async function measure(fixture: Fixture): Promise<DomainReading> {
  const floor = await collected();

  let peak = floor;
  const ticker = setInterval(() => {
    peak = Math.max(peak, held());
  }, 4);

  const started = performance.now();
  let result: DocumentReadResult | undefined;
  try {
    result = await read3mf(fixture.bytes, context);
  } finally {
    clearInterval(ticker);
  }
  peak = Math.max(peak, held());
  const elapsedMs = performance.now() - started;

  const documentTriangles = documentTriangleCount(result.document);
  let canonicalBytes = 0;
  for (const mesh of distinctMeshes(result.document)) {
    canonicalBytes += mesh.positions.byteLength + mesh.indices.byteLength;
  }

  /*
   * THE PRODUCTION MODEL, evaluated on exactly this import, so the comparison
   * is against what the product would actually have computed rather than
   * against a reconstruction of it.
   */
  const modelled = estimateImportPeak({
    currentResidentBytes: 0,
    currentRenderBytes: renderBytesFor(documentTriangles),
    inputBytes: fixture.bytes.byteLength,
    candidateTriangles: documentTriangles,
  }).modelledPeakBytes;

  const retained = (await collected()) - floor;
  void documentVertexCount(result.document);

  return {
    fixture,
    archive: fixture.bytes.byteLength,
    importPeak: peak - floor,
    retained,
    modelled,
    canonicalBytes,
    elapsedMs,
    documentTriangles,
  };
}

function report(reading: DomainReading): void {
  const ratio = reading.importPeak / reading.modelled;
  process.stdout.write(
    `  ${reading.fixture.family.padEnd(34)} entry ${mib(reading.fixture.entryBytes)} ` +
      `archive ${mib(reading.archive)}\n` +
      `      triangles ${reading.documentTriangles.toLocaleString('en-US').padStart(12)}  ` +
      `canonical ${mib(reading.canonicalBytes)} MiB\n` +
      `      MEASURED peak ${mib(reading.importPeak)} MiB   ` +
      `MODELLED ${mib(reading.modelled)} MiB   ` +
      `under-prediction ${ratio.toFixed(2)}x\n` +
      `      retained after gc ${mib(reading.retained)} MiB   ${reading.elapsedMs.toFixed(0)} ms\n`,
  );
}

function parseSizes(): number[] {
  const raw = process.env.CADFIXER_R1_MB;
  if (raw === undefined || raw.trim() === '') return [64, 128, 200];
  return raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

it('R1: what the import model covers, across fixture shapes', async () => {
  process.stdout.write(
    `\nStage 6D-R1 resource-model breakdown — node ${process.version} ${process.platform}/${process.arch}\n` +
      `metric: heapUsed + arrayBuffers, forced collection between readings\n\n`,
  );

  for (const sizeMb of parseSizes()) {
    const target = Math.floor(sizeMb * MIB);
    process.stdout.write(`── target entry ${String(sizeMb)} MiB ──\n`);
    report(await measure(geometryDense(target)));
    report(await measure(textHeavy(target)));
    report(await measure(objectHeavy(target, 4_000)));
  }

  // F4 is sized by placements rather than by entry bytes: the whole point is a
  // small entry that produces a large DOCUMENT.
  process.stdout.write(`── placement-heavy (small entry, many parts) ──\n`);
  // SIZED TO STAY INSIDE THE DOCUMENT CEILING. 20,000,000 summed triangles is
  // the document limit, and a fixture that trips it would measure the refusal
  // rather than the memory.
  report(await measure(placementHeavy(20_000, 200)));
  report(await measure(placementHeavy(5_000, 2_000)));
}, 1_800_000);

/* ------------------------------------------- multi-part prototype (R1) -- */

/**
 * WHAT A2 WILL DO, MEASURED WITHOUT ENABLING IT.
 *
 * A2 parses reachable model parts SEQUENTIALLY, retaining each part's canonical
 * geometry and discarding its transient memory before opening the next. The
 * architectural claim is that the peak is therefore
 *
 *     largest part's transient + accumulated canonical geometry
 *
 * and NOT the sum of every part's XML. That claim is the whole basis for A2
 * being affordable, and it has never been measured.
 *
 * MODELLED WITH REPEATED `read3mf` CALLS, holding each result. That is faithful
 * to A2's lifetimes in the respect that matters: if a previous part's inflated
 * bytes, decoded string or scratch arrays were still reachable, they would show
 * up here exactly as they would there. It is not A2 — there is no graph, no
 * cross-part resolution and no production path — which is the point.
 */
interface PartReading {
  readonly index: number;
  readonly peakDuringPart: number;
  readonly retainedAfterPart: number;
  readonly canonicalBytes: number;
}

async function measureSequentialParts(fixtures: readonly Fixture[]): Promise<PartReading[]> {
  const floor = await collected();
  const retained: DocumentReadResult[] = [];
  const readings: PartReading[] = [];

  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index];
    if (fixture === undefined) continue;

    let peak = held();
    const ticker = setInterval(() => {
      peak = Math.max(peak, held());
    }, 4);
    let result: DocumentReadResult;
    try {
      result = await read3mf(fixture.bytes, context);
    } finally {
      clearInterval(ticker);
    }
    peak = Math.max(peak, held());
    retained.push(result);

    /*
     * THE LIFETIME GATE. A forced collection between parts is exactly the
     * opportunity A2 relies on: if the previous part's transient memory is
     * genuinely unreachable it goes here, and if it is still held the reading
     * after this collection will say so.
     */
    const after = (await collected()) - floor;

    let canonical = 0;
    for (const document of retained) {
      for (const mesh of distinctMeshes(document.document)) {
        canonical += mesh.positions.byteLength + mesh.indices.byteLength;
      }
    }

    readings.push({
      index: index + 1,
      peakDuringPart: peak - floor,
      retainedAfterPart: after,
      canonicalBytes: canonical,
    });
  }

  // Held to the end: a collector that reclaimed these mid-run would report a
  // retention the real multi-part import never enjoys.
  void retained.length;
  return readings;
}

it('R1: a second model part costs the LARGER part, not the sum', async () => {
  const cases: { readonly label: string; readonly sizeMb: number }[] = [
    { label: 'MP1  128 + 128', sizeMb: 128 },
    { label: 'MP2  200 + 200', sizeMb: 200 },
    { label: 'MP3  248 + 248', sizeMb: 248 },
  ];

  for (const { label, sizeMb } of cases) {
    const target = Math.floor(sizeMb * MIB);
    // Two DISTINCT parts, so nothing can be shared by accident and the second
    // genuinely adds geometry.
    const first = geometryDense(target);
    const second = geometryDense(target - 4 * MIB);

    const readings = await measureSequentialParts([first, second]);
    const one = readings[0];
    const two = readings[1];
    if (one === undefined || two === undefined) continue;

    const sumOfEntries = first.entryBytes + second.entryBytes;
    process.stdout.write(
      `\n── ${label} (entries ${mib(first.entryBytes)} + ${mib(second.entryBytes)} MiB) ──\n` +
        `   part 1: peak ${mib(one.peakDuringPart)} MiB  retained after ${mib(one.retainedAfterPart)} MiB ` +
        `(canonical ${mib(one.canonicalBytes)})\n` +
        `   part 2: peak ${mib(two.peakDuringPart)} MiB  retained after ${mib(two.retainedAfterPart)} MiB ` +
        `(canonical ${mib(two.canonicalBytes)})\n` +
        `   peak growth part1 -> part2: ` +
        `${((two.peakDuringPart - one.peakDuringPart) / MIB).toFixed(1)} MiB\n` +
        `   peak / largest entry  ${(two.peakDuringPart / first.entryBytes).toFixed(2)}x\n` +
        `   peak / sum of entries ${(two.peakDuringPart / sumOfEntries).toFixed(2)}x\n` +
        `   LIFETIME: retained after part 1 was ` +
        `${(one.retainedAfterPart / one.canonicalBytes).toFixed(2)}x its canonical geometry\n`,
    );
  }
}, 1_800_000);

/* --------------------------------------------------- the lifetime gate -- */

/**
 * R1 §25 — IS ANYTHING BUT CANONICAL GEOMETRY STILL REACHABLE AFTER A PART?
 *
 * The multi-part measurement shows retention above canonical geometry, and the
 * honest reading of that is "some of this is GC slack and some might be a
 * leak" — which is not good enough to let A2 proceed. This isolates the
 * question by DROPPING the result and collecting again: if the extra retention
 * is reachable through the document it stays, and if it is allocator slack it
 * goes.
 *
 * The fixture archive is built ONCE and held across every reading, so it
 * contributes equally to all of them and cancels out of the differences.
 */
it('R1: after a part is materialised, only its canonical geometry stays reachable', async () => {
  for (const sizeMb of [128, 248]) {
    const fixture = geometryDense(Math.floor(sizeMb * MIB));
    // The archive is live from here on, in every reading below.
    const floor = await collected();

    let result: DocumentReadResult | undefined = await read3mf(fixture.bytes, context);
    const holding = (await collected()) - floor;

    let canonical = 0;
    for (const mesh of distinctMeshes(result.document)) {
      canonical += mesh.positions.byteLength + mesh.indices.byteLength;
    }
    const triangles = documentTriangleCount(result.document);

    // DROP IT. Whatever the document was keeping alive becomes unreachable.
    result = undefined;
    const dropped = (await collected()) - floor;

    process.stdout.write(
      `\n── lifetime, entry ${mib(fixture.entryBytes)} MiB, ` +
        `${triangles.toLocaleString('en-US')} triangles ──\n` +
        `   canonical geometry            ${mib(canonical)} MiB\n` +
        `   held while document alive     ${mib(holding)} MiB\n` +
        `   held after document dropped   ${mib(dropped)} MiB\n` +
        `   attributable to the document  ${mib(holding - dropped)} MiB ` +
        `= ${((holding - dropped) / canonical).toFixed(2)}x canonical\n` +
        `   residual slack (not reachable) ${mib(dropped)} MiB ` +
        `= ${(dropped / fixture.entryBytes).toFixed(3)}x the entry\n`,
    );
  }
}, 1_800_000);

/**
 * R1 §25 (decisive form) — DOES PEAK PLATEAU ACROSS MANY PARTS?
 *
 * WHY THIS AND NOT A RETENTION SUBTRACTION. `heapUsed + arrayBuffers` after a
 * forced collection turned out not to resolve retention at this granularity —
 * it reported memory as held after the only reference was dropped, and
 * attributed zero to a document that plainly held tens of megabytes. Any
 * lifetime claim built on subtracting those readings would be built on noise.
 *
 * The question survives a better test. If each part's inflated bytes, decoded
 * string and scratch arrays were still reachable, peak would climb by roughly
 * one entry per part and the growth would be LINEAR in the number of parts. If
 * only canonical geometry survives, peak climbs by the geometry alone — about a
 * third of an entry for this fixture family — and the difference between those
 * two slopes is large enough that GC noise cannot disguise it.
 */
it('R1: sequential parts plateau rather than accumulating transient memory', async () => {
  const PARTS = 5;
  const sizeMb = 128;
  const fixtures: Fixture[] = [];
  for (let index = 0; index < PARTS; index += 1) {
    // Slightly different sizes so no two parts can be shared by accident.
    fixtures.push(geometryDense(Math.floor(sizeMb * MIB) - index * MIB));
  }

  const readings = await measureSequentialParts(fixtures);
  const first = readings[0];
  if (first === undefined) return;

  const entryBytes = fixtures[0]?.entryBytes ?? 1;
  const canonicalPerPart = first.canonicalBytes;

  process.stdout.write(
    `\n── plateau test: ${String(PARTS)} sequential parts of ~${String(sizeMb)} MiB ──\n` +
      `   entry ${mib(entryBytes)} MiB, canonical per part ${mib(canonicalPerPart)} MiB\n`,
  );
  for (const reading of readings) {
    const growth = reading.peakDuringPart - first.peakDuringPart;
    process.stdout.write(
      `   part ${String(reading.index)}: peak ${mib(reading.peakDuringPart)} MiB  ` +
        `growth over part 1 ${mib(growth)} MiB  ` +
        `= ${(growth / canonicalPerPart).toFixed(2)}x canonical, ` +
        `${(growth / entryBytes).toFixed(2)}x entry\n`,
    );
  }

  const last = readings[readings.length - 1];
  if (last === undefined) return;
  const growth = last.peakDuringPart - first.peakDuringPart;
  const leakSlope = (PARTS - 1) * entryBytes;
  const geometrySlope = (PARTS - 1) * canonicalPerPart;
  process.stdout.write(
    `   VERDICT: growth over ${String(PARTS - 1)} further parts was ${mib(growth)} MiB.\n` +
      `      accumulating transient would predict ~${mib(leakSlope)} MiB\n` +
      `      canonical geometry alone predicts    ~${mib(geometrySlope)} MiB\n`,
  );
}, 1_800_000);
