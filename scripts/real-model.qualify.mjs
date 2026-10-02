/**
 * REPAIR-RC-03 — REAL-MODEL ACCEPTANCE IN A HARDWARE-ACCELERATED CHROMIUM.
 *
 * NOT A TEST AND NOT PART OF ANY SUITE, and it ships NO data: point it at a
 * binary STL the user already has.
 *
 *   npm run build && npm run preview            (in another terminal)
 *   CADFIXER_REAL_MODEL=/path/model.stl npm run qualify:real-model
 *   CADFIXER_REAL_MODEL=/path/model.stl npm run qualify:real-model -- --native
 *
 * WHERE A LARGE OBJ IS WRITTEN — TWO MODES, AND THEY DO NOT CLAIM THE SAME THING
 * (WORKSPACE-UX-03). A large OBJ is streamed to a folder the user picks, and
 * the OS folder dialog cannot be driven by a script. This runner used to press
 * Export and wait for a dialog nobody was answering, for twenty minutes.
 *
 *   --controlled  (the default) `showDirectoryPicker` is answered with a
 *                 directory in the browser's private file system. The product's
 *                 own worker, serialiser, validation and writable stream run
 *                 unchanged; only the dialog is replaced. EVERY LINE IT PRINTS
 *                 SAYS SO, and the summary states that this is NOT acceptance
 *                 of the native file system.
 *   --native      the REAL `showDirectoryPicker`. The runner prints what to
 *                 choose and waits a bounded time for a person to choose it.
 *                 `CADFIXER_NATIVE_DIR` names the folder to pick — an existing,
 *                 EMPTY directory — so the file can be read back from disk.
 *                 This is the only mode that is native acceptance.
 *
 * Neither mode waits without saying what it is waiting for, and neither waits
 * for ever: an unanswered picker ends the run with a failure that names it.
 *
 * A HEADED Chromium drawing through the machine's GPU (Metal on macOS):
 * headless Chromium rasterises WebGL on the CPU and its frame gaps measure that
 * rasteriser, not the page (see docs/design/REPAIR_CORE_02.md §9).
 *
 * FOUR SESSIONS, one browser each:
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
 *   4. the size refusal on a short window: at 1440×300 the 3MF this model would
 *      write is refused for size, and the refusal must be usable — its headline
 *      and ⓘ clickable, the whole explanation scrollable, Close reachable, the
 *      disabled action described, the unit and destination controls in reach,
 *      and nothing drawn over anything else. Skipped, and said to be skipped,
 *      for a model whose 3MF is small enough to be written.
 *
 * Memory is the renderer's macOS `phys_footprint_peak` (monotonic, so the value
 * read after a phase is the peak up to then) plus the current footprint.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/** Where a large OBJ goes. Stated on the command line; never inferred. */
const DestinationMode = Object.freeze({ Controlled: 'controlled', Native: 'native' });
const flags = process.argv.slice(2);
const unknownFlags = flags.filter((flag) => flag !== '--native' && flag !== '--controlled');
if (unknownFlags.length > 0 || (flags.includes('--native') && flags.includes('--controlled'))) {
  process.stderr.write(
    `Use --controlled (default) or --native, not both. Not understood: ${unknownFlags.join(' ') || '(both given)'}\n`,
  );
  process.exit(2);
}
const MODE = flags.includes('--native') ? DestinationMode.Native : DestinationMode.Controlled;
const NATIVE_DIR = process.env.CADFIXER_NATIVE_DIR;
/** How long a person is given to answer the OS folder dialog. */
const PICKER_WAIT_MS = Number(process.env.CADFIXER_PICKER_WAIT_MS ?? 10 * 60_000);
/** The private-file-system directory that stands in for the dialog. */
const CONTROLLED_DIRECTORY = 'qualification-output';
const MODE_LABEL =
  MODE === DestinationMode.Native
    ? 'NATIVE destination (real folder picker)'
    : 'CONTROLLED destination — not native file-system acceptance';

if (MODE === DestinationMode.Native) {
  const usable =
    NATIVE_DIR !== undefined &&
    NATIVE_DIR !== '' &&
    existsSync(NATIVE_DIR) &&
    statSync(NATIVE_DIR).isDirectory() &&
    readdirSync(NATIVE_DIR).length === 0;
  if (!usable) {
    process.stderr.write(
      '--native needs CADFIXER_NATIVE_DIR=/path/to/an/existing/EMPTY/folder — the folder a person will pick in the dialog.\n',
    );
    process.exit(2);
  }
}

/** A gate that failed. The run goes on, so one failure does not hide the next. */
let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(
    `  ${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}\n`,
  );
  return ok;
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

