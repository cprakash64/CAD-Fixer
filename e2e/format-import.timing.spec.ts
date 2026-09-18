import { expect, test, type Page } from '@playwright/test';
import { ThreeMfImportPhase } from '@cadfixer/file-formats';
import { objLarge, threeMfLarge, threeMfProductionLarge, toZip64 } from './format-fixtures';

/**
 * OBJ-P17/P18 AND MF-P22/P23 — cancellation and responsiveness on large files.
 *
 * SERIAL, in the timing project, for the reason that project exists: a
 * main-thread gap and a cancellation ratio measured while three other Chromium
 * instances compete for cores describe the machine rather than the application.
 *
 * WHAT MAKES THESE DIFFERENT FROM THE STL EQUIVALENTS. An STL parse is a walk
 * over a fixed-stride binary buffer; an OBJ parse is a character scan with
 * per-face vertex remapping, and a 3MF parse inflates an archive and then scans
 * XML. Those are three different shapes of loop, and each has to yield on its
 * own. A proof about the STL loop says nothing about the other two.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
}

interface FrameMeasurement {
  readonly frames: number;
  readonly longestGapMs: number;
  readonly durationMs: number;
}

/**
 * Starts a frame loop that stops when the imported triangle count appears.
 *
 * A frame loop is the honest instrument: if the main thread is blocked, frames
 * do not fire and the gap IS the block. Nothing about the measurement depends
 * on what the worker is doing.
 *
 * CALL THIS AFTER THE FILE HAS BEEN HANDED TO THE PAGE. Playwright materialising
 * a sixteen-megabyte `File` is its own multi-second main-thread stall inside the
 * page, and an earlier version of OBJ-P18 measured across it and reported a
 * 1,033 ms gap that belonged entirely to the test harness. The same reasoning
 * is recorded on the STL equivalent in `stl-import.spec.ts`.
 */
async function startFrameLoop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gaps: number[] = [];
    let previous = performance.now();
    const startedAt = previous;
    let running = true;
    let finishedAt: number | undefined;

    const tick = (): void => {
      if (!running) return;
      const now = performance.now();
      if (finishedAt === undefined) gaps.push(now - previous);
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const observer = new MutationObserver(() => {
      if (finishedAt !== undefined) return;
      if (document.querySelector('[data-testid="fact-triangles"]') !== null) {
        finishedAt = performance.now();
        observer.disconnect();
      }
    });
    // Checked once immediately as well: an import that finished before this
    // installed would otherwise never close the window, and the measurement
    // would silently run past the thing it is measuring.
    if (document.querySelector('[data-testid="fact-triangles"]') !== null) {
      finishedAt = performance.now();
    } else {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    Object.assign(globalThis, {
      __stopFrames: (): { frames: number; longestGapMs: number; durationMs: number } => {
        running = false;
        observer.disconnect();
        return {
          frames: gaps.length,
          longestGapMs: gaps.length === 0 ? 0 : Math.max(...gaps),
          durationMs: (finishedAt ?? performance.now()) - startedAt,
        };
      },
    });
  });
}

async function stopFrameLoop(page: Page): Promise<FrameMeasurement> {
  return page.evaluate(() =>
    (globalThis as unknown as { __stopFrames: () => FrameMeasurement }).__stopFrames(),
  );
}

/**
 * Arms a `MutationObserver` that clicks Cancel the instant it appears.
 *
 * Playwright's own polling loses this race on a fast machine: the import can
 * finish between the control appearing and the click landing, and the test then
 * proves nothing while still passing.
 */
