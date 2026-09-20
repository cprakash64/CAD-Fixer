import { describe, expect, it } from 'vitest';
import { isAppError } from '@cadfixer/shared';
import { refusalOf } from '../import-errors';
import {
  inflateRawForTests,
  inflateRawSlicedForTests,
  inflateRawWholeWriteForTests,
  testReadContext,
} from '../test-context';
import { createSlicedInflater, INFLATE_INPUT_SLICE_BYTES, type DecompressorLike } from './inflate';
import { read3mf } from './threemf-reader';
import {
  createInflationBudget,
  readZipDirectory,
  readZipEntry,
  type ZipEntry,
  type ZipReadOptions,
} from './zip';
import { buildZip, CONTENT_TYPES, RELS } from './zip-fixtures';

/**
 * 6E-I / 6E-W — THE ONE INFLATER, AND THE BUFFERED READER IT FEEDS (Stage 6E-A2).
 *
 * Every raw-deflate caller now goes through `createSlicedInflater`, which writes
 * the compressed input in bounded slices. That change exists for memory (finding
 * R3); what these tests pin is that it changed NOTHING ELSE: the buffered reader
 * produces the same bytes, the same refusals and the same budget accounting as it
 * did through the one-write inflater v0.2.0 shipped — kept here as
 * `inflateRawWholeWriteForTests` for exactly this comparison — and every exit
 * releases the decompressor. The real-decompressor queue bound is measured in
 * `scripts/inflate-backpressure.test.ts`, which has the timers this package's
 * ES2023 lib deliberately lacks.
 */

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

/** Chunk-granular fields; see `streaming-ingestion.test.ts`. */
function comparable(value: Refusal): Refusal {
  const details: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value.details)) {
    details[key] = key === 'produced' || key === 'atLeast' ? typeof field : field;
  }
  return { ...value, details };
}

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

