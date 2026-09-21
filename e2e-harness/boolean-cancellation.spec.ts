import { expect, test, type Page } from '@playwright/test';
import { openHarness } from './harness';

async function waitForManifold(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.cadfixerHarness
              ?.testBooleanPhases()
              .some((item) => item.phase === 'MANIFOLD_ENTER') ?? false,
        ),
      { timeout: 60_000, intervals: [10, 10, 20, 50] },
    )
    .toBe(true);
}

async function waitForPhase(page: Page, phase: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (value) =>
            window.cadfixerHarness?.testBooleanPhases().some((item) => item.phase === value) ??
            false,
          phase,
        ),
      { timeout: 60_000, intervals: [10, 10, 20, 50] },
    )
    .toBe(true);
}

test('nested disposable worker preserves union, difference, and intersection semantics', async ({
  page,
}) => {
  await openHarness(page);
  for (const operation of ['union', 'difference', 'intersection'] as const) {
    await page.evaluate((kind) => window.cadfixerHarness?.beginTestBoolean(kind), operation);
    const result = await page.evaluate(() => window.cadfixerHarness?.awaitTestBoolean());
    expect(result?.status).toBe('SUCCESS');
    expect(result?.triangles).toBeGreaterThan(0);
    expect(result?.phases.map((item) => item.phase)).toEqual([
      'WORKER_READY',
      'WASM_READY',
      'MANIFOLD_ENTER',
      'MANIFOLD_RETURN',
      'OUTPUT_VALIDATION',
      'PREVIEW_CONSTRUCTION',
    ]);
    expect(result?.stats.active).toBe(0);
    expect(result?.stats.created).toBe(result?.stats.terminated);
  }
});

test('cancellation closes initialization, output validation, and preview phases', async ({
  page,
}) => {
  await openHarness(page);
  for (const phase of ['WORKER_READY', 'OUTPUT_VALIDATION', 'PREVIEW_CONSTRUCTION']) {
    await page.evaluate(() => window.cadfixerHarness?.beginTestBoolean('union', 360, 180));
    await waitForPhase(page, phase);
    await page.evaluate(() => window.cadfixerHarness?.cancelTestBoolean());
    const result = await page.evaluate(() => window.cadfixerHarness?.awaitTestBoolean());
    expect(result?.status, phase).toBe('OPERATION_CANCELLED');
    expect(result?.stats.active).toBe(0);
  }
});

test('termination cancels confirmed in-Manifold work three times and then recovers', async ({
  page,
}) => {
  await openHarness(page);
  const tails: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => window.cadfixerHarness?.beginTestBoolean('union', 360, 180));
    await waitForManifold(page);
    const cancelledAt = Date.now();
    await page.evaluate(() => window.cadfixerHarness?.cancelTestBoolean());
    const result = await page.evaluate(() => window.cadfixerHarness?.awaitTestBoolean());
    tails.push(Date.now() - cancelledAt);
    expect(result?.status).toBe('OPERATION_CANCELLED');
    expect(result?.phases.some((item) => item.phase === 'MANIFOLD_ENTER')).toBe(true);
    expect(result?.phases.some((item) => item.phase === 'MANIFOLD_RETURN')).toBe(false);
    expect(result?.stats.active).toBe(0);
    expect(tails.at(-1)).toBeLessThan(1000);
  }
  await page.evaluate(() => window.cadfixerHarness?.beginTestBoolean('union'));
  const recovered = await page.evaluate(() => window.cadfixerHarness?.awaitTestBoolean());
  expect(recovered?.status).toBe('SUCCESS');
  expect(tails).toHaveLength(3);
});

test('supersession and child crash settle cleanly and preserve recovery', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => window.cadfixerHarness?.beginTestBoolean('union', 360, 180));
  await waitForManifold(page);
  await page.evaluate(() => window.cadfixerHarness?.beginTestBoolean('difference'));
  const superseding = await page.evaluate(() => window.cadfixerHarness?.awaitTestBoolean());
  expect(superseding?.status).toBe('SUCCESS');
  expect(superseding?.stats.active).toBe(0);

  await page.evaluate(() => window.cadfixerHarness?.beginTestBoolean('union', 20, 12, true));
  const crashed = await page.evaluate(() => window.cadfixerHarness?.awaitTestBoolean());
  expect(crashed?.status).toBe('INTERNAL_ERROR');
  expect(crashed?.stats.active).toBe(0);

  await page.evaluate(() => window.cadfixerHarness?.beginTestBoolean('intersection'));
  await expect(
    page.evaluate(() => window.cadfixerHarness?.awaitTestBoolean()),
  ).resolves.toMatchObject({ status: 'SUCCESS' });
});

test('repeated disposable workers retain nothing and load assets only from this origin', async ({
  page,
}) => {
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== 'http://localhost:4175') offOrigin.push(request.url());
  });
  await openHarness(page);
  for (let cycle = 0; cycle < 5; cycle++) {
    await page.evaluate(() => window.cadfixerHarness?.beginTestBoolean('union'));
    const result = await page.evaluate(() => window.cadfixerHarness?.awaitTestBoolean());
    expect(result?.status).toBe('SUCCESS');
    expect(result?.stats.active).toBe(0);
    expect(result?.stats.created).toBe(result?.stats.terminated);
  }
  expect(offOrigin).toEqual([]);
});
