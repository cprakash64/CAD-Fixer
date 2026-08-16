import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openedSphere, uvSphere } from '../experiments/browser-harness/scale-meshes.mjs';
import type { GeneratedMesh } from '../experiments/browser-harness/scale-meshes.mjs';

/**
 * STAGE 3A-3B — WORKER CANCELLATION HARD GATE (Part C), and persistent versus
 * disposable worker cost (Part D).
 *
 * NODE CHILD-PROCESS KILLS ARE NOT BROWSER EVIDENCE. Stage 3A-2 and 3A-3A could
 * only show that killing an OS process stops a runaway kernel. The product runs
 * in a browser, so the question is whether `Worker.terminate()` stops real
 * synchronous WASM work, leaves the page usable, leaves the authoritative
 * geometry intact, and allows a clean restart.
 *
 * THE WORKLOAD IS REAL CANDIDATE CPU WORK. No `setTimeout`, no sleep, no
 * unrelated JavaScript busy-loop. Each candidate is given a legitimate
 * operation on a large enough mesh that it is provably still inside the WASM
 * call when terminate is issued — asserted, not assumed, via `stillRunning`
 * and the pending-operation count at the moment of termination.
 *
 * THE PAGE OWNS THE GEOMETRY. The worker receives a structured-clone COPY (the
 * harness posts without a transfer list on purpose). If the input were
 * transferred, terminating would destroy the only copy — which is precisely the
 * failure this gate has to rule out.
 */

const CASES = join(import.meta.dirname, '..', 'experiments', 'browser-harness', '.cases');

/** Long enough that termination lands mid-kernel with room to spare. */
const MINIMUM_WORKLOAD_MS = 700;
/** How long to let the kernel run before terminating. */
const RUN_BEFORE_TERMINATE_MS = 200;
/** Quiet window used to observe that nothing more arrives from a dead worker. */
const QUIET_MS = 1200;

interface CancellationRow {
  candidateId: string;
  workload: string;
  workloadTriangles: number;
  calibratedKernelMs: number | null;
  workerCreateMs: number | null;
  glueImportMs: number | null;
  wasmInstantiateMs: number | null;
  initTotalMs: number | null;
  operationStartLatencyMs: number | null;
  stillRunningAtTerminate: boolean;
  pendingAtTerminate: number | null;
  terminateCallMs: number | null;
  observedQuietMs: number | null;
  lateMessages: number | null;
  mainThreadResponsiveMs: number | null;
  sourceDigestBefore: string | null;
  sourceDigestAfter: string | null;
  sourceIntact: boolean;
  restartInitMs: number | null;
  recoveryKernelMs: number | null;
  recoveryOutputTriangles: number | null;
  verdict: string;
  note: string | null;
}

interface WorkerCostRow {
  candidateId: string;
  mode: 'persistent' | 'disposable';
  operations: number;
  totalMs: number;
  perOperationMs: number;
  initMsTotal: number;
  kernelMsTotal: number;
}

const cancellation: CancellationRow[] = [];
const workerCost: WorkerCostRow[] = [];
const staleTests: Record<string, unknown>[] = [];

test.describe.configure({ mode: 'serial' });

/**
 * Workloads, one per candidate, each inside that candidate's ROLE.
 *
 * Sizes are chosen to exceed `MINIMUM_WORKLOAD_MS` and are calibrated at run
 * time rather than hard-coded, because "long enough" is a property of this
 * machine, not of the code.
 */
const WORKLOADS = {
  manifold: {
    description: 'boolean union of two large tessellated spheres',
    sizes: [
      { segments: 200, rings: 100 },
      { segments: 320, rings: 160 },
      { segments: 460, rings: 230 },
    ],
  },
  geogram: {
    description: 'intersection resolution on two interpenetrating spheres',
    sizes: [
      { segments: 60, rings: 30 },
      { segments: 110, rings: 55 },
      { segments: 170, rings: 85 },
    ],
  },
  pmp: {
    description: 'hole fill on a sphere with a large boundary loop',
    sizes: [
      { segments: 220, rings: 110 },
      { segments: 420, rings: 210 },
      { segments: 700, rings: 350 },
    ],
  },
} as const;