function entryOf(archive: Uint8Array, name: string): ZipEntry {
  const entry = readZipDirectory(archive).find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no ${name}`);
  return entry;
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

async function packageOf(model: string): Promise<Uint8Array> {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES, method: 8 },
    { name: '_rels/.rels', content: RELS, method: 8 },
    { name: '3D/3dmodel.model', content: model, method: 8 },
  ]);
}

function denseModel(triangles: number): string {
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
    '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    `<resources><object id="1" type="model" name="Größe 大"><mesh><vertices>${vertices.join('')}</vertices>` +
    `<triangles>${faces.join('')}</triangles></mesh></object></resources>` +
    '<build><item objectid="1"/></build></model>'
  );
}

/** A decompressor stand-in that records what was done to it. */
function recordingDecompressor(chunks: readonly Uint8Array[]): {
  readonly stream: DecompressorLike;
  readonly log: string[];
} {
  const log: string[] = [];
  let next = 0;
  type Reader = ReturnType<DecompressorLike['readable']['getReader']>;
  type Writer = ReturnType<DecompressorLike['writable']['getWriter']>;
  const reader: Reader = {
    read: (): ReturnType<Reader['read']> => {
      const value = chunks[next];
      next += 1;
      return Promise.resolve(value === undefined ? { done: true } : { done: false, value });
    },
    cancel: (): Promise<void> => {
      log.push('reader.cancel');
      return Promise.resolve();
    },
    releaseLock: (): void => {
      log.push('reader.releaseLock');
    },
  };
  const writer: Writer = {
    write: (chunk: Uint8Array<ArrayBuffer>): Promise<void> => {
      log.push(`write ${String(chunk.byteLength)}`);
      return Promise.resolve();
    },
    close: (): Promise<void> => {
      log.push('writer.close');
      return Promise.resolve();
    },
    abort: (): Promise<void> => {
      log.push('writer.abort');
      return Promise.resolve();
    },
    releaseLock: (): void => {
      log.push('writer.releaseLock');
    },
  };
  return {
    log,
    stream: {
      readable: { getReader: (): Reader => reader },
      writable: { getWriter: (): Writer => writer },
    },
  };
}

describe('6E-I: the production inflater', () => {
  it('writes its input in bounded slices, never in one piece', async () => {
    const { stream, log } = recordingDecompressor([new Uint8Array(3)]);
    await collect(createSlicedInflater(() => stream, 1_000)(new Uint8Array(2_500)));
    await Promise.resolve();
    expect(log.filter((line) => /^write \d/.test(line))).toEqual([
      'write 1000',
      'write 1000',
      'write 500',
    ]);
    expect(log).toContain('writer.close');
    expect(log).toEqual(expect.arrayContaining(['reader.releaseLock', 'writer.releaseLock']));
    expect(INFLATE_INPUT_SLICE_BYTES).toBe(65_536);
  });

  it('an early exit cancels the reader, aborts the writer and releases both locks', async () => {
    const { stream, log } = recordingDecompressor([new Uint8Array(3), new Uint8Array(3)]);
    for await (const chunk of createSlicedInflater(() => stream)(new Uint8Array(10))) {
      expect(chunk.byteLength).toBe(3);
      break;
    }
    expect(log).toEqual(
      expect.arrayContaining([
        'reader.cancel',
        'writer.abort',
        'reader.releaseLock',
        'writer.releaseLock',
      ]),
    );
  });

  it('a consumer that THROWS mid-stream still releases everything', async () => {
    const { stream, log } = recordingDecompressor([new Uint8Array(3), new Uint8Array(3)]);
    await expect(
      (async (): Promise<void> => {
        for await (const chunk of createSlicedInflater(() => stream)(new Uint8Array(10))) {
          void chunk;
          throw new Error('refused by the consumer');
        }
      })(),
    ).rejects.toThrow('refused by the consumer');
    expect(log).toEqual(expect.arrayContaining(['reader.cancel', 'writer.abort']));
  });

  // The real-decompressor queue bound is measured in `scripts/inflate-backpressure.test.ts`,
  // which has the timers this package's ES2023 lib deliberately lacks.
});

describe('6E-W: the buffered reader is unchanged by sliced writes', () => {
  it('produces the same bytes and the same refusals as the one-write inflater', async () => {
    const cases: readonly Parameters<typeof buildZip>[0][number][] = [
      { name: 'a.model', content: PAYLOAD, method: 8 },
      { name: 'a.model', content: PAYLOAD, method: 8, declaredUncompressedSize: 100 },
      {
        name: 'a.model',
        content: PAYLOAD,
        method: 8,
        declaredUncompressedSize: PAYLOAD.byteLength + 1,
      },
    ];
    for (const spec of cases) {
      const archive = await buildZip([spec]);
      const entry = entryOf(archive, 'a.model');
      const read = async (inflateRaw: ZipReadOptions['inflateRaw']): Promise<unknown> => {
        try {
          return await readZipEntry(archive, entry, zipOptions({ inflateRaw }));
        } catch (error) {
          return comparable(describeRefusal(error));
        }
      };
      expect(await read(inflateRawForTests)).toEqual(await read(inflateRawWholeWriteForTests));
    }
  });

  it('charges the budget the same total, and refuses a bomb the same way', async () => {
    const archive = await buildZip([{ name: 'a.model', content: PAYLOAD, method: 8 }]);
    const entry = entryOf(archive, 'a.model');
    for (const inflateRaw of [inflateRawWholeWriteForTests, inflateRawForTests]) {
      const budget = createInflationBudget();
      await readZipEntry(archive, entry, zipOptions({ inflateRaw, budget }));
      expect(budget.totalProducedBytes).toBe(PAYLOAD.byteLength);
    }
    const zeros = new Uint8Array(4 * 1024 * 1024);
    const bomb = await buildZip([
      { name: 'a.model', content: zeros, method: 8, declaredUncompressedSize: 1024 },
    ]);
    const bombEntry = { ...entryOf(bomb, 'a.model'), uncompressedSize: zeros.byteLength };
    const before = await refusal(() =>
      readZipEntry(bomb, bombEntry, zipOptions({ inflateRaw: inflateRawWholeWriteForTests })),
    );
    const after = await refusal(() =>
      readZipEntry(bomb, bombEntry, zipOptions({ inflateRaw: inflateRawForTests })),
    );
    expect(after).toEqual(before);
  });

  it('a whole buffered 3MF read is identical through either inflater', async () => {
    const bytes = await packageOf(denseModel(5_000));
    const before = await read3mf(
      bytes,
      testReadContext({ inflateRaw: inflateRawWholeWriteForTests }),
    );
    const after = await read3mf(bytes, testReadContext());
    expect(after).toEqual(before);
  });
});
