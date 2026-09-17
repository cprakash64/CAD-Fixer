/**
 * STAGE 6D-B3 — CHROMIUM WORKER MEMORY QUALIFICATION.
 *
 * NOT A TEST AND NOT PART OF ANY SUITE. A standalone qualification harness, run
 * by hand, that measures what a real 3MF import costs inside the real product
 * worker in a real Chromium — because Node's `heapUsed + arrayBuffers` is not
 * evidence about a browser, and the 256 MiB -> 384 MiB decision has to be made
 * on the environment the product actually runs in.
 *
 * WHAT IT MEASURES AND WHAT EACH SIGNAL EXCLUDES.
 *
 *   - WORKER ISOLATE, via CDP `Runtime.getHeapUsage` on the geometry worker's
 *     own target: `usedSize` is the V8 heap (where the decoded XML string and
 *     the `number[]` scratch live) and `backingStorageSize` is ArrayBuffer
 *     backing store (where the inflated bytes and the canonical Float32/Uint32
 *     arrays live). Together they are the direct Chromium analogue of the Node
 *     metric B1 and B2 used. EXCLUDES: anything outside the worker isolate.
 *   - PAGE ISOLATE, same call on the page target. This is where render
 *     snapshots land. EXCLUDES: the worker.
 *   - RENDERER PROCESS `phys_footprint`, from macOS `footprint(1)`. A dedicated
 *     worker runs on its own thread INSIDE the renderer process, so this covers
 *     page and worker together, plus V8 overhead, Blink, and the compositor's
 *     share. It is macOS's own non-shared, compression-aware accounting — the
 *     number the OS uses for memory pressure. EXCLUDES: GPU process, browser
 *     process, network service.
 *
 * `performance.measureUserAgentSpecificMemory()` would have been the single
 * best signal — one number covering page and workers, broken down by type — and
 * it is NOT AVAILABLE in this Chromium even with cross-origin isolation and
 * with `--enable-experimental-web-platform-features`. That is recorded rather
 * than worked around, and it is why this harness carries three signals instead
 * of one.
 *
 * FIXTURES ARE GENERATED IN NODE, WRITTEN TO A TEMPORARY DIRECTORY, AND HANDED
 * TO THE BROWSER THROUGH THE REAL FILE CHOOSER. Generating a hundreds-of-
 * megabytes archive inside the renderer would put the generator's own peak into
 * the measurement, which is the one thing this must not do. Nothing is
 * committed; the directory is removed on exit.
 *
 * Run: node scripts/chromium-memory.qualify.mjs [--sizes 128,250,300,377]
 */

import { chromium } from 'playwright';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.env.CADFIXER_QUALIFY_URL ?? 'http://localhost:4173/';
const MIB = 1024 * 1024;

