import { describe, expect, it } from 'vitest';
import { AppErrorCode, CancellationSource, isAppError } from '@cadfixer/shared';
import { documentTriangleCount } from '@cadfixer/mesh-core';
import { ImportRefusal, refusalOf } from '../import-errors';
import {
  inflateRawForTests,
  inflateRawSlicedForTests,
  testReadContext,
  type TestContextOptions,
} from '../test-context';
import { INFLATE_INPUT_SLICE_BYTES } from './inflate';
import {
  DEFAULT_3MF_LIMITS,
  read3mf,
  read3mfForQualification,
  ThreeMfIngestion,
  type ThreeMfReadOptions,
  type ThreeMfStreamingQualification,
} from './threemf-reader';
import {
  createInflationBudget,
  DEFAULT_ZIP_LIMITS,
  openTwoPassEntry,
  readZipDirectory,
  readZipEntry,
  type ZipEntry,
  type ZipReadOptions,
} from './zip';
import { buildZip, CONTENT_TYPES, RELS, TETRAHEDRON_MESH } from './zip-fixtures';
import { createStreamScanStats } from './xml-stream';

/**
 * 6E-Z / 6E-R — THE STREAMED ENTRY READ AND THE STREAMED 3MF READ, AS UNITS.
 *
 * Parity with the buffered reader over the whole mutation campaign lives in
 * `mutation-campaign.test.ts` (6E-P). This file pins what only streaming has:
 * a two-pass entry whose order and budget are enforced by the object itself,
 * cleanup of every stream on every exit, bounded decompressor queues, chunked
 * delivery under every `readZipEntry` rule, cancellation at byte positions,
 * parse-once across two passes, no document from a late failure — and a table
 * of refusals compared field by field between the two modes.
 */

const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const ALTERNATIVES = 'http://schemas.microsoft.com/3dmanufacturing/production/alternatives/2021/04';

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

interface Refusal {
  readonly code: string;
  readonly reason: unknown;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

function describeRefusal(error: unknown): Refusal {
  if (!isAppError(error)) throw error;
  return {
    code: error.code,
    reason: refusalOf(error),
    message: error.message,
    details: error.details,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    return describeRefusal(error);
  }
  throw new Error('expected a refusal');
}

/**
 * The fields a refusal carries that depend on DECOMPRESSOR CHUNKING rather than
 * on the file: the prospective total at the chunk that crossed a ceiling. Both
 * modes report them, and both report them the same way; their VALUES move with
 * chunk boundaries — as they already did between Node and Chromium. Everything
 * else must be identical, and the key must be present in both.
 */
const CHUNK_GRANULAR_DETAILS: readonly string[] = ['produced', 'atLeast'];

function comparable(value: Refusal): Refusal {
  const details: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value.details)) {
    details[key] = CHUNK_GRANULAR_DETAILS.includes(key) ? typeof field : field;
  }
  return { ...value, details };
}

