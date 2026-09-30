/** Browser-native chunk-size comparison through the production stream core.
 * The never-shipped harness supplies only a chunk-size adapter and native sink. */
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execute = promisify(execFile);
const out = process.env.CADFIXER_EXPORT_EVIDENCE ?? '/private/tmp/pybrix-obj-chunk-evidence';
const model = process.env.CADFIXER_EXPORT_REAL_MODEL;
if (!model) throw new Error('CADFIXER_EXPORT_REAL_MODEL must name the local STL');
mkdirSync(out, { recursive: true });
async function footprint(pid) {
  const { stdout } = await execute('/usr/bin/footprint', ['-p', String(pid)], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const read = (key) => {
    const m = new RegExp(`${key}:\\s+([\\d.]+)\\s*(\\w+)`).exec(stdout);
    return m
      ? Number(m[1]) *
          (m[2].toUpperCase().startsWith('G')
            ? 1024
            : m[2].toUpperCase().startsWith('M')
              ? 1
              : 1 / 1024)
      : 0;
  };
  return { current: read('phys_footprint'), peak: read('phys_footprint_peak') };
}
const profile = mkdtempSync(join(tmpdir(), 'pybrix-chunk-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = context.pages()[0];
const browser = context.browser();
const cdp = await browser.newBrowserCDPSession();
const rows = [];
try {
  await page.addInitScript(() => {
    globalThis.__chunkGap = { last: 0, max: 0 };
    const frame = (time) => {
      const state = globalThis.__chunkGap;
      if (state.last) state.max = Math.max(state.max, time - state.last);
      state.last = time;
      globalThis.requestAnimationFrame(frame);
    };
    globalThis.requestAnimationFrame(frame);
  });
  await page.goto(process.env.CADFIXER_EXPORT_HARNESS_URL ?? 'http://localhost:4192');
  const pending = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await pending).setFiles(model);
  await page.getByTestId('workflow-repair').click({ timeout: 600_000 });
  await page
    .getByTestId('repair-op-status-fill-openings')
    .filter({ hasNotText: /Checking/ })
    .waitFor({ timeout: 600_000 });
  const renderer = (await cdp.send('SystemInfo.getProcessInfo')).processInfo
    .filter((p) => p.type === 'renderer')
    .at(-1).id;
  for (const chunkBytes of [64, 256, 1024, 4096].map((kib) => kib * 1024)) {
    await page.waitForTimeout(5000);
    await page.evaluate(() => {
      globalThis.__chunkGap.max = 0;
      globalThis.__chunkGap.last = 0;
    });
    const baseline = await footprint(renderer);
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-v8.gc',
      transferMode: 'ReturnAsStream',
    });
    let result, failure;
    const finished = page
      .evaluate((size) => globalThis.cadfixerHarness.chunkBenchmark(size), chunkBytes)
      .then((value) => {
        result = value;
      })
      .catch((error) => {
        failure = error;
      });
    const samples = [];
    while (result === undefined && failure === undefined) {
      samples.push(await footprint(renderer));
      await page.waitForTimeout(100);
    }
    await finished;
    if (failure) throw failure;
    const traceDone = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const event = await traceDone;
    let text = '';
    for (;;) {
      const read = await cdp.send('IO.read', { handle: event.stream });
      text += read.base64Encoded ? Buffer.from(read.data, 'base64').toString() : read.data;
      if (read.eof) break;
    }
    await cdp.send('IO.close', { handle: event.stream });
    writeFileSync(join(out, `chunks-${chunkBytes}.trace.json`), text);
    const events = JSON.parse(text).traceEvents;
    const gc = events.filter((e) => (e.name === 'MinorGC' || e.name === 'MajorGC') && e.ph === 'X');
    const cancel = await page.evaluate(
      (size) => globalThis.cadfixerHarness.chunkBenchmark(size, 200),
      chunkBytes,
    );
    const row = {
      chunkBytes,
      ...result,
      rendererBaselineMiB: baseline.current,
      rendererSampledPeakMiB: Math.max(baseline.current, ...samples.map((s) => s.current)),
      rendererLifetimePeakMiB: Math.max(baseline.peak, ...samples.map((s) => s.peak)),
      longestFrameGapMs: await page.evaluate(() => globalThis.__chunkGap.max),
      gcEvents: gc.length,
      gcMs: gc.reduce((sum, e) => sum + e.dur / 1000, 0),
      cancelStatus: cancel.status,
      cancelLatencyMs: cancel.cancelLatencyMs,
      samples,
    };
    rows.push(row);
    writeFileSync(join(out, 'chunks.json'), JSON.stringify(rows, null, 2));
    process.stdout.write(JSON.stringify({ ...row, samples: undefined }) + '\n');
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
