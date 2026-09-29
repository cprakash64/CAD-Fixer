import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { it } from 'vitest';
import createSelfIntersectionKernel from '@cadfixer/self-intersection-kernel';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  analyseTopology,
  estimateBoundaryLoopBytes,
  estimateBoundaryScanBytes,
  estimateEdgeBytes,
  estimateManifoldBytes,
  estimateVertexIdentityBytes,
  extractBoundaryLoops,
  peakOf,
  scanBoundaries,
  stage,
} from '@cadfixer/mesh-topology';
import {
  admitBoundaryLoops,
  appendPatches,
  buildLocalPatchProblem,
  classifyLocalPatches,
  DEFAULT_BOUNDARY_FILL_LIMITS,
  judgeFilledCandidate,
} from '@cadfixer/mesh-hole-fill';
import { uncancellable } from '@cadfixer/shared';
import { createKernelNarrowphase } from '../apps/web/src/workers/hole-fill-narrowphase';
import { gridForTriangles, holedCubeStl } from './boundary-fill-fixture.mjs';

/**
 * REPAIR-CORE-02 — PHASE COSTS OF AUTOMATIC BOUNDARY FILLING, 100k → 2M.
 *
 * NOT part of CI. Run with `npm run bench:boundary-fill`. Numbers depend on the
 * machine; they are transcribed into `docs/design/REPAIR_CORE_02.md` with the
 * hardware they came from.
 *
 * FIXTURE: the holed cube (6 simple planar openings, 7 branched boundaries,
 * otherwise closed), and — for the pathological shape the old listing blew up
 * on — loose triangles, where every edge is a boundary edge.
 *
 * FOR COMPARISON, the per-opening path's own boundary walk
 * (`extractBoundaryLoops`) on the same meshes, which is what hole filling used
 * to need before it could touch a single loop.
 *
 * MEMORY. `scan.tableBytes` is the scan's one part-proportional allocation at
 * its largest (including the final growth's overlap). The old path is reported
 * as the heap + array-buffer growth while its result is held, which is a LOWER
 * bound on its peak (its radix-sort scratch and probe table are already gone).
 */

const MIB = 1024 * 1024;
const ms = (value: number): string => `${value.toFixed(0)} ms`.padStart(9);
const mb = (value: number): string => `${(value / MIB).toFixed(1)} MiB`.padStart(11);

/** Collects first when the process was started with `--expose-gc`. */
function held(): number {
  const collect = (globalThis as { gc?: () => void }).gc;
  collect?.();
  collect?.();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

function soupFromBinaryStl(bytes: Uint8Array): CanonicalMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const positions = createPositionArray(count * 9);
  const indices = createIndexArray(count * 3);
  for (let face = 0; face < count; face += 1) {
    const base = 84 + face * 50 + 12;
    for (let k = 0; k < 9; k += 1) positions[face * 9 + k] = view.getFloat32(base + k * 4, true);
    indices[face * 3] = face * 3;
    indices[face * 3 + 1] = face * 3 + 1;
    indices[face * 3 + 2] = face * 3 + 2;
  }
  return { positions, indices, metadata: { sourceFormat: 'stl' } };
}

function looseTriangles(count: number): CanonicalMesh {
  const positions = createPositionArray(count * 9);
  const indices = createIndexArray(count * 3);
  for (let t = 0; t < count; t += 1) {
    const x = (t % 1024) * 0.5;
    const y = Math.floor(t / 1024) * 0.5;
    positions.set([x, y, 0, x + 0.4, y, 0, x, y + 0.4, 0], t * 9);
    indices.set([t * 3, t * 3 + 1, t * 3 + 2], t * 3);
  }
  return { positions, indices, metadata: {} };
}

