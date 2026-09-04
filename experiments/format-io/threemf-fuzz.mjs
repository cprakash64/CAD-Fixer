/**
 * Stage 4A-1-R1 — security regression after adding geometry parsing.
 * RESEARCH ONLY.
 *
 * Adding a geometry layer on top of a hardened container is exactly where a
 * bypass appears: the new code reads fields the old code never looked at. This
 * re-runs the qualified hostile archives THROUGH the geometry reader, then
 * mutates well-formed model XML to see whether any mutation escapes the
 * refusals.
 *
 * DETERMINISTIC AND BOUNDED. A seeded generator and a fixed case count, so the
 * run is reproducible and writes nothing to disk.
 */
import { buildZip, compressionBomb } from './zip-fixtures.mjs';
import { read3mf } from './threemf.mjs';
import { ZipError } from './zip.mjs';
import { XmlError } from './xml-scan.mjs';
import { ThreeMfError } from './threemf.mjs';

const say = (l = '') => process.stdout.write(`${l}\n`);

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- 1. the container corpus still refuses, now via the geometry reader ---- */

say('=== container corpus re-run through the 3MF geometry reader ===');
const containerCases = [
  ['compression bomb', await compressionBomb()],
  ['path traversal', await buildZip([{ name: '../../etc/passwd', content: 'x' }])],
  ['absolute path', await buildZip([{ name: '/etc/passwd', content: 'x' }])],
  ['URL-like name', await buildZip([{ name: 'https://evil.test/a.model', content: 'x' }])],
  ['encrypted entry', await buildZip([{ name: '3D/3dmodel.model', content: 'x', flags: 1 }])],
  ['unsupported method', await buildZip([{ name: '3D/3dmodel.model', content: 'x', method: 12 }])],
  [
    'duplicate paths',
    await buildZip([
      { name: '3D/3dmodel.model', content: 'a' },
      { name: '3D/3DMODEL.MODEL', content: 'b' },
    ]),
  ],
];

let containerRefused = 0;
for (const [name, bytes] of containerCases) {
  let refusal = 'ACCEPTED';
  try {
    await read3mf(bytes);
  } catch (error) {
    refusal = error.refusal ?? error.name;
  }
  const ok = refusal !== 'ACCEPTED';
  if (ok) containerRefused += 1;
  say(`  ${name.padEnd(24)} ${ok ? 'refused' : '*** ACCEPTED ***'}  ${refusal}`);
}
say(
  `  ${String(containerRefused)}/${String(containerCases.length)} still refused after geometry parsing was added`,
);

/* ---- 2. DTD/entity refusal survives inside a real archive ---- */

say('');
say('=== XML refusals inside a real 3MF archive ===');
const xmlCases = [
  [
    'DOCTYPE with external entity',
    `<?xml version="1.0"?><!DOCTYPE model [<!ENTITY x SYSTEM "file:///etc/passwd">]><model unit="millimeter"><resources/><build/></model>`,
  ],
  [
    'billion laughs',
    `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aa"><!ENTITY b "&a;&a;&a;">]><model unit="millimeter">&b;</model>`,
  ],
  [
    'external SYSTEM identifier',
    `<?xml version="1.0"?><!DOCTYPE model SYSTEM "http://evil.test/x.dtd"><model unit="millimeter"/>`,
  ],
  ['unterminated tag', `<?xml version="1.0"?><model unit="millimeter"><resources`],
  ['unbalanced close', `<?xml version="1.0"?><model unit="millimeter"></resources></model>`],
];
let xmlRefused = 0;
for (const [name, xml] of xmlCases) {
  const bytes = await buildZip([
    { name: '[Content_Types].xml', method: 8, content: '<Types/>' },
    { name: '3D/3dmodel.model', method: 8, content: xml },
  ]);
  let refusal = 'ACCEPTED';
  try {
    await read3mf(bytes);
  } catch (error) {
    refusal = error.refusal ?? error.name;
  }
  const ok = refusal !== 'ACCEPTED';
  if (ok) xmlRefused += 1;
  say(`  ${name.padEnd(30)} ${ok ? 'refused' : '*** ACCEPTED ***'}  ${refusal}`);
}
say(`  ${String(xmlRefused)}/${String(xmlCases.length)} refused`);

/* ---- 3. deterministic mutation of a valid model ---- */

say('');
say('=== deterministic mutation fuzz of valid model XML ===');

const BASE = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="1" type="model"><mesh>
  <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>
  <triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/></triangles>
 </mesh></object></resources>
 <build><item objectid="1"/></build>
</model>`;

const rand = mulberry32(0xf022);
const CASES = 3_000;
let refused = 0;
let accepted = 0;
let unexpected = 0;
const refusalKinds = new Map();

for (let i = 0; i < CASES; i += 1) {
  let xml = BASE;
  const mutations = 1 + Math.floor(rand() * 3);
  for (let m = 0; m < mutations; m += 1) {
    const at = Math.floor(rand() * xml.length);
    const pick = rand();
    if (pick < 0.3) {
      // delete a span
      const len = 1 + Math.floor(rand() * 12);
      xml = xml.slice(0, at) + xml.slice(at + len);
    } else if (pick < 0.6) {
      // insert hostile-ish text
      const inject = [
        '<',
        '>',
        '"',
        '&',
        '../',
        'NaN',
        'Infinity',
        '999999',
        '-1',
        '<!ENTITY',
        ']]>',
      ][Math.floor(rand() * 11)];
      xml = xml.slice(0, at) + inject + xml.slice(at);
    } else {
      // flip a character
      xml =
        xml.slice(0, at) + String.fromCharCode(33 + Math.floor(rand() * 90)) + xml.slice(at + 1);
    }
  }

  const bytes = await buildZip([
    { name: '[Content_Types].xml', method: 8, content: '<Types/>' },
    { name: '3D/3dmodel.model', method: 8, content: xml },
  ]);

  try {
    const r = await read3mf(bytes);
    accepted += 1;
    // An ACCEPTED mutation must still have produced structurally sound output.
    for (const part of r.parts) {
      const vertexCount = part.mesh.positions.length / 3;
      for (const index of part.mesh.indices) {
        if (index >= vertexCount) {
          unexpected += 1;
          break;
        }
      }
      for (const c of part.mesh.positions) {
        if (!Number.isFinite(c)) {
          unexpected += 1;
          break;
        }
      }
    }
  } catch (error) {
    if (error instanceof ZipError || error instanceof XmlError || error instanceof ThreeMfError) {
      refused += 1;
      const kind = error.refusal ?? error.name;
      refusalKinds.set(kind, (refusalKinds.get(kind) ?? 0) + 1);
    } else {
      // An unexpected exception class is a finding: the reader should refuse
      // deliberately, not fall over.
      unexpected += 1;
      refusalKinds.set(
        `UNTYPED:${error.constructor.name}`,
        (refusalKinds.get(`UNTYPED:${error.constructor.name}`) ?? 0) + 1,
      );
    }
  }
}

say(`  cases:              ${String(CASES)} (seeded, reproducible)`);
say(`  refused (typed):    ${String(refused)}`);
say(`  accepted:           ${String(accepted)}`);
say(`  unsound or untyped: ${String(unexpected)}`);
say('  refusal kinds:');
for (const [kind, count] of [...refusalKinds].sort((a, b) => b[1] - a[1])) {
  say(`    ${kind.padEnd(34)} ${String(count)}`);
}
say('');
say(
  unexpected === 0
    ? '  RESULT: every mutation was either refused with a typed error or produced structurally sound geometry.'
    : `  RESULT: *** ${String(unexpected)} cases were unsound or threw an untyped error ***`,
);
