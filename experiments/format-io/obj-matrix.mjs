/**
 * Stage 4A-1 — OBJ record matrix (F03-F09). RESEARCH ONLY.
 * Every expectation is analytically known from the fixture text itself.
 */
import { parseObj, writeFloat32 } from './obj.mjs';

const say = (l = '') => process.stdout.write(`${l}\n`);

const cases = [
  {
    id: 'F03',
    name: 'triangle-only OBJ',
    text: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
    expect: { vertexCount: 3, faceCount: 1, refusals: 0 },
    why: 'three v records and one f record; nothing else to interpret',
  },
  {
    id: 'F04',
    name: 'negative (relative) indices',
    text: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n',
    expect: { vertexCount: 3, faceCount: 1, refusals: 0, resolvesTo: [0, 1, 2] },
    why: '-1 is the most recent vertex, so -3 -2 -1 is exactly 1 2 3',
  },
  {
    id: 'F05',
    name: 'multiple objects and groups',
    text: 'o partA\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\no partB\ng inner\nv 5 0 0\nv 6 0 0\nv 5 1 0\nf 4 5 6\n',
    expect: { vertexCount: 6, faceCount: 2, objects: 2, groups: 1, refusals: 0 },
    why: 'two o records, one g record, six vertices, two triangles',
  },
  {
    id: 'F06',
    name: 'quad face',
    text: 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n',
    expect: { faceCount: 0, refusals: 1, refusal: 'POLYGON_UNSUPPORTED' },
    why: 'a 4-gon; triangle-only policy must refuse rather than fan it',
  },
  {
    id: 'F07',
    name: 'concave pentagon',
    text: 'v 0 0 0\nv 4 0 0\nv 4 4 0\nv 2 1 0\nv 0 4 0\nf 1 2 3 4 5\n',
    expect: { faceCount: 0, refusals: 1, refusal: 'POLYGON_UNSUPPORTED' },
    why: 'vertex 4 is inside the hull; a naive fan would emit triangles outside the polygon',
  },
  {
    id: 'F08',
    name: 'malformed / out-of-range index',
    text: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\nf 1 0 2\nf 1 2 abc\n',
    expect: { faceCount: 0, refusals: 3 },
    why: '99 exceeds the vertex count, 0 is not a legal OBJ index, abc is not a number',
  },
  {
    id: 'F09',
    name: 'very long line',
    text: `v 0 0 0\n# ${'x'.repeat(70_000)}\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`,
    expect: { refusals: 1, refusal: 'LINE_TOO_LONG' },
    why: 'the comment exceeds the 65,536-char line cap and is refused before tokenising',
  },
  {
    id: 'F08b',
    name: 'non-finite coordinates',
    text: 'v 0 0 0\nv NaN 0 0\nv Infinity 0 0\nv 1 0 0\n',
    expect: { refusals: 2, refusal: 'NON_FINITE_COORDINATE' },
    why: 'parseFloat accepts "NaN" and "Infinity"; neither has a bounding box or exact predicate',
  },
  {
    id: 'F03b',
    name: 'all four face-corner spellings',
    text: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nf 1 2 3\nf 1/1 2/1 3/1\nf 1//1 2//1 3//1\nf 1/1/1 2/1/1 3/1/1\n',
    expect: { faceCount: 4, refusals: 0 },
    why: 'v, v/vt, v//vn and v/vt/vn all resolve to the same three positions',
  },
  {
    id: 'F03c',
    name: 'CRLF line endings and blank lines',
    text: 'v 0 0 0\r\n\r\nv 1 0 0\r\nv 0 1 0\r\n\r\nf 1 2 3\r\n',
    expect: { vertexCount: 3, faceCount: 1, refusals: 0 },
    why: 'CRLF and blank lines carry no geometry meaning',
  },
  {
    id: 'F05b',
    name: 'Unicode object names and materials',
    text: 'mtllib パーツ.mtl\no 部品Ａ\nusemtl 赤\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
    expect: { vertexCount: 3, faceCount: 1, objects: 1, materials: 1, refusals: 0 },
    why: 'names are opaque text; only their length is bounded',
  },
];

