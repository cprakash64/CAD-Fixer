import { expect, test, type Page } from '@playwright/test';
import { Fixture, loadFixture, openHarness, readScene, readState } from './harness';

/**
 * §44 — MULTI-PART RESPONSIVENESS, IN REAL CHROMIUM.
 *
 * The question is narrow and answerable: does part COUNT cost main-thread time?
 * The document benchmark showed it costs metadata rather than geometry in Node;
 * this is the same claim in the place it matters, where the geometry is uploaded
 * to a GPU and React renders a selector with a thousand entries in it.
 *
 * SELF-SCALING, NOT FIXED CEILINGS, for the same reason `responsiveness.timing`
 * is: an absolute millisecond threshold on a shared machine measures the machine.
 * What is asserted is the SHAPE — that a thousand placements do not cost a
 * thousand times a single one — plus one absolute bound where the interface
 * either responds or does not.
 */

/**
 * Longest gap between animation frames over `durationMs`.
 *
 * The same instrument `e2e/responsiveness.timing.spec.ts` uses, and for the same
 * reason: if the main thread is blocked, frames do not fire, and the gap is
 * exactly the block.
 */
async function measureWorstGap(page: Page, durationMs: number): Promise<number> {
  return page.evaluate(
    async (duration: number) =>
      new Promise<number>((resolve) => {
        let last = performance.now();
        let worst = 0;
        const started = performance.now();
        const tick = (): void => {
          const now = performance.now();
          worst = Math.max(worst, now - last);
          last = now;
          if (now - started < duration) requestAnimationFrame(tick);
          else resolve(worst);
        };
        requestAnimationFrame(tick);
      }),
    durationMs,
  );
}

/** Wall-clock time for a fixture to become fully drawn. */
async function timeLoad(page: Page, fixture: Fixture): Promise<number> {
  const started = Date.now();
  await loadFixture(page, fixture);
  return Date.now() - started;
}

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test('§44: placement count costs metadata, not proportional load time', async ({ page }) => {
  test.setTimeout(300_000);

  const one = await timeLoad(page, Fixture.SinglePart);
  const ten = await timeLoad(page, Fixture.Shared10);
  const hundred = await timeLoad(page, Fixture.Shared100);
  const thousand = await timeLoad(page, Fixture.Shared1000);

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(1000);
  // ONE upload for a thousand placements. If this were 1000, the timings below
  // would be measuring a design that does not work.
  expect(scene.sharedGeometries).toBe(1);

  /*
   * THE SHAPE, not a stopwatch. A thousand placements are a thousand times more
   * parts than one; if geometry were duplicated per part the cost would scale
   * with that. A generous factor still fails loudly on N-times-geometry, and
   * does not fail on a busy machine.
   */
  const budget = Math.max(one * 25, 4_000);
  expect(
    thousand,
    `1000 placements loaded in ${String(thousand)}ms against ${String(one)}ms for one ` +
      `(10: ${String(ten)}ms, 100: ${String(hundred)}ms)`,
  ).toBeLessThan(budget);

  process.stdout.write(
    `[multi-part] load ms — 1 part ${String(one)}, 10 ${String(ten)}, ` +
      `100 ${String(hundred)}, 1000 ${String(thousand)}\n`,
  );
});

test('§44: switching the active part is immediate at a thousand placements', async ({ page }) => {
  test.setTimeout(300_000);

  await loadFixture(page, Fixture.Shared1000);
  const before = await readScene(page);

  // The selector lists every part; picking one from the far end is the worst
  // case for both the list and the store.
  const target = page.getByTestId('part-option-p999');
  await target.scrollIntoViewIfNeeded();

  const started = Date.now();
  await target.click();
  await expect
    .poll(async () => (await readState(page)).activePartId, { timeout: 30_000 })
    .toBe('p999');
  const switchMs = Date.now() - started;

  const after = await readScene(page);
  // NO GEOMETRY WORK AT ALL for a selection, at any part count. This is the
  // property that makes the latency bound meaningful rather than lucky.
  expect(after.geometriesCreated).toBe(before.geometriesCreated);
  expect(after.geometriesDisposed).toBe(before.geometriesDisposed);
  expect(after.modelObjects).toBe(1000);

  // An absolute bound, because this is a click: either the interface responds
  // or it does not.
  expect(switchMs, `active-part switch took ${String(switchMs)}ms at 1000 placements`).toBeLessThan(
    3_000,
  );

  process.stdout.write(
    `[multi-part] active-part switch at 1000 placements: ${String(switchMs)}ms\n`,
  );
});

