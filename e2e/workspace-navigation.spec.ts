import { expect, test, type Page } from '@playwright/test';
import { canvas, enter, openBox, watchErrors } from './ui-fixtures';

/**
 * UI-07A: ONE workspace selector, and every implemented workspace enterable.
 *
 * Measured in a real browser because what matters here — which selector is on
 * screen at a width, whether the navigation is centred, whether zones collide,
 * whether a CSS tooltip appears on hover and on keyboard focus — is layout that
 * jsdom cannot compute. The component-level rules are in `App.test.tsx`.
 */

const IMPLEMENTED = ['repair', 'convert', 'split', 'texture'] as const;

const EMPTY_MESSAGE = {
  repair: 'Open a 3D model to analyze and repair mesh issues.',
  convert: 'Open a 3D model to convert or export it.',
  split: 'Open a 3D model to split it into parts.',
  texture: 'Open a 3D model to add surface texture.',
} as const;

/** How many workspace selectors are actually on screen. */
async function visibleSelectors(page: Page): Promise<number> {
  let count = 0;
  for (const id of ['workspace-nav', 'workspace-switcher'])
    if (await page.getByTestId(id).isVisible()) count += 1;
  return count;
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The CSS tooltip's visibility, read off the `::after` it is drawn in. */
async function tooltip(page: Page, testId: string): Promise<{ text: string; shown: boolean }> {
  return page.getByTestId(testId).evaluate((element) => {
    const style = getComputedStyle(element, '::after');
    return {
      text: style.content,
      shown: style.visibility === 'visible' && Number(style.opacity) > 0.9,
    };
  });
}

test('A: with no model, every implemented workspace can be entered from the navigation', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  for (const id of IMPLEMENTED) {
    const tab = page.getByTestId(`workflow-${id}`);
    await expect(tab).toBeEnabled();
    await expect(tab).not.toHaveAttribute('aria-disabled');
    await tab.click();
    await expect(tab).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-testid^="workflow-"][aria-current="page"]')).toHaveCount(1);
    await expect(page.getByTestId('workspace-empty')).toHaveAttribute('data-workflow', id);
  }

  // Nothing about entering an empty workspace creates a model.
  await expect(page.getByTestId('topbar-export')).toBeDisabled();
  await expect(page.getByTestId('drop-zone')).toBeVisible();
  await expect(page.getByTestId('workspace-nav')).not.toContainText(
    /Open a model first|Not implemented/,
  );
  expect(errors).toEqual([]);
});

test('B: Hollow says it is coming soon on hover and on keyboard focus, and cannot be entered', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const hollow = page.getByTestId('workflow-hollow');

  await expect(hollow).toBeVisible();
  await expect(hollow).toHaveAttribute('aria-disabled', 'true');
  await expect(hollow).toHaveAccessibleName('Hollow — coming soon');
  await expect(hollow).toContainText('Soon');

  await hollow.hover();
  await expect
    .poll(() => tooltip(page, 'workflow-hollow'))
    .toEqual({
      text: '"Hollow — coming soon"',
      shown: true,
    });

  // Clicking does nothing: the current workspace does not change. `force`
  // only skips Playwright's own wait for an enabled element — aria-disabled
  // is exactly what it waits on — and still clicks with the real mouse.
  await hollow.click({ force: true });
  await expect(hollow).not.toHaveAttribute('aria-current');
  await expect(page.getByTestId('workflow-repair')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('workspace-header')).toContainText('Repair');

  // Keyboard: reachable by Tab, tooltip immediately, Enter and Space inert.
  await page.mouse.move(5, 500);
  await page.getByTestId('workflow-texture').focus();
  await page.keyboard.press('Tab');
  await expect(hollow).toBeFocused();
  await expect.poll(() => tooltip(page, 'workflow-hollow')).toMatchObject({ shown: true });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(hollow).not.toHaveAttribute('aria-current');
  await expect(page.getByTestId('workflow-repair')).toHaveAttribute('aria-current', 'page');
  expect(errors).toEqual([]);
});

test('C: an empty workspace says what it does and opens the same file picker', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  for (const id of ['convert', 'split', 'texture'] as const) {
    await page.getByTestId(`workflow-${id}`).click();
    const empty = page.getByTestId('workspace-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No model loaded');
    await expect(empty).toContainText(EMPTY_MESSAGE[id]);
    // Exactly one empty state in the panel; the viewport keeps the drop target.
    await expect(page.getByTestId('workspace-empty')).toHaveCount(1);
    await expect(page.getByTestId('drop-zone')).toBeVisible();

    const open = page.getByTestId(`workspace-empty-open-${id}`);
    await expect(open).toBeEnabled();
    const chooser = page.waitForEvent('filechooser');
    await open.click();
    await chooser;
  }

  // The commands that need a model are still guarded.
  await page.getByTestId('workflow-convert').click();
  await expect(page.getByTestId('convert-export')).toBeDisabled();
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-preview')).toBeDisabled();
  await page.getByTestId('workflow-texture').click();
  await expect(page.getByTestId('texture-generate')).toBeDisabled();
  // And an empty texture workspace claims no preview.
  await expect(page.getByTestId('texture-preview-banner')).toHaveCount(0);
});