function entryOf(archive: Uint8Array, name: string): ZipEntry {
  const entry = readZipDirectory(archive).find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no ${name}`);
  return entry;
}

function dataStart(archive: Uint8Array, entry: ZipEntry): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  return (
    entry.localOffset +
    30 +
    view.getUint16(entry.localOffset + 26, true) +
    view.getUint16(entry.localOffset + 28, true)
  );
}

const PAYLOAD = new TextEncoder().encode(
  Array.from({ length: 4_000 }, (_unused, n) => `<vertex x="${String(n)}" y="1" z="2"/>`).join(''),
);

function zipOptions(overrides: Partial<ZipReadOptions> = {}): ZipReadOptions {
  return {
    inflateRaw: inflateRawSlicedForTests(64),
    budget: createInflationBudget(),
    ...overrides,
  };
}

/* ---------------------------------------------------------- two passes -- */

describe('6E-Z: the two-pass entry delivers what readZipEntry delivers, under every rule', () => {
  for (const [label, method, zip64] of [
    ['deflated', 8, false],
    ['stored', 0, false],
    ['deflated, Zip64 form', 8, true],
    ['stored, Zip64 form', 0, true],
  ] as const) {
    it(`${label}: both passes concatenate to the whole entry`, async () => {
      const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method }], { zip64 });
      const entry = entryOf(archive, 'a.model');
      const whole = await readZipEntry(archive, entry, zipOptions());
      const passes = openTwoPassEntry(archive, entry, zipOptions());
      expect(await collect(passes.security())).toEqual(whole);
      expect(await collect(passes.semantic())).toEqual(whole);
    });
  }

  it('refuses to open the element pass before the security pass reached its end', async () => {
    const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method: 8 }]);
    const entry = entryOf(archive, 'a.model');

    const unopened = openTwoPassEntry(archive, entry, zipOptions());
    expect((await refusal(() => collect(unopened.semantic()))).code).toBe(AppErrorCode.Internal);

    const abandoned = openTwoPassEntry(archive, entry, zipOptions());
    for await (const chunk of abandoned.security()) {
      void chunk;
      break;
    }
    expect((await refusal(() => collect(abandoned.semantic()))).code).toBe(AppErrorCode.Internal);

    const twice = openTwoPassEntry(archive, entry, zipOptions());
    await collect(twice.security());
    expect((await refusal(() => collect(twice.security()))).code).toBe(AppErrorCode.Internal);
  });

  it('a security pass that ends SHORT never clears the element pass', async () => {
    const archive = await buildZip([
      {
        name: 'a.model',
        content: PAYLOAD,
        method: 8,
        declaredUncompressedSize: PAYLOAD.byteLength + 9,
      },
    ]);
    const passes = openTwoPassEntry(archive, entryOf(archive, 'a.model'), zipOptions());
    expect((await refusal(() => collect(passes.security()))).reason).toBe(
      ImportRefusal.ZipDeclaredSizeShortfall,
    );
    expect((await refusal(() => collect(passes.semantic()))).code).toBe(AppErrorCode.Internal);
  });

  it('charges the package budget in the security pass only — exactly once', async () => {
    for (const method of [8, 0] as const) {
      const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method }]);
      const budget = createInflationBudget();
      const passes = openTwoPassEntry(archive, entryOf(archive, 'a.model'), zipOptions({ budget }));
      await collect(passes.security());
      expect(budget.totalProducedBytes).toBe(PAYLOAD.byteLength);
      await collect(passes.semantic());
      expect(budget.totalProducedBytes).toBe(PAYLOAD.byteLength);
    }
  });

  it('a declared size over the per-entry ceiling is refused before anything is inflated', async () => {
    const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method: 8 }]);
    const entry = entryOf(archive, 'a.model');
    let inflations = 0;
    const limits = { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 1_000 };
    const result = await refusal(() =>
      collect(
        openTwoPassEntry(archive, entry, {
          limits,
          inflateRaw: (bytes) => {
            inflations += 1;
            return inflateRawForTests(bytes);
          },
          budget: createInflationBudget(),
        }).security(),
      ),
    );
    const buffered = await refusal(() =>
      readZipEntry(archive, entry, zipOptions({ limits, inflateRaw: inflateRawForTests })),
    );
    expect(result).toEqual(buffered);
    expect(inflations).toBe(0);
  });

  it('a STORED entry is refused and charged exactly as readZipEntry does it', async () => {
    const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method: 0 }]);
    const entry = entryOf(archive, 'a.model');
    const narrow = (): Partial<ZipReadOptions>[] => [
      { limits: { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 1_000 } },
      {
        budget: createInflationBudget({
          ...DEFAULT_ZIP_LIMITS,
          maxTotalUncompressedBytes: PAYLOAD.byteLength - 1,
        }),
      },
    ];
    const buffered = narrow();
    const two = narrow();
    for (let index = 0; index < buffered.length; index += 1) {
      const expected = await refusal(() =>
        readZipEntry(archive, entry, zipOptions(buffered[index])),
      );
      const result = await refusal(() =>
        collect(openTwoPassEntry(archive, entry, zipOptions(two[index])).security()),
      );
      // Word for word, detail for detail — a stored entry is charged whole.
      expect(result).toEqual(expected);
    }
  });

  it('overrun and shortfall are the buffered refusals', async () => {
    for (const [declared, expected] of [
      [100, ImportRefusal.ZipDeclaredSizeOverrun],
      [PAYLOAD.byteLength + 9, ImportRefusal.ZipDeclaredSizeShortfall],
    ] as const) {
      const archive = await buildZip([
        { name: 'a.model', content: PAYLOAD, method: 8, declaredUncompressedSize: declared },
      ]);
      const entry = entryOf(archive, 'a.model');
      const buffered = await refusal(() => readZipEntry(archive, entry, zipOptions()));
      const result = await refusal(() =>
        collect(openTwoPassEntry(archive, entry, zipOptions()).security()),
      );
      expect(result.reason).toBe(expected);
      expect(comparable(result)).toEqual(comparable(buffered));
    }
  });

  /*
   * WHAT CORRUPTION IS DETECTED AS, honestly. No CRC is verified — v0.2.0's
   * reader has never checked one, and A2 changes no refusal. A damaged DEFLATE
   * stream therefore surfaces as whatever the decompressor and the declared
   * size can see: a decode error (typically early), or output of the wrong
   * length (typically later, where damaged data still decodes). Every one of
   * those is a typed malformed-file refusal, and it is the SAME refusal on both
   * paths — which is the property that matters here.
   */
  for (const [where, at] of [
    ['early', 0],
    ['in the middle', 0.5],
    ['near the end', 0.97],
  ] as const) {
    it(`corruption ${where} is the same typed refusal on both paths`, async () => {
      const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method: 8 }]);
      const entry = entryOf(archive, 'a.model');
      const damaged = archive.slice();
      const offset = dataStart(damaged, entry) + Math.floor(entry.compressedSize * at);
      damaged.fill(
        0xff,
        offset,
        Math.min(offset + 8, dataStart(damaged, entry) + entry.compressedSize),
      );
      const buffered = await refusal(() => readZipEntry(damaged, entry, zipOptions()));
      const result = await refusal(() =>
        collect(openTwoPassEntry(damaged, entry, zipOptions()).security()),
      );
      expect(result.code).toBe(AppErrorCode.MalformedFile);
      expect([
        ImportRefusal.ZipMalformed,
        ImportRefusal.ZipDeclaredSizeShortfall,
        ImportRefusal.ZipDeclaredSizeOverrun,
      ]).toContain(result.reason);
      if (where === 'early') expect(result.message).toMatch(/damaged/);
      expect(comparable(result)).toEqual(comparable(buffered));
    });
  }

  it('the runtime ratio check fires on a stream that lies about its compressed size', async () => {
    const zeros = new Uint8Array(4 * 1024 * 1024);
    const archive = await buildZip([
      { name: 'a.model', content: zeros, method: 8, declaredUncompressedSize: 1024 },
    ]);
    const entry = { ...entryOf(archive, 'a.model'), uncompressedSize: zeros.byteLength };
    const buffered = await refusal(() => readZipEntry(archive, entry, zipOptions()));
    const result = await refusal(() =>
      collect(openTwoPassEntry(archive, entry, zipOptions()).security()),
    );
    expect(result.reason).toBe(ImportRefusal.ZipRatioExceeded);
    expect(result).toEqual(buffered);
  });
});

/* ------------------------------------------------------------ read3mf -- */

function denseModel(triangles: number, name = 'Größe 大'): string {
  const vertices: string[] = [];
  const faces: string[] = [];
  for (let n = 0; n < triangles; n += 1) {
    vertices.push(
      `<vertex x="${String(n)}" y="0" z="0"/><vertex x="${String(n)}" y="1" z="0"/><vertex x="${String(n)}" y="0" z="1"/>`,
    );
    faces.push(
      `<triangle v1="${String(n * 3)}" v2="${String(n * 3 + 1)}" v3="${String(n * 3 + 2)}"/>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}">` +
    `<resources><object id="1" type="model" name="${name}"><mesh><vertices>${vertices.join('')}</vertices>` +
    `<triangles>${faces.join('')}</triangles></mesh></object></resources>` +
    '<build><item objectid="1"/></build></model>'
  );
}

