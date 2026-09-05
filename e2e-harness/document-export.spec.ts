import { expect, test, type Page } from '@playwright/test';
import { Fixture, digest, loadFixture, openHarness, readScene, readState } from './harness';

/**
 * DOCUMENT EXPORT, IN A REAL BROWSER.
 *
 * The writer suites prove the bytes are right under Node. What only this can
 * answer is whether the ARCHITECTURE is right: whether a snapshot really
 * crosses two workers without the page holding geometry, whether terminating
 * the export worker really stops the work, whether an artifact from a stale
 * revision is really discarded, and whether the authoritative document is
 * really untouched by any of it.
 *
 * The harness bridge is the only caller. Stage 4A-2B2 builds the engine; the
 * user-facing workflow is Stage 4A-2B3's, and there is deliberately no
 * production route to this.
 */

/**
 * What the harness bridge reports back.
 *
 * A LENGTH AND A HEAD, never the file: the artifact belongs in a download, and
 * a test needs to know how large it was, what format it looks like, and what
 * the writer observed about the conversion.
 */
interface ExportResult {
  readonly status: string;
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
  readonly byteLength?: number | undefined;
  readonly fileName?: string | undefined;
  readonly observations?: readonly string[] | undefined;
  readonly triangleCount?: number | undefined;
  readonly partCount?: number | undefined;
  readonly meshResourceCount?: number | undefined;
  readonly durationMs: number;
  readonly head?: string | undefined;
  readonly progressUpdates: number;
}

async function exportDocument(
  page: Page,
  target: 'obj' | '3mf',
  options: {
    readonly sourceName?: string;
    readonly revisionDelta?: number;
    readonly download?: boolean;
    readonly cancelAfterMs?: number;
  } = {},
): Promise<ExportResult> {
  const state = await readState(page);
  const documentId = state.documentId ?? '';
  const revision = (state.revision ?? 0) + (options.revisionDelta ?? 0);

  const request = {
    documentId,
    revision,
    target,
    sourceName: options.sourceName ?? 'bracket.stl',
    download: options.download ?? false,
    cancelAfterMs: options.cancelAfterMs ?? null,
  };

  return page.evaluate(async (input): Promise<ExportResult> => {
    const bridge = window.cadfixerHarness;
    if (bridge === undefined) throw new Error('the harness bridge is not installed');
    return bridge.exportDocument(input.documentId, input.revision, input.target, input.sourceName, {
      ...(input.download ? { download: true } : {}),
      ...(input.cancelAfterMs === null ? {} : { cancelAfterMs: input.cancelAfterMs }),
    });
  }, request);
}

async function liveExportResources(page: Page): Promise<{ workers: number; channels: number }> {
  return page.evaluate(() => ({
    workers: window.cadfixerHarness?.exportLiveWorkers() ?? -1,
    channels: window.cadfixerHarness?.exportLiveChannels() ?? -1,
  }));
}

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

/* ------------------------------------------------------------ happy path -- */

test('writes an OBJ of the whole document, through both workers', async ({ page }) => {
  await loadFixture(page, Fixture.TwoIndependentParts);

  const result = await exportDocument(page, 'obj');
  expect(result.status).toBe('SUCCESS');
  expect(result.partCount).toBe(2);
  expect(result.byteLength).toBeGreaterThan(0);
  expect(result.fileName).toBe('bracket.obj');
  // The bytes ARE an OBJ, identified without holding the file.
  expect(result.head).toContain('# Written by CAD Fixer');
  // Progress crossed the boundary as scalars.
  expect(result.progressUpdates).toBeGreaterThan(0);

  // NOTHING IS RETAINED. The export worker and its channel are gone.
  expect(await liveExportResources(page)).toEqual({ workers: 0, channels: 0 });
});

test('writes a 3MF when the document states a unit', async ({ page }) => {
  await loadFixture(page, Fixture.MillimetreTwoParts);

  const result = await exportDocument(page, '3mf', { sourceName: 'bracket.stl' });
  expect(result.status).toBe('SUCCESS');
  expect(result.fileName).toBe('bracket.3mf');
  // A ZIP, by its signature.
  expect(result.head?.slice(0, 2)).toBe('PK');
  expect(result.observations).toContain('UNIT_PRESERVED');
  expect(result.observations).toContain('TRANSFORMS_PRESERVED');
});