function buildWorkload(
  candidateId: string,
  size: { segments: number; rings: number },
):
  | { kind: 'boolean'; a: GeneratedMesh; b: GeneratedMesh; triangles: number }
  | {
      kind: 'operation';
      operation: string;
      parameter: number;
      mesh: GeneratedMesh;
      triangles: number;
    } {
  if (candidateId === 'manifold') {
    const a = uvSphere(size.segments, size.rings, 1, [0, 0, 0]);
    const b = uvSphere(size.segments, size.rings, 1, [0.7, 0, 0]);
    return { kind: 'boolean' as const, a, b, triangles: a.triangles.length / 3 };
  }
  if (candidateId === 'geogram') {
    // Two interpenetrating spheres as ONE soup: a genuine self-intersection
    // resolution problem, which is what `intersectSurface` is for.
    const a = uvSphere(size.segments, size.rings, 1, [0, 0, 0]);
    const b = uvSphere(size.segments, size.rings, 1, [0.7, 0, 0]);
    const positions = new Float64Array(a.positions.length + b.positions.length);
    positions.set(a.positions, 0);
    positions.set(b.positions, a.positions.length);
    const offset = a.positions.length / 3;
    const triangles = new Uint32Array(a.triangles.length + b.triangles.length);
    triangles.set(a.triangles, 0);
    for (let i = 0; i < b.triangles.length; i += 1) {
      triangles[a.triangles.length + i] = (b.triangles[i] ?? 0) + offset;
    }
    return {
      kind: 'operation' as const,
      operation: 'intersectSurface',
      parameter: 0,
      mesh: { positions, triangles },
      triangles: triangles.length / 3,
    };
  }
  const mesh = openedSphere(size.segments, size.rings, 1);
  return {
    kind: 'operation' as const,
    operation: 'fillHoles',
    parameter: 0,
    mesh,
    triangles: mesh.triangles.length / 3,
  };
}

