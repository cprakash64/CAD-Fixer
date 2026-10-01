import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import createSelfIntersectionKernel from '@cadfixer/self-intersection-kernel';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  analyseTopology,
  extractBoundaryLoops,
  scanBoundaries,
  type TopologyReport,
} from '@cadfixer/mesh-topology';
import {
  admitBoundaryLoops,
  appendPatches,
  buildLocalPatchProblem,
  classifyLocalPatches,
  DEFAULT_BOUNDARY_FILL_LIMITS,
  judgeFilledCandidate,
  runHoleFill,
  sourcePreserved,
  type AdmittedLoop,
} from '@cadfixer/mesh-hole-fill';
import { uncancellable } from '@cadfixer/shared';
import { createKernelNarrowphase } from '../apps/web/src/workers/hole-fill-narrowphase';

/**
 * REPAIR-RC-03 — ENGINE EVIDENCE FOR A REAL MODEL.
 *
 * NOT part of CI and ships NO data. Point it at a binary STL:
 *
 *   CADFIXER_REAL_MODEL=/path/to/model.stl npm run qualify:real-model-fill
 *
 * It runs the automatic boundary-fill stage the way the geometry worker does —
 * compact scan, per-loop admission, the local region, the qualified Geogram
 * narrowphase, the append-only candidate and an independent Stage 2
 * re-analysis — and prints what the product UI deliberately does not show: the
 * verdict of every opening, each admitted opening's bounds, region size and
 * narrowphase outcome, every predicted count beside the measured one, the
 * source and patch areas, byte preservation, determinism, and whether a second
 * pass over the filled result finds anything new.
 *
 * REGION COMPLETENESS is checked independently here: a brute-force pass counts
 * every source face whose box meets any PATCH TRIANGLE's box, and every one of
 * them must lie in the region the product built from the loop's box.
 *
 * The STL is read as the product reads it: triangle soup, three records per
 * face, no welding, exact Float32 coordinates.
 */

const MIB = 1024 * 1024;

function readBinaryStl(bytes: Uint8Array): CanonicalMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (84 + count * 50 !== bytes.byteLength) throw new Error('not a binary STL of declared length');
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

function analyse(mesh: CanonicalMesh, revision: number): TopologyReport {
  return analyseTopology(mesh, {
    documentId: 'real',
    partId: 'part-1',
    documentRevision: revision,
    cancellation: uncancellable,
  }).report;
}

interface PassResult {
  readonly lines: string[];
  readonly filled: readonly AdmittedLoop[];
  readonly candidate: CanonicalMesh;
  readonly after: TopologyReport;
}