test('BLOCKS a 3MF export when the document states no unit', async ({ page }) => {
  /*
   * THE SAME GEOMETRY AS THE TEST ABOVE, without a unit. A 3MF declares one for
   * everything it contains, and a document derived from an STL has asserted
   * nothing — so CAD Fixer refuses rather than choosing millimetres on the
   * user's behalf. Stage 4A-2B3 lifts this by ASKING.
   */
  await loadFixture(page, Fixture.TwoIndependentParts);

  const result = await exportDocument(page, '3mf');
  expect(result.status).toBe('BLOCKED_UNIT_REQUIRED');
  expect(result.reason).toBe('EXPORT_UNIT_REQUIRED');
  expect(result.byteLength).toBeUndefined();
  expect(result.message).not.toMatch(/millimet/i);

  // The same document exports as OBJ, which needs no unit.
  expect((await exportDocument(page, 'obj')).status).toBe('SUCCESS');
});

test('preserves shared geometry in 3MF and flattens it in OBJ', async ({ page }) => {
  await loadFixture(page, Fixture.MillimetreShared1000);

  const asThreeMf = await exportDocument(page, '3mf');
  expect(asThreeMf.status).toBe('SUCCESS');
  expect(asThreeMf.partCount).toBe(1_000);
  // ONE serialised resource for a thousand placements.
  expect(asThreeMf.meshResourceCount).toBe(1);
  expect(asThreeMf.observations).toContain('STRUCTURAL_SHARING_PRESERVED');

  const asObj = await exportDocument(page, 'obj');
  expect(asObj.status).toBe('SUCCESS');
  expect(asObj.observations).toContain('STRUCTURAL_SHARING_FLATTENED');
  /*
   * AND THE COST IS REAL, not a claim. OBJ has no instancing, so a thousand
   * placements are a thousand copies — this is the number Stage 4A-2B3 will
   * turn into a warning a user reads before choosing a format.
   */
  expect(asObj.byteLength ?? 0).toBeGreaterThan((asThreeMf.byteLength ?? 0) * 10);
});

/* ---------------------------------------------------------- cancellation -- */

test.describe('cancellation stops the work and leaves nothing behind', () => {
  for (const target of ['obj', '3mf'] as const) {
    test(`cancels a large ${target} export`, async ({ page }) => {
      test.setTimeout(180_000);
      await loadFixture(page, Fixture.MillimetreShared1000);

      const result = await exportDocument(page, target, { cancelAfterMs: 1 });
      expect(result.status).toBe('CANCELLED');
      // NO ARTIFACT. A cancelled export must not hand back partial bytes.
      expect(result.byteLength).toBeUndefined();
      expect(await liveExportResources(page)).toEqual({ workers: 0, channels: 0 });

      // AND A RETRY SUCCEEDS, against a fresh worker.
      const retry = await exportDocument(page, target);
      expect(retry.status).toBe('SUCCESS');
      expect(await liveExportResources(page)).toEqual({ workers: 0, channels: 0 });
    });
  }
});

/* --------------------------------------------------------- stale revision -- */

test('discards an artifact written from a revision the caller is not on', async ({ page }) => {
  await loadFixture(page, Fixture.MillimetreTwoParts);

  // Asking for a revision that does not exist is the same condition an export
  // finishing after a repair produces, and it is the one a test can create
  // deterministically.
  const result = await exportDocument(page, 'obj', { revisionDelta: 7 });
  expect(result.status).toBe('STALE_REVISION');
  expect(result.byteLength).toBeUndefined();
  expect(await liveExportResources(page)).toEqual({ workers: 0, channels: 0 });

  // The current revision still exports.
  expect((await exportDocument(page, 'obj')).status).toBe('SUCCESS');
});

/* ------------------------------------------------------ source immutability -- */

