import { expect, test, type Page } from '@playwright/test';
import { objLarge, threeMfLarge } from './format-fixtures';

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
