import { expect, test, type Locator, type Page } from '@playwright/test';
import { enter, gridBox, openBox, watchErrors } from './ui-fixtures';

/**
 * PR-01: a result computed for one revision must never land on another.
 *
 * Every guard involved is worker-side and unit-tested; these drive the real
 * application through the two shapes the race takes for a user:
 *
 *   - REPLACEMENT: a slow operation is running when a different file is opened.
 *   - SAME DOCUMENT: a slow operation is running when another workspace applies
 *     an edit, moving the document to a new revision.
 *
 * Each test first PROVES the race happened — the operation was still running
 * when the model changed — then asserts the final state, which must hold
 * whichever of the two finished first.
 */

const DENSE = 91; // 12 · 91² = 99,372 triangles: slow enough to overlap.
const DENSE_TRIANGLES = '99,372';

const canvas = (page: Page): Locator => page.locator('[data-testid="viewport-canvas"] canvas');

async function openDense(page: Page): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({ name: 'dense.3mf', mimeType: 'model/3mf', buffer: gridBox(DENSE) });
  await expect(page.getByTestId('status-triangles')).toHaveText(DENSE_TRIANGLES, {
    timeout: 60_000,
  });
}

async function selectTopFace(page: Page): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (box === null) throw new Error('no canvas');
  await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 - 20);
  await expect(page.getByTestId('texture-hud-selection')).toContainText('Selected', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('texture-elements')).toBeVisible({ timeout: 60_000 });
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('a split preview still computing when another file opens never lands on it', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await openDense(page);
  await enter(page, 'split');

  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-progress')).toBeVisible();
  await openBox(page); // 12 triangles, while the split is still running.

  // Give the abandoned split every chance to return, then check nothing of it
  // reached the new document.
  await page.waitForTimeout(6_000);
  await expect(page.getByTestId('status-triangles')).toHaveText('12');
  await expect(page.getByTestId('split-preview-banner')).toHaveCount(0);
  await expect(page.getByTestId('split-preview-label')).toHaveCount(0);
  await expect(canvas(page)).toHaveAttribute('data-tinted-parts', '0');
  await expect(canvas(page)).toHaveAttribute('data-preview-objects', '0');
  // And the new document can be split normally.
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-banner')).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

test('a texture preview still generating when another file opens never lands on it', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await openDense(page);
  await enter(page, 'texture');
  await selectTopFace(page);

  await page.getByTestId('texture-generate').click();
  await expect(page.getByTestId('texture-progress')).toBeVisible();
  await openBox(page);

  await page.waitForTimeout(8_000);
  await expect(page.getByTestId('status-triangles')).toHaveText('12');
  await expect(page.getByTestId('texture-preview-banner')).toHaveCount(0);
  await expect(canvas(page)).toHaveAttribute('data-preview-objects', '0');
  await expect(page.getByTestId('texture-no-selection')).toBeAttached();
  expect(errors).toEqual([]);
});

test('a texture preview still generating when a split is applied never lands on the new revision', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await openDense(page);
  await enter(page, 'texture');
  await selectTopFace(page);

  await page.getByTestId('texture-generate').click();
  await expect(page.getByTestId('texture-progress')).toBeVisible();

  // Another workspace moves the SAME document to a new revision.
  await enter(page, 'split');
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-banner')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-preview-banner')).toHaveCount(0, { timeout: 90_000 });
  const afterSplit = (await page.getByTestId('status-triangles').textContent()) ?? '';
  expect(afterSplit).not.toBe(DENSE_TRIANGLES);

  // The texture work, whenever it finished, belongs to the old revision.
  await page.waitForTimeout(8_000);
  await enter(page, 'texture');
  await expect(page.getByTestId('texture-preview-banner')).toHaveCount(0);
  await expect(canvas(page)).toHaveAttribute('data-preview-objects', '0');
  await expect(page.getByTestId('status-triangles')).toHaveText(afterSplit);
  expect(errors).toEqual([]);
});
