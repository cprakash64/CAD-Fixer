import { expect, test, type Page } from '@playwright/test';
import { modelXml, threeMf } from './format-fixtures';

/**
 * UI-05: the Surface Texture workspace in the shipped application.
 *
 * Every selection is a real worker region grown from a real ray pick, every
 * layout the engine's own, every preview a real Boolean. The fixture is a
 * millimetre box 40 × 20 × 60 whose faces have three different areas, so a
 * metric taken from the wrong face — or from the whole part — cannot match.
 */

const FACE_AREAS = ['800', '1,200', '2,400'];

function boxMesh(): string {
  const [x0, y0, z0, x1, y1, z1] = [5, 7, 10, 45, 27, 70];
  const v = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x0, y1, z0],
    [x1, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x0, y1, z1],
    [x1, y1, z1],
  ];
  const t = [
    [0, 2, 3],
    [0, 3, 1],
    [4, 5, 7],
    [4, 7, 6],
    [0, 1, 5],
    [0, 5, 4],
    [2, 6, 7],
    [2, 7, 3],
    [0, 4, 6],
    [0, 6, 2],
    [1, 3, 7],
    [1, 7, 5],
  ];
  return `<mesh><vertices>${v
    .map(([x, y, z]) => `<vertex x="${String(x)}" y="${String(y)}" z="${String(z)}"/>`)
    .join('')}</vertices><triangles>${t
    .map(([a, b, c]) => `<triangle v1="${String(a)}" v2="${String(b)}" v3="${String(c)}"/>`)
    .join('')}</triangles></mesh>`;
}

async function openBox(page: Page): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: 'box.3mf',
    mimeType: 'model/3mf',
    buffer: threeMf(
      modelXml({
        unit: 'millimeter',
        resources: `<object id="1" type="model" name="Box">${boxMesh()}</object>`,
      }),
    ),
  });
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
}

const canvas = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-testid="viewport-canvas"] canvas');

async function enterTexture(page: Page): Promise<void> {
  await page.getByTestId('workflow-texture').click();
  await expect(page.getByTestId('texture-workspace')).toBeVisible();
}

