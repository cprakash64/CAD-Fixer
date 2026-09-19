/**
 * STAGE 6E-A1 — STREAMING 3MF IMPORT, MEASURED IN CHROMIUM.
 *
 * NOT A TEST AND NOT PART OF ANY SUITE. A standalone qualification harness, run
 * by hand, that answers one question with the methodology Stage 6D-B3 and R3
 * established: what does reading a large 3MF model part cost in a real renderer
 * process, whole-buffer versus streamed?
 *
 * WHAT IT DOES NOT DO: touch the application. The worker half
 * (`streaming-import.worker.mjs`) is bundled with Vite into a temporary
 * directory and served, with a one-line page, from a local server this script
 * starts and stops. No route is added to the shipped build, and the fixtures —
 * generated here, in Node — are written to a temporary directory and removed.
 *
 * SIGNALS, as in B3: renderer `phys_footprint_peak` from macOS `footprint(1)`
 * (page + worker + V8 + Blink; the kernel's own high-water mark, so ONE BROWSER
 * PER RUN), worker and page isolate heaps via CDP, and the same after a forced
 * collection and after replacing the model with a small one.
 *
 * Run:
 *   node scripts/streaming-import.qualify.mjs \
 *     [--cases dense:128,dense:300,dense-cjk:250,text:300,objects,placements] \
 *     [--modes whole,stream] [--runs 1] [--slice 65536] [--cancel 0.1,0.5,0.9]
 *
 *   node scripts/streaming-import.qualify.mjs --cases dense:250 --emit /abs/dir
 *     writes the fixtures only, and prints `file:<triangles>:<path>` specs for
 *     `qualify:import-phases`, so today's FULL product path — page, render
 *     upload and automatic analysis included — can be measured on the same bytes.
 */
import { chromium } from 'playwright';
import { build } from 'vite';
import { deflateRawSync } from 'node:zlib';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MIB = 1024 * 1024;
const ROOT = join(import.meta.dirname, '..');

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

/* ---------------------------------------------------------------- zip -- */

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
    const payload = deflateRawSync(entry.content, { level: 6 });
    const crc = crc32(entry.content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, payload);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const size = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const HEAD = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}" xmlns:v="http://example.invalid/vendor">`;

/* ----------------------------------------------------------- fixtures -- */

/** Appends generated text to one buffer in batches; never holds the XML as a string. */
function writer(capacity) {
  const out = Buffer.allocUnsafe(capacity);
  let at = 0;
  return {
    write(text) {
      const bytes = Buffer.byteLength(text, 'utf8');
      // `Buffer.write` silently truncates at capacity; a truncated fixture is
      // malformed XML, which would be measured as a reader result.
      if (at + bytes > out.length) throw new Error('fixture exceeded its buffer');
      at += out.write(text, at, 'utf8');
    },
    get length() {
      return at;
    },
    done() {
      return out.subarray(0, at);
    },
  };
}

const vertex = (x, y, z) => `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="${z.toFixed(4)}"/>`;

/**
 * DENSE: the Stage 6D-B3 / `large-entry.bench-suite.ts` shape — one object of
 * unshared triangles, so a size here is comparable with B3's ~2.1 GiB at 297 MiB.
 *
 * `dense-cjk` is the same bytes but for ONE object name, `模型`. V8 stores a
 * string with any character above U+00FF at two bytes per character, so that
 * one name decides whether the whole-buffer path's decoded model part costs 1×
 * or 2× the entry. The streamed path never holds the part as one string.
 */
function dense(sizeMb, name) {
  const target = Math.floor(sizeMb * MIB);
  const block = (n) => {
    const x = (n % 512) * 0.5;
    const y = Math.floor(n / 512) * 0.5;
    return vertex(x, y, 0) + vertex(x + 0.4, y, 0) + vertex(x, y + 0.4, 0);
  };
  const face = (n) => `<triangle v1="${n * 3}" v2="${n * 3 + 1}" v3="${n * 3 + 2}"/>`;
  // Estimated at the FINAL index, as B3 does: indices grow digits.
  const costAt = (n) => Buffer.byteLength(block(n) + face(n));
  let triangles = Math.floor((target - 400) / costAt(100_000));
  triangles = Math.floor((target - 400) / costAt(triangles));
  const out = writer(Math.ceil(target * 1.1) + 4 * MIB);
  const named = name === undefined ? '' : ` name="${name}"`;
  out.write(`${HEAD}<resources><object id="1" type="model"${named}><mesh><vertices>`);
  for (let n = 0; n < triangles; n += 4096) {
    let text = '';
    for (let k = n; k < Math.min(n + 4096, triangles); k += 1) text += block(k);
    out.write(text);
  }
  out.write('</vertices><triangles>');
  for (let n = 0; n < triangles; n += 4096) {
    let text = '';
    for (let k = n; k < Math.min(n + 4096, triangles); k += 1) text += face(k);
    out.write(text);
  }
  out.write('</triangles></mesh></object></resources><build><item objectid="1"/></build></model>');
  return { xml: out.done(), triangles };
}

