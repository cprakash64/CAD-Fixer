import { expect, test, type Page } from '@playwright/test';
import { Fixture, digest, loadFixture, openHarness, readState } from './harness';

async function openTexture(page: Page): Promise<void> {
  await page.getByTestId('workflow-texture').click();
  await expect(page.getByRole('heading', { name: 'Surface texture' })).toBeVisible();
}
async function selectVisibleSurface(page: Page, xFraction = 0.5): Promise<void> {
  const canvas = page.getByTestId('viewport-canvas').locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Viewport canvas has no bounds.');
  await canvas.click({
    force: true,
    position: { x: box.width * xFraction, y: box.height / 2 },
  });
  await expect(page.getByText(/Surface selected \(triangle/)).toBeVisible();
}
async function preview(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Update Preview' }).click();
  await expect(page.getByTestId('texture-preview-banner')).toBeVisible({ timeout: 30_000 });
}
async function exportWhole(page: Page, target: 'stl' | 'obj' | '3mf'): Promise<number> {
  await page.getByTestId('open-convert').click();
  await expect(page.getByTestId('convert-dialog')).toBeVisible();
  await page.getByTestId(`convert-target-${target}`).check();
  const pending = page.waitForEvent('download');
  await page.getByTestId('convert-export').click();
  const download = await pending;
  const stream = await download.createReadStream();
  let bytes = 0;
  for await (const chunk of stream) bytes += (chunk as Buffer).byteLength;
  await expect(page.getByTestId('convert-saved')).toBeVisible();
  await page.getByTestId('convert-close').click();
  return bytes;
}
async function resetBooleanEvents(page: Page): Promise<void> {
  await page.evaluate(() => window.cadfixerHarness?.resetSplitQualification());
}
async function waitForBooleanPhase(page: Page, phase: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (wanted) =>
            window.cadfixerHarness
              ?.splitQualificationEvents()
              .some((event) => event.phase === wanted) ?? false,
          phase,
        ),
      { timeout: 30_000, intervals: [5, 10, 20] },
    )
    .toBe(true);
}

test('7C browser flow 1: Dots Raised previews, applies, and undoes', async ({ page }) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  const before = await readState(page);
  await openTexture(page);
  await selectVisibleSurface(page);
  await preview(page);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await readState(page)).revision).not.toBe(before.revision);
  for (const target of ['stl', 'obj', '3mf'] as const)
    expect(await exportWhole(page, target)).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await readState(page)).revision).not.toBe(before.revision);
});

test('7C browser flows 3/4: Lines Engraved and Diamond build actual previews', async ({ page }) => {
  await openHarness(page);
  for (const pattern of ['lines', 'diamond'] as const) {
    await loadFixture(page, Fixture.SplitCubeMillimetre);
    await openTexture(page);
    await selectVisibleSurface(page);
    await page.getByLabel('Texture pattern').selectOption(pattern);
    await page.getByLabel('Texture mode').selectOption('engrave');
    await page.getByLabel('Texture rotation').fill('45');
    await preview(page);
    await expect(page.getByText(new RegExp(`${pattern} · engrave`))).toBeVisible();
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  }
});

test('7C-M01/M02: texturing Part 3 isolates six shared siblings and Undo restores sharing', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SevenSharedMillimetre);
  const beforeState = await readState(page),
    before = await digest(page, beforeState);
  await page.getByTestId('part-option-p3').click();
  await openTexture(page);
  // Flow 1 proves the real viewport ray pick. Here a harness event fixes the
  // seed on the requested shared placement so this test isolates transaction
  // semantics rather than camera occlusion among seven tiny instances.
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('cadfixer:texture-surface-pick', {
        detail: { partId: 'p3', triangleIndex: 0, point: [0, 0, 0], normal: [0, 0, -1] },
      }),
    );
  });
  await expect(page.getByText(/Surface selected \(triangle/)).toBeVisible();
  await page.getByLabel('Texture feature size').fill('0.1');
  await page.getByLabel('Texture spacing').fill('0.3');
  await page.getByLabel('Texture height or depth').fill('0.05');
  await preview(page);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await readState(page)).revision).not.toBe(beforeState.revision);
  const appliedState = await readState(page),
    applied = await digest(page, appliedState);
  expect(applied.parts.filter((part) => part.partId !== 'p3')).toEqual(
    before.parts.filter((part) => part.partId !== 'p3'),
  );
  expect(applied.distinctMeshes).toBe(2);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await readState(page)).revision).not.toBe(appliedState.revision);
  const undone = await digest(page, await readState(page));
  expect(undone.parts).toEqual(before.parts);
  expect(undone.distinctMeshes).toBe(before.distinctMeshes);
});

test('7C-P01: texture selection, preview, Apply, and Undo remain local-only', async ({ page }) => {
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== 'http://localhost:4175') offOrigin.push(request.url());
  });
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  await openTexture(page);
  await selectVisibleSurface(page);
  await preview(page);
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  expect(offOrigin).toEqual([]);
});

