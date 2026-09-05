/**
 * THE STAGE 4B-1A QUALIFICATION RUN. RESEARCH ONLY.
 *
 * Drives both candidates over HF01–HF30, validates every result with CAD
 * Fixer's own independent checks, and prints a matrix. Nothing here is
 * production; nothing here is imported by production.
 */

import { performance } from 'node:perf_hooks';
import { corpus } from './fixtures.mjs';
import { extractBoundaryLoops } from './boundary-loops.mjs';
import { earClip, assessPlanarity } from './ear-clip.mjs';
import { narrowToFloat32, validateCandidate, eulerOf } from './validate.mjs';

const MAX_LOOP_VERTICES = 4096;

/** Appends patch triangles using ONLY existing vertices. Append-only by design. */
function applyEarClipPatch(source, loop, welded, triangles) {
  const corners = loop.vertices;
  // Map welded vertex ids back to a representative RAW corner index, so the
  // patch reuses the source's own vertices rather than adding any.
  const rawOf = new Map();
  for (let raw = 0; raw < welded.vertexOf.length; raw += 1) {
    const id = welded.vertexOf[raw];
    if (!rawOf.has(id)) rawOf.set(id, raw);
  }

  const extra = new Uint32Array(triangles.length * 3);
  let at = 0;
  for (const [a, b, c] of triangles) {
    extra[at] = rawOf.get(corners[a]);
    extra[at + 1] = rawOf.get(corners[b]);
    extra[at + 2] = rawOf.get(corners[c]);
    at += 3;
  }

  const indices = new Uint32Array(source.indices.length + extra.length);
  indices.set(source.indices, 0);
  indices.set(extra, source.indices.length);
  // POSITIONS ARE UNTOUCHED: no vertex is added, so the array is the same one.
  return { positions: source.positions, indices };
}

/** The largest eligible loop, which is the one these fixtures intend to fill. */
function selectLoop(result) {
  if (result.loops.length === 0) return undefined;
  return result.loops.reduce((best, loop) =>
    loop.vertices.length > best.vertices.length ? loop : best,
  );
}

function patchArea(mesh, from) {
  let total = 0;
  for (let face = from; face < mesh.indices.length / 3; face += 1) {
    const p = [0, 1, 2].map((c) => {
      const v = mesh.indices[face * 3 + c] * 3;
      return [mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]];
    });
    const ux = p[1][0] - p[0][0];
    const uy = p[1][1] - p[0][1];
    const uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0];
    const vy = p[2][1] - p[0][1];
    const vz = p[2][2] - p[0][2];
    total += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return total;
}

async function main() {
  const rows = [];

  for (const testCase of corpus()) {
    const source = testCase.build();
    const sourceFaceCount = source.indices.length / 3;
    const startedExtract = performance.now();
    const extracted = extractBoundaryLoops(source.positions, source.indices, {
      maxLoopVertices: MAX_LOOP_VERTICES,
    });
    const extractMs = performance.now() - startedExtract;

    const row = {
      id: testCase.id,
      what: testCase.what,
      faces: sourceFaceCount,
      loops: extracted.loops.length,
      refusals: [...new Set(extracted.refusals.map((r) => r.reason))],
      extractMs: Number(extractMs.toFixed(2)),
    };

    const loop = selectLoop(extracted);
    if (loop === undefined) {
      row.outcome = 'REFUSED_UNSAFE_BOUNDARY';
      rows.push(row);
      continue;
    }

    row.loopVertices = loop.vertices.length;
    row.loopId = loop.id;

    const points = loop.vertices.map((vertex) => extracted.representative[vertex]);
    const planarity = assessPlanarity(points);
    row.planarRelative = Number(planarity.relative.toExponential(3));
    row.planar = planarity.planar;

    const startedFill = performance.now();
    const clipped = earClip(points);
    const fillMs = performance.now() - startedFill;
    row.fillMs = Number(fillMs.toFixed(2));

    if (clipped.refusal) {
      row.outcome = `EARCLIP_${clipped.refusal}`;
      rows.push(row);
      continue;
    }

    row.patchTriangles = clipped.triangles.length;
    row.addedVertices = 0;

    const candidate = applyEarClipPatch(source, loop, extracted, clipped.triangles);
    // The candidate's positions are ALREADY canonical Float32 — no vertex was
    // added — but narrowing is applied unconditionally so the validated
    // representation is always the one that would become authoritative.
    const narrowed = {
      positions: narrowToFloat32(candidate.positions),
      indices: candidate.indices,
    };

    const startedValidate = performance.now();
    const validation = validateCandidate(source, narrowed, {
      loopVertices: loop.vertices.length,
      loopId: loop.id,
      loopVertexIds: loop.vertices,
      sourceFaceCount,
    });
    row.validateMs = Number((performance.now() - startedValidate).toFixed(2));

    row.outcome = validation.status;
    row.failures = validation.failures;
    row.notes = validation.notes;

    // Analytic area comparison, where the fixture knows the answer.
    if (testCase.expect.patchArea !== undefined && planarity.normal) {
      const produced = patchArea(narrowed, sourceFaceCount);
      const expected = testCase.expect.patchArea;
      row.patchArea = Number(produced.toFixed(6));
      row.expectedArea = Number(expected.toFixed(6));
      row.areaRelativeError = Number((Math.abs(produced - expected) / expected).toExponential(3));
    }

    // Euler corroboration.
    const before = eulerOf(source, extracted);
    row.chiBefore = before.chi;
    row.chiAfter = validation.notes.euler.chi;
    row.chiDelta = validation.notes.euler.chi - before.chi;

    rows.push(row);
  }

  process.stdout.write(
    `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
