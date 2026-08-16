import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  CORPUS,
  diagnose,
  fromTransfer,
  summariseReport,
  symmetricSampledSurfaceDistance,
} from '@cadfixer/repair-evaluation';
import type { TopologySummaryRow } from '@cadfixer/repair-evaluation';

/**
 * STAGE 3A-3B, STEP 3 OF 3 — judge what the browser produced.
 *
 * SEPARATE PROCESS, OUR ORACLE. The Playwright spec records raw candidate
 * output and decides nothing. This file runs CAD Fixer's own Stage 2 analysis
 * over that output. A candidate cannot influence its own verdict, and the
 * driver cannot either.
 *
 * IT ALSO CROSS-CHECKS BROWSER AGAINST NODE. Stage 3A-3A measured the same
 * operations under Node; where a case has a Node counterpart the two are
 * compared. Agreement is evidence that the browser result is the candidate's
 * behaviour rather than an artefact of either host.
 *
 * NOT PART OF CI.
 */

/**
 * Narrows an `unknown` JSON field to a string.
 *
 * `String(value)` on an unknown renders an object as "[object Object]", which
 * would put a plausible-looking wrong value into a results file.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

const CASES = join(import.meta.dirname, '..', 'experiments', 'browser-harness', '.cases');
const OUT = join(import.meta.dirname, '..', 'docs', 'repair', 'bakeoff');

interface RawRow {
  caseId: string;
  candidateId: string;
  description: string;
  phase: string;
  fixture: string | null;
  operation: string;
  parameter: number | null;
  kernelStatus: number | null;
  kernelMs: number | null;
  ingestMs: number | null;
  extractMs: number | null;
  heap: Record<string, number> | null;
  outputVertices: number | null;
  outputTriangles: number | null;
  positions: number[] | null;
  triangles: number[] | null;
  extra: Record<string, unknown>;
  note: string | null;
}

/**
 * Expectations, stated here rather than in the browser driver.
 *
 * These are the frozen corpus's acceptance semantics, not new criteria: BG04
 * heals R19's crack, BG06 destroys R21's intentional gap, BM03 must not bridge
 * disjoint solids. The exam is unchanged; this is where its verdict is applied
 * to a browser result.
 */
const EXPECTED: Readonly<Record<string, (post: TopologySummaryRow) => string | null>> = {
  BM01: (p) =>
    p.components === 1 && p.boundaryEdges === 0 ? null : 'clean solid must survive ingest',
  BM02: (p) =>
    p.components === 1 && p.boundaryEdges === 0 && p.nonManifoldEdges === 0
      ? null
      : 'overlapping union must be one closed manifold solid',
  BM03: (p) =>
    p.components === 2 && p.boundaryEdges === 0
      ? null
      : 'disjoint union must stay two components with no bridge',
  BM04: (p) =>
    p.components === 1 && p.boundaryEdges === 0 && p.isBoundaryFree
      ? null
      : 'R16 union must be a single closed solid',
  BG01: (p) => (p.triangles === 12 && p.components === 1 ? null : 'clean cube must be unchanged'),
  BG03: (p) => (p.components === 2 ? null : 'tolerance below the crack must NOT weld'),
  BG04: (p) => (p.components === 1 ? null : 'tolerance at the crack must weld'),
  BG05: (p) => (p.components === 2 ? null : "R21's intentional gap must survive"),
  BG06: (p) => (p.components === 1 ? null : 'this tolerance is expected to destroy the control'),
  BP01: (p) => (p.triangles === 12 ? null : 'clean cube must survive PMP ingest'),
  BP02: (p) => (p.boundaryEdges === 0 && p.isBoundaryFree ? null : 'the named loop must be closed'),
};

