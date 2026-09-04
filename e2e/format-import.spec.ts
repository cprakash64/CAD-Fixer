import { expect, test, type Page } from '@playwright/test';
import {
  objMultiPart,
  objTriangle,
  objWithBadIndex,
  objWithHostileName,
  objWithQuad,
  objWithRemoteMtllib,
  threeMf,
  threeMfComponentCycle,
  threeMfHostileName,
  threeMfLarge,
  threeMfNestedComponents,
  threeMfSharedPlacements,
  threeMfTwoParts,
  threeMfWithDoctype,
  threeMfWithExternalReference,
  threeMfWithTexture,
  modelXml,
  zipCompressionBomb,
  zipEncryptedEntry,
  zipWithTraversalPath,
} from './format-fixtures';
import { binaryStl } from './stl-fixtures';

/**
 * OBJ AND 3MF IMPORT, IN A REAL BROWSER.
 *
 * The parser suites test each format against its own corpus under Node. What
 * only this can answer is whether a real user opening a real file gets a real
 * model: the file chooser, the worker boundary, the built worker chunk, the
 * viewport, the part selector and Mesh Health, all at once.
 *
 * Every hostile fixture is also run HERE rather than only in the reader tests,
 * because a security property that holds in Node and not in the shipped bundle
 * is not a security property.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
}

async function statusText(page: Page): Promise<string> {
  return (await page.getByTestId('status-list').textContent()) ?? '';
}

/** Scene facts the viewport publishes for leak and rendering tests. */
async function readScene(page: Page): Promise<{
  drawCalls: number;
  modelObjects: number;
  sharedGeometries: number;
  partTransforms: string;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const read = (key: string): number => Number(canvas?.dataset[key] ?? 0);
    return {
      drawCalls: read('drawCalls'),
      modelObjects: read('modelObjects'),
      sharedGeometries: read('sharedGeometries'),
      partTransforms: canvas?.dataset.partTransforms ?? '',
    };
  });
}

function translationOf(partTransforms: string, partId: string): readonly number[] | undefined {
  for (const entry of partTransforms.split('|')) {
    const [id, values] = entry.split(':');
    if (id !== partId || values === undefined) continue;
    return values.split(',').map(Number);
  }
  return undefined;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

/* ------------------------------------------------------------------ obj -- */

test('imports an OBJ and renders it', async ({ page }) => {
  await openFile(page, 'triangle.obj', objTriangle().bytes);

  await expect(page.getByTestId('fact-triangles')).toHaveText('1', { timeout: 30_000 });
  await expect(page.getByTestId('fact-units')).toContainText(/unspecified/i);

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(1);
  expect(scene.drawCalls).toBeGreaterThan(0);
});

test('an OBJ with several objects becomes several parts', async ({ page }) => {
  const fixture = objMultiPart(3);
  await openFile(page, 'assembly.obj', fixture.bytes);

  await expect(page.getByTestId('part-selector')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('fact-parts')).toHaveText('3');
  await expect(page.getByTestId('part-option-part-1')).toContainText('Part 1');
  await expect(page.getByTestId('part-option-part-3')).toContainText('Part 3');

  const scene = await readScene(page);
  // THREE OBJECTS DRAWN, and three distinct meshes: OBJ has no instancing.
  expect(scene.modelObjects).toBe(3);
  expect(scene.sharedGeometries).toBe(3);
});

test('refuses an OBJ polygon with an explanation, and keeps the workspace empty', async ({
  page,
}) => {
  await openFile(page, 'quad.obj', objWithQuad());

  await expect.poll(async () => statusText(page), { timeout: 30_000 }).toMatch(/triangle faces/i);
  // It says what it will not do, and why.
  expect(await statusText(page)).toMatch(/invent/i);
  await expect(page.getByTestId('model-empty')).toBeVisible();
});

test('refuses an OBJ with an impossible index rather than clamping it', async ({ page }) => {
  await openFile(page, 'bad.obj', objWithBadIndex());

  await expect.poll(async () => statusText(page), { timeout: 30_000 }).toMatch(/does not exist/i);
  await expect(page.getByTestId('model-empty')).toBeVisible();
});

test('names a material library it did not open, and makes no request for it', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
  });

  await openFile(page, 'materials.obj', objWithRemoteMtllib());
  await expect(page.getByTestId('fact-triangles')).toHaveText('1', { timeout: 30_000 });

  // The geometry imported, and the omission is stated rather than silent.
  await expect(page.getByTestId('model-warnings')).toContainText(/material library/i);
  // NOTHING WAS FETCHED. The library is text; nothing resolves it.
  expect(requests.filter((url) => url.includes('evil.test'))).toEqual([]);
});

/* ------------------------------------------------------------------ 3mf -- */