test('terminating a candidate worker cancels real WASM work and recovers cleanly', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.goto('/');

  for (const candidateId of ['manifold', 'geogram', 'pmp'] as const) {
    const workload = WORKLOADS[candidateId];

    /* ------------------------------------------------- calibrate the size -- */

    let chosen: ReturnType<typeof buildWorkload> | null = null;
    let calibratedMs: number | null = null;

    for (const size of workload.sizes) {
      const candidate = buildWorkload(candidateId, size);
      const session = await page.evaluate((id) => window.cfHarness.open(id), candidateId);
      expect(session.ok, `${candidateId} init`).toBe(true);

      const measured = await page.evaluate(
        ([sessionId, payload]) => {
          const job = payload as Record<string, unknown>;
          const request =
            job.kind === 'boolean'
              ? {
                  type: 'boolean',
                  opType: 0,
                  a: {
                    positions: new Float64Array(Object.values(job.aPositions as number[])),
                    triangles: new Uint32Array(Object.values(job.aTriangles as number[])),
                  },
                  b: {
                    positions: new Float64Array(Object.values(job.bPositions as number[])),
                    triangles: new Uint32Array(Object.values(job.bTriangles as number[])),
                  },
                }
              : {
                  type: 'operation',
                  operation: job.operation as string,
                  parameter: job.parameter as number,
                  positions: new Float64Array(Object.values(job.positions as number[])),
                  triangles: new Uint32Array(Object.values(job.triangles as number[])),
                };
          return window.cfHarness.run(sessionId, request, { returnGeometry: false });
        },
        [
          session.sessionId,
          candidate.kind === 'boolean'
            ? {
                kind: 'boolean',
                aPositions: Array.from(candidate.a.positions),
                aTriangles: Array.from(candidate.a.triangles),
                bPositions: Array.from(candidate.b.positions),
                bTriangles: Array.from(candidate.b.triangles),
              }
            : {
                kind: 'operation',
                operation: candidate.operation,
                parameter: candidate.parameter,
                positions: Array.from(candidate.mesh.positions),
                triangles: Array.from(candidate.mesh.triangles),
              },
        ] as const,
      );
      await page.evaluate((s) => window.cfHarness.close(s), session.sessionId);

      const kernelMs = typeof measured.kernelMs === 'number' ? measured.kernelMs : 0;
      chosen = candidate;
      calibratedMs = kernelMs;
      if (measured.ok === true && kernelMs >= MINIMUM_WORKLOAD_MS) break;
    }

    if (chosen === null || calibratedMs === null) {
      cancellation.push({
        candidateId,
        workload: workload.description,
        workloadTriangles: 0,
        calibratedKernelMs: null,
        workerCreateMs: null,
        glueImportMs: null,
        wasmInstantiateMs: null,
        initTotalMs: null,
        operationStartLatencyMs: null,
        stillRunningAtTerminate: false,
        pendingAtTerminate: null,
        terminateCallMs: null,
        observedQuietMs: null,
        lateMessages: null,
        mainThreadResponsiveMs: null,
        sourceDigestBefore: null,
        sourceDigestAfter: null,
        sourceIntact: false,
        restartInitMs: null,
        recoveryKernelMs: null,
        recoveryOutputTriangles: null,
        verdict: 'NO_WORKLOAD',
        note: 'no size produced a measurable operation',
      });
      continue;
    }

    /* --------------------------------------- authoritative geometry, page -- */

    const authoritative =
      chosen.kind === 'boolean'
        ? { positions: Array.from(chosen.a.positions), triangles: Array.from(chosen.a.triangles) }
        : {
            positions: Array.from(chosen.mesh.positions),
            triangles: Array.from(chosen.mesh.triangles),
          };

    const before = await page.evaluate(
      (mesh) =>
        window.cfHarness.setAuthoritative(
          (mesh as { positions: number[] }).positions,
          (mesh as { triangles: number[] }).triangles,
        ),
      authoritative,
    );

    /* ------------------------------------------------ run, then terminate -- */

    const session = await page.evaluate((id) => window.cfHarness.open(id), candidateId);
    expect(session.ok).toBe(true);

    const begin = await page.evaluate(
      ([sessionId, job]) => {
        const payload = job as Record<string, unknown>;
        const request =
          payload.kind === 'boolean'
            ? {
                type: 'boolean',
                opType: 0,
                a: {
                  positions: new Float64Array(Object.values(payload.aPositions as number[])),
                  triangles: new Uint32Array(Object.values(payload.aTriangles as number[])),
                },
                b: {
                  positions: new Float64Array(Object.values(payload.bPositions as number[])),
                  triangles: new Uint32Array(Object.values(payload.bTriangles as number[])),
                },
              }
            : {
                type: 'operation',
                operation: payload.operation as string,
                parameter: payload.parameter as number,
                positions: new Float64Array(Object.values(payload.positions as number[])),
                triangles: new Uint32Array(Object.values(payload.triangles as number[])),
              };
        return window.cfHarness.beginLongOperation(sessionId, request);
      },
      [
        session.sessionId,
        chosen.kind === 'boolean'
          ? {
              kind: 'boolean',
              aPositions: Array.from(chosen.a.positions),
              aTriangles: Array.from(chosen.a.triangles),
              bPositions: Array.from(chosen.b.positions),
              bTriangles: Array.from(chosen.b.triangles),
            }
          : {
              kind: 'operation',
              operation: chosen.operation,
              parameter: chosen.parameter,
              positions: Array.from(chosen.mesh.positions),
              triangles: Array.from(chosen.mesh.triangles),
            },
      ] as const,
    );
    expect(begin.ok, `${candidateId} operation must start`).toBe(true);

    await page.waitForTimeout(RUN_BEFORE_TERMINATE_MS);

    // The page thread must be usable while the kernel runs — this is what makes
    // an off-thread kernel worth the copying cost in the first place.
    const responsiveMs = await page.evaluate(() => window.cfHarness.mainThreadResponsive());

    const stillRunning = await page.evaluate(
      (s) => window.cfHarness.stillRunning(s),
      session.sessionId,
    );
    const terminated = await page.evaluate((s) => window.cfHarness.terminate(s), session.sessionId);
    const observed = await page.evaluate(
      ([s, quiet]) => window.cfHarness.observeTermination(s, quiet as number),
      [session.sessionId, QUIET_MS] as const,
    );

    const after = await page.evaluate(() => window.cfHarness.authoritativeDigest());

    /* -------------------------------------------------------- recover ----- */

    const restart = await page.evaluate((id) => window.cfHarness.open(id), candidateId);
    const recovery = await page.evaluate(
      ([sessionId, id]) => {
        // A small, unambiguously valid operation: a unit tetrahedron ingest for
        // Manifold and PMP, an exact topology repair for Geogram.
        const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const triangles = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
        const operation = id === 'geogram' ? 'repairTopology' : 'ingest';
        return window.cfHarness.run(sessionId, {
          type: 'operation',
          operation,
          parameter: 0,
          positions,
          triangles,
        });
      },
      [restart.sessionId, candidateId] as const,
    );
    await page.evaluate((s) => window.cfHarness.close(s), restart.sessionId);

    const sourceIntact =
      before !== null &&
      after !== null &&
      before.positions === after.positions &&
      before.triangles === after.triangles &&
      !after.detached;

    const verdict =
      stillRunning &&
      terminated.ok &&
      observed.lateMessages === 0 &&
      sourceIntact &&
      restart.ok &&
      recovery.ok === true
        ? 'PASS'
        : 'FAIL';

    cancellation.push({
      candidateId,
      workload: workload.description,
      workloadTriangles: chosen.triangles,
      calibratedKernelMs: calibratedMs,
      workerCreateMs: session.workerCreateMs ?? null,
      glueImportMs: session.glueImportMs ?? null,
      wasmInstantiateMs: session.wasmInstantiateMs ?? null,
      initTotalMs: session.initTotalMs ?? null,
      operationStartLatencyMs: begin.startedAtMs ?? null,
      stillRunningAtTerminate: stillRunning,
      pendingAtTerminate: terminated.pendingAtTerminate ?? null,
      terminateCallMs: terminated.terminateCallMs ?? null,
      observedQuietMs: observed.observedMs,
      lateMessages: observed.lateMessages,
      mainThreadResponsiveMs: responsiveMs,
      sourceDigestBefore: before === null ? null : `${before.positions}/${before.triangles}`,
      sourceDigestAfter: after === null ? null : `${after.positions}/${after.triangles}`,
      sourceIntact,
      restartInitMs: restart.initTotalMs ?? null,
      recoveryKernelMs: typeof recovery.kernelMs === 'number' ? recovery.kernelMs : null,
      recoveryOutputTriangles:
        typeof recovery.outputTriangles === 'number' ? recovery.outputTriangles : null,
      verdict,
      note: null,
    });
  }

  writeFileSync(join(CASES, 'cancellation-raw.json'), JSON.stringify({ cancellation }));

  for (const row of cancellation) {
    expect(
      row.stillRunningAtTerminate,
      `${row.candidateId} must still be computing at terminate`,
    ).toBe(true);
    expect(row.sourceIntact, `${row.candidateId} authoritative geometry must survive`).toBe(true);
    expect(row.lateMessages, `${row.candidateId} must publish nothing after terminate`).toBe(0);
    expect(row.verdict, `${row.candidateId} cancellation gate`).toBe('PASS');
  }
});

