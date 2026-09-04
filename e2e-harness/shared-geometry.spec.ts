import { expect, test } from '@playwright/test';
import {
  Fixture,
  digest,
  loadFixture,
  openHarness,
  readScene,
  readState,
  worldTranslation,
} from './harness';

/**
 * DF10, AND THE STRUCTURAL SHARING IT PROTECTS.
 *
 * Reference counting is the half of sharing that can go wrong invisibly. An
 * under-count frees a buffer another part is still drawing from, which a
 * browser renders as a blank or garbled model rather than reporting as an
 * error; an over-count leaks a buffer per load, which nothing surfaces until a
 * long session runs out of memory. Neither is observable from unit tests of the
 * counter alone, because neither is about the counter — both are about whether
 * the RENDERER drives it correctly across a real document lifecycle.
 */

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

/* ------------------------------------------------ structural sharing -- */

test('two parts sharing one mesh upload ONE GPU geometry', async ({ page }) => {
  const state = await loadFixture(page, Fixture.SharedPairApart);

  expect(state.partCount).toBe(2);
  // The worker reported one resource for both parts.
  expect(state.meshResourceIndices).toEqual([0, 0]);

  const scene = await readScene(page);
  // TWO OBJECTS, ONE GEOMETRY. That is the whole design: N placements cost N
  // transforms, not N meshes.
  expect(scene.modelObjects).toBe(2);
  expect(scene.sharedGeometries).toBe(1);
  expect(scene.geometriesCreated).toBe(1);
  expect(scene.geometriesDisposed).toBe(0);

  // And they really are in two places, so the single upload is not a single
  // object drawn once.
  const a = worldTranslation(scene, 'a');
  const b = worldTranslation(scene, 'b');
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  expect((b?.[0] ?? 0) - (a?.[0] ?? 0)).toBeCloseTo(10, 3);

  // Worker-side: one authoritative mesh, not two.
  const document = await digest(page, state);
  expect(document.distinctMeshes).toBe(1);
  expect(document.parts[0]?.positionDigest).toBe(document.parts[1]?.positionDigest);
});

test.describe('placement counts scale without duplicating geometry', () => {
  for (const [fixture, placements] of [
    [Fixture.Shared10, 10],
    [Fixture.Shared100, 100],
    [Fixture.Shared1000, 1000],
  ] as const) {
    test(`${String(placements)} placements hold one authoritative mesh and one GPU geometry`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const state = await loadFixture(page, fixture);

      // Document METADATA grows with placement count...
      expect(state.partCount).toBe(placements);
      expect(state.documentTriangleCount).toBe(4 * placements);
      // ...and geometry does not. One resource, whatever N is.
      expect(state.distinctMeshResources).toBe(1);

      const scene = await readScene(page);
      expect(scene.modelObjects).toBe(placements);
      expect(scene.sharedGeometries).toBe(1);
      expect(scene.geometriesCreated).toBe(1);

      const document = await digest(page, state);
      expect(document.distinctMeshes).toBe(1);
      expect(document.parts).toHaveLength(placements);
      // One digest across every placement: no placement rewrote coordinates.
      expect(new Set(document.parts.map((part) => part.positionDigest)).size).toBe(1);
    });
  }
});

test('resident bytes are charged once for a shared mesh, not once per placement', async ({
  page,
}) => {
  const two = await loadFixture(page, Fixture.SharedPairApart);
  const thousand = await loadFixture(page, Fixture.Shared1000);

  // Same underlying tetrahedron in both fixtures: 500x the placements, the same
  // authoritative bytes. Charging per part would have made this 500x larger and
  // would have refused documents that fit comfortably.
  expect(thousand.residentBytes).toBe(two.residentBytes);
});

/* --------------------------------------------------------------- DF10 -- */

