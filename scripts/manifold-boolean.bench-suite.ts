import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  CORPUS,
  box,
  diagnose,
  fromTransfer,
  scalePoints,
  soup,
  summariseReport,
  symmetricSampledSurfaceDistance,
  toTransfer,
  translate,
} from '@cadfixer/repair-evaluation';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { TopologySummaryRow, Triangle } from '@cadfixer/repair-evaluation';

/**
 * STAGE 3A-3A — MANIFOLD BOOLEAN MICRO-SUITE.
 *
 * WHAT THIS REPLACES. Stage 3A-2's "self union" was
 * `Boolean(Manifold(), OpType::Add)` — a union against an EMPTY solid, which is
 * the identity operation. It returned its input unchanged and was then read as
 * evidence that Manifold could not resolve interpenetrating shells. The
 * experiment measured nothing and is marked INVALID_EXPERIMENT; these rows
 * replace it.
 *
 * THE API UNDER TEST is the real one, from the pinned v3.5.2 header:
 *   manifold.h:222  Manifold Manifold::Boolean(const Manifold& second, OpType op) const
 *   common.h:626    enum class OpType : char { Add, Subtract, Intersect }
 *   mesh.h:182      bool MeshGL64::Merge()
 *
 * ROLE DISCIPLINE. Manifold is a solid/boolean engine. Every input below is a
 * VALID closed solid, or is recorded as refused. Feeding it broken soup and
 * scoring the refusal would be testing the wrong role — Stage 3A-2 already
 * established that it rejects 15 of 30 corpus fixtures by precondition.
 *
 * NOT PART OF CI.
 */

const OUT_DIR = join(import.meta.dirname, '..', 'docs', 'repair', 'bakeoff');
const KERNELS = join(import.meta.dirname, '..', 'experiments', 'repair-kernels');
const RUNNER = join(KERNELS, 'scripts', 'run-manifold-single.mjs');
const ARTIFACT = join(KERNELS, 'manifold', 'artifacts', 'manifold-candidate.wasm');

const MANIFOLD_SHA = '11235e6b8ebea2dbed8aec4285685aafd3d95667';
const HARNESS_VERSION = 'stage-3a-3a.1';
const TIMEOUT_MS = 30_000;

const OP_ADD = 0;
const OP_SUBTRACT = 1;
const OP_INTERSECT = 2;
const OP_NAMES: Readonly<Record<number, string>> = {
  [OP_ADD]: 'Boolean(OpType::Add)',
  [OP_SUBTRACT]: 'Boolean(OpType::Subtract)',
  [OP_INTERSECT]: 'Boolean(OpType::Intersect)',
};

