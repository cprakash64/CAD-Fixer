import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  IDENTITY_MATRIX4,
  triangleCount,
} from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { uncancellable } from '@cadfixer/shared';
import { analyseTopology } from '@cadfixer/mesh-topology';
import {
  executeConservativeRepair,
  fullCopyBytes,
  planConservativeRepair,
  RepairOperation,
} from '@cadfixer/mesh-repair';

/**
 * STAGE 3B-1A — conservative repair performance.
 *
 * NOT PART OF CI: timings are machine-dependent and there are no timing
 * assertions. What this exists to catch is a SHAPE change — anything
 * superlinear, or a memory profile that says an object appeared per face.
 *
 * The defect densities are chosen to bracket real files: a mostly-clean export,
 * a sloppy one, and a pathological one where a third of the faces go.
 */

const OUT = join(import.meta.dirname, '..', 'docs', 'repair');

/** Bytes a canonical mesh occupies: Float32 positions plus Uint32 indices. */
function meshBytes(mesh: CanonicalMesh): number {
  return mesh.positions.byteLength + mesh.indices.byteLength;
}

/**
 * A deterministic grid of triangles with a controlled defect mix.
 *
 * Faces are laid out so most are ordinary, and every Nth is replaced by a
 * duplicate or a degenerate. Nothing random: the same size produces the same
 * mesh on any machine.
 */
function generate(targetFaces: number, defectRate: number): CanonicalMesh {
  const positions: number[] = [];
  let emitted = 0;
  let index = 0;
  while (emitted < targetFaces) {
    const x = (index % 512) * 2;
    const y = Math.floor(index / 512) * 2;
    const push = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void => {
      positions.push(ax, ay, 0, bx, by, 0, cx, cy, 0);
      emitted += 1;
    };
    push(x, y, x + 1, y, x, y + 1);

    if (defectRate > 0 && index % Math.max(2, Math.round(1 / defectRate)) === 0) {
      // A same-orientation duplicate of the face just emitted.
      if (emitted < targetFaces) push(x, y, x + 1, y, x, y + 1);
      // A repeated-position degenerate, isolated from the grid.
      if (emitted < targetFaces) push(x + 0.5, y + 0.5, x + 0.5, y + 0.5, x + 0.6, y + 0.5);
    }
    index += 1;
  }

  const out = createPositionArray(positions.length);
  out.set(positions);
  const indices = createIndexArray(positions.length / 3);
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;
  return {
    positions: out,
    indices,
    metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
  };
}

interface Row {
  readonly targetMiB: number;
  readonly defectRate: number;
  readonly faces: number;
  readonly inputBytes: number;
  readonly analyseMs: number;
  readonly planMs: number;
  readonly executeMs: number;
  readonly totalMs: number;
  readonly removed: number;
  readonly flipped: number;
  readonly candidateBytes: number;
  readonly inverseBytes: number;
  readonly fullCopyBytes: number;
  readonly modelledPeakBytes: number;
  readonly acceptance: string;
}

it('measures conservative repair at realistic sizes', () => {
  const rows: Row[] = [];
  // 1 MiB is ~29k faces at 36 bytes each. 50 MiB is the largest size that runs
  // comfortably here; 100 MiB is modelled from the estimator rather than run,
  // because deliberately approaching an OOM would destroy the run's own output.
  const sizes: { mib: number; faces: number }[] = [
    { mib: 1, faces: 29_000 },
    { mib: 10, faces: 291_000 },
    { mib: 50, faces: 1_456_000 },
  ];

  for (const size of sizes) {
    for (const defectRate of [0, 0.05, 0.33]) {
      const mesh = generate(size.faces, defectRate);
      const faces = triangleCount(mesh);

      const t0 = performance.now();
      const report = analyseTopology(mesh, {
        modelId: 'bench',
        modelRevision: 1,
        cancellation: uncancellable,
      }).report;
      const t1 = performance.now();

      const { plan, view, prepared } = planConservativeRepair({
        mesh,
        report,
        modelId: 'bench',
        sourceRevision: 1,
        requested: [
          RepairOperation.RemoveDuplicateFaces,
          RepairOperation.RemoveRepeatedPositionFaces,
          RepairOperation.RemoveZeroAreaFaces,
          RepairOperation.UnifyWinding,
        ],
      });
      const t2 = performance.now();

      const result = executeConservativeRepair({
        source: mesh,
        plan,
        sourceReport: report,
        cancellation: uncancellable,
        modelId: 'bench',
        revision: 1,
        view,
        prepared,
      });
      const t3 = performance.now();

      rows.push({
        targetMiB: size.mib,
        defectRate,
        faces,
        inputBytes: meshBytes(mesh),
        analyseMs: t1 - t0,
        planMs: t2 - t1,
        executeMs: t3 - t2,
        totalMs: t3 - t0,
        removed:
          result.counts.removedDuplicateFaces +
          result.counts.removedRepeatedPositionFaces +
          result.counts.removedZeroAreaFaces,
        flipped: result.counts.flippedFaces,
        candidateBytes: result.candidate === undefined ? 0 : meshBytes(result.candidate),
        inverseBytes: result.inverse?.byteLength ?? 0,
        fullCopyBytes: fullCopyBytes(mesh),
        modelledPeakBytes: plan.memory.peakBytes,
        acceptance: result.validation.acceptance,
      });
    }
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, 'repair-performance.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        environment: `node ${process.version} ${process.platform}/${process.arch}`,
        note: 'No timing assertions. Numbers are machine-dependent; the point is the SHAPE — anything superlinear, or an inverse patch that approaches a full copy at low defect density, is a regression.',
        rows,
      },
      null,
      2,
    ),
  );

  process.stdout.write('\nconservative repair performance\n');
  for (const row of rows) {
    process.stdout.write(
      `  ${String(row.targetMiB).padStart(2)} MiB  defects ${(row.defectRate * 100).toFixed(0).padStart(2)}%  ` +
        `faces ${String(row.faces).padStart(9)}  analyse ${row.analyseMs.toFixed(0).padStart(5)}ms  ` +
        `plan ${row.planMs.toFixed(0).padStart(5)}ms  exec ${row.executeMs.toFixed(0).padStart(5)}ms  ` +
        `removed ${String(row.removed).padStart(7)}  inverse ${(row.inverseBytes / 1048576).toFixed(1)} MiB  ` +
        `vs copy ${(row.fullCopyBytes / 1048576).toFixed(1)} MiB  ${row.acceptance}\n`,
    );
  }
}, 1_800_000);
