import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { createIndexArray, createPositionArray, IDENTITY_MATRIX4 } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { recoverVertexIdentity } from '@cadfixer/mesh-topology';
import { CORPUS, FixtureScale, diagnose, summariseReport } from '@cadfixer/repair-evaluation';
import type { RepairFixture, TopologySummaryRow } from '@cadfixer/repair-evaluation';

/**
 * THE STAGE 3A-2 BAKEOFF.
 *
 * Runs the FROZEN Stage 3A-1 corpus against the compiled WASM candidates and
 * judges every output with CAD Fixer's own validators. Not part of CI: it needs
 * built artifacts and its timings are machine-dependent.
 *
 * THE EXAM IS NOT EDITED HERE. Fixtures and expectations come from the
 * committed evaluation package exactly as Stage 3A-1 froze them.
 *
 * CANDIDATES RUN IN A CHILD PROCESS. Emscripten's ES6 glue does not survive
 * Vite's transform — see run-candidates.mjs. This file prepares meshes, spawns
 * that process, and validates what comes back.
 */

const OUT_DIR = join(import.meta.dirname, '..', 'docs', 'repair', 'bakeoff');
const RUNNER = join(
  import.meta.dirname,
  '..',
  'experiments',
  'repair-kernels',
  'scripts',
  'run-candidates.mjs',
);

const CANDIDATE_SHAS: Readonly<Record<string, string>> = {
  manifold: '11235e6b8ebea2dbed8aec4285685aafd3d95667',
  geogram: 'c8529bb00838186938ab31d96008a59b6a892dee',
  pmp: 'af4725ccf6aa308e7ffad9a7bb927c6381b7c858',
};

/**
 * The candidate-neutral transfer representation: WELDED positions plus indices.
 *
 * THIS IS THE CORRECTION THAT MADE THE BAKEOFF MEAN ANYTHING. The first version
 * handed candidates de-indexed soup — every triangle with its own three
 * corners. Under that representation no two faces share a vertex, so PMP
 * ingested the bow-tie and the non-manifold-edge fixtures without complaint
 * (every triangle is an isolated, trivially manifold island) and Manifold
 * rejected almost everything as non-manifold. Both results were artefacts of
 * the harness, not properties of the kernels.
 *
 * Welding uses the approved Stage 2 exact-coordinate identity — the same
 * connectivity recovery the product performs — so each candidate receives the
 * topology a production integration would actually hand it. No tolerance is
 * applied: identity is exact, as ADR 0009 requires.
 */
function toTransfer(mesh: CanonicalMesh): { positions: Float64Array; triangles: Uint32Array } {
  const identity = recoverVertexIdentity(mesh);
  const positions = new Float64Array(identity.vertexCount * 3);
  for (let v = 0; v < identity.vertexCount; v += 1) {
    const corner = (identity.vertexRepresentativeCorner[v] ?? 0) * 3;
    positions[v * 3] = mesh.positions[corner] ?? 0;
    positions[v * 3 + 1] = mesh.positions[corner + 1] ?? 0;
    positions[v * 3 + 2] = mesh.positions[corner + 2] ?? 0;
  }

  const triangles = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i += 1) {
    triangles[i] = identity.cornerToVertex[mesh.indices[i] ?? 0] ?? 0;
  }
  return { positions, triangles };
}

/** Rebuilds a canonical soup mesh from candidate output, for OUR validators. */
function fromCandidate(positions: readonly number[], triangles: readonly number[]): CanonicalMesh {
  const out = createPositionArray(triangles.length * 3);
  const indices = createIndexArray(triangles.length);
  for (let i = 0; i < triangles.length; i += 1) {
    const source = (triangles[i] ?? 0) * 3;
    out[i * 3] = positions[source] ?? 0;
    out[i * 3 + 1] = positions[source + 1] ?? 0;
    out[i * 3 + 2] = positions[source + 2] ?? 0;
    indices[i] = i;
  }
  return {
    positions: out,
    indices,
    metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
  };
}

