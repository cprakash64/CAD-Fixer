/**
 * STAGE 6D-R3 — PHASE-ATTRIBUTED IMPORT FOOTPRINT QUALIFICATION.
 *
 * NOT A TEST AND NOT PART OF ANY SUITE. A standalone harness, run by hand
 * against a production build served by `npm run preview`, that opens a fixture
 * through the real file chooser and reports the renderer process's macOS
 * `phys_footprint_peak` AT PHASE BOUNDARIES rather than once at the end.
 *
 * WHY IT SUPERSEDES `stl-footprint.qualify.mjs`. Stage 6D-R2 measured the whole
 * session as one number and could not say whether the ~5 GiB a 300 MiB binary
 * STL reaches belongs to the import, to the render upload, or to the automatic
 * topology analysis that starts afterwards. R3 cannot choose between tightening
 * the import gate and size-gating the analysis without that attribution.
 *
 * HOW THE PHASES ARE SEPARATED. `phys_footprint_peak` is MONOTONIC over a
 * process's life, so reading it at successive checkpoints and differencing
 * gives each phase's incremental high-water mark directly — no sampling, no
 * interpolation. The checkpoints are DOM transitions the application already
 * exposes:
 *
 *   baseline  page loaded, worker constructed, nothing imported
 *   import    `import-progress` detached: parse, document gate, render snapshot
 *             built and transferred, commit done
 *   analysis  the automatic topology analysis has settled — a report, a typed
 *             refusal, or a failure
 *   settled   a fixed dwell afterwards, with the render uploaded and drawn
 *
 * WHAT THE PEAK DELTA IS AND IS NOT. A delta of zero does NOT mean a phase
 * allocated nothing; it means the phase never exceeded the high-water mark an
 * earlier phase had already set. That is the honest reading and it is the one
 * that matters for a gate, because the gate has to bound the MAXIMUM, not the
 * sum. `phys_footprint` (current, not peak) is reported beside it so retention
 * can be read separately from transience.
 *
 * CANCELLING THE ANALYSIS. `--cancel-analysis` clicks the panel's own Cancel as
 * soon as it appears. Cancellation is polled every 65,536 corners, so it lands
 * part-way into canonicalisation rather than before it: the resulting number is
 * an UPPER bound on what an import without automatic analysis would reach, not
 * an exact one. The exact statement comes from sizes above the analysis
 * workspace ceiling, where the refusal is preflight and allocates nothing.
 *
 * Run: npm run preview   (in another terminal)
 *      npm run qualify:import-phases -- stl:100,stl:200,stl:300
 *      npm run qualify:import-phases -- file:6920:/path/outside/the/repo/package.3mf
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIB,
  binaryStl,
  objManyObjects,
  objShared,
  objSoup,
  patchedStl,
  stlTrianglesFor,
  weldedStl,
  threeMfDense,
  threeMfManyObjects,
  threeMfPlacements,
  threeMfProductionPackage,
} from './fixtures.qualify.mjs';

const BASE_URL = process.env.CADFIXER_QUALIFY_URL ?? 'http://localhost:4173/';
const SETTLE_MS = Number(process.env.CADFIXER_QUALIFY_SETTLE_MS ?? '4000');

/* ------------------------------------------------------------ fixtures -- */

/**
 * Builds the fixture a case name describes.
 *
 * Names are `kind:argument[:argument]`, chosen so a ladder reads as one line of
 * shell history and so the same string always produces the same bytes.
 */
