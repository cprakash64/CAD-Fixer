import { expect, test, type Page } from '@playwright/test';
import { digest, Fixture, loadFixture, openHarness, readState } from './harness';

/**
 * THE HOLE-FILL ENGINE, IN REAL CHROMIUM.
 *
 * WHY IT IS HERE AND NOT IN `e2e/`. Stage 4B-1B1 ships the ENGINE and
 * deliberately no user-facing control — selection, patch preview and Apply are
 * Stage 4B-1B2 — so there is nothing in the shipped interface for a product
 * suite to click. The harness drives the PRODUCTION service, which builds the
 * PRODUCTION disposable worker, which loads the PRODUCTION kernel; the only
 * thing the harness supplies is a document no shipped importer can produce and
 * a way to start the operation.
 *
 * WHAT ONLY A BROWSER CAN SHOW. The Node suites prove the verdicts; they cannot
 * prove that the work is off the main thread, that a real Worker is created and
 * terminated, that `terminate()` actually interrupts a running fill, or that
 * the WebAssembly kernel instantiates in a module worker at all.
 *
 * SERIAL, in the harness project, which runs one worker with no parallelism. A
 * main-thread gap measured while three other Chromium instances compete for
 * cores is a measurement of the machine.
 */

interface GapSample {
  readonly worstGapMs: number;
  readonly frames: number;
}

interface BoundaryLoopSummary {
  readonly boundaryLoopId: string;
  readonly vertexCount: number;
  readonly edgeCount: number;
  readonly fillable: boolean;
  readonly refusal?: string;
}

interface HoleFillResult {
  readonly status: string;
  readonly message?: string;
  readonly candidateId?: string;
  readonly candidatePartId?: string;
  readonly candidateRevision?: number;
  readonly candidateLoopId?: string;
  readonly summary?: Record<string, number | boolean | Record<string, number>>;
  readonly durationMs: number;
  readonly cancelLatencyMs?: number;
  readonly startedFaceCount?: number;
}

/** The frame-gap probe every Stage 3 and Stage 4 responsiveness proof uses. */
async function startProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gaps: number[] = [];
    let previous = performance.now();
    let running = true;

    const tick = (): void => {
      if (!running) return;
      const now = performance.now();
      gaps.push(now - previous);
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    Object.assign(globalThis, {
      __stopHoleFillProbe: (): GapSample => {
        running = false;
        return {
          worstGapMs: gaps.length === 0 ? 0 : Math.max(...gaps),
          frames: gaps.length,
        };
      },
    });
  });
}

async function stopProbe(page: Page): Promise<GapSample> {
  return page.evaluate(() =>
    (globalThis as unknown as { __stopHoleFillProbe: () => GapSample }).__stopHoleFillProbe(),
  );
}

async function listLoops(page: Page, partId: string): Promise<readonly BoundaryLoopSummary[]> {
  const state = await readState(page);
  const result = await page.evaluate(
    async (input) => {
      const bridge = window.cadfixerHarness;
      if (bridge === undefined) throw new Error('the harness bridge is not installed');
      return bridge.listBoundaryLoops(input.documentId, input.revision, input.partId);
    },
    { documentId: state.documentId ?? '', revision: state.revision ?? 0, partId },
  );
  return result.loops;
}

async function beginFill(
  page: Page,
  partId: string,
  boundaryLoopId: string,
  options: { readonly cancelAfterMs?: number } = {},
): Promise<void> {
  const state = await readState(page);
  await page.evaluate(
    (input) => {
      const bridge = window.cadfixerHarness;
      if (bridge === undefined) throw new Error('the harness bridge is not installed');
      bridge.beginHoleFill(input.documentId, input.revision, input.partId, input.loopId, {
        ...(input.cancelAfterMs === null ? {} : { cancelAfterMs: input.cancelAfterMs }),
      });
    },
    {
      documentId: state.documentId ?? '',
      revision: state.revision ?? 0,
      partId,
      loopId: boundaryLoopId,
      cancelAfterMs: options.cancelAfterMs ?? null,
    },
  );
}

async function awaitFill(page: Page): Promise<HoleFillResult> {
  return page.evaluate(async (): Promise<HoleFillResult> => {
    const bridge = window.cadfixerHarness;
    if (bridge === undefined) throw new Error('the harness bridge is not installed');
    return bridge.awaitHoleFill();
  });
}

async function liveResources(page: Page): Promise<{
  workers: number;
  channels: number;
  operation: string | undefined;
}> {
  return page.evaluate(() => ({
    workers: window.cadfixerHarness?.holeFillLiveWorkers() ?? -1,
    channels: window.cadfixerHarness?.holeFillLiveChannels() ?? -1,
    operation: window.cadfixerHarness?.holeFillActiveOperation(),
  }));
}

function summaryNumber(result: HoleFillResult, field: string): number {
  const value = result.summary?.[field];
  return typeof value === 'number' ? value : Number.NaN;
}

/* ------------------------------------------------------------- verdicts -- */

