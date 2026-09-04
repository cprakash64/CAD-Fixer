import { expect, test } from '@playwright/test';
import {
  Fixture,
  PART_B_OFFSET_X,
  PART_C_OFFSET_Y,
  digest,
  loadFixture,
  openHarness,
  readScene,
  readState,
  worldTranslation,
} from './harness';

/**
 * DF07 AND DF08, IN A REAL BROWSER.
 *
 * Stage 4A-2A proved the placement arithmetic and the render-snapshot shape at
 * unit level. What it could not prove was that Three.js, given those snapshots,
 * actually puts two parts on screen in two places — because no production
 * import produces a document with two parts. That is the only thing these
 * specs add, and it is the thing that was missing.
 *
 * They read what the renderer resolved (`matrixWorld`, draw calls, object
 * counts) rather than sampling pixels: a screenshot cannot distinguish a part
 * drawn at the wrong place from a part drawn behind another one, and cannot
 * distinguish a transposed matrix from a correct one at all.
 */

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

/* ------------------------------------------------- MP-BROWSER-01 / DF07 -- */

test('DF07: two independent parts both render, with their identities preserved', async ({
  page,
}) => {
  const state = await loadFixture(page, Fixture.TwoIndependentParts);

  expect(state.partCount).toBe(2);
  expect(state.partIds).toEqual(['a', 'b']);
  expect(state.partNames).toEqual(['Alpha', 'Beta']);
  // Independent geometry: two distinct authoritative meshes, so two resources.
  expect(state.meshResourceIndices).toEqual([0, 1]);

  const scene = await readScene(page);
  // ONE OBJECT PER PART, both in the scene at once.
  expect(scene.modelObjects).toBe(2);
  expect(scene.sharedGeometries).toBe(2);
  // And they were actually drawn, not merely added.
  expect(scene.drawCalls).toBeGreaterThan(0);
  expect(scene.renderedTriangles).toBeGreaterThan(0);

  // The selector is offered, names both parts, and selects a deterministic one.
  await expect(page.getByTestId('part-selector')).toBeVisible();
  await expect(page.getByTestId('part-option-a')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('part-option-b')).toHaveAttribute('aria-pressed', 'false');
  expect(state.activePartId).toBe('a');

  // The page holds descriptors and pixels. The document stays in the worker: a
  // digest of its authoritative buffers is available, and the buffers are not.
  const document = await digest(page, state);
  expect(document.ok).toBe(true);
  expect(document.parts.map((part) => part.partId)).toEqual(['a', 'b']);
});

test('DF07: switching the active part does not remove the other part', async ({ page }) => {
  const state = await loadFixture(page, Fixture.TwoIndependentParts);
  const before = await readScene(page);
  expect(before.modelObjects).toBe(2);

  await page.getByTestId('part-option-b').click();
  await expect(page.getByTestId('part-option-b')).toHaveAttribute('aria-pressed', 'true');

  const after = await readScene(page);
  // BOTH PARTS ARE STILL DRAWN. Selection changes what the workflows target,
  // not what the viewport shows — a selector that hid the rest of the model
  // would make a multi-part document unusable.
  expect(after.modelObjects).toBe(2);
  expect(after.sharedGeometries).toBe(before.sharedGeometries);

  const selected = await readState(page);
  expect(selected.activePartId).toBe('b');
  // NO NEW REVISION. Selection is workspace state; the authoritative document
  // did not move, so nothing in flight was invalidated by a click.
  expect(selected.revision).toBe(state.revision);
  expect(selected.documentId).toBe(state.documentId);
  expect(selected.workspaceRevision).toBe(state.workspaceRevision);

  // NO GEOMETRY WAS REBUILT for the selection.
  expect(after.geometriesCreated).toBe(before.geometriesCreated);
  expect(after.geometriesDisposed).toBe(before.geometriesDisposed);
});

test('DF07: Mesh Health and repair follow the active part and name it', async ({ page }) => {
  await loadFixture(page, Fixture.TwoIndependentParts);

  await expect(page.getByTestId('health-part-scope')).toContainText('Alpha');
  await expect(page.getByTestId('health-part-scope')).toContainText('2 parts');

  await page.getByTestId('part-option-b').click();
  await expect(page.getByTestId('health-part-scope')).toContainText('Beta');

  // The scope note states what it does NOT claim, in the browser and not only
  // in a component test.
  await expect(page.getByTestId('health-part-scope')).toContainText(
    'nothing here reports how the parts relate to one another',
  );
});

