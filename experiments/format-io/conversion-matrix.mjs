/** Stage 4A-1-R1 — X01-X04 and the conversion verdict matrix. RESEARCH ONLY. */
import { analyseConversion, ConversionVerdict } from './conversion.mjs';

const say = (l = '') => process.stdout.write(`${l}\n`);
let pass = 0;
let total = 0;
function check(id, description, fn) {
  total += 1;
  try {
    fn();
    pass += 1;
    say(`${id.padEnd(7)} PASS  ${description}`);
  } catch (e) {
    say(`${id.padEnd(7)} ***FAIL*** ${description}\n          ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

const mesh = { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const moved = [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0];

const stlDoc = { unit: undefined, parts: [{ id: 'a', mesh, transform: identity }] };
const objDoc = {
  unit: undefined,
  parts: [{ id: 'a', name: 'hull', materialRef: 'red', mesh, transform: identity }],
};
const mf3Doc = {
  unit: 'inch',
  parts: [
    { id: 'a', name: 'left', mesh, transform: identity },
    { id: 'b', name: 'right', mesh, transform: moved },
  ],
};
const texturedDoc = {
  unit: 'millimeter',
  unsupported: ['texture2d'],
  parts: [{ id: 'a', mesh, transform: identity }],
};

say('=== X: cross-format conversion ===');

check('X01', 'STL (unknown unit) -> 3MF is BLOCKED, not silently millimetres', () => {
  const r = analyseConversion(stlDoc, '3mf');
  assert(r.verdict === ConversionVerdict.Blocked, `verdict ${r.verdict}`);
  assert(
    r.findings.some((f) => f.code === 'UNIT_REQUIRED'),
    'no unit finding',
  );
});

check('X01b', 'STL -> 3MF proceeds only with an explicit user unit, recorded as asserted', () => {
  const r = analyseConversion(stlDoc, '3mf', { unitOverride: 'millimeter' });
  assert(r.verdict !== ConversionVerdict.Blocked, 'still blocked with an override');
  assert(
    r.findings.some((f) => f.code === 'UNIT_ASSERTED_BY_USER'),
    'the added claim was not recorded',
  );
});

check('X02', 'OBJ (unknown unit) -> 3MF is BLOCKED for the same reason', () => {
  const r = analyseConversion(objDoc, '3mf');
  assert(r.verdict === ConversionVerdict.Blocked, `verdict ${r.verdict}`);
});

check('X03', '3MF -> OBJ loses the unit but keeps parts and names', () => {
  const r = analyseConversion(mf3Doc, 'obj');
  assert(r.verdict === ConversionVerdict.LossyStructure, `verdict ${r.verdict}`);
  assert(
    r.findings.some((f) => f.code === 'UNIT_LOST'),
    'unit loss not reported',
  );
  // OBJ cannot express a placement, so the transform must be baked.
  assert(
    r.findings.some((f) => f.code === 'TRANSFORMS_BAKED'),
    'transform loss not reported',
  );
  assert(!r.findings.some((f) => f.code === 'NAMES_LOST'), 'OBJ can carry names');
});

check('X04', '3MF -> STL reports structure, unit and name loss together', () => {
  const r = analyseConversion(mf3Doc, 'stl');
  assert(r.verdict === ConversionVerdict.LossyStructure, `verdict ${r.verdict}`);
  for (const code of ['PARTS_FLATTENED', 'TRANSFORMS_BAKED', 'UNIT_LOST', 'NAMES_LOST']) {
    assert(
      r.findings.some((f) => f.code === code),
      `missing ${code}`,
    );
  }
});

say('');
say('=== verdict distinguishability ===');

check('CV01', 'a supported 3MF subset -> 3MF is LOSSLESS', () => {
  const r = analyseConversion(mf3Doc, '3mf');
  assert(
    r.verdict === ConversionVerdict.Lossless,
    `verdict ${r.verdict} ${JSON.stringify(r.findings)}`,
  );
  assert(r.findings.length === 0, 'unexpected findings');
});

check('CV02', 'single-part 3MF -> STL with identity transform is LOSSY_METADATA only', () => {
  const doc = { unit: 'millimeter', parts: [{ id: 'a', mesh, transform: identity }] };
  const r = analyseConversion(doc, 'stl');
  assert(r.verdict === ConversionVerdict.LossyMetadata, `verdict ${r.verdict}`);
  assert(r.findings.length === 1 && r.findings[0].code === 'UNIT_LOST', 'expected only unit loss');
});

check('CV03', 'a textured source reports UNSUPPORTED_INPUT_FEATURE', () => {
  const r = analyseConversion(texturedDoc, '3mf');
  assert(r.verdict === ConversionVerdict.UnsupportedInput, `verdict ${r.verdict}`);
  assert(
    r.findings.some((f) => f.detail.includes('texture2d')),
    'texture not named',
  );
});

check('CV04', 'OBJ names and material reference survive OBJ -> OBJ', () => {
  const r = analyseConversion(objDoc, 'obj');
  assert(r.verdict === ConversionVerdict.Lossless, `verdict ${r.verdict}`);
});

check('CV05', 'multi-part OBJ -> STL is LOSSY_STRUCTURE', () => {
  const doc = {
    unit: undefined,
    parts: [
      { id: 'a', name: 'x', mesh, transform: identity },
      { id: 'b', mesh, transform: identity },
    ],
  };
  const r = analyseConversion(doc, 'stl');
  assert(r.verdict === ConversionVerdict.LossyStructure, `verdict ${r.verdict}`);
  assert(
    r.findings.some((f) => f.code === 'PARTS_FLATTENED'),
    'flattening not reported',
  );
});

check('CV06', 'all five verdicts are reachable and distinct', () => {
  const seen = new Set([
    analyseConversion(mf3Doc, '3mf').verdict,
    analyseConversion(
      { unit: 'millimeter', parts: [{ id: 'a', mesh, transform: identity }] },
      'stl',
    ).verdict,
    analyseConversion(mf3Doc, 'stl').verdict,
    analyseConversion(texturedDoc, '3mf').verdict,
    analyseConversion(stlDoc, '3mf').verdict,
  ]);
  assert(seen.size === 5, `only ${String(seen.size)} distinct verdicts: ${[...seen].join(', ')}`);
});

say('');
say(`conversion matrix: ${String(pass)}/${String(total)} checks passed`);
