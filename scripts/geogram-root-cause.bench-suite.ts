import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  CORPUS,
  diagnose,
  fromTransfer,
  summariseReport,
  symmetricSampledSurfaceDistance,
  toTransfer,
} from '@cadfixer/repair-evaluation';
import type { TopologySummaryRow } from '@cadfixer/repair-evaluation';

/**
 * STAGE 3A-3A — GEOGRAM COLOCATE ROOT CAUSE.
 *
 * Stage 3A-2 recorded Geogram's colocate path aborting on a `variable_exists`
 * assertion and could not attribute it. Reading the pinned source produced a
 * specific hypothesis:
 *
 *   mesh_repair.cpp:1186   epsilon == 0 -> colocate_by_lexico_sort (no CmdLine)
 *                          epsilon != 0 -> Geom::colocate
 *   colocate.cpp:231       -> NearestNeighborSearch::create(dim, "default")
 *   nn_search.cpp:133      -> CmdLine::get_arg("algo:nn_search")
 *   colocate.cpp:238       -> CmdLine::get_arg_bool("sys:multithread")
 *   environment.cpp:217    -> geo_assert(variable_exists) when undeclared
 *
 * and `GEO::initialize()` imports no argument group at all.
 *
 * THIS SUITE TESTS THAT HYPOTHESIS RATHER THAN ASSERTING IT. Two factors are
 * crossed:
 *
 *   initMode  0 = Stage 3A-2's initialisation verbatim (negative control)
 *             1 = plus import_arg_group("algo") and ("sys")
 *   engine    native (clang, same pinned commit) vs wasm (emcc)
 *
 * If mode 0 fails and mode 1 succeeds on BOTH engines, the cause is our
 * initialisation and neither Geogram nor Emscripten. If native and WASM
 * disagree at the same mode, it is Emscripten-specific. If mode 1 fails
 * everywhere, the hypothesis is wrong and the finding stays open.
 *
 * NOT PART OF CI. It needs built artifacts and its timings are machine-specific.
 */

const OUT_DIR = join(import.meta.dirname, '..', 'docs', 'repair', 'bakeoff');
const KERNELS = join(import.meta.dirname, '..', 'experiments', 'repair-kernels');
const NATIVE = join(KERNELS, 'geogram', 'artifacts', 'geogram-reference');
const WASM_RUNNER = join(KERNELS, 'scripts', 'run-geogram-single.mjs');
const WASM_ARTIFACT = join(KERNELS, 'geogram', 'artifacts', 'geogram-candidate.wasm');

const GEOGRAM_SHA = 'c8529bb00838186938ab31d96008a59b6a892dee';
const HARNESS_VERSION = 'stage-3a-3a.1';

/** Operation code 2 = mesh_repair(MESH_REPAIR_COLOCATE, epsilon). */
const COLOCATE = 2;

/**
 * Per-operation wall clock. Stage 3A-2 saw a single call run 28 minutes, so a
 * budget is mandatory; 20 s is far beyond anything these 32-to-72 triangle
 * fixtures could legitimately need.
 */
const TIMEOUT_MS = 20_000;

interface RootCauseRow {
  readonly engine: 'native' | 'wasm';
  readonly initMode: number;
  readonly fixtureId: string;
  readonly epsilon: number;
  readonly run: number;
  readonly outcome: string;
  readonly message: string | null;
  readonly wallMs: number;
  readonly kernelMs: number | null;
  readonly outputVertices: number | null;
  readonly outputTriangles: number | null;
  readonly post: TopologySummaryRow | null;
  readonly surfaceRms: number | null;
  readonly surfaceMax: number | null;
}

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

