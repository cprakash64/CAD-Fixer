import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { beforeAll, it } from 'vitest';
import createSelfIntersectionKernel from '@cadfixer/self-intersection-kernel';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { extractBoundaryLoops } from '@cadfixer/mesh-topology';
import {
  collectNonManifoldDefects,
  diffNonManifoldDefects,
  runHoleFill,
  type HoleFillStatus,
  type HoleFillValidationSummary,
  type PatchNarrowphase,
} from '@cadfixer/mesh-hole-fill';
import { recoverVertexIdentity } from '@cadfixer/mesh-topology';
import {
  hp02QuadHole,
  hpBoundaryOfSize,
  tetrahedron,
  concatMeshes,
} from '@cadfixer/mesh-hole-fill/fixtures';
import { createKernelNarrowphase } from '../apps/web/src/workers/hole-fill-narrowphase';

/**
 * WHERE HOLE-FILL TIME ACTUALLY GOES. NOT part of CI.
 *
 * THIS IS THE EVIDENCE BEHIND TWO PRODUCTION CONSTANTS, and it exists because
 * ADR 0018 refused to inherit them: "a boundary-vertex ceiling in the low
 * hundreds, and a part-size ceiling governed by the validator", both to be set
 * from numbers rather than from a number that sounded safe.
 *
 * IT MEASURES THE PRODUCTION PATH, kernel included. A benchmark of the
 * triangulator alone would measure the cheap half: Stage 4B-1A found validation
 * dominating by one to two orders of magnitude, and the whole point of the
 * ceilings is to bound the expensive half.
 *
 * Three measured iterations after a warm-up, and the MEDIAN is reported —
 * a mean lets one scheduling hiccup rewrite the answer.
 */

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
  throw new Error(`Could not locate ${relative} from ${process.cwd()}`);
}

let narrowphase: () => PatchNarrowphase;

beforeAll(async () => {
  const module = await createSelfIntersectionKernel({ wasmBinary: readFileSync(kernelWasmPath()) });
  narrowphase = (): PatchNarrowphase => createKernelNarrowphase(module);
});

/** The rim at `z = 0`: the loop every tube fixture is about. */
function topLoopId(mesh: CanonicalMesh): string {
  const set = extractBoundaryLoops(mesh);
  let best: { id: string; height: number } | undefined;
  for (const loop of set.loops) {
    if (loop.refusal !== undefined || loop.vertices.length === 0) continue;
    let height = -Infinity;
    for (const vertex of loop.vertices) {
      const corner = (set.vertexRepresentativeCorner[vertex] ?? 0) * 3;
      height = Math.max(height, mesh.positions[corner + 2] ?? 0);
    }
    if (best === undefined || height > best.height) best = { id: loop.id, height };
  }
  return best?.id ?? 'bl-missing';
}

interface Measurement {
  readonly status: HoleFillStatus;
  readonly totalMs: number;
  readonly summary: HoleFillValidationSummary;
}

function measure(mesh: CanonicalMesh, iterations = 3): Measurement {
  const loopId = topLoopId(mesh);
  const run = (): Measurement => {
    const started = performance.now();
    const result = runHoleFill({
      source: mesh,
      request: {
        operationId: 'bench',
        documentId: 'bench',
        revision: 1,
        partId: 'bench',
        boundaryLoopId: loopId,
      },
      narrowphase: narrowphase(),
      now: () => performance.now(),
    });
    return {
      status: result.outcome.status,
      totalMs: performance.now() - started,
      summary: result.outcome.summary,
    };
  };

  run(); // warm-up: JIT, kernel heap growth, first-touch page faults.
  const samples: Measurement[] = [];
  for (let index = 0; index < iterations; index += 1) samples.push(run());
  samples.sort((left, right) => left.totalMs - right.totalMs);
  return samples[Math.floor(samples.length / 2)] ?? samples[0] ?? run();
}