say(
  `${'id'.padEnd(7)} ${'fixture'.padEnd(34)} ${'v'.padStart(4)} ${'f'.padStart(4)} ${'obj'.padStart(4)} ${'grp'.padStart(4)} ${'refusals'.padStart(9)}  verdict`,
);
say('-'.repeat(104));

let pass = 0;
for (const c of cases) {
  const r = parseObj(c.text);
  const e = c.expect;
  const checks = [
    e.vertexCount === undefined || r.vertexCount === e.vertexCount,
    e.faceCount === undefined || r.faceCount === e.faceCount,
    e.objects === undefined || r.objects.length === e.objects,
    e.groups === undefined || r.groups.length === e.groups,
    e.materials === undefined || r.materials.length === e.materials,
    e.refusals === undefined || r.refusals.length === e.refusals,
    e.refusal === undefined || r.refusals.some((x) => x.code === e.refusal),
    e.resolvesTo === undefined ||
      JSON.stringify(r.faces[0]?.indices) === JSON.stringify(e.resolvesTo),
  ];
  const ok = checks.every(Boolean);
  if (ok) pass += 1;
  say(
    `${c.id.padEnd(7)} ${c.name.padEnd(34)} ${String(r.vertexCount).padStart(4)} ${String(r.faceCount).padStart(4)} ` +
      `${String(r.objects.length).padStart(4)} ${String(r.groups.length).padStart(4)} ${String(r.refusals.length).padStart(9)}  ${ok ? 'as expected' : '*** UNEXPECTED'}`,
  );
}
say('');
say(`OBJ matrix: ${String(pass)}/${String(cases.length)} behaved as analytically expected`);

/* ---- the polygon question, demonstrated rather than asserted ---- */

say('');
say('--- why a naive fan is not an option (F07 concave pentagon) ---');
const pentagon = [
  [0, 0],
  [4, 0],
  [4, 4],
  [2, 1],
  [0, 4],
];
const area = (a, b, c) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
const signs = [];
for (let i = 1; i + 1 < pentagon.length; i += 1) {
  const t = area(pentagon[0], pentagon[i], pentagon[i + 1]);
  signs.push(t > 0 ? '+' : '-');
}
let shoelace = 0;
for (let i = 0; i < pentagon.length; i += 1) {
  const p = pentagon[i];
  const q = pentagon[(i + 1) % pentagon.length];
  shoelace += p[0] * q[1] - q[0] * p[1];
}
shoelace /= 2;
say(`  true polygon area (shoelace):  ${shoelace.toFixed(2)}`);
say(`  naive fan triangle signs:      ${signs.join(' ')}`);
say(`  fan produces a triangle of the OPPOSITE orientation, i.e. geometry outside the polygon.`);
say(`  Fanning would therefore INVENT faces the file never described.`);

/* ---- round-trip of the writer ---- */

say('');
say('--- OBJ coordinate writer, Float32 exactness ---');
const f32 = new Float32Array(1);
let exact = 0;
const probes = [
  0,
  -0,
  0.1,
  1 / 3,
  1.401298464324817e-45,
  3.4028234663852886e38,
  16777217,
  -123456.789,
];
for (const v of probes) {
  f32[0] = v;
  const text = writeFloat32(f32[0]);
  const back = new Float32Array(1);
  back[0] = Number.parseFloat(text);
  const ok = Object.is(back[0], f32[0]);
  if (ok) exact += 1;
  say(`  ${String(f32[0]).padEnd(26)} -> ${text.padEnd(16)} ${ok ? 'exact' : '*** LOST'}`);
}
say(`  ${String(exact)}/${String(probes.length)} exact, including negative zero`);