it('attributes the Geogram colocate failure by crossing initialisation with engine', () => {
  const scratch = join(tmpdir(), `cf-geogram-rc-${String(process.pid)}`);
  mkdirSync(scratch, { recursive: true });

  const fixtures = ['R19', 'R20', 'R21'];
  // Below / at / above the separations the fixtures were built around: R19's
  // crack is 1e-3, R21's intentional gap 5e-4, R20 carries 1e-4/1e-3/1e-2.
  const epsilons = [1e-5, 5e-4, 1e-3, 5e-3];

  const corpusHash = createHash('sha256');
  const prepared = new Map<
    string,
    {
      positions: Float64Array;
      triangles: Uint32Array;
      pre: TopologySummaryRow;
      nativeInput: string;
    }
  >();

  for (const id of fixtures) {
    const fixture = CORPUS.find((entry) => entry.id === id);
    if (fixture === undefined) throw new Error(`missing fixture ${id}`);
    const mesh = fixture.build();
    corpusHash.update(id);
    corpusHash.update(new Uint8Array(mesh.positions.buffer));

    const transfer = toTransfer(mesh);
    prepared.set(id, {
      positions: transfer.positions,
      triangles: transfer.triangles,
      pre: summariseReport(diagnose(mesh)),
      nativeInput: '',
    });
  }
  const corpusVersion = corpusHash.digest('hex').slice(0, 16);

  const rows: RootCauseRow[] = [];

  const runNative = (
    fixtureId: string,
    epsilon: number,
    initMode: number,
    run: number,
  ): RootCauseRow => {
    const entry = prepared.get(fixtureId);
    if (entry === undefined) throw new Error(`unprepared ${fixtureId}`);

    // The SAME buffers the WASM candidate receives, written as text. No fixture
    // is regenerated in C++, so the two engines cannot diverge on geometry.
    const parts: string[] = [
      `${String(COLOCATE)} ${String(epsilon)} ${String(initMode)} ${String(entry.positions.length / 3)} ${String(entry.triangles.length / 3)}`,
    ];
    parts.push([...entry.positions].map((value) => value.toPrecision(17)).join(' '));
    parts.push([...entry.triangles].join(' '));
    const inputPath = join(
      scratch,
      `native-${fixtureId}-${String(epsilon)}-${String(initMode)}.txt`,
    );
    writeFileSync(inputPath, parts.join('\n'));

    const startedAt = performance.now();
    let stdout: string;
    let outcome = 'ABORTED';
    let message: string | null = null;
    try {
      stdout = execFileSync(NATIVE, [inputPath], {
        timeout: TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      // A killed or aborting child still flushed its context lines, so partial
      // stdout is evidence rather than noise.
      const error = cause as { stdout?: string; signal?: string; stderr?: string };
      stdout = error.stdout ?? '';
      outcome = error.signal === 'SIGTERM' ? 'TIMEOUT' : 'ABORTED';
      message = (error.stderr ?? '').slice(0, 300) || null;
    }
    const wallMs = performance.now() - startedAt;

    const fields = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const index = line.indexOf('=');
      if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1));
    }
    const reported = fields.get('outcome');
    if (reported !== undefined) outcome = reported;
    if (fields.has('message')) message = fields.get('message') ?? null;

    const outputTriangles = fields.has('outputTriangles')
      ? Number(fields.get('outputTriangles'))
      : null;
    return {
      engine: 'native',
      initMode,
      fixtureId,
      epsilon,
      run,
      outcome,
      message,
      wallMs,
      kernelMs: null,
      outputVertices: fields.has('outputVertices') ? Number(fields.get('outputVertices')) : null,
      outputTriangles,
      post: null,
      surfaceRms: null,
      surfaceMax: null,
    };
  };

  const runWasm = (
    fixtureId: string,
    epsilon: number,
    initMode: number,
    run: number,
  ): RootCauseRow => {
    const entry = prepared.get(fixtureId);
    if (entry === undefined) throw new Error(`unprepared ${fixtureId}`);

    const requestPath = join(
      scratch,
      `wasm-req-${fixtureId}-${String(epsilon)}-${String(initMode)}-${String(run)}.json`,
    );
    const resultPath = join(
      scratch,
      `wasm-res-${fixtureId}-${String(epsilon)}-${String(initMode)}-${String(run)}.json`,
    );
    writeFileSync(
      requestPath,
      JSON.stringify({
        positions: [...entry.positions],
        triangles: [...entry.triangles],
        operation: 'repairColocate',
        parameter: epsilon,
        initMode,
      }),
    );
    rmSync(resultPath, { force: true });

    const startedAt = performance.now();
    let outcome = 'TIMEOUT';
    try {
      execFileSync(process.execPath, [WASM_RUNNER, requestPath, resultPath], {
        timeout: TIMEOUT_MS,
        stdio: ['ignore', 'ignore', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      // Killed or non-zero exit. Whether a result file exists decides below;
      // this is data, not a reason to abandon the matrix.
    }
    const wallMs = performance.now() - startedAt;

    let payload: Record<string, unknown> | null = null;
    if (existsSync(resultPath)) {
      payload = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
      outcome = text(payload.outcome, 'UNKNOWN');
    }

    let post: TopologySummaryRow | null = null;
    let surfaceRms: number | null = null;
    let surfaceMax: number | null = null;
    let outputTriangles: number | null = null;
    let outputVertices: number | null = null;

    const outPositions = payload?.outPositions;
    const outTriangles = payload?.outTriangles;
    if (Array.isArray(outPositions) && Array.isArray(outTriangles)) {
      outputVertices = outPositions.length / 3;
      outputTriangles = outTriangles.length / 3;
      const output = fromTransfer(outPositions as number[], outTriangles as number[]);
      // OUR oracle judges the output, never Geogram's own report.
      post = summariseReport(diagnose(output));
      const source = fromTransfer([...entry.positions], [...entry.triangles]);
      const distance = symmetricSampledSurfaceDistance(source, output, {
        samplesPerDirection: 4000,
      });
      surfaceRms = distance.combinedRmsDistance;
      surfaceMax = distance.combinedMaxSampledDistance;
    }

    return {
      engine: 'wasm',
      initMode,
      fixtureId,
      epsilon,
      run,
      outcome,
      message:
        payload?.message === undefined ? null : text(payload.message, 'unreadable').slice(0, 300),
      wallMs,
      kernelMs: typeof payload?.kernelMs === 'number' ? payload.kernelMs : null,
      outputVertices,
      outputTriangles,
      post,
      surfaceRms,
      surfaceMax,
    };
  };

  // SEQUENTIAL, ONE PROCESS AT A TIME. Concurrency here would let a hung
  // candidate's CPU contention change another row's timing, and this machine
  // has already suffered that.
  for (const fixtureId of fixtures) {
    for (const epsilon of epsilons) {
      // Mode 0 is a control: one run is enough to show it fails.
      rows.push(runNative(fixtureId, epsilon, 0, 0));
      rows.push(runWasm(fixtureId, epsilon, 0, 0));
      // Mode 1 is the candidate path: three runs, for determinism.
      for (let run = 0; run < 3; run += 1) {
        rows.push(runNative(fixtureId, epsilon, 1, run));
        rows.push(runWasm(fixtureId, epsilon, 1, run));
      }
    }
  }

  writeFileSync(
    join(OUT_DIR, 'geogram-root-cause.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        harnessVersion: HARNESS_VERSION,
        environment: `node ${process.version} ${process.platform}/${process.arch}`,
        corpusVersion,
        candidateId: 'geogram',
        candidateSha: GEOGRAM_SHA,
        wasmArtifactSha256: sha256Of(WASM_ARTIFACT),
        nativeArtifactSha256: sha256Of(NATIVE),
        operation: 'mesh_repair(MESH_REPAIR_COLOCATE, epsilon)',
        timeoutMs: TIMEOUT_MS,
        pre: Object.fromEntries([...prepared].map(([id, entry]) => [id, entry.pre])),
        rows,
      },
      null,
      2,
    ),
  );
  rmSync(scratch, { recursive: true, force: true });

  process.stdout.write(`\ngeogram root cause: ${String(rows.length)} rows\n`);
  for (const engine of ['native', 'wasm'] as const) {
    for (const initMode of [0, 1]) {
      const mine = rows.filter((row) => row.engine === engine && row.initMode === initMode);
      const byOutcome = new Map<string, number>();
      for (const row of mine) byOutcome.set(row.outcome, (byOutcome.get(row.outcome) ?? 0) + 1);
      process.stdout.write(
        `  ${engine.padEnd(7)} initMode=${String(initMode)}  ` +
          [...byOutcome.entries()].map(([key, value]) => `${key}=${String(value)}`).join(' ') +
          '\n',
      );
    }
  }
}, 1_800_000);