/** Which operations each candidate's ROLE calls for on a given fixture. */
function operationsFor(
  candidateId: string,
  fixture: RepairFixture,
): { op: string; param: number }[] {
  if (candidateId === 'manifold') {
    const ops = [
      { op: 'ingest', param: 0 },
      { op: 'merge', param: 0 },
    ];
    if (['R16', 'R17', 'R18', 'R24', 'R25'].includes(fixture.id)) {
      ops.push({ op: 'selfUnion', param: 0 });
    }
    return ops;
  }
  if (candidateId === 'geogram') {
    const ops = [
      { op: 'repairTopology', param: 0 },
      { op: 'repairDuplicateFacets', param: 0 },
      { op: 'reorient', param: 0 },
    ];
    // Explicit tolerances spanning below / near / above the real separations.
    // R19's crack is 1e-3; R21's intentional gap is 5e-4.
    if (['R19', 'R20', 'R21'].includes(fixture.id)) {
      for (const epsilon of [1e-5, 5e-4, 1e-3, 5e-3]) {
        ops.push({ op: 'repairColocate', param: epsilon });
      }
    }
    if (['R16', 'R17', 'R18', 'R28', 'R29'].includes(fixture.id)) {
      ops.push({ op: 'intersectSurface', param: 0 });
    }
    return ops;
  }
  const ops = [{ op: 'ingest', param: 0 }];
  // Hole filling ONLY where a fixture asks for an opening to be closed. R09's
  // tube is deliberately excluded: deciding to fill it is the product decision
  // R09 exists to catch.
  if (['R08', 'R28'].includes(fixture.id)) ops.push({ op: 'fillHoles', param: 0 });
  return ops;
}

interface BakeoffCase {
  readonly fixtureId: string;
  readonly candidateId: string;
  readonly operation: string;
  readonly parameter: number;
  readonly run: number;
  readonly positions: number[];
  readonly triangles: number[];
}

interface RunnerRecord {
  readonly kind?: string;
  readonly initMs?: number;
  readonly artifact?: { bytes: number; sha256: string };
  readonly supports?: string[];
  readonly fixtureId?: string;
  readonly operation?: string;
  readonly parameter?: number;
  readonly run?: number;
}

/** One case's identity, rendered the same way on both sides of the comparison. */
function caseKey(record: RunnerRecord, separator: string): string {
  return [
    record.fixtureId ?? '?',
    record.operation ?? '?',
    String(record.parameter ?? 0),
    String(record.run ?? 0),
  ].join(separator);
}

interface CandidateResult {
  fixtureId: string;
  candidateId: string;
  operation: string;
  parameter: number;
  run: number;
  status: string;
  kernelStatus?: number | null;
  unsupportedOperation?: string | null;
  unsupportedInput?: boolean;
  kernelMs?: number;
  heapBefore?: number;
  heapAfter?: number;
  filledHoles?: number | null;
  kernelReportedSuccess?: boolean | null;
  moebiusFacets?: number | null;
  genus?: number | null;
  outPositions?: number[] | null;
  outTriangles?: number[] | null;
  notes?: string[];
}

