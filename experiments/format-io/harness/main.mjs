/**
 * Stage 4A-1 harness surface. RESEARCH ONLY.
 *
 * Answers the questions that only a real browser can: what DOMParser actually
 * does with a DTD and an external entity, and whether parsing a hostile document
 * can be made to reach the network.
 */
import { parseObj } from '../obj.mjs';
import { read3mf } from '../threemf.mjs';
import { write3mf } from '../threemf-write.mjs';
import { IDENTITY_TRANSFORM } from '../document.mjs';
import { readDirectory, readEntry } from '../zip.mjs';
import { buildZip, valid3mf, compressionBomb } from '../zip-fixtures.mjs';

/**
 * The XML policy under test.
 *
 * DOMParser does not resolve external entities, but "does not" is a property of
 * today's engines rather than a contract we control. So the policy is defence in
 * depth: the document is REFUSED if it declares a DTD at all, before it is
 * parsed for meaning. A file that never reaches entity expansion cannot depend
 * on whether entity expansion is safe.
 */
function describeUnsafeXml(text) {
  if (/<!DOCTYPE/i.test(text)) return 'DOCTYPE/DTD declaration';
  if (/<!ENTITY/i.test(text)) return 'entity declaration';
  if (/SYSTEM\s+["']/i.test(text) || /PUBLIC\s+["']/i.test(text)) return 'external identifier';
  return undefined;
}

window.fmt = {
  env: () => ({
    crossOriginIsolated: globalThis.crossOriginIsolated,
    decompressionStream: typeof DecompressionStream,
    domParser: typeof DOMParser,
  }),

  /** What does DOMParser do with a DTD + external entity, unguarded? */
  probeXxe(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const parseError = doc.getElementsByTagName('parsererror').length > 0;
    return {
      parseError,
      // If an external entity were resolved, its content would appear here.
      text: doc.documentElement?.textContent ?? '',
      root: doc.documentElement?.nodeName ?? '',
    };
  },

  /** The guarded path: refuse before parsing. */
  guardedXml(xml) {
    const unsafe = describeUnsafeXml(xml);
    if (unsafe !== undefined) return { refused: true, reason: unsafe };
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return {
      refused: false,
      parseError: doc.getElementsByTagName('parsererror').length > 0,
      root: doc.documentElement?.nodeName ?? '',
    };
  },

  async zipCase(kind) {
    const bytes =
      kind === 'valid'
        ? await valid3mf()
        : kind === 'bomb'
          ? await compressionBomb()
          : await buildZip([{ name: '../../escape', content: 'x' }]);
    try {
      const { entries } = readDirectory(bytes);
      const out = [];
      for (const e of entries)
        out.push({ name: e.name, bytes: (await readEntry(bytes, e)).length });
      return { accepted: true, entries: out };
    } catch (error) {
      return { accepted: false, refusal: error.refusal ?? String(error.message) };
    }
  },

  parseObjText: (text) => {
    const r = parseObj(text);
    return { vertexCount: r.vertexCount, faceCount: r.faceCount, refusals: r.refusals.length };
  },

  /** Round-trips a 3MF entirely in the browser: same code, same expectations. */
  async threeMfRoundTrip(faces) {
    const positions = new Float32Array(faces * 9);
    const indices = new Uint32Array(faces * 3);
    for (let f = 0; f < faces; f += 1) {
      const base = f * 9;
      positions[base] = f % 512;
      positions[base + 1] = Math.floor(f / 512);
      positions[base + 3] = (f % 512) + 1;
      positions[base + 4] = Math.floor(f / 512);
      positions[base + 6] = f % 512;
      positions[base + 7] = Math.floor(f / 512) + 1;
      indices[f * 3] = f * 3;
      indices[f * 3 + 1] = f * 3 + 1;
      indices[f * 3 + 2] = f * 3 + 2;
    }
    const parts = [
      {
        id: 'p',
        name: 'browser part',
        mesh: { positions, indices },
        transform: IDENTITY_TRANSFORM,
      },
    ];

    const exportStart = performance.now();
    const bytes = await write3mf(parts, 'millimeter');
    const exportMs = performance.now() - exportStart;

    const importStart = performance.now();
    const back = await read3mf(bytes);
    const importMs = performance.now() - importStart;

    let exact = true;
    for (let i = 0; i < positions.length; i += 1) {
      if (!Object.is(back.parts[0].mesh.positions[i], positions[i])) {
        exact = false;
        break;
      }
    }
    return {
      zipBytes: bytes.length,
      partCount: back.parts.length,
      unit: back.unit,
      name: back.parts[0].name,
      faceCount: back.parts[0].mesh.indices.length / 3,
      coordinatesExact: exact,
      exportMs,
      importMs,
    };
  },

  /** Proves a hostile archive is still refused in the browser. */
  async threeMfHostile() {
    const { compressionBomb } = await import('../zip-fixtures.mjs');
    try {
      await read3mf(await compressionBomb());
      return { refused: false };
    } catch (error) {
      return { refused: true, refusal: error.refusal ?? error.name };
    }
  },

  /** Generates a large OBJ and parses it, timing the parse. */
  objBenchmark(faces) {
    const lines = [];
    for (let i = 0; i < faces; i += 1) {
      const x = i % 512;
      const y = Math.floor(i / 512);
      lines.push(`v ${x} ${y} 0`, `v ${x + 1} ${y} 0`, `v ${x} ${y + 1} 0`);
    }
    for (let i = 0; i < faces; i += 1) {
      const b = i * 3;
      lines.push(`f ${b + 1} ${b + 2} ${b + 3}`);
    }
    const text = lines.join('\n');
    const started = performance.now();
    const r = parseObj(text);
    return { bytes: text.length, faceCount: r.faceCount, parseMs: performance.now() - started };
  },
};

document.getElementById('state').textContent = 'ready';
