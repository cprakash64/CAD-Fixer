import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * STAGE 3A-3B — REALISTIC SCALING AND WASM MEMORY (Parts E, F, G).
 *
 * THE TINY CORPUS ANSWERS NOTHING ABOUT MEMORY. R01-R30 are at most 200
 * triangles, so Stage 3A-2's "no heap growth observed" was a negative result at
 * a scale where growth was impossible. These runs use meshes sized by their
 * actual transfer bytes.
 *
 * GEOMETRY IS GENERATED IN THE PAGE. The first version built meshes in Node and
 * sent them across the Playwright bridge; `Array.from` over a 50 MiB mesh
 * produced millions of boxed numbers and killed the test runner with
 * "JavaScript heap out of memory" before the browser did any work. Nothing
 * large crosses the bridge now — only names, parameters and measurements. That
 * also matches production, where the geometry is already in the browser.
 *
 * ROLE-APPROPRIATE ONLY. Closed solids for Manifold booleans, a seam fixture
 * for Geogram, a manifold surface for PMP. Nothing is fed malformed input.
 *
 * SAFETY FIRST, SEQUENTIALLY. Every size is estimated before it runs and
 * skipped if unsafe. A graceful refusal is an acceptable result; crashing the
 * tab is not, and would destroy the run's own evidence.
 */

const CASES = join(import.meta.dirname, '..', 'experiments', 'browser-harness', '.cases');
const MIB = 1024 * 1024;
const TARGETS = [1, 10, 50];

/**
 * Refuse anything whose estimated peak exceeds this.
 *
 * The estimate deliberately over-counts: page copy, worker copy, WASM ingest,
 * WASM working set (assumed 3x input, which booleans can exceed), output and
 * the extracted result. 8 GB machine, and contention has bitten before.
 */
const SAFETY_BUDGET_BYTES = 1400 * MIB;

const estimatePeak = (inputBytes: number): number => inputBytes * 8;