it('runs the frozen R01-R30 corpus against the compiled candidates', () => {
  const RUNS = 3; // §27 determinism.
  const scratch = join(tmpdir(), `cf-bakeoff-${String(process.pid)}`);
  mkdirSync(scratch, { recursive: true });

  const corpusHash = createHash('sha256');
  const cases: BakeoffCase[] = [];
  const preByFixture = new Map<string, TopologySummaryRow>();
  const inputTriangles = new Map<string, number>();

  for (const fixture of CORPUS) {
    const mesh = fixture.build(FixtureScale.Tiny);
    corpusHash.update(fixture.id);
    corpusHash.update(new Uint8Array(mesh.positions.buffer));

    preByFixture.set(fixture.id, summariseReport(diagnose(mesh)));
    inputTriangles.set(fixture.id, mesh.indices.length / 3);

    const transfer = toTransfer(mesh);
    for (const candidateId of ['manifold', 'geogram', 'pmp']) {
      for (const { op, param } of operationsFor(candidateId, fixture)) {
        for (let run = 0; run < RUNS; run += 1) {
          cases.push({
            fixtureId: fixture.id,
            candidateId,
            operation: op,
            parameter: param,
            run,
            positions: Array.from(transfer.positions),
            triangles: Array.from(transfer.triangles),
          });
        }
      }
    }
  }
  const corpusVersion = corpusHash.digest('hex').slice(0, 16);

  const inputPath = join(scratch, 'input.json');
  writeFileSync(inputPath, JSON.stringify({ cases }));

  /**
   * ONE CHILD PROCESS PER CANDIDATE, WITH A WALL-CLOCK TIMEOUT.
   *
   * A synchronous WASM call cannot be cancelled from inside its own process.
   * The first full run proved the point painfully: Geogram's intersectSurface
   * consumed 28 minutes of CPU on one fixture with no way to stop it. Killing
   * the process is the only cancellation available, which is exactly the
   * disposable-worker model REPAIR_ARCHITECTURE.md predicts — demonstrated here
   * at process granularity.
   *
   * The child appends each result as it completes and announces each case
   * before starting it, so a kill leaves both the completed work AND the
   * identity of the hanging case on disk.
   */
  // PER FIXTURE, not per candidate. The first timed run used one budget for a
  // whole candidate, so Geogram's hang on R19/repairColocate consumed it and
  // every later fixture was recorded as TIMEOUT — one pathological case erased
  // twelve fixtures of real data. Per-fixture isolation keeps a hang local,
  // which is exactly the property the disposable-worker model has to provide.
  const CANDIDATE_TIMEOUT_MS = 30_000;
  const meta: Record<
    string,
    { initMs: number; artifact: { bytes: number; sha256: string }; supports: string[] }
  > = {};
  const results: CandidateResult[] = [];
  const timedOut: { candidateId: string; onCase: string }[] = [];

  for (const candidateId of ['manifold', 'geogram', 'pmp']) {
    for (const fixture of CORPUS) {
      const outputPath = join(scratch, `${candidateId}-${fixture.id}.jsonl`);
      let killed = false;
      try {
        execFileSync(process.execPath, [RUNNER, candidateId, inputPath, outputPath, fixture.id], {
          stdio: ['ignore', 'inherit', 'inherit'],
          timeout: CANDIDATE_TIMEOUT_MS,
          maxBuffer: 256 * 1024 * 1024,
        });
      } catch {
        // Timeout or non-zero exit. Both are DATA, not a reason to abandon the
        // run: whatever the child flushed before dying is still valid evidence.
        killed = true;
      }

      let lines: string[];
      try {
        lines = readFileSync(outputPath, 'utf8')
          .split('\n')
          .filter((line) => line.length > 0);
      } catch {
        // A child that died before writing anything leaves no file. That is the
        // TIMEOUT path, handled below, not an error worth propagating.
        lines = [];
      }

      const completed = new Set<string>();
      let lastStarted: string | undefined;
      for (const line of lines) {
        const record = JSON.parse(line) as RunnerRecord;
        if (record.kind === 'meta') {
          meta[candidateId] = {
            initMs: record.initMs ?? -1,
            artifact: record.artifact ?? { bytes: 0, sha256: 'unknown' },
            supports: record.supports ?? [],
          };
        } else if (record.kind === 'start') {
          lastStarted = caseKey(record, '/');
        } else if (record.kind === 'result') {
          results.push(record as unknown as CandidateResult);
          completed.add(caseKey(record, '|'));
        }
      }

      if (killed) {
        timedOut.push({ candidateId, onCase: lastStarted ?? `${fixture.id}/unknown` });
        // Every case this candidate never reached is recorded as TIMEOUT rather
        // than silently missing from the matrix.
        for (const entry of cases) {
          if (entry.candidateId !== candidateId) continue;
          if (entry.fixtureId !== fixture.id) continue;
          const id = caseKey(entry, '|');
          if (completed.has(id)) continue;
          results.push({
            fixtureId: entry.fixtureId,
            candidateId,
            operation: entry.operation,
            parameter: entry.parameter,
            run: entry.run,
            status: 'TIMEOUT',
            notes: [
              `candidate killed after ${String(CANDIDATE_TIMEOUT_MS / 1000)}s; hung on ${lastStarted ?? 'unknown'}`,
            ],
          });
        }
        meta[candidateId] ??= {
          initMs: -1,
          artifact: { bytes: 0, sha256: 'unknown' },
          supports: [],
        };
      }
    }
  }

  const raw = { meta, results };

  const rows = raw.results.map((result) => {
    const pre = preByFixture.get(result.fixtureId);
    let status = result.status;
    let post: TopologySummaryRow | null = null;
    let outputTriangleCount: number | null = null;
    let validationMs = 0;
    const notes: string[] = [...(result.notes ?? [])];

    if (result.status === 'RAN') {
      if (result.unsupportedOperation !== null && result.unsupportedOperation !== undefined) {
        status = 'UNSUPPORTED_OPERATION';
      } else if (result.unsupportedInput === true) {
        // PMP's halfedge structure cannot represent this input at all.
        status = 'UNSUPPORTED_INPUT_CLASS';
      } else if (
        result.kernelStatus !== 0 &&
        result.kernelStatus !== null &&
        result.kernelStatus !== undefined
      ) {
        status = `KERNEL_STATUS_${String(result.kernelStatus)}`;
        if (result.candidateId === 'manifold' && result.kernelStatus === 2) {
          notes.push('Manifold::Error::NotManifold — input rejected');
        }
        if (result.candidateId === 'geogram' && result.kernelStatus === 3) {
          notes.push(`non-orientable: ${String(result.moebiusFacets ?? 0)} moebius facets`);
        }
      } else if (
        result.outPositions === null ||
        result.outPositions === undefined ||
        result.outTriangles === null ||
        result.outTriangles === undefined
      ) {
        status = 'EMPTY_OUTPUT';
      } else if (result.outPositions.some((value) => !Number.isFinite(value))) {
        status = 'NON_FINITE';
      } else {
        const output = fromCandidate(result.outPositions, result.outTriangles);
        outputTriangleCount = output.indices.length / 3;
        // OUR oracle decides, never the candidate.
        const startedAt = performance.now();
        post = summariseReport(diagnose(output));
        validationMs = performance.now() - startedAt;
        status = 'RAN_VALIDATED';
      }
    }

    if (result.filledHoles !== null && result.filledHoles !== undefined && result.filledHoles > 0) {
      notes.push(`filled ${String(result.filledHoles)} boundary loops`);
    }
    if (result.kernelReportedSuccess !== null && result.kernelReportedSuccess !== undefined) {
      notes.push(`kernelReportedSuccess=${String(result.kernelReportedSuccess)}`);
    }

    return {
      candidateId: result.candidateId,
      candidateSha: CANDIDATE_SHAS[result.candidateId] ?? 'unknown',
      artifactSha256: raw.meta[result.candidateId]?.artifact.sha256 ?? 'unknown',
      fixtureId: result.fixtureId,
      operation: result.operation,
      parameters: { parameter: result.parameter },
      run: result.run,
      status,
      kernelMs: result.kernelMs ?? 0,
      validationMs,
      inputTriangles: inputTriangles.get(result.fixtureId) ?? 0,
      outputTriangles: outputTriangleCount,
      pre,
      post,
      heapBefore: result.heapBefore ?? 0,
      heapAfter: result.heapAfter ?? 0,
      notes,
    };
  });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'results.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        environment: `node ${process.version} ${process.platform}/${process.arch}`,
        corpusVersion,
        emscripten: '4.0.16',
        transferRepresentation: 'welded positions + indices via exact stored-coordinate identity',
        timedOut,
        candidates: Object.entries(raw.meta).map(([id, entry]) => ({
          id,
          sha: CANDIDATE_SHAS[id],
          artifactBytes: entry.artifact.bytes,
          artifactSha256: entry.artifact.sha256,
          initMs: entry.initMs,
          supports: entry.supports,
        })),
        rows,
      },
      null,
      2,
    ),
  );
  rmSync(scratch, { recursive: true, force: true });

  process.stdout.write(`\ncorpus ${corpusVersion}: ${String(rows.length)} rows\n`);
  for (const [id, entry] of Object.entries(raw.meta)) {
    const mine = rows.filter((row) => row.candidateId === id);
    const byStatus = new Map<string, number>();
    for (const row of mine) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    process.stdout.write(
      `  ${id.padEnd(9)} init ${entry.initMs.toFixed(1)}ms  wasm ${(entry.artifact.bytes / 1024).toFixed(0)}KiB  ` +
        [...byStatus.entries()].map(([key, value]) => `${key}=${String(value)}`).join(' ') +
        '\n',
    );
  }
}, 900_000);