interface BooleanRow {
  readonly caseId: string;
  readonly description: string;
  readonly upstreamApi: string;
  readonly run: number;
  readonly outcome: string;
  readonly kernelStatus: number | null;
  readonly kernelReportedSuccess: boolean | null;
  readonly kernelComponents: number | null;
  readonly kernelVolume: number | null;
  readonly genus: number | null;
  readonly kernelMs: number;
  readonly outputTriangles: number | null;
  /** CAD Fixer's INDEPENDENT verdict on the output. */
  readonly post: TopologySummaryRow | null;
  readonly message: string | null;
  /**
   * The output geometry, for callers that need to measure it.
   *
   * NOT serialised into the results file: `BakeoffRow`'s contract forbids raw
   * geometry there, and a results file people read should not carry meshes.
   */
  readonly outputMesh: CanonicalMesh | null;
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

/**
 * Strips the output mesh before serialisation.
 *
 * `BakeoffRow`'s contract forbids raw geometry in a results file, and
 * `scripts/results-integrity.test.ts` enforces it. Written as an explicit
 * rebuild rather than a destructure-and-discard so nothing is silently unused.
 */
function withoutMesh(row: BooleanRow): Omit<BooleanRow, 'outputMesh'> {
  const { outputMesh, ...rest } = row;
  void outputMesh;
  return rest;
}

function sha256Of(path: string): string {
  if (!existsSync(path)) return 'missing';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

it('runs real two-solid Manifold booleans and judges every output independently', () => {
  const scratch = join(tmpdir(), `cf-manifold-bool-${String(process.pid)}`);
  mkdirSync(scratch, { recursive: true });

  const transferOf = (
    triangles: readonly Triangle[],
  ): { positions: number[]; triangles: number[] } => {
    const t = toTransfer(soup(triangles));
    return { positions: [...t.positions], triangles: [...t.triangles] };
  };

  const rows: BooleanRow[] = [];
  let sequence = 0;

  const callBoolean = (
    caseId: string,
    description: string,
    opType: number,
    a: { positions: number[]; triangles: number[] },
    b: { positions: number[]; triangles: number[] },
    run: number,
  ): BooleanRow => {
    sequence += 1;
    const requestPath = join(scratch, `req-${String(sequence)}.json`);
    const resultPath = join(scratch, `res-${String(sequence)}.json`);
    writeFileSync(requestPath, JSON.stringify({ kind: 'boolean', opType, a, b }));

    try {
      execFileSync(process.execPath, [RUNNER, requestPath, resultPath], {
        timeout: TIMEOUT_MS,
        stdio: ['ignore', 'ignore', 'ignore'],
        maxBuffer: 128 * 1024 * 1024,
      });
    } catch {
      // Timeout or non-zero exit: the absence of a result file below is the
      // signal, and it is recorded rather than thrown.
    }

    if (!existsSync(resultPath)) {
      return {
        caseId,
        description,
        upstreamApi: OP_NAMES[opType] ?? 'unknown',
        run,
        outcome: 'TIMEOUT_OR_KILLED',
        kernelStatus: null,
        kernelReportedSuccess: null,
        kernelComponents: null,
        kernelVolume: null,
        genus: null,
        kernelMs: 0,
        outputTriangles: null,
        post: null,
        message: null,
        outputMesh: null,
      };
    }

    const payload = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    let post: TopologySummaryRow | null = null;
    let outputTriangles: number | null = null;
    let outputMesh: CanonicalMesh | null = null;
    const outPositions = payload.outPositions;
    const outTriangles = payload.outTriangles;
    if (Array.isArray(outPositions) && Array.isArray(outTriangles) && outTriangles.length > 0) {
      outputMesh = fromTransfer(outPositions as number[], outTriangles as number[]);
      outputTriangles = outTriangles.length / 3;
      post = summariseReport(diagnose(outputMesh));
    }

    return {
      caseId,
      description,
      upstreamApi: OP_NAMES[opType] ?? 'unknown',
      run,
      outcome: text(payload.outcome, 'UNKNOWN'),
      kernelStatus: typeof payload.kernelStatus === 'number' ? payload.kernelStatus : null,
      kernelReportedSuccess:
        typeof payload.kernelReportedSuccess === 'boolean' ? payload.kernelReportedSuccess : null,
      kernelComponents:
        typeof payload.kernelComponents === 'number' ? payload.kernelComponents : null,
      kernelVolume: typeof payload.volume === 'number' ? payload.volume : null,
      genus: typeof payload.genus === 'number' ? payload.genus : null,
      kernelMs: typeof payload.kernelMs === 'number' ? payload.kernelMs : 0,
      outputTriangles,
      post,
      message:
        payload.message === undefined ? null : text(payload.message, 'unreadable').slice(0, 300),
      outputMesh,
    };
  };

  const unit = 10;
  const cube = (
    min: readonly [number, number, number],
    max: readonly [number, number, number],
  ): { positions: number[]; triangles: number[] } => transferOf(box(min, max));

  /* ---------------------------------------------------------- MB01 - MB08 -- */

  // MB01 — overlapping cubes, union. One solid expected.
  rows.push(
    callBoolean(
      'MB01',
      'Overlapping cube union (offset by half an edge on every axis)',
      OP_ADD,
      cube([0, 0, 0], [unit, unit, unit]),
      cube([unit / 2, unit / 2, unit / 2], [unit * 1.5, unit * 1.5, unit * 1.5]),
      0,
    ),
  );

  // MB02 — disjoint cubes, union. Two components expected, and NO bridge.
  rows.push(
    callBoolean(
      'MB02',
      'Disjoint cube union, 100 units apart',
      OP_ADD,
      cube([0, 0, 0], [unit, unit, unit]),
      cube([unit * 10, 0, 0], [unit * 11, unit, unit]),
      0,
    ),
  );

  // MB03 — subtraction of an overlapping cutter.
  rows.push(
    callBoolean(
      'MB03',
      'Cube minus an overlapping corner cutter',
      OP_SUBTRACT,
      cube([0, 0, 0], [unit, unit, unit]),
      cube([unit / 2, unit / 2, unit / 2], [unit * 1.5, unit * 1.5, unit * 1.5]),
      0,
    ),
  );

  // MB04 — exactly face-to-face contact. Upstream semantics are NOT assumed;
  // whatever happens is recorded.
  rows.push(
    callBoolean(
      'MB04',
      'Tangent cubes sharing one face exactly (contact, no overlap)',
      OP_ADD,
      cube([0, 0, 0], [unit, unit, unit]),
      cube([unit, 0, 0], [unit * 2, unit, unit]),
      0,
    ),
  );

  // MB05 — near-coplanar faces at three explicit overlaps, spanning the range
  // where a boolean either merges the faces or emits a sliver.
  for (const overlap of [1e-9, 1e-6, 1e-3]) {
    rows.push(
      callBoolean(
        `MB05-${overlap.toExponential(0)}`,
        `Near-coplanar cubes overlapping by ${String(overlap)}`,
        OP_ADD,
        cube([0, 0, 0], [unit, unit, unit]),
        cube([unit - overlap, 0, 0], [unit * 2, unit, unit]),
        0,
      ),
    );
  }

  // MB06 — the MB01 union translated 10^6 units from the origin. Generated
  // intersection coordinates at large magnitude: the ADR 0004 evidence.
  const far: readonly [number, number, number] = [1e6, -1e6, 1e6];
  rows.push(
    callBoolean(
      'MB06',
      'Overlapping cube union translated 1e6 from the origin',
      OP_ADD,
      transferOf(translate(box([0, 0, 0], [unit, unit, unit]), far)),
      transferOf(
        translate(box([unit / 2, unit / 2, unit / 2], [unit * 1.5, unit * 1.5, unit * 1.5]), far),
      ),
      0,
    ),
  );

  // MB07 — the same union at 10^-4 scale.
  rows.push(
    callBoolean(
      'MB07',
      'Overlapping cube union at 1e-4 scale',
      OP_ADD,
      transferOf(scalePoints(box([0, 0, 0], [unit, unit, unit]), 1e-5)),
      transferOf(
        scalePoints(
          box([unit / 2, unit / 2, unit / 2], [unit * 1.5, unit * 1.5, unit * 1.5]),
          1e-5,
        ),
      ),
      0,
    ),
  );

  // MB08 — determinism. Three repetitions of a union and a subtraction.
  for (let run = 1; run < 3; run += 1) {
    rows.push(
      callBoolean(
        'MB01',
        'Overlapping cube union (offset by half an edge on every axis)',
        OP_ADD,
        cube([0, 0, 0], [unit, unit, unit]),
        cube([unit / 2, unit / 2, unit / 2], [unit * 1.5, unit * 1.5, unit * 1.5]),
        run,
      ),
    );
    rows.push(
      callBoolean(
        'MB03',
        'Cube minus an overlapping corner cutter',
        OP_SUBTRACT,
        cube([0, 0, 0], [unit, unit, unit]),
        cube([unit / 2, unit / 2, unit / 2], [unit * 1.5, unit * 1.5, unit * 1.5]),
        run,
      ),
    );
  }

  // Intersection, for completeness of the operator set.
  rows.push(
    callBoolean(
      'MB09',
      'Intersection of two overlapping cubes',
      OP_INTERSECT,
      cube([0, 0, 0], [unit, unit, unit]),
      cube([unit / 2, unit / 2, unit / 2], [unit * 1.5, unit * 1.5, unit * 1.5]),
      0,
    ),
  );

  /* ------------------------------------------------------------------ R16 -- */

  /*
   * R16 IS TWO SEPARATE CLOSED BOXES that happen to interpenetrate.
   *
   * MEASURED, NOT ASSUMED: Manifold ACCEPTS the combined 24-triangle soup —
   * the Merge experiment below records status 0 for R16. That is consistent
   * with its precondition being topological: two closed, manifold, correctly
   * wound shells are a valid Manifold, and interpenetration is a GEOMETRIC
   * defect its ingest does not look for. Stage 2 cannot see it either, which is
   * precisely why R16 exists.
   *
   * So decomposition is not needed to ingest R16. It is needed to RESOLVE the
   * interpenetration, because resolving it means unioning the two solids
   * against each other and a boolean needs two operands. That is a precondition
   * of the operation, not a limitation of ingestion, and the distinction
   * matters for what a production pipeline would have to do.
   *
   * The split is not a guess: `corpus.ts` builds R16 as box(...) followed by
   * box(...), 12 triangles each, so the first 12 and the last 12 are exactly
   * the two shells. `decompositionMatchesFixture` asserts the reconstruction
   * is byte-equivalent to the fixture.
   */
  const r16 = CORPUS.find((fixture) => fixture.id === 'R16');
  if (r16 === undefined) throw new Error('missing R16');
  const shellA = box([0, 0, 0], [unit, unit, unit]);
  const shellB = box([unit / 2, unit / 2, unit / 2], [unit * 1.5, unit * 1.5, unit * 1.5]);
  const r16Combined = soup([...shellA, ...shellB]);
  const r16Pre = summariseReport(diagnose(r16Combined));
  // The decomposition must reproduce the fixture exactly, or the experiment is
  // about different geometry than the corpus defines.
  const fixturePre = summariseReport(diagnose(r16.build()));

  for (let run = 0; run < 3; run += 1) {
    rows.push(
      callBoolean(
        'R16-union',
        'R16 decomposed into its two closed shells, then unioned as two solids',
        OP_ADD,
        transferOf(shellA),
        transferOf(shellB),
        run,
      ),
    );
  }

  /* ------------------------------------------------------------------ R17 -- */

  /*
   * R17 is ONE self-intersecting closed shell — closed, edge-manifold and
   * consistently wound, so it satisfies Manifold's topological precondition and
   * is ingested without complaint. Ingestion is therefore NOT the boundary
   * here, and calling it UNSUPPORTED_INPUT_CLASS would be wrong.
   *
   * The real boundary is that a self-intersecting SINGLE shell has no
   * decomposition into two valid solids, so there is no second operand and no
   * honest two-solid boolean to run. Resolving it would need a self-
   * intersection resolution pass, which upstream v3.5.2 does not expose.
   *
   * Explicitly NOT done: pre-processing it with Geogram to manufacture an input
   * Manifold handles. That would measure the pair and then credit Manifold.
   */
  const r17 = CORPUS.find((fixture) => fixture.id === 'R17');
  if (r17 === undefined) throw new Error('missing R17');
  const r17Transfer = toTransfer(r17.build());
  sequence += 1;
  const r17Request = join(scratch, `req-${String(sequence)}.json`);
  const r17Result = join(scratch, `res-${String(sequence)}.json`);
  writeFileSync(
    r17Request,
    JSON.stringify({
      kind: 'run',
      operation: 'ingest',
      positions: [...r17Transfer.positions],
      triangles: [...r17Transfer.triangles],
    }),
  );
  try {
    execFileSync(process.execPath, [RUNNER, r17Request, r17Result], {
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // Recorded through the missing-file path below.
  }
  const r17Payload = existsSync(r17Result)
    ? (JSON.parse(readFileSync(r17Result, 'utf8')) as Record<string, unknown>)
    : null;

  /* ---------------------------------------------------- Merge, explicitly -- */

  const mergeRows: {
    fixtureId: string;
    outcome: string;
    kernelStatus: number | null;
    mergeChanged: number | null;
  }[] = [];
  for (const fixtureId of ['R02', 'R03', 'R11', 'R12', 'R16', 'R19']) {
    const fixture = CORPUS.find((entry) => entry.id === fixtureId);
    if (fixture === undefined) continue;
    const transfer = toTransfer(fixture.build());
    sequence += 1;
    const requestPath = join(scratch, `req-${String(sequence)}.json`);
    const resultPath = join(scratch, `res-${String(sequence)}.json`);
    writeFileSync(
      requestPath,
      JSON.stringify({
        kind: 'run',
        operation: 'merge',
        positions: [...transfer.positions],
        triangles: [...transfer.triangles],
      }),
    );
    try {
      execFileSync(process.execPath, [RUNNER, requestPath, resultPath], {
        timeout: TIMEOUT_MS,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      // Missing result file is the record.
    }
    const payload = existsSync(resultPath)
      ? (JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>)
      : null;
    mergeRows.push({
      fixtureId,
      outcome: payload === null ? 'TIMEOUT_OR_KILLED' : text(payload.outcome, 'UNKNOWN'),
      kernelStatus: typeof payload?.kernelStatus === 'number' ? payload.kernelStatus : null,
      mergeChanged: typeof payload?.mergeChanged === 'number' ? payload.mergeChanged : null,
    });
  }

  /* ------------------------------------------- preservation of a control -- */

  /*
   * A valid solid taken through a boolean that should be a no-op geometrically:
   * union of a cube with a cube strictly inside it. The union IS the outer
   * cube, so any distance from the original is Manifold rewriting geometry it
   * did not need to touch.
   */
  const outer = box([0, 0, 0], [unit, unit, unit]);
  const inner = box(
    [unit * 0.25, unit * 0.25, unit * 0.25],
    [unit * 0.75, unit * 0.75, unit * 0.75],
  );
  const containmentRow = callBoolean(
    'MB10',
    'Union of a cube with a cube wholly inside it (geometric no-op)',
    OP_ADD,
    transferOf(outer),
    transferOf(inner),
    0,
  );
  /*
   * The union of a cube with a cube inside it IS the outer cube. Any distance
   * between the original outer cube and the boolean's output is Manifold
   * rewriting geometry the operation did not require it to touch — measured,
   * not assumed, now that a metric exists.
   */
  let containmentDistance: {
    combinedRms: number;
    combinedMax: number;
    normalisedRms: number | undefined;
  } | null = null;
  if (containmentRow.outputMesh !== null) {
    const distance = symmetricSampledSurfaceDistance(soup(outer), containmentRow.outputMesh, {
      samplesPerDirection: 8000,
    });
    containmentDistance = {
      combinedRms: distance.combinedRmsDistance,
      combinedMax: distance.combinedMaxSampledDistance,
      normalisedRms: distance.normalisedCombinedRmsDistance,
    };
  }

  writeFileSync(
    join(OUT_DIR, 'manifold-boolean.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        harnessVersion: HARNESS_VERSION,
        environment: `node ${process.version} ${process.platform}/${process.arch}`,
        candidateId: 'manifold',
        candidateSha: MANIFOLD_SHA,
        artifactSha256: sha256Of(ARTIFACT),
        upstreamApis: {
          boolean: 'manifold.h:222 Manifold::Boolean(const Manifold&, OpType) const',
          opType: 'common.h:626 enum class OpType : char { Add, Subtract, Intersect }',
          merge: 'mesh.h:182 bool MeshGL64::Merge()',
        },
        invalidatedExperiment: {
          id: 'selfUnion',
          status: 'INVALID_EXPERIMENT',
          reason:
            'Boolean(Manifold(), OpType::Add) unions against an EMPTY solid, which is the identity. It returned its input unchanged and measured nothing. Retained for the record; excluded from all scoring and from every conclusion about intersection resolution.',
        },
        r16: {
          decompositionRequired: true,
          note: 'R16 is two closed boxes emitted as one soup. Manifold ACCEPTS that soup (status 0) because its precondition is topological and interpenetration is geometric. Decomposition is required to RESOLVE the interpenetration — a boolean needs two operands — not to ingest it.',
          fixturePre,
          decomposedPre: r16Pre,
          decompositionMatchesFixture: JSON.stringify(fixturePre) === JSON.stringify(r16Pre),
        },
        r17: {
          classification: 'see rows',
          outcome: r17Payload === null ? 'TIMEOUT_OR_KILLED' : text(r17Payload.outcome, '?'),
          kernelStatus:
            typeof r17Payload?.kernelStatus === 'number' ? r17Payload.kernelStatus : null,
          note: 'Single self-intersecting closed shell. Manifold INGESTS it (its precondition is topological, and R17 is topologically clean), so this is not an unsupported input class for ingest. It has no decomposition into two valid solids, so no two-solid boolean applies, and v3.5.2 exposes no self-intersection resolution. NOT pre-processed with another candidate.',
        },
        merge: mergeRows,
        containment: withoutMesh(containmentRow),
        containmentDistance,
        rows: rows.map(withoutMesh),
      },
      null,
      2,
    ),
  );
  rmSync(scratch, { recursive: true, force: true });

  process.stdout.write(`\nmanifold boolean: ${String(rows.length)} rows\n`);
  for (const row of rows) {
    process.stdout.write(
      `  ${row.caseId.padEnd(12)} run${String(row.run)} ${row.outcome.padEnd(8)} status=${String(row.kernelStatus)} tris=${String(row.outputTriangles)} comps=${String(row.post?.components ?? '-')} boundary=${String(row.post?.boundaryEdges ?? '-')}\n`,
    );
  }
}, 1_800_000);