async function packageOf(model: string, extra: Record<string, string> = {}): Promise<Uint8Array> {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES, method: 8 },
    { name: '_rels/.rels', content: RELS, method: 8 },
    { name: '3D/3dmodel.model', content: model, method: 8 },
    ...Object.entries(extra).map(([name, content]) => ({ name, content, method: 8 })),
  ]);
}

const STREAMING: ThreeMfReadOptions = { ingestion: ThreeMfIngestion.Streaming };

function streamed(
  bytes: Uint8Array,
  qualification: ThreeMfStreamingQualification = {},
  context: TestContextOptions = {},
  options: ThreeMfReadOptions = {},
): ReturnType<typeof read3mf> {
  return read3mfForQualification(
    bytes,
    testReadContext(context),
    { ...options, ...STREAMING },
    { yieldEveryPieces: 1, ...qualification },
  );
}

describe('6E-R: the streamed read', () => {
  it('buffered is the default, and a streamed read without a decoder is a wiring fault', async () => {
    const bytes = await packageOf(denseModel(10));
    // No decoder: the DEFAULT still reads, because the default is buffered.
    await read3mf(bytes, testReadContext({ withTextDecoder: false }));
    const fault = await refusal(() =>
      read3mf(bytes, testReadContext({ withTextDecoder: false }), STREAMING),
    );
    expect(fault.code).toBe(AppErrorCode.Internal);
  });

  it('reads a dense part through bounded pieces, with the UTF-8 name intact', async () => {
    const stats = createStreamScanStats();
    const bytes = await packageOf(denseModel(20_000));
    const whole = await read3mf(bytes, testReadContext());
    const result = await streamed(bytes, { stats });
    expect(documentTriangleCount(result.document)).toBe(20_000);
    expect(result.document.parts[0]?.name).toBe('Größe 大');
    expect(result).toEqual(whole);
    // Nothing near the size of the part was ever held as one piece or one tag.
    expect(stats.maxPieceChars).toBeLessThan(200_000);
    expect(stats.maxTagChars).toBeLessThan(200);
  });

  it('parses each model part once — two passes — one part open at a time', async () => {
    const root =
      `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}" xmlns:p="${PRODUCTION}" requiredextensions="p">` +
      '<resources><object id="1" type="model"><components>' +
      '<component objectid="7" p:path="/3D/child.model"/>' +
      '<component objectid="7" p:path="/3D/child.model" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>' +
      '</components></object></resources>' +
      '<build><item objectid="1"/><item objectid="7" p:path="/3D/child.model"/></build></model>';
    const child =
      `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}">` +
      `<resources><object id="7" type="model">${TETRAHEDRON_MESH}</object></resources><build/></model>`;
    const bytes = await packageOf(root, { '3D/child.model': child });
    let inflations = 0;
    const passes: string[] = [];
    const result = await streamed(
      bytes,
      { onPass: (pass, event) => passes.push(`${String(pass)}${event === 'start' ? '<' : '>'}`) },
      {
        inflateRaw: (compressed) => {
          inflations += 1;
          return inflateRawSlicedForTests(128)(compressed);
        },
      },
    );
    expect(result.document.parts).toHaveLength(3);
    expect(result).toEqual(await read3mf(bytes, testReadContext()));
    // The root .rels once (buffered), the root twice and the child twice: three
    // references to the child, one parse. And every part's two passes close
    // before the next part's open.
    expect(inflations).toBe(5);
    expect(passes).toEqual(['1<', '1>', '2<', '2>', '1<', '1>', '2<', '2>']);
  });

  it('charges the package budget once for a part it reads twice', async () => {
    const model = denseModel(2_000);
    const bytes = await packageOf(model);
    const exact = new TextEncoder().encode(model).byteLength;
    const rels = new TextEncoder().encode(RELS).byteLength;
    const budget = createInflationBudget();
    await streamed(bytes, {}, {}, { budget });
    expect(budget.totalProducedBytes).toBe(exact + rels);
  });

  it('one package budget: parts that sum to the limit read, one byte fewer refuses', async () => {
    const child =
      `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}">` +
      `<resources><object id="7" type="model">${TETRAHEDRON_MESH}</object></resources><build/></model>`;
    const root =
      `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}" xmlns:p="${PRODUCTION}" requiredextensions="p">` +
      `<resources/><build><item objectid="7" p:path="/3D/child.model"/></build></model>`;
    const bytes = await packageOf(root, { '3D/child.model': child });
    const total = [RELS, root, child].reduce(
      (sum, text) => sum + new TextEncoder().encode(text).byteLength,
      0,
    );
    for (const ingestion of [ThreeMfIngestion.Buffered, ThreeMfIngestion.Streaming]) {
      const exact = createInflationBudget({
        ...DEFAULT_ZIP_LIMITS,
        maxTotalUncompressedBytes: total,
      });
      const read = await read3mf(bytes, testReadContext(), { ingestion, budget: exact });
      expect(read.document.parts).toHaveLength(1);
      expect(exact.totalProducedBytes).toBe(total);
      const short = createInflationBudget({
        ...DEFAULT_ZIP_LIMITS,
        maxTotalUncompressedBytes: total - 1,
      });
      const refused = await refusal(() =>
        read3mf(bytes, testReadContext(), { ingestion, budget: short }),
      );
      expect(refused.reason, ingestion).toBe(ImportRefusal.ZipTotalTooLarge);
    }
  });

  for (const fraction of [0.1, 0.5, 0.9]) {
    it(`a cancel at ${String(fraction * 100)}% of the bytes stops the read, and returns nothing`, async () => {
      const model = denseModel(20_000);
      const bytes = await packageOf(model);
      const total = new TextEncoder().encode(model).byteLength * 2;
      const source = new CancellationSource();
      let seen = 0;
      let seenAtCancel = 0;
      const result = await refusal(() =>
        streamed(
          bytes,
          {
            onBytes: (_pass, length) => {
              seen += length;
              if (seenAtCancel === 0 && seen >= total * fraction) {
                seenAtCancel = seen;
                source.cancel();
              }
            },
          },
          { cancellation: source.token },
        ),
      );
      expect(result.code).toBe(AppErrorCode.OperationCancelled);
      // Stopped within one piece of where it was asked to.
      expect(seen - seenAtCancel).toBeLessThan(70_000);
    });
  }

  it('a cancel BETWEEN the passes is observed before the element pass reads', async () => {
    const bytes = await packageOf(denseModel(2_000));
    const source = new CancellationSource();
    const passes: string[] = [];
    const result = await refusal(() =>
      streamed(
        bytes,
        {
          onPass: (pass, event) => {
            passes.push(`${String(pass)} ${event}`);
            if (pass === 1 && event === 'end') source.cancel();
          },
        },
        { cancellation: source.token },
      ),
    );
    expect(result.code).toBe(AppErrorCode.OperationCancelled);
    expect(passes).not.toContain('2 end');
  });

  it('a malformed token at the very end refuses the part — no document, no partial', async () => {
    const model = denseModel(5_000).replace('</model>', '</model><broken');
    const bytes = await packageOf(model);
    const stats = createStreamScanStats();
    const buffered = await refusal(() => read3mf(bytes, testReadContext()));
    const result = await refusal(() => streamed(bytes, { stats }));
    expect(result).toEqual(buffered);
    expect(result.reason).toBe(ImportRefusal.XmlMalformed);
    // The scanner's location: it had consumed the whole part when it refused.
    expect(stats.charsConsumed).toBe(model.length);
  });

  it('a late ENTITY refuses without ever starting the element pass', async () => {
    const model = denseModel(5_000).replace('</model>', '</model><!ENTITY x "y">');
    const bytes = await packageOf(model);
    const passes: string[] = [];
    const result = await refusal(() =>
      streamed(bytes, { onPass: (pass, event) => passes.push(`${String(pass)} ${event}`) }),
    );
    expect(result.reason).toBe(ImportRefusal.XmlEntityRefused);
    expect(passes).toEqual(['1 start', '1 end']);
  });

  it('a required extension split across pieces is still refused as unsupported', async () => {
    const model = denseModel(10).replace(
      '<model unit="millimeter"',
      '<model unit="millimeter" xmlns:q="http://example.invalid/q" requiredextensions="q"',
    );
    const bytes = await packageOf(model);
    for (const slice of [1, 2, 3, 5, 8, 13]) {
      const result = await refusal(() =>
        streamed(bytes, {}, { inflateRaw: inflateRawSlicedForTests(slice) }),
      );
      expect(result.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
    }
  });

  it('a tag past the stream limit is the one streamed-only refusal, and it names the limit', async () => {
    const bytes = await packageOf(denseModel(10, 'n'.repeat(2_000)));
    await read3mf(bytes, testReadContext());
    const result = await refusal(() => streamed(bytes, { streamLimits: { maxTagLength: 1_024 } }));
    expect(result.reason).toBe(ImportRefusal.XmlTagTooLong);
    expect(result.details).toMatchObject({ limit: 1_024 });
    expect(result.message).toContain('1,024');
  });
});

/* ------------------------------------------------------- refusal table -- */

const CHILD_PATH = '3D/Objects/a.model';

function childModel(unit = 'millimeter'): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><model unit="${unit}" xmlns="${CORE}">` +
    `<resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources><build/></model>`
  );
}

/** A root placing the child through `p:path`, with extra namespaces and attributes. */
function productionRoot(xmlns: string, attrs: string, objectExtra = '', build?: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}" xmlns:p="${PRODUCTION}"${xmlns}${attrs}>` +
    `<resources><object id="2" type="model">${TETRAHEDRON_MESH}${objectExtra}</object></resources>` +
    `<build>${build ?? `<item objectid="2"/><item objectid="1" p:path="/${CHILD_PATH}"/>`}</build></model>`
  );
}

