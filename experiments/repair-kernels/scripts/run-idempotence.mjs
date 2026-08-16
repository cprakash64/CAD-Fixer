#!/usr/bin/env node
/**
 * Applies ONE operation TWICE, in one isolated process, and returns both
 * outputs.
 *
 * Stage 3A-3A §F. Idempotence is `f(f(x)) == f(x)`, so both intermediate and
 * final geometry have to cross back: comparing only counts would let a kernel
 * that reshuffled coordinates on the second pass score as idempotent, which is
 * exactly the inference the spec forbids ("Do not treat equal triangle counts
 * as proof").
 *
 * The second pass is fed the FIRST PASS'S OUTPUT, re-indexed exactly as the
 * candidate emitted it. Re-welding between passes would launder a defect the
 * candidate introduced and make the second pass a different experiment.
 *
 * Usage: run-idempotence.mjs <request.json> <result.json>
 *   request: { candidateId, operation, parameter, positions, triangles }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadGeogram, loadManifold, loadPmp } from './candidates.mjs';

const [, , requestPath, resultPath] = process.argv;
if (requestPath === undefined || resultPath === undefined) {
  console.error('usage: run-idempotence.mjs <request.json> <result.json>');
  process.exit(2);
}

const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const loaders = { manifold: loadManifold, geogram: loadGeogram, pmp: loadPmp };
const load = loaders[request.candidateId];
if (load === undefined) {
  writeFileSync(resultPath, JSON.stringify({ outcome: 'UNKNOWN_CANDIDATE' }));
  process.exit(0);
}

let candidate;
try {
  candidate = await load();
} catch (cause) {
  writeFileSync(
    resultPath,
    JSON.stringify({ outcome: 'LOAD_FAILED', message: String(cause).slice(0, 300) }),
  );
  process.exit(0);
}

function apply(positions, triangles) {
  const outcome = candidate.run(request.operation, positions, triangles, request.parameter);
  return {
    status: outcome.status ?? null,
    unsupportedOperation: outcome.unsupported ?? null,
    unsupportedInput: outcome.unsupportedInput === true,
    kernelMs: outcome.kernelMs ?? 0,
    filledHoles: outcome.filledHoles ?? null,
    positions: outcome.outPositions,
    triangles: outcome.outTriangles,
  };
}

try {
  const first = apply(new Float64Array(request.positions), new Uint32Array(request.triangles));
  let second = null;
  if (first.positions !== undefined && first.triangles !== undefined) {
    second = apply(first.positions.slice(), first.triangles.slice());
  }

  writeFileSync(
    resultPath,
    JSON.stringify({
      outcome: 'RAN',
      first: {
        status: first.status,
        unsupportedOperation: first.unsupportedOperation,
        unsupportedInput: first.unsupportedInput,
        kernelMs: first.kernelMs,
        filledHoles: first.filledHoles,
        positions: first.positions === undefined ? null : Array.from(first.positions),
        triangles: first.triangles === undefined ? null : Array.from(first.triangles),
      },
      second:
        second === null
          ? null
          : {
              status: second.status,
              unsupportedOperation: second.unsupportedOperation,
              unsupportedInput: second.unsupportedInput,
              kernelMs: second.kernelMs,
              filledHoles: second.filledHoles,
              positions: second.positions === undefined ? null : Array.from(second.positions),
              triangles: second.triangles === undefined ? null : Array.from(second.triangles),
            },
    }),
  );
} catch (cause) {
  writeFileSync(
    resultPath,
    JSON.stringify({ outcome: 'ABORTED', message: String(cause).slice(0, 500) }),
  );
}