test('7C-R02: three confirmed in-Manifold cancellations terminate and recover', async ({
  page,
}) => {
  await openHarness(page);
  const tails: number[] = [];
  for (let trial = 0; trial < 3; trial++) {
    await loadFixture(page, Fixture.SplitCubeMillimetre);
    await openTexture(page);
    await selectVisibleSurface(page);
    await page.getByLabel('Texture feature size').fill('1');
    await page.getByLabel('Texture spacing').fill('2');
    await resetBooleanEvents(page);
    await page.getByRole('button', { name: 'Update Preview' }).click();
    await waitForBooleanPhase(page, 'MANIFOLD_ENTER');
    const started = performance.now();
    await page.getByLabel('Surface texture').getByRole('button', { name: 'Cancel' }).click();
    await waitForBooleanPhase(page, 'TERMINAL');
    tails.push(performance.now() - started);
    const terminal = await page.evaluate(() =>
      window.cadfixerHarness
        ?.splitQualificationEvents()
        .filter((event) => event.phase === 'TERMINAL')
        .at(-1),
    );
    expect(terminal?.stats.active).toBe(0);
    expect(terminal?.stats.created).toBe(terminal?.stats.terminated);
    expect(tails.at(-1)).toBeLessThan(1000);
  }
  tails.sort((a, b) => a - b);
  console.warn(
    `[texture cancellation] min/median/max ${String(Math.round(tails[0] ?? 0))}/${String(Math.round(tails[1] ?? 0))}/${String(Math.round(tails[2] ?? 0))}ms`,
  );
});

test('7C-R03/R05: superseded previews release workers and latest configuration wins', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  await openTexture(page);
  await selectVisibleSurface(page);
  await resetBooleanEvents(page);
  await preview(page);
  await page.getByLabel('Texture spacing').fill('6');
  await preview(page);
  await page.getByLabel('Texture pattern').selectOption('lines');
  await preview(page);
  await expect(page.getByText(/lines · emboss/)).toBeVisible();
  await page.getByLabel('Surface texture').getByRole('button', { name: 'Cancel' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const events = window.cadfixerHarness?.splitQualificationEvents() ?? [];
        return events.filter((event) => event.phase === 'TERMINAL').at(-1)?.stats.active ?? -1;
      }),
    )
    .toBe(0);
  const stats = await page.evaluate(() =>
    window.cadfixerHarness
      ?.splitQualificationEvents()
      .filter((event) => event.phase === 'TERMINAL')
      .at(-1),
  );
  expect(stats?.stats.created).toBe(stats?.stats.terminated);
});

test('7C-R04: document replacement terminates active texture and remains authoritative', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  await openTexture(page);
  await selectVisibleSurface(page);
  await page.getByLabel('Texture feature size').fill('0.5');
  await page.getByLabel('Texture spacing').fill('1');
  await resetBooleanEvents(page);
  await page.getByRole('button', { name: 'Update Preview' }).click();
  await waitForBooleanPhase(page, 'MANIFOLD_ENTER');
  await loadFixture(page, Fixture.SevenSharedMillimetre);
  await waitForBooleanPhase(page, 'TERMINAL');
  const replacement = await readState(page);
  expect(replacement.partCount).toBe(7);
  const terminal = await page.evaluate(() =>
    window.cadfixerHarness
      ?.splitQualificationEvents()
      .filter((event) => event.phase === 'TERMINAL')
      .at(-1),
  );
  expect(terminal?.stats.active).toBe(0);
  expect(terminal?.stats.created).toBe(terminal?.stats.terminated);
  await expect(page.getByTestId('texture-preview-banner')).toHaveCount(0);
});

test('7C main-thread responsiveness: dense preview and Apply keep frame gaps bounded', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  const before = await readState(page);
  await openTexture(page);
  await selectVisibleSurface(page);
  await page.getByLabel('Texture feature size').fill('0.5');
  await page.getByLabel('Texture spacing').fill('1');
  await page.evaluate(() => {
    const gaps: number[] = [];
    let prior = performance.now();
    const sample = (now: number): void => {
      gaps.push(now - prior);
      prior = now;
      (window as unknown as { textureProbe: number }).textureProbe = requestAnimationFrame(sample);
    };
    (window as unknown as { textureGaps: number[] }).textureGaps = gaps;
    (window as unknown as { textureProbe: number }).textureProbe = requestAnimationFrame(sample);
  });
  const started = Date.now();
  await preview(page);
  const previewMs = Date.now() - started;
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await readState(page)).revision).not.toBe(before.revision);
  const result = await page.evaluate(() => {
    const state = window as unknown as { textureGaps: number[]; textureProbe: number };
    cancelAnimationFrame(state.textureProbe);
    return { samples: state.textureGaps.length, longestGap: Math.max(...state.textureGaps) };
  });
  console.warn(
    `[texture responsiveness] preview ${String(previewMs)}ms, longest frame gap ${result.longestGap.toFixed(1)}ms`,
  );
  expect(result.samples).toBeGreaterThan(2);
  expect(result.longestGap).toBeLessThan(250);
});