function buildFixture(spec) {
  const [kind, ...rest] = spec.split(':');
  const n = (index, fallback) => {
    const raw = rest[index];
    return raw === undefined || raw === '' ? fallback : Number(raw);
  };

  switch (kind) {
    case 'stl': {
      const sizeMb = n(0, 100);
      const triangles = stlTrianglesFor(sizeMb);
      return { name: `${spec}.stl`, content: binaryStl(triangles), triangles };
    }
    case 'stl-welded': {
      const sizeMb = n(0, 100);
      const content = weldedStl(stlTrianglesFor(sizeMb));
      return { name: `${spec}.stl`, content, triangles: content.readUInt32LE(80) };
    }
    case 'stl-patches': {
      const components = n(0, 1_000);
      const each = n(1, 1_000);
      const content = patchedStl(components, each);
      return { name: `${spec}.stl`, content, triangles: content.readUInt32LE(80) };
    }
    case 'obj-shared': {
      const triangles = Math.round(n(0, 1) * 1_000_000);
      return { name: `${spec}.obj`, content: objShared(triangles), triangles };
    }
    case 'obj-soup': {
      const triangles = Math.round(n(0, 1) * 1_000_000);
      return { name: `${spec}.obj`, content: objSoup(triangles), triangles };
    }
    case 'obj-objects': {
      const objects = n(0, 100);
      const each = n(1, 1_000);
      return {
        name: `${spec}.obj`,
        content: objManyObjects(objects, each),
        triangles: objects * each,
      };
    }
    case '3mf-dense': {
      const triangles = Math.round(n(0, 1) * 1_000_000);
      return { name: `${spec}.3mf`, content: threeMfDense(triangles), triangles };
    }
    case '3mf-objects': {
      const objects = n(0, 100);
      const each = n(1, 1_000);
      return {
        name: `${spec}.3mf`,
        content: threeMfManyObjects(objects, each),
        triangles: objects * each,
      };
    }
    case '3mf-package': {
      /*
       * A PRODUCTION-EXTENSION PACKAGE: `n(0)` referenced model parts of
       * `n(1)` triangles each. Stage 6D-A2's lifetime claim is that ONE model
       * part is open at a time, which only a package of several large entries
       * can put to the test.
       */
      const parts = n(0, 2);
      const each = n(1, 500_000);
      return {
        name: `${spec}.3mf`,
        content: threeMfProductionPackage(parts, each),
        triangles: parts * each,
      };
    }
    case '3mf-place': {
      const placements = n(0, 1_000);
      const each = n(1, 2_100);
      return {
        name: `${spec}.3mf`,
        content: threeMfPlacements(placements, each),
        triangles: placements * each,
      };
    }
    case 'file': {
      /*
       * A REAL FILE, measured as it is — Stage 6D-A4. `file:<triangles>:<path>`,
       * the path outside the repository (the corpus is never committed) and the
       * triangle count the one the import is expected to report. The bytes are
       * copied into the temporary directory like any generated fixture, so the
       * cleanup below never touches the original.
       */
      const path = rest.slice(1).join(':');
      return {
        name: path.split('/').pop() ?? 'file',
        content: readFileSync(path),
        triangles: n(0, 0),
      };
    }
    default:
      throw new Error(`unknown fixture kind: ${String(kind)}`);
  }
}

function writeFixture(spec, directory) {
  const built = buildFixture(spec);
  const path = join(directory, built.name.replace(/[:]/g, '_'));
  writeFileSync(path, built.content);
  return { path, triangles: built.triangles, bytes: statSync(path).size };
}

/* ------------------------------------------------------------- probing -- */

/** `phys_footprint_peak` and `phys_footprint` in bytes, or undefined. */
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
  if (peak === undefined) return undefined;
  return { peak, current: read('phys_footprint') ?? 0 };
}

const mib = (bytes) => (bytes === undefined ? '  n/a' : `${(bytes / MIB).toFixed(0)}`.padStart(5));

/**
 * Swallows a wait that timed out.
 *
 * A NAMED FUNCTION RATHER THAN `() => {}` so the intent is written down: these
 * waits are for UI states that legitimately never appear — a refused import
 * shows no analysis, a cancelled one shows no progress — and treating their
 * absence as a failure would abandon the measurement the run exists to take.
 */
function ignore() {
  return undefined;
}

/**
 * Every Chromium process's peak footprint, summed.
 *
 * WHY THE RENDERER ALONE IS NOT THE ENVELOPE. The renderer is where CAD Fixer's
 * buffers live, so it is the number a gate has to move; but what an 8 GiB host
 * has to hold is the whole browser — the GPU process, which is where the
 * uploaded vertex buffers end up, plus the browser process and the utilities.
 * Justifying a ceiling against the renderer alone would understate the claim on
 * the machine by however much the GPU process holds.
 *
 * Peaks are summed rather than sampled together, which OVERSTATES the total
 * slightly: two processes need not peak at the same instant. That direction is
 * the safe one for a ceiling.
 */