interface ScaleRow {
  candidateId: string;
  operation: string;
  targetMiB: number;
  inputBytes: number;
  inputTriangles: number;
  estimatedPeakBytes: number;
  phase: string;
  skipReason: string | null;
  kernelStatus: number | null;
  ingestMs: number | null;
  kernelMs: number | null;
  extractMs: number | null;
  totalMs: number | null;
  heapBeforeIngest: number | null;
  heapAfterIngest: number | null;
  heapAfterOperation: number | null;
  heapAfterExtract: number | null;
  outputVertices: number | null;
  outputTriangles: number | null;
  outputBytes: number | null;
  summary: Record<string, unknown> | null;
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

const rows: ScaleRow[] = [];

function blank(
  candidateId: string,
  operation: string,
  targetMiB: number,
  inputBytes: number,
  inputTriangles: number,
): ScaleRow {
  return {
    candidateId,
    operation,
    targetMiB,
    inputBytes,
    inputTriangles,
    estimatedPeakBytes: estimatePeak(inputBytes),
    phase: 'PENDING',
    skipReason: null,
    kernelStatus: null,
    ingestMs: null,
    kernelMs: null,
    extractMs: null,
    totalMs: null,
    heapBeforeIngest: null,
    heapAfterIngest: null,
    heapAfterOperation: null,
    heapAfterExtract: null,
    outputVertices: null,
    outputTriangles: null,
    outputBytes: null,
    summary: null,
    note: null,
  };
}

function fill(row: ScaleRow, result: Record<string, unknown>): ScaleRow {
  if (result.ok !== true) {
    return {
      ...row,
      phase: text(result.phase, 'OPERATION_FAILED'),
      note: result.message === undefined ? null : text(result.message, 'unreadable').slice(0, 300),
    };
  }
  const outputVertices = Number(result.outputVertices ?? 0);
  const outputTriangles = Number(result.outputTriangles ?? 0);
  return {
    ...row,
    phase: result.unsupportedInput === true ? 'UNSUPPORTED_INPUT_CLASS' : 'RAN',
    kernelStatus: typeof result.kernelStatus === 'number' ? result.kernelStatus : null,
    ingestMs: typeof result.ingestMs === 'number' ? result.ingestMs : null,
    kernelMs: typeof result.kernelMs === 'number' ? result.kernelMs : null,
    extractMs: typeof result.extractMs === 'number' ? result.extractMs : null,
    totalMs: typeof result.totalMs === 'number' ? result.totalMs : null,
    heapBeforeIngest: Number(result.heapBeforeIngest ?? 0),
    heapAfterIngest: Number(result.heapAfterIngest ?? 0),
    heapAfterOperation: Number(result.heapAfterOperation ?? 0),
    heapAfterExtract: Number(result.heapAfterExtract ?? 0),
    outputVertices,
    outputTriangles,
    outputBytes: outputVertices * 3 * 8 + outputTriangles * 3 * 4,
    summary: (result.summary as Record<string, unknown> | null) ?? null,
  };
}

test.describe.configure({ mode: 'serial' });

test('candidates scale to realistic mesh sizes in the browser', async ({ page }) => {
  test.setTimeout(1_800_000);
  await page.goto('/');

  for (const targetMiB of TARGETS) {
    const target = targetMiB * MIB;

    /* ------------------------------------------------------------ manifold -- */
    // Two overlapping spheres, each half the budget so the PAIR hits the size.
    const half = await page.evaluate((bytes) => window.cfHarness.sphereForBytes(bytes), target / 2);
    expect(half).not.toBeNull();
    if (half !== null) {
      const a = await page.evaluate(
        ([segments, rings]) =>
          window.cfHarness.buildMesh('mfA', {
            kind: 'uvSphere',
            segments: segments,
            rings: rings,
            radius: 1,
            centre: [0, 0, 0],
          }),
        [half.segments, half.rings] as const,
      );
      await page.evaluate(
        ([segments, rings]) =>
          window.cfHarness.buildMesh('mfB', {
            kind: 'uvSphere',
            segments: segments,
            rings: rings,
            radius: 1,
            centre: [0.7, 0, 0],
          }),
        [half.segments, half.rings] as const,
      );

      const inputBytes = a.bytes * 2;
      const row = blank('manifold', 'Boolean(OpType::Add)', targetMiB, inputBytes, a.triangles * 2);
      if (row.estimatedPeakBytes > SAFETY_BUDGET_BYTES) {
        rows.push({
          ...row,
          phase: 'SKIPPED_UNSAFE',
          skipReason: `estimated peak ${String(Math.round(row.estimatedPeakBytes / MIB))} MiB exceeds the ${String(SAFETY_BUDGET_BYTES / MIB)} MiB budget`,
        });
      } else {
        const session = await page.evaluate(() => window.cfHarness.open('manifold'));
        expect(session.ok).toBe(true);
        const result = await page.evaluate(
          (sessionId) => window.cfHarness.booleanOnMeshes(sessionId, 'mfA', 'mfB', 0),
          session.sessionId,
        );
        await page.evaluate((s) => window.cfHarness.close(s), session.sessionId);
        rows.push(fill(row, result));
      }
      await page.evaluate(() => window.cfHarness.releaseMeshes());
    }

    /* ------------------------------------------------------------- geogram -- */
    // A seam fixture at scale, exercising exact topology recovery — the
    // operation Geogram's front-line role actually calls for.
    let side = 8;
    const bytesFor = (s: number): number => (s + 1) * (s + 1) * 2 * 3 * 8 + s * s * 4 * 3 * 4;
    while (bytesFor(side) < target) side += 8;
    const grid = await page.evaluate(
      (s) => window.cfHarness.buildMesh('gg', { kind: 'crackedGrid', side: s, gap: 1e-3 }),
      side,
    );
    const geogramRow = blank('geogram', 'repairTopology', targetMiB, grid.bytes, grid.triangles);
    if (geogramRow.estimatedPeakBytes > SAFETY_BUDGET_BYTES) {
      rows.push({
        ...geogramRow,
        phase: 'SKIPPED_UNSAFE',
        skipReason: `estimated peak ${String(Math.round(geogramRow.estimatedPeakBytes / MIB))} MiB exceeds budget`,
      });
    } else {
      const session = await page.evaluate(() => window.cfHarness.open('geogram'));
      expect(session.ok).toBe(true);
      const result = await page.evaluate(
        (sessionId) =>
          window.cfHarness.runOnMesh(sessionId, 'gg', {
            type: 'operation',
            operation: 'repairTopology',
            parameter: 0,
          }),
        session.sessionId,
      );
      await page.evaluate((s) => window.cfHarness.close(s), session.sessionId);
      rows.push(fill(geogramRow, result));
    }
    await page.evaluate(() => window.cfHarness.releaseMeshes());

    /* ----------------------------------------------------------------- pmp -- */
    /*
     * INGEST AT SCALE, NOT HOLE FILL — and that is a finding, not a dodge.
     * PMP's hole filling is a dynamic program over the BOUNDARY LOOP, and the
     * cancellation calibration measured 48.8 s for a single loop on a
     * 488k-triangle sphere. Scaling the loop further would take hours and add
     * nothing. Ingest exercises halfedge construction, ingest and extraction at
     * size — the parts that scale with the MESH rather than with the loop. The
     * loop-size sensitivity is measured separately below.
     */
    const pmpSphere = await page.evaluate(
      (bytes) => window.cfHarness.sphereForBytes(bytes),
      target,
    );
    if (pmpSphere !== null) {
      const mesh = await page.evaluate(
        ([segments, rings]) =>
          window.cfHarness.buildMesh('pm', {
            kind: 'uvSphere',
            segments: segments,
            rings: rings,
            radius: 1,
          }),
        [pmpSphere.segments, pmpSphere.rings] as const,
      );
      const pmpRow = blank('pmp', 'ingest', targetMiB, mesh.bytes, mesh.triangles);
      if (pmpRow.estimatedPeakBytes > SAFETY_BUDGET_BYTES) {
        rows.push({
          ...pmpRow,
          phase: 'SKIPPED_UNSAFE',
          skipReason: `estimated peak ${String(Math.round(pmpRow.estimatedPeakBytes / MIB))} MiB exceeds budget`,
        });
      } else {
        const session = await page.evaluate(() => window.cfHarness.open('pmp'));
        expect(session.ok).toBe(true);
        const result = await page.evaluate(
          (sessionId) =>
            window.cfHarness.runOnMesh(sessionId, 'pm', {
              type: 'operation',
              operation: 'ingest',
              parameter: 0,
            }),
          session.sessionId,
        );
        await page.evaluate((s) => window.cfHarness.close(s), session.sessionId);
        rows.push(fill(pmpRow, result));
      }
      await page.evaluate(() => window.cfHarness.releaseMeshes());
    }
  }

  /* -------------------------- PMP hole-fill LOOP-SIZE sensitivity --------- */
  /*
   * The loop, not the mesh, is what makes PMP's fill expensive. Measured
   * explicitly because a production integration must bound the loop it accepts,
   * and "hole filling is fast" would be a dangerous thing to conclude from the
   * 4-edge R08 fixture alone.
   */
  for (const segments of [24, 48, 96]) {
    const mesh = await page.evaluate(
      (s) =>
        window.cfHarness.buildMesh('pmHole', {
          kind: 'openedSphere',
          segments: s,
          rings: Math.max(4, Math.round(s / 2)),
          radius: 1,
        }),
      segments,
    );
    const row = blank('pmp', `fillHoles (loop=${String(segments)})`, 0, mesh.bytes, mesh.triangles);
    const session = await page.evaluate(() => window.cfHarness.open('pmp'));
    expect(session.ok).toBe(true);
    const result = await page.evaluate(
      (sessionId) =>
        window.cfHarness.runOnMesh(sessionId, 'pmHole', {
          type: 'operation',
          operation: 'fillHoles',
          parameter: 0,
        }),
      session.sessionId,
    );
    await page.evaluate((s) => window.cfHarness.close(s), session.sessionId);
    rows.push(fill(row, result));
    await page.evaluate(() => window.cfHarness.releaseMeshes());
  }

  writeFileSync(join(CASES, 'scaling-raw.json'), JSON.stringify({ rows }));

  // A surviving evaluate proves the page is still alive after every run.
  const alive = await page.evaluate(() => window.cfHarness.environment().crossOriginIsolated);
  expect(alive, 'page survived every scaled run').toBe(true);
});
