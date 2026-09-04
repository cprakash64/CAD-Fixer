/**
 * Stage 4A-1-R1 — numeric fidelity through the REAL 3MF pipeline. RESEARCH ONLY.
 *
 * Stage 4A-1 proved nine significant digits round-trip a Float32 through
 * `Number.parseFloat`. That is not the same claim as "the 3MF writer and reader
 * preserve it": the value passes through XML attribute escaping, a scanner, and
 * `Number(...)` rather than `parseFloat`. This measures the actual path.
 */
import { writeFloat32, writeFloat64 } from './threemf-write.mjs';
import { readAttrs, scanXml, escapeXml } from './xml-scan.mjs';

const say = (l = '') => process.stdout.write(`${l}\n`);
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The full path a coordinate travels: write -> XML -> scan -> Number -> Float32. */
function throughXml(value) {
  const xml = `<vertex x="${writeFloat32(value)}"/>`;
  let read;
  scanXml(xml, {
    onOpen(_name, attrText) {
      read = readAttrs(attrText).x;
    },
  });
  const back = new Float32Array(1);
  back[0] = Number(read);
  return back[0];
}

const named = [
  0,
  -0,
  1,
  -1,
  0.1,
  -0.1,
  1.401298464324817e-45,
  1.1754943508222875e-38,
  3.4028234663852886e38,
  -3.4028234663852886e38,
  1 / 3,
  Math.PI,
  16777216,
  16777217,
  1e-7,
  1e7,
  -123456.789,
];

let exact = 0;
let failed = 0;
let firstFailure = '';
const check = (v) => {
  f32[0] = v;
  const original = f32[0];
  const back = throughXml(original);
  if (Object.is(back, original)) exact += 1;
  else {
    failed += 1;
    if (firstFailure === '')
      firstFailure = `${String(original)} -> "${writeFloat32(original)}" -> ${String(back)}`;
  }
};

for (const v of named) check(v);

const rand = mulberry32(0x33f5);
let drawn = 0;
while (drawn < 200_000) {
  u32[0] = (rand() * 4294967296) >>> 0;
  if (!Number.isFinite(f32[0])) continue;
  check(f32[0]);
  drawn += 1;
}

say('=== 3MF coordinate fidelity: Float32 -> writer -> XML -> scanner -> Float32 ===');
say(
  `  values tested: ${String(named.length + drawn)} (${String(named.length)} named boundaries + 200,000 random bit patterns)`,
);
say(`  bit-identical: ${String(exact)}`);
say(`  failed:        ${String(failed)}${failed > 0 ? `  first: ${firstFailure}` : ''}`);

/* ---- negative zero, explicitly ---- */
f32[0] = -0;
const negZero = throughXml(f32[0]);
say('');
say(
  `  negative zero: written as "${writeFloat32(-0)}", returns ${Object.is(negZero, -0) ? '-0 (preserved)' : '+0 (LOST)'}`,
);

/* ---- transforms are Float64 and get their own contract ---- */
say('');
say('=== transform fidelity: Float64 -> writer -> XML -> scanner -> Number ===');

const transformProbes = [
  0,
  -0,
  1,
  -1,
  0.1,
  1 / 3,
  Math.PI,
  Number.EPSILON,
  5e-324,
  Number.MIN_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER,
  1.7976931348623157e308,
  -1.7976931348623157e308,
  0.30000000000000004,
  123456789.0625,
];
const randT = mulberry32(0x7f64);
for (let i = 0; i < 100_000; i += 1) {
  // Random Float64 bit patterns via two 32-bit halves.
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, (randT() * 4294967296) >>> 0);
  dv.setUint32(4, (randT() * 4294967296) >>> 0);
  const v = dv.getFloat64(0);
  if (Number.isFinite(v)) transformProbes.push(v);
}

let tExact = 0;
let tFailed = 0;
let tFirst = '';
for (const v of transformProbes) {
  const xml = `<item transform="${escapeXml(writeFloat64(v))}"/>`;
  let read;
  scanXml(xml, {
    onOpen(_n, a) {
      read = readAttrs(a).transform;
    },
  });
  const back = Number(read);
  if (Object.is(back, v)) tExact += 1;
  else {
    tFailed += 1;
    if (tFirst === '') tFirst = `${String(v)} -> "${writeFloat64(v)}" -> ${String(back)}`;
  }
}
say(`  values tested: ${String(transformProbes.length)}`);
say(`  bit-identical: ${String(tExact)}`);
say(`  failed:        ${String(tFailed)}${tFailed > 0 ? `  first: ${tFirst}` : ''}`);

/* ---- what a naive 6-decimal transform writer would do ---- */
const naive = (v) => v.toFixed(6);
let naiveFailed = 0;
for (const v of transformProbes) {
  if (!Object.is(Number(naive(v)), v)) naiveFailed += 1;
}
say('');
say(
  `  contrast: a toFixed(6) transform writer would lose ${String(naiveFailed)} of ${String(transformProbes.length)} values`,
);