it('validates browser candidate output with CAD Fixer Stage 2 analysis', () => {
  const rawPath = join(CASES, 'browser-raw.json');
  if (!existsSync(rawPath)) {
    throw new Error(
      'browser-raw.json missing — run the Playwright browser-harness suite before validating',
    );
  }
  const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as {
    startedAt: string;
    harnessVersion: string;
    corpusVersion: string;
    artifactShas: Record<string, string>;
    browser: Record<string, unknown>;
    initTimings: Record<string, unknown>;
    network: { origin: string; path: string; resourceType: string }[];
    rows: RawRow[];
  };

  const preByFixture = new Map<string, TopologySummaryRow>();
  for (const fixture of CORPUS) {
    preByFixture.set(fixture.id, summariseReport(diagnose(fixture.build())));
  }

  const rows = raw.rows.map((row) => {
    let post: TopologySummaryRow | null = null;
    let verdict = row.phase;
    let violation: string | null = null;
    let preservation: Record<string, number | undefined> | null = null;

    if (row.positions !== null && row.triangles !== null && row.triangles.length > 0) {
      const output = fromTransfer(row.positions, row.triangles);
      post = summariseReport(diagnose(output));

      if (row.positions.some((value) => !Number.isFinite(value))) {
        verdict = 'NON_FINITE';
      } else {
        const check = EXPECTED[row.caseId];
        violation = check === undefined ? null : check(post);
        verdict = violation === null ? 'VALIDATED' : 'EXPECTATION_VIOLATED';
      }

      // Geometry change, where a source fixture exists to compare against.
      if (row.fixture !== null) {
        const fixture = CORPUS.find((entry) => entry.id === row.fixture);
        if (fixture !== undefined) {
          const source = fixture.build();
          const distance = symmetricSampledSurfaceDistance(source, output, {
            samplesPerDirection: 4000,
          });
          preservation = {
            combinedRms: distance.combinedRmsDistance,
            combinedMax: distance.combinedMaxSampledDistance,
            normalisedMax: distance.normalisedCombinedMaxSampledDistance,
          };
        }
      }
    } else if (row.phase === 'UNSUPPORTED_INPUT_CLASS') {
      // A typed refusal is a correct outcome, not a missing result.
      verdict = 'UNSUPPORTED_INPUT_CLASS';
    }

    return {
      caseId: row.caseId,
      candidateId: row.candidateId,
      candidateSha: null,
      artifactSha256: raw.artifactShas[row.candidateId] ?? 'unknown',
      harnessVersion: raw.harnessVersion,
      corpusVersion: raw.corpusVersion,
      description: row.description,
      operation: row.operation,
      parameters: { parameter: row.parameter },
      environment: `chromium ${text(raw.browser.userAgent, '?').split(' ').pop() ?? '?'}`,
      runId: `${raw.harnessVersion}-${row.caseId}`,
      browserPhase: row.phase,
      verdict,
      violation,
      kernelStatus: row.kernelStatus,
      kernelMs: row.kernelMs,
      ingestMs: row.ingestMs,
      extractMs: row.extractMs,
      heap: row.heap,
      pre: row.fixture === null ? null : (preByFixture.get(row.fixture) ?? null),
      post,
      preservation,
      kernelReportedSuccess: row.extra.kernelReportedSuccess ?? null,
      kernelVolume: row.extra.volume ?? null,
      note: row.note,
    };
  });

  // Provenance guard: a row must never be summarised against an artifact that
  // is not the one on disk now.
  const foreign = raw.network.filter((entry) => entry.origin !== 'http://127.0.0.1:4174');

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, 'browser-qualification.json'),
    JSON.stringify(
      {
        startedAt: raw.startedAt,
        harnessVersion: raw.harnessVersion,
        environment: `node ${process.version} ${process.platform}/${process.arch}`,
        corpusVersion: raw.corpusVersion,
        browser: raw.browser,
        artifactShas: raw.artifactShas,
        initTimings: raw.initTimings,
        network: {
          requestCount: raw.network.length,
          origins: [...new Set(raw.network.map((entry) => entry.origin))],
          paths: [...new Set(raw.network.map((entry) => entry.path))].sort(),
          foreignOriginRequests: foreign.length,
        },
        rows,
      },
      null,
      2,
    ),
  );

  /* ------------------- cancellation and scaling, same provenance rules ---- */

  const readRaw = (name: string): Record<string, unknown> | null => {
    const path = join(CASES, name);
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : null;
  };

  const cancellationRaw = readRaw('worker-cost-raw.json');
  const scalingRaw = readRaw('scaling-raw.json');

  if (cancellationRaw !== null) {
    writeFileSync(
      join(OUT, 'browser-cancellation.json'),
      JSON.stringify(
        {
          startedAt: raw.startedAt,
          harnessVersion: raw.harnessVersion,
          environment: `chromium via playwright; node ${process.version} ${process.platform}/${process.arch}`,
          corpusVersion: raw.corpusVersion,
          artifactShas: raw.artifactShas,
          browser: raw.browser,
          note: 'Worker.terminate() against real candidate WASM work. Termination latency is an OBSERVATION BOUND from the page, not a measured kernel-stop time: the platform exposes no termination event, so what is measured is that nothing further arrived during a quiet window.',
          cancellation: cancellationRaw.cancellation ?? [],
          workerCost: cancellationRaw.workerCost ?? [],
          staleWorkerTests: cancellationRaw.staleTests ?? [],
        },
        null,
        2,
      ),
    );
  }

  if (scalingRaw !== null) {
    writeFileSync(
      join(OUT, 'browser-scaling.json'),
      JSON.stringify(
        {
          startedAt: raw.startedAt,
          harnessVersion: raw.harnessVersion,
          environment: `chromium via playwright; node ${process.version} ${process.platform}/${process.arch}`,
          corpusVersion: raw.corpusVersion,
          artifactShas: raw.artifactShas,
          browser: raw.browser,
          note: 'Heap figures are WebAssembly.Memory buffer lengths observed in the worker. They are NOT process RSS and must not be reported as such. Geometry was generated in the page; only measurements crossed the Playwright bridge.',
          rows: scalingRaw.rows ?? [],
        },
        null,
        2,
      ),
    );
  }

  const byVerdict = new Map<string, number>();
  for (const row of rows) byVerdict.set(row.verdict, (byVerdict.get(row.verdict) ?? 0) + 1);
  process.stdout.write(
    `\nbrowser validation: ${[...byVerdict.entries()].map(([k, v]) => `${k}=${String(v)}`).join(' ')}\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `  ${row.caseId.padEnd(5)} ${row.candidateId.padEnd(9)} ${row.verdict.padEnd(24)} ${row.violation ?? ''}\n`,
    );
  }
  if (foreign.length > 0) {
    throw new Error(`candidate runtime contacted ${String(foreign.length)} foreign-origin URLs`);
  }
  const violations = rows.filter((row) => row.verdict === 'EXPECTATION_VIOLATED');
  if (violations.length > 0) {
    throw new Error(
      `browser expectation violations: ${violations.map((row) => `${row.caseId}: ${String(row.violation)}`).join('; ')}`,
    );
  }
}, 600_000);