async function open(viewport = { width: 1440, height: 900 }) {
  const browser = await chromium.launch(HARDWARE);
  const page = await (await browser.newContext({ viewport })).newPage();
  if (MODE === DestinationMode.Controlled) {
    // ONLY THE DIALOG IS REPLACED. The handle is a real directory handle, so
    // the product's lookup, overwrite check and writable stream run unchanged.
    await page.addInitScript((name) => {
      globalThis.showDirectoryPicker = async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    }, CONTROLLED_DIRECTORY);
  }
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
    .locator('[data-testid="repair-applied"]:not([data-outcome="checking"])')
    .waitFor({ timeout: LONG });
}

/**
 * Chooses the folder a large OBJ is streamed to, in the stated mode.
 *
 * NEVER AN OPEN-ENDED WAIT. In native mode a person has `PICKER_WAIT_MS` to
 * answer the dialog and is told what to choose; an unanswered or wrongly
 * answered dialog throws, naming itself, instead of stalling the run.
 */
async function chooseDestination(page) {
  const folder = page.getByTestId('convert-folder');
  if (((await folder.textContent()) ?? '').includes('Folder:')) return;
  if (MODE === DestinationMode.Native) {
    process.stdout.write(
      `\n>>> ACTION NEEDED within ${String(Math.round(PICKER_WAIT_MS / 60_000))} min: in the Chromium window choose the folder\n>>>   ${NATIVE_DIR}\n>>> and allow Chromium to edit files in it if it asks.\n\n`,
    );
  }
  await folder.click();
  try {
    await folder.filter({ hasText: 'Folder:' }).waitFor({
      timeout: MODE === DestinationMode.Native ? PICKER_WAIT_MS : 30_000,
    });
  } catch {
    throw new Error(
      MODE === DestinationMode.Native
        ? `No folder was chosen in the OS dialog within ${String(PICKER_WAIT_MS)} ms. Re-run and choose ${NATIVE_DIR}, or run with --controlled.`
        : `The controlled destination was not accepted: "${await text(page, 'convert-destination-note')}".`,
    );
  }
  const chosen = ((await folder.textContent()) ?? '').replace('Folder:', '').trim();
  const expected = MODE === DestinationMode.Native ? basename(NATIVE_DIR) : CONTROLLED_DIRECTORY;
  if (chosen !== expected) {
    throw new Error(`The folder chosen was "${chosen}", not "${expected}".`);
  }
}

/** Copies a file out of the controlled destination so it can be re-imported. */
async function readControlledFile(page, name, path) {
  const pending = page.waitForEvent('download', { timeout: LONG });
  await page.evaluate(
    async ([directoryName, fileName]) => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(directoryName);
      const file = await (await directory.getFileHandle(fileName)).getFile();
      const link = globalThis.document.createElement('a');
      const url = URL.createObjectURL(file);
      link.href = url;
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    [CONTROLLED_DIRECTORY, name],
  );
  await (await pending).saveAs(path);
}

