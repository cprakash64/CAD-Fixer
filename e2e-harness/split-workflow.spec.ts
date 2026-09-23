import { expect, test } from '@playwright/test';
import { Fixture, digest, loadFixture, openHarness, readState } from './harness';
import type { Page } from '@playwright/test';

async function openSplit(page: Parameters<typeof openHarness>[0]): Promise<void> {
  await page.getByTestId('workflow-split').click();
  await expect(page.getByRole('heading', { name: 'Split', exact: true })).toBeVisible();
}
async function preview(page: Parameters<typeof openHarness>[0]): Promise<void> {
  await page.getByRole('button', { name: 'Update Preview' }).click();
  await expect(page.getByRole('heading', { name: 'Preview' })).toBeVisible({ timeout: 30000 });
}
async function resetQualification(page: Page): Promise<void> {
  await page.evaluate(() => window.cadfixerHarness?.resetSplitQualification());
}
async function waitForSplitPhase(
  page: Page,
  predicate: { phase: string; minimumBooleanIndex?: number },
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ phase, minimumBooleanIndex }) =>
            window.cadfixerHarness
              ?.splitQualificationEvents()
              .some(
                (event) =>
                  event.phase === phase && event.booleanIndex >= (minimumBooleanIndex ?? 0),
              ) ?? false,
          predicate,
        ),
      { timeout: 60_000, intervals: [10, 20, 50] },
    )
    .toBe(true);
}
async function latestTerminal(page: Page): Promise<{
  stats: { active: number; created: number; terminated: number };
}> {
  await waitForSplitPhase(page, { phase: 'TERMINAL' });
  const terminal = await page.evaluate(() =>
    window.cadfixerHarness
      ?.splitQualificationEvents()
      .filter((event) => event.phase === 'TERMINAL')
      .at(-1),
  );
  if (!terminal) throw new Error('No Split terminal event.');
  return terminal;
}

test('7B browser flow 1: cube split previews, applies as two parts, and undoes exactly', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  const before = await readState(page);
  expect(before.partCount).toBe(1);
  await openSplit(page);
  await preview(page);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(2);
  await page.getByRole('button', { name: 'Undo Split' }).click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(1);
});

test('7B browser flow 2: round pin split applies and exports both pieces', async ({ page }) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  await openSplit(page);
  await page.getByLabel('Connector type').selectOption('pin');
  await preview(page);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(2);
  for (const label of ['Export Piece A', 'Export Piece B']) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: label }).click();
    expect((await download).suggestedFilename()).toMatch(/Piece-[AB]\.stl/);
  }
});

test('7B browser flow 3: dovetail supports 90 degree orientation and Piece B male', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  await openSplit(page);
  await page.getByLabel('Connector type').selectOption('dovetail');
  await page.getByLabel('Dovetail orientation').selectOption('90');
  await page.getByLabel('Male connector side').selectOption('B');
  await preview(page);
  await expect(page.getByText(/Connector: dovetail/)).toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(2);
});

test('7B browser flow 4: cancelling split mode discards preview without changing the document', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  const before = await readState(page);
  await openSplit(page);
  await preview(page);
  await page.getByLabel('Split', { exact: true }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Split', exact: true })).toHaveCount(0);
  const after = await readState(page);
  expect(after.revision).toBe(before.revision);
  expect(after.partCount).toBe(1);
});

test('7B-X09: seven shared parts become eight and Undo restores exact sharing', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SevenSharedMillimetre);
  const beforeState = await readState(page),
    before = await digest(page, beforeState);
  await page.getByTestId('part-option-p3').click();
  await openSplit(page);
  await preview(page);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(8);
  const after = await digest(page, await readState(page));
  expect(after.parts.filter((p) => p.partId !== 'p3-A' && p.partId !== 'p3-B')).toEqual(
    before.parts.filter((p) => p.partId !== 'p3'),
  );
  await page.getByRole('button', { name: 'Undo Split' }).click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(7);
  expect((await digest(page, await readState(page))).parts).toEqual(before.parts);
});

test('7B-X01: five confirmed in-Manifold heavy Split cancellations terminate and recover', async ({
  page,
}) => {
  await openHarness(page);
  const tails: number[] = [];
  for (let trial = 0; trial < 5; trial++) {
    await loadFixture(page, Fixture.SplitHeavySphereMillimetre);
    await openSplit(page);
    await resetQualification(page);
    await page.getByRole('button', { name: 'Update Preview' }).click();
    await waitForSplitPhase(page, { phase: 'MANIFOLD_ENTER' });
    const started = Date.now();
    await page.getByLabel('Split', { exact: true }).getByRole('button', { name: 'Cancel' }).click();
    const terminal = await latestTerminal(page);
    tails.push(Date.now() - started);
    expect(terminal.stats.active).toBe(0);
    expect(terminal.stats.created).toBe(terminal.stats.terminated);
    expect(tails.at(-1)).toBeLessThan(1000);
    expect((await readState(page)).partCount).toBe(1);

    await loadFixture(page, Fixture.SplitCubeMillimetre);
    await openSplit(page);
    await preview(page);
    await page.getByLabel('Split', { exact: true }).getByRole('button', { name: 'Cancel' }).click();
  }
  const ordered = [...tails].sort((a, b) => a - b);
  console.warn(
    `[split cancellation] min/median/max ${String(ordered[0])}/${String(ordered[2])}/${String(ordered[4])}ms`,
  );
  expect(tails).toHaveLength(5);
});