test('§44: part count does not cost main-thread time proportionally', async ({ page }) => {
  test.setTimeout(300_000);

  /*
   * WHAT THIS COMPARES, AND WHY IT IS NOT AN ABSOLUTE CEILING.
   *
   * Building a thousand scene objects and a thousand list rows is proportional
   * work that is not a defect — a document with a thousand parts genuinely has a
   * thousand of each. A fixed millisecond bound would therefore be asserting
   * that large documents are small, which is not a property the product has or
   * claims.
   *
   * The property it DOES have is the one the whole sharing design exists for:
   * part count must cost METADATA, not geometry. So the measurement is
   * like-for-like — the same mesh, loaded once and loaded a thousand times — and
   * the assertion is on the RATIO. Flattening the document, deep-cloning parts,
   * or walking one shared mesh once per placement would all land as a long task
   * that scales with N and would blow this apart. The Node benchmark measured
   * exactly that mistake at 356 ms before per-mesh bounds memoisation.
   */
  await loadFixture(page, Fixture.SinglePart);
  const idleGap = await measureWorstGap(page, 1_500);

  // One placement of the fixture geometry, measured across its load.
  await page.getByTestId(`harness-load-${Fixture.SharedPairApart}`).click();
  const smallGap = await measureWorstGap(page, 1_500);
  await expect.poll(async () => (await readScene(page)).modelObjects, { timeout: 60_000 }).toBe(2);

  // A thousand placements of the same geometry, measured the same way.
  await page.getByTestId(`harness-load-${Fixture.Shared1000}`).click();
  const largeGap = await measureWorstGap(page, 2_500);
  await expect
    .poll(async () => (await readScene(page)).modelObjects, { timeout: 120_000 })
    .toBe(1000);

  const scene = await readScene(page);
  // THE ARCHITECTURAL CLAIM, checked directly: one upload, not a thousand.
  expect(scene.sharedGeometries).toBe(1);

  /*
   * 500x the parts. A factor of 20 on the longest main-thread gap leaves ample
   * room for a thousand `Mesh` allocations and a thousand list rows, and none at
   * all for per-part geometry work — which at this ratio would be hundreds of
   * times the small document's cost, not tens.
   */
  const ceiling = Math.max(smallGap * 20, 400);
  expect(
    largeGap,
    `main-thread gap loading 1000 placements ${largeGap.toFixed(0)}ms against ` +
      `${smallGap.toFixed(0)}ms for 2 placements of the same mesh (idle ${idleGap.toFixed(0)}ms)`,
  ).toBeLessThan(ceiling);

  process.stdout.write(
    `[multi-part] main-thread gap — idle ${idleGap.toFixed(0)}ms, ` +
      `2 placements ${smallGap.toFixed(0)}ms, 1000 placements ${largeGap.toFixed(0)}ms
`,
  );
});

test('§44: the interface stays usable while a multi-part document is being set up', async ({
  page,
}) => {
  test.setTimeout(300_000);

  await loadFixture(page, Fixture.SinglePart);

  await page.getByTestId(`harness-load-${Fixture.Shared1000}`).click();

  /*
   * ACTUALLY USE THE INTERFACE, do not merely watch it. A frame loop can keep
   * ticking while input is queued behind work, so this hovers and clicks a real
   * control and times the response.
   */
  const fit = page.getByTestId('fit-view');
  const started = Date.now();
  await fit.hover();
  await fit.click();
  const interactionMs = Date.now() - started;

  await expect
    .poll(async () => (await readScene(page)).modelObjects, { timeout: 120_000 })
    .toBe(1000);

  expect(
    interactionMs,
    `interacting during a 1000-placement load took ${String(interactionMs)}ms`,
  ).toBeLessThan(2_000);

  process.stdout.write(`[multi-part] interaction during load: ${String(interactionMs)}ms\n`);
});

test('§44: topology and self-intersection on the active part are unaffected by part count', async ({
  page,
}) => {
  test.setTimeout(300_000);

  // A distinct-mesh document, so the active part is a real mesh rather than one
  // shared a thousand ways.
  await loadFixture(page, Fixture.ThreeTransformedParts);

  const analysisStarted = Date.now();
  await expect
    .poll(async () => (await readState(page)).analysisState, { timeout: 120_000 })
    .toBe('ready');
  const analysisMs = Date.now() - analysisStarted;

  const selfIntersectionStarted = Date.now();
  await expect
    .poll(async () => (await readState(page)).selfIntersectionStatus, { timeout: 180_000 })
    .toBeDefined();
  const selfIntersectionMs = Date.now() - selfIntersectionStarted;

  const state = await readState(page);
  // ONE PART WAS ANALYSED, not three. A hundred-part document must not launch a
  // hundred topology passes because a file was opened.
  expect(state.analysisPartId).toBe('a');
  expect(state.selfIntersectionReportPartId).toBe('a');

  process.stdout.write(
    `[multi-part] active-part topology ${String(analysisMs)}ms, ` +
      `self-intersection ${String(selfIntersectionMs)}ms\n`,
  );
});
