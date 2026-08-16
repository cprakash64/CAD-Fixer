import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * STAGE 3A-3B, STEP 2 OF 3 — drive Chromium (Parts A, B).
 *
 * THE HARD GATE. Node success is not browser success. Until a candidate's
 * actual WASM artifact loads, instantiates, ingests, computes and returns
 * geometry inside a cross-origin-isolated Chromium worker, it cannot be
 * selected for a browser product.
 *
 * THIS FILE DOES NOT JUDGE ANYTHING. It records what the browser produced and
 * writes it out; `scripts/browser-validate.bench-suite.ts` runs CAD Fixer's
 * Stage 2 analysis on that output in a separate process. Keeping the driver and
 * the oracle apart is why a candidate cannot influence its own verdict.
 *
 * LOCAL IMPORTS ONLY, deliberately: every production `e2e/` spec follows that
 * rule, and importing the workspace package graph here hangs Playwright's
 * loader outright.
 */

const CASES = join(import.meta.dirname, '..', 'experiments', 'browser-harness', '.cases');

interface PreparedMesh {
  positions: number[];
  triangles: number[];
  pre: Record<string, number | boolean>;
}

interface Prepared {
  harnessVersion: string;
  corpusVersion: string;
  artifactShas: Record<string, string>;
  meshes: Record<string, PreparedMesh>;
}

const prepared = JSON.parse(readFileSync(join(CASES, 'cases.json'), 'utf8')) as Prepared;

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
 * Narrows an `unknown` field to a string.
 *
 * `String(value)` on an unknown renders an object as "[object Object]", which
 * would put a plausible-looking wrong value into a results file. Non-strings
 * become the fallback instead of a fabricated rendering.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

const rows: RawRow[] = [];
const network: { url: string; resourceType: string }[] = [];
// Widened deliberately: this is serialised into the results file alongside
// harness fields, so it is stored as an open record rather than as the narrow
// readonly shape the harness returns.
let browserEnvironment: Record<string, unknown> = {};
const initTimings: Record<string, unknown> = {};

test.describe.configure({ mode: 'serial' });

