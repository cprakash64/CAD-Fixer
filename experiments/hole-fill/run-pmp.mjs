/**
 * CANDIDATE A — THE PINNED PMP ARTIFACT, MEASURED. RESEARCH ONLY.
 *
 * Uses the Stage 3A-2 build at PMP `af4725ccf6aa308e7ffad9a7bb927c6381b7c858`
 * (MIT), already vendored under `experiments/repair-kernels/pmp`. Nothing is
 * rebuilt here and nothing enters the product.
 *
 * WHAT THIS BINDING CAN AND CANNOT ANSWER. `cf_p_run(FILL_ALL_HOLES)` fills
 * EVERY boundary loop and republishes the whole mesh through a compacting walk.
 * For a single-hole fixture that is exactly the operation under test, so
 * patch geometry, vertex/face growth, orientation, determinism and provenance
 * are all measurable. What it cannot answer is per-loop selection, which is a
 * BINDING limitation rather than a PMP one — `pmp::fill_hole` takes a specific
 * boundary halfedge, so a per-loop binding is a small change and is recorded as
 * required work for 4B-1B rather than a risk.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { corpus } from './fixtures.mjs';
import { extractBoundaryLoops } from './boundary-loops.mjs';
import { narrowToFloat32, validateCandidate, eulerOf } from './validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(HERE, '..', 'repair-kernels', 'pmp', 'artifacts');

const OP_FILL_ALL = 1;

async function loadPmp() {
  const { default: create } = await import(join(ARTIFACTS, 'pmp-candidate.js'));
  const wasmBinary = readFileSync(join(ARTIFACTS, 'pmp-candidate.wasm'));
  const startedAt = performance.now();
  const mod = await create({ wasmBinary });
  return { mod, initMs: performance.now() - startedAt };
}

/**
 * Runs one operation.
 *
 * COORDINATES ARE WIDENED TO Float64 ON THE WAY IN, which is the contract the
 * binding declares (`const double*`). The narrowing back to canonical Float32
 * happens on the way out and is validated there — never before.
 */
function run(mod, operation, positions, indices) {
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;

  const positionBytes = positions.length * 8;
  const indexBytes = indices.length * 4;
  const positionPtr = mod._malloc(positionBytes);
  const indexPtr = mod._malloc(indexBytes);

  const doubles = new Float64Array(positions.length);
  for (let index = 0; index < positions.length; index += 1) doubles[index] = positions[index];
  mod.HEAPF64.set(doubles, positionPtr / 8);
  mod.HEAPU32.set(indices, indexPtr / 4);

  const startedAt = performance.now();
  const status = mod._cf_p_run(operation, positionPtr, vertexCount, indexPtr, triangleCount, 0);
  const ms = performance.now() - startedAt;

  const outVertices = mod._cf_p_vertex_count();
  const outTriangles = mod._cf_p_triangle_count();
  const outPositionPtr = mod._cf_p_positions();
  const outTrianglePtr = mod._cf_p_triangles();

  const outPositions = new Float64Array(
    mod.HEAPF64.buffer.slice(outPositionPtr, outPositionPtr + outVertices * 3 * 8),
  );
  const outIndices = new Uint32Array(
    mod.HEAPU32.buffer.slice(outTrianglePtr, outTrianglePtr + outTriangles * 3 * 4),
  );
  const filledHoles = mod._cf_p_filled_holes();

  mod._free(positionPtr);
  mod._free(indexPtr);
  mod._cf_p_reset();

  return { status, ms, outPositions, outIndices, filledHoles };
}

/**
 * Welds the source the way PMP will see it.
 *
 * PMP's `SurfaceMesh` builds connectivity from INDICES, so a soup mesh — every
 * corner its own vertex — has no connectivity at all and every triangle is an
 * isolated island. Feeding raw soup would measure nothing about hole filling.
 * The source is therefore welded by exact coordinates first, which is exactly
 * what production topology does before any analysis.
 */
