#!/usr/bin/env node
/**
 * Runs EXACTLY ONE Geogram operation in its own process, then exits.
 *
 * Stage 3A-3A §B6. The Stage 3A-2 runner processed a whole fixture per process,
 * so one non-returning call took every later case in that process down with it
 * and those cases were recorded as TIMEOUT without ever having been attempted.
 * That is not isolation, it is contamination: a fixture's result depended on
 * which fixture ran before it.
 *
 * One operation per process makes a hang cost exactly one row. It is also the
 * only honest way to time the colocate path, because a process that has already
 * survived one abort is not in a comparable state to a fresh one.
 *
 * Usage: run-geogram-single.mjs <request.json> <result.json>
 *   request: { positions, triangles, operation, parameter, initMode }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadGeogram } from './candidates.mjs';

const [, , requestPath, resultPath] = process.argv;
if (requestPath === undefined || resultPath === undefined) {
  console.error('usage: run-geogram-single.mjs <request.json> <result.json>');
  process.exit(2);
}

const request = JSON.parse(readFileSync(requestPath, 'utf8'));

let candidate;
try {
  candidate = await loadGeogram({ initMode: request.initMode });
} catch (cause) {
  writeFileSync(
    resultPath,
    JSON.stringify({ outcome: 'LOAD_FAILED', message: String(cause).slice(0, 300) }),
  );
  process.exit(0);
}

const positions = new Float64Array(request.positions);
const triangles = new Uint32Array(request.triangles);

let outcome;
try {
  outcome = candidate.run(request.operation, positions, triangles, request.parameter);
} catch (cause) {
  // A Geogram assertion reaches Emscripten as a thrown abort. Recorded as
  // ABORTED with its message, never swallowed into a generic failure — the
  // message is the evidence this whole experiment exists to capture.
  writeFileSync(
    resultPath,
    JSON.stringify({
      outcome: 'ABORTED',
      initMode: request.initMode,
      message: String(cause).slice(0, 500),
    }),
  );
  process.exit(0);
}

writeFileSync(
  resultPath,
  JSON.stringify({
    outcome: 'RAN',
    initMode: request.initMode,
    initMs: candidate.initMs,
    artifact: candidate.artifact,
    kernelStatus: outcome.status ?? null,
    kernelMs: outcome.kernelMs ?? 0,
    heapBefore: outcome.heapBefore ?? 0,
    heapAfter: outcome.heapAfter ?? 0,
    moebiusFacets: outcome.moebiusFacets ?? null,
    outPositions: outcome.outPositions === undefined ? null : Array.from(outcome.outPositions),
    outTriangles: outcome.outTriangles === undefined ? null : Array.from(outcome.outTriangles),
  }),
);