function report(label: string, measurement: Measurement): void {
  const phases = measurement.summary.phaseMilliseconds;
  const ms = (value: number): string => value.toFixed(2).padStart(9);
  // eslint-disable-next-line no-console -- a benchmark's whole output is its report.
  console.log(
    [
      label.padEnd(34),
      measurement.status.padEnd(18),
      `loop${ms(phases.loopResolution)}`,
      `elig${ms(phases.eligibility)}`,
      `plan${ms(phases.planarity)}`,
      `tri${ms(phases.triangulation)}`,
      `asm${ms(phases.candidateAssembly)}`,
      `struct${ms(phases.structuralValidation)}`,
      `topo${ms(phases.topologyValidation)}`,
      `broad${ms(phases.broadphase)}`,
      `narrow${ms(phases.narrowphase)}`,
      `TOTAL${ms(measurement.totalMs)}`,
      `patch=${String(measurement.summary.patchFaceCount)}`,
      `cand=${String(measurement.summary.broadphaseCandidates)}`,
      `narrowPairs=${String(measurement.summary.narrowphaseChecks)}`,
    ].join('  '),
  );
}

/** A tube whose rim has `vertices` corners, on a part with `extraFaces` bulk. */
function part(vertices: number, extraFaces: number): CanonicalMesh {
  const hole = vertices === 4 ? hp02QuadHole() : hpBoundaryOfSize(vertices);
  if (extraFaces <= 0) return hole;
  const bodies: CanonicalMesh[] = [hole];
  for (let index = 0; index < Math.ceil(extraFaces / 4); index += 1) {
    // Spread far from the hole so the bulk exercises the BROADPHASE rather than
    // the narrowphase: the question is whether a large part costs anything when
    // none of it is near the patch.
    bodies.push(tetrahedron([100_000 + index * 0.5, 0, 0], 0.25));
  }
  return concatMeshes(...bodies);
}

it('boundary size: where the O(n^2) ear search and the patch/patch scan bite', () => {
  // eslint-disable-next-line no-console -- see above.
  console.log('\n--- boundary size, on a bare tube ---');
  for (const vertices of [8, 32, 128, 256, 384, 511, 512]) {
    report(`boundary ${String(vertices)}`, measure(part(vertices, 0)));
  }
});

it('part size: what the validator costs when the part is large and the hole is not', () => {
  // eslint-disable-next-line no-console -- see above.
  console.log('\n--- part size, four-vertex hole ---');
  for (const faces of [10_000, 50_000, 100_000, 200_000, 249_000]) {
    report(`part ~${String(faces)} faces`, measure(part(4, faces), 3));
  }
});

it('the combination: a large boundary on a large part', () => {
  // eslint-disable-next-line no-console -- see above.
  console.log('\n--- combined ---');
  report('512 boundary / 100k faces', measure(part(512, 100_000), 3));
  // 1,024 wall faces come from the rim itself, so the bulk stops short of the
  // ceiling rather than crossing it and turning the measurement into a refusal.
  report('512 boundary / 248k faces', measure(part(512, 247_000), 3));
});

it('bounded memory: the candidate pair count never approaches patch x source', () => {
  /*
   * THE PROOF THAT THE RESEARCH SHAPE IS GONE. Stage 4B-1A tested every
   * (patch, face) pair and exhausted a 1.7 GB heap. Here the ratio of pairs
   * actually generated to the naive product is reported directly, so the claim
   * is a measurement rather than an assertion about the code.
   */
  // eslint-disable-next-line no-console -- see above.
  console.log('\n--- broadphase reduction ---');
  for (const [vertices, faces] of [
    [8, 100_000],
    [128, 100_000],
    [512, 247_000],
  ] as const) {
    const measurement = measure(part(vertices, faces), 1);
    const naive = measurement.summary.patchFaceCount * measurement.summary.sourceFaceCount;
    const ratio = naive === 0 ? 0 : measurement.summary.broadphaseCandidates / naive;
    // eslint-disable-next-line no-console -- see above.
    console.log(
      `boundary ${String(vertices).padStart(4)} / ${String(faces).padStart(7)} faces  ` +
        `naive pairs ${naive.toLocaleString().padStart(14)}  ` +
        `generated ${measurement.summary.broadphaseCandidates.toLocaleString().padStart(10)}  ` +
        `ratio ${ratio.toExponential(2)}  ` +
        `nodeVisits ${measurement.summary.broadphaseNodeVisits.toLocaleString()}`,
    );
  }
});

