/**
 * STAGE 6D-R2 — STL RENDERER FOOTPRINT QUALIFICATION.
 *
 * SUPERSEDED BY `import-phases.qualify.mjs`, and kept because it is the exact
 * harness R2's recorded numbers came from. It reports ONE peak for the whole
 * session and cannot say which phase reached it — which is precisely the gap
 * that hid Stage 6D-R3's finding, that most of the footprint belonged to an
 * automatic boundary walk rather than to the import. Use the phase harness for
 * new measurements; use this one only to reproduce R2's table.
 *
 * NOT A TEST AND NOT PART OF ANY SUITE. A standalone harness, run by hand
 * against a production build served by `npm run preview`, that imports binary
 * STL files of chosen sizes through the real file chooser and reports the
 * renderer process's macOS `phys_footprint_peak`.
 *
 * WHY IT EXISTS. Stage 6D-R2 set out to retire `checkImportPeak` and found that
 * the gate, however inaccurate, is what currently stops binary STL above about
 * 317 MiB. Removing it would admit STL up to the 512 MiB input cap, and this
 * harness is the evidence that doing so is unsafe on the 8 GiB minimum host.
 *
 * WHAT THE NUMBER INCLUDES. `phys_footprint_peak` is the kernel's high-water
 * mark for the renderer over the whole run: the import, the automatic topology
 * analysis the application starts after it, the render upload, and a small
 * replacement import. It is the footprint a user's session reaches, NOT the
 * import alone. One browser per size, so a peak never carries across sizes.
 *
 * Run: npm run preview   (in another terminal)
 *      npm run qualify:stl-footprint -- 100,300,511
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.env.CADFIXER_QUALIFY_URL ?? 'http://localhost:4173/';
const MIB = 1024 * 1024;
const BINARY_STL_HEADER = 84;
const BINARY_STL_FACET = 50;

/** A binary STL of `triangles` non-degenerate facets, deterministic. */
function binaryStl(triangles) {
  const buffer = Buffer.alloc(BINARY_STL_HEADER + BINARY_STL_FACET * triangles);
  buffer.writeUInt32LE(triangles, 80);
  for (let facet = 0; facet < triangles; facet += 1) {
    const at = BINARY_STL_HEADER + facet * BINARY_STL_FACET;
    const x = (facet % 512) * 0.5;
    const y = Math.floor(facet / 512) * 0.5;
    buffer.writeFloatLE(0, at);
    buffer.writeFloatLE(0, at + 4);
    buffer.writeFloatLE(1, at + 8);
    buffer.writeFloatLE(x, at + 12);
    buffer.writeFloatLE(y, at + 16);
    buffer.writeFloatLE(0, at + 20);
    buffer.writeFloatLE(x + 0.4, at + 24);
    buffer.writeFloatLE(y, at + 28);
    buffer.writeFloatLE(0, at + 32);
    buffer.writeFloatLE(x, at + 36);
    buffer.writeFloatLE(y + 0.4, at + 40);
    buffer.writeFloatLE(0, at + 44);
  }
  return buffer;
}

/** `phys_footprint_peak` in bytes, or `undefined` when `footprint(1)` cannot read it. */
function footprintPeak(pid) {
  let text;
  try {
    text = execFileSync('/usr/bin/footprint', ['-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch (error) {
    process.stderr.write(`footprint(1) failed for pid ${String(pid)}: ${String(error)}\n`);
    return undefined;
  }
  const match = /phys_footprint_peak:\s+([\d.]+)\s*(\w+)/.exec(text);
  if (match === null) return undefined;
  const unit = match[2].toUpperCase();
  const scale = unit.startsWith('G') ? 1024 * MIB : unit.startsWith('M') ? MIB : 1024;
  return Number(match[1]) * scale;
}

async function openFile(page, path) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles(path);
}

async function statusText(page) {
  try {
    return (await page.getByTestId('status-list').textContent({ timeout: 5_000 })) ?? '';
  } catch (error) {
    return `status unavailable: ${String(error).slice(0, 80)}`;
  }
}

async function qualify(directory, sizeMb) {
  const triangles = Math.floor((sizeMb * MIB - BINARY_STL_HEADER) / BINARY_STL_FACET);
  const path = join(directory, `qualify-${String(sizeMb)}.stl`);
  writeFileSync(path, binaryStl(triangles));
  const small = join(directory, 'small.stl');
  writeFileSync(small, binaryStl(1_000));

  // ONE BROWSER PER SIZE: `phys_footprint_peak` is a process-lifetime maximum.
  const browser = await chromium.launch();
  try {
    const session = await browser.newBrowserCDPSession();
    const page = await (await browser.newContext()).newPage();
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    const renderers = (await session.send('SystemInfo.getProcessInfo')).processInfo.filter(
      (entry) => entry.type === 'renderer',
    );
    const pid = renderers[renderers.length - 1]?.id;

    const started = Date.now();
    await openFile(page, path);
    /*
     * WAIT FOR THE IMPORT TO SETTLE, not for success. Waiting for the triangle
     * count alone makes every REFUSED size sit out the whole timeout, because a
     * refusal never produces one. The progress block appears when the import
     * starts and detaches when it ends either way; this is the first import of
     * a fresh page, so a triangle count present afterwards belongs to it.
     */
    const progress = page.getByTestId('import-progress');
    await progress.waitFor({ state: 'attached', timeout: 60_000 }).catch((error) => {
      process.stderr.write(`import progress never appeared: ${String(error).slice(0, 80)}\n`);
    });
    await progress.waitFor({ state: 'detached', timeout: 300_000 });
    const outcome =
      (await page.getByTestId('fact-triangles').count()) > 0
        ? `imported ${(await page.getByTestId('fact-triangles').textContent()) ?? ''} triangles`
        : `NOT IMPORTED: ${(await statusText(page)).slice(0, 160)}`;
    const elapsed = Date.now() - started;

    await openFile(page, small);
    const replaced = await page
      .getByTestId('fact-triangles')
      .waitFor({ state: 'visible', timeout: 120_000 })
      .then(() => true)
      .catch((error) => {
        process.stderr.write(`replacement did not land: ${String(error).slice(0, 80)}\n`);
        return false;
      });
    const sessionLost = (await page.getByTestId('session-lost').count()) > 0;
    const peak = pid === undefined ? undefined : footprintPeak(pid);

    process.stdout.write(
      `${String(sizeMb).padStart(4)} MiB STL, ${triangles.toLocaleString('en-US')} triangles: ${outcome}\n` +
        `     ${String(elapsed)} ms, replacementLanded=${String(replaced)} sessionLost=${String(sessionLost)}, ` +
        `renderer phys_footprint_peak ${peak === undefined ? 'unavailable' : `${(peak / MIB).toFixed(0)} MiB`}\n`,
    );
  } finally {
    await browser.close();
  }
}

const sizes = (process.argv[2] ?? '100,300,511')
  .split(',')
  .map((entry) => Number(entry.trim()))
  .filter((entry) => Number.isFinite(entry) && entry > 0);
const directory = mkdtempSync(join(tmpdir(), 'cadfixer-stl-qualify-'));
process.stdout.write(
  `STL footprint qualification against ${BASE_URL}, sizes ${sizes.join(', ')} MiB\n`,
);
try {
  for (const sizeMb of sizes) await qualify(directory, sizeMb);
} finally {
  rmSync(directory, { recursive: true, force: true });
  process.stdout.write(`fixtures removed: ${directory}\n`);
}
