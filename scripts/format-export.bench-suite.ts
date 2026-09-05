import { performance } from 'node:perf_hooks';
import { it } from 'vitest';
import { uncancellable, LengthUnit } from '@cadfixer/shared';
import {
  createIndexArray,
  createPositionArray,
  IDENTITY_PART_TRANSFORM,
  partId,
  type CanonicalMesh,
  type GeometryDocument,
  type PartTransform,
} from '@cadfixer/mesh-core';
import {
  DEFAULT_EXPORT_LIMITS,
  DEFAULT_IMPORT_BUDGET,
  exportSnapshotOf,
  MeshFormatId,
  readObj,
  read3mf,
  writeObjDocument,
  write3mfDocument,
  type ExportDocumentSnapshot,
  type FormatReadContext,
  type FormatWriteDocumentContext,
} from '@cadfixer/file-formats';

/**
 * OBJ and 3MF EXPORT, measured at realistic sizes. NOT part of CI.
 *
 * Two questions this answers that the import benchmark cannot:
 *
 *   1. WHAT DOES VALIDATION COST? Every successful export reads its own bytes
 *      back with the production reader. That is not free, and a user waits for
 *      it, so it is measured separately rather than folded into a total.
 *   2. WHAT DOES A PLACEMENT COST IN EACH FORMAT? 3MF shares a mesh resource
 *      and OBJ cannot, so the two diverge as placements multiply. The
 *      architecture claims this; these numbers are whether it is true.
 *
 * NODE, NOT A BROWSER, and no claim about process memory — the same reasoning
 * recorded on `pipeline.bench-suite.ts`. Output sizes are exact because they
 * are the artifacts themselves.
 *
 * Run with `npm run bench:export`. Sizes: `CADFIXER_EXPORT_MB=1,10,50`.
 */

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

async function* deflateRaw(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
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

async function* inflateRaw(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
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

const write: FormatWriteDocumentContext = {
  cancellation: uncancellable,
  limits: DEFAULT_EXPORT_LIMITS,
  progress: { report: (): void => undefined },
  yieldToEventLoop,
  encodeText: (text) => encoder.encode(text),
  deflateRaw,
};

const read: FormatReadContext = {
  cancellation: uncancellable,
  budget: DEFAULT_IMPORT_BUDGET,
  progress: { report: (): void => undefined },
  yieldToEventLoop,
  decodeText: (bytes) => decoder.decode(bytes),
  inflateRaw,
};

/* ------------------------------------------------------------- fixtures -- */

function grid(side: number): CanonicalMesh {
  const positions = createPositionArray((side + 1) * (side + 1) * 3);
  let at = 0;
  for (let row = 0; row <= side; row += 1) {
    for (let column = 0; column <= side; column += 1) {
      positions[at] = column;
      positions[at + 1] = row;
      positions[at + 2] = ((column * 7 + row * 13) % 17) * 0.01;
      at += 3;
    }
  }
  const indices = createIndexArray(side * side * 6);
  let out = 0;
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const base = row * (side + 1) + column;
      indices[out] = base;
      indices[out + 1] = base + 1;
      indices[out + 2] = base + side + 1;
      indices[out + 3] = base + 1;
      indices[out + 4] = base + side + 2;
      indices[out + 5] = base + side + 1;
      out += 6;
    }
  }
  return { positions, indices, metadata: { sourceFormat: MeshFormatId.ThreeMf } };
}

