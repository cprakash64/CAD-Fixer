import { expect, test, type Page } from '@playwright/test';
import { APP_BASE_URL } from './app-origin';
import { enter, openBox, watchErrors } from './ui-fixtures';

/**
 * BRAND-01: the Pybrix identity, in a real browser, under the production CSP.
 *
 * What jsdom cannot see: whether the icons actually load (no 404, no decode
 * failure, no CSP refusal), whether the header lays out without collisions at
 * every tier, whether the brand images reserve their box before decoding, and
 * whether anything reaches off-origin to draw the brand.
 */

const LEGACY_NAME = /cad[\s_-]*fixer/i;
const ORIGIN = new URL(APP_BASE_URL).origin;

/** Collects CSP violations the page itself reports. */
async function watchCsp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

const cspViolations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);

/** An <img> that has decoded to real pixels, not a broken-image placeholder. */
const decoded = (page: Page, testId: string): Promise<boolean> =>
  page
    .getByTestId(testId)
    .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);

test('B-01: the title, favicon and touch icon are Pybrix and load same-origin', async ({
  page,
}) => {
  await watchCsp(page);
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${String(response.status())} ${response.url()}`);
  });
  await page.goto('/');

  await expect(page).toHaveTitle('Pybrix — 3D Print Repair & Editing');
  for (const rel of ['icon', 'apple-touch-icon']) {
    const href = await page.locator(`link[rel="${rel}"]`).getAttribute('href');
    expect(href, rel).toMatch(/^\/assets\/pybrix-[\w-]+\.png$/);
    const response = await page.request.get(href ?? '');
    expect(response.status(), rel).toBe(200);
    expect(response.headers()['content-type']).toBe('image/png');
  }
  // No request for the conventional /favicon.ico either.
  expect(failures).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});

test('B-02: the header mark and the Help lockup decode, and nothing leaves the origin', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await watchCsp(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  await expect(page.getByTestId('brand-mark')).toBeVisible();
  expect(await decoded(page, 'brand-mark')).toBe(true);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pybrix');
  await expect(page.getByTestId('release-stage')).toHaveText('Technical Preview');

  await page.getByTestId('help-menu').click();
  const about = page.getByRole('region', { name: 'About Pybrix' });
  await expect(about).toBeVisible();
  await expect(page.getByTestId('about-lockup')).toBeVisible();
  await expect.poll(() => decoded(page, 'about-lockup')).toBe(true);
  // Drawn at its reserved size: never stretched.
  const box = await page.getByTestId('about-lockup').boundingBox();
  expect(box?.width).toBeCloseTo(188, 0);
  expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(600 / 202, 1);

  const offOrigin = requests.filter(
    (url) => !url.startsWith(`${ORIGIN}/`) && !url.startsWith('data:') && !url.startsWith('blob:'),
  );
  expect(offOrigin).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('B-03: the brand block reserves its size, so the header never shifts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Hold the mark's bytes back so its box is measured BEFORE it decodes.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/pybrix-tile-96.*\.png$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const title = page.getByRole('heading', { level: 1 });
  await expect(title).toBeVisible();
  const before = await title.boundingBox();
  release();
  await expect.poll(() => decoded(page, 'brand-mark')).toBe(true);
  const after = await title.boundingBox();
  expect(after?.x).toBe(before?.x);
  expect(after?.y).toBe(before?.y);
});

for (const [width, height, chip, name] of [
  [1920, 1080, true, true],
  [1440, 900, true, true],
  [1280, 800, true, true],
  [1024, 768, false, true],
  [768, 1024, false, true],
  [430, 932, false, false],
  [390, 844, false, false],
] as const) {
  test(`B-04: at ${String(width)} px the brand fits its tier`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');

    await expect(page.getByTestId('brand-mark')).toBeVisible();
    expect(await page.getByTestId('release-stage').isVisible()).toBe(chip);
    // Below 600 the name is visually hidden but still the page's heading.
    const title = page.getByRole('heading', { level: 1, name: 'Pybrix' });
    await expect(title).toBeAttached();
    expect((await title.boundingBox())?.width ?? 0).toBeGreaterThan(name ? 20 : -1);
    if (!name) expect((await title.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

    // Nothing in the brand block overlaps what follows it, or leaves the bar.
    const brand = await page.locator('.topbar__brand').boundingBox();
    const next = await page
      .locator('.topbar__start > :not(.topbar__brand):visible')
      .first()
      .boundingBox();
    if (brand === null || next === null) throw new Error('no brand geometry');
    expect(brand.x).toBeGreaterThanOrEqual(0);
    expect(brand.x + brand.width).toBeLessThanOrEqual(next.x + 0.5);
    expect(brand.height).toBeLessThanOrEqual(48);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('B-05: at a short, narrow window Help keeps the lockup and the notices link in reach', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto('/');
  await page.getByTestId('help-menu').click();
  const lockup = page.getByTestId('about-lockup');
  await expect(lockup).toBeVisible();
  const box = await lockup.boundingBox();
  // Never larger than its design size, however much room there is.
  expect(box?.width ?? 0).toBeLessThanOrEqual(188.5);
  await page.getByTestId('third-party-notices').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('third-party-notices')).toBeInViewport();
});

test('B-06: no workspace shows the legacy name, before or after a model is open', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const readable = (): Promise<string> =>
    page.evaluate(() => {
      const names = ['aria-label', 'title', 'alt', 'placeholder', 'data-tooltip'];
      const parts = [document.title, document.body.innerText];
      for (const element of document.querySelectorAll('*'))
        for (const name of names) parts.push(element.getAttribute(name) ?? '');
      return parts.join('\n');
    });

  for (const id of ['repair', 'convert', 'split', 'texture'] as const) {
    await enter(page, id);
    expect(await readable(), id).not.toMatch(LEGACY_NAME);
  }
  await openBox(page);
  for (const id of ['repair', 'convert', 'split', 'texture'] as const) {
    await enter(page, id);
    expect(await readable(), `${id} with a model`).not.toMatch(LEGACY_NAME);
  }
  expect(errors).toEqual([]);
});

test('B-07: the third-party notices are headed Pybrix and keep their licences', async ({
  page,
}) => {
  const response = await page.request.get('/third-party-notices.txt');
  expect(response.status()).toBe(200);
  const text = await response.text();
  expect(text.split('\n')[0]).toBe(
    'Pybrix — third-party notices for software and assets shipped in this build',
  );
  expect(text).toContain('SIL OPEN FONT LICENSE');
});
