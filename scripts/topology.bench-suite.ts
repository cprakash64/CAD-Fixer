import { performance } from 'node:perf_hooks';
import { it } from 'vitest';
import { uncancellable } from '@cadfixer/shared';
import { createIndexArray, createPositionArray } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology, estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';

/**
 * Small topology benchmark — NOT part of CI.
 *
 * Deliberately limited to ~1 MiB and ~10 MiB. Its purpose is to catch
 * catastrophic design errors — accidental O(N²), an object-per-edge explosion,
 * an order-of-magnitude memory amplification — not to produce the definitive
 * numbers. The full 50/100 MiB suite belongs to Stage 2C-2.
 *
 * WHAT THE RATIO CAN AND CANNOT SHOW. Two data points cannot establish
 * asymptotic complexity, and this benchmark does not try to. Analysis has to
 * visit every corner and every face, so its runtime cannot be below Ω(N) no
 * matter what these numbers look like — a ratio under 10x across a 10x input is
 * an observation about constant factors, cache behaviour, and fixed startup
 * cost at these sizes, not evidence of sub-linear growth.
 *
 * What the ratio IS good for is catching a catastrophe: a ratio approaching 100x
 * across a 10x input is the signature of quadratic behaviour, and that is the
 * failure this benchmark exists to notice.
 *
 * The implemented complexity is O(N) expected for the hashing and radix stages,
 * plus O(F log F) for the one comparison sort in duplicate-face detection.
 *
 * Run with `npm run bench:topology`. Sizes: `CADFIXER_TOPO_MB=1,10`.
 */

const BINARY_FACET_BYTES = 50;

/**
 * A closed-ish triangulated grid whose corners genuinely coincide, so vertex
 * canonicalisation has real merging to do rather than the trivial all-distinct
 * case that would flatter the hash table.
 */
function gridMesh(targetBytes: number): CanonicalMesh {
  const faceCount = Math.max(2, Math.floor(targetBytes / BINARY_FACET_BYTES));
  const side = Math.max(2, Math.floor(Math.sqrt(faceCount / 2)));
  const quads = side * side;
  const faces = quads * 2;

  const positions = createPositionArray(faces * 9);
  const indices = createIndexArray(faces * 3);

  let write = 0;
  const push = (x: number, y: number, z: number): void => {
    positions[write] = x;
    positions[write + 1] = y;
    positions[write + 2] = z;
    write += 3;
  };

  // Height is a function of the GRID POSITION, not of the quad, so neighbouring
  // quads emit bit-identical coordinates for their shared corners. An earlier
  // version varied z per quad, which gave every quad its own vertices and one
  // component each — it benchmarked the hash table's insert path while
  // exercising almost none of its merging, the part that actually costs.
  const height = (x: number, y: number): number => ((x * 7 + y * 13) % 17) * 0.01;

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      push(col, row, height(col, row));
      push(col + 1, row, height(col + 1, row));
      push(col, row + 1, height(col, row + 1));

      push(col + 1, row, height(col + 1, row));
      push(col + 1, row + 1, height(col + 1, row + 1));
      push(col, row + 1, height(col, row + 1));
    }
  }
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;

  return {
    positions,
    indices,
    metadata: { sourceFormat: 'stl' },
  };
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function parseSizes(): number[] {
  const raw = process.env.CADFIXER_TOPO_MB;
  if (raw === undefined || raw.trim().length === 0) return [1, 10];
  return raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

it('measures topology analysis across small representative sizes', () => {
  process.stdout.write(
    `\nnode ${process.version} on ${process.platform}/${process.arch}\n` +
      `run at ${new Date().toISOString()}\n\n`,
  );

  const timings: { sizeMb: number; totalMs: number; faces: number }[] = [];

  for (const sizeMb of parseSizes()) {
    const mesh = gridMesh(Math.floor(sizeMb * 1024 * 1024));
    const faceCount = mesh.indices.length / 3;
    const cornerCount = mesh.positions.length / 3;

    const phaseMs = new Map<string, number>();
    let lastPhase = '';
    let lastAt = performance.now();

    const startedAt = performance.now();
    const result = analyseTopology(mesh, {
      documentId: 'bench',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
      onPhaseStart: (phase) => {
        const now = performance.now();
        if (lastPhase !== '') phaseMs.set(lastPhase, now - lastAt);
        lastPhase = phase;
        lastAt = now;
      },
    });
    const totalMs = performance.now() - startedAt;
    if (lastPhase !== '') phaseMs.set(lastPhase, performance.now() - lastAt);

    const estimated = estimateTopologyWorkspaceBytes(faceCount, cornerCount);
    const detailBytes =
      result.detail.boundaryEdges.byteLength +
      result.detail.nonManifoldEdges.byteLength +
      result.detail.windingConflictEdges.byteLength +
      result.detail.degenerateFaces.byteLength +
      result.detail.sampleVertexIds.byteLength +
      result.detail.sampleVertexPositions.byteLength;

    process.stdout.write(
      [
        `input ~${String(sizeMb)} MiB   faces ${faceCount.toLocaleString()}  corners ${cornerCount.toLocaleString()}`,
        ...[...phaseMs.entries()].map(
          ([phase, ms]) => `  ${phase.padEnd(26)} ${ms.toFixed(0).padStart(6)} ms`,
        ),
        `  ${'TOTAL'.padEnd(26)} ${totalMs.toFixed(0).padStart(6)} ms`,
        `  recovered vertices ${result.report.topologicalVertexCount.toLocaleString()}` +
          `  edges ${result.report.uniqueEdgeCount.toLocaleString()}` +
          `  components ${String(result.report.componentCount)}`,
        `  modelled scratch ${mib(estimated)}   detail output ${mib(detailBytes)}`,
        '',
      ].join('\n'),
    );

    timings.push({ sizeMb, totalMs, faces: faceCount });
  }

  // A regression tripwire, not a complexity measurement. See the note above.
  if (timings.length >= 2) {
    const first = timings[0];
    const last = timings[timings.length - 1];
    if (first !== undefined && last !== undefined && first.totalMs > 0) {
      const faceRatio = last.faces / first.faces;
      const timeRatio = last.totalMs / first.totalMs;
      process.stdout.write(
        `observed: faces x${faceRatio.toFixed(1)}  time x${timeRatio.toFixed(1)}\n` +
          'Two data points. Favourable at these sizes, but NOT evidence of\n' +
          'sub-linear complexity — the work is Omega(N) by construction.\n' +
          'Implemented: O(N) expected hashing/radix, O(F log F) duplicate sort.\n' +
          'A time ratio far ABOVE the face ratio would indicate a real problem.\n\n',
      );
    }
  }
});