interface TableCase {
  readonly name: string;
  readonly build: () => Promise<Uint8Array>;
  readonly reason: string;
  readonly options?: ThreeMfReadOptions;
}

const TABLE: readonly TableCase[] = [
  {
    name: 'malformed XML',
    build: () => packageOf(denseModel(50).replace('</model>', '</model><broken')),
    reason: ImportRefusal.XmlMalformed,
  },
  {
    name: 'a DOCTYPE',
    build: () => packageOf(denseModel(50).replace('<model', '<!DOCTYPE model><model')),
    reason: ImportRefusal.XmlDoctypeRefused,
  },
  {
    name: 'an ENTITY',
    build: () => packageOf(denseModel(50).replace('</model>', '</model><!ENTITY x "y">')),
    reason: ImportRefusal.XmlEntityRefused,
  },
  {
    name: 'an external identifier',
    build: () => packageOf(denseModel(50).replace('<model', '<!-- PUBLIC "x" --><model')),
    reason: ImportRefusal.XmlExternalIdRefused,
  },
  {
    name: 'a corrupt deflate stream',
    build: async (): Promise<Uint8Array> => {
      const archive = await packageOf(denseModel(500));
      const entry = entryOf(archive, '3D/3dmodel.model');
      const at = dataStart(archive, entry);
      archive.fill(0xff, at, at + 8);
      return archive;
    },
    reason: ImportRefusal.ZipMalformed,
  },
  {
    name: 'a model part shorter than declared',
    build: () =>
      buildZip([
        { name: '_rels/.rels', content: RELS, method: 8 },
        {
          name: '3D/3dmodel.model',
          content: denseModel(50),
          method: 8,
          declaredUncompressedSize: new TextEncoder().encode(denseModel(50)).byteLength + 3,
        },
      ]),
    reason: ImportRefusal.ZipDeclaredSizeShortfall,
  },
  {
    name: 'a model part longer than declared',
    build: () =>
      buildZip([
        { name: '_rels/.rels', content: RELS, method: 8 },
        {
          name: '3D/3dmodel.model',
          content: denseModel(50),
          method: 8,
          declaredUncompressedSize: 64,
        },
      ]),
    reason: ImportRefusal.ZipDeclaredSizeOverrun,
  },
  {
    name: 'a child part over the compression ratio',
    build: () =>
      packageOf(productionRoot('', ' requiredextensions="p"'), {
        [CHILD_PATH]: childModel().replace('<build/>', `<!-- ${' '.repeat(3_000_000)} --><build/>`),
      }),
    reason: ImportRefusal.ZipRatioExceeded,
  },
  {
    name: 'an unknown required extension',
    build: () =>
      packageOf(
        productionRoot(' xmlns:q="http://example.invalid/q"', ' requiredextensions="p q"'),
        { [CHILD_PATH]: childModel() },
      ),
    reason: ImportRefusal.ThreeMfUnsupportedExtension,
  },
  {
    name: 'Secure Content declared required',
    build: () =>
      packageOf(
        productionRoot(
          ' xmlns:z="http://schemas.microsoft.com/3dmanufacturing/securecontent/2019/04"',
          ' requiredextensions="p z"',
        ),
        { [CHILD_PATH]: childModel() },
      ),
    reason: ImportRefusal.ThreeMfUnsupportedExtension,
  },
  {
    name: 'an alternatives element under a non-conventional prefix',
    build: () =>
      packageOf(
        productionRoot(
          ` xmlns:alt="${ALTERNATIVES}"`,
          ' requiredextensions="p"',
          `<alt:alternatives><alt:alternative p:path="/${CHILD_PATH}" objectid="1"/></alt:alternatives>`,
        ),
        { [CHILD_PATH]: childModel() },
      ),
    reason: ImportRefusal.ThreeMfModelResolutionUnsupported,
  },
  {
    name: 'a reference to an object the child does not declare',
    build: () =>
      packageOf(
        productionRoot(
          '',
          ' requiredextensions="p"',
          '',
          `<item objectid="2"/><item objectid="99" p:path="/${CHILD_PATH}"/>`,
        ),
        { [CHILD_PATH]: childModel() },
      ),
    reason: ImportRefusal.ThreeMfMissingModelPartObject,
  },
  {
    name: 'a missing child part',
    build: () => packageOf(productionRoot('', ' requiredextensions="p"')),
    reason: ImportRefusal.ThreeMfModelPartNotFound,
  },
  {
    name: 'parts that disagree about the unit',
    build: () =>
      packageOf(productionRoot('', ' requiredextensions="p"'), {
        [CHILD_PATH]: childModel('inch'),
      }),
    reason: ImportRefusal.ThreeMfInconsistentModelPartUnits,
  },
  {
    name: 'a package over the part ceiling',
    build: () =>
      packageOf(productionRoot('', ' requiredextensions="p"'), { [CHILD_PATH]: childModel() }),
    reason: ImportRefusal.ThreeMfTooManyParts,
    options: { limits: { ...DEFAULT_3MF_LIMITS, maxParts: 1 } },
  },
];

describe('6E-E: every refusal is the same refusal in both modes', () => {
  for (const entry of TABLE) {
    it(`${entry.name}: same category, code, message and details`, async () => {
      const bytes = await entry.build();
      const options = entry.options ?? {};
      const buffered = await refusal(() => read3mf(bytes, testReadContext(), options));
      expect(buffered.reason, 'the case reaches the refusal it names').toBe(entry.reason);
      for (const slice of [7, 4_096, INFLATE_INPUT_SLICE_BYTES]) {
        const result = await refusal(() =>
          streamed(bytes, {}, { inflateRaw: inflateRawSlicedForTests(slice) }, options),
        );
        expect(comparable(result), `slice ${String(slice)}`).toEqual(comparable(buffered));
      }
    });
  }

  it('cancellation: the same typed refusal in both modes', async () => {
    const bytes = await packageOf(denseModel(20_000));
    for (const ingestion of [ThreeMfIngestion.Buffered, ThreeMfIngestion.Streaming]) {
      const source = new CancellationSource();
      source.cancel();
      const result = await refusal(() =>
        read3mf(bytes, testReadContext({ cancellation: source.token }), { ingestion }),
      );
      expect(result.code, ingestion).toBe(AppErrorCode.OperationCancelled);
    }
  });
});
