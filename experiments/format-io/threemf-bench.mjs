/**
 * Stage 4A-1-R1 — 3MF import/export scaling and memory. RESEARCH ONLY.
 *
 * Phases are timed separately because they scale differently and one of them is
 * the reason a bounded scanner was written instead of using DOMParser.
 */
import { readDirectory, readEntry } from './zip.mjs';
import { parseModelXml, materialiseMeshes, expandBuild } from './threemf.mjs';
import { write3mf, writeModelXml } from './threemf-write.mjs';
import { IDENTITY_TRANSFORM } from './document.mjs';

const say = (l = '') => process.stdout.write(`${l}\n`);
const MiB = (b) => (b / (1024 * 1024)).toFixed(1);
const heap = () => process.memoryUsage().heapUsed;

/** A conforming grid as a triangle soup, split across `partCount` parts. */
function gridParts(faces, partCount) {
  const perPart = Math.ceil(faces / partCount);
  const parts = [];
  let made = 0;
  for (let p = 0; p < partCount && made < faces; p += 1) {
    const n = Math.min(perPart, faces - made);
    const positions = new Float32Array(n * 9);
    const indices = new Uint32Array(n * 3);
    for (let f = 0; f < n; f += 1) {
      const x = (made + f) % 512;
      const y = Math.floor((made + f) / 512);
      const base = f * 9;
      positions[base] = x;
      positions[base + 1] = y;
      positions[base + 2] = 0;
      positions[base + 3] = x + 1;
      positions[base + 4] = y;
      positions[base + 5] = 0.5;
      positions[base + 6] = x;
      positions[base + 7] = y + 1;
      positions[base + 8] = 0;
      indices[f * 3] = f * 3;
      indices[f * 3 + 1] = f * 3 + 1;
      indices[f * 3 + 2] = f * 3 + 2;
    }
    parts.push({
      id: `p${String(p)}`,
      name: `part ${String(p)}`,
      mesh: { positions, indices },
      transform: IDENTITY_TRANSFORM,
    });
    made += n;
  }
  return parts;
}

async function measure(label, faces, partCount) {
  const parts = gridParts(faces, partCount);

  /* ---- export ---- */
  const xmlStart = performance.now();
  writeModelXml(parts, 'millimeter');
  const xmlMs = performance.now() - xmlStart;

  const zipStart = performance.now();
  const bytes = await write3mf(parts, 'millimeter');
  const zipMs = performance.now() - zipStart - xmlMs;

  /* ---- import ---- */
  const dirStart = performance.now();
  const { entries } = readDirectory(bytes);
  const dirMs = performance.now() - dirStart;

  const modelEntry = entries.find((e) => e.name === '3D/3dmodel.model');
  const inflateStart = performance.now();
  const inflated = await readEntry(bytes, modelEntry);
  const inflateMs = performance.now() - inflateStart;

  const decodeStart = performance.now();
  const text = new TextDecoder().decode(inflated);
  const decodeMs = performance.now() - decodeStart;

  const heapBefore = heap();
  const parseStart = performance.now();
  const model = parseModelXml(text);
  const parseMs = performance.now() - parseStart;

  const buildStart = performance.now();
  materialiseMeshes(model);
  const built = expandBuild(model);
  const buildMs = performance.now() - buildStart;
  const heapAfter = heap();

  const totalImport = dirMs + inflateMs + decodeMs + parseMs + buildMs;

  say(
    `${label.padEnd(9)} ${String(faces).padStart(8)} ${String(partCount).padStart(6)} ` +
      `${MiB(bytes.length).padStart(8)} ${MiB(inflated.length).padStart(9)} ` +
      `${xmlMs.toFixed(0).padStart(7)} ${zipMs.toFixed(0).padStart(7)} ` +
      `${dirMs.toFixed(0).padStart(5)} ${inflateMs.toFixed(0).padStart(8)} ${decodeMs.toFixed(0).padStart(7)} ` +
      `${parseMs.toFixed(0).padStart(8)} ${buildMs.toFixed(0).padStart(7)} ${totalImport.toFixed(0).padStart(8)} ` +
      `${MiB(heapAfter - heapBefore).padStart(9)}  ${String(built.length)}`,
  );
  return { bytes: bytes.length, inflated: inflated.length, totalImport, parts: built.length };
}

say('=== 3MF import/export scaling (single part) ===');
say(
  `${'target'.padEnd(9)} ${'faces'.padStart(8)} ${'parts'.padStart(6)} ${'zip_MiB'.padStart(8)} ${'xml_MiB'.padStart(9)} ` +
    `${'xml_ms'.padStart(7)} ${'zip_ms'.padStart(7)} ${'dir'.padStart(5)} ${'inflate'.padStart(8)} ${'decode'.padStart(7)} ` +
    `${'parse'.padStart(8)} ${'build'.padStart(7)} ${'import'.padStart(8)} ${'heap_MiB'.padStart(9)}  built`,
);

// Face counts chosen so the INFLATED model XML lands near 1 / 10 / 50 MiB,
// which is the size that actually drives parser cost. Compressed bytes are
// reported too, but a compressed MiB says little about the work required.
for (const [label, faces] of [
  ['~1 MiB', 7_000],
  ['~10 MiB', 70_000],
  ['~50 MiB', 350_000],
]) {
  await measure(label, faces, 1);
}

say('');
say('=== multi-part overhead at a constant triangle count (70,000 faces) ===');
say(
  `${'target'.padEnd(9)} ${'faces'.padStart(8)} ${'parts'.padStart(6)} ${'zip_MiB'.padStart(8)} ${'xml_MiB'.padStart(9)} ` +
    `${'xml_ms'.padStart(7)} ${'zip_ms'.padStart(7)} ${'dir'.padStart(5)} ${'inflate'.padStart(8)} ${'decode'.padStart(7)} ` +
    `${'parse'.padStart(8)} ${'build'.padStart(7)} ${'import'.padStart(8)} ${'heap_MiB'.padStart(9)}  built`,
);
for (const partCount of [1, 10, 100, 1_000]) {
  await measure('parts', 70_000, partCount);
}
