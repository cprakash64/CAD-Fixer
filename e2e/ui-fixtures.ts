import { expect, type Locator, type Page } from '@playwright/test';
import { modelXml, threeMf } from './format-fixtures';
import { binaryStlFrom, type Point } from './stl-fixtures';

/**
 * Shared fixtures for the cross-workspace UI suites (UI-06): deterministic
 * models built at test time and the few steps every UI suite repeats.
 */

export type Triangle = readonly [Point, Point, Point];

/** A 20 mm open box with one reversed side and a zero-area sliver. */
export function defects(): Triangle[] {
  const s = 20;
  const v = (x: number, y: number, z: number): Point => [x * s, y * s, z * s];
  const t: Triangle[] = [
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0)],
    [v(0, 0, 0), v(1, 1, 0), v(1, 0, 0)],
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1)],
    [v(0, 0, 0), v(1, 0, 1), v(0, 0, 1)],
    [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1)],
    [v(0, 1, 0), v(1, 1, 1), v(1, 1, 0)],
    [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1)],
    [v(0, 0, 0), v(0, 1, 1), v(0, 1, 0)],
    [v(1, 0, 0), v(1, 1, 1), v(1, 1, 0)],
    [v(1, 0, 0), v(1, 1, 1), v(1, 0, 1)],
  ];
  t.push([
    [40, 0, 0],
    [45, 0, 0],
    [50, 0, 0],
  ]);
  return t;
}

/** A millimetre box 40 × 20 × 60 with three distinct face areas. */
export function boxModel(): Buffer {
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
  const mesh = `<mesh><vertices>${v
    .map(([x, y, z]) => `<vertex x="${String(x)}" y="${String(y)}" z="${String(z)}"/>`)
    .join('')}</vertices><triangles>${t
    .map(([a, b, c]) => `<triangle v1="${String(a)}" v2="${String(b)}" v3="${String(c)}"/>`)
    .join('')}</triangles></mesh>`;
  return threeMf(
    modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model" name="Box">${mesh}</object>`,
    }),
  );
}

export async function pick(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType, buffer });
}

export async function openBox(page: Page): Promise<void> {
  await pick(page, 'box.3mf', 'model/3mf', boxModel());
  await expect(page.getByTestId('status-triangles')).toHaveText('12', { timeout: 60_000 });
}

export async function openDefects(page: Page): Promise<void> {
  await pick(page, 'defects.stl', 'model/stl', binaryStlFrom(defects()));
  await expect(page.getByTestId('issue-list')).toBeAttached({ timeout: 60_000 });
}

/** Switches workspace through whichever control this width shows. */
export async function enter(
  page: Page,
  id: 'repair' | 'convert' | 'split' | 'texture',
): Promise<void> {
  const tab = page.getByTestId(`workflow-${id}`);
  if (await tab.isVisible()) await tab.click();
  else {
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId(`workspace-option-${id}`).click();
  }
}

export const canvas = (page: Page): Locator =>
  page.locator('[data-testid="viewport-canvas"] canvas');

/** Clicks the box's large front-right face, as the texture workspace spec does. */
export async function selectFace(page: Page): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (box === null) throw new Error('no canvas');
  await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 - 20);
  // The HUD, not the panel's metrics: on a phone the panel is a closed drawer.
  await expect(page.getByTestId('texture-hud-selection')).toContainText('Selected', {
    timeout: 30_000,
  });
}

/** Whether an element lies wholly inside the window. */
export async function inWindow(page: Page, locator: Locator): Promise<boolean> {
  const rect = await locator.boundingBox();
  const size = page.viewportSize();
  if (rect === null || size === null) return false;
  return rect.y >= 0 && rect.y + rect.height <= size.height && rect.x >= 0;
}

export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/**
 * A millimetre box 40 × 20 × 60 subdivided n × n per face — 12·n² triangles,
 * indexed so every edge is shared: a closed, consistently wound solid Split and
 * Texture accept, dense enough that their work takes measurable time.
 */
export function gridBox(n: number): Buffer {
  const size = [40, 20, 60];
  const vertices: string[] = [];
  const index = new Map<string, number>();
  const triangles: string[] = [];
  const at = (p: readonly number[]): number => {
    const key = p.join(',');
    let id = index.get(key);
    if (id === undefined) {
      id = vertices.length;
      index.set(key, id);
      vertices.push(`<vertex x="${String(p[0])}" y="${String(p[1])}" z="${String(p[2])}"/>`);
    }
    return id;
  };
  // Each face: the fixed axis, its side, and the two axes it spans.
  const faces: readonly (readonly [number, number, number, number])[] = [
    [2, 1, 0, 1],
    [2, 0, 0, 1],
    [1, 1, 2, 0],
    [1, 0, 2, 0],
    [0, 1, 1, 2],
    [0, 0, 1, 2],
  ];
  for (const [axis, side, u, v] of faces) {
    const rightHanded = ['012', '120', '201'].includes(`${String(axis)}${String(u)}${String(v)}`);
    const outward = (side === 1) === rightHanded;
    for (let i = 0; i < n; i += 1)
      for (let j = 0; j < n; j += 1) {
        const corner = (di: number, dj: number): number => {
          const p = [0, 0, 0];
          p[axis] = side * (size[axis] ?? 0);
          p[u] = ((i + di) / n) * (size[u] ?? 0);
          p[v] = ((j + dj) / n) * (size[v] ?? 0);
          return at(p);
        };
        const [a, b, c, d] = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
        const tri = (x: number, y: number, z: number): string =>
          `<triangle v1="${String(x)}" v2="${String(y)}" v3="${String(z)}"/>`;
        triangles.push(outward ? tri(a, b, c) + tri(a, c, d) : tri(a, c, b) + tri(a, d, c));
      }
  }
  return threeMf(
    modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model" name="Grid box"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object>`,
    }),
  );
}
