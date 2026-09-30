/** EXPORT-CORE-01 hardware acceptance. Native OPFS handles replace only the OS
 * picker; the production UI, worker, validation and writable stream run intact.
 * Run with CADFIXER_EXPORT_EVIDENCE and optionally CADFIXER_EXPORT_REAL_MODEL.
 * No remote model traffic, production access, or committed model fixtures. */
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { holedCubeStl } from './boundary-fill-fixture.mjs';

const execute = promisify(execFile);
const out = process.env.CADFIXER_EXPORT_EVIDENCE ?? '/private/tmp/pybrix-obj-export-evidence';
const url = process.env.CADFIXER_EXPORT_URL ?? 'http://localhost:4191';
const real = process.env.CADFIXER_EXPORT_REAL_MODEL;
const requested = (process.env.CADFIXER_EXPORT_SIZES ?? '10000,100000,250000,500000,1000000')
  .split(',')
  .map(Number)
  .filter((value) => value > 0);
mkdirSync(out, { recursive: true });
const rows = [];
async function footprint(pid) {
  const { stdout } = await execute('/usr/bin/footprint', ['-p', String(pid)], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const read = (key) => {
    const match = new RegExp(`${key}:\\s+([\\d.]+)\\s*(\\w+)`).exec(stdout);
    return match
      ? Number(match[1]) *
          (match[2].toUpperCase().startsWith('G')
            ? 1024
            : match[2].toUpperCase().startsWith('M')
              ? 1
              : 1 / 1024)
      : 0;
  };
  return { current: read('phys_footprint'), peak: read('phys_footprint_peak') };
}
async function open() {
  const profile = mkdtempSync(join(tmpdir(), 'pybrix-export-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const browser = context.browser();
  const page = context.pages()[0] ?? (await context.newPage());
  await page.addInitScript(() => {
    globalThis.__exportEvidence = {
      picks: 0,
      frames: 0,
      gap: 0,
      measuring: false,
      last: 0,
      writes: 0,
      maxChunk: 0,
    };
    globalThis.showDirectoryPicker = async () => {
      const state = globalThis.__exportEvidence;
      state.picks += 1;
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('qualification-output', { create: true });
      const getFileHandle = directory.getFileHandle.bind(directory);
      directory.getFileHandle = async (name, flags) => {
        const handle = await getFileHandle(name, flags);
        state.handle = handle;
        // Keep native destination behavior; observe bounded writes and backpressure.
        const create = handle.createWritable.bind(handle);
        handle.createWritable = async (options) => {
          const stream = await create(options);
          const write = stream.write.bind(stream);
          stream.write = async (chunk) => {
            state.writes += 1;
            state.maxChunk = Math.max(state.maxChunk, chunk.byteLength);
            if (state.inFlight) throw new Error('More than one chunk in flight');
            state.inFlight = true;
            try {
              await write(chunk);
            } finally {
              state.inFlight = false;
            }
          };
          return stream;
        };
        return handle;
      };
      return directory;
    };
    const frame = (time) => {
      const state = globalThis.__exportEvidence;
      if (state.measuring && state.last) {
        state.gap = Math.max(state.gap, time - state.last);
        state.frames += 1;
      }
      state.last = time;
      globalThis.requestAnimationFrame(frame);
    };
    globalThis.requestAnimationFrame(frame);
  });
  page.on('pageerror', (error) => console.error('PAGE ERROR', error.message));
  await page.goto(url);
  await page.getByTestId('browse-button').waitFor();
  const cdp = await browser.newBrowserCDPSession();
  const processes = (await cdp.send('SystemInfo.getProcessInfo')).processInfo;
  const renderer = processes.filter((process) => process.type === 'renderer').at(-1).id;
  const browserPid = processes.find((process) => process.type === 'browser').id;
  writeFileSync(
    join(out, 'gpu.json'),
    JSON.stringify(await cdp.send('SystemInfo.getInfo'), null, 2),
  );
  return {
    browser,
    page,
    renderer,
    browserPid,
    close: async () => {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
async function importFile(page, path) {
  const pending = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await pending).setFiles(path);
  await page.waitForFunction(
    (name) =>
      globalThis.document.querySelector('[data-testid="fact-filename"]')?.textContent === name,
    basename(path),
    { timeout: 600_000 },
  );
  await page.getByTestId('workflow-repair').click({ timeout: 600_000 });
  await page.getByTestId('issue-list').waitFor({ timeout: 600_000 });
  await page
    .getByTestId('repair-op-status-fill-openings')
    .filter({ hasNotText: /Checking/ })
    .waitFor({ timeout: 600_000 });
}
async function issues(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...globalThis.document.querySelectorAll('[data-testid^="issue-count-"]')].map((node) => [
        node.getAttribute('data-testid'),
        node.textContent,
      ]),
    ),
  );
}
async function cleanupCount(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('pybrix-export-staging', { create: true });
    let count = 0;
    for await (const entry of directory.values()) if (entry.kind === 'file') count += 1;
    return count;
  });
}
async function exportOne(host, label, triangles, capture, cancel = false) {
  const { page, renderer, browserPid } = host;
  await page.getByTestId('workflow-convert').click();
  await page.getByTestId('convert-target-obj').check();
  await page.evaluate(() => {
    Object.assign(globalThis.__exportEvidence, {
      gap: 0,
      frames: 0,
      last: 0,
      measuring: true,
      writes: 0,
      maxChunk: 0,
    });
  });
  const before = await footprint(renderer);
  const beforeBrowser = await footprint(browserPid);
  const timeline = [{ phase: 'before', renderer: before, browser: beforeBrowser }];
  let download;
  const listener = (value) => {
    download = value;
  };
  page.on('download', listener);
  const started = Date.now();
  await page.getByTestId('convert-filename').fill(`${label}.obj`);
  await page.getByTestId('convert-export').click();
  if (cancel) {
    await page.getByTestId('convert-progress').waitFor();
    await page.waitForTimeout(200);
    const at = Date.now();
    await page.getByTestId('convert-cancel').click();
    await page.getByTestId('convert-export').waitFor({ state: 'visible' });
    const latency = Date.now() - at;
    await page.waitForTimeout(1500);
    const state = await page.evaluate(async () => ({
      exists:
        (await globalThis.__exportEvidence.handle?.getFile().then(
          () => true,
          (error) => {
            if (error.name === 'NotFoundError') return false;
            throw error;
          },
        )) ?? false,
    }));
    const result = {
      label,
      triangles,
      cancelled: true,
      cancelLatencyMs: latency,
      destinationExists: state.exists,
      stagingFiles: await cleanupCount(page),
    };
    page.off('download', listener);
    process.stdout.write(JSON.stringify(result) + '\n');
    rows.push(result);
    return result;
  }
  let completeAt;
  let completionError;
  const completion = page
    .getByTestId('convert-saved')
    .waitFor({ timeout: 600_000 })
    .then(() => {
      completeAt = Date.now();
    })
    .catch((error) => {
      completionError = error;
    });

  while (completeAt === undefined) {
    if (completionError) throw completionError;
    if (await page.getByTestId('convert-failure').count())
      throw new Error(await page.getByTestId('convert-failure').innerText());
    const [rendererMemory, browserMemory] = await Promise.all([
      footprint(renderer),
      footprint(browserPid),
    ]);
    timeline.push({
      atMs: Date.now() - started,
      phase: await page.evaluate(
        () =>
          globalThis.document.querySelector('[data-testid="convert-phase"]')?.textContent ??
          'complete',
      ),
      renderer: rendererMemory,
      browser: browserMemory,
    });
    await page.waitForTimeout(100);
  }
  await completion;
  const state = await page.evaluate(() => {
    const state = globalThis.__exportEvidence;
    state.measuring = false;
    return {
      picks: state.picks,
      frames: state.frames,
      gap: state.gap,
      writes: state.writes,
      maxChunk: state.maxChunk,
    };
  });
  let outputBytes;
  if (state.writes > 0) {
    outputBytes = await page.evaluate(
      async () => (await globalThis.__exportEvidence.handle.getFile()).size,
    );
    if (capture) {
      const pending = page.waitForEvent('download');
      await page.evaluate(async () => {
        const file = await globalThis.__exportEvidence.handle.getFile();
        const link = globalThis.document.createElement('a');
        const url = URL.createObjectURL(file);
        link.href = url;
        link.download = file.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      });
      await (await pending).saveAs(join(out, `${label}.obj`));
    }
  } else {
    if (download === undefined) throw new Error('Small export did not download');
    await download.saveAs(join(out, `${label}.obj`));
    outputBytes = readFileSync(join(out, `${label}.obj`)).byteLength;
  }
  page.off('download', listener);
  timeline.push({
    phase: 'immediate',
    renderer: await footprint(renderer),
    browser: await footprint(browserPid),
  });
  await page.waitForTimeout(5000);
  const five = await footprint(renderer);
  timeline.push({ phase: 'five-seconds', renderer: five });
  let thirty;
  if (label.includes('real')) {
    await page.waitForTimeout(25_000);
    thirty = await footprint(renderer);
    timeline.push({ phase: 'thirty-seconds', renderer: thirty });
  }
  const peak = Math.max(...timeline.map((point) => point.renderer.current));
  const lifetimePeak = Math.max(...timeline.map((point) => point.renderer.peak));
  const result = {
    label,
    triangles,
    outputBytes,
    path: state.writes ? 'file' : 'blob',
    elapsedMs: completeAt - started,
    rendererBaselineMiB: before.current,
    rendererSampledPeakMiB: peak,
    rendererLifetimePeakMiB: lifetimePeak,
    browserPeakMiB: Math.max(
      ...timeline.filter((point) => point.browser).map((point) => point.browser.peak),
    ),
    extraMiB: peak - before.current,
    afterFiveMiB: five.current,
    afterThirtyMiB: thirty?.current,
    longestFrameGapMs: state.gap,
    frames: state.frames,
    writes: state.writes,
    maxChunkBytes: state.maxChunk,
    stagingFiles: await cleanupCount(page),
    ...(capture
      ? {
          sha256: createHash('sha256')
            .update(readFileSync(join(out, `${label}.obj`)))
            .digest('hex'),
        }
      : {}),
    timeline,
  };
  rows.push(result);
  if (rows.length > 0) writeFileSync(join(out, 'matrix.json'), JSON.stringify(rows, null, 2));
  process.stdout.write(JSON.stringify({ ...result, timeline: undefined }) + '\n');
  return result;
}