async function armCancel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const clickWhenPresent = (): boolean => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="cancel-import"]');
      if (button === null) return false;
      button.click();
      return true;
    };
    if (clickWhenPresent()) return;
    const observer = new MutationObserver(() => {
      if (clickWhenPresent()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/* --------------------------------------------------------------- OBJ-P18 -- */

test('OBJ-P18: a large OBJ import leaves the UI thread responsive', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');

  const model = objLarge(200_000);
  await openFile(page, 'large.obj', model.bytes);
  await startFrameLoop(page);

  await expect(page.getByTestId('fact-triangles')).toHaveText(model.triangles.toLocaleString(), {
    timeout: 240_000,
  });

  const measurement = await stopFrameLoop(page);
  expect(
    measurement.frames,
    `frames delivered during a ${(model.bytes.byteLength / 1024 / 1024).toFixed(1)} MiB OBJ import`,
  ).toBeGreaterThan(5);
  // A main-thread parse produces one gap on the order of the whole import.
  expect(
    measurement.longestGapMs,
    `longest gap ${measurement.longestGapMs.toFixed(0)}ms of ${measurement.durationMs.toFixed(0)}ms`,
  ).toBeLessThan(measurement.durationMs / 3);
});

/* --------------------------------------------------------------- OBJ-P17 -- */

test('OBJ-P17: a large OBJ import can be cancelled, and cancelling is faster', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/');

  const model = objLarge(200_000);

  // The uncancelled baseline, on the same page and the same bytes.
  const completeStart = Date.now();
  await openFile(page, 'baseline.obj', model.bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText(model.triangles.toLocaleString(), {
    timeout: 300_000,
  });
  const completeMs = Date.now() - completeStart;

  await armCancel(page);
  const cancelStart = Date.now();
  await openFile(page, 'cancelled.obj', model.bytes);
  await expect(page.getByTestId('status-list')).toContainText('cancelled', { timeout: 300_000 });
  const cancelMs = Date.now() - cancelStart;

  // THE PREVIOUS MODEL IS STILL THERE. A cancelled import is not a failed
  // replacement — it never began replacing anything.
  await expect(page.getByTestId('fact-filename')).toHaveText('baseline.obj');
  await expect(page.getByTestId('fact-triangles')).toHaveText(model.triangles.toLocaleString());

  /*
   * AND IT ACTUALLY STOPPED THE WORK. A cancel that merely hides the progress
   * bar and lets the parse run to completion would satisfy every assertion
   * above. The ratio is what distinguishes the two.
   */
  expect(
    cancelMs / completeMs,
    `cancelled in ${String(cancelMs)}ms against ${String(completeMs)}ms uncancelled`,
  ).toBeLessThan(0.8);
});

/* ---------------------------------------------------------------- MF-P23 -- */

test('MF-P23: a large 3MF import leaves the UI thread responsive', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');

  const triangles = 150_000;
  const bytes = threeMfLarge(triangles);
  await openFile(page, 'large.3mf', bytes);
  await startFrameLoop(page);

  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
    timeout: 240_000,
  });

  const measurement = await stopFrameLoop(page);
  // Inflation AND the XML scan are both inside this window, and both are loops
  // that had to be made to yield.
  expect(measurement.frames).toBeGreaterThan(5);
  expect(
    measurement.longestGapMs,
    `longest gap ${measurement.longestGapMs.toFixed(0)}ms of ${measurement.durationMs.toFixed(0)}ms`,
  ).toBeLessThan(measurement.durationMs / 3);
});

/* ---------------------------------------------------------------- MF-P27 -- */

test('MF-P27: a large Zip64 multi-model-part 3MF import leaves the UI thread responsive', async ({
  page,
}) => {
  /*
   * STAGE 6D-A4. MF-P23 measures one model part in a classic archive. The
   * packages Bambu Studio and OrcaSlicer write are Zip64 and, for multi-part
   * projects, production-extension packages whose geometry lives in CHILD
   * model parts — a different path through the reader: a Zip64 directory, the
   * root's relationships, then one child after another, each inflated,
   * decoded, scanned and materialised. The same bar applies to all of it.
   */
  test.setTimeout(300_000);
  await page.goto('/');

  const children = 6;
  const trianglesPerChild = 30_000;
  const bytes = toZip64(threeMfProductionLarge(children, trianglesPerChild));
  await openFile(page, 'large-zip64-production.3mf', bytes);
  await startFrameLoop(page);

  await expect(page.getByTestId('fact-triangles')).toHaveText(
    (children * trianglesPerChild).toLocaleString(),
    { timeout: 240_000 },
  );

  const measurement = await stopFrameLoop(page);
  expect(measurement.frames).toBeGreaterThan(5);
  expect(
    measurement.longestGapMs,
    `longest gap ${measurement.longestGapMs.toFixed(0)}ms of ${measurement.durationMs.toFixed(0)}ms`,
  ).toBeLessThan(measurement.durationMs / 3);
  // No multi-second block, stated absolutely as well as relatively.
  expect(measurement.longestGapMs).toBeLessThan(1_000);
});