function documentOf(
  parts: readonly { mesh: CanonicalMesh; transform?: PartTransform }[],
): GeometryDocument {
  return {
    unit: LengthUnit.Millimeter,
    parts: parts.map((part, index) => ({
      id: partId(`part-${String(index + 1)}`),
      mesh: part.mesh,
      transform: part.transform ?? IDENTITY_PART_TRANSFORM,
    })),
  };
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function ms(value: number): string {
  return `${value.toFixed(0).padStart(6)} ms`;
}

function parseSizes(): number[] {
  const raw = process.env.CADFIXER_EXPORT_MB;
  if (raw === undefined || raw.trim().length === 0) return [1, 10, 50];
  return raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

/** Side length whose OBJ text is roughly `targetBytes`. About 95 bytes a triangle. */
function sideForObjBytes(targetBytes: number): number {
  return Math.max(4, Math.round(Math.sqrt(targetBytes / 95 / 2)));
}

interface Timing {
  readonly snapshotMs: number;
  readonly serialiseMs: number;
  readonly validateMs: number;
  readonly totalMs: number;
  readonly outputBytes: number;
}

async function timeObj(document: GeometryDocument): Promise<Timing> {
  const snapshotStart = performance.now();
  const snapshot = exportSnapshotOf(document, 'bench', 1);
  const snapshotMs = performance.now() - snapshotStart;

  const serialiseStart = performance.now();
  const written = await writeObjDocument(snapshot, write);
  const serialiseMs = performance.now() - serialiseStart;

  const validateStart = performance.now();
  await readObj(written.bytes, read);
  const validateMs = performance.now() - validateStart;

  return {
    snapshotMs,
    serialiseMs,
    validateMs,
    totalMs: snapshotMs + serialiseMs + validateMs,
    outputBytes: written.bytes.byteLength,
  };
}

interface ThreeMfTiming extends Timing {
  readonly xmlBytes: number;
}

async function time3mf(snapshot: ExportDocumentSnapshot): Promise<ThreeMfTiming> {
  const serialiseStart = performance.now();
  const written = await write3mfDocument(snapshot, write);
  const serialiseMs = performance.now() - serialiseStart;

  const validateStart = performance.now();
  await read3mf(written.bytes, read);
  const validateMs = performance.now() - validateStart;

  return {
    snapshotMs: 0,
    serialiseMs,
    validateMs,
    totalMs: serialiseMs + validateMs,
    outputBytes: written.bytes.byteLength,
    xmlBytes: 0,
  };
}

const RUNS = 3;

async function best<T extends Timing>(run: () => Promise<T>): Promise<T> {
  // Warm up, then keep the FASTEST of three. A median would be defensible too;
  // the fastest is the one least polluted by whatever else the machine did.
  await run();
  let bestRun = await run();
  for (let attempt = 1; attempt < RUNS; attempt += 1) {
    const next = await run();
    if (next.totalMs < bestRun.totalMs) bestRun = next;
  }
  return bestRun;
}

it('measures OBJ and 3MF export across representative sizes', async () => {
  process.stdout.write(
    `\nnode ${process.version} on ${process.platform}/${process.arch}\n` +
      `run at ${new Date().toISOString()}\n` +
      `best of ${String(RUNS)} after one warm-up\n\n`,
  );

  for (const sizeMb of parseSizes()) {
    const side = sideForObjBytes(sizeMb * 1024 * 1024);
    const mesh = grid(side);
    const triangles = side * side * 2;
    const document = documentOf([{ mesh }]);
    const snapshot = exportSnapshotOf(document, 'bench', 1);

    const obj = await best(async () => timeObj(document));
    const threeMf = await best(async () => time3mf(snapshot));

    process.stdout.write(
      `=== one part, ${triangles.toLocaleString()} triangles ===\n` +
        `  OBJ  snapshot ${ms(obj.snapshotMs)}  serialise ${ms(obj.serialiseMs)}` +
        `  validate ${ms(obj.validateMs)}  total ${ms(obj.totalMs)}  out ${mib(obj.outputBytes)}\n` +
        `  3MF  snapshot ${ms(obj.snapshotMs)}  serialise ${ms(threeMf.serialiseMs)}` +
        `  validate ${ms(threeMf.validateMs)}  total ${ms(threeMf.totalMs)}  out ${mib(threeMf.outputBytes)}\n\n`,
    );
  }
}, 900_000);

it('measures how each format scales with PLACEMENT count', async () => {
  /*
   * THE ARCHITECTURAL CLAIM, MEASURED. 3MF writes one mesh resource however
   * many parts place it; OBJ has no instancing and writes the geometry again
   * for every placement. This is the number Stage 4A-2B3 turns into a warning a
   * user reads before choosing a format.
   */
  const mesh = grid(24); // 1,152 triangles: small enough to repeat a thousand times.
  process.stdout.write(`=== placements of one ${String(24 * 24 * 2)}-triangle mesh ===\n`);
  process.stdout.write(
    `  ${'parts'.padStart(6)}  ${'OBJ total'.padStart(11)} ${'OBJ bytes'.padStart(10)}` +
      `  ${'3MF total'.padStart(11)} ${'3MF bytes'.padStart(10)}\n`,
  );

  for (const count of [1, 10, 100, 1_000]) {
    const parts = Array.from({ length: count }, (_part, index) => ({
      mesh,
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, index * 30, 0, 0] as unknown as PartTransform,
    }));
    const document = documentOf(parts);
    const snapshot = exportSnapshotOf(document, 'bench', 1);

    const obj = await best(async () => timeObj(document));
    const threeMf = await best(async () => time3mf(snapshot));

    process.stdout.write(
      `  ${String(count).padStart(6)}  ${ms(obj.totalMs).padStart(11)} ${mib(obj.outputBytes).padStart(10)}` +
        `  ${ms(threeMf.totalMs).padStart(11)} ${mib(threeMf.outputBytes).padStart(10)}\n`,
    );
  }
  process.stdout.write('\n');
}, 900_000);
