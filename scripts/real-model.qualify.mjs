/**
 * REPAIR-RC-03 — REAL-MODEL ACCEPTANCE IN A HARDWARE-ACCELERATED CHROMIUM.
 *
 * NOT A TEST AND NOT PART OF ANY SUITE, and it ships NO data: point it at a
 * binary STL the user already has.
 *
 *   npm run build && npm run preview            (in another terminal)
 *   CADFIXER_REAL_MODEL=/path/model.stl npm run qualify:real-model
 *
 * A HEADED Chromium drawing through the machine's GPU (Metal on macOS):
 * headless Chromium rasterises WebGL on the CPU and its frame gaps measure that
 * rasteriser, not the page (see docs/design/REPAIR_CORE_02.md §9).
 *
 * THREE SESSIONS, one browser each:
 *   1. the whole workflow — import, analysis, plan, preview, apply, undo, a
 *      deterministic retry, viewport interaction, and STL / OBJ / 3MF export
 *      and re-import of the repaired model. The exported STL is also compared
 *      with the input BYTE FOR BYTE: every original facet's coordinates must be
 *      unchanged and in order, with only the patch facets appended.
 *   2. cancellation during the preview's exact check / revalidation, then a
 *      fresh Repair model on the same page.
 *   3. stale replacement: a different model imported while planning, and
 *      again while a preview is running; the replacement must stay authoritative
 *      and the worker usable.
 *
 * Memory is the renderer's macOS `phys_footprint_peak` (monotonic, so the value
 * read after a phase is the peak up to then) plus the current footprint.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gridForTriangles, holedCubeStl } from './boundary-fill-fixture.mjs';

const BASE_URL = process.env.CADFIXER_QUALIFY_URL ?? 'http://localhost:4173/';
const MODEL = process.env.CADFIXER_REAL_MODEL;
const MIB = 1024 * 1024;
const LONG = 20 * 60_000;
const HARDWARE = {
  headless: false,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
};

if (MODEL === undefined || MODEL === '') {
  process.stdout.write('Set CADFIXER_REAL_MODEL=/path/to/model.stl to run.\n');
  process.exit(0);
}

const out = [];
const log = (line) => {
  out.push(line);
  process.stdout.write(`${line}\n`);
};

function footprint(pid) {
  const text = execFileSync('/usr/bin/footprint', ['-p', String(pid)], {
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * MIB,
  }).toString();
  const read = (key) => {
    const match = new RegExp(`${key}:\\s+([\\d.]+)\\s*(\\w+)`).exec(text);
    if (match === null) return undefined;
    const unit = match[2].toUpperCase();
    const scale = unit.startsWith('G') ? 1024 * MIB : unit.startsWith('M') ? MIB : 1024;
    return Number(match[1]) * scale;
  };
  return { peak: read('phys_footprint_peak') ?? 0, current: read('phys_footprint') ?? 0 };
}
const mib = (bytes) => `${(bytes / MIB).toFixed(0)} MiB`;

async function open() {
  const browser = await chromium.launch(HARDWARE);
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  const console = [];
  page.on('console', (message) => console.push(`${message.type()}: ${message.text()}`));
  await page.goto(BASE_URL);
  await page.getByTestId('browse-button').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1_000);
  const session = await browser.newBrowserCDPSession();
  const renderers = (await session.send('SystemInfo.getProcessInfo')).processInfo.filter(
    (entry) => entry.type === 'renderer',
  );
  const pid = renderers[renderers.length - 1]?.id;
  await page.evaluate(() => {
    const state = { last: performance.now(), max: 0 };
    globalThis.__gap = state;
    const tick = (now) => {
      state.max = Math.max(state.max, now - state.last);
      state.last = now;
      globalThis.requestAnimationFrame(tick);
    };
    globalThis.requestAnimationFrame(tick);
  });
  return { browser, page, pid, console };
}

const resetGap = (page) =>
  page.evaluate(() => {
    globalThis.__gap.max = 0;
    globalThis.__gap.last = performance.now();
  });
const readGap = async (page) => Math.round(await page.evaluate(() => globalThis.__gap.max));

async function importFile(page, path) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles(path);
}

async function settledPlan(page) {
  const status = page.getByTestId('repair-op-status-fill-openings');
  await status.filter({ hasNotText: /Checking/ }).waitFor({ timeout: LONG });
  return (await status.textContent()) ?? '';
}

async function issueCounts(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...globalThis.document.querySelectorAll('[data-testid^="issue-count-"]')].map((node) => [
        node.getAttribute('data-testid').replace('issue-count-', ''),
        node.textContent,
      ]),
    ),
  );
}

const text = async (page, id) =>
  (
    (await page
      .getByTestId(id)
      .first()
      .textContent()
      .catch(() => '')) ?? ''
  ).trim();
const triangles = (page) => text(page, 'status-triangles');

async function preview(page) {
  await page.getByTestId('preview-repair').click();
  await page
    .locator('[data-testid="apply-repair"]:enabled, [data-testid="repair-candidate-error"]')
    .first()
    .waitFor({ timeout: LONG });
  return {
    filled: await text(page, 'change-count-filledOpenings'),
    leftOpen: await text(page, 'fill-left-open'),
  };
}

async function applyRepair(page) {
  await page.getByTestId('apply-repair').click();
  await page
    .getByTestId('repair-applied-remaining')
    .filter({ hasNotText: 'Checking the repaired mesh' })
    .waitFor({ timeout: LONG });
}

async function exportAs(page, target, directory) {
  await page.getByTestId('workflow-convert').click();
  await page.getByTestId(`convert-target-${target}`).check();
  if (target === '3mf') await page.getByTestId('convert-unit-millimeter').check();
  const t = Date.now();
  let saved;
  page.once('download', (download) => {
    saved = download;
  });
  await page.getByTestId('convert-export').click();
  // A download, or the product's own size refusal — never an open-ended wait.
  await page
    .locator('[data-testid="convert-saved"], [data-testid="convert-failure"]')
    .first()
    .waitFor({ timeout: LONG });
  const ms = Date.now() - t;
  let result;
  if (saved === undefined) {
    result = { refused: await text(page, 'convert-failure'), ms };
  } else {
    const path = join(directory, `repaired.${target}`);
    await saved.saveAs(path);
    result = { path, ms };
  }
  await page.getByTestId('workflow-repair').click();
  return result;
}

/** Every input facet's 36 coordinate bytes, in order, then only appended facets. */
function compareStl(original, exported) {
  const count = (bytes) => bytes.readUInt32LE(80);
  const n = count(original);
  const m = count(exported);
  let moved = 0;
  for (let face = 0; face < n; face += 1) {
    const a = 84 + face * 50 + 12;
    if (original.compare(exported, a, a + 36, a, a + 36) !== 0) moved += 1;
  }
  return { original: n, exported: m, appended: m - n, originalFacetsChanged: moved };
}