/* ---------------------------------------------------------------- MF-P22 -- */

test('MF-P22: a large 3MF import can be cancelled, and cancelling is faster', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/');

  const triangles = 150_000;
  const bytes = threeMfLarge(triangles);

  const completeStart = Date.now();
  await openFile(page, 'baseline.3mf', bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
    timeout: 300_000,
  });
  const completeMs = Date.now() - completeStart;

  await armCancel(page);
  const cancelStart = Date.now();
  await openFile(page, 'cancelled.3mf', bytes);
  await expect(page.getByTestId('status-list')).toContainText('cancelled', { timeout: 300_000 });
  const cancelMs = Date.now() - cancelStart;

  await expect(page.getByTestId('fact-filename')).toHaveText('baseline.3mf');
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString());

  expect(
    cancelMs / completeMs,
    `cancelled in ${String(cancelMs)}ms against ${String(completeMs)}ms uncancelled`,
  ).toBeLessThan(0.8);
});

/* ---------------------------------------------------------------- MF-P24 -- */

/**
 * MF-P24 — CANCELLATION REQUESTED AFTER INFLATION HAS COMPLETED.
 *
 * THE TEST MF-P22 COULD NOT BE. MF-P22 arms Cancel before the import starts, so
 * the cancel lands during inflation — which is an awaited chunk loop, and was
 * always interruptible. Its ratio therefore stayed low however large the file
 * grew, and it passed throughout the period when cancelling a 3MF import after
 * inflation did nothing at all.
 *
 * What made it do nothing: `model/import` was not dispatched as an
 * interruptible operation, so the worker's cancellation token was backed only
 * by a `cancel` MESSAGE. Everything after inflation — decode, the XML safety
 * scan, the element scan, materialisation, expansion, the structural gates — is
 * one synchronous span, and a message cannot be delivered while it runs. Every
 * `throwIfCancelled` along that span was reading a flag that could not change.
 * Measured uninterruptible tail: about 4.0 s for a 250 MiB entry.
 *
 * THE PHASE IS ASSERTED, NOT ASSUMED. The proof is worthless unless the cancel
 * provably landed after inflation, so the page records which phase was on
 * screen at the moment it clicked, and the assertion is against
 * `ThreeMfImportPhase.Parsing` — the SYMBOL the reader emits, imported from the
 * reader rather than copied as a string, so the two cannot drift.
 * `ThreeMfImportPhase.Parsing` is reported after `readZipEntry` returns and
 * before the decode begins, which is exactly the boundary this test needs.
 */

/**
 * Arms a watcher that clicks Cancel the first time the import reports `phase`.
 *
 * ARMED BEFORE THE FILE IS HANDED TO THE PAGE, and that ordering is the whole
 * reason this is two functions instead of one. Playwright's `setFiles` does not
 * resolve until the page has taken the buffer, which for a hundred-megabyte
 * fixture is several seconds — long enough that an observer installed after it
 * can miss the entire import. `armCancel` is called before `openFile` for the
 * same reason.
 *
 * A `MutationObserver` rather than Playwright polling, for the reason recorded
 * on `armCancel`: Playwright's loop can lose the race on a fast machine, and a
 * test that silently misses its own window still passes.
 */