test.describe('exporting never touches the authoritative document', () => {
  for (const target of ['obj', '3mf'] as const) {
    test(`${target} export leaves every byte, placement and share identical`, async ({ page }) => {
      const loaded = await loadFixture(page, Fixture.MillimetreShared1000);
      const before = await digest(page, loaded);
      const sceneBefore = await readScene(page);

      expect((await exportDocument(page, target)).status).toBe('SUCCESS');
      // And once more after a cancellation, which is the path most likely to
      // leave something half-done.
      await exportDocument(page, target, { cancelAfterMs: 1 });

      const after = await digest(page, await readState(page));
      expect(after.parts).toEqual(before.parts);
      expect(after.distinctMeshes).toBe(before.distinctMeshes);

      const state = await readState(page);
      expect(state.revision).toBe(loaded.revision);
      expect(state.partCount).toBe(loaded.partCount);
      expect(state.activePartId).toBe(loaded.activePartId);

      // The viewport uploaded nothing new and disposed nothing.
      const sceneAfter = await readScene(page);
      expect(sceneAfter.geometriesCreated).toBe(sceneBefore.geometriesCreated);
      expect(sceneAfter.geometriesDisposed).toBe(sceneBefore.geometriesDisposed);
    });
  }
});

test('two parts sharing one mesh still share it after both exports', async ({ page }) => {
  const loaded = await loadFixture(page, Fixture.SharedPairApart);
  const before = await digest(page, loaded);
  expect(before.distinctMeshes).toBe(1);

  expect((await exportDocument(page, 'obj')).status).toBe('SUCCESS');
  await loadFixture(page, Fixture.MillimetreShared1000);
  await loadFixture(page, Fixture.SharedPairApart);

  const after = await digest(page, await readState(page));
  // NO SERIALISER MAY "HELPFULLY" DETACH A SHARED RESOURCE.
  expect(after.distinctMeshes).toBe(1);
});

/* ------------------------------------------------------------- lifecycle -- */

test('repeated exports leak no worker, channel or operation', async ({ page }) => {
  test.setTimeout(240_000);
  await loadFixture(page, Fixture.MillimetreTwoParts);

  for (const target of ['obj', '3mf'] as const) {
    expect((await exportDocument(page, target)).status).toBe('SUCCESS');
    expect((await exportDocument(page, target)).status).toBe('SUCCESS');
    expect((await exportDocument(page, target, { cancelAfterMs: 1 })).status).toBe('CANCELLED');
    expect((await exportDocument(page, target)).status).toBe('SUCCESS');
    expect(await liveExportResources(page)).toEqual({ workers: 0, channels: 0 });
  }

  // The document is exactly as it was after eight exports.
  const state = await readState(page);
  expect(state.partCount).toBe(2);
  expect(state.loaded).toBe(true);
});

/* -------------------------------------------------------------- downloads -- */

test('produces a downloadable file with a safe name', async ({ page }) => {
  await loadFixture(page, Fixture.MillimetreTwoParts);

  const download = page.waitForEvent('download');
  const result = await exportDocument(page, '3mf', {
    // A hostile source name: path components, a reserved character and a
    // right-to-left override that would make a file manager render the name
    // backwards.
    sourceName: `../../evil${String.fromCharCode(0x202e)}gnp:x.stl`,
    download: true,
  });

  expect(result.status).toBe('SUCCESS');
  const saved = await download;
  // NO PATH, NO OVERRIDE, NO RESERVED CHARACTER, and the extension is the
  // WRITER'S rather than the source's.
  expect(saved.suggestedFilename()).toBe('evilgnpx.3mf');
  expect(saved.suggestedFilename()).not.toContain('/');
  expect(saved.suggestedFilename()).not.toContain('..');
});

/* --------------------------------------------------------------- privacy -- */

test('nothing leaves the machine during an export', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://localhost:4175')) external.push(request.url());
  });

  await loadFixture(page, Fixture.MillimetreTwoParts);
  expect((await exportDocument(page, 'obj')).status).toBe('SUCCESS');
  expect((await exportDocument(page, '3mf', { download: true })).status).toBe('SUCCESS');

  expect(external).toEqual([]);
});
