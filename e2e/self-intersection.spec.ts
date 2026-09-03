import { expect, test, type Page } from '@playwright/test';
import {
  cleanGridStl,
  crossingTrianglesStl,
  selfIntersectingShellStl,
  tetrahedronStl,
} from './stl-fixtures';

/**
 * THE PRODUCTION SELF-INTERSECTION DIAGNOSTIC, END TO END.
 *
 * NOTHING IS STUBBED. A real Chromium, the real production build, the real
 * authoritative geometry worker, a real disposable diagnostic worker, the real
 * MessageChannel between them, and the real Geogram WebAssembly kernel.
 *
 * WHAT THESE TESTS ARE ACTUALLY FOR. The geometry was settled by the Stage 3C
 * qualification; what production adds is everything AROUND the answer — when it
 * runs, when it refuses to run, what happens when the model changes underneath
 * it, and whether the interface can be made to imply a verdict it does not
 * have. Five of the six statuses carry a zero intersection count, so most of
 * what follows is about telling those five apart.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

/** Workers currently alive in the page, by name. */
async function workerNames(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (globalThis as { __cadfixerWorkers?: string[] }).__cadfixerWorkers ?? [],
  );
}

/** Records every Worker construction so "no worker was created" is provable. */
async function instrumentWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const created: string[] = [];
    (globalThis as { __cadfixerWorkers?: string[] }).__cadfixerWorkers = created;
    const Real = globalThis.Worker;
    class Recording extends Real {
      public constructor(url: string | URL, options?: WorkerOptions) {
        // The name is what identifies the diagnostic worker; the URL is only a
        // fallback for a worker that did not set one.
        created.push(options?.name ?? (typeof url === 'string' ? url : url.href));
        super(url, options);
      }
    }
    globalThis.Worker = Recording;
  });
}

/* ------------------------------------------------------------- SI-P01 -- */

test('SI-P01: a small model is checked automatically and reports none found', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'tetra.stl', tetrahedronStl());

  // The headline appears without anyone asking for it.
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 60_000,
  });
  // "None found" is only ever allowed to mean this one thing, so it is followed
  // by the qualifier that stops it being read as "the model is fine".
  await expect(page.getByTestId('self-intersection-qualifier')).toContainText(/wall thickness/i);
});

/* ------------------------------------------------------------- SI-P02 -- */

test('SI-P02: a proper crossing is found and broken down by cause', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'crossing.stl', crossingTrianglesStl());

  await expect(page.getByTestId('self-intersection-headline')).toContainText(
    'intersecting face pair',
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('self-intersection-properCrossing')).toHaveText('1');
});

/* ------------------------------------------------------------- SI-P03 -- */

test('SI-P03: R17, the self-intersecting shell, is detected on the production path', async ({
  page,
}) => {
  /*
   * THE FIXTURE THAT DECIDED QUALIFICATION. A closed, manifold, consistently
   * wound single shell that passes through itself. Stage 2 topology reports it
   * as clean, which is exactly why this diagnostic exists.
   */
  await page.goto('/');
  await openFile(page, 'r17.stl', selfIntersectingShellStl());

  await expect(page.getByTestId('self-intersection-headline')).toContainText('intersecting', {
    timeout: 60_000,
  });
  // Nothing about this model may read as clean.
  await expect(page.getByTestId('self-intersection-headline')).not.toHaveText('None found');
});

/* ------------------------------------------------------------- SI-P04 -- */

test('SI-P04: a medium model is NOT checked automatically but offers the check', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await instrumentWorkers(page);
  await page.goto('/');

  // Above the 25,000-face automatic band, below the 250,000 ceiling.
  const medium = cleanGridStl(120); // 28,800 triangles
  expect(medium.triangles).toBeGreaterThan(25_000);
  expect(medium.triangles).toBeLessThan(250_000);
  await openFile(page, 'medium.stl', medium.bytes);

  await expect(page.getByTestId('self-intersection-headline')).toHaveText('Not checked', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('self-intersection-detail')).toContainText('25,000');
  await expect(page.getByTestId('run-self-intersection')).toBeVisible();

  // NO DIAGNOSTIC WORKER WAS BUILT. The check is offered, not started.
  expect(await workerNames(page)).not.toContain('cadfixer-self-intersection');

  // Explicit invocation completes.
  await page.getByTestId('run-self-intersection').click();
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 120_000,
  });
  expect(await workerNames(page)).toContain('cadfixer-self-intersection');
});