test('a planar hole is filled and independently validated in the browser', async ({ page }) => {
  test.setTimeout(180_000);
  await openHarness(page);
  const state = await loadFixture(page, Fixture.HoleFillSmall);
  const part = state.partIds[0] ?? '';

  const loops = await listLoops(page, part);
  // An open tube has two rims, both fillable.
  expect(loops).toHaveLength(2);
  for (const loop of loops) {
    expect(loop.fillable).toBe(true);
    expect(loop.vertexCount).toBe(4);
  }

  await beginFill(page, part, loops[0]?.boundaryLoopId ?? '');
  const result = await awaitFill(page);

  expect(result.status).toBe('VALID_CANDIDATE');
  expect(result.candidateId).toBeDefined();
  expect(result.candidatePartId).toBe(part);
  expect(result.candidateRevision).toBe(state.revision);
  expect(result.candidateLoopId).toBe(loops[0]?.boundaryLoopId);

  // The validators ran in the browser, against the real kernel.
  expect(summaryNumber(result, 'patchFaceCount')).toBe(2);
  expect(summaryNumber(result, 'addedVertexCount')).toBe(0);
  expect(summaryNumber(result, 'invalidPatchSourcePairs')).toBe(0);
  expect(summaryNumber(result, 'invalidPatchPatchPairs')).toBe(0);
  expect(summaryNumber(result, 'narrowphaseChecks')).toBeGreaterThan(0);
  expect(result.summary?.eulerPassed).toBe(true);
});

test('THE HARD GATE holds in the browser: a patch that pierces a wall is rejected', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openHarness(page);
  const state = await loadFixture(page, Fixture.HoleFillPierced);
  const part = state.partIds[0] ?? '';

  const loops = await listLoops(page, part);
  const fillable = loops.filter((loop) => loop.fillable);
  expect(fillable.length).toBeGreaterThan(0);

  // The rim at the top of the tube is the one whose patch crosses the shell.
  let rejected: HoleFillResult | undefined;
  for (const loop of fillable) {
    await beginFill(page, part, loop.boundaryLoopId);
    const attempt = await awaitFill(page);
    if (attempt.status === 'SELF_INTERSECTION_CREATED') rejected = attempt;
  }

  expect(rejected, 'one of the two rims must be refused as self-intersecting').toBeDefined();
  if (rejected === undefined) return;

  expect(rejected.candidateId).toBeUndefined();
  expect(summaryNumber(rejected, 'invalidPatchSourcePairs')).toBeGreaterThan(0);
  // And it passed everything else, which is why the gate has to exist.
  expect(rejected.summary?.selectedLoopRemoved).toBe(true);
  expect(rejected.summary?.eulerPassed).toBe(true);
  expect(summaryNumber(rejected, 'agreeingBoundaryEdges')).toBe(0);
});

test('the authoritative document is untouched, byte for byte, by any outcome', async ({ page }) => {
  test.setTimeout(180_000);
  await openHarness(page);
  const state = await loadFixture(page, Fixture.HoleFillSmall);
  const part = state.partIds[0] ?? '';
  const before = await digest(page, state);

  const loops = await listLoops(page, part);
  await beginFill(page, part, loops[0]?.boundaryLoopId ?? '');
  expect((await awaitFill(page)).status).toBe('VALID_CANDIDATE');

  // A REFUSAL as well as a success, because both must be non-destructive.
  await beginFill(page, part, 'bl-0-0-0000000000000000');
  expect((await awaitFill(page)).status).toBe('UNKNOWN_LOOP');

  const after = await digest(page, { ...state });
  expect(after).toEqual(before);

  // The revision did not move either: Stage 4B-1B1 produces candidates only.
  expect((await readState(page)).revision).toBe(state.revision);
});

/* ------------------------------------------------------- responsiveness -- */

test('§61: a large in-policy fill does not block the UI thread', async ({ page }) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const state = await loadFixture(page, Fixture.HoleFillLarge);
  const part = state.partIds[0] ?? '';

  const loops = await listLoops(page, part);
  const target = loops.find((loop) => loop.fillable && loop.vertexCount === 512);
  expect(target, 'the large fixture must expose a 512-vertex fillable rim').toBeDefined();
  if (target === undefined) return;

  // The idle gap on THIS machine sets the bar, so the assertion is about the
  // work rather than about the hardware.
  await startProbe(page);
  await page.waitForTimeout(1_500);
  const idle = await stopProbe(page);

  await startProbe(page);
  await beginFill(page, part, target.boundaryLoopId);
  const result = await awaitFill(page);
  const busy = await stopProbe(page);

  expect(result.status).toBe('VALID_CANDIDATE');
  expect(summaryNumber(result, 'patchFaceCount')).toBe(510);
  // The window sampled something: a fill that finished instantly would have no
  // period in which to be unresponsive.
  expect(result.durationMs).toBeGreaterThan(100);
  expect(busy.frames).toBeGreaterThan(10);

  /*
   * THE LINE BETWEEN BUSY AND FROZEN. A whole-part triangulation and an exact
   * narrowphase on the UI thread would grow the gap by orders of magnitude, not
   * by a factor of a few. The absolute bound is stated separately so the test
   * cannot pass merely because the idle baseline happened to be poor.
   */
  const ceiling = Math.max(idle.worstGapMs * 10, 250);
  expect(
    busy.worstGapMs,
    `longest main-thread gap during a ${result.durationMs.toFixed(0)}ms fill: ` +
      `${busy.worstGapMs.toFixed(0)}ms against idle ${idle.worstGapMs.toFixed(0)}ms`,
  ).toBeLessThan(ceiling);
  expect(busy.worstGapMs).toBeLessThan(1_000);
});

