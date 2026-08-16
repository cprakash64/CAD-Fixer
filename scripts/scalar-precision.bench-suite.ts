import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';

/**
 * STAGE 3A-3A — CANDIDATE SCALAR PRECISION (§G, §H).
 *
 * WHY THIS CANNOT USE THE CORPUS. CAD Fixer's canonical store is
 * `PositionArray = Float32Array` (mesh-core/src/mesh.ts:27), so every corpus
 * fixture is ALREADY float32 by the time any candidate sees it. Feeding a
 * candidate float32-rounded coordinates and then asking whether it rounds to
 * float32 is a question that cannot return "yes" — the damage has been done
 * upstream of the measurement.
 *
 * That is not hypothetical: it is why R26 and R27 report float64-level round
 * trip error for a candidate this file proves is float32. It also makes the
 * Stage 3A-1/3A-2 assumption that R26 and R27 are strong precision probes
 * WRONG for this particular question, and R26 is doubly blind — its
 * coordinates are integers below 2^24, which binary32 represents exactly, so
 * it cannot detect narrowing at any storage precision.
 *
 * SO THIS PROBE BYPASSES THE CORPUS DELIBERATELY, feeding coordinates straight
 * into the transfer buffers (which are genuinely Float64Array) that binary32
 * cannot represent. The prediction is exact and stated in advance: if a
 * candidate narrows, the round-trip delta equals `|v - Math.fround(v)|`; if it
 * does not, the delta is 0.
 *
 * This does not change the frozen exam. It adds a measurement the exam was
 * never able to make.
 *
 * NOT PART OF CI.
 */

const OUT_DIR = join(import.meta.dirname, '..', 'docs', 'repair', 'bakeoff');
const KERNELS = join(import.meta.dirname, '..', 'experiments', 'repair-kernels');
const HARNESS_VERSION = 'stage-3a-3a.1';

const ARTIFACTS: Readonly<Record<string, string>> = {
  manifold: join(KERNELS, 'manifold', 'artifacts', 'manifold-candidate.wasm'),
  geogram: join(KERNELS, 'geogram', 'artifacts', 'geogram-candidate.wasm'),
  pmp: join(KERNELS, 'pmp', 'artifacts', 'pmp-candidate.wasm'),
};

/**
 * Narrows an `unknown` JSON field to a string.
 *
 * `String(value)` on an unknown would render an object as "[object Object]" and
 * quietly put that in a results file, which is exactly the kind of plausible-
 * looking wrong value this stage exists to eliminate. Non-strings become the
 * fallback rather than a fabricated rendering.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function sha256Of(path: string): string {
  if (!existsSync(path)) return 'missing';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * A closed tetrahedron whose corners binary32 cannot represent.
 *
 * Closed and manifold so that Manifold accepts it — a bare triangle is refused
 * by its precondition, and a refusal would tell us nothing about precision.
 */
function inexactTetrahedron(offset: number): { positions: number[]; triangles: number[] } {
  const a = [offset + 0.1, offset + 0.2, offset + 0.30000000000000004];
  const b = [offset + 1.7000000000000002, offset + 0.2, offset + 0.30000000000000004];
  const c = [offset + 0.1, offset + 1.3000000000000003, offset + 0.30000000000000004];
  const d = [offset + 0.1, offset + 0.2, offset + 1.9000000000000004];
  return {
    positions: [...a, ...b, ...c, ...d],
    // Wound outward, matching the corpus tetrahedron's convention.
    triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
  };
}