test('candidate WASM runs in a cross-origin-isolated Chromium worker', async ({ page }) => {
  page.on('request', (request) => {
    network.push({ url: request.url(), resourceType: request.resourceType() });
  });
  await page.goto('/');

  // ASSERTED IN THE BROWSER, not read off response headers. A header can be
  // present while the document still fails to reach an isolated context, and
  // `crossOriginIsolated` is the only thing that proves it did.
  browserEnvironment = { ...(await page.evaluate(() => window.cfHarness.environment())) };
  expect(browserEnvironment.crossOriginIsolated, 'page must be cross-origin isolated').toBe(true);
  expect(browserEnvironment.hasSharedArrayBuffer).toBe(true);

  const push = (
    caseId: string,
    candidateId: string,
    description: string,
    fixture: string | null,
    operation: string,
    parameter: number | null,
    result: Record<string, unknown>,
  ): void => {
    if (result.ok !== true) {
      // PRECISE PHASE. "browser failed" is not a finding.
      rows.push({
        caseId,
        candidateId,
        description,
        phase: text(result.phase, 'UNKNOWN'),
        fixture,
        operation,
        parameter,
        kernelStatus: null,
        kernelMs: null,
        ingestMs: null,
        extractMs: null,
        heap: null,
        outputVertices: null,
        outputTriangles: null,
        positions: null,
        triangles: null,
        extra: {},
        note:
          result.message === undefined ? null : text(result.message, 'unreadable').slice(0, 300),
      });
      return;
    }

    rows.push({
      caseId,
      candidateId,
      description,
      phase: result.unsupportedInput === true ? 'UNSUPPORTED_INPUT_CLASS' : 'RAN',
      fixture,
      operation,
      parameter,
      kernelStatus: typeof result.kernelStatus === 'number' ? result.kernelStatus : null,
      kernelMs: typeof result.kernelMs === 'number' ? result.kernelMs : null,
      ingestMs: typeof result.ingestMs === 'number' ? result.ingestMs : null,
      extractMs: typeof result.extractMs === 'number' ? result.extractMs : null,
      heap: {
        beforeIngest: Number(result.heapBeforeIngest ?? 0),
        afterIngest: Number(result.heapAfterIngest ?? 0),
        afterOperation: Number(result.heapAfterOperation ?? 0),
        afterExtract: Number(result.heapAfterExtract ?? 0),
      },
      outputVertices: typeof result.outputVertices === 'number' ? result.outputVertices : null,
      outputTriangles: typeof result.outputTriangles === 'number' ? result.outputTriangles : null,
      positions: Array.isArray(result.positions) ? (result.positions as number[]) : null,
      triangles: Array.isArray(result.triangles) ? (result.triangles as number[]) : null,
      extra: {
        kernelReportedSuccess: result.kernelReportedSuccess ?? null,
        volume: result.volume ?? null,
        kernelComponents: result.kernelComponents ?? null,
        moebiusFacets: result.moebiusFacets ?? null,
        filledHoles: result.filledHoles ?? null,
      },
      note: null,
    });
  };

  const operationCase = async (
    session: number,
    caseId: string,
    candidateId: string,
    description: string,
    meshName: string,
    operation: string,
    parameter: number,
  ): Promise<void> => {
    const mesh = prepared.meshes[meshName];
    if (mesh === undefined) throw new Error(`missing prepared mesh ${meshName}`);
    const result = await page.evaluate(
      ([sessionId, payload, op, param]) =>
        window.cfHarness.run(sessionId, {
          type: 'operation',
          operation: op,
          parameter: param,
          positions: new Float64Array(payload.positions),
          triangles: new Uint32Array(payload.triangles),
        }),
      [session, mesh, operation, parameter] as const,
    );
    push(caseId, candidateId, description, meshName, operation, parameter, result);
  };

  /* ------------------------------------------------------------- manifold -- */

  const manifold = await page.evaluate(() => window.cfHarness.open('manifold'));
  expect(manifold.ok, `manifold init phase: ${String(manifold.phase)}`).toBe(true);
  initTimings.manifold = manifold;

  await operationCase(
    manifold.sessionId,
    'BM01',
    'manifold',
    'clean closed solid ingest',
    'cubeA',
    'ingest',
    0,
  );

  const booleanCase = async (
    caseId: string,
    description: string,
    left: string,
    right: string,
    opType: number,
  ): Promise<void> => {
    const a = prepared.meshes[left];
    const b = prepared.meshes[right];
    if (a === undefined || b === undefined) throw new Error(`missing operands ${left}/${right}`);
    const result = await page.evaluate(
      ([sessionId, one, two, op]) =>
        window.cfHarness.run(sessionId, {
          type: 'boolean',
          opType: op,
          a: {
            positions: new Float64Array(one.positions),
            triangles: new Uint32Array(one.triangles),
          },
          b: {
            positions: new Float64Array(two.positions),
            triangles: new Uint32Array(two.triangles),
          },
        }),
      [manifold.sessionId, a, b, opType] as const,
    );
    push(caseId, 'manifold', description, `${left}+${right}`, 'Boolean(OpType::Add)', null, result);
  };

  await booleanCase('BM02', 'overlapping cubes union', 'cubeA', 'cubeOverlap', 0);
  await booleanCase('BM03', 'disjoint cubes union — bridge test', 'cubeA', 'cubeFar', 0);
  await booleanCase('BM04', 'R16 two-shell union (decomposed)', 'r16ShellA', 'r16ShellB', 0);
  await booleanCase('BM05', 'near-coplanar boolean, 1e-6 overlap', 'cubeA', 'cubeNearCoplanar', 0);
  await booleanCase(
    'BM06',
    'boolean at 1e6 from the origin',
    'cubeFarOriginA',
    'cubeFarOriginB',
    0,
  );
  await booleanCase('BM07', 'boolean at 1e-4 scale', 'cubeTinyA', 'cubeTinyB', 0);

  await page.evaluate((session) => window.cfHarness.close(session), manifold.sessionId);

  /* -------------------------------------------------------------- geogram -- */

  const geogram = await page.evaluate(() => window.cfHarness.open('geogram'));
  expect(geogram.ok, `geogram init phase: ${String(geogram.phase)}`).toBe(true);
  initTimings.geogram = geogram;

  await operationCase(
    geogram.sessionId,
    'BG01',
    'geogram',
    'clean cube, exact topology repair',
    'R02',
    'repairTopology',
    0,
  );
  await operationCase(
    geogram.sessionId,
    'BG02',
    'geogram',
    'R28 mixed defects, topology repair',
    'R28',
    'repairTopology',
    0,
  );
  /*
   * TOLERANCE IS EXPLICIT AND PARAMETER-DRIVEN, in the browser exactly as in
   * Node. Never a default, never implicit — BG06 exists to show that the same
   * parameter which heals BG04 destroys an intentional feature.
   */
  await operationCase(
    geogram.sessionId,
    'BG03',
    'geogram',
    'R19 tolerance BELOW the crack',
    'R19',
    'repairColocate',
    1e-5,
  );
  await operationCase(
    geogram.sessionId,
    'BG04',
    'geogram',
    'R19 tolerance AT the crack',
    'R19',
    'repairColocate',
    1e-3,
  );
  await operationCase(
    geogram.sessionId,
    'BG05',
    'geogram',
    'R21 tolerance BELOW destructive',
    'R21',
    'repairColocate',
    5e-4,
  );
  await operationCase(
    geogram.sessionId,
    'BG06',
    'geogram',
    'R21 DESTRUCTIVE tolerance',
    'R21',
    'repairColocate',
    1e-3,
  );
  await operationCase(
    geogram.sessionId,
    'BG07',
    'geogram',
    'R17 intersection/remeshing, small controlled case',
    'R17',
    'intersectSurface',
    0,
  );

  await page.evaluate((session) => window.cfHarness.close(session), geogram.sessionId);

  /* ------------------------------------------------------------------ pmp -- */

  const pmp = await page.evaluate(() => window.cfHarness.open('pmp'));
  expect(pmp.ok, `pmp init phase: ${String(pmp.phase)}`).toBe(true);
  initTimings.pmp = pmp;

  await operationCase(
    pmp.sessionId,
    'BP01',
    'pmp',
    'clean manifold input, ingest',
    'R02',
    'ingest',
    0,
  );
  await operationCase(
    pmp.sessionId,
    'BP02',
    'pmp',
    'R08 explicit hole fill',
    'R08',
    'fillHoles',
    0,
  );
  /*
   * BP03 — the PRECONDITION is enforced by our adapter, not by crashing PMP.
   * R11's non-manifold edge cannot be represented by `pmp::SurfaceMesh`, and the
   * binding returns a typed refusal before any algorithm runs. A production
   * integration would have to own exactly this check.
   */
  await operationCase(
    pmp.sessionId,
    'BP03',
    'pmp',
    'R11 non-manifold edge, refused by precondition',
    'R11',
    'ingest',
    0,
  );

  await page.evaluate((session) => window.cfHarness.close(session), pmp.sessionId);

  const stale = await page.evaluate(() => window.cfHarness.staleMessages());
  expect(stale, 'no stale worker message during the smoke matrix').toEqual([]);

  writeFileSync(
    join(CASES, 'browser-raw.json'),
    JSON.stringify({
      startedAt: new Date().toISOString(),
      harnessVersion: prepared.harnessVersion,
      corpusVersion: prepared.corpusVersion,
      artifactShas: prepared.artifactShas,
      browser: browserEnvironment,
      initTimings,
      network: network.map((entry) => ({
        origin: new URL(entry.url).origin,
        path: new URL(entry.url).pathname,
        resourceType: entry.resourceType,
      })),
      rows,
    }),
  );
});

test('no candidate request left the harness origin', () => {
  expect(network.length, 'requests were recorded').toBeGreaterThan(0);
  const foreign = network.filter((entry) => !entry.url.startsWith('http://127.0.0.1:4174/'));
  // CAD Fixer is local-first. A candidate runtime that reached another origin
  // would be disqualified outright, not noted as a caveat.
  expect(foreign, 'candidate runtime must not contact an external origin').toEqual([]);
});