async function armCancelAtPhase(page: Page, phase: string): Promise<void> {
  await page.evaluate((target: string) => {
    // THE RAW PHASE, not the sentence rendered beside it. See the note on
    // `data-phase` in ImportDropZone.
    const phaseNow = (): string =>
      document.querySelector('[data-testid="import-progress"]')?.getAttribute('data-phase') ?? '';
    const cancelButton = (): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>('[data-testid="cancel-import"]');

    const state: { phaseAtCancel: string; cancelledAtMs: number; settledAtMs: number } = {
      phaseAtCancel: '',
      cancelledAtMs: 0,
      settledAtMs: 0,
    };
    const seen: string[] = [];

    const attempt = (): boolean => {
      const current = phaseNow();
      if (current !== '' && seen[seen.length - 1] !== current) seen.push(current);
      if (current !== target) return false;
      const button = cancelButton();
      if (button === null) return false;
      state.phaseAtCancel = current;
      state.cancelledAtMs = performance.now();
      button.click();
      return true;
    };

    /*
     * `attributes` IS REQUIRED HERE, and its absence is a silent failure rather
     * than a loud one. The phase lives in an ATTRIBUTE that React updates in
     * place, so a `childList`-only observer sees the progress block appear and
     * then never fires again — the watcher waits out its own timeout while the
     * phase it is looking for comes and goes.
     */
    const observer = new MutationObserver(() => {
      if (state.cancelledAtMs !== 0) {
        // Already cancelled: now watch for the session to settle.
        if (document.querySelector('[data-testid="import-progress"]') === null) {
          state.settledAtMs = performance.now();
          observer.disconnect();
        }
        return;
      }
      attempt();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-phase'],
    });

    Object.assign(globalThis, {
      __lateCancel: (): {
        phaseAtCancel: string;
        cancelledAtMs: number;
        settledAtMs: number;
        phasesSeen: string[];
      } => ({ ...state, phasesSeen: [...seen] }),
    });
  }, phase);
}

interface LateCancelReading {
  readonly phaseAtCancel: string;
  readonly cancelledAtMs: number;
  readonly settledAtMs: number;
  readonly phasesSeen: string[];
}

async function readLateCancel(page: Page): Promise<LateCancelReading> {
  return page.evaluate(() =>
    (globalThis as unknown as { __lateCancel: () => LateCancelReading }).__lateCancel(),
  );
}

test('MF-P24: a 3MF import cancelled AFTER inflation stops during parsing', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/');

  /*
   * BIG ENOUGH THAT PARSING IS THE LONG PHASE. At this size inflation is a few
   * hundred milliseconds and the element scan is seconds, so the window in
   * which the detail reads `parsing model` is wide, and a cancel that lands
   * inside it is unambiguously post-inflate.
   */
  /*
   * SIZE IS OVERRIDABLE FOR LOCAL QUALIFICATION, and the default is what CI
   * runs. 600,000 triangles is roughly 108 MiB of model XML — already past the
   * hundred-megabyte class, and large enough that the element scan runs for
   * well over a second, so the window in which the phase reads `parsing model`
   * is wide. The 128 MiB and 250 MiB measurements recorded in docs/design were
   * taken by raising this; they are not pinned here because a multi-minute
   * fixture in the default suite buys no additional proposition.
   */
  const triangles = Number(process.env.CADFIXER_MFP24_TRIANGLES ?? '600000');
  const bytes = threeMfLarge(triangles);

  await armCancelAtPhase(page, ThreeMfImportPhase.Parsing);
  await openFile(page, 'late-cancel.3mf', bytes);

  // The import must reach a terminal state; the watcher records when.
  await expect(page.getByTestId('import-progress')).toHaveCount(0, { timeout: 240_000 });
  const observed = await readLateCancel(page);

  // Printed BEFORE the assertions: a diagnostic that only appears when the
  // test passes is unavailable exactly when it is needed.
  const tailMs = observed.settledAtMs - observed.cancelledAtMs;
  process.stdout.write(
    `\n[MF-P24] phases=${observed.phasesSeen.join('|')} ` +
      `triangles=${String(triangles)} ` +
      `phaseAtCancel="${observed.phaseAtCancel}" postCancelTailMs=${tailMs.toFixed(0)}\n`,
  );

  /* 1. THE CANCEL LANDED AFTER INFLATION. Without this the rest proves nothing. */
  expect(observed.phaseAtCancel, `phases seen: ${observed.phasesSeen.join(' -> ')}`).toBe(
    ThreeMfImportPhase.Parsing,
  );
  // And inflation is a phase this import genuinely passed THROUGH, not skipped.
  expect(observed.phasesSeen).toContain(ThreeMfImportPhase.Decompressing);

  /* 2. IT WAS OBSERVED AS A CANCELLATION, not as a failure or a success. */
  await expect(page.getByTestId('status-list')).toContainText('cancelled');

  /* 3. NOTHING WAS COMMITTED. A cancelled import is not a partial import. */
  await expect(page.getByTestId('fact-triangles')).toHaveCount(0);

  /* 4. THE WORKER SURVIVED, which is the difference between cancelling an
   *    operation and killing the authoritative session. */
  await expect(page.getByTestId('session-lost')).toHaveCount(0);

  /* 5. AND IT IS STILL USABLE. */
  await openFile(page, 'after-cancel.3mf', threeMfLarge(64));
  await expect(page.getByTestId('fact-triangles')).toHaveText('64', { timeout: 120_000 });

  /*
   * A GENEROUS CEILING, DELIBERATELY. The functional assertions above are the
   * proof and they carry no wall clock at all; this exists only to fail if the
   * dispatch regresses to a message-backed token, which would put the tail back
   * into the multi-second range. Controlled measurements are recorded in
   * docs/design rather than pinned here.
   */
  expect(
    tailMs,
    `post-cancel tail ${tailMs.toFixed(0)}ms at phase "${observed.phaseAtCancel}"`,
  ).toBeLessThan(2_000);
});