it('measures whether each candidate narrows float64 coordinates to float32', () => {
  const scratch = join(tmpdir(), `cf-precision-${String(process.pid)}`);
  mkdirSync(scratch, { recursive: true });

  const runners: Readonly<Record<string, { script: string; operation: string }>> = {
    manifold: { script: 'run-manifold-single.mjs', operation: 'ingest' },
    geogram: { script: 'run-geogram-single.mjs', operation: 'repairTopology' },
    pmp: { script: 'run-idempotence.mjs', operation: 'ingest' },
  };

  const rows: Record<string, unknown>[] = [];
  let sequence = 0;

  for (const [candidateId, runner] of Object.entries(runners)) {
    for (const offset of [0, 1e6]) {
      const input = inexactTetrahedron(offset);
      // Stated BEFORE the measurement, so the result cannot be rationalised
      // after the fact.
      const float32Prediction = Math.max(
        ...input.positions.map((value) => Math.abs(value - Math.fround(value))),
      );

      sequence += 1;
      const requestPath = join(scratch, `req-${String(sequence)}.json`);
      const resultPath = join(scratch, `res-${String(sequence)}.json`);

      const request =
        candidateId === 'manifold'
          ? {
              kind: 'run',
              operation: 'ingest',
              positions: input.positions,
              triangles: input.triangles,
            }
          : candidateId === 'geogram'
            ? {
                operation: 'repairTopology',
                parameter: 0,
                initMode: 1,
                positions: input.positions,
                triangles: input.triangles,
              }
            : {
                candidateId: 'pmp',
                operation: 'ingest',
                parameter: 0,
                positions: input.positions,
                triangles: input.triangles,
              };
      writeFileSync(requestPath, JSON.stringify(request));

      try {
        execFileSync(
          process.execPath,
          [join(KERNELS, 'scripts', runner.script), requestPath, resultPath],
          {
            timeout: 30_000,
            stdio: ['ignore', 'ignore', 'ignore'],
          },
        );
      } catch {
        // Absence of a result file is the record.
      }

      let observed: number | null = null;
      let status: number | null = null;
      let outcome = 'TIMEOUT_OR_KILLED';
      if (existsSync(resultPath)) {
        const payload = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
        outcome = text(payload.outcome, 'UNKNOWN');
        const body = (payload.first as Record<string, unknown> | undefined) ?? payload;
        status = typeof body.status === 'number' ? body.status : null;
        const out = body.positions ?? body.outPositions;
        if (Array.isArray(out) && out.length >= input.positions.length) {
          /*
           * ORDER-INDEPENDENT, because a candidate may renumber vertices.
           * Manifold does exactly that, and an index-wise comparison scored it
           * as losing 1.6 units of precision when it had lost none — it had
           * simply emitted the same four corners in a different order.
           *
           * For each INPUT vertex, take the distance to the nearest OUTPUT
           * vertex. These probes have four vertices, so the quadratic scan is
           * free; it is not a general-purpose matcher and is not used as one.
           */
          observed = 0;
          for (let i = 0; i < input.positions.length; i += 3) {
            let best = Number.POSITIVE_INFINITY;
            for (let j = 0; j + 2 < out.length; j += 3) {
              const dx = (input.positions[i] ?? 0) - Number(out[j]);
              const dy = (input.positions[i + 1] ?? 0) - Number(out[j + 1]);
              const dz = (input.positions[i + 2] ?? 0) - Number(out[j + 2]);
              best = Math.min(best, Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)));
            }
            observed = Math.max(observed, best);
          }
        }
      }

      // Classified only when the candidate actually returned geometry. A
      // refusal is recorded as a refusal, never as "preserves float64".
      let verdict = 'NO_OUTPUT';
      if (observed !== null) {
        if (observed === 0) verdict = 'PRESERVES_FLOAT64';
        else if (Math.abs(observed - float32Prediction) <= float32Prediction * 1e-6)
          verdict = 'NARROWS_TO_FLOAT32';
        else verdict = 'OTHER_PRECISION_LOSS';
      }

      rows.push({
        candidateId,
        artifactSha256: sha256Of(ARTIFACTS[candidateId] ?? ''),
        harnessVersion: HARNESS_VERSION,
        operation: runner.operation,
        coordinateOffset: offset,
        outcome,
        kernelStatus: status,
        float32Prediction,
        observedMaxCoordinateDelta: observed,
        verdict,
      });
    }
  }

  writeFileSync(
    join(OUT_DIR, 'scalar-precision.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        harnessVersion: HARNESS_VERSION,
        environment: `node ${process.version} ${process.platform}/${process.arch}`,
        canonicalStore: {
          type: 'Float32Array',
          source: 'packages/mesh-core/src/mesh.ts:27 (PositionArray)',
          consequence:
            'Corpus fixtures are float32 before any candidate sees them, so the corpus cannot detect candidate float32 narrowing. This probe bypasses the corpus.',
        },
        pmpScalarConfiguration: {
          typedef: 'using Scalar = float',
          source: 'src/pmp/types.h:17-21, selected when PMP_SCALAR_TYPE_64 is NOT defined',
          doubleBuildSupported: true,
          doubleBuildFlag: '-DPMP_SCALAR_TYPE=64 (CMakeLists.txt:167 defines PMP_SCALAR_TYPE_64)',
          ourBuildDefinesIt: false,
          evidence:
            'PMP_SCALAR_TYPE absent from the build CMakeCache, and absent from the em++ command line that compiles binding.cpp.',
        },
        manifoldScalarConfiguration: {
          typedef: 'MeshGL64 (double precision vertex properties)',
          source: 'binding.cpp uses manifold::MeshGL64 deliberately',
        },
        rows,
      },
      null,
      2,
    ),
  );
  rmSync(scratch, { recursive: true, force: true });

  process.stdout.write('\nscalar precision\n');
  for (const row of rows) {
    process.stdout.write(
      `  ${String(row.candidateId).padEnd(9)} offset=${String(row.coordinateOffset).padEnd(7)} predicted=${Number(row.float32Prediction).toExponential(3)} observed=${row.observedMaxCoordinateDelta === null ? 'none' : Number(row.observedMaxCoordinateDelta).toExponential(3)} ${String(row.verdict)}\n`,
    );
  }
}, 600_000);
