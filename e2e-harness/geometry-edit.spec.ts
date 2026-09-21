import { expect, test } from '@playwright/test';
import { Fixture, digest, loadFixture, openHarness, readState } from './harness';

test('test-only worker edit previews, commits one shared instance, and undoes exactly', async ({
  page,
}) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SharedPairApart);
  const state = await readState(page),
    id = state.documentId ?? '',
    revision = state.revision ?? 0;
  const before = await digest(page, state);
  const proof = await page.evaluate(
    async ({ id, revision }) => {
      const api = window.cadfixerHarness;
      if (!api) throw new Error('Harness unavailable');
      const candidate = await api.beginTestEdit(id, revision, 'a', 2);
      const preview = await api.previewTestEdit(candidate);
      const beforeCommit = await api.digest(id, revision);
      const applied = await api.commitTestEdit(candidate, id, revision, 'a');
      const after = await api.digest(id, applied.revision);
      const undoRevision = await api.undoTestEdit(id, applied.revision, applied.recordId);
      const restored = await api.digest(id, undoRevision);
      return { preview, beforeCommit, applied, after, restored, undoRevision };
    },
    { id, revision },
  );
  expect(proof.preview.vertexCount).toBeGreaterThan(0);
  expect(proof.beforeCommit.parts).toEqual(before.parts);
  expect(proof.after.parts[0]?.positionDigest).not.toBe(before.parts[0]?.positionDigest);
  expect(proof.after.parts[1]?.positionDigest).toBe(before.parts[1]?.positionDigest);
  expect(proof.after.distinctMeshes).toBe(2);
  expect(proof.restored.parts).toEqual(before.parts);
  expect(proof.restored.distinctMeshes).toBe(1);
  expect(proof.undoRevision).toBe(revision + 2);
});

test('superseded and discarded edits cannot preview or apply', async ({ page }) => {
  await openHarness(page);
  await loadFixture(page, Fixture.TwoIndependentParts);
  const state = await readState(page),
    id = state.documentId ?? '',
    revision = state.revision ?? 0;
  const verdict = await page.evaluate(
    async ({ id, revision }) => {
      const api = window.cadfixerHarness;
      if (!api) throw new Error('Harness unavailable');
      const a = await api.beginTestEdit(id, revision, 'a', 1);
      const b = await api.beginTestEdit(id, revision, 'b', 1);
      let stale = false;
      try {
        await api.commitTestEdit(a, id, revision, 'a');
      } catch {
        stale = true;
      }
      const discarded = await api.discardTestEdit(b);
      let cancelled = false;
      try {
        await api.previewTestEdit(b);
      } catch {
        cancelled = true;
      }
      return { stale, discarded, cancelled, after: await api.digest(id, revision) };
    },
    { id, revision },
  );
  expect(verdict.stale).toBe(true);
  expect(verdict.discarded).toBe(true);
  expect(verdict.cancelled).toBe(true);
  expect(verdict.after.ok).toBe(true);
});

test('seven-part edit isolates Part 3 and undo restores all seven', async ({ page }) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SevenSharedMillimetre);
  const state = await readState(page),
    id = state.documentId ?? '',
    revision = state.revision ?? 0;
  const before = await digest(page, state);
  expect(before.parts).toHaveLength(7);
  expect(before.distinctMeshes).toBe(1);
  const result = await page.evaluate(
    async ({ id, revision }) => {
      const api = window.cadfixerHarness;
      if (!api) throw new Error('Harness unavailable');
      const candidate = await api.beginTestEdit(id, revision, 'p3', 1);
      const applied = await api.commitTestEdit(candidate, id, revision, 'p3');
      const after = await api.digest(id, applied.revision);
      const restoredRevision = await api.undoTestEdit(id, applied.revision, applied.recordId);
      return { after, restored: await api.digest(id, restoredRevision) };
    },
    { id, revision },
  );
  expect(result.after.parts[2]?.positionDigest).not.toBe(before.parts[2]?.positionDigest);
  for (let i = 0; i < 7; i++) if (i !== 2) expect(result.after.parts[i]).toEqual(before.parts[i]);
  expect(result.after.distinctMeshes).toBe(2);
  expect(result.restored.parts).toEqual(before.parts);
  expect(result.restored.distinctMeshes).toBe(1);
});

test('edited seven-part document exports and reads back as STL, OBJ, and 3MF', async ({ page }) => {
  await openHarness(page);
  await loadFixture(page, Fixture.SevenSharedMillimetre);
  const state = await readState(page),
    id = state.documentId ?? '',
    revision = state.revision ?? 0;
  const applied = await page.evaluate(
    async ({ id, revision }) => {
      const api = window.cadfixerHarness;
      if (!api) throw new Error('Harness unavailable');
      const candidate = await api.beginTestEdit(id, revision, 'p3', 1);
      return api.commitTestEdit(candidate, id, revision, 'p3');
    },
    { id, revision },
  );
  const exports: { target: 'stl' | 'obj' | '3mf'; buffer: Buffer }[] = [];
  for (const target of ['stl', 'obj', '3mf'] as const) {
    const download = page.waitForEvent('download');
    const result = page.evaluate(
      async (input) =>
        window.cadfixerHarness?.exportDocument(
          input.id,
          input.revision,
          input.target,
          'seven.3mf',
          { download: true },
        ),
      { id, revision: applied.revision, target },
    );
    const outcome = await result;
    expect(outcome?.status, JSON.stringify(outcome)).toBe('SUCCESS');
    const file = await download;
    expect(outcome?.triangleCount).toBe(28);
    const path = await file.path();
    expect(path).not.toBeNull();
    exports.push({ target, buffer: await (await import('node:fs/promises')).readFile(path) });
  }
  for (const { target, buffer } of exports) {
    await page
      .getByTestId('file-input')
      .setInputFiles({ name: `roundtrip.${target}`, mimeType: 'application/octet-stream', buffer });
    await expect(page.getByTestId('fact-triangles')).toHaveText('28', { timeout: 60_000 });
  }
});