/* ------------------------------------------------------------ session 1 -- */

async function workflow(directory) {
  const { browser, page, pid, console } = await open();
  try {
    const env = await page.evaluate(() => {
      const gl = globalThis.document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        userAgent: globalThis.navigator.userAgent,
        renderer:
          info === undefined || info === null
            ? 'n/a'
            : gl.getParameter(info.UNMASKED_RENDERER_WEBGL),
        viewport: `${String(globalThis.innerWidth)}x${String(globalThis.innerHeight)} @${String(globalThis.devicePixelRatio)}x`,
      };
    });
    log(`browser ${env.userAgent}`);
    log(`webgl ${env.renderer}; viewport ${env.viewport}`);
    log(
      `memory free level at start: ${execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']).toString().trim()}%`,
    );
    const baseline = footprint(pid);
    log(`baseline renderer ${mib(baseline.current)}`);

    let t = Date.now();
    await importFile(page, MODEL);
    await page.getByTestId('issue-list').waitFor({ timeout: LONG });
    log(`import+analysis ${String(Date.now() - t)} ms; triangles ${await triangles(page)}`);
    const before = await issueCounts(page);
    log(`issues before: ${JSON.stringify(before)}`);

    await resetGap(page);
    t = Date.now();
    const fillStatus = await settledPlan(page);
    const planMem = footprint(pid);
    log(
      `plan settled ${String(Date.now() - t)} ms after analysis; gap ${String(await readGap(page))} ms; renderer peak ${mib(planMem.peak)}`,
    );
    log(`  fill option: "${fillStatus}"`);
    log(`  open boundaries: "${await text(page, 'issue-status-open-boundaries')}"`);
    log(`  scope: "${await text(page, 'repair-scope')}"`);
    log(`  Repair model enabled: ${String(await page.getByTestId('preview-repair').isEnabled())}`);
    const scrollTop = await page.evaluate(() => {
      const button = globalThis.document.querySelector('[data-testid="preview-repair"]');
      const rect = button?.getBoundingClientRect();
      return rect === undefined
        ? 'absent'
        : `${String(Math.round(rect.top))}..${String(Math.round(rect.bottom))} of ${String(globalThis.innerHeight)}`;
    });
    log(`  Repair model button in viewport without scrolling: ${scrollTop}`);
    log(
      `  advanced diagnostics expanded: ${String(await page.locator('details[open] [data-testid*="advanced"], [data-testid="advanced-diagnostics"][open]').count())}`,
    );

    await resetGap(page);
    t = Date.now();
    const first = await preview(page);
    const previewMem = footprint(pid);
    log(
      `preview ${String(Date.now() - t)} ms; gap ${String(await readGap(page))} ms; renderer peak ${mib(previewMem.peak)}; filled ${first.filled}; ${first.leftOpen.replace(/\s+/g, ' ')}`,
    );
    log(`  triangles during preview (must be unchanged): ${await triangles(page)}`);

    await resetGap(page);
    t = Date.now();
    await applyRepair(page);
    const applyMem = footprint(pid);
    log(
      `apply ${String(Date.now() - t)} ms; gap ${String(await readGap(page))} ms; renderer peak ${mib(applyMem.peak)}; triangles ${await triangles(page)}`,
    );
    log(`  changes: "${await text(page, 'repair-applied-changes')}"`);
    log(`  remaining: "${(await text(page, 'repair-applied-remaining')).replace(/\s+/g, ' ')}"`);
    await page.waitForTimeout(2_000);
    log(`  issues after apply: ${JSON.stringify(await issueCounts(page))}`);
    log(
      `  next plan: fill "${await settledPlan(page)}"; Repair model enabled ${String(await page.getByTestId('preview-repair').isEnabled())}`,
    );
    const workspace = (await page.getByTestId('repair-workspace').innerText()).toLowerCase();
    log(
      `  banned words present: ${JSON.stringify(['watertight', 'print-ready', 'printable', 'fully repaired', 'all fixed', 'all issues fixed'].filter((word) => workspace.includes(word)))}`,
    );

    await resetGap(page);
    t = Date.now();
    await page.getByTestId('undo-repair').click();
    await page.getByTestId('repair-applied').waitFor({ state: 'detached', timeout: LONG });
    await page
      .getByTestId('issue-count-open-boundaries')
      .filter({ hasText: /^13$/ })
      .waitFor({ timeout: LONG })
      .catch(() => undefined);
    log(
      `undo ${String(Date.now() - t)} ms; gap ${String(await readGap(page))} ms; triangles ${await triangles(page)}`,
    );
    log(`  issues after undo: ${JSON.stringify(await issueCounts(page))}`);
    log(`  plan after undo: fill "${await settledPlan(page)}"`);

    const again = await preview(page);
    log(
      `retry preview: filled ${again.filled}; ${again.leftOpen.replace(/\s+/g, ' ')}; identical to first ${String(again.filled === first.filled && again.leftOpen === first.leftOpen)}`,
    );
    await applyRepair(page);
    log(`retry apply: triangles ${await triangles(page)}`);

    const canvas = await page.locator('canvas').first().boundingBox();
    await resetGap(page);
    if (canvas !== null) {
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
      await page.mouse.down();
      await page.mouse.move(canvas.x + canvas.width / 2 + 120, canvas.y + canvas.height / 2 + 40, {
        steps: 12,
      });
      await page.mouse.up();
    }
    await page.waitForTimeout(1_000);
    log(`viewport orbit gap ${String(await readGap(page))} ms`);
    await page.waitForTimeout(3_000);
    log(
      `steady state renderer ${mib(footprint(pid).current)} (peak so far ${mib(footprint(pid).peak)})`,
    );

    const exports = {};
    for (const target of ['stl', 'obj', '3mf']) {
      exports[target] = await exportAs(page, target, directory);
      log(
        `export ${target} ${String(exports[target].ms)} ms${exports[target].refused === undefined ? '' : `: REFUSED "${exports[target].refused}"`}`,
      );
    }
    const stl = compareStl(readFileSync(MODEL), readFileSync(exports.stl.path));
    log(`STL bytes: ${JSON.stringify(stl)}`);
    for (const target of ['stl', 'obj', '3mf']) {
      if (exports[target].path === undefined) continue;
      t = Date.now();
      await importFile(page, exports[target].path);
      await page
        .getByTestId('status-triangles')
        .filter({ hasNotText: /^$/ })
        .waitFor({ timeout: LONG });
      await page.getByTestId('issue-list').waitFor({ timeout: LONG });
      await page.waitForTimeout(1_500);
      const fill = await settledPlan(page);
      log(
        `re-import ${target} ${String(Date.now() - t)} ms: triangles ${await triangles(page)}; issues ${JSON.stringify(await issueCounts(page))}; fill "${fill}"`,
      );
    }
    log(`renderer peak for the whole session ${mib(footprint(pid).peak)}`);
    const geogram = console.filter((line) => /multiply defined/.test(line));
    log(`console lines mentioning "multiply defined": ${String(geogram.length)}`);
    log(`console errors: ${String(console.filter((line) => line.startsWith('error')).length)}`);
    log(`sessionLost=${String((await page.getByTestId('session-lost').count()) > 0)}`);
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------ session 2 -- */

async function cancellation() {
  const { browser, page } = await open();
  try {
    await importFile(page, MODEL);
    await page.getByTestId('issue-list').waitFor({ timeout: LONG });
    await settledPlan(page);
    const original = await triangles(page);
    await resetGap(page);
    await page.getByTestId('preview-repair').click();
    const phase = page.getByTestId('repair-phase');
    await phase
      .filter({ hasText: /Checking the openings|Revalidating/ })
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    const during = (await phase.textContent().catch(() => '')) ?? '';
    const t = Date.now();
    await page.getByTestId('cancel-repair').click();
    await page.getByTestId('repair-cancelled').waitFor({ timeout: LONG });
    log(
      `cancel during "${during.trim()}": acknowledged ${String(Date.now() - t)} ms; gap ${String(await readGap(page))} ms`,
    );
    log(
      `  triangles ${await triangles(page)} (unchanged ${String((await triangles(page)) === original)}); apply offered ${String((await page.getByTestId('apply-repair').count()) > 0)}`,
    );
    const next = await preview(page);
    log(`  Repair model after cancel: filled ${next.filled}`);
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------ session 3 -- */

async function staleReplacement(directory) {
  const cube = holedCubeStl(gridForTriangles(100_000));
  const replacement = join(directory, 'replacement.stl');
  writeFileSync(replacement, cube.bytes);
  const expected = cube.triangles.toLocaleString('en-US');

  for (const when of ['planning', 'preview']) {
    const { browser, page } = await open();
    try {
      await importFile(page, MODEL);
      await page.getByTestId('issue-list').waitFor({ timeout: LONG });
      if (when === 'preview') {
        await settledPlan(page);
        await page.getByTestId('preview-repair').click();
        await page.waitForTimeout(400);
      }
      await importFile(page, replacement);
      await page
        .getByTestId('status-triangles')
        .filter({ hasText: expected })
        .waitFor({ timeout: LONG });
      await page.getByTestId('issue-list').waitFor({ timeout: LONG });
      const fill = await settledPlan(page);
      const staleApply = await page.locator('[data-testid="apply-repair"]:enabled').count();
      const result = await preview(page);
      log(
        `replace during ${when}: triangles ${await triangles(page)} (replacement ${expected}); fill "${fill}"; stale apply offered ${String(staleApply > 0)}; new preview filled ${result.filled}; ${result.leftOpen.replace(/\s+/g, ' ')}`,
      );
    } finally {
      await browser.close();
    }
  }
}

const directory = mkdtempSync(join(tmpdir(), 'pybrix-rc03-'));
try {
  log(`REPAIR-RC-03 real-model acceptance: ${basename(MODEL)}`);
  await workflow(directory);
  await cancellation();
  await staleReplacement(directory);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