function kernelWasmPath(): string {
  const relative = join(
    'packages',
    'self-intersection-kernel',
    'artifacts',
    'self-intersection.wasm',
  );
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not locate ${relative}`);
}

const SIZES = (process.env.CADFIXER_FILL_SIZES ?? '100000,250000,500000,1000000,2000000')
  .split(',')
  .map(Number);

it('boundary-fill phases by part size', { timeout: 3_600_000 }, async () => {
  const module = await createSelfIntersectionKernel({ wasmBinary: readFileSync(kernelWasmPath()) });
  const lines: string[] = [];

  for (const target of SIZES) {
    const cube = holedCubeStl(gridForTriangles(target));
    const mesh = soupFromBinaryStl(cube.bytes);
    const faces = mesh.indices.length / 3;

    let t = performance.now();
    const scan = scanBoundaries(mesh, {
      limits: {
        maxBoundaryEdges: DEFAULT_BOUNDARY_FILL_LIMITS.maxBoundaryEdges,
        maxLoopVertices: DEFAULT_BOUNDARY_FILL_LIMITS.maxLoopVertices,
      },
    });
    const scanMs = performance.now() - t;

    t = performance.now();
    const admission = admitBoundaryLoops(mesh, scan);
    const admitMs = performance.now() - t;

    t = performance.now();
    const problem = buildLocalPatchProblem(mesh, admission.admitted, {
      maxFaces: DEFAULT_BOUNDARY_FILL_LIMITS.maxLocalFaces,
    });
    const regionMs = performance.now() - t;

    t = performance.now();
    const verdicts = classifyLocalPatches(problem, createKernelNarrowphase(module));
    const kernelMs = performance.now() - t;
    const passing = admission.admitted.filter((_, index) => {
      const verdict = verdicts[index];
      return verdict !== undefined && verdict.complete && verdict.invalidPatchSourcePairs === 0;
    });

    t = performance.now();
    const before = analyseTopology(mesh, {
      documentId: 'b',
      partId: 'p',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;
    const candidate = appendPatches(mesh, passing);
    const after = analyseTopology(candidate, {
      documentId: 'b',
      partId: 'p',
      documentRevision: 2,
      cancellation: uncancellable,
    }).report;
    const regressions = judgeFilledCandidate(before, after, passing);
    const validateMs = (performance.now() - t) / 2; // one analysis is the source report, cached in the product

    // The per-opening path's own boundary walk, for comparison.
    const heldBefore = held();
    t = performance.now();
    const old = extractBoundaryLoops(mesh, { maxLoopVertices: 512 });
    const oldMs = performance.now() - t;
    const oldHeld = held() - heldBefore;
    // Keep `old` reachable until after the measurement.
    if (old.loops.length < 0) throw new Error('unreachable');
    // The old path's PEAK by the product's own memory model — the stages it
    // runs, each with its retained and transient arrays (see memory.ts). It
    // omits per-component JavaScript objects, so for loose triangles it is a
    // floor, and Stage 6D-R3 measured 691–1,034 B/face there.
    const oldModel = peakOf([
      estimateVertexIdentityBytes(faces * 3),
      stage(faces * 3 * 4, 0),
      estimateEdgeBytes(faces),
      estimateManifoldBytes(faces, old.vertexCount),
      estimateBoundaryLoopBytes(faces, old.vertexCount),
    ]);

    lines.push(
      `${faces.toLocaleString('en-US').padStart(10)} faces | scan ${ms(scanMs)} table ${mb(scan.tableBytes)} (${(scan.tableBytes / faces).toFixed(1)} B/face) | admit ${ms(admitMs)} ${String(admission.admitted.length)}/${String(scan.loops.length)} | region ${ms(regionMs)} ${String(problem.sourceFaceCount)} faces | kernel ${ms(kernelMs)} | re-analysis ${ms(validateMs)} | filled ${String(passing.length)} regressions ${String(regressions.length)} | OLD walk ${ms(oldMs)} modelled peak ${mb(oldModel)} (${(oldModel / faces).toFixed(0)} B/face), retained ${mb(oldHeld)}, ${String(old.loops.length)} loops`,
    );
  }

  // The pathological shape: every edge a boundary edge.
  for (const count of [1_000_000, 2_000_000]) {
    const mesh = looseTriangles(count);
    const t = performance.now();
    const scan = scanBoundaries(mesh, {
      limits: {
        maxBoundaryEdges: DEFAULT_BOUNDARY_FILL_LIMITS.maxBoundaryEdges,
        maxLoopVertices: DEFAULT_BOUNDARY_FILL_LIMITS.maxLoopVertices,
      },
    });
    lines.push(
      `${count.toLocaleString('en-US').padStart(10)} loose triangles | scan ${ms(performance.now() - t)} status ${scan.status} boundary edges ${scan.boundaryEdgeCount.toLocaleString('en-US')} table ${mb(scan.tableBytes)} (${(scan.tableBytes / count).toFixed(1)} B/face; bound ${mb(estimateBoundaryScanBytes(count))})`,
    );
  }

  process.stdout.write(
    `\nREPAIR-CORE-02 boundary-fill phases (Node ${process.version})\n${lines.join('\n')}\n`,
  );
});