function parseSizes() {
  const at = process.argv.indexOf('--sizes');
  const raw = at === -1 ? '128,250,300,377' : (process.argv[at + 1] ?? '');
  return raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

/* ------------------------------------------------------------ fixtures -- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.content, { level: 6 });
    const crc = crc32(entry.content);
    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.content.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.content.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.byteLength + compressed.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  '</Types>';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rel0" Target="/3D/3dmodel.model" ' +
  'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
  '</Relationships>';
const HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
  '<resources><object id="1" type="model" name="Qualify"><mesh><vertices>';
const MID = '</vertices><triangles>';
const TAIL = '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>';

/** The same generator shape `large-entry.bench-suite.ts` uses, so sizes compare. */
function buildModelXml(targetBytes) {
  const vertexBlock = (index) => {
    const x = (index % 512) * 0.5;
    const y = Math.floor(index / 512) * 0.5;
    return (
      `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
      `<vertex x="${(x + 0.4).toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
      `<vertex x="${x.toFixed(4)}" y="${(y + 0.4).toFixed(4)}" z="0.0000"/>`
    );
  };
  const faceBlock = (index) => {
    const base = index * 3;
    return `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`;
  };
  const overhead = Buffer.byteLength(HEAD + MID + TAIL, 'utf8');
  const costAt = (index) =>
    Buffer.byteLength(vertexBlock(index), 'utf8') + Buffer.byteLength(faceBlock(index), 'utf8');
  let triangles = Math.max(64, Math.floor((targetBytes - overhead) / costAt(100_000)));
  triangles = Math.max(64, Math.floor((targetBytes - overhead) / costAt(triangles)));

  const out = Buffer.allocUnsafe(targetBytes + 4 * MIB);
  let at = out.write(HEAD, 0, 'utf8');
  const BATCH = 4096;
  for (let index = 0; index < triangles; index += BATCH) {
    const upto = Math.min(index + BATCH, triangles);
    let block = '';
    for (let n = index; n < upto; n += 1) block += vertexBlock(n);
    at += out.write(block, at, 'utf8');
  }
  at += out.write(MID, at, 'utf8');
  for (let index = 0; index < triangles; index += BATCH) {
    const upto = Math.min(index + BATCH, triangles);
    let block = '';
    for (let n = index; n < upto; n += 1) block += faceBlock(n);
    at += out.write(block, at, 'utf8');
  }
  at += out.write(TAIL, at, 'utf8');
  return { buffer: out.subarray(0, at), triangles };
}

function writeFixture(directory, sizeMb) {
  const built = buildModelXml(Math.floor(sizeMb * MIB));
  const archive = buildZip([
    { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', content: Buffer.from(RELS, 'utf8') },
    { name: '3D/3dmodel.model', content: built.buffer },
  ]);
  const path = join(directory, `qualify-${String(sizeMb)}.3mf`);
  writeFileSync(path, archive);
  return {
    path,
    entryBytes: built.buffer.byteLength,
    archiveBytes: archive.byteLength,
    triangles: built.triangles,
  };
}

/* ------------------------------------------------------------ measuring -- */

function mib(bytes) {
  return `${(bytes / MIB).toFixed(1)}`.padStart(8);
}

/** CDP against the geometry worker's own target, through the browser session. */
async function workerProbe(browserSession) {
  const { targetInfos } = await browserSession.send('Target.getTargets');
  const worker = targetInfos.find(
    (target) => target.type === 'worker' && target.url.includes('geometry.worker'),
  );
  if (worker === undefined) return undefined;
  const { sessionId } = await browserSession.send('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: false,
  });

  let nextId = 1;
  const pending = new Map();
  browserSession.on('Target.receivedMessageFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const settle = pending.get(message.id);
    if (settle !== undefined) {
      pending.delete(message.id);
      settle(message);
    }
  });

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, (message) =>
        message.error ? reject(new Error(message.error.message)) : resolve(message.result),
      );
      browserSession
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(reject);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`worker CDP timeout on ${method}`));
      }, 20_000);
    });

  await call('Runtime.enable');
  await call('HeapProfiler.enable').catch(() => undefined);
  return {
    async collectGarbage() {
      await call('HeapProfiler.collectGarbage').catch(() => undefined);
    },
    async heap() {
      const usage = await call('Runtime.getHeapUsage');
      return {
        heapUsed: usage.usedSize,
        backingStorage: usage.backingStorageSize,
        held: usage.usedSize + usage.backingStorageSize,
      };
    },
  };
}

function scaleOf(unit) {
  const upper = unit.toUpperCase();
  if (upper.startsWith('G')) return 1024 * MIB;
  if (upper.startsWith('M')) return MIB;
  if (upper.startsWith('K')) return 1024;
  return 1;
}

/**
 * macOS `phys_footprint` and `phys_footprint_peak` for one process.
 *
 * `phys_footprint_peak` IS THE POINT. It is the kernel's own high-water mark
 * for the process, so the true peak does not have to be caught by a sampler —
 * and a sampler cannot catch it: the interesting moments are inside the
 * worker's synchronous spans, and every sample costs a subprocess spawn that
 * perturbs the very machine being measured. Sampling gives the SHAPE; this
 * gives the MAXIMUM.
 */
