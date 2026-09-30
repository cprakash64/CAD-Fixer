import { test, expect, type Page } from '@playwright/test';
import { binaryStl } from './stl-fixtures';

type SinkMode = 'save' | 'cancel' | 'disk' | 'permission' | 'closed';
interface SinkWindow extends Window {
  showSaveFilePicker: () => Promise<FileSystemFileHandle>;
  exportTest: {
    mode: SinkMode;
    picks: number;
    writes: number;
    maxBytes: number;
    handle?: FileSystemFileHandle;
  };
}
async function installSink(page: Page, mode: SinkMode): Promise<void> {
  await page.addInitScript((initial) => {
    const host = window as unknown as SinkWindow;
    host.exportTest = { mode: initial, picks: 0, writes: 0, maxBytes: 0 };
    host.showSaveFilePicker = async (): Promise<FileSystemFileHandle> => {
      host.exportTest.picks += 1;
      if (host.exportTest.mode === 'cancel') throw new DOMException('cancel', 'AbortError');
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('mesh-export.obj', { create: true });
      host.exportTest.handle = handle;
      const nativeCreate = handle.createWritable.bind(handle);
      handle.createWritable = async (): Promise<FileSystemWritableFileStream> => {
        const stream = await nativeCreate();
        const nativeWrite = stream.write.bind(stream);
        stream.write = async (chunk): Promise<void> => {
          host.exportTest.writes += 1;
          const bytes = chunk as Uint8Array;
          host.exportTest.maxBytes = Math.max(host.exportTest.maxBytes, bytes.byteLength);
          if (host.exportTest.mode !== 'save')
            throw new DOMException(
              'injected sink failure',
              host.exportTest.mode === 'permission'
                ? 'NotAllowedError'
                : host.exportTest.mode === 'disk'
                  ? 'QuotaExceededError'
                  : 'InvalidStateError',
            );
          await nativeWrite(chunk);
        };
        return stream;
      };
      return handle;
    };
  }, mode);
}
async function load(page: Page, triangles = 250_000): Promise<void> {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({ name: 'mesh.stl', mimeType: 'model/stl', buffer: binaryStl(triangles).bytes });
  await expect(page.getByTestId('fact-triangles')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('workflow-convert').click();
  await page.getByTestId('convert-target-obj').check();
}
async function stagingCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('pybrix-export-staging', { create: true });
    let count = 0;
    for await (const entry of directory.values()) {
      if (entry.kind === 'file') count += 1;
    }
    return count;
  });
}

test('small OBJ keeps automatic download without a save picker', async ({ page }) => {
  await installSink(page, 'cancel');
  await load(page, 10_000);
  const pending = page.waitForEvent('download');
  await page.getByTestId('convert-export').click();
  expect((await pending).suggestedFilename()).toBe('mesh.obj');
  await expect(page.getByTestId('convert-saved')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as SinkWindow).exportTest.picks)).toBe(0);
});
test('large native writable export repeats, bounds chunks and cleans staging', async ({ page }) => {
  test.setTimeout(180_000);
  await installSink(page, 'save');
  await load(page);
  let size = 0;
  for (let run = 0; run < 3; run += 1) {
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 90_000 });
    const result = await page.evaluate(async () => {
      const state = (window as unknown as SinkWindow).exportTest;
      if (state.handle === undefined) throw new Error('No selected file');
      const file = await state.handle.getFile();
      return { size: file.size, head: await file.slice(0, 64).text(), maxBytes: state.maxBytes };
    });
    expect(result.head).toContain('# Written by Pybrix');
    expect(result.size).toBeGreaterThan(10_000_000);
    expect(result.maxBytes).toBeLessThanOrEqual(256 * 1024);
    if (run > 0) expect(result.size).toBe(size);
    size = result.size;
    await expect.poll(() => stagingCount(page)).toBe(0);
  }
});
test('save picker cancellation starts no export worker and creates no output', async ({ page }) => {
  await installSink(page, 'cancel');
  await load(page);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-export')).toBeEnabled();
  expect(workers.filter((url) => url.includes('export.worker'))).toHaveLength(0);
  expect(await stagingCount(page)).toBe(0);
});
for (const mode of ['disk', 'permission', 'closed'] as const) {
  test(`large ${mode} failure aborts and the next export succeeds`, async ({ page }) => {
    test.setTimeout(180_000);
    await installSink(page, mode);
    await load(page);
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-failure')).toBeVisible({ timeout: 90_000 });
    expect(
      await page.evaluate(
        async () => (await (window as unknown as SinkWindow).exportTest.handle?.getFile())?.size,
      ),
    ).toBe(0);
    await expect.poll(() => stagingCount(page)).toBe(0);
    await page.evaluate(() => {
      (window as unknown as SinkWindow).exportTest.mode = 'save';
    });
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 90_000 });
  });
}
test('large export can be cancelled from the sticky footer at 300px height', async ({ page }) => {
  await installSink(page, 'save');
  await load(page, 500_000);
  await page.setViewportSize({ width: 1200, height: 300 });
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-cancel')).toBeInViewport();
  await page.getByTestId('convert-cancel').click();
  await expect(page.getByTestId('convert-export')).toBeEnabled();
  await expect.poll(() => stagingCount(page)).toBe(0);
  expect(
    await page.evaluate(
      async () => (await (window as unknown as SinkWindow).exportTest.handle?.getFile())?.size ?? 0,
    ),
  ).toBe(0);
});

test('missing file access reports the capability requirement without starting a worker', async ({
  page,
}) => {
  await load(page);
  await page.evaluate(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-failure')).toBeVisible();
  await page.getByTestId('convert-failure-info').click();
  await expect(page.getByTestId('convert-outcome-details')).toContainText(
    'desktop Chromium file access',
  );
  expect(workers.filter((url) => url.includes('export.worker'))).toHaveLength(0);
});

test('replacing a document cancels a blocked native write and exports the new model', async ({
  page,
}) => {
  await installSink(page, 'save');
  await load(page);
  await page.evaluate(() => {
    const host = window as unknown as SinkWindow;
    const picker = host.showSaveFilePicker;
    host.showSaveFilePicker = async (): Promise<FileSystemFileHandle> => {
      const handle = await picker();
      const create = handle.createWritable.bind(handle);
      handle.createWritable = async (): Promise<FileSystemWritableFileStream> => {
        const stream = await create();
        // A slow device must not keep a replaced document alive or publish it.
        stream.write = (): Promise<void> => new Promise(() => undefined);
        return stream;
      };
      return handle;
    };
  });
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-progress')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({ name: 'replacement.stl', mimeType: 'model/stl', buffer: binaryStl(12).bytes });
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 90_000 });
  await page.getByTestId('workflow-convert').click();
  await page.getByTestId('convert-target-obj').check();
  const pending = page.waitForEvent('download');
  await page.getByTestId('convert-export').click();
  expect((await pending).suggestedFilename()).toBe('replacement.obj');
  expect(
    await page.evaluate(
      async () => (await (window as unknown as SinkWindow).exportTest.handle?.getFile())?.size,
    ),
  ).toBe(0);
});