function weldedMesh(positions, indices) {
  const extracted = extractBoundaryLoops(positions, indices);
  const vertexCount = extracted.representative.length;
  const welded = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    welded[vertex * 3] = extracted.representative[vertex][0];
    welded[vertex * 3 + 1] = extracted.representative[vertex][1];
    welded[vertex * 3 + 2] = extracted.representative[vertex][2];
  }
  const remapped = new Uint32Array(indices.length);
  for (let index = 0; index < indices.length; index += 1) {
    remapped[index] = extracted.vertexOf[indices[index]];
  }
  /*
   * THE EXTRACTION IS REDONE ON THE WELDED MESH, and that is not redundant.
   * `extracted` above maps RAW soup corners; the welded mesh has different
   * indices entirely, so using the raw map to look up welded indices produces
   * nonsense — it silently reported a Euler delta of −4 for a fixture whose
   * true delta is +1 before this was caught.
   */
  const weldedExtracted = extractBoundaryLoops(welded, remapped);
  return { positions: welded, indices: remapped, extracted: weldedExtracted };
}

async function main() {
  let { mod, initMs } = await loadPmp();
  const rows = [];

  /*
   * A LOOP-COUNT GUARD, and the reason for it is a finding rather than a
   * convenience.
   *
   * This binding's only hole operation is FILL EVERY LOOP. HF29 — a large part
   * whose filler geometry is disconnected triangle pairs — has 20,165 boundary
   * loops, and asking the kernel to fill all of them did not finish in twelve
   * minutes. That is exactly the hazard behind "do not silently batch hundreds
   * of patches": an operation whose cost is unbounded in the number of
   * openings cannot be offered as a single user action, and cannot be
   * independently validated afterwards either.
   *
   * The case is recorded as refused-by-policy rather than left to hang, and the
   * measurement stands as evidence for the per-loop operation shape.
   */
  const MAX_LOOPS_FOR_FILL_ALL = 64;

  /*
   * ONE FIXTURE PER PROCESS, driven by `run-pmp-all.mjs`.
   *
   * NOT A CONVENIENCE — it is the architectural finding made executable. PMP's
   * out-of-bounds trap on a 512-vertex loop is a WASM trap: the binding's
   * `catch (...)` never runs, the module's linear memory is left undefined, and
   * a later call on the same instance is meaningless. Isolating each run in its
   * own process here is the direct analogue of isolating it in its own
   * disposable worker in production.
   */
  const only = process.argv[2];

  for (const testCase of corpus()) {
    if (only !== undefined && testCase.id !== only) continue;
    const raw = testCase.build();
    const source = weldedMesh(raw.positions, raw.indices);
    const sourceFaceCount = source.indices.length / 3;
    const sourceVertexCount = source.positions.length / 3;

    if (source.extracted.loops.length > MAX_LOOPS_FOR_FILL_ALL) {
      rows.push({
        id: testCase.id,
        what: testCase.what,
        sourceFaces: sourceFaceCount,
        sourceVertices: sourceVertexCount,
        boundaryLoops: source.extracted.loops.length,
        outcome: 'NOT_ATTEMPTED_FILL_ALL_UNBOUNDED',
      });
      process.stderr.write(`${testCase.id} skipped: ${source.extracted.loops.length} loops\n`);
      continue;
    }

    process.stderr.write(`${testCase.id} …\n`);
    /*
     * THE KERNEL CAN TRAP, and a trap is not an exception.
     *
     * PMP raised `RuntimeError: memory access out of bounds` inside
     * `cf_p_run` on a 512-vertex boundary loop — a legal, planar, simple loop
     * that CAD Fixer's own extractor and triangulator both handle. A WASM trap
     * unwinds through the binding's `catch(...)` without being caught by it, so
     * the module's linear memory is left in an undefined state and every later
     * call on that instance is suspect.
     *
     * That is the single most important architectural finding in this stage: a
     * kernel that can trap cannot share a worker with authoritative geometry.
     * Here it is caught only so the rest of the matrix can be measured, and the
     * module is reloaded afterwards so one trap does not contaminate later
     * rows.
     */
    let first;
    try {
      first = run(mod, OP_FILL_ALL, source.positions, source.indices);
    } catch (error) {
      rows.push({
        id: testCase.id,
        what: testCase.what,
        sourceFaces: sourceFaceCount,
        sourceVertices: sourceVertexCount,
        boundaryLoops: source.extracted.loops.length,
        loopVertices: source.extracted.loops[0]?.vertices.length,
        outcome: 'KERNEL_TRAP',
        trap: String(error).slice(0, 120),
      });
      process.stderr.write(`${testCase.id} -> KERNEL_TRAP\n`);
      ({ mod } = await loadPmp());
      continue;
    }

    const row = {
      id: testCase.id,
      what: testCase.what,
      sourceFaces: sourceFaceCount,
      sourceVertices: sourceVertexCount,
      status: first.status,
      filledHoles: first.filledHoles,
      kernelMs: Number(first.ms.toFixed(2)),
      outVertices: first.outPositions.length / 3,
      outFaces: first.outIndices.length / 3,
    };

    if (first.status !== 0) {
      row.outcome = first.status === 10 ? 'UNSUPPORTED_INPUT_CLASS' : 'KERNEL_FAILURE';
      rows.push(row);
      continue;
    }

    row.addedVertices = row.outVertices - sourceVertexCount;
    row.addedFaces = row.outFaces - sourceFaceCount;

    /*
     * PROVENANCE, MEASURED RATHER THAN ASSUMED. PMP compacts after garbage
     * collection, so whether the original vertices keep their indices and
     * values is an empirical question — and it decides whether an append-only
     * candidate is even possible.
     */
    let prefixIdentical = true;
    for (let index = 0; index < sourceVertexCount * 3; index += 1) {
      if (first.outPositions[index] !== source.positions[index]) {
        prefixIdentical = false;
        break;
      }
    }
    row.vertexPrefixPreserved = prefixIdentical;

    let facePrefixIdentical = true;
    for (let index = 0; index < source.indices.length; index += 1) {
      if (first.outIndices[index] !== source.indices[index]) {
        facePrefixIdentical = false;
        break;
      }
    }
    row.facePrefixPreserved = facePrefixIdentical;

    /* DETERMINISM: the same input twice. */
    const second = run(mod, OP_FILL_ALL, source.positions, source.indices);
    row.deterministic =
      second.outPositions.length === first.outPositions.length &&
      second.outIndices.length === first.outIndices.length &&
      first.outPositions.every((value, index) => value === second.outPositions[index]) &&
      first.outIndices.every((value, index) => value === second.outIndices[index]);

    /*
     * INDEPENDENT VALIDATION, but only where the candidate is append-only.
     * When the prefix is preserved the result IS a source-plus-patch candidate
     * and every CAD Fixer check applies. When it is not, that is itself the
     * finding, and validating a reordered mesh against the source's byte
     * layout would report a provenance difference as a geometry failure.
     */
    if (prefixIdentical && facePrefixIdentical && testCase.expect.loops === 1) {
      const loop = source.extracted.loops[0];
      const candidate = {
        positions: narrowToFloat32(first.outPositions),
        indices: first.outIndices,
      };
      const validation = validateCandidate(source, candidate, {
        loopVertices: loop.vertices.length,
        loopId: loop.id,
        loopVertexIds: loop.vertices,
        sourceFaceCount,
      });
      row.outcome = validation.status;
      row.failures = validation.failures;
      row.patchIntersections = validation.notes.patchIntersections;
      row.smallestPatchArea = validation.notes.smallestPatchArea;
      row.chiDelta = validation.notes.euler.chi - eulerOf(source, source.extracted).chi;
    } else {
      row.outcome = prefixIdentical && facePrefixIdentical ? 'NOT_SINGLE_HOLE' : 'PROVENANCE_LOST';
    }

    rows.push(row);
    process.stderr.write(`${testCase.id} -> ${row.outcome} (${row.kernelMs ?? '-'}ms)\n`);
  }

  process.stdout.write(`${JSON.stringify({ initMs, rows }, null, 2)}\n`);
  /*
   * EXPLICIT EXIT. The Emscripten module keeps a handle that stops the event
   * loop draining, so a child that has finished its work still never exits and
   * the parent's timeout fires — which looks exactly like a hang in the kernel
   * and is not one. Distinguishing the two mattered: the first isolated run
   * reported every fixture as a 120-second abort.
   */
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
