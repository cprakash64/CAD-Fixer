import { it } from 'vitest';
import { extractBoundaryLoops, estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';

/**
 * STAGE 6D-R3 — WHAT THE AUTOMATIC BOUNDARY-LOOP LISTING COSTS, BY SHAPE.
 *
 * NOT part of CI. Run with `npm run bench:boundary-listing`.
 *
 * WHY IT EXISTS. `holefill/list-loops` runs AUTOMATICALLY after every import,
 * on the active part, and until Stage 6D-R3 it ran at ANY size with no resource
 * preflight of any kind — the only automatic post-import operation without one.
 * Its cost is not driven by triangle count: `extractBoundaryLoops` keeps a map
 * entry, a member list and a summary object carrying an identity STRING for
 * every boundary COMPONENT, and a mesh of loose triangles has one component per
 * FACE.
 *
 * That is what made two 100 MiB binary STL files with identical triangle counts
 * measure 1,055 MiB and 2,650 MiB of Chromium renderer footprint. This suite is
 * the Node-side attribution for that difference, and the evidence behind capping
 * the walk at `HOLE_FILL_MAX_PART_FACES` — the ceiling above which no opening
 * could be filled anyway.
 *
 * METRIC: `heapUsed + arrayBuffers`. Typed arrays live outside the JS heap, so
 * heap alone would miss the walk's own buffers entirely; the per-component
 * bookkeeping is the opposite case and lives entirely inside it. Only the sum
 * sees both.
 */

const MIB = 1024 * 1024;

function held(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/** T1 — every triangle isolated, so every FACE is its own boundary component. */
function soup(triangles: number): CanonicalMesh {
  const positions = createPositionArray(triangles * 9);
  const indices = createIndexArray(triangles * 3);
  for (let t = 0; t < triangles; t += 1) {
    const x = (t % 512) * 0.5;
    const y = Math.floor(t / 512) * 0.5;
    const p = t * 9;
    positions[p] = x;
    positions[p + 1] = y;
    positions[p + 3] = x + 0.4;
    positions[p + 4] = y;
    positions[p + 6] = x;
    positions[p + 7] = y + 0.4;
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
  }
  return { positions, indices, metadata: {} };
}

/** T2 — a welded grid: ONE boundary component, whatever the triangle count. */
function welded(triangles: number): CanonicalMesh {
  const cells = Math.max(1, Math.floor(triangles / 2));
  const cols = Math.max(2, Math.ceil(Math.sqrt(cells)));
  const rows = Math.max(1, Math.ceil(cells / cols));
  const positions = createPositionArray((cols + 1) * (rows + 1) * 3);
  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      const v = (row * (cols + 1) + col) * 3;
      positions[v] = col * 0.5;
      positions[v + 1] = row * 0.5;
    }
  }
  const indices = createIndexArray(rows * cols * 6);
  const id = (row: number, col: number): number => row * (cols + 1) + col;
  let at = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      indices[at] = id(row, col);
      indices[at + 1] = id(row, col + 1);
      indices[at + 2] = id(row + 1, col);
      indices[at + 3] = id(row, col + 1);
      indices[at + 4] = id(row + 1, col + 1);
      indices[at + 5] = id(row + 1, col);
      at += 6;
    }
  }
  return { positions, indices, metadata: {} };
}

it('measures the automatic boundary listing against the topology analysis', () => {
  const lines: string[] = [];
  lines.push(
    `\nStage 6D-R3 boundary-listing cost — node ${process.version} ${process.platform}/${process.arch}`,
    'metric: heapUsed + arrayBuffers, retained across the call\n',
  );

  for (const [shape, build] of [
    ['T1 loose triangles', soup],
    ['T2 welded grid', welded],
  ] as const) {
    for (const requested of [200_000, 500_000, 1_000_000]) {
      const mesh = build(requested);
      const faces = Math.floor(mesh.indices.length / 3);
      const corners = Math.floor(mesh.positions.length / 3);

      const before = held();
      const set = extractBoundaryLoops(mesh, { maxLoopVertices: 512 });
      /*
       * CLAMPED AT ZERO, AND THE REASON IS NOT COSMETIC. A collection can run
       * DURING the walk and reclaim the fixture builder's garbage, which makes
       * the delta negative — a number that would read as "the listing freed
       * memory". Zero means "nothing this measurement could see survived the
       * call", which is the truthful reading of that case and is exactly what
       * the welded shape produces at every size.
       */
      const cost = Math.max(0, held() - before);
      const loops = set.loops.length;

      lines.push(
        `${shape.padEnd(20)} F=${faces.toLocaleString('en-US').padStart(10)}  ` +
          `components ${loops.toLocaleString('en-US').padStart(10)}  ` +
          `listing ${(cost / MIB).toFixed(1).padStart(7)} MiB ` +
          `(${(cost / faces).toFixed(0).padStart(5)} B/face)  ` +
          `analysis model ${(estimateTopologyWorkspaceBytes(faces, corners) / MIB).toFixed(1)} MiB`,
      );
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
});
