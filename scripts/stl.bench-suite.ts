import { performance } from 'node:perf_hooks';
import { it } from 'vitest';
import {
  DEFAULT_IMPORT_BUDGET,
  readStl,
  writeAsciiStl,
  writeBinaryStl,
  type FormatReadContext,
} from '@cadfixer/file-formats';
import { computeBounds, computeVertexNormals, validateMeshStructure } from '@cadfixer/mesh-core';
import { uncancellable } from '@cadfixer/shared';

/**
 * STL import/export benchmark.
 *
 * Run with `npm run bench:stl`. NOT part of CI — see vitest.bench.config.ts for
 * why. Results belong in docs/PERFORMANCE_BASELINE.md alongside the hardware
 * they were measured on.
 *
 * Test files are generated in memory at the requested sizes and never written
 * to disk, so nothing large is committed.
 *
 * Sizes can be overridden: `CADFIXER_BENCH_MB=1,10,50,100,250 npm run bench:stl`
 */

const BINARY_PREFIX_BYTES = 84;
const BINARY_FACET_BYTES = 50;

function context(): FormatReadContext {
  return {
    cancellation: uncancellable,
    budget: DEFAULT_IMPORT_BUDGET,
    progress: { report: (): void => undefined },
    yieldToEventLoop: (): Promise<void> => Promise.resolve(),
    decodeText: (input: Uint8Array): string =>
      new TextDecoder('utf-8', { fatal: false }).decode(input),
  };
}

/**
 * Builds a binary STL of approximately `targetBytes`.
 *
 * The triangles form a deterministic lattice of DISTINCT positions rather than
 * one triangle repeated, so the measurement is not flattered by a fixture whose
 * data happens to be trivially cache-friendly.
 */
function buildBinaryStl(targetBytes: number): { bytes: Uint8Array; triangles: number } {
  const triangles = Math.max(
    1,
    Math.floor((targetBytes - BINARY_PREFIX_BYTES) / BINARY_FACET_BYTES),
  );
  const bytes = new Uint8Array(BINARY_PREFIX_BYTES + triangles * BINARY_FACET_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles, true);

  for (let index = 0; index < triangles; index += 1) {
    const offset = BINARY_PREFIX_BYTES + index * BINARY_FACET_BYTES;
    const x = (index % 512) * 0.37;
    const y = Math.floor(index / 512) * 0.41;
    const z = ((index * 7919) % 1024) * 0.05;

    view.setFloat32(offset + 8, 1, true);
    const corners: readonly (readonly [number, number, number])[] = [
      [x, y, z],
      [x + 0.9, y + 0.1, z],
      [x + 0.2, y + 0.8, z + 0.3],
    ];
    for (let corner = 0; corner < 3; corner += 1) {
      const source = corners[corner] ?? [0, 0, 0];
      const base = offset + 12 + corner * 12;
      view.setFloat32(base, source[0], true);
      view.setFloat32(base + 4, source[1], true);
      view.setFloat32(base + 8, source[2], true);
    }
  }
  return { bytes, triangles };
}

function mib(value: number): string {
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function measure<T>(run: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = run();
  return { ms: performance.now() - start, value };
}

async function measureAsync<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await run();
  return { ms: performance.now() - start, value };
}

function parseSizes(): number[] {
  const raw = process.env.CADFIXER_BENCH_MB;
  if (raw === undefined || raw.trim().length === 0) return [1, 10, 50, 100];
  return raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

it('measures STL import and export across representative sizes', async () => {
  const sizes = parseSizes();

  process.stdout.write(
    `\nnode ${process.version} on ${process.platform}/${process.arch}\n` +
      `run at ${new Date().toISOString()}\n\n`,
  );

  for (const sizeMb of sizes) {
    const { bytes, triangles } = buildBinaryStl(Math.floor(sizeMb * 1024 * 1024));

    const parsed = await measureAsync(() => readStl(bytes, context()));
    const mesh = parsed.value.mesh;

    const validated = measure(() => validateMeshStructure(mesh));
    const bounds = measure(() => computeBounds(mesh));
    const normals = measure(() => computeVertexNormals(mesh));
    const binaryOut = await measureAsync(() => writeBinaryStl(mesh, context()));
    const asciiOut = await measureAsync(() => writeAsciiStl(mesh, context()));
    // Parsed back so the ASCII path is measured on real ASCII input rather than
    // being assumed to behave like the binary one. It does not: ASCII is
    // tokenised and every coordinate goes through a decimal conversion.
    //
    // Above roughly 90 MiB of binary input the ASCII rendering of the same
    // model exceeds the default intake limit — a real consequence of ASCII
    // being about 5.2x larger, not a bug in the benchmark. Skipped rather than
    // raising the budget, because the limit is the thing being characterised.
    const asciiFitsBudget = asciiOut.value.bytes.byteLength <= DEFAULT_IMPORT_BUDGET.maxInputBytes;
    const asciiParse = asciiFitsBudget
      ? await measureAsync(() => readStl(asciiOut.value.bytes, context()))
      : undefined;

    const positionBytes = mesh.positions.byteLength;
    const indexBytes = mesh.indices.byteLength;
    const normalBytes = normals.value.byteLength;
    const canonicalBytes = positionBytes + indexBytes;
    const workingBytes = canonicalBytes + normalBytes;

    process.stdout.write(
      [
        `input ${mib(bytes.byteLength)}  triangles ${triangles.toLocaleString()}`,
        `  parse            ${parsed.ms.toFixed(0).padStart(6)} ms   ` +
          `(${((bytes.byteLength / (1024 * 1024) / parsed.ms) * 1000).toFixed(0)} MiB/s)`,
        `  validate         ${validated.ms.toFixed(0).padStart(6)} ms`,
        `  bounds           ${bounds.ms.toFixed(0).padStart(6)} ms`,
        `  render normals   ${normals.ms.toFixed(0).padStart(6)} ms`,
        `  write binary     ${binaryOut.ms.toFixed(0).padStart(6)} ms  -> ${mib(binaryOut.value.bytes.byteLength)}`,
        `  write ascii      ${asciiOut.ms.toFixed(0).padStart(6)} ms  -> ${mib(asciiOut.value.bytes.byteLength)}`,
        asciiParse === undefined
          ? `  parse ascii         skipped   (${mib(asciiOut.value.bytes.byteLength)} exceeds the ${mib(DEFAULT_IMPORT_BUDGET.maxInputBytes)} intake limit)`
          : `  parse ascii      ${asciiParse.ms.toFixed(0).padStart(6)} ms   ` +
            `(${((asciiOut.value.bytes.byteLength / (1024 * 1024) / asciiParse.ms) * 1000).toFixed(0)} MiB/s)`,
        `  positions ${mib(positionBytes)} | indices ${mib(indexBytes)} | render normals ${mib(normalBytes)}`,
        `  canonical ${mib(canonicalBytes)} (${(canonicalBytes / bytes.byteLength).toFixed(2)}x input)` +
          `  working ${mib(workingBytes)} (${(workingBytes / bytes.byteLength).toFixed(2)}x input)`,
        `  float32 positions ${mib(positionBytes)} vs float64 ${mib(positionBytes * 2)}` +
          `  -> canonical would be ${mib(canonicalBytes + positionBytes)} (${(
            (canonicalBytes + positionBytes) /
            bytes.byteLength
          ).toFixed(2)}x input)`,
        '',
      ].join('\n'),
    );
  }
});