function pass(
  label: string,
  mesh: CanonicalMesh,
  before: TopologyReport,
  module: Awaited<ReturnType<typeof createSelfIntersectionKernel>>,
): PassResult {
  const lines: string[] = [`--- ${label}`];
  const limits = DEFAULT_BOUNDARY_FILL_LIMITS;
  let t = performance.now();
  const scan = scanBoundaries(mesh, {
    limits: { maxBoundaryEdges: limits.maxBoundaryEdges, maxLoopVertices: limits.maxLoopVertices },
  });
  const scanMs = performance.now() - t;
  const rimPoints = scan.loops.reduce((sum, loop) => sum + loop.vertexCount, 0);
  lines.push(
    `scan ${scanMs.toFixed(0)} ms, status ${scan.status}, table ${(scan.tableBytes / MIB).toFixed(1)} MiB`,
    `boundary edges ${String(scan.boundaryEdgeCount)} / cap ${String(limits.maxBoundaryEdges)}; components ${String(scan.loops.length)} (simple ${String(scan.simpleLoopCount)}, complex ${String(scan.complexBoundaryCount)}); boundary points ${String(rimPoints)}`,
  );

  t = performance.now();
  const admission = admitBoundaryLoops(mesh, scan);
  lines.push(`admission ${(performance.now() - t).toFixed(1)} ms`);
  const scanned = new Map(scan.loops.map((loop) => [loop.id, loop]));
  for (const decision of admission.decisions) {
    const refusal = scanned.get(decision.id)?.refusal;
    lines.push(
      `  opening ${decision.id} points ${String(decision.vertexCount)} edges ${String(scanned.get(decision.id)?.edgeCount ?? 0)} -> ${decision.verdict}${refusal === undefined ? '' : ` (scan: ${refusal})`}`,
    );
  }
  const admittedRim = admission.admitted.reduce((sum, loop) => sum + loop.vertexCount, 0);
  lines.push(
    `admitted ${String(admission.admitted.length)} / cap ${String(limits.maxLoopsPerCandidate)} openings; rim points ${String(admittedRim)} / cap ${String(limits.maxTotalBoundaryVertices)}`,
  );

  // Per-opening region, verdict and completeness evidence.
  const narrowphase = createKernelNarrowphase(module);
  const faceCount = mesh.indices.length / 3;
  for (const loop of admission.admitted) {
    const one = buildLocalPatchProblem(mesh, [loop], { maxFaces: limits.maxLocalFaces });
    const [verdict] = classifyLocalPatches(one, narrowphase);
    // Brute force: source faces whose box meets any patch triangle's box.
    const regionBox = (face: number): number[] => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 3; c += 1) {
        const v = mesh.indices[face * 3 + c] ?? 0;
        for (let a = 0; a < 3; a += 1) {
          const x = mesh.positions[v * 3 + a] ?? Number.NaN;
          lo[a] = Math.min(lo[a] ?? Infinity, x);
          hi[a] = Math.max(hi[a] ?? -Infinity, x);
        }
      }
      return [...lo, ...hi];
    };
    const patchBoxes: number[][] = [];
    for (let p = 0; p < loop.patch.length; p += 3) {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 3; c += 1) {
        const v = loop.patch[p + c] ?? 0;
        for (let a = 0; a < 3; a += 1) {
          const x = mesh.positions[v * 3 + a] ?? Number.NaN;
          lo[a] = Math.min(lo[a] ?? Infinity, x);
          hi[a] = Math.max(hi[a] ?? -Infinity, x);
        }
      }
      patchBoxes.push([...lo, ...hi]);
    }
    let touchingPatch = 0;
    let insideLoopBox = 0;
    let touchingButOutside = 0;
    for (let face = 0; face < faceCount; face += 1) {
      const box = regionBox(face);
      const meets = (other: readonly number[]): boolean =>
        [0, 1, 2].every(
          (a) => (box[a] ?? 0) <= (other[a + 3] ?? 0) && (other[a] ?? 0) <= (box[a + 3] ?? 0),
        );
      const inLoop = meets([...loop.min, ...loop.max]);
      if (inLoop) insideLoopBox += 1;
      if (patchBoxes.some(meets)) {
        touchingPatch += 1;
        if (!inLoop) touchingButOutside += 1;
      }
    }
    const fmt = (v: readonly number[]): string => v.map((x) => x.toPrecision(7)).join(', ');
    lines.push(
      `  admitted ${loop.id}: box [${fmt(loop.min)}] – [${fmt(loop.max)}]; patch ${String(loop.patchFaceCount)} faces, area ${loop.patchArea.toPrecision(9)}`,
      `    region ${String(one.sourceFaceCount)} faces (brute-force box-meets-loop-box ${String(insideLoopBox)}; faces meeting a patch triangle's box ${String(touchingPatch)}, of which OUTSIDE the region ${String(touchingButOutside)}); excluded ${String(one.excluded.length)}`,
      `    narrowphase complete=${String(verdict?.complete)} budgetExceeded=${String(verdict?.budgetExceeded)} pairs=${String(verdict?.testedPairs)} invalid patch×source=${String(verdict?.invalidPatchSourcePairs)} patch×patch=${String(verdict?.invalidPatchPatchPairs)}`,
    );
  }

  // The combined problem, as the worker builds it.
  t = performance.now();
  const problem = buildLocalPatchProblem(mesh, admission.admitted, {
    maxFaces: limits.maxLocalFaces,
  });
  const verdicts = classifyLocalPatches(problem, narrowphase);
  const filled: AdmittedLoop[] = [];
  for (const [index, id] of problem.loopIds.entries()) {
    const verdict = verdicts[index];
    const loop = admission.admitted.find((candidate) => candidate.id === id);
    if (
      verdict !== undefined &&
      loop !== undefined &&
      verdict.complete &&
      verdict.invalidPatchSourcePairs === 0 &&
      verdict.invalidPatchPatchPairs === 0
    ) {
      filled.push(loop);
    }
  }
  const verifyMs = performance.now() - t;
  const candidate = appendPatches(mesh, filled);
  t = performance.now();
  const after = analyse(candidate, 2);
  const reanalysisMs = performance.now() - t;
  const regressions = judgeFilledCandidate(before, after, filled);

  const rim = filled.reduce((sum, loop) => sum + loop.vertexCount, 0);
  const patchFaces = filled.reduce((sum, loop) => sum + loop.patchFaceCount, 0);
  const patchArea = filled.reduce((sum, loop) => sum + loop.patchArea, 0);
  const components = (r: TopologyReport): number =>
    r.simpleBoundaryLoopCount + r.openBoundaryChainCount + r.branchedBoundaryCount;
  const row = (name: string, b: number, predicted: string, a: number): string =>
    `    ${name.padEnd(26)} before ${String(b).padStart(9)}  predicted ${predicted.padStart(12)}  after ${String(a).padStart(9)}`;
  lines.push(
    `region+verify ${verifyMs.toFixed(0)} ms (${String(problem.sourceFaceCount)} region faces); re-analysis ${reanalysisMs.toFixed(0)} ms`,
    `filled ${String(filled.length)}; patch faces ${String(patchFaces)}; rim edges ${String(rim)}`,
    row('faces', before.sourceFaceCount, `+${String(patchFaces)}`, after.sourceFaceCount),
    row('boundary edges', before.boundaryEdgeCount, `-${String(rim)}`, after.boundaryEdgeCount),
    row('boundary components', components(before), `-${String(filled.length)}`, components(after)),
    row('  simple loops', before.simpleBoundaryLoopCount, 'n/a', after.simpleBoundaryLoopCount),
    row('  branched', before.branchedBoundaryCount, 'unchanged', after.branchedBoundaryCount),
    row('  open chains', before.openBoundaryChainCount, 'unchanged', after.openBoundaryChainCount),
    row('non-manifold edges', before.nonManifoldEdgeCount, 'unchanged', after.nonManifoldEdgeCount),
    row(
      'non-manifold vertices',
      before.nonManifoldVertexCount,
      '<= before',
      after.nonManifoldVertexCount,
    ),
    row(
      'winding conflicts',
      before.windingConflictEdgeCount,
      'unchanged',
      after.windingConflictEdgeCount,
    ),
    row('components', before.componentCount, 'unchanged', after.componentCount),
    row(
      'topological vertices',
      before.topologicalVertexCount,
      'unchanged',
      after.topologicalVertexCount,
    ),
    row(
      'same-orient duplicates',
      before.sameOrientationDuplicateCount,
      'unchanged',
      after.sameOrientationDuplicateCount,
    ),
    row(
      'reversed duplicates',
      before.reversedOrientationDuplicateCount,
      'unchanged',
      after.reversedOrientationDuplicateCount,
    ),
    row(
      'repeated-position faces',
      before.repeatedPositionFaceCount,
      'unchanged',
      after.repeatedPositionFaceCount,
    ),
    row('zero-area faces', before.zeroAreaFaceCount, 'unchanged', after.zeroAreaFaceCount),
    `    surface area: source A=${before.totalSurfaceArea.toPrecision(12)} patch P=${patchArea.toPrecision(9)} A+P=${(before.totalSurfaceArea + patchArea).toPrecision(12)} candidate=${after.totalSurfaceArea.toPrecision(12)} relative error ${(Math.abs(after.totalSurfaceArea - before.totalSurfaceArea - patchArea) / Math.max(1, before.totalSurfaceArea + patchArea)).toExponential(2)}`,
    `    judgeFilledCandidate regressions: [${regressions.join(', ')}]`,
    `    sourcePreserved=${String(sourcePreserved(mesh, candidate))} positionsShared=${String(candidate.positions === mesh.positions)}`,
  );
  return { lines, filled, candidate, after };
}