test('§61: the interface stays interactive while a fill runs', async ({ page }) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const state = await loadFixture(page, Fixture.HoleFillLarge);
  const part = state.partIds[0] ?? '';
  const loops = await listLoops(page, part);
  const target = loops.find((loop) => loop.fillable && loop.vertexCount === 512);
  if (target === undefined) throw new Error('missing the large rim');

  await beginFill(page, part, target.boundaryLoopId);

  // A REAL interaction with a production control, not a synthetic event.
  const startedAt = Date.now();
  await page.getByTestId('harness-bar').click();
  const interactionMs = Date.now() - startedAt;

  const result = await awaitFill(page);
  expect(result.status).toBe('VALID_CANDIDATE');
  expect(
    interactionMs,
    `interaction took ${String(interactionMs)}ms during a ${result.durationMs.toFixed(0)}ms fill`,
  ).toBeLessThan(result.durationMs);
});

/* ------------------------------------------------------------ lifecycle -- */

test('§62: cancellation terminates the worker and leaves nothing behind', async ({ page }) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const state = await loadFixture(page, Fixture.HoleFillLarge);
  const part = state.partIds[0] ?? '';
  const before = await digest(page, state);

  const loops = await listLoops(page, part);
  const target = loops.find((loop) => loop.fillable && loop.vertexCount === 512);
  if (target === undefined) throw new Error('missing the large rim');

  expect(await liveResources(page)).toMatchObject({ workers: 0, channels: 0 });

  await beginFill(page, part, target.boundaryLoopId, { cancelAfterMs: 60 });
  const during = await liveResources(page);
  expect(during.workers).toBe(1);
  expect(during.channels).toBe(1);
  expect(during.operation).toBeDefined();

  const result = await awaitFill(page);
  expect(result.status).toBe('HoleFillCancelled');
  expect(result.candidateId).toBeUndefined();

  /*
   * CANCELLATION LATENCY, reported rather than asserted tightly. `terminate()`
   * stops the thread; what is being measured is the round trip back to the
   * page, and a tight bound on that would be a bound on the event loop.
   */
  expect(result.cancelLatencyMs).toBeDefined();
  expect(result.cancelLatencyMs ?? Infinity).toBeLessThan(2_000);

  // Everything the operation owned is released, not merely forgotten.
  expect(await liveResources(page)).toMatchObject({
    workers: 0,
    channels: 0,
    operation: undefined,
  });

  // And the model is exactly where it was.
  expect(await digest(page, state)).toEqual(before);
});

test('§62: a full lifecycle leaks no worker and no channel', async ({ page }) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const state = await loadFixture(page, Fixture.HoleFillSmall);
  const part = state.partIds[0] ?? '';
  const loops = await listLoops(page, part);
  const fillable = loops[0]?.boundaryLoopId ?? '';

  const run = async (loopId: string, expected: string): Promise<void> => {
    expect(await liveResources(page)).toMatchObject({ workers: 0, channels: 0 });
    await beginFill(page, part, loopId);
    const result = await awaitFill(page);
    expect(result.status).toBe(expected);
    expect(await liveResources(page)).toMatchObject({
      workers: 0,
      channels: 0,
      operation: undefined,
    });
  };

  // success → success → refusal → success. One worker per operation, and none
  // of them survives its operation.
  await run(fillable, 'VALID_CANDIDATE');
  await run(fillable, 'VALID_CANDIDATE');
  await run('bl-0-0-0000000000000000', 'UNKNOWN_LOOP');
  await run(fillable, 'VALID_CANDIDATE');
});

test('§62: cancelling and retrying works, on a fresh worker', async ({ page }) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const state = await loadFixture(page, Fixture.HoleFillLarge);
  const part = state.partIds[0] ?? '';
  const loops = await listLoops(page, part);
  const target = loops.find((loop) => loop.fillable && loop.vertexCount === 512);
  if (target === undefined) throw new Error('missing the large rim');

  await beginFill(page, part, target.boundaryLoopId, { cancelAfterMs: 40 });
  expect((await awaitFill(page)).status).toBe('HoleFillCancelled');
  expect(await liveResources(page)).toMatchObject({ workers: 0, channels: 0 });

  await beginFill(page, part, target.boundaryLoopId);
  const retried = await awaitFill(page);
  expect(retried.status).toBe('VALID_CANDIDATE');
  expect(retried.candidateId).toBeDefined();
  expect(await liveResources(page)).toMatchObject({ workers: 0, channels: 0 });
});