for (const [width, height] of [
  [1920, 1080],
  [1440, 900],
  [1280, 800],
] as const) {
  test(`D: at ${String(width)} px one centred workspace navigation, and no dropdown`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');

    await expect(page.getByTestId('workspace-nav')).toBeVisible();
    await expect(page.getByTestId('workspace-switcher')).toBeHidden();
    expect(await visibleSelectors(page)).toBe(1);

    // Centred on the bar itself, not on what the left-hand controls leave.
    const bar = await page.locator('.topbar').boundingBox();
    const nav = await page.getByTestId('workspace-nav').boundingBox();
    if (bar === null || nav === null) throw new Error('no top bar geometry');
    expect(Math.abs(nav.x + nav.width / 2 - (bar.x + bar.width / 2))).toBeLessThanOrEqual(2);
  });
}

for (const [width, height] of [
  [1440, 900],
  [1280, 800],
  [1200, 800],
  [1024, 768],
  [900, 800],
  [768, 1024],
  [600, 900],
  [430, 932],
  [390, 844],
] as const) {
  test(`E: at ${String(width)} px the top bar has one selector, no collisions and no overflow`, async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width, height });
    await page.goto('/');
    expect(await visibleSelectors(page)).toBe(1);
    await noHorizontalOverflow(page);

    const rect = async (selector: string): Promise<{ x: number; width: number }> => {
      const found = await page.locator(selector).boundingBox();
      if (found === null) throw new Error(`${selector} has no box`);
      return found;
    };
    const start = await rect('.topbar__start');
    const end = await rect('.topbar__end');
    expect(start.x).toBeGreaterThanOrEqual(0);
    expect(end.x + end.width).toBeLessThanOrEqual(width);
    // Every visible control lies inside its own zone. Measured per child
    // rather than with `scrollWidth`, which also counts the hidden CSS
    // tooltips positioned beside each button.
    const escaped = await page.evaluate(() =>
      ['.topbar__start', '.topbar__end'].flatMap((selector) => {
        const zone = document.querySelector(selector);
        if (zone === null) return [`${selector} missing`];
        const outer = zone.getBoundingClientRect();
        return [...zone.children]
          .map((child) => ({ child, box: child.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0)
          .filter(({ box }) => box.left < outer.left - 0.5 || box.right > outer.right + 0.5)
          .map(({ child }) => child.className);
      }),
    );
    expect(escaped).toEqual([]);

    if (width >= 1024) {
      const nav = await rect('[data-testid="workspace-nav"]');
      expect(start.x + start.width).toBeLessThanOrEqual(nav.x);
      expect(nav.x + nav.width).toBeLessThanOrEqual(end.x);
      await page.getByTestId('workflow-split').click();
      await expect(page.getByTestId('workflow-split')).toHaveAttribute('aria-current', 'page');
    } else {
      expect(start.x + start.width).toBeLessThanOrEqual(end.x);
      const trigger = page.getByTestId('workspace-switcher');
      await trigger.click();
      for (const id of IMPLEMENTED)
        await expect(page.getByTestId(`workspace-option-${id}`)).not.toHaveAttribute(
          'aria-disabled',
        );
      await expect(page.getByTestId('workspace-option-hollow')).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await expect(page.getByTestId('workspace-option-hollow')).toContainText('Coming soon');
      await expect(page.locator('.workspace-switcher__menu')).not.toContainText(
        /Open a model first|Not implemented/,
      );
      const menu = await rect('.workspace-switcher__menu');
      expect(menu.x).toBeGreaterThanOrEqual(0);
      expect(menu.x + menu.width).toBeLessThanOrEqual(width);

      // Hollow does nothing and leaves the menu open.
      await page.getByTestId('workspace-option-hollow').click({ force: true });
      await expect(page.getByTestId('workspace-option-hollow')).toBeVisible();

      await page.getByTestId('workspace-option-split').click();
      await expect(trigger).toHaveAccessibleName('Workspace: Split & Connect. Change workspace');
      await expect(page.getByTestId('workspace-header')).toContainText('Split & Connect');
    }
    await noHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
}

test('F: with a model open, switching every workspace keeps the model and the renderer', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openBox(page);
  await expect(page.getByTestId('workspace-empty')).toHaveCount(0);

  for (const id of [...IMPLEMENTED, 'repair'] as const) {
    await enter(page, id);
    await expect(page.getByTestId(`workflow-${id}`)).toHaveAttribute('aria-current', 'page');
    await expect(canvas(page)).toBeVisible();
    await expect(page.getByTestId('status-triangles')).toHaveText('12');
    await expect(page.getByTestId('workspace-empty')).toHaveCount(0);
  }
  await expect(page.getByTestId('viewport-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