test('a terminated worker cannot publish a stale result into its replacement', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');

  /*
   * THE SPECIFIC FABRICATION RISK. A worker terminated mid-flight can have a
   * queued message delivered after its replacement exists. If the page matched
   * replies by order, or by "most recent", the dead worker's output could be
   * attributed to a live operation — a result that looks entirely plausible and
   * is completely wrong. The harness matches on (sessionId, opId) and drops
   * anything else; this test proves the drop happens.
   */
  const mesh = uvSphere(320, 160, 1, [0, 0, 0]);
  const other = uvSphere(320, 160, 1, [0.7, 0, 0]);

  const first = await page.evaluate(() => window.cfHarness.open('manifold'));
  expect(first.ok).toBe(true);

  await page.evaluate(
    ([sessionId, a, b]) =>
      window.cfHarness.beginLongOperation(sessionId, {
        type: 'boolean',
        opType: 0,
        a: {
          positions: new Float64Array(Object.values((a as { p: number[] }).p)),
          triangles: new Uint32Array(Object.values((a as { t: number[] }).t)),
        },
        b: {
          positions: new Float64Array(Object.values((b as { p: number[] }).p)),
          triangles: new Uint32Array(Object.values((b as { t: number[] }).t)),
        },
      }),
    [
      first.sessionId,
      { p: Array.from(mesh.positions), t: Array.from(mesh.triangles) },
      { p: Array.from(other.positions), t: Array.from(other.triangles) },
    ] as const,
  );

  await page.waitForTimeout(120);
  const terminated = await page.evaluate((s) => window.cfHarness.terminate(s), first.sessionId);
  expect(terminated.ok).toBe(true);
  expect(terminated.pendingAtTerminate, 'an operation was in flight').toBeGreaterThan(0);

  // Replacement worker, new session id, small operation.
  const second = await page.evaluate(() => window.cfHarness.open('manifold'));
  expect(second.ok).toBe(true);
  expect(second.sessionId).not.toBe(first.sessionId);

  const replacement = await page.evaluate((sessionId) => {
    const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const triangles = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    return window.cfHarness.run(sessionId, {
      type: 'operation',
      operation: 'ingest',
      positions,
      triangles,
    });
  }, second.sessionId);

  expect(replacement.ok).toBe(true);
  // A tetrahedron, not the sphere boolean the dead worker was computing.
  expect(replacement.outputTriangles, 'replacement returned its OWN result').toBe(4);

  await page.waitForTimeout(1500);
  const stale = await page.evaluate(() => window.cfHarness.staleMessages());
  staleTests.push({
    terminatedSession: first.sessionId,
    replacementSession: second.sessionId,
    replacementOutputTriangles: replacement.outputTriangles,
    staleMessagesObserved: stale.length,
    staleDetail: stale,
  });

  // Every stale message must be attributed to the dead session, never delivered.
  for (const entry of stale) {
    expect(entry.sessionId, 'stale message came from the terminated session').toBe(first.sessionId);
  }

  await page.evaluate((s) => window.cfHarness.close(s), second.sessionId);
});

