/**
 * REPAIR-CORE-02 — CHROMIUM QUALIFICATION OF AUTOMATIC BOUNDARY FILLING.
 *
 * NOT A TEST AND NOT PART OF ANY SUITE. A standalone harness, run by hand
 * against a production build served by `npm run preview`, in the same shape as
 * `import-phases.qualify.mjs`: one browser per case, the renderer's macOS
 * `phys_footprint_peak` read at phase boundaries, and the whole browser's peak
 * summed at the end.
 *
 * THE FIXTURE is the holed cube (`boundary-fill-fixture.mjs`): closed, with 6
 * simple planar openings and 7 branched boundaries — the shape of the model
 * that motivated the stage — at the requested triangle count.
 *
 * PHASES, each a DOM transition the application already exposes:
 *   import    triangles shown
 *   analysis  the issue list is rendered (automatic topology analysis done)
 *   plan      the fill option's status settled (compact scan + admission)
 *   preview   Apply repairs enabled (fill stage: region, disposable-worker
 *             exact check, append, independent re-analysis)
 *   apply     the result card shows what remains (commit + re-analysis)
 *
 * MAIN-THREAD RESPONSIVENESS: the longest gap between animation frames while
 * the plan and the preview run, recorded in the page.
 *
 * CANCELLATION (`--cancel`): press Repair model, then Cancel as soon as the
 * phase reads "Checking the openings" (or after 300 ms), and time until the
 * panel says the repair was cancelled; the model must be unchanged.
 *
 * Run: npm run build && npm run preview     (in another terminal)
 *      npm run qualify:boundary-fill -- 100000,250000,500000,1000000,2000000
 *      npm run qualify:boundary-fill -- 2000000 --cancel
 *      npm run qualify:boundary-fill -- 2000000 --hardware-gl
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gridForTriangles, holedCubeStl } from './boundary-fill-fixture.mjs';

const BASE_URL = process.env.CADFIXER_QUALIFY_URL ?? 'http://localhost:4173/';
const MIB = 1024 * 1024;
const LONG = 20 * 60_000;

function footprint(pid) {
  let text;
  try {
    text = execFileSync('/usr/bin/footprint', ['-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch (error) {
    process.stderr.write(`footprint(1) failed for pid ${String(pid)}: ${String(error)}\n`);
    return undefined;
  }
  const read = (key) => {
    const match = new RegExp(`${key}:\\s+([\\d.]+)\\s*(\\w+)`).exec(text);
    if (match === null) return undefined;
    const unit = match[2].toUpperCase();
    const scale = unit.startsWith('G') ? 1024 * MIB : unit.startsWith('M') ? MIB : 1024;
    return Number(match[1]) * scale;
  };
  const peak = read('phys_footprint_peak');
  return peak === undefined ? undefined : { peak, current: read('phys_footprint') ?? 0 };
}

async function wholeBrowserPeak(session) {
  const info = await session.send('SystemInfo.getProcessInfo');
  let peak = 0;
  const byType = new Map();
  for (const entry of info.processInfo) {
    const reading = footprint(entry.id);
    if (reading === undefined) continue;
    peak += reading.peak;
    byType.set(entry.type, (byType.get(entry.type) ?? 0) + reading.peak);
  }
  return { peak, byType };
}

const mib = (bytes) => (bytes === undefined ? '  n/a' : `${(bytes / MIB).toFixed(0)}`.padStart(5));

async function frameGapMonitor(page) {
  await page.evaluate(() => {
    const state = { last: performance.now(), max: 0, running: true };
    globalThis.__gap = state;
    const tick = (now) => {
      if (!state.running) return;
      state.max = Math.max(state.max, now - state.last);
      state.last = now;
      globalThis.requestAnimationFrame(tick);
    };
    globalThis.requestAnimationFrame(tick);
  });
}

async function resetGap(page) {
  await page.evaluate(() => {
    globalThis.__gap.max = 0;
    globalThis.__gap.last = performance.now();
  });
}

async function readGap(page) {
  return page.evaluate(() => globalThis.__gap.max);
}

async function qualify(directory, target, cancel) {
  const cube = holedCubeStl(gridForTriangles(target));
  const path = join(directory, `holed-cube-${String(cube.triangles)}.stl`);
  writeFileSync(path, cube.bytes);

  const browser = await chromium.launch(
    HARDWARE_GL
      ? { headless: false, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] }
      : {},
  );
  const lines = [];
  try {
    const session = await browser.newBrowserCDPSession();
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    await page.goto(BASE_URL);
    await page.getByTestId('browse-button').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1_000);
    const renderers = (await session.send('SystemInfo.getProcessInfo')).processInfo.filter(
      (entry) => entry.type === 'renderer',
    );
    const pid = renderers[renderers.length - 1]?.id;
    if (pid === undefined) throw new Error('no renderer process found');
    await frameGapMonitor(page);
    const baseline = footprint(pid);

    const t0 = Date.now();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('browse-button').click();
    await (await chooser).setFiles(path);
    await page
      .getByTestId('status-triangles')
      .filter({ hasText: cube.triangles.toLocaleString('en-US') })
      .waitFor({ timeout: LONG });
    const tImport = Date.now();
    const afterImport = footprint(pid);
    await resetGap(page);

    await page.getByTestId('issue-list').waitFor({ timeout: LONG });
    const tAnalysis = Date.now();
    const analysisGap = await readGap(page);
    const afterAnalysis = footprint(pid);

    await resetGap(page);
    const status = page.getByTestId('repair-op-status-fill-openings');
    await status.filter({ hasText: /to fill|None eligible|Too many/ }).waitFor({ timeout: LONG });
    const tPlan = Date.now();
    const planGap = await readGap(page);
    const afterPlan = footprint(pid);
    const statusText = (await status.textContent()) ?? '';

    lines.push(
      `${cube.triangles.toLocaleString('en-US')} triangles (${(cube.bytes.length / MIB).toFixed(1)} MiB STL)`,
    );
    const row = (label, phase, previous, millis, extra = '') =>
      `    ${label.padEnd(9)} peak ${mib(phase?.peak)} MiB (+${mib(
        phase?.peak === undefined || previous?.peak === undefined
          ? undefined
          : Math.max(0, phase.peak - previous.peak),
      )}) current ${mib(phase?.current)} MiB  ${String(millis).padStart(6)} ms ${extra}`;
    lines.push(row('baseline', baseline, undefined, 0));
    lines.push(row('import', afterImport, baseline, tImport - t0));
    lines.push(
      row(
        'analysis',
        afterAnalysis,
        afterImport,
        tAnalysis - tImport,
        `max frame gap ${analysisGap.toFixed(0)} ms (existing automatic analysis, for comparison)`,
      ),
    );
    lines.push(
      row(
        'plan',
        afterPlan,
        afterAnalysis,
        tPlan - tAnalysis,
        `fill: "${statusText}" max frame gap ${planGap.toFixed(0)} ms`,
      ),
    );

    if (cancel) {
      await resetGap(page);
      await page.getByTestId('preview-repair').click();
      const phase = page.getByTestId('repair-phase');
      await phase
        .filter({ hasText: /Checking the openings|Revalidating/ })
        .waitFor({ timeout: 5_000 })
        .catch(() => page.waitForTimeout(300));
      const tCancel = Date.now();
      const phaseText = (await phase.textContent().catch(() => '')) ?? '';
      await page.getByTestId('cancel-repair').click();
      await page.getByTestId('repair-cancelled').waitFor({ timeout: LONG });
      const tCancelled = Date.now();
      const triangles = (await page.getByTestId('status-triangles').textContent()) ?? '';
      lines.push(
        `    cancel during "${phaseText}": acknowledged in ${String(tCancelled - tCancel)} ms; triangles after ${triangles} (unchanged: ${String(triangles === cube.triangles.toLocaleString('en-US'))}); max frame gap ${(await readGap(page)).toFixed(0)} ms`,
      );
    } else {
      await resetGap(page);
      await page.getByTestId('preview-repair').click();
      await page
        .locator('[data-testid="apply-repair"]:enabled, [data-testid="repair-candidate-error"]')
        .first()
        .waitFor({ timeout: LONG });
      const tPreview = Date.now();
      const previewGap = await readGap(page);
      const afterPreview = footprint(pid);
      const filled =
        (await page
          .getByTestId('change-count-filledOpenings')
          .textContent()
          .catch(() => 'n/a')) ?? 'n/a';
      const leftOpen =
        (await page
          .getByTestId('fill-left-open-count')
          .textContent()
          .catch(() => '')) ?? '';
      lines.push(
        row(
          'preview',
          afterPreview,
          afterPlan,
          tPreview - tPlan,
          `filled ${filled}; ${leftOpen}; max frame gap ${previewGap.toFixed(0)} ms`,
        ),
      );

      await page.getByTestId('apply-repair').click();
      await page
        .getByTestId('repair-applied-remaining')
        .filter({ hasNotText: 'Checking the repaired mesh' })
        .waitFor({ timeout: LONG });
      const tApply = Date.now();
      const afterApply = footprint(pid);
      const remaining = (await page.getByTestId('repair-applied-remaining').textContent()) ?? '';
      const triangles = (await page.getByTestId('status-triangles').textContent()) ?? '';
      lines.push(
        row(
          'apply',
          afterApply,
          afterPreview,
          tApply - tPreview,
          `triangles ${triangles}; remaining: ${remaining}`,
        ),
      );
    }

    const whole = await wholeBrowserPeak(session);
    lines.push(
      `    whole browser peak ${mib(whole.peak)} MiB (${[...whole.byType]
        .map(([type, bytes]) => `${type} ${(bytes / MIB).toFixed(0)}`)
        .join(', ')})`,
    );
    const lost = (await page.getByTestId('session-lost').count()) > 0;
    const crashed = (await page.getByTestId('app-crashed').count()) > 0;
    lines.push(`    sessionLost=${String(lost)} appCrashed=${String(crashed)}`);
  } finally {
    await browser.close();
    rmSync(path, { force: true });
  }
  process.stdout.write(`${lines.join('\n')}\n\n`);
}

const args = process.argv.slice(2);
const cancel = args.includes('--cancel');
/**
 * `--hardware-gl`: a HEADED Chromium drawing through the machine's GPU (Metal
 * on macOS). Headless Chromium draws WebGL through SwiftShader, a CPU
 * rasteriser, where one redraw of a 2M-triangle part takes 1.3–1.7 s with no
 * page script involved at all; its frame gaps measure the rasteriser, not the
 * main thread.
 */
const HARDWARE_GL = args.includes('--hardware-gl');
const sizes = (args.find((entry) => !entry.startsWith('--')) ?? '100000').split(',').map(Number);
const directory = mkdtempSync(join(tmpdir(), 'pybrix-fill-'));
try {
  for (const size of sizes) await qualify(directory, size, cancel);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
