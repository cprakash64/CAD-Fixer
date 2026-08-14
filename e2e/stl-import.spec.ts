import { expect, test, type Page } from '@playwright/test';
import { asciiStl, binaryStl, binaryStlWithSolidHeader, truncatedBinaryStl } from './stl-fixtures';

/**
 * The STL pipeline, end to end, in a real browser against the production build.
 *
 * Everything here runs through the REAL module worker and the REAL WebGL
 * viewport. Nothing is stubbed: a test that mocked the worker would prove only
 * that the mock works.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

/** Reads what the viewport actually drew, not what React state claims. */
async function readSceneStats(page: Page): Promise<{ drawCalls: number; triangles: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport-canvas"] canvas',
    );
    return {
      drawCalls: Number(canvas?.dataset.drawCalls ?? 0),
      triangles: Number(canvas?.dataset.renderedTriangles ?? 0),
    };
  });
}

test('imports a binary STL and displays it', async ({ page }) => {
  await page.goto('/');
  const { bytes, triangles } = binaryStl(2000);

  await openFile(page, 'bracket.stl', bytes);

  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
    timeout: 20_000,
  });
  await expect(page.getByTestId('fact-encoding')).toHaveText('binary');
  await expect(page.getByTestId('fact-vertices')).toHaveText((triangles * 3).toLocaleString());
  await expect(page.getByTestId('validation-summary')).toHaveText('Structurally valid');

  // The empty-workspace notice must be gone and the fit control available,
  // which only happens once a model is actually in the scene.
  await expect(page.getByTestId('viewport-empty')).toHaveCount(0);
  await expect(page.getByTestId('fit-view')).toBeVisible();
});

test('actually renders geometry, not just React state', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'bracket.stl', binaryStl(1200).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('1,200', { timeout: 20_000 });

  const stats = await readSceneStats(page);

  // The renderer reports what it drew on the previous frame. A non-zero
  // triangle count proves the pipeline reached the GPU.
  expect(stats.drawCalls).toBeGreaterThan(0);
  expect(stats.triangles).toBeGreaterThan(0);
});

test('imports an ASCII STL', async ({ page }) => {
  await page.goto('/');
  const { bytes, triangles } = asciiStl(300);

  await openFile(page, 'bracket-ascii.stl', bytes);

  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
    timeout: 20_000,
  });
  await expect(page.getByTestId('fact-encoding')).toHaveText('ascii');
});

test('detects a binary STL whose header begins with "solid"', async ({ page }) => {
  await page.goto('/');
  const { bytes, triangles } = binaryStlWithSolidHeader(500);

  await openFile(page, 'misleading.stl', bytes);

  // The classic detection failure: this file must not be read as ASCII.
  await expect(page.getByTestId('fact-encoding')).toHaveText('binary', { timeout: 20_000 });
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString());
});

test('states that STL units are unspecified rather than inventing millimetres', async ({
  page,
}) => {
  await page.goto('/');

  await openFile(page, 'bracket.stl', binaryStl(50).bytes);

  await expect(page.getByTestId('fact-units')).toHaveText('Unspecified by STL', {
    timeout: 20_000,
  });
});

test('reports bounding-box dimensions', async ({ page }) => {
  await page.goto('/');

  await openFile(page, 'bracket.stl', binaryStl(600).bytes);

  await expect(page.getByTestId('fact-size')).not.toBeEmpty({ timeout: 20_000 });
  await expect(page.getByTestId('fact-size')).toContainText('×');
});

test('fit view keeps the model on screen', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'bracket.stl', binaryStl(800).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('800', { timeout: 20_000 });

  await page.getByTestId('fit-view').click();

  const stats = await readSceneStats(page);
  expect(stats.triangles).toBeGreaterThan(0);
});

test('rejects a truncated binary STL and keeps the workspace empty', async ({ page }) => {
  await page.goto('/');

  await openFile(page, 'broken.stl', truncatedBinaryStl());

  await expect(page.getByTestId('status-list')).toContainText('truncated', { timeout: 20_000 });
  await expect(page.getByTestId('model-empty')).toBeVisible();
});

test('a failed replacement import keeps the previously loaded model', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'good.stl', binaryStl(700).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('700', { timeout: 20_000 });

  await openFile(page, 'broken.stl', truncatedBinaryStl());
  await expect(page.getByTestId('status-list')).toContainText('truncated', { timeout: 20_000 });

  // The user's loaded model must survive someone else's broken file.
  await expect(page.getByTestId('fact-filename')).toHaveText('good.stl');
  await expect(page.getByTestId('fact-triangles')).toHaveText('700');
});

test('a successful replacement import swaps the model', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'first.stl', binaryStl(400).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('400', { timeout: 20_000 });

  await openFile(page, 'second.stl', binaryStl(900).bytes);

  await expect(page.getByTestId('fact-triangles')).toHaveText('900', { timeout: 20_000 });
  await expect(page.getByTestId('fact-filename')).toHaveText('second.stl');
});

test('loading many models does not grow the scene graph', async ({ page }) => {
  await page.goto('/');

  for (const triangles of [100, 200, 300, 400]) {
    await openFile(page, `model-${String(triangles)}.stl`, binaryStl(triangles).bytes);
    await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
      timeout: 20_000,
    });
  }

  // One model object, regardless of how many have been loaded. A leak here
  // would mean every import left its GPU buffers behind.
  const objects = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport-canvas"] canvas',
    );
    return Number(canvas?.dataset.modelObjects ?? -1);
  });
  expect(objects).toBe(1);
});

test('the main thread stays responsive while a large STL parses', async ({ page }) => {
  await page.goto('/');

  // Big enough that parsing on the UI thread would visibly block. The assertion
  // is not a millisecond threshold — those flake across machines — but that the
  // page keeps responding to real input while the parse is in flight.
  const { bytes } = binaryStl(900_000);
  await openFile(page, 'large.stl', bytes);

  await expect(page.getByTestId('import-progress')).toBeVisible({ timeout: 20_000 });

  // Interact with the page while the worker is busy. If parsing were happening
  // on the main thread these clicks could not be serviced until it finished.
  let interactionsDuringParse = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await page.getByTestId('import-progress').isVisible()) {
      await page.getByTestId('workflow-repair').hover({ timeout: 2000 });
      interactionsDuringParse += 1;
    }
  }
  expect(interactionsDuringParse).toBeGreaterThan(0);

  await expect(page.getByTestId('fact-triangles')).toHaveText((900_000).toLocaleString(), {
    timeout: 120_000,
  });
});

test('a cancelled import leaves the previous model in place', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'keep-me.stl', binaryStl(500).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('500', { timeout: 20_000 });

  await openFile(page, 'huge.stl', binaryStl(900_000).bytes);
  await expect(page.getByTestId('import-progress')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('cancel-import').click();

  await expect(page.getByTestId('status-list')).toContainText('cancelled', { timeout: 60_000 });
  await expect(page.getByTestId('fact-filename')).toHaveText('keep-me.stl');
  await expect(page.getByTestId('fact-triangles')).toHaveText('500');
});