test('imports a 3MF and preserves its unit', async ({ page }) => {
  await openFile(page, 'part.3mf', threeMf(modelXml({ unit: 'inch' })));

  await expect(page.getByTestId('fact-triangles')).toHaveText('4', { timeout: 30_000 });
  // The unit the file stated, shown as stated — and the coordinates unchanged.
  await expect(page.getByTestId('fact-units')).toHaveText('inch');

  // AND EVERY SENTENCE THAT MENTIONS UNITS FOLLOWS THE FILE. Mesh Health used
  // to say "STL states no unit" to every user, whatever they had opened.
  await expect(page.getByTestId('mesh-health')).toContainText(
    'Areas and volumes are in the unit the file stated (inch)',
    { timeout: 30_000 },
  );
  await expect(page.getByTestId('mesh-health')).not.toContainText('STL states no unit');
});

test('a 3MF with two build items becomes two placed parts', async ({ page }) => {
  await openFile(page, 'two.3mf', threeMfTwoParts());

  await expect(page.getByTestId('part-selector')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('part-option-part-1')).toContainText('Left');
  await expect(page.getByTestId('part-option-part-2')).toContainText('Right');

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(2);
  // Distinct objects, so distinct meshes.
  expect(scene.sharedGeometries).toBe(2);

  // AND THE PLACEMENT REACHED THE RENDERER. 40 along X, as the file says.
  const a = translationOf(scene.partTransforms, 'part-1');
  const b = translationOf(scene.partTransforms, 'part-2');
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  expect((b?.[0] ?? 0) - (a?.[0] ?? 0)).toBeCloseTo(40, 2);
});

test('repeated 3MF placements share one GPU geometry', async ({ page }) => {
  await openFile(page, 'shared.3mf', threeMfSharedPlacements(24));

  await expect(page.getByTestId('fact-parts')).toHaveText('24', { timeout: 30_000 });

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(24);
  // ONE UPLOAD FOR TWENTY-FOUR PLACEMENTS. The whole point of sharing, proven
  // in a real GPU context rather than in a unit test's bookkeeping.
  expect(scene.sharedGeometries).toBe(1);
});

test('nested 3MF components compose their transforms', async ({ page }) => {
  await openFile(page, 'nested.3mf', threeMfNestedComponents());

  await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 30_000 });

  const scene = await readScene(page);
  const leaf = translationOf(scene.partTransforms, 'part-1');
  const nested = translationOf(scene.partTransforms, 'part-2');
  if (leaf === undefined || nested === undefined) {
    throw new Error(`missing placement in "${scene.partTransforms}"`);
  }

  // outer(0,+25) applied after inner(+30,0) puts the leaf at (30, 25).
  expect((nested[0] ?? 0) - (leaf[0] ?? 0)).toBeCloseTo(30, 2);
  expect((nested[1] ?? 0) - (leaf[1] ?? 0)).toBeCloseTo(25, 2);
  // BOTH SHARE ONE MESH: the component instance points at the same object.
  expect(scene.sharedGeometries).toBe(1);
});

test('reports a 3MF texture it did not read, and fetches nothing', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
  });

  await openFile(page, 'textured.3mf', threeMfWithTexture());
  await expect(page.getByTestId('fact-triangles')).toHaveText('4', { timeout: 30_000 });

  await expect(page.getByTestId('model-warnings')).toContainText(/textures/i);
  await expect(page.getByTestId('model-warnings')).toContainText(/nothing was downloaded/i);
  expect(requests.filter((url) => url.includes('evil.test'))).toEqual([]);
});

/* ------------------------------------------------------- hostile inputs -- */

test.describe('hostile files are refused in the browser, exactly as in the reader tests', () => {
  for (const [label, name, build, expected] of [
    ['a ZIP traversal path', 'traversal.3mf', zipWithTraversalPath, /unsafe file path/i],
    ['a compression bomb', 'bomb.3mf', zipCompressionBomb, /compressed far beyond/i],
    ['an encrypted entry', 'locked.3mf', zipEncryptedEntry, /encrypted/i],
    ['a DOCTYPE declaration', 'xxe.3mf', threeMfWithDoctype, /document type definition/i],
    [
      'an external XML reference',
      'external.3mf',
      threeMfWithExternalReference,
      /external XML resource/i,
    ],
    ['a component cycle', 'cycle.3mf', threeMfComponentCycle, /loop/i],
  ] as const) {
    test(`refuses ${label}`, async ({ page }) => {
      const requests: string[] = [];
      page.on('request', (request) => {
        requests.push(request.url());
      });

      await openFile(page, name, build());

      await expect.poll(async () => statusText(page), { timeout: 60_000 }).toMatch(expected);
      // Nothing was committed, and nothing off-origin was requested.
      await expect(page.getByTestId('model-empty')).toBeVisible();
      expect(requests.filter((url) => !url.startsWith('http://localhost:4173'))).toEqual([]);
    });
  }
});

