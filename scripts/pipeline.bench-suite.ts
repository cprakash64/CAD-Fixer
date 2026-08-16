import { performance } from 'node:perf_hooks';
import { it } from 'vitest';
import { uncancellable } from '@cadfixer/shared';
import {
  computeBounds,
  computeVertexNormals,
  triangleCount,
  validateMeshStructure,
} from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  DEFAULT_IMPORT_BUDGET,
  MeshFormatId,
  readStl,
  registerBuiltInFormats,
  requireWriter,
} from '@cadfixer/file-formats';
import {
  analyseTopology,
  estimateDetailBytes,
  estimateTopologyWorkspaceBytes,
} from '@cadfixer/mesh-topology';
import {
  DEFAULT_SESSION_MEMORY_BUDGET,
  renderBytesFor,
  requestAnalysisWorkspace,
  residentBytesFor,
} from '@cadfixer/geometry-runtime';

/**
 * The whole local pipeline, measured at realistic sizes. NOT part of CI.
 *
 * Runs the same stages the worker runs, in the same order: parse the file,
 * validate it, build the render snapshot, analyse topology, encode an export.
 * Everything is measured in one process so the numbers relate to each other —
 * a topology figure with no parse figure beside it says little about what a
 * user waits for.
 *
 * WHAT THIS IS NOT. It is a Node measurement, not a browser one, and it does not
 * claim process memory. Node's heap accounting would not tell the truth about a
 * browser tab, and neither would a number scraped from `process.memoryUsage()`
 * with typed arrays living outside the JS heap. Memory here is MODELLED from
 * actual typed-array byte lengths and compared against the estimator, which is
 * a claim that can be checked. The browser numbers live in the Playwright
 * benchmark.
 *
 * Run with `npm run bench:pipeline`. Sizes: `CADFIXER_PIPELINE_MB=1,10,50,100`.
 * Sizes are attempted SEQUENTIALLY and a size that exceeds the configured budget
 * is reported as a rejection rather than being forced through.
 */

const BINARY_PREFIX_BYTES = 84;
const BINARY_FACET_BYTES = 50;

/**
 * A binary STL of roughly `targetBytes`, whose corners genuinely coincide.
 *
 * Height is a function of grid position, so neighbouring quads emit
 * bit-identical coordinates for shared corners and vertex canonicalisation has
 * real merging to do.
 */
function buildStl(targetBytes: number): { bytes: Uint8Array; triangles: number } {
  const facets = Math.max(2, Math.floor((targetBytes - BINARY_PREFIX_BYTES) / BINARY_FACET_BYTES));
  const side = Math.max(2, Math.floor(Math.sqrt(facets / 2)));
  const triangles = side * side * 2;

  const bytes = new Uint8Array(BINARY_PREFIX_BYTES + triangles * BINARY_FACET_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles, true);

  const height = (x: number, y: number): number => ((x * 7 + y * 13) % 17) * 0.01;
  let facet = 0;
  const writeTriangle = (points: readonly (readonly [number, number, number])[]): void => {
    const offset = BINARY_PREFIX_BYTES + facet * BINARY_FACET_BYTES;
    points.forEach((point, corner) => {
      const base = offset + 12 + corner * 12;
      view.setFloat32(base, point[0], true);
      view.setFloat32(base + 4, point[1], true);
      view.setFloat32(base + 8, point[2], true);
    });
    facet += 1;
  };

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const p00: readonly [number, number, number] = [col, row, height(col, row)];
      const p10: readonly [number, number, number] = [col + 1, row, height(col + 1, row)];
      const p01: readonly [number, number, number] = [col, row + 1, height(col, row + 1)];
      const p11: readonly [number, number, number] = [col + 1, row + 1, height(col + 1, row + 1)];
      writeTriangle([p00, p10, p01]);
      writeTriangle([p10, p11, p01]);
    }
  }

  return { bytes, triangles };
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function ms(value: number): string {
  return `${value.toFixed(0).padStart(6)} ms`;
}