/**
 * THE INDEPENDENT ORACLE: the qualified per-opening engine (ADR 0018), with the
 * same kernel, over a submesh of every face whose box meets the loop's box
 * inflated by 50× its own extent — a strict superset of the local region, and
 * small enough for that engine's 250,000-face ceiling.
 *
 * Then THE PAIRS THEMSELVES, so a refusal can be read rather than trusted:
 * every (patch triangle × region face) pair whose boxes meet is classified ON
 * ITS OWN by the kernel, and each invalid one is described by its geometry —
 * corners shared exactly, the region triangle's distance from the patch plane
 * relative to the patch's size, and the cosine between the two normals.
 */
function oracle(
  mesh: CanonicalMesh,
  loop: AdmittedLoop,
  module: Awaited<ReturnType<typeof createSelfIntersectionKernel>>,
): string[] {
  const extent = Math.max(...[0, 1, 2].map((a) => (loop.max[a] ?? 0) - (loop.min[a] ?? 0)));
  const pad = extent * 50;
  const faceCount = mesh.indices.length / 3;
  const kept: number[] = [];
  for (let face = 0; face < faceCount; face += 1) {
    let meets = true;
    for (let a = 0; a < 3 && meets; a += 1) {
      let fl = Infinity;
      let fh = -Infinity;
      for (let c = 0; c < 3; c += 1) {
        const x = mesh.positions[(mesh.indices[face * 3 + c] ?? 0) * 3 + a] ?? Number.NaN;
        fl = Math.min(fl, x);
        fh = Math.max(fh, x);
      }
      meets = fl <= (loop.max[a] ?? 0) + pad && (loop.min[a] ?? 0) - pad <= fh;
    }
    if (meets) kept.push(face);
  }
  const positions = createPositionArray(kept.length * 9);
  const indices = createIndexArray(kept.length * 3);
  kept.forEach((face, index) => {
    for (let c = 0; c < 3; c += 1) {
      const v = mesh.indices[face * 3 + c] ?? 0;
      for (let a = 0; a < 3; a += 1) {
        positions[index * 9 + c * 3 + a] = mesh.positions[v * 3 + a] ?? Number.NaN;
      }
      indices[index * 3 + c] = index * 3 + c;
    }
  });
  const sub: CanonicalMesh = { positions, indices, metadata: {} };

  const key = (source: ArrayLike<number>, corner: number): string =>
    `${String(source[corner * 3])},${String(source[corner * 3 + 1])},${String(source[corner * 3 + 2])}`;
  const rim = new Set<string>();
  for (const corner of loop.patch) rim.add(key(mesh.positions, corner));
  const set = extractBoundaryLoops(sub, { maxLoopVertices: 512 });
  const target = set.loops.find(
    (candidate) =>
      candidate.refusal === undefined &&
      candidate.vertexCount === rim.size &&
      [...candidate.vertices].every((vertex) =>
        rim.has(key(positions, set.vertexRepresentativeCorner[vertex] ?? 0)),
      ),
  );
  if (target === undefined) {
    return [
      `    ORACLE: rim not found as a simple loop in the ${String(kept.length)}-face submesh`,
    ];
  }
  const result = runHoleFill({
    source: sub,
    request: {
      operationId: 'o',
      documentId: 'd',
      revision: 1,
      partId: 'p',
      boundaryLoopId: target.id,
    },
    narrowphase: createKernelNarrowphase(module),
  });
  const summary = result.outcome.summary;
  const lines = [
    `    ORACLE per-opening engine over ${String(kept.length)} faces: ${result.outcome.status}; invalid patch×source ${String(summary.invalidPatchSourcePairs)}, patch×patch ${String(summary.invalidPatchPatchPairs)}, unclassified ${String(summary.narrowphaseRefusals)}`,
  ];

  // The pairs, one at a time, over the product's own local problem.
  const problem = buildLocalPatchProblem(mesh, [loop], {
    maxFaces: DEFAULT_BOUNDARY_FILL_LIMITS.maxLocalFaces,
  });
  const narrowphase = createKernelNarrowphase(module);
  const p = problem.positions;
  const t = problem.triangles;
  const corner = (face: number, c: number): [number, number, number] => {
    const v = (t[face * 3 + c] ?? 0) * 3;
    return [p[v] ?? 0, p[v + 1] ?? 0, p[v + 2] ?? 0];
  };
  const box = (face: number): number[] => {
    const cs = [0, 1, 2].map((c) => corner(face, c));
    return [0, 1, 2]
      .map((a) => Math.min(...cs.map((q) => q[a] ?? 0)))
      .concat([0, 1, 2].map((a) => Math.max(...cs.map((q) => q[a] ?? 0))));
  };
  const normal = (face: number): [number, number, number] => {
    const [a, b, c] = [corner(face, 0), corner(face, 1), corner(face, 2)];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: [number, number, number] = [
      (u[1] ?? 0) * (w[2] ?? 0) - (u[2] ?? 0) * (w[1] ?? 0),
      (u[2] ?? 0) * (w[0] ?? 0) - (u[0] ?? 0) * (w[2] ?? 0),
      (u[0] ?? 0) * (w[1] ?? 0) - (u[1] ?? 0) * (w[0] ?? 0),
    ];
    const length = Math.hypot(...n);
    return [n[0] / length, n[1] / length, n[2] / length];
  };
  narrowphase.begin({
    positions: p,
    triangles: t,
    patchFaceStart: problem.sourceFaceCount,
    maxSamples: 0,
  });
  const total = t.length / 3;
  const pair = new Uint32Array(2);
  try {
    for (let patch = problem.sourceFaceCount; patch < total; patch += 1) {
      const pb = box(patch);
      const at = (values: readonly number[], index: number): number => values[index] ?? Number.NaN;
      const n = normal(patch);
      const origin = corner(patch, 0);
      const size = Math.max(at(pb, 3) - at(pb, 0), at(pb, 4) - at(pb, 1), at(pb, 5) - at(pb, 2));
      for (let face = 0; face < total; face += 1) {
        if (face === patch) continue;
        const fb = box(face);
        if (![0, 1, 2].every((a) => at(fb, a) <= at(pb, a + 3) && at(pb, a) <= at(fb, a + 3))) {
          continue;
        }
        pair[0] = patch;
        pair[1] = face;
        const verdict = narrowphase.classify(pair, 1);
        if (verdict.invalidPatchSourcePairs + verdict.invalidPatchPatchPairs === 0) continue;
        const shared = [0, 1, 2].filter((c) =>
          [0, 1, 2].some((d) => t[face * 3 + c] === t[patch * 3 + d]),
        ).length;
        const distance = Math.max(
          ...[0, 1, 2].map((c) => {
            const q = corner(face, c);
            return Math.abs(
              (q[0] - origin[0]) * n[0] + (q[1] - origin[1]) * n[1] + (q[2] - origin[2]) * n[2],
            );
          }),
        );
        const m = normal(face);
        const cosine = n[0] * m[0] + n[1] * m[1] + n[2] * m[2];
        lines.push(
          `      invalid pair: ${face < problem.sourceFaceCount ? 'patch×source' : 'patch×patch'} shared corners ${String(shared)}, off-plane ${(distance / size).toExponential(2)} of patch size, normal cosine ${cosine.toFixed(4)}`,
        );
      }
    }
  } finally {
    narrowphase.end();
  }
  return lines;
}