function rendererFootprint(pid) {
  try {
    const text = execFileSync('/usr/bin/footprint', ['-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const now = /phys_footprint:\s+([\d.]+)\s*(\w+)/.exec(text);
    const peak = /phys_footprint_peak:\s+([\d.]+)\s*(\w+)/.exec(text);
    return {
      now: now === null ? 0 : Number(now[1]) * scaleOf(now[2]),
      peak: peak === null ? 0 : Number(peak[1]) * scaleOf(peak[2]),
    };
  } catch {
    return { now: 0, peak: 0 };
  }
}

/* --------------------------------------------------------------- driver -- */

const SETTLE_MS = 1_500;

/**
 * Forces a collection in BOTH isolates, then waits.
 *
 * WITHOUT THIS THE RETENTION FIGURE IS FICTION. `Runtime.getHeapUsage` reports
 * `usedSize`, which includes everything the collector has not got round to —
 * and V8 does not collect a worker heap that is under no pressure. A reading
 * taken straight after an import therefore shows the decoded XML string and the
 * `number[]` scratch as though they were still live, which says nothing about
 * whether the import LEAKED. Peak occupancy is measured without this; retention
 * is measured with it.
 */
async function settle(page, pageSession, worker) {
  await pageSession.send('HeapProfiler.enable').catch(() => undefined);
  await pageSession.send('HeapProfiler.collectGarbage').catch(() => undefined);
  await worker?.collectGarbage();
  await page.waitForTimeout(SETTLE_MS);
  await pageSession.send('HeapProfiler.collectGarbage').catch(() => undefined);
  await worker?.collectGarbage();
  await page.waitForTimeout(500);
}

async function sample(label, pageSession, worker, rendererPid, withFootprint = true) {
  const pageHeap = await pageSession.send('Runtime.getHeapUsage');
  const workerHeap = worker === undefined ? undefined : await worker.heap();
  // The footprint read spawns a subprocess, so the hot sampler skips it.
  const footprint = withFootprint ? rendererFootprint(rendererPid) : { now: 0, peak: 0 };
  return {
    label,
    pageHeld: pageHeap.usedSize + pageHeap.backingStorageSize,
    workerHeld: workerHeap?.held ?? 0,
    workerHeap: workerHeap?.heapUsed ?? 0,
    workerBacking: workerHeap?.backingStorage ?? 0,
    footprintNow: footprint.now,
    footprintPeak: footprint.peak,
  };
}

function line(sample) {
  return (
    `   ${sample.label.padEnd(30)} worker ${mib(sample.workerHeld)} ` +
    `(heap ${mib(sample.workerHeap)} + ab ${mib(sample.workerBacking)})  ` +
    `page ${mib(sample.pageHeld)}  footprint ${mib(sample.footprintNow)}`
  );
}

async function openFixture(page, path) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles(path);
}

/** Arms the B2 phase watcher: clicks Cancel the first time `data-phase` matches. */
async function armCancelAtPhase(page, phase) {
  await page.evaluate((target) => {
    const phaseNow = () =>
      document.querySelector('[data-testid="import-progress"]')?.getAttribute('data-phase') ?? '';
    const state = { phaseAtCancel: '', cancelledAtMs: 0, settledAtMs: 0, phasesSeen: [] };
    const observer = new MutationObserver(() => {
      if (state.cancelledAtMs !== 0) {
        if (document.querySelector('[data-testid="import-progress"]') === null) {
          state.settledAtMs = performance.now();
          observer.disconnect();
        }
        return;
      }
      const current = phaseNow();
      if (current !== '' && state.phasesSeen[state.phasesSeen.length - 1] !== current) {
        state.phasesSeen.push(current);
      }
      if (current !== target) return;
      const button = document.querySelector('[data-testid="cancel-import"]');
      if (button === null) return;
      state.phaseAtCancel = current;
      state.cancelledAtMs = performance.now();
      button.click();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-phase'],
    });
    Object.assign(globalThis, { __lateCancel: () => ({ ...state }) });
  }, phase);
}

async function run() {
  const sizes = parseSizes();
  const runs = Number(process.env.CADFIXER_QUALIFY_RUNS ?? '1');
  const directory = mkdtempSync(join(tmpdir(), 'cadfixer-qualify-'));
  const mode = process.env.CADFIXER_QUALIFY_MODE ?? 'import';
  process.stdout.write(
    `\nStage 6D-B3 Chromium memory qualification\n` +
      `  url ${BASE_URL}\n  fixtures ${directory}\n` +
      `  sizes ${sizes.join(', ')} MiB, ${String(runs)} run(s) each, mode=${mode}\n`,
  );

  try {
    for (const sizeMb of sizes) {
      const fixture = writeFixture(directory, sizeMb);
      const small = writeFixture(directory, 1);
      process.stdout.write(
        `\n\u2500\u2500 entry ${(fixture.entryBytes / MIB).toFixed(1)} MiB, ` +
          `archive ${(fixture.archiveBytes / MIB).toFixed(1)} MiB, ` +
          `${fixture.triangles.toLocaleString('en-US')} triangles \u2500\u2500\n`,
      );

      for (let attempt = 1; attempt <= runs; attempt += 1) {
        /*
         * ONE BROWSER PER RUN. `phys_footprint_peak` is a high-water mark for
         * the life of the PROCESS, so reusing a renderer would carry the
         * previous run's peak into this one and every reading after the first
         * would be the maximum of everything so far.
         */
        const browser = await chromium.launch();
        const browserSession = await browser.newBrowserCDPSession();
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(BASE_URL);
        await page.waitForTimeout(1_000);

        const pageSession = await context.newCDPSession(page);
        await pageSession.send('Runtime.enable');
        const worker = await workerProbe(browserSession);
        const renderers = (
          await browserSession.send('SystemInfo.getProcessInfo')
        ).processInfo.filter((entry) => entry.type === 'renderer');
        const rendererPid = renderers[renderers.length - 1]?.id;

        const baseline = await sample('baseline', pageSession, worker, rendererPid);

        let peak = baseline;
        const ticker = setInterval(() => {
          void sample('peak (isolates)', pageSession, worker, rendererPid, false)
            .then((reading) => {
              if (reading.workerHeld + reading.pageHeld > peak.workerHeld + peak.pageHeld) {
                peak = reading;
              }
            })
            .catch(() => undefined);
        }, 100);

        if (mode === 'cancel') await armCancelAtPhase(page, 'parsing model');

        const started = Date.now();
        await openFixture(page, fixture.path);

        let outcome;
        let triangles = '';
        let cancelReport = '';
        if (mode === 'cancel') {
          await page
            .getByTestId('import-progress')
            .waitFor({ state: 'detached', timeout: 300_000 })
            .catch(() => undefined);
          const observed = await page.evaluate(() => globalThis.__lateCancel());
          const committed = (await page.getByTestId('fact-triangles').count()) > 0;
          cancelReport =
            ` phases=${observed.phasesSeen.join('|')}` +
            ` phaseAtCancel="${observed.phaseAtCancel}"` +
            ` tailMs=${(observed.settledAtMs - observed.cancelledAtMs).toFixed(0)}` +
            ` committed=${String(committed)}`;
          outcome = committed ? 'COMMITTED DESPITE CANCEL' : 'cancelled';
        } else {
          try {
            await page
              .getByTestId('fact-triangles')
              .waitFor({ state: 'visible', timeout: 300_000 });
            triangles = (await page.getByTestId('fact-triangles').textContent()) ?? '';
            outcome = 'imported';
          } catch {
            const status = (await page.getByTestId('status-list').textContent()) ?? '';
            outcome = `refused/failed: ${status.slice(0, 160)}`;
          }
        }
        const elapsed = Date.now() - started;
        clearInterval(ticker);

        const afterImport = await sample('after import', pageSession, worker, rendererPid);
        await settle(page, pageSession, worker);
        const settledAfter = await sample('after settle (gc)', pageSession, worker, rendererPid);

        /*
         * REPLACEMENT. In `import` and `cancel` modes this is a small model,
         * proving the session stays usable and memory comes back.
         *
         * `sequence` MODE MAKES IT THE SAME SIZE, which is Stage 6D-R1's browser
         * proxy for multi-part loading: during the second import the FIRST
         * document is still resident — the store holds it until the new one
         * commits — so the renderer is carrying retained canonical geometry plus
         * a full second transient, which is exactly the shape A2 produces. It is
         * a conservative proxy, because the product also still holds the first
         * RENDER snapshot and A2 would not.
         */
        const replacement = mode === 'sequence' ? fixture.path : small.path;
        await openFixture(page, replacement);
        const replaced = await page
          .getByTestId('fact-triangles')
          .waitFor({ state: 'visible', timeout: 300_000 })
          .then(() => true)
          .catch(() => false);
        await settle(page, pageSession, worker);
        const afterReplacement = await sample(
          'after replacement (gc)',
          pageSession,
          worker,
          rendererPid,
        );
        const sessionLost = (await page.getByTestId('session-lost').count()) > 0;

        process.stdout.write(
          `  run ${String(attempt)}: ${outcome}` +
            (triangles === '' ? '' : ` (${triangles} triangles)`) +
            `${cancelReport} in ${String(elapsed)} ms,` +
            ` replacementLanded=${String(replaced)} sessionLost=${String(sessionLost)}\n` +
            `${line(baseline)}\n${line(peak)}\n${line(afterImport)}\n` +
            `${line(settledAfter)}\n${line(afterReplacement)}\n` +
            `   isolate peak over baseline: ` +
            `${((peak.workerHeld + peak.pageHeld - (baseline.workerHeld + baseline.pageHeld)) / MIB).toFixed(1)} MiB\n` +
            `   RENDERER phys_footprint_peak: ` +
            `${(afterReplacement.footprintPeak / MIB).toFixed(1)} MiB ` +
            `(baseline now ${(baseline.footprintNow / MIB).toFixed(1)} MiB, ` +
            `end now ${(afterReplacement.footprintNow / MIB).toFixed(1)} MiB)\n`,
        );

        await browser.close();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    process.stdout.write(`\nfixtures removed: ${directory}\n`);
  }
}

await run();