function parseSizes(): number[] {
  const raw = process.env.CADFIXER_PIPELINE_MB;
  if (raw === undefined || raw.trim().length === 0) return [1, 10, 50, 100];
  return raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

/** Codecs need a macrotask yield; in Node a resolved promise is enough here. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

it('measures the whole local pipeline across representative sizes', async () => {
  registerBuiltInFormats();

  process.stdout.write(
    `\nnode ${process.version} on ${process.platform}/${process.arch}\n` +
      `run at ${new Date().toISOString()}\n\n`,
  );

  for (const sizeMb of parseSizes()) {
    const targetBytes = Math.floor(sizeMb * 1024 * 1024);
    const built = buildStl(targetBytes);

    process.stdout.write(
      `=== input ~${String(sizeMb)} MiB (${mib(built.bytes.byteLength)} actual, ` +
        `${built.triangles.toLocaleString()} triangles) ===\n`,
    );

    // --- parse ---------------------------------------------------------
    const parseStart = performance.now();
    const read = await readStl(built.bytes, {
      budget: DEFAULT_IMPORT_BUDGET,
      cancellation: uncancellable,
      yieldToEventLoop,
      progress: { report: () => undefined },
    });
    const parseMs = performance.now() - parseStart;
    const mesh: CanonicalMesh = read.mesh;

    const faceCount = triangleCount(mesh);
    const cornerCount = Math.floor(mesh.positions.length / 3);

    // --- validate ------------------------------------------------------
    const validateStart = performance.now();
    validateMeshStructure(mesh);
    const validateMs = performance.now() - validateStart;

    // --- render snapshot ----------------------------------------------
    const snapshotStart = performance.now();
    const bounds = computeBounds(mesh);
    const normals = computeVertexNormals(mesh);
    const renderPositions = new Float32Array(mesh.positions);
    const snapshotMs = performance.now() - snapshotStart;

    // --- memory preflight ---------------------------------------------
    const workspaceBytes = estimateTopologyWorkspaceBytes(faceCount, cornerCount);
    const refusal = requestAnalysisWorkspace('model/analyze', workspaceBytes, {
      faceCount,
      cornerCount,
    });

    if (refusal !== undefined) {
      // A refusal is a RESULT, not a failure. Local-only processing means the
      // machine's limits are a product behaviour, and reporting the refusal is
      // more useful than forcing the allocation through.
      process.stdout.write(
        `  parse                    ${ms(parseMs)}\n` +
          `  REJECTED by analysis budget\n` +
          `    modelled workspace     ${mib(workspaceBytes)}\n` +
          `    configured ceiling     ${mib(DEFAULT_SESSION_MEMORY_BUDGET.maxAnalysisWorkspaceBytes)}\n` +
          `  the model stays resident and exportable; only analysis is refused\n\n`,
      );
      continue;
    }

    // --- topology ------------------------------------------------------
    const phaseMs = new Map<string, number>();
    let lastPhase = '';
    let lastAt = performance.now();
    const analysisStart = performance.now();
    const result = analyseTopology(mesh, {
      modelId: 'bench',
      modelRevision: 1,
      cancellation: uncancellable,
      onPhaseStart: (phase) => {
        const now = performance.now();
        if (lastPhase !== '') phaseMs.set(lastPhase, now - lastAt);
        lastPhase = phase;
        lastAt = now;
      },
    });
    const analysisMs = performance.now() - analysisStart;
    if (lastPhase !== '') phaseMs.set(lastPhase, performance.now() - lastAt);

    // --- export --------------------------------------------------------
    const exportStart = performance.now();
    const written = await requireWriter(MeshFormatId.Stl).write(mesh, {
      encoding: 'binary',
      budget: DEFAULT_IMPORT_BUDGET,
      cancellation: uncancellable,
      yieldToEventLoop,
      progress: { report: () => undefined },
    });
    const exportMs = performance.now() - exportStart;

    // --- modelled memory ----------------------------------------------
    const residentBytes = mesh.positions.byteLength + mesh.indices.byteLength;
    const renderBytes = renderPositions.byteLength + normals.byteLength;
    const detailBytes =
      result.detail.boundaryEdges.byteLength +
      result.detail.nonManifoldEdges.byteLength +
      result.detail.windingConflictEdges.byteLength +
      result.detail.degenerateFaces.byteLength +
      result.detail.sampleVertexIds.byteLength +
      result.detail.sampleVertexPositions.byteLength;
    // Peak the APPLICATION holds: the worker's resident mesh, the main thread's
    // render snapshot, and the topology scratch that exists only during
    // analysis.
    const modelledPeak = residentBytes + renderBytes + workspaceBytes + detailBytes;

    process.stdout.write(
      [
        `  corners ${cornerCount.toLocaleString()}  recovered vertices ` +
          `${result.report.topologicalVertexCount.toLocaleString()}  edges ` +
          `${result.report.uniqueEdgeCount.toLocaleString()}  components ` +
          result.report.componentCount.toLocaleString(),
        '',
        `  parse                    ${ms(parseMs)}`,
        `  structural validation    ${ms(validateMs)}`,
        `  render snapshot          ${ms(snapshotMs)}`,
        ...[...phaseMs.entries()].map(([phase, value]) => `    ${phase.padEnd(24)}${ms(value)}`),
        `  topology TOTAL           ${ms(analysisMs)}`,
        `  binary export            ${ms(exportMs)}`,
        '',
        `  resident canonical       ${mib(residentBytes)}   (estimator ${mib(residentBytesFor(faceCount))})`,
        `  render snapshot          ${mib(renderBytes)}   (estimator ${mib(renderBytesFor(faceCount))})`,
        `  topology scratch (est.)  ${mib(workspaceBytes)}`,
        `  bounded detail           ${mib(detailBytes)}   (ceiling ${mib(estimateDetailBytes(result.detail.sampleLimit))})`,
        `  modelled application peak ${mib(modelledPeak)}`,
        `  export bytes             ${mib(written.bytes.byteLength)}`,
        `  bounds radius            ${bounds === undefined ? 'n/a' : bounds.radius.toFixed(3)}`,
        '',
      ].join('\n'),
    );
  }
});