/* --------------------------------------------------------------- DF08 -- */

test('DF08: a transformed part is drawn at its placement, and its bytes are untouched', async ({
  page,
}) => {
  const state = await loadFixture(page, Fixture.ThreeTransformedParts);
  expect(state.partCount).toBe(3);
  // One mesh, three placements: the sharing case AND the transform case at once.
  expect(state.meshResourceIndices).toEqual([0, 0, 0]);

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(3);
  expect(scene.sharedGeometries).toBe(1);

  const a = worldTranslation(scene, 'a');
  const b = worldTranslation(scene, 'b');
  const c = worldTranslation(scene, 'c');
  if (a === undefined || b === undefined || c === undefined) {
    throw new Error(`missing part placement in "${scene.partTransforms}"`);
  }

  /*
   * RELATIVE, NOT ABSOLUTE. The model group carries a display-only centring
   * offset, so no part sits at the world origin — and asserting an absolute
   * position would be asserting the centring rule rather than the placement.
   * The DIFFERENCES between parts are the transforms, exactly.
   */
  expect(b[0] - a[0]).toBeCloseTo(PART_B_OFFSET_X, 3);
  expect(b[1] - a[1]).toBeCloseTo(0, 3);
  expect(b[2] - a[2]).toBeCloseTo(0, 3);

  expect(c[0] - a[0]).toBeCloseTo(0, 3);
  expect(c[1] - a[1]).toBeCloseTo(PART_C_OFFSET_Y, 3);
  expect(c[2] - a[2]).toBeCloseTo(0, 3);

  /*
   * AND THE COORDINATES WERE NOT REWRITTEN. Three parts share one mesh, so if a
   * placement had been baked into positions there would be three different
   * buffers with three different digests. There is one buffer, and every part
   * reports the same digest for it.
   */
  const document = await digest(page, state);
  expect(document.distinctMeshes).toBe(1);
  const digests = new Set(document.parts.map((part) => part.positionDigest));
  expect(digests.size).toBe(1);

  // The placements live on the PARTS, and they are the ones that differ.
  expect(document.parts.map((part) => part.transform.slice(9))).toEqual([
    [0, 0, 0],
    [PART_B_OFFSET_X, 0, 0],
    [0, PART_C_OFFSET_Y, 0],
  ]);
});

test('DF08: switching the active part changes neither placement nor bytes', async ({ page }) => {
  const state = await loadFixture(page, Fixture.ThreeTransformedParts);
  const before = await readScene(page);
  const beforeDigest = await digest(page, state);

  await page.getByTestId('part-option-c').click();
  await expect(page.getByTestId('part-option-c')).toHaveAttribute('aria-pressed', 'true');

  const after = await readScene(page);
  expect(after.partTransforms).toBe(before.partTransforms);

  const afterDigest = await digest(page, await readState(page));
  expect(afterDigest.parts.map((part) => part.positionDigest)).toEqual(
    beforeDigest.parts.map((part) => part.positionDigest),
  );
  expect(afterDigest.parts.map((part) => part.indexDigest)).toEqual(
    beforeDigest.parts.map((part) => part.indexDigest),
  );
  expect(afterDigest.parts.map((part) => part.transform)).toEqual(
    beforeDigest.parts.map((part) => part.transform),
  );
});

test('a single-part document renders exactly as it did before the migration', async ({ page }) => {
  // THE REGRESSION GUARD. One part, one object, and no selector at all — the
  // STL user's experience is unchanged, verified on the same page that proves
  // multi-part works.
  const state = await loadFixture(page, Fixture.SinglePart);

  expect(state.partCount).toBe(1);
  expect(state.activePartId).toBe('only');

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(1);
  expect(scene.sharedGeometries).toBe(1);
  expect(scene.drawCalls).toBeGreaterThan(0);

  await expect(page.getByTestId('part-selector')).toHaveCount(0);
  await expect(page.getByTestId('health-part-scope')).toHaveCount(0);
});