test.describe('untrusted names render as text, never as markup', () => {
  for (const [label, name, build] of [
    ['an OBJ object name', 'hostile.obj', objWithHostileName],
    ['a 3MF object name', 'hostile.3mf', threeMfHostileName],
  ] as const) {
    test(`escapes ${label}`, async ({ page }) => {
      await openFile(page, name, build());
      // Two parts, so the selector renders and the name is actually displayed.
      await expect(page.getByTestId('part-selector')).toBeVisible({ timeout: 30_000 });

      // The name is on screen as literal text...
      await expect(page.getByTestId('part-option-part-1')).toContainText('<img src=x onerror=');
      // ...and the handler never ran: no element was created, and the payload's
      // own effect did not fire.
      expect(await page.title()).not.toBe('XSS');
      expect(await page.locator('img').count()).toBe(0);
      // The whole payload survives as one text node rather than being parsed.
      const rendered = await page
        .getByTestId('part-option-part-1')
        .evaluate((element) => ({ text: element.textContent, children: element.innerHTML }));
      expect(rendered.text).toContain(`document.title='XSS'`);
      expect(rendered.children).toContain('&lt;img');
    });
  }
});

/* ---------------------------------------------------------- progress -- */

test('a 3MF import says it is decompressing, in words rather than in tokens', async ({ page }) => {
  test.setTimeout(120_000);

  /*
   * WHY THIS IS WORTH A TEST. A 3MF spends real time inflating an archive, and
   * without the detail the interface says "Parsing geometry" throughout — which
   * is not what is happening yet. The note comes from the reader, so this also
   * proves the phase note survives the worker boundary.
   */
  const seen: string[] = [];
  await page.exposeFunction('__recordPhase', (text: string) => {
    seen.push(text);
  });
  await page.evaluate(() => {
    const record = (): void => {
      const phase = document.querySelector('[data-testid="import-phase"]');
      if (phase === null) return;
      const send = (window as unknown as { __recordPhase: (text: string) => void }).__recordPhase;
      send(phase.textContent);
    };
    new MutationObserver(record).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  await openFile(page, 'large.3mf', threeMfLarge(60_000));
  await expect(page.getByTestId('fact-triangles')).toHaveText('60,000', { timeout: 90_000 });

  const joined = seen.join(' | ');
  expect(joined).toMatch(/decompressing|reading the archive|reading the model part|building parts/);
  // AND NEVER THE READER'S OWN VOCABULARY. A note the interface has no words
  // for shows nothing at all rather than an internal token.
  expect(joined).not.toMatch(/parsing model|reading package|building document/);
});

/* ------------------------------------------------------ transactionality -- */

test('a failed OBJ import leaves the loaded model untouched', async ({ page }) => {
  await openFile(page, 'good.obj', objMultiPart(2).bytes);
  await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 30_000 });
  const before = await readScene(page);

  await openFile(page, 'quad.obj', objWithQuad());
  await expect.poll(async () => statusText(page), { timeout: 30_000 }).toMatch(/triangle faces/i);

  // SAME MODEL, still drawn, still two parts.
  await expect(page.getByTestId('fact-parts')).toHaveText('2');
  const after = await readScene(page);
  expect(after.modelObjects).toBe(before.modelObjects);
  expect(after.sharedGeometries).toBe(before.sharedGeometries);
  await expect(page.getByTestId('part-option-part-1')).toHaveAttribute('aria-pressed', 'true');
});

test('a failed 3MF import leaves the loaded model untouched', async ({ page }) => {
  await openFile(page, 'good.3mf', threeMfTwoParts());
  await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 30_000 });

  await openFile(page, 'bomb.3mf', zipCompressionBomb());
  await expect
    .poll(async () => statusText(page), { timeout: 60_000 })
    .toMatch(/compressed far beyond/i);

  await expect(page.getByTestId('fact-parts')).toHaveText('2');
  expect((await readScene(page)).modelObjects).toBe(2);
});

/* --------------------------------------------------------- STL unchanged -- */

test('STL import is unchanged by the arrival of other formats', async ({ page }) => {
  const stl = binaryStl(64);
  await openFile(page, 'bracket.stl', stl.bytes);

  await expect(page.getByTestId('fact-triangles')).toHaveText('64', { timeout: 30_000 });
  await expect(page.getByTestId('fact-encoding')).toHaveText('binary');
  await expect(page.getByTestId('fact-units')).toContainText(/unspecified by stl/i);
  // One part, and therefore no selector: the STL user's experience is the same.
  await expect(page.getByTestId('part-selector')).toHaveCount(0);
  expect((await readScene(page)).modelObjects).toBe(1);
});