it('R1: what the closure checks cost', () => {
  /*
   * STAGE 4B-1B1-R1 added two gates, and both had to be shown affordable
   * rather than assumed so:
   *
   *   1. an authoritative BYTE comparison of the returned candidate against the
   *      resident source — linear in source bytes, and a `memcmp` in all but
   *      name;
   *   2. a NON-MANIFOLD DIFFERENTIAL by defect identity, which builds edge and
   *      vertex manifoldness for the source AND the candidate.
   *
   * The second is the one that could have been expensive. It is measured
   * beside the topology validation it joins, so the report is a share of an
   * existing cost rather than a number with nothing to compare it to.
   */
  // eslint-disable-next-line no-console -- a benchmark's whole output is its report.
  console.log('\n--- R1 closure checks ---');

  for (const faces of [10_000, 100_000, 249_000]) {
    const mesh = part(4, faces);
    const identity = recoverVertexIdentity(mesh);

    // The byte comparison, as the authoritative worker performs it: the
    // candidate's buffers against the resident part's.
    const candidatePositions = new Float32Array(mesh.positions);
    const candidateIndices = new Uint32Array(mesh.indices.length + 6);
    candidateIndices.set(mesh.indices, 0);

    const compare = (): boolean => {
      const a = new Uint8Array(
        mesh.positions.buffer,
        mesh.positions.byteOffset,
        mesh.positions.byteLength,
      );
      const b = new Uint8Array(
        candidatePositions.buffer,
        candidatePositions.byteOffset,
        candidatePositions.byteLength,
      );
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false;
      }
      const c = new Uint8Array(
        mesh.indices.buffer,
        mesh.indices.byteOffset,
        mesh.indices.byteLength,
      );
      const d = new Uint8Array(
        candidateIndices.buffer,
        candidateIndices.byteOffset,
        mesh.indices.byteLength,
      );
      for (let index = 0; index < c.length; index += 1) {
        if (c[index] !== d[index]) return false;
      }
      return true;
    };

    compare();
    const bytesStart = performance.now();
    for (let run = 0; run < 3; run += 1) compare();
    const bytesMs = (performance.now() - bytesStart) / 3;

    const defects = (): number => {
      const source = collectNonManifoldDefects(mesh, identity);
      const candidate = collectNonManifoldDefects(mesh, identity);
      return diffNonManifoldDefects(source, candidate).total;
    };
    defects();
    const defectStart = performance.now();
    for (let run = 0; run < 3; run += 1) defects();
    const defectMs = (performance.now() - defectStart) / 3;

    const whole = measure(mesh, 3);
    // eslint-disable-next-line no-console -- see above.
    console.log(
      `part ~${String(faces).padStart(7)} faces  ` +
        `bytes ${bytesMs.toFixed(2).padStart(8)} ms  ` +
        `defect differential ${defectMs.toFixed(2).padStart(9)} ms  ` +
        `topology phase ${whole.summary.phaseMilliseconds.topologyValidation.toFixed(2).padStart(9)} ms  ` +
        `TOTAL ${whole.totalMs.toFixed(2).padStart(9)} ms  ` +
        `bytes+differential share ${(((bytesMs + defectMs) / whole.totalMs) * 100).toFixed(1)}%`,
    );
  }
});