/* ---------------------------------------------------------------- MF-P25 -- */

test('MF-P25: the page is cross-origin isolated, so import really gets a shared word', async ({
  page,
}) => {
  await page.goto('/');

  /*
   * THE PRECONDITION MF-P24 SILENTLY DEPENDS ON.
   *
   * `interruptible: true` is a REQUEST: the coordinator allocates a control
   * word only where `SharedArrayBuffer` and `Atomics` exist, and a
   * `SharedArrayBuffer` requires cross-origin isolation. A deployment that lost
   * its COOP/COEP headers would silently fall back to the message-backed token
   * — the exact defect Stage 6D-B2 fixed — and MF-P24 would then be the only
   * thing standing between that and a release. Asserting the environment
   * directly makes the regression legible instead of leaving it to be inferred
   * from a timing number.
   */
  const capabilities = await page.evaluate(() => ({
    crossOriginIsolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    atomics: typeof Atomics,
  }));

  expect(capabilities.crossOriginIsolated).toBe(true);
  expect(capabilities.sharedArrayBuffer).toBe('function');
  expect(capabilities.atomics).toBe('object');
});

/* ---------------------------------------------------------------- MF-P26 -- */

test('MF-P26: a replacement import commits while the one it replaced does not', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.goto('/');

  /*
   * THE RACE THAT ACTUALLY HAPPENS, rather than an artificial cancel call.
   *
   * A user opens a large file, waits, gets impatient and opens a different one.
   * The first import is abandoned mid-parse and the second must be the one that
   * lands. Two mechanisms have to hold at once and they are independent:
   * cancellation stops the abandoned work, and the stale-result guard stops it
   * committing if it finishes anyway. Neither replaces the other.
   */
  const big = threeMfLarge(600_000);
  const small = threeMfLarge(128);

  await armCancelAtPhase(page, ThreeMfImportPhase.Parsing);
  await openFile(page, 'abandoned.3mf', big);
  await expect(page.getByTestId('import-progress')).toHaveCount(0, { timeout: 240_000 });

  const observed = await readLateCancel(page);
  expect(observed.phaseAtCancel).toBe(ThreeMfImportPhase.Parsing);

  // The replacement lands, and it is the one on screen.
  await openFile(page, 'replacement.3mf', small);
  await expect(page.getByTestId('fact-triangles')).toHaveText('128', { timeout: 120_000 });
  await expect(page.getByTestId('fact-filename')).toHaveText('replacement.3mf');

  // The abandoned import never became the model, and never overwrote the one
  // that did.
  await expect(page.getByTestId('fact-triangles')).not.toHaveText('600,000');
  await expect(page.getByTestId('session-lost')).toHaveCount(0);
});
