import { test, expect, type Page } from '@playwright/test';
import { binaryStl } from './stl-fixtures';

type SinkMode = 'save' | 'cancel' | 'disk' | 'permission' | 'closed' | 'blocked';
interface SinkWindow extends Window {
  showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
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
    host.showDirectoryPicker = async (): Promise<FileSystemDirectoryHandle> => {
      host.exportTest.picks += 1;
      if (host.exportTest.mode === 'cancel') throw new DOMException('cancel', 'AbortError');
      const root = await navigator.storage.getDirectory();
      const lookup = root.getFileHandle.bind(root);
      root.getFileHandle = async (name, options): Promise<FileSystemFileHandle> => {
        const handle = await lookup(name, options);
        host.exportTest.handle = handle;
        const nativeCreate = handle.createWritable.bind(handle);
        handle.createWritable = async (configuration): Promise<FileSystemWritableFileStream> => {
          const stream = await nativeCreate(configuration);
          const nativeWrite = stream.write.bind(stream);
          stream.write = async (chunk): Promise<void> => {
            host.exportTest.writes += 1;
            const bytes = chunk as Uint8Array;
            host.exportTest.maxBytes = Math.max(host.exportTest.maxBytes, bytes.byteLength);
            if (host.exportTest.mode === 'blocked') {
              await new Promise<void>(() => undefined);
              return;
            }
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
      return root;
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
    if (run > 0) await page.getByTestId('convert-overwrite-confirm').click();
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
      await page.evaluate(async () => {
        try {
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle('mesh.obj', { create: false });
          return false;
        } catch (cause) {
          return cause instanceof DOMException && cause.name === 'NotFoundError';
        }
      }),
    ).toBe(true);
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
    await page.evaluate(async () => {
      try {
        await (await navigator.storage.getDirectory()).getFileHandle('mesh.obj', { create: false });
        return false;
      } catch (cause) {
        return cause instanceof DOMException && cause.name === 'NotFoundError';
      }
    }),
  ).toBe(true);
});

test('missing file access reports the capability requirement without starting a worker', async ({
  page,
}) => {
  await load(page);
  await page.evaluate(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
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
    (window as unknown as SinkWindow).exportTest.mode = 'blocked';
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
    await page.evaluate(async () => {
      try {
        await (await navigator.storage.getDirectory()).getFileHandle('mesh.obj', { create: false });
        return false;
      } catch (cause) {
        return cause instanceof DOMException && cause.name === 'NotFoundError';
      }
    }),
  ).toBe(true);
});

test('existing lookup and declined overwrite preserve bytes; filename and folder edits reclassify', async ({
  page,
}) => {
  await installSink(page, 'save');
  await load(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('mesh.obj', { create: true });
    const writer = await file.createWritable();
    await writer.write('KEEP ORIGINAL');
    await writer.close();
  });
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.getByTestId('convert-folder').click();
  await expect(page.getByTestId('convert-destination-note')).toContainText('Existing file');
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-overwrite')).toContainText('mesh.obj');
  expect(workers.filter((url) => url.includes('export.worker'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Keep existing file', exact: true }).click();
  await expect(page.getByTestId('convert-export')).toBeEnabled();
  await page.getByTestId('convert-filename').fill('模型');
  await expect(page.getByTestId('convert-destination-note')).toHaveText('New file');
  await page.evaluate(() => {
    (window as unknown as SinkWindow).showDirectoryPicker =
      async (): Promise<FileSystemDirectoryHandle> =>
        await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle('other-folder', { create: true });
  });
  await page.getByTestId('convert-folder').click();
  await expect(page.getByTestId('convert-folder')).toHaveText('Folder: other-folder');
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-saved')).toContainText('模型.obj', { timeout: 90_000 });
  const files = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    return {
      original: await (await (await root.getFileHandle('mesh.obj')).getFile()).text(),
      saved: (
        await (
          await (await root.getDirectoryHandle('other-folder')).getFileHandle('模型.obj')
        ).getFile()
      ).size,
    };
  });
  expect(files.original).toBe('KEEP ORIGINAL');
  expect(files.saved).toBeGreaterThan(10_000_000);
});

test('changed existing metadata requires a fresh confirmation before worker creation', async ({
  page,
}) => {
  await installSink(page, 'save');
  await load(page);
  const change = async (text: string): Promise<void> => {
    await page.evaluate(async (value) => {
      const file = await (
        await navigator.storage.getDirectory()
      ).getFileHandle('mesh.obj', { create: true });
      const writer = await file.createWritable();
      await writer.write(value);
      await writer.close();
    }, text);
  };
  await change('old');
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-overwrite')).toContainText('3 bytes');
  await change('changed externally');
  await page.getByTestId('convert-overwrite-confirm').click();
  await expect(page.getByTestId('convert-overwrite')).toContainText('18 bytes');
  await expect(page.getByTestId('convert-footer')).toContainText('File changed.');
  expect(workers.filter((url) => url.includes('export.worker'))).toHaveLength(0);
  await page.getByTestId('convert-overwrite-confirm').click();
  await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 90_000 });
});

test('invalid filename fails before invoking a directory picker', async ({ page }) => {
  await installSink(page, 'save');
  await load(page);
  await page.getByTestId('convert-filename').fill('../unsafe');
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-failure')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as SinkWindow).exportTest.picks)).toBe(0);
});
