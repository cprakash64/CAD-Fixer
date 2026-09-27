import { expect, test, type Page } from '@playwright/test';
import { Fixture, digest, loadFixture, openHarness, readState } from './harness';

async function openTexture(page: Page): Promise<void> {
  await page.getByTestId('workflow-texture').click();
  await expect(page.getByTestId('texture-workspace')).toBeVisible();
}
async function selectVisibleSurface(page: Page, xFraction = 0.5): Promise<void> {
  const canvas = page.getByTestId('viewport-canvas').locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Viewport canvas has no bounds.');
  await canvas.click({
    force: true,
    position: { x: box.width * xFraction, y: box.height / 2 },
  });
  await expect(page.getByTestId('texture-selection-metrics')).toBeVisible();
}
async function preview(page: Page): Promise<void> {
  await page.getByTestId('texture-generate').click();
  await expect(page.getByTestId('texture-preview-banner')).toBeVisible({ timeout: 30_000 });
}
async function exportWhole(page: Page, target: 'stl' | 'obj' | '3mf'): Promise<number> {
  await page.getByTestId('open-convert').click();
  await expect(page.getByTestId('convert-workspace')).toBeVisible();
  await page.getByTestId(`convert-target-${target}`).check();
  const pending = page.waitForEvent('download');
  await page.getByTestId('convert-export').click();
  const download = await pending;
  const stream = await download.createReadStream();
  let bytes = 0;
  for await (const chunk of stream) bytes += (chunk as Buffer).byteLength;
  await expect(page.getByTestId('convert-saved')).toBeVisible();
  // Back to the workspace the flow was in, whose Undo the test presses next.
  await page.getByTestId('workflow-texture').click();
  return bytes;
}
/**
 * Stops texture work. UI-05: a built preview is discarded with its own button;
 * while work runs, Reset cancels it (and restores the default settings).
 */
async function cancelTexture(page: Page): Promise<void> {
  const discard = page.getByTestId('texture-discard');
  if (await discard.isVisible()) await discard.click();
  else await page.getByTestId('texture-reset').click();
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
  await page.getByTestId('texture-apply').click();
  await expect.poll(async () => (await readState(page)).revision).not.toBe(before.revision);
  for (const target of ['stl', 'obj', '3mf'] as const)
    expect(await exportWhole(page, target)).toBeGreaterThan(100);
  await page.getByTestId('texture-undo').click();
  await expect.poll(async () => (await readState(page)).revision).not.toBe(before.revision);
});