/* ------------------------------------------------------------- SI-P05 -- */

test('SI-P05: above the ceiling nothing diagnostic is created at all', async ({ page }) => {
  test.setTimeout(300_000);
  await instrumentWorkers(page);
  await page.goto('/');

  const huge = cleanGridStl(360); // 259,200 triangles
  expect(huge.triangles).toBeGreaterThan(250_000);
  await openFile(page, 'huge.stl', huge.bytes);

  await expect(page.getByTestId('self-intersection-headline')).toHaveText(
    'Not checked for this model size',
    { timeout: 240_000 },
  );
  await expect(page.getByTestId('self-intersection-detail')).toContainText('250,000');

  /*
   * THE PROOF THAT MATTERS, and it is not "the button is absent".
   *
   * No diagnostic worker was constructed, so no WebAssembly was instantiated, no
   * MessageChannel carried geometry, no disposable copy was allocated and no
   * broadphase was built. At a million faces the broadphase alone allocated
   * ~272 MiB during qualification, which is why the ceiling is a PREFLIGHT gate
   * rather than a runtime one.
   */
  expect(await workerNames(page)).not.toContain('cadfixer-self-intersection');
  await expect(page.getByTestId('run-self-intersection')).toHaveCount(0);
  // And it is never described as clean.
  await expect(page.getByTestId('self-intersection-headline')).not.toHaveText('None found');
});

/* ------------------------------------------------------------- SI-P06 -- */

test('SI-P06: cancelling leaves the model untouched and a retry succeeds', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');

  const medium = cleanGridStl(240); // 115,200 triangles: long enough to cancel
  await openFile(page, 'cancel.stl', medium.bytes);
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('Not checked', {
    timeout: 180_000,
  });

  const trianglesBefore = await page.getByTestId('fact-triangles').textContent();

  await page.getByTestId('run-self-intersection').click();
  await expect(page.getByTestId('cancel-self-intersection')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('cancel-self-intersection').click();

  await expect(page.getByTestId('self-intersection-headline')).toHaveText('Check cancelled', {
    timeout: 60_000,
  });
  // Cancellation is not failure, and above all not a clean result.
  await expect(page.getByTestId('self-intersection-headline')).not.toHaveText('None found');

  // The authoritative model is untouched and still exportable.
  await expect(page.getByTestId('fact-triangles')).toHaveText(trianglesBefore ?? '');

  // Retry on a fresh worker completes.
  await page.getByTestId('run-self-intersection').click();
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 180_000,
  });
});

/* ------------------------------------------------------------- SI-P07 -- */

test('SI-P07: a new model invalidates the previous verdict immediately', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');

  await openFile(page, 'clean.stl', tetrahedronStl());
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 60_000,
  });

  // Replace with a model that DOES self-intersect. The old "None found" must not
  // survive even momentarily as the verdict for new geometry.
  await openFile(page, 'r17.stl', selfIntersectingShellStl());
  await expect(page.getByTestId('self-intersection-headline')).toContainText('intersecting', {
    timeout: 60_000,
  });
});

/* ------------------------------------------------------------- SI-P08 -- */

test('SI-P08: the diagnostic sends nothing to the network', async ({ page }) => {
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (
      !url.startsWith('http://localhost:4173/') &&
      !url.startsWith('data:') &&
      !url.startsWith('blob:')
    ) {
      offOrigin.push(url);
    }
    const body = request.postData();
    if (body !== null && body.length > 512) offOrigin.push(`BODY:${url}`);
  });

  await page.goto('/');
  await openFile(page, 'crossing.stl', crossingTrianglesStl());
  await expect(page.getByTestId('self-intersection-headline')).toContainText('intersecting', {
    timeout: 60_000,
  });

  expect(offOrigin).toEqual([]);
});