/** Clicks the box's large front-right face — in the view's centre-right. */
async function selectFace(page: Page): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (box === null) throw new Error('no canvas');
  await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 - 20);
  await expect(page.getByTestId('texture-selection-metrics')).toBeVisible({ timeout: 30_000 });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('A: the overview offers only real tools, patterns and mapping', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await openBox(page);
  await enterTexture(page);
  await expect(page.getByTestId('workspace-header')).toContainText('Surface Texture');
  await expect(page.getByRole('group', { name: 'Selection tool' })).toContainText('Flat region');
  await expect(page.getByRole('radiogroup', { name: 'Pattern' }).getByRole('radio')).toHaveCount(3);
  await expect(page.getByTestId('texture-projection')).toContainText('Flat');
  await expect(page.getByTestId('texture-workspace')).not.toContainText(
    /Brush|Lasso|Upload image|Cylindrical|Triplanar|Subdivision/,
  );
  await expect(page.getByTestId('texture-hud-detail')).toHaveText(
    'Click a flat face of the model to select it',
  );
  await expect(page.getByTestId('texture-generate')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('B/C: a click selects a real flat region, measured everywhere alike, and Clear removes it', async ({
  page,
}) => {
  await page.goto('/');
  await openBox(page);
  await enterTexture(page);
  await selectFace(page);

  // One of the box's three face areas — not the part's 8,800 mm².
  const area = ((await page.getByTestId('texture-area').textContent()) ?? '').replace(' mm²', '');
  expect(FACE_AREAS).toContain(area);
  await expect(page.getByTestId('texture-triangles')).toHaveText('2 triangles');
  // The HUD and the inspector read the same selection.
  await expect(page.getByTestId('texture-hud-selection')).toContainText(`Selected ${area} mm²`);
  await expect(page.getByTestId('texture-inspector-area')).toHaveText(`${area} mm²`);
  const coverage = Math.round((Number(area.replace(',', '')) / 8800) * 100);
  await expect(page.getByTestId('texture-coverage')).toHaveText(`${String(coverage)}% of surface`);
  // The highlight is the worker's two faces, drawn by the renderer.
  await expect(canvas(page)).toHaveAttribute('data-texture-selection-triangles', '2');

  await page.getByTestId('texture-clear').click();
  await expect(page.getByTestId('texture-no-selection')).toBeVisible();
  await expect(canvas(page)).toHaveAttribute('data-texture-selection-triangles', '0');
  await expect(page.getByTestId('fact-triangles')).toHaveText('12');
});

test('D/E/F: pattern, rotation and spacing change the engine’s real layout', async ({ page }) => {
  await page.goto('/');
  await openBox(page);
  await enterTexture(page);
  await selectFace(page);

  const elements = async (): Promise<number> => {
    await expect(page.getByTestId('texture-elements')).toBeVisible({ timeout: 30_000 });
    return Number(
      ((await page.getByTestId('texture-elements').textContent()) ?? '').split(' of ')[0],
    );
  };
  const dots = await elements();
  expect(dots).toBeGreaterThan(0);
  // A dot's outline is 24 edges on the face.
  await expect(canvas(page)).toHaveAttribute('data-texture-footprint-edges', String(dots * 24));

  // Lines: a different layout, four edges per bar.
  await page.getByTestId('texture-pattern-lines').check();
  await expect(page.getByTestId('texture-inspector-source')).toHaveText('Lines');
  const lines = await elements();
  await expect(canvas(page)).toHaveAttribute('data-texture-footprint-edges', String(lines * 4));

  // Rotation is real: the same bars at 90° lay out differently on a 3:1 face.
  await page.getByTestId('texture-rotation').fill('90');
  await expect(canvas(page)).not.toHaveAttribute(
    'data-texture-footprint-edges',
    String(lines * 4),
    { timeout: 10_000 },
  );

  // Wider spacing places fewer elements.
  await page.getByTestId('texture-pattern-dots').check();
  await page.getByTestId('texture-spacing').fill('10');
  await expect.poll(elements).toBeLessThan(dots);
  // And still nothing has changed in the model.
  await expect(page.getByTestId('fact-triangles')).toHaveText('12');
});

test('G/H: Apply builds validated geometry, retires the selection, and Undo restores it', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await openBox(page);
  await enterTexture(page);
  await canvas(page).evaluate((element) => {
    element.dataset.probe = 'original';
  });
  await selectFace(page);
  await page.getByTestId('texture-engraved').click();

  await page.getByTestId('texture-generate').click();
  await expect(page.getByTestId('texture-preview-banner')).toBeVisible({ timeout: 60_000 });
  const result = Number(
    ((await page.getByTestId('texture-result-triangles').textContent()) ?? '').replace(/\D/g, ''),
  );
  expect(result).toBeGreaterThan(12);
  // A preview is not an application.
  await expect(page.getByTestId('fact-triangles')).toHaveText('12');

  await page.getByTestId('texture-apply').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText(result.toLocaleString(), {
    timeout: 60_000,
  });
  // The old face ids index a mesh that no longer exists: no selection remains.
  await expect(page.getByTestId('texture-no-selection')).toBeVisible();
  await expect(canvas(page)).toHaveAttribute('data-texture-selection-triangles', '0');
  await expect(canvas(page)).toHaveAttribute('data-probe', 'original');

  await page.getByTestId('texture-undo').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
  expect(errors).toEqual([]);
});

test('a layout past the engine’s limit is refused before any geometry, and says why', async ({
  page,
}) => {
  await page.goto('/');
  await openBox(page);
  await enterTexture(page);
  await selectFace(page);
  await page.getByTestId('texture-feature-size').fill('0.2');
  await page.getByTestId('texture-spacing').fill('0.4');
  const error = page.getByTestId('texture-layout-error');
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText('limit is');
  await expect(page.getByTestId('texture-generate')).toBeDisabled();
  await expect(page.getByTestId('fact-triangles')).toHaveText('12');
});

for (const width of [430, 390] as const) {
  test(`J: at ${String(width)} px the workspace works in its drawer`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 430 ? 932 : 844 });
    await page.goto('/');
    await openBox(page);
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace-option-texture').click();
    // Select on the viewport first, with the drawer closed.
    const box = await canvas(page).boundingBox();
    if (box === null) throw new Error('no canvas');
    await page.mouse.click(box.x + box.width / 2 + 30, box.y + box.height / 2 - 10);
    await expect(page.getByTestId('texture-hud-selection')).toContainText('Selected', {
      timeout: 30_000,
    });

    await page.getByTestId('toggle-tool-drawer').click();
    const panel = page.getByTestId('tool-panel');
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(page.getByTestId('texture-selection-metrics')).toBeVisible();
    await page.getByTestId('texture-pattern-lines').check();
    const card = await page.getByTestId('texture-pattern-lines').boundingBox();
    expect(card?.width ?? 0).toBeGreaterThanOrEqual(80);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    for (let step = 0; step < 30; step += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () => document.getElementById('tool-panel')?.contains(document.activeElement) ?? false,
        ),
      ).toBe(true);
    }
  });
}