it('real-model boundary-fill evidence', { timeout: 3_600_000 }, async () => {
  const path = process.env.CADFIXER_REAL_MODEL;
  if (path === undefined || path === '') {
    process.stdout.write('Set CADFIXER_REAL_MODEL=/path/to/model.stl to run.\n');
    return;
  }
  const module = await createSelfIntersectionKernel({ wasmBinary: readFileSync(kernelWasmPath()) });
  const bytes = new Uint8Array(readFileSync(path));
  const mesh = readBinaryStl(bytes);
  const before = analyse(mesh, 1);
  const out: string[] = [
    `faces ${String(before.sourceFaceCount)}, stored vertices ${String(mesh.positions.length / 3)}, topological vertices ${String(before.topologicalVertexCount)}, components ${String(before.componentCount)}, boundary edges ${String(before.boundaryEdgeCount)}, simple loops ${String(before.simpleBoundaryLoopCount)}, branched ${String(before.branchedBoundaryCount)}, open chains ${String(before.openBoundaryChainCount)}, non-manifold edges ${String(before.nonManifoldEdgeCount)}, non-manifold vertices ${String(before.nonManifoldVertexCount)}`,
  ];

  const first = pass('pass 1 (the source)', mesh, before, module);
  out.push(...first.lines);
  // WASM-BUILD-01: compare the six actual candidate openings with frozen old bytes.
  const baselineDirectory = mkdtempSync(join(tmpdir(), 'pybrix-real-kernel-baseline-'));
  try {
    const show = (file: string): Buffer =>
      execFileSync(
        'git',
        [
          'show',
          `a466058be058b31ad348bc40b3e75be407aaaac6:packages/self-intersection-kernel/artifacts/${file}`,
        ],
        { maxBuffer: 64 * MIB },
      );
    const glue = join(baselineDirectory, 'self-intersection.js');
    writeFileSync(glue, show('self-intersection.js'));
    const oldFactory = (await import(pathToFileURL(glue).href)) as {
      default: typeof createSelfIntersectionKernel;
    };
    const started = performance.now();
    const oldModule = await oldFactory.default({ wasmBinary: show('self-intersection.wasm') });
    out.push(`old module startup ${(performance.now() - started).toFixed(1)} ms`);
    const previous = pass('previous qualified kernel', mesh, before, oldModule);
    expect(first.filled.map((loop) => loop.id)).toEqual(previous.filled.map((loop) => loop.id));
    expect(first.filled).toHaveLength(2);
    expect(first.candidate.indices).toEqual(previous.candidate.indices);
    expect({ ...first.after, analysisMilliseconds: 0 }).toEqual({
      ...previous.after,
      analysisMilliseconds: 0,
    });
    // Timing rows differ; all per-opening narrowphase counters/decisions must match.
    const decisions = (lines: string[]): string[] =>
      lines.filter((line) => /narrowphase complete=|opening .* ->|sourcePreserved=/.test(line));
    expect(decisions(first.lines)).toEqual(decisions(previous.lines));
    expect(sourcePreserved(mesh, first.candidate)).toBe(true);
    out.push(
      'old/new real-model kernel decisions and candidate geometry: IDENTICAL (2 accepted, 4 geometry refusals)',
    );
    out.push(...previous.lines);
  } finally {
    rmSync(baselineDirectory, { recursive: true, force: true });
  }

  out.push('--- independent oracle, every admitted opening of pass 1');
  const scan = scanBoundaries(mesh, {
    limits: {
      maxBoundaryEdges: DEFAULT_BOUNDARY_FILL_LIMITS.maxBoundaryEdges,
      maxLoopVertices: DEFAULT_BOUNDARY_FILL_LIMITS.maxLoopVertices,
    },
  });
  for (const loop of admitBoundaryLoops(mesh, scan).admitted) {
    out.push(
      `  ${loop.id} (${first.filled.includes(loop) || first.filled.some((f) => f.id === loop.id) ? 'FILLED by the product path' : 'REFUSED by the product path'})`,
    );
    out.push(...oracle(mesh, loop, module));
  }

  // Determinism: a second build from the same source is byte-identical.
  const again = pass('pass 1, repeated', mesh, before, module);
  const same =
    again.candidate.indices.length === first.candidate.indices.length &&
    again.candidate.indices.every((value, index) => value === first.candidate.indices[index]);
  out.push(`--- determinism: repeated candidate byte-identical = ${String(same)}`);

  // A second Repair model over the applied result: does anything new qualify?
  const second = pass('pass 2 (after applying pass 1)', first.candidate, first.after, module);
  out.push(...second.lines);

  process.stdout.write(
    `\nREPAIR-RC-03 real-model evidence (${path.split('/').pop() ?? ''})\n${out.join('\n')}\n`,
  );
});
