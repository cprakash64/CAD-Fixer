import { expect, test, type Page } from '@playwright/test';

/**
 * Stage 3C-1A — browser qualification of the read-only self-intersection
 * diagnostic. RESEARCH ONLY.
 *
 * Real Chromium, real cross-origin isolation, the real WASM artifact built from
 * the pinned Geogram, and real Workers. What is being qualified here is not the
 * geometry — the native corpus already settled that — but the ARCHITECTURE:
 * can this run off the UI thread, can it be cancelled, can geometry reach it
 * without the page ever holding it, and does the authoritative copy survive.
 */

interface SiApi {
  env(): { crossOriginIsolated: boolean; sharedArrayBuffer: string; wasm: string };
  grid(side: number): { positions: number[]; triangles: number[] };
  runDirect(f: unknown, l?: unknown): Promise<Record<string, number | string | boolean>>;
  setupChannel(f: unknown): Promise<Record<string, number>>;
  runOverChannel(l?: unknown): Promise<Record<string, number | string | boolean>>;
  startOverChannel(l?: unknown): Promise<number>;
  terminateDiagnostic(): number;
  verifyAuthoritative(): Promise<Record<string, number>>;
  recreateDiagnostic(): Promise<boolean>;
}
declare global {
  interface Window {
    si: SiApi;
  }
}

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#state')).toHaveText('ready');
}

test('the research context is cross-origin isolated with WASM available', async ({ page }) => {
  await ready(page);
  const env = await page.evaluate(() => window.si.env());
  expect(env.crossOriginIsolated).toBe(true);
  expect(env.sharedArrayBuffer).toBe('function');
  expect(env.wasm).toBe('object');
});

test('the diagnostic runs in a worker and classifies a known crossing', async ({ page }) => {
  await ready(page);
  const report = await page.evaluate(() =>
    window.si.runDirect({
      positions: [0, 0, 0, 4, 0, 0, 0, 4, 0, 1, 1, -2, 3, 1, 2, 1, 3, 2],
      triangles: [0, 1, 2, 3, 4, 5],
    }),
  );
  expect(report.statusName).toBe('CHECKED');
  expect(report.intersectingPairCount).toBe(1);
  expect(report.properCrossing).toBe(1);
});

test('a clean 2048-face surface produces no false positives in the browser', async ({ page }) => {
  await ready(page);
  const report = await page.evaluate(() => window.si.runDirect(window.si.grid(32)));
  expect(report.statusName).toBe('CHECKED');
  expect(report.intersectingPairCount).toBe(0);
  expect(Number(report.legitimateShared)).toBeGreaterThan(10000);
});

test('the resource limit reports RESOURCE_LIMIT, never a clean bill of health', async ({
  page,
}) => {
  await ready(page);
  const report = await page.evaluate(() =>
    window.si.runDirect(window.si.grid(48), { maxTestedPairs: 500 }),
  );
  expect(report.statusName).toBe('RESOURCE_LIMIT');
  // The aborted search must not masquerade as "nothing found".
  expect(Number(report.testedPairCount)).toBeLessThan(Number(report.candidatePairCount));
});

test('OPTION B: geometry travels producer worker -> MessageChannel -> diagnostic worker', async ({
  page,
}) => {
  await ready(page);

  const before = await page.evaluate(async () => {
    const g = window.si.grid(24);
    return window.si.setupChannel(g);
  });
  expect(before.faceCount).toBe(1152);

  const report = await page.evaluate(() => window.si.runOverChannel());
  expect(report.statusName).toBe('CHECKED');
  expect(report.intersectingPairCount).toBe(0);

  // THE AUTHORITATIVE COPY SURVIVED. The producer transferred a disposable
  // slice; its own buffers were never detached.
  const after = await page.evaluate(() => window.si.verifyAuthoritative());
  expect(after.positions).toBe(before.positions);
  expect(after.triangles).toBe(before.triangles);
  expect(after.faceCount).toBe(before.faceCount);

  // eslint-disable-next-line no-console
  console.log(
    `[channel] postMs=${String(report.postMs)} roundTripMs=${String(report.roundTripMs)}`,
  );
});

test('CANCELLATION: terminating the diagnostic worker stops the work and the source survives', async ({
  page,
}) => {
  await ready(page);

  // A workload heavy enough that a full run is unambiguously long.
  const before = await page.evaluate(async () => window.si.setupChannel(window.si.grid(120)));

  const full = await page.evaluate(() => window.si.runOverChannel());
  expect(full.statusName).toBe('CHECKED');
  const tFull = Number(full.roundTripMs);
  expect(tFull).toBeGreaterThan(300);

  // Start again, then kill the diagnostic worker mid-flight.
  const cancel = await page.evaluate(async () => {
    await window.si.recreateDiagnostic();
    const started = await window.si.startOverChannel();
    // Let the synchronous WASM scan genuinely get under way before killing it.
    await new Promise((r) => setTimeout(r, 120));
    const killed = window.si.terminateDiagnostic();
    return { tCancel: killed - started };
  });

  // Terminate is immediate and does not wait for the C++ call to finish.
  expect(cancel.tCancel).toBeLessThan(tFull * 0.8);

  // THE AUTHORITATIVE WORKER IS UNTOUCHED and still owns intact geometry.
  const after = await page.evaluate(() => window.si.verifyAuthoritative());
  expect(after.positions).toBe(before.positions);
  expect(after.triangles).toBe(before.triangles);

  // RETRY: a fresh diagnostic worker completes normally.
  const retry = await page.evaluate(async () => {
    await window.si.recreateDiagnostic();
    return window.si.runOverChannel();
  });
  expect(retry.statusName).toBe('CHECKED');

  // eslint-disable-next-line no-console
  console.log(
    `[cancellation] T_full=${String(Math.round(tFull))}ms T_cancel=${String(Math.round(cancel.tCancel))}ms ` +
      `ratio=${(cancel.tCancel / tFull).toFixed(3)}`,
  );
});

test('no network request carries geometry', async ({ page }) => {
  const offOrigin: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (
      !url.startsWith('http://localhost:4319/') &&
      !url.startsWith('data:') &&
      !url.startsWith('blob:')
    ) {
      offOrigin.push(url);
    }
    const post = r.postData();
    if (post !== null && post.length > 512) offOrigin.push(`BODY:${url}`);
  });

  await ready(page);
  await page.evaluate(() => window.si.runDirect(window.si.grid(16)));
  expect(offOrigin).toEqual([]);
});