test('persistent versus disposable worker cost', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');

  /*
   * ARCHITECTURAL EVIDENCE, NOT AN ASSUMPTION. The disposable-per-operation
   * model gives the strongest cancellation and crash isolation, and the received
   * wisdom is that it is too expensive. That is measurable, so it is measured:
   * the same five operations run against one long-lived worker and against a
   * fresh worker per operation.
   */
  const positions = new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
  const triangles = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  const OPERATIONS = 5;

  for (const candidateId of ['manifold', 'geogram', 'pmp'] as const) {
    const operation = candidateId === 'geogram' ? 'repairTopology' : 'ingest';

    const persistent = await page.evaluate(
      async ([id, op, count]) => {
        const startedAt = performance.now();
        const session = await window.cfHarness.open(id);
        const initMs = session.initTotalMs ?? 0;
        let kernelMs = 0;
        const p = new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
        const t = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
        for (let i = 0; i < count; i += 1) {
          const result = await window.cfHarness.run(session.sessionId, {
            type: 'operation',
            operation: op,
            parameter: 0,
            positions: p,
            triangles: t,
          });
          kernelMs += typeof result.kernelMs === 'number' ? result.kernelMs : 0;
        }
        window.cfHarness.close(session.sessionId);
        return { totalMs: performance.now() - startedAt, initMs, kernelMs };
      },
      [candidateId, operation, OPERATIONS] as const,
    );

    const disposable = await page.evaluate(
      async ([id, op, count]) => {
        const startedAt = performance.now();
        let initMs = 0;
        let kernelMs = 0;
        const p = new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
        const t = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
        for (let i = 0; i < count; i += 1) {
          const session = await window.cfHarness.open(id);
          initMs += session.initTotalMs ?? 0;
          const result = await window.cfHarness.run(session.sessionId, {
            type: 'operation',
            operation: op,
            parameter: 0,
            positions: p,
            triangles: t,
          });
          kernelMs += typeof result.kernelMs === 'number' ? result.kernelMs : 0;
          window.cfHarness.close(session.sessionId);
        }
        return { totalMs: performance.now() - startedAt, initMs, kernelMs };
      },
      [candidateId, operation, OPERATIONS] as const,
    );

    workerCost.push({
      candidateId,
      mode: 'persistent',
      operations: OPERATIONS,
      totalMs: persistent.totalMs,
      perOperationMs: persistent.totalMs / OPERATIONS,
      initMsTotal: persistent.initMs,
      kernelMsTotal: persistent.kernelMs,
    });
    workerCost.push({
      candidateId,
      mode: 'disposable',
      operations: OPERATIONS,
      totalMs: disposable.totalMs,
      perOperationMs: disposable.totalMs / OPERATIONS,
      initMsTotal: disposable.initMs,
      kernelMsTotal: disposable.kernelMs,
    });
  }

  void positions;
  void triangles;

  writeFileSync(
    join(CASES, 'worker-cost-raw.json'),
    JSON.stringify({ workerCost, staleTests, cancellation }),
  );
});