for (const triangles of requested) {
  const source = holedCubeStl(Math.ceil(Math.sqrt(triangles / 12)), { simple: 0, branched: 0 });
  const bytes = source.bytes.subarray(0, 84 + triangles * 50);
  bytes.writeUInt32LE(triangles, 80);
  const path = join(out, `${triangles}.stl`);
  writeFileSync(path, bytes);
  const host = await open();
  try {
    await importFile(host.page, path);
    await host.page.waitForTimeout(5000);
    await exportOne(host, String(triangles), triangles, true);
    if (triangles >= 100_000) await exportOne(host, `${triangles}-cancel`, triangles, false, true);
  } finally {
    await host.close();
  }
}
if (process.env.CADFIXER_EXPORT_REIMPORT) {
  const host = await open();
  try {
    await importFile(host.page, process.env.CADFIXER_EXPORT_REIMPORT);
    writeFileSync(
      join(out, 'real-reimport-topology.json'),
      JSON.stringify(
        {
          triangles: await host.page.getByTestId('status-triangles').textContent(),
          issues: await issues(host.page),
        },
        null,
        2,
      ),
    );
    await importFile(host.page, join(out, '10000.stl'));
    const immediate = await footprint(host.renderer);
    await host.page.waitForTimeout(5000);
    const five = await footprint(host.renderer);
    await host.page.waitForTimeout(25_000);
    const thirty = await footprint(host.renderer);
    writeFileSync(
      join(out, 'post-replacement.json'),
      JSON.stringify(
        {
          triangles: await host.page.getByTestId('status-triangles').textContent(),
          immediate,
          five,
          thirty,
        },
        null,
        2,
      ),
    );
  } finally {
    await host.close();
  }
}
if (real) {
  const host = await open();
  try {
    await importFile(host.page, real);
    writeFileSync(
      join(out, 'real-source-topology.json'),
      JSON.stringify(await issues(host.page), null, 2),
    );
    await host.page.waitForTimeout(5000);
    for (let run = 1; run <= Number(process.env.CADFIXER_EXPORT_RUNS ?? 3); run += 1)
      await exportOne(host, `real-${run}`, 1_988_877, true);
    await exportOne(host, 'real-cancel', 1_988_877, false, true);
    await host.page.getByTestId('workflow-repair').click();
    await host.page.getByTestId('preview-repair').click();
    await host.page
      .locator('[data-testid="apply-repair"]:enabled, [data-testid="repair-candidate-error"]')
      .first()
      .waitFor({ timeout: 600_000 });
    await host.page.getByTestId('apply-repair').click();
    await host.page
      .getByTestId('repair-applied-remaining')
      .filter({ hasNotText: 'Checking the repaired mesh' })
      .waitFor({ timeout: 600_000 });
    await host.page.waitForTimeout(30_000);
    await exportOne(host, 'real-repaired', 1_988_883, true);
    await importFile(host.page, join(out, `${requested[0] ?? 10000}.stl`));
    const replacementImmediate = await footprint(host.renderer);
    await host.page.waitForTimeout(5000);
    const replacementFive = await footprint(host.renderer);
    await host.page.waitForTimeout(25_000);
    const replacementThirty = await footprint(host.renderer);
    writeFileSync(
      join(out, 'post-export-replacement.json'),
      JSON.stringify(
        {
          triangles: await host.page.getByTestId('status-triangles').textContent(),
          immediate: replacementImmediate,
          five: replacementFive,
          thirty: replacementThirty,
          issues: await issues(host.page),
        },
        null,
        2,
      ),
    );
    await importFile(host.page, join(out, 'real-repaired.obj'));
    writeFileSync(
      join(out, 'real-reimport-topology.json'),
      JSON.stringify(
        {
          triangles: await host.page.getByTestId('status-triangles').textContent(),
          issues: await issues(host.page),
        },
        null,
        2,
      ),
    );
    await importFile(host.page, join(out, `${requested[0] ?? 10000}.stl`));
    const immediate = await footprint(host.renderer);
    await host.page.waitForTimeout(5000);
    const five = await footprint(host.renderer);
    await host.page.waitForTimeout(25_000);
    const thirty = await footprint(host.renderer);
    writeFileSync(
      join(out, 'post-replacement.json'),
      JSON.stringify(
        {
          triangles: await host.page.getByTestId('status-triangles').textContent(),
          immediate,
          five,
          thirty,
          stagingFiles: await cleanupCount(host.page),
        },
        null,
        2,
      ),
    );
  } finally {
    await host.close();
  }
}
if (rows.length > 0) writeFileSync(join(out, 'matrix.json'), JSON.stringify(rows, null, 2));