function browserFootprint(session) {
  return session.send('SystemInfo.getProcessInfo').then((info) => {
    let peak = 0;
    let current = 0;
    const byType = new Map();
    for (const entry of info.processInfo) {
      const reading = footprint(entry.id);
      if (reading === undefined) continue;
      peak += reading.peak;
      current += reading.current;
      byType.set(entry.type, (byType.get(entry.type) ?? 0) + reading.peak);
    }
    return { peak, current, byType };
  });
}

/** macOS memory pressure and swap, for the host-envelope argument. */
function hostPressure() {
  try {
    const swap = execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const level = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return `pressureLevel=${level} ${swap}`;
  } catch (error) {
    return `host pressure unavailable: ${String(error).slice(0, 60)}`;
  }
}

async function textOf(locator) {
  try {
    return (await locator.textContent({ timeout: 2_000 })) ?? '';
  } catch {
    return '';
  }
}

async function openFile(page, path) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles(path);
}

/**
 * Drives one import and returns its phase checkpoints.
 *
 * Waits for the import to SETTLE rather than to succeed: a refusal never
 * produces a triangle count, and waiting for one would make every refused size
 * sit out the whole timeout and report a peak that includes minutes of idling.
 */
async function importOnce(page, pid, path, options) {
  const progress = page.getByTestId('import-progress');
  const started = Date.now();
  await openFile(page, path);
  await progress.waitFor({ state: 'attached', timeout: 120_000 }).catch(ignore);

  // Armed BEFORE the import settles: the automatic analysis is started by an
  // effect on the imported model, so the Cancel control can appear in the same
  // task that detaches the import progress.
  let cancelled = false;
  if (options.cancelAnalysis) {
    void page
      .getByTestId('cancel-analysis')
      .click({ timeout: 120_000 })
      .then(() => {
        cancelled = true;
      }, ignore);
  }

  await progress.waitFor({ state: 'detached', timeout: 600_000 });
  const importMs = Date.now() - started;
  const afterImport = footprint(pid);

  const triangles = await page.getByTestId('fact-triangles').count();
  const outcome =
    triangles > 0
      ? `imported ${(await textOf(page.getByTestId('fact-triangles'))).trim()} triangles`
      : `REFUSED: ${(await textOf(page.getByTestId('status-list'))).replace(/\s+/g, ' ').slice(0, 200)}`;

  // The analysis has settled when its progress block is gone AND the panel is
  // showing one of its three terminal shapes.
  const analysisStarted = Date.now();
  await page
    .getByTestId('analysis-progress')
    .waitFor({ state: 'detached', timeout: 900_000 })
    .catch(ignore);
  const analysisMs = Date.now() - analysisStarted;
  const afterAnalysis = footprint(pid);

  const analysisError = (await textOf(page.getByTestId('analysis-error'))).replace(/\s+/g, ' ');
  const cancelledNote = (await textOf(page.getByTestId('analysis-cancelled'))).replace(/\s+/g, ' ');
  const reported = (await page.getByTestId('health-topology').count()) > 0;
  const analysis =
    analysisError !== ''
      ? `REFUSED/FAILED: ${analysisError.slice(0, 160)}`
      : cancelledNote !== ''
        ? `CANCELLED: ${cancelledNote.slice(0, 80)}`
        : reported
          ? 'report produced'
          : 'no report';

  await page.waitForTimeout(SETTLE_MS);
  const settled = footprint(pid);

  return {
    importMs,
    analysisMs,
    outcome,
    analysis: options.cancelAnalysis
      ? `${analysis} (cancel requested: ${String(cancelled)})`
      : analysis,
    afterImport,
    afterAnalysis,
    settled,
  };
}