test('7B-X03 repeated preview invalidation and cancel retains no Boolean worker', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  for (let cycle = 0; cycle < 3; cycle++) {
    await openSplit(page);
    await resetQualification(page);
    await preview(page);
    await page.getByRole('button', { name: 'Y', exact: true }).click();
    await preview(page);
    await page.getByLabel('Connector type').selectOption('pin');
    await preview(page);
    await page.getByLabel('Split', { exact: true }).getByRole('button', { name: 'Cancel' }).click();
    const terminal = await latestTerminal(page);
    expect(terminal.stats.active).toBe(0);
    expect(terminal.stats.created).toBe(terminal.stats.terminated);
    expect((await readState(page)).partCount).toBe(1);
  }
});

test('7B-X01 connector cancellation terminates a confirmed pin Boolean without a candidate', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitHeavySphereMillimetre);
  await openSplit(page);
  await page.getByLabel('Connector type').selectOption('pin');
  await resetQualification(page);
  await page.getByRole('button', { name: 'Update Preview' }).click();
  await waitForSplitPhase(page, { phase: 'MANIFOLD_ENTER', minimumBooleanIndex: 2 });
  await page.getByLabel('Split', { exact: true }).getByRole('button', { name: 'Cancel' }).click();
  const terminal = await latestTerminal(page);
  expect(terminal.stats.active).toBe(0);
  expect(terminal.stats.created).toBe(terminal.stats.terminated);
  expect((await readState(page)).partCount).toBe(1);
});

test('7B-X02 real Split supersession allows only Preview B to apply', async ({ page }) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitHeavySphereMillimetre);
  await openSplit(page);
  await resetQualification(page);
  await page.getByRole('button', { name: 'Update Preview' }).click();
  await waitForSplitPhase(page, { phase: 'MANIFOLD_ENTER' });
  await page.getByLabel('Split plane offset value').fill('3');
  await page.getByRole('button', { name: 'Update Preview' }).click();
  await expect(page.getByRole('heading', { name: 'Preview' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(2);
  const events = await page.evaluate(
    () => window.cadfixerHarness?.splitQualificationEvents() ?? [],
  );
  expect(new Set(events.map((event) => event.generation)).size).toBeGreaterThanOrEqual(2);
});

test('7B-X03 replacement import terminates a heavy Split and remains authoritative', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitHeavySphereMillimetre);
  await openSplit(page);
  await resetQualification(page);
  await page.getByRole('button', { name: 'Update Preview' }).click();
  await waitForSplitPhase(page, { phase: 'MANIFOLD_ENTER' });
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  const terminal = await latestTerminal(page);
  expect(terminal.stats.active).toBe(0);
  expect(terminal.stats.created).toBe(terminal.stats.terminated);
  expect((await readState(page)).partCount).toBe(1);
  await openSplit(page);
  await preview(page);
});

test('7B-X10 Split preview, connectors, apply and piece exports stay on origin', async ({
  page,
}) => {
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== 'http://localhost:4175') offOrigin.push(request.url());
  });
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  await openSplit(page);
  await page.getByLabel('Connector type').selectOption('pin');
  await preview(page);
  await page.getByLabel('Connector type').selectOption('dovetail');
  await preview(page);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(2);
  for (const label of ['Export Piece A', 'Export Piece B']) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: label }).click();
    await download;
  }
  expect(offOrigin).toEqual([]);
});

test('7B-PERF Split previews at 10k, 100k and 500k keep the main thread responsive', async ({
  page,
}) => {
  await openHarness(page);
  for (const [label, fixture] of [
    ['10k', Fixture.SplitSmallSphereMillimetre],
    ['100k', Fixture.SplitHeavySphereMillimetre],
    ['500k', Fixture.SplitLargeSphereMillimetre],
  ] as const) {
    await loadFixture(page, fixture);
    await openSplit(page);
    await page.evaluate(() => {
      const probe = window as unknown as { splitFrameGaps: number[]; splitFrameStop: boolean };
      probe.splitFrameGaps = [];
      probe.splitFrameStop = false;
      let previous = performance.now();
      const sample = (now: number): void => {
        probe.splitFrameGaps.push(now - previous);
        previous = now;
        if (!probe.splitFrameStop) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const started = Date.now();
    await preview(page);
    const total = Date.now() - started;
    const longestGap = await page.evaluate(() => {
      const probe = window as unknown as { splitFrameGaps: number[]; splitFrameStop: boolean };
      probe.splitFrameStop = true;
      return Math.max(0, ...probe.splitFrameGaps);
    });
    console.warn(
      `[split browser] ${label} total=${String(total)}ms longestGap=${longestGap.toFixed(0)}ms`,
    );
    expect(longestGap).toBeLessThan(1000);
    await page.getByLabel('Split', { exact: true }).getByRole('button', { name: 'Cancel' }).click();
  }
});
