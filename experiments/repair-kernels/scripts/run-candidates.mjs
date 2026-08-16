#!/usr/bin/env node
/**
 * Runs the compiled candidates against prepared meshes, in a PLAIN NODE
 * process, ONE CANDIDATE PER INVOCATION.
 *
 * WHY A SEPARATE PROCESS. Emscripten's ES6 glue does not survive Vite's
 * transform: loaded through vitest, the Geogram module threw
 * "Cannot read properties of undefined (reading 'module')" on every call, while
 * the identical artifact worked under plain `node`. Rather than record 321
 * fabricated "crashes" as evidence about Geogram, the candidates run here,
 * untouched.
 *
 * WHY ONE CANDIDATE PER PROCESS, AND WHY RESULTS ARE APPENDED AS THEY FINISH.
 * A synchronous WASM call cannot be interrupted from inside this process — the
 * exact problem REPAIR_ARCHITECTURE.md predicts. During the first full run,
 * Geogram's `intersectSurface` consumed 28 minutes of CPU on a single fixture
 * with no way to stop it. So the parent applies a wall-clock timeout and kills
 * this process; because every completed case has already been flushed to disk,
 * the work up to the hang survives and the hang itself is recorded rather than
 * taking the whole bakeoff down.
 *
 * That is not a workaround. It IS the disposable-worker cancellation model from
 * §33, demonstrated at process granularity.
 *
 * Usage: run-candidates.mjs <candidate-id> <input.json> <output.jsonl> [fixtureId]
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadGeogram, loadManifold, loadPmp } from './candidates.mjs';

const [, , candidateId, inputPath, outputPath, onlyFixture] = process.argv;
if (candidateId === undefined || inputPath === undefined || outputPath === undefined) {
  console.error('usage: run-candidates.mjs <candidate-id> <input.json> <output.jsonl>');
  process.exit(2);
}

const loaders = { manifold: loadManifold, geogram: loadGeogram, pmp: loadPmp };
const load = loaders[candidateId];
if (load === undefined) {
  console.error(`unknown candidate: ${candidateId}`);
  process.exit(2);
}

const input = JSON.parse(readFileSync(inputPath, 'utf8'));
writeFileSync(outputPath, '');

let candidate;
try {
  candidate = await load();
} catch (cause) {
  appendFileSync(
    outputPath,
    `${JSON.stringify({ kind: 'meta', candidateId, loadFailed: String(cause).slice(0, 300) })}\n`,
  );
  process.exit(0);
}

appendFileSync(
  outputPath,
  `${JSON.stringify({
    kind: 'meta',
    candidateId,
    initMs: candidate.initMs,
    artifact: candidate.artifact,
    supports: candidate.supports,
  })}\n`,
);

for (const entry of input.cases) {
  if (entry.candidateId !== candidateId) continue;
  if (onlyFixture !== undefined && entry.fixtureId !== onlyFixture) continue;

  const positions = new Float64Array(entry.positions);
  const triangles = new Uint32Array(entry.triangles);

  const key = {
    fixtureId: entry.fixtureId,
    candidateId,
    operation: entry.operation,
    parameter: entry.parameter,
    run: entry.run,
  };

  // Announced BEFORE the call. If the process is killed mid-operation, the
  // parent can read this line and know exactly which case hung.
  appendFileSync(outputPath, `${JSON.stringify({ kind: 'start', ...key })}\n`);

  let outcome;
  try {
    outcome = candidate.run(entry.operation, positions, triangles, entry.parameter);
  } catch (cause) {
    appendFileSync(
      outputPath,
      `${JSON.stringify({ kind: 'result', ...key, status: 'CRASH', notes: [String(cause).slice(0, 200)] })}\n`,
    );
    continue;
  }

  appendFileSync(
    outputPath,
    `${JSON.stringify({
      kind: 'result',
      ...key,
      status: 'RAN',
      kernelStatus: outcome.status ?? null,
      unsupportedOperation: outcome.unsupported ?? null,
      unsupportedInput: outcome.unsupportedInput === true,
      kernelMs: outcome.kernelMs ?? 0,
      heapBefore: outcome.heapBefore ?? 0,
      heapAfter: outcome.heapAfter ?? 0,
      filledHoles: outcome.filledHoles ?? null,
      kernelReportedSuccess: outcome.kernelReportedSuccess ?? null,
      moebiusFacets: outcome.moebiusFacets ?? null,
      genus: outcome.genus ?? null,
      outPositions: outcome.outPositions === undefined ? null : Array.from(outcome.outPositions),
      outTriangles: outcome.outTriangles === undefined ? null : Array.from(outcome.outTriangles),
    })}\n`,
  );
}

appendFileSync(outputPath, `${JSON.stringify({ kind: 'done', candidateId })}\n`);