/**
 * TEXT-HEAVY: hundreds of MiB of XML that is NOT geometry — comments, metadata
 * text and vendor elements — around one tetrahedron. A parser that retained
 * tokens, attributes or element records would grow with the input here even
 * though the document it produces is tiny.
 */
function textHeavy(sizeMb) {
  const target = Math.floor(sizeMb * MIB);
  const out = writer(target + 4 * MIB);
  out.write(HEAD);
  // Deterministic, non-repeating filler, so the entry stays inside the 200:1
  // ratio ceiling the way real text does instead of compressing to nothing.
  let seed = 0x6e_a1;
  const word = () => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return seed.toString(36);
  };
  const words = (count) => Array.from({ length: count }, word).join(' ');
  let batch = '';
  while (out.length + batch.length < target - 2_000) {
    batch +=
      `<!-- ${words(90)} -->` +
      `<metadata name="Description">Größe 模型 ${words(90)}</metadata>` +
      `<v:note v:colour="red" v:text="${words(90)}" v:n="${word()}"/>`;
    if (batch.length > 1_000_000) {
      out.write(batch);
      batch = '';
    }
  }
  out.write(batch);
  out.write(
    '<resources><object id="1" type="model"><mesh><vertices>' +
      vertex(0, 0, 0) +
      vertex(10, 0, 0) +
      vertex(0, 10, 0) +
      vertex(0, 0, 10) +
      '</vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>' +
      '<triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object>' +
      '</resources><build><item objectid="1"/></build></model>',
  );
  return { xml: out.done(), triangles: 4 };
}

function smallMesh(triangles, offset) {
  let vertices = '';
  let faces = '';
  for (let n = 0; n < triangles; n += 1) {
    vertices +=
      vertex(offset + n * 0.01, 0, 0) +
      vertex(offset + n * 0.01, 1, 0) +
      vertex(offset + n * 0.01, 0, 1);
    faces += `<triangle v1="${n * 3}" v2="${n * 3 + 1}" v3="${n * 3 + 2}"/>`;
  }
  return `<mesh><vertices>${vertices}</vertices><triangles>${faces}</triangles></mesh>`;
}

/** OBJECT-HEAVY: the document part ceiling's worth of distinct objects. */
function objectHeavy() {
  const objects = 4_000;
  const each = 150;
  const out = writer(512 * MIB);
  out.write(`${HEAD}<resources>`);
  for (let id = 1; id <= objects; id += 1) {
    out.write(`<object id="${id}" type="model" name="Part ${id}">${smallMesh(each, id)}</object>`);
  }
  out.write('</resources><build>');
  for (let id = 1; id <= objects; id += 1) out.write(`<item objectid="${id}"/>`);
  out.write('</build></model>');
  return { xml: out.done(), triangles: objects * each };
}

/** PLACEMENT-HEAVY: one mesh, the part ceiling's worth of placements. */
function placementHeavy() {
  const placements = 4_000;
  const out = writer(64 * MIB);
  out.write(
    `${HEAD}<resources><object id="1" type="model">${smallMesh(50_000, 0)}</object></resources><build>`,
  );
  for (let n = 0; n < placements; n += 1) {
    out.write(`<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${n * 3} 0 0"/>`);
  }
  out.write('</build></model>');
  return { xml: out.done(), triangles: placements * 50_000 };
}

function fixture(directory, spec) {
  const [kind, size] = spec.split(':');
  const built =
    kind === 'dense'
      ? dense(Number(size))
      : kind === 'dense-cjk'
        ? dense(Number(size), '模型')
        : kind === 'text'
          ? textHeavy(Number(size))
          : kind === 'objects'
            ? objectHeavy()
            : kind === 'placements'
              ? placementHeavy()
              : undefined;
  if (built === undefined) throw new Error(`unknown case ${spec}`);
  const archive = buildZip([
    { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES) },
    { name: '_rels/.rels', content: Buffer.from(RELS) },
    { name: '3D/3dmodel.model', content: built.xml },
  ]);
  const path = join(directory, `${spec.replace(':', '-')}.3mf`);
  writeFileSync(path, archive);
  return {
    path,
    entryBytes: built.xml.length,
    archiveBytes: archive.length,
    triangles: built.triangles,
  };
}