async function qualify(directory, spec, options) {
  const primary = writeFixture(spec, directory);
  const secondary = options.then === undefined ? undefined : writeFixture(options.then, directory);

  // ONE BROWSER PER CASE: `phys_footprint_peak` is a process-lifetime maximum,
  // so a peak set by an earlier case would be reported as this one's.
  const browser = await chromium.launch();
  try {
    const session = await browser.newBrowserCDPSession();
    const page = await (await browser.newContext()).newPage();
    await page.goto(BASE_URL);
    await page.getByTestId('browse-button').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1_000);
    const renderers = (await session.send('SystemInfo.getProcessInfo')).processInfo.filter(
      (entry) => entry.type === 'renderer',
    );
    const pid = renderers[renderers.length - 1]?.id;
    if (pid === undefined) throw new Error('no renderer process found');
    const baseline = footprint(pid);

    const first = await importOnce(page, pid, primary.path, options);
    const second =
      secondary === undefined ? undefined : await importOnce(page, pid, secondary.path, options);

    const lost = (await page.getByTestId('session-lost').count()) > 0;
    const crashed = (await page.getByTestId('app-crashed').count()) > 0;
    const whole = await browserFootprint(session);

    const lines = [];
    lines.push(
      `${spec} — ${(primary.bytes / MIB).toFixed(1)} MiB file, ${primary.triangles.toLocaleString('en-US')} triangles declared`,
    );
    const row = (label, phase, previous) =>
      `    ${label.padEnd(10)} peak ${mib(phase?.peak)} MiB  (+${mib(
        phase?.peak === undefined || previous?.peak === undefined
          ? undefined
          : Math.max(0, phase.peak - previous.peak),
      )})  current ${mib(phase?.current)} MiB`;
    lines.push(row('baseline', baseline, undefined));
    lines.push(row('import', first.afterImport, baseline));
    lines.push(row('analysis', first.afterAnalysis, first.afterImport));
    lines.push(row('settled', first.settled, first.afterAnalysis));
    lines.push(
      `    import ${String(first.importMs)} ms, analysis window ${String(first.analysisMs)} ms`,
    );
    lines.push(`    outcome:  ${first.outcome}`);
    lines.push(`    analysis: ${first.analysis}`);
    if (second !== undefined && secondary !== undefined) {
      lines.push(
        `  then ${options.then} — ${(secondary.bytes / MIB).toFixed(1)} MiB, ${secondary.triangles.toLocaleString('en-US')} triangles`,
      );
      lines.push(row('import2', second.afterImport, first.settled));
      lines.push(row('analysis2', second.afterAnalysis, second.afterImport));
      lines.push(row('settled2', second.settled, second.afterAnalysis));
      lines.push(`    outcome:  ${second.outcome}`);
      lines.push(`    analysis: ${second.analysis}`);
    }
    lines.push(
      `    whole browser peak ${mib(whole.peak)} MiB (${[...whole.byType]
        .map(([type, bytes]) => `${type} ${(bytes / MIB).toFixed(0)}`)
        .join(', ')})`,
    );
    lines.push(`    ${hostPressure()}`);
    lines.push(`    sessionLost=${String(lost)} appCrashed=${String(crashed)}`);
    process.stdout.write(`${lines.join('\n')}\n\n`);
  } finally {
    await browser.close();
    rmSync(primary.path, { force: true });
    if (secondary !== undefined) rmSync(secondary.path, { force: true });
  }
}

/* ---------------------------------------------------------------- main -- */

const args = process.argv.slice(2);
const flags = new Set(args.filter((entry) => entry.startsWith('--')));
const positional = args.filter((entry) => !entry.startsWith('--'));
const thenFlag = args.find((entry) => entry.startsWith('--then='));
const specs = (positional[0] ?? 'stl:100')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const options = {
  cancelAnalysis: flags.has('--cancel-analysis'),
  ...(thenFlag === undefined ? {} : { then: thenFlag.slice('--then='.length) }),
};

const directory = mkdtempSync(join(tmpdir(), 'cadfixer-r3-'));
process.stdout.write(
  `Stage 6D-R3 phase qualification against ${BASE_URL}\n` +
    `cases: ${specs.join(', ')}${options.then === undefined ? '' : ` (each followed by ${options.then})`}` +
    `${options.cancelAnalysis ? ', analysis cancelled on sight' : ''}\n` +
    `host: ${process.platform}, settle ${String(SETTLE_MS)} ms\n\n`,
);
try {
  for (const spec of specs) await qualify(directory, spec, options);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
