#!/usr/bin/env node
/**
 * Runs EXACTLY ONE Manifold operation in its own process, then exits.
 *
 * Stage 3A-3A §C. Same isolation rationale as the Geogram single runner: a
 * synchronous WASM call cannot be interrupted from inside its own process, so
 * the only cancellation available is killing the process, and a shared process
 * would let one hang erase unrelated rows.
 *
 * Two request kinds:
 *   { kind: 'boolean', opType, a: {positions, triangles}, b: {...} }
 *   { kind: 'run', operation, positions, triangles }
 *
 * Usage: run-manifold-single.mjs <request.json> <result.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadManifold } from './candidates.mjs';

const [, , requestPath, resultPath] = process.argv;
if (requestPath === undefined || resultPath === undefined) {
  console.error('usage: run-manifold-single.mjs <request.json> <result.json>');
  process.exit(2);
}

const request = JSON.parse(readFileSync(requestPath, 'utf8'));

let candidate;
try {
  candidate = await loadManifold();
} catch (cause) {
  writeFileSync(
    resultPath,
    JSON.stringify({ outcome: 'LOAD_FAILED', message: String(cause).slice(0, 300) }),
  );
  process.exit(0);
}

const asArrays = (side) => ({
  positions: new Float64Array(side.positions),
  triangles: new Uint32Array(side.triangles),
});

let outcome;
try {
  if (request.kind === 'boolean') {
    outcome = candidate.boolean(request.opType, asArrays(request.a), asArrays(request.b));
  } else {
    outcome = candidate.run(
      request.operation,
      new Float64Array(request.positions),
      new Uint32Array(request.triangles),
    );
  }
} catch (cause) {
  writeFileSync(
    resultPath,
    JSON.stringify({ outcome: 'ABORTED', message: String(cause).slice(0, 500) }),
  );
  process.exit(0);
}

writeFileSync(
  resultPath,
  JSON.stringify({
    outcome: 'RAN',
    initMs: candidate.initMs,
    artifact: candidate.artifact,
    kernelStatus: outcome.status ?? null,
    kernelMs: outcome.kernelMs ?? 0,
    heapBefore: outcome.heapBefore ?? 0,
    heapAfter: outcome.heapAfter ?? 0,
    kernelReportedSuccess: outcome.kernelReportedSuccess ?? null,
    genus: outcome.genus ?? null,
    volume: outcome.volume ?? null,
    // Manifold's OWN component count, via Decompose(). Recorded beside CAD
    // Fixer's independent count so the two can disagree visibly.
    kernelComponents: outcome.components ?? null,
    mergeChanged: outcome.mergeChanged ?? null,
    outPositions: outcome.outPositions === undefined ? null : Array.from(outcome.outPositions),
    outTriangles: outcome.outTriangles === undefined ? null : Array.from(outcome.outTriangles),
  }),
);