/* ---------------------------------------------------------- measuring -- */

function scaleOf(unit) {
  const upper = unit.toUpperCase();
  if (upper.startsWith('G')) return 1024 * MIB;
  if (upper.startsWith('M')) return MIB;
  if (upper.startsWith('K')) return 1024;
  return 1;
}

function footprint(pid) {
  const text = execFileSync('/usr/bin/footprint', ['-p', String(pid)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
  const now = /phys_footprint:\s+([\d.]+)\s*(\w+)/.exec(text);
  const peak = /phys_footprint_peak:\s+([\d.]+)\s*(\w+)/.exec(text);
  return {
    now: now === null ? 0 : Number(now[1]) * scaleOf(now[2]),
    peak: peak === null ? 0 : Number(peak[1]) * scaleOf(peak[2]),
  };
}

async function workerSession(browserSession) {
  const { targetInfos } = await browserSession.send('Target.getTargets');
  const worker = targetInfos.find((target) => target.type === 'worker');
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
    pending.get(message.id)?.(message);
    pending.delete(message.id);
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
    });
  await call('Runtime.enable');
  await call('HeapProfiler.enable').catch(() => undefined);
  return {
    gc: () => call('HeapProfiler.collectGarbage').catch(() => undefined),
    heap: async () => {
      const usage = await call('Runtime.getHeapUsage');
      return usage.usedSize + usage.backingStorageSize;
    },
  };
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>6E-A1</title><input type="file" id="f">
<script type="module">
const worker = new Worker('/worker.js', { type: 'module' });
window.__run = (options) => new Promise(async (resolve) => {
  const file = document.getElementById('f').files[0];
  const bytes = await file.arrayBuffer();
  worker.onmessage = (event) => resolve(event.data);
  worker.postMessage({ ...options, bytes }, [bytes]);
});
</script>`;

async function serve(directory) {
  const server = createServer((request, response) => {
    const path = request.url === '/' ? 'index.html' : request.url.slice(1);
    const type = path.endsWith('.js') ? 'text/javascript' : 'text/html';
    try {
      const body = readFileSync(join(directory, path));
      response.writeHead(200, {
        'content-type': type,
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

const mib = (bytes) => `${(bytes / MIB).toFixed(0)}`.padStart(6);

async function measure(url, target, small, options) {
  const browser = await chromium.launch();
  try {
    const browserSession = await browser.newBrowserCDPSession();
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForTimeout(500);
    const pageSession = await page.context().newCDPSession(page);
    const worker = await workerSession(browserSession);
    const renderers = (await browserSession.send('SystemInfo.getProcessInfo')).processInfo.filter(
      (entry) => entry.type === 'renderer',
    );
    const pid = renderers[renderers.length - 1]?.id;
    const baseline = footprint(pid);

    await page.locator('#f').setInputFiles(target.path);
    const result = await page.evaluate((run) => window.__run(run), {
      ...options,
      declaredBytes: target.entryBytes,
    });
    const afterImport = footprint(pid);
    const settle = async () => {
      await pageSession.send('HeapProfiler.enable').catch(() => undefined);
      await pageSession.send('HeapProfiler.collectGarbage').catch(() => undefined);
      await worker?.gc();
      await page.waitForTimeout(1_000);
    };
    await settle();
    const retained = { footprint: footprint(pid).now, worker: (await worker?.heap()) ?? 0 };
    const pageHeap = await pageSession.send('Runtime.getHeapUsage');

    await page.locator('#f').setInputFiles(small.path);
    const replacement = await page.evaluate((run) => window.__run(run), {
      ...options,
      cancelAtFraction: undefined,
      declaredBytes: small.entryBytes,
    });
    await settle();
    const replaced = { footprint: footprint(pid).now, worker: (await worker?.heap()) ?? 0 };
    return { baseline, afterImport, result, retained, pageHeap, replacement, replaced };
  } finally {
    await browser.close();
  }
}

async function main() {
  const cases = argument('cases', 'dense:128,dense:250,dense:300,dense:377').split(',');
  const modes = argument('modes', 'whole,stream').split(',').filter(Boolean);
  // `--modes ''` runs only the cancellation plans. Anything else unknown is an
  // error: the worker treats every mode but `stream` as whole, so a typo would
  // silently measure the wrong path under the wrong label.
  for (const mode of modes) {
    if (mode !== 'whole' && mode !== 'stream') throw new Error(`unknown mode ${mode}`);
  }
  const runs = Number(argument('runs', '1'));
  const sliceBytes = Number(argument('slice', '65536'));
  const cancels = argument('cancel', '').split(',').filter(Boolean).map(Number);
  const emit = argument('emit', undefined);
  if (emit !== undefined) {
    // Write the fixtures and stop, so the SAME bytes can be measured through the
    // real application by `qualify:import-phases -- file:<triangles>:<path>`.
    // The directory must lie outside the repository; nothing here is committed.
    if (!emit.startsWith('/') || emit.startsWith(ROOT)) {
      throw new Error('--emit needs an absolute directory outside the repository');
    }
    for (const spec of cases) {
      const target = fixture(emit, spec);
      process.stdout.write(`file:${target.triangles}:${target.path}\n`);
    }
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'cadfixer-6e-'));
  try {
    // Vite, not esbuild: Vite is a declared devDependency, esbuild only an
    // optional peer of it, so a clean `npm ci` would not provide the latter.
    await build({
      configFile: false,
      logLevel: 'error',
      root: ROOT,
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        target: 'es2022',
        lib: {
          entry: join(ROOT, 'scripts/streaming-import.worker.mjs'),
          formats: ['es'],
          fileName: () => 'worker.js',
        },
      },
    });
    writeFileSync(join(directory, 'index.html'), PAGE);
    const { server, url } = await serve(directory);
    const small = fixture(directory, 'dense:1');
    process.stdout.write(`Stage 6E-A1 streaming qualification — ${url}\n  slice ${sliceBytes} B\n`);
    try {
      for (const spec of cases) {
        const target = fixture(directory, spec);
        process.stdout.write(
          `\n── ${spec}: entry ${(target.entryBytes / MIB).toFixed(1)} MiB, archive ${(target.archiveBytes / MIB).toFixed(1)} MiB, ${target.triangles.toLocaleString('en-US')} triangles\n`,
        );
        const plans = [
          ...modes.map((mode) => ({ mode })),
          ...cancels.map((fraction) => ({ mode: 'stream', cancelAtFraction: fraction })),
        ];
        for (const plan of plans) {
          for (let run = 1; run <= runs; run += 1) {
            let measured;
            try {
              measured = await measure(url, target, small, {
                mode: plan.mode,
                sliceBytes,
                entryLimit: 512 * MIB,
                cancelAtFraction: plan.cancelAtFraction,
              });
            } catch (error) {
              // A renderer that dies under the import is a RESULT, not a harness fault.
              process.stdout.write(
                `  ${plan.mode.padEnd(12)} run ${run}: RENDERER FAILED — ${String(
                  error?.message ?? error,
                )
                  .split('\n')[0]
                  .slice(0, 160)}\n`,
              );
              continue;
            }
            const { result } = measured;
            const label =
              plan.cancelAtFraction === undefined ? plan.mode : `cancel@${plan.cancelAtFraction}`;
            const outcome = result.ok
              ? `ok ${result.triangles.toLocaleString('en-US')} tris, read ${result.readMs.toFixed(0)} ms, total ${result.totalMs.toFixed(0)} ms, geometry ${result.geometryMiB.toFixed(0)} MiB, gate ${result.gate.slice(0, 40)}`
              : `${result.code} (${String(result.message).slice(0, 90)}) after ${result.totalMs.toFixed(0)} ms` +
                (result.cancelTailMs === undefined
                  ? ''
                  : `, cancel tail ${result.cancelTailMs.toFixed(0)} ms at ${(result.cancelledAtBytes / MIB).toFixed(0)} MiB`);
            process.stdout.write(
              `  ${label.padEnd(12)} run ${run}: peak ${mib(measured.afterImport.peak)} MiB (baseline ${mib(measured.baseline.now).trim()})` +
                ` | retained ${mib(measured.retained.footprint)} (worker ${mib(measured.retained.worker).trim()}, page ${mib(measured.pageHeap.usedSize + measured.pageHeap.backingStorageSize).trim()})` +
                ` | after replacement ${mib(measured.replaced.footprint)} (worker ${mib(measured.replaced.worker).trim()}) replacement=${measured.replacement.ok ? 'ok' : measured.replacement.code}` +
                ` | ${outcome}` +
                (plan.mode === 'stream' && result.stats
                  ? ` | maxPiece ${result.stats.maxPieceChars} maxTag ${result.stats.maxTagChars} maxCarry ${result.stats.maxCarryChars} pieces ${result.stats.pieces}`
                  : '') +
                '\n',
            );
          }
        }
        rmSync(target.path, { force: true });
      }
    } finally {
      server.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