async function exportAs(page, target, directory) {
  await page.getByTestId('workflow-convert').click();
  await page.getByTestId(`convert-target-${target}`).check();
  if (target === '3mf') await page.getByTestId('convert-unit-millimeter').check();
  // A large OBJ is streamed to a chosen folder rather than downloaded.
  const streamed = (await page.getByTestId('convert-destination').count()) > 0;
  const name = `repaired.${target}`;
  if (streamed) {
    await chooseDestination(page);
    await page.getByTestId('convert-filename').fill('repaired');
    await page
      .getByTestId('convert-destination-note')
      .filter({ hasText: /New file|Existing file/ })
      .waitFor({ timeout: 30_000 });
  }
  const t = Date.now();
  // Awaited, not sampled: the download event can arrive after the panel says
  // the file was saved. Settles when the page closes if no file ever comes.
  const download = streamed
    ? undefined
    : page.waitForEvent('download', { timeout: LONG }).catch(() => undefined);
  await page.getByTestId('convert-export').click();
  if (streamed) {
    // An earlier run's file in the same folder is replaced, on purpose.
    const replace = page.getByTestId('convert-overwrite-confirm');
    const outcome = page
      .locator('[data-testid="convert-saved"], [data-testid="convert-failure"]')
      .first();
    await Promise.race([
      replace.waitFor({ timeout: LONG }).then(() => replace.click()),
      outcome.waitFor({ timeout: LONG }),
    ]);
  }
  // A saved file, or the product's own refusal — never an open-ended wait.
  await page
    .locator('[data-testid="convert-saved"], [data-testid="convert-failure"]')
    .first()
    .waitFor({ timeout: LONG });
  const ms = Date.now() - t;
  let result;
  if ((await page.getByTestId('convert-failure').count()) > 0) {
    result = { refused: await text(page, 'convert-failure'), ms };
  } else if (streamed) {
    const path = MODE === DestinationMode.Native ? join(NATIVE_DIR, name) : join(directory, name);
    if (MODE === DestinationMode.Controlled) await readControlledFile(page, name, path);
    result = { path, ms, destination: MODE_LABEL };
  } else {
    const saved = await download;
    if (saved === undefined) throw new Error(`The ${target} export reported success with no file.`);
    const path = join(directory, name);
    await saved.saveAs(path);
    result = { path, ms, destination: 'browser download' };
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
        `export ${target} ${String(exports[target].ms)} ms${exports[target].refused === undefined ? ` [${exports[target].destination}]` : `: REFUSED "${exports[target].refused}"`}`,
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

/* ------------------------------------------------------------ session 4 -- */

/** Brings a control into reach and reports what a click at its centre hits. */
async function reach(page, id) {
  const control = page.getByTestId(id).first();
  await control.scrollIntoViewIfNeeded();
  return control.evaluate((element) => {
    const surface =
      element.getBoundingClientRect().width < 4 ? (element.closest('label') ?? element) : element;
    const rect = surface.getBoundingClientRect();
    const target = globalThis.document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    const footer = globalThis.document.querySelector('[data-testid="convert-footer"]');
    const footerTop = footer.getBoundingClientRect().top;
    const room =
      footerTop -
      globalThis.document.querySelector('.tool-panel__body').getBoundingClientRect().top;
    return {
      own: target !== null && (surface === target || surface.contains(target)),
      hit: target?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      // A control that FITS above the action region must be wholly above it; a
      // taller one — a format tile — only has to be clickable at its centre.
      clear: footer.contains(element) || rect.height > room || rect.bottom <= footerTop + 1,
    };
  });
}

async function reachable(page, label, id) {
  const probe = await reach(page, id);
  check(
    `${label}: ${id} is clickable at its centre`,
    probe.own && probe.clear,
    probe.own ? (probe.clear ? '' : 'under the action region') : `lands on ${String(probe.hit)}`,
  );
}

/**
 * THE SIZE REFUSAL ON A SHORT WINDOW. Component tests cover the footer's
 * structure in this state; only a browser shows whether a person can use it.
 */
async function sizeRefusal() {
  const { browser, page } = await open({ width: 1440, height: 300 });
  try {
    let downloads = 0;
    page.on('download', () => {
      downloads += 1;
    });
    await importFile(page, MODEL);
    await page.getByTestId('issue-list').waitFor({ state: 'attached', timeout: LONG });
    const before = await triangles(page);
    await page.getByTestId('workflow-convert').click();
    await page.getByTestId('convert-target-3mf').check({ force: true });
    if ((await page.getByTestId('convert-unit-millimeter').count()) > 0) {
      await page.getByTestId('convert-unit-millimeter').check({ force: true });
    }
    const t = Date.now();
    await page.getByTestId('convert-export').click();
    await page
      .locator('[data-testid="convert-saved"], [data-testid="convert-failure"]')
      .first()
      .waitFor({ timeout: LONG });
    if ((await page.getByTestId('convert-failure').count()) === 0) {
      log('size refusal at 1440x300: SKIPPED — this model is small enough to be written as 3MF');
      return;
    }
    log(
      `size refusal at 1440x300: "${await text(page, 'convert-failure')}" after ${String(Date.now() - t)} ms`,
    );

    const layout = await page.evaluate(() => {
      const box = (selector) => globalThis.document.querySelector(selector).getBoundingClientRect();
      const scroller = globalThis.document.querySelector('.tool-panel__body');
      const footer = box('[data-testid="convert-footer"]');
      return {
        scrollerTop: box('.tool-panel__body').top,
        footerTop: footer.top,
        footerHeight: footer.height,
        footerBottom: footer.bottom,
        activityTop: box('.tool-panel__footer').top,
        cap: Number.parseFloat(
          globalThis.getComputedStyle(scroller).getPropertyValue('--action-footer-max'),
        ),
        overflowX: scroller.scrollWidth > scroller.clientWidth,
      };
    });
    check(
      'action region within its cap',
      layout.footerHeight <= layout.cap,
      `${String(Math.round(layout.footerHeight))} px of ${String(layout.cap)} px`,
    );
    check(
      'scroll area left above the action region',
      layout.footerTop - layout.scrollerTop >= 44,
      `${String(Math.round(layout.footerTop - layout.scrollerTop))} px`,
    );
    check('action region clear of Activity', layout.footerBottom <= layout.activityTop + 1);
    check('no horizontal overflow', !layout.overflowX);

    const failure = page.getByTestId('convert-failure');
    check(
      'headline in view and announced as an alert',
      (await failure.getAttribute('role')) === 'alert' && (await failure.isVisible()),
    );
    const description = await page.getByTestId('convert-export').evaluate((button) => {
      const id = button.getAttribute('aria-describedby');
      return id === null ? '' : (globalThis.document.getElementById(id)?.textContent ?? '');
    });
    check(
      'disabled action says why',
      (await page.getByTestId('convert-export').isDisabled()) && description.trim() !== '',
      description,
    );
    await reachable(page, 'refused', 'convert-refusal-info');
    await reachable(page, 'refused', 'convert-unit-inch');
    await reachable(page, 'refused', 'convert-target-obj');

    // THE WHOLE EXPLANATION SCROLLS: its first line and its Close button can
    // each be brought above the action region and clicked.
    await page.getByTestId('convert-refusal-info').click();
    const details = page.getByTestId('convert-outcome-details');
    await details.waitFor({ timeout: 10_000 });
    const span = await details.evaluate((element) => {
      const scroller = globalThis.document.querySelector('.tool-panel__body');
      const footerTop = globalThis.document
        .querySelector('[data-testid="convert-footer"]')
        .getBoundingClientRect().top;
      const hits = (target, x, y) => {
        const at = globalThis.document.elementFromPoint(x, y);
        return at !== null && (target === at || target.contains(at));
      };
      // Top of the explanation to the top of the scroll area.
      scroller.scrollTop +=
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const top = element.getBoundingClientRect();
      const first = element.querySelector('.info-panel__text');
      const firstRect = first.getBoundingClientRect();
      const firstLine =
        firstRect.top >= scroller.getBoundingClientRect().top - 1 &&
        firstRect.top + 12 <= footerTop &&
        hits(first, firstRect.left + 12, firstRect.top + 8);
      // Then its end: the Close button, wholly above the action region.
      scroller.scrollTop += element.getBoundingClientRect().bottom - footerTop + 4;
      const close = element.querySelector('.info-panel__close');
      const closeRect = close.getBoundingClientRect();
      return {
        height: Math.round(top.height),
        firstLine,
        close:
          closeRect.bottom <= footerTop + 1 &&
          closeRect.top >= scroller.getBoundingClientRect().top - 1 &&
          hits(close, closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2),
      };
    });
    check(
      'first line of the explanation reachable',
      span.firstLine,
      `${String(span.height)} px tall`,
    );
    check('Close reachable', span.close);
    await details.locator('.info-panel__close').click();
    check('Close closes the explanation', !(await details.isVisible()));

    check('nothing was downloaded', downloads === 0);
    check('model still loaded and unchanged', (await triangles(page)) === before);
    check('session intact', (await page.getByTestId('session-lost').count()) === 0);

    // Another format recovers the action, with its destination in reach.
    await page.getByTestId('convert-target-obj').check({ force: true });
    check('OBJ offered after the refusal', await page.getByTestId('convert-export').isEnabled());
    if ((await page.getByTestId('convert-destination').count()) > 0) {
      await reachable(page, 'after switching to OBJ', 'convert-filename');
      await reachable(page, 'after switching to OBJ', 'convert-folder');
    }
    await reachable(page, 'after switching to OBJ', 'convert-export');

    // And the refusal is remembered rather than waited for again.
    await page.getByTestId('convert-target-3mf').check({ force: true });
    check(
      '3MF refusal remembered without a second attempt',
      (await page.getByTestId('convert-export').isDisabled()) &&
        (await page.getByTestId('convert-failure').count()) === 0 &&
        (await page.getByTestId('convert-unavailable').isVisible()),
      await text(page, 'convert-unavailable'),
    );
    await reachable(page, 'remembered', 'convert-refusal-info');
  } finally {
    await browser.close();
  }
}

const directory = mkdtempSync(join(tmpdir(), 'pybrix-rc03-'));
try {
  log(`REPAIR-RC-03 real-model acceptance: ${basename(MODEL)}`);
  log(`large OBJ: ${MODE_LABEL}`);
  await workflow(directory);
  await cancellation();
  await staleReplacement(directory);
  await sizeRefusal();
  log(
    MODE === DestinationMode.Native
      ? `large OBJ was written to ${NATIVE_DIR} through the real folder picker.`
      : 'large OBJ used a CONTROLLED destination: this run is NOT acceptance of the native file system. Re-run with --native for that.',
  );
  if (failures > 0) {
    log(`${String(failures)} gate(s) FAILED`);
    process.exitCode = 1;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