test('DF10: an intermediate part switch never disposes geometry another part uses', async ({
  page,
}) => {
  const state = await loadFixture(page, Fixture.ThreeTransformedParts);
  const before = await readScene(page);
  expect(before.sharedGeometries).toBe(1);
  expect(before.geometriesCreated).toBe(1);
  expect(before.geometriesDisposed).toBe(0);

  // Walk the whole selection, twice.
  for (const partId of ['b', 'c', 'a', 'c', 'b', 'a']) {
    await page.getByTestId(`part-option-${partId}`).click();
    await expect(page.getByTestId(`part-option-${partId}`)).toHaveAttribute('aria-pressed', 'true');
  }

  const after = await readScene(page);
  // NOTHING WAS CREATED AND NOTHING WAS DISPOSED. Selection is not a lifecycle
  // event; three parts sharing one buffer must not have that buffer released
  // and rebuilt because the user looked at a different one.
  expect(after.geometriesCreated).toBe(1);
  expect(after.geometriesDisposed).toBe(0);
  expect(after.sharedGeometries).toBe(1);
  // And all three are still on screen.
  expect(after.modelObjects).toBe(3);
  expect(after.drawCalls).toBeGreaterThan(0);

  expect((await readState(page)).revision).toBe(state.revision);
});

test('DF10: replacing a document releases its shared geometry exactly once', async ({ page }) => {
  await loadFixture(page, Fixture.Shared100);
  const loaded = await readScene(page);
  expect(loaded.sharedGeometries).toBe(1);
  expect(loaded.geometriesCreated).toBe(1);
  expect(loaded.geometriesDisposed).toBe(0);

  // A second document replaces the first. The first's geometry is released as
  // the new scene is built.
  await loadFixture(page, Fixture.TwoIndependentParts);
  const replaced = await readScene(page);

  // ONE disposal for the hundred placements that shared one buffer — not zero
  // (a leak) and not a hundred (a double dispose per part).
  expect(replaced.geometriesDisposed).toBe(1);
  // Two independent meshes in the replacement.
  expect(replaced.geometriesCreated).toBe(1 + 2);
  expect(replaced.sharedGeometries).toBe(2);
  expect(replaced.modelObjects).toBe(2);

  // The replacement renders normally, which is what "not corrupted" means here.
  expect(replaced.drawCalls).toBeGreaterThan(0);
  expect(replaced.renderedTriangles).toBeGreaterThan(0);
});

test('DF10: repeated load and dispose cycles do not leak or double-dispose', async ({ page }) => {
  test.setTimeout(300_000);

  /*
   * THE ACCOUNTING IDENTITY THIS PROVES: for every document that has been
   * replaced, exactly one disposal per distinct mesh it held. `created` and
   * `disposed` are cumulative, so a leak makes the gap grow and a double
   * dispose makes disposed overtake created — neither is visible from the live
   * count alone, which returns to the same number every cycle either way.
   */
  const cycle = [
    { fixture: Fixture.SharedPairApart, geometries: 1, parts: 2 },
    { fixture: Fixture.TwoIndependentParts, geometries: 2, parts: 2 },
    { fixture: Fixture.Shared100, geometries: 1, parts: 100 },
  ] as const;

  let expectedCreated = 0;

  for (let round = 0; round < 3; round += 1) {
    for (const step of cycle) {
      await loadFixture(page, step.fixture);
      // Everything created before this load has now been disposed, because the
      // new document replaced the one that held it.
      const expectedDisposed = expectedCreated;
      expectedCreated += step.geometries;

      const scene = await readScene(page);
      expect(scene.geometriesCreated, `round ${String(round)} after ${step.fixture}`).toBe(
        expectedCreated,
      );
      expect(scene.geometriesDisposed, `round ${String(round)} after ${step.fixture}`).toBe(
        expectedDisposed,
      );
      // The LIVE count only ever holds the current document's geometries.
      expect(scene.sharedGeometries).toBe(step.geometries);
      expect(scene.modelObjects).toBe(step.parts);
      // Still rendering after every cycle: nothing was released out from under
      // the scene that replaced it.
      expect(scene.drawCalls).toBeGreaterThan(0);
    }
  }

  const final = await readScene(page);
  // Never negative, never overtaking: disposals trail creations by exactly the
  // geometries the CURRENT document still holds.
  expect(final.geometriesCreated - final.geometriesDisposed).toBe(final.sharedGeometries);
});