test('7C browser flows 3/4: Lines Engraved and Diamond build actual previews', async ({ page }) => {
  await openHarness(page);
  for (const pattern of ['lines', 'diamond'] as const) {
    await loadFixture(page, Fixture.SplitCubeMillimetre);
    await openTexture(page);
    await selectVisibleSurface(page);
    await page.getByTestId(`texture-pattern-${pattern}`).check();
    await page.getByTestId('texture-engraved').click();
    await page.getByTestId('texture-rotation').fill('45');
    await preview(page);
    await expect(page.getByTestId('texture-inspector-source')).toHaveText(
      pattern === 'lines' ? 'Lines' : 'Diamond',
    );
    await expect(page.getByTestId('texture-inspector-direction')).toContainText('Engraved');
    await page.getByTestId('texture-apply').click();
    await expect(page.getByTestId('texture-undo')).toBeVisible();
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
  // Flow 1 proves the real viewport ray pick. Here the harness selects the seed
  // on the requested shared placement through the same worker operation and
  // store call a pick makes, so this test isolates transaction semantics
  // rather than camera occlusion among seven tiny instances.
  await page.evaluate(() => window.cadfixerHarness?.selectTextureSurface('p3', 0));
  await expect(page.getByTestId('texture-selection-metrics')).toBeVisible();
  await page.getByTestId('texture-feature-size').fill('0.1');
  await page.getByTestId('texture-spacing').fill('0.3');
  await page.getByTestId('texture-depth').fill('0.05');
  await preview(page);
  await page.getByTestId('texture-apply').click();
  await expect.poll(async () => (await readState(page)).revision).not.toBe(beforeState.revision);
  const appliedState = await readState(page),
    applied = await digest(page, appliedState);
  expect(applied.parts.filter((part) => part.partId !== 'p3')).toEqual(
    before.parts.filter((part) => part.partId !== 'p3'),
  );
  expect(applied.distinctMeshes).toBe(2);
  await page.getByTestId('texture-undo').click();
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
  await page.getByTestId('texture-apply').click();
  await page.getByTestId('texture-undo').click();
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
    await page.getByTestId('texture-feature-size').fill('1');
    await page.getByTestId('texture-spacing').fill('2');
    await resetBooleanEvents(page);
    await page.getByTestId('texture-generate').click();
    await waitForBooleanPhase(page, 'MANIFOLD_ENTER');
    const started = performance.now();
    await cancelTexture(page);
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
  await page.getByTestId('texture-spacing').fill('6');
  await preview(page);
  await page.getByTestId('texture-pattern-lines').check();
  await preview(page);
  await expect(page.getByTestId('texture-inspector-source')).toHaveText('Lines');
  await expect(page.getByTestId('texture-inspector-direction')).toContainText('Raised');
  await cancelTexture(page);
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
  await page.getByTestId('texture-feature-size').fill('0.5');
  await page.getByTestId('texture-spacing').fill('1');
  await resetBooleanEvents(page);
  await page.getByTestId('texture-generate').click();
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

/**
 * THE BENCHMARK RENDERS AT A FIXED SIZE, whatever the shell around it looks
 * like. Headless Chromium draws WebGL on the CPU (SwiftShader), so the time
 * the main thread waits on the compositor scales with the canvas's pixel area:
 * the unchanged 8c94d10 build passed at its old 1008x149 canvas and failed
 * the same way the UI-01 shell did once given the shell's 750x642. The limit
 * below is a statement about main-thread work, so the pixel area is held
 * constant: 640x240 at DPR 1 is ~154k px, the area the limit was qualified at.
 * See docs/design/UI_SHELL.md. The full-size editor is covered separately by
 * the UI shell smoke test in e2e/ui-shell.spec.ts.
 */
const BENCHMARK_CANVAS = { width: 640, height: 240 } as const;

async function pinBenchmarkCanvas(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
  // Test-only CSS on the renderer's container; the viewport's ResizeObserver
  // then sizes the drawing buffer exactly as it would for a real layout.
  await page.addStyleTag({
    content: `[data-testid="viewport-canvas"] {
      inset: 0 auto auto 0 !important;
      width: ${String(BENCHMARK_CANVAS.width)}px !important;
      height: ${String(BENCHMARK_CANVAS.height)}px !important;
    }`,
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '[data-testid="viewport-canvas"] canvas',
        );
        return canvas === null
          ? null
          : {
              cssWidth: canvas.clientWidth,
              cssHeight: canvas.clientHeight,
              width: canvas.width,
              height: canvas.height,
            };
      }),
    )
    .toEqual({
      cssWidth: BENCHMARK_CANVAS.width,
      cssHeight: BENCHMARK_CANVAS.height,
      width: BENCHMARK_CANVAS.width,
      height: BENCHMARK_CANVAS.height,
    });
}

test('7C main-thread responsiveness: dense preview and Apply keep frame gaps bounded', async ({
  page,
}) => {
  await openHarness(page);
  await pinBenchmarkCanvas(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  const before = await readState(page);
  await openTexture(page);
  await selectVisibleSurface(page);
  await page.getByTestId('texture-feature-size').fill('0.5');
  await page.getByTestId('texture-spacing').fill('1');
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
  await page.getByTestId('texture-apply').click();
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
