/**
 * Stage 3C-1A-R1 — differential validation. RESEARCH ONLY.
 *
 * THE RULE THIS ENFORCES. The Stage 3C-1A classifier is the ORACLE. A prefilter
 * exists only to reach the same answer faster; the moment it changes one
 * legitimate classification it is not an optimisation, it is a different
 * diagnostic, and it is rejected. Every field is compared, not just the
 * headline count.
 */
import { FIXTURES } from './fixtures.mjs';
import { GENERATED } from './run-generated.mjs';
import { runFixture } from './run-native.mjs';

/** Research output. A named writer, because `no-console` is on repo-wide. */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

/*
 * `candidatePairCount` is deliberately NOT a classification field.
 *
 * It counts how many candidates the broadphase ENUMERATED, which is a measure
 * of work performed, not of what the mesh contains. When a work cap fires, the
 * abortable tree stops and the Geogram tree does not — so on a capped run the
 * two legitimately disagree, and that disagreement is precisely the defect this
 * stage set out to fix. Every field that describes the MESH is compared; this
 * one is asserted separately, and only in the direction that means less waste.
 */
const KEYS = [
  'statusName',
  'testedPairCount',
  'intersectingPairCount',
  'affectedFaceCount',
  'properCrossing',
  'coplanarOverlap',
  'nonAdjacentPointTouch',
  'nonAdjacentEdgeTouch',
  'adjacentOverlapBeyondShared',
  'duplicateTopologyDefect',
  'legitimateShared',
  'skippedDegenerateFaceCount',
  'skippedPairCount',
  'samplePairCount',
  'samplesTruncated',
];

/**
 * `variant` is the flag set under test; the oracle is always the Stage 3C-1A
 * configuration — Geogram's broadphase with no prefilters.
 */
function compare(label, fixture, extraArgs = [], variant = ['--fast'], quiet = false) {
  const base = runFixture(fixture, [...extraArgs, '--geogram-broadphase']);
  const fast = runFixture(fixture, [...extraArgs, ...variant]);
  const diffs = KEYS.filter((k) => String(base[k]) !== String(fast[k]));
  const sampleDiff = JSON.stringify(base.samples) !== JSON.stringify(fast.samples);
  // Work enumerated may fall, never rise: a variant that enumerated MORE pairs
  // than the oracle would be doing extra work, which is its own defect.
  const workOk = Number(fast.candidatePairCount) <= Number(base.candidatePairCount);
  const ok = diffs.length === 0 && !sampleDiff && workOk;
  if (!workOk && !quiet) {
    say(
      `${label.padEnd(10)} *** MORE WORK: oracle=${base.candidatePairCount} variant=${fast.candidatePairCount}`,
    );
  }
  if (!ok && !quiet) {
    say(`${label.padEnd(10)} *** MISMATCH: ${diffs.join(',')}${sampleDiff ? ' samples' : ''}`);
    for (const k of diffs) say(`             ${k}: oracle=${base[k]} variant=${fast[k]}`);
  }
  return ok;
}

let pass = 0,
  fail = 0;

/*
 * PASS 1 — THE SHIPPED PATH. The default configuration (abortable broadphase,
 * no prefilters) must agree with the Stage 3C-1A oracle on every field. This is
 * the pass that gates the stage.
 */
say('=== PASS 1: DEFAULT path vs Stage 3C-1A oracle (must be identical) ===');
let defaultPass = 0,
  defaultFail = 0;
for (const f of [...FIXTURES, ...GENERATED]) {
  const args = f.expect?.pathological ? ['--max-tested=2000'] : [];
  if (compare(f.id, f, args, [])) defaultPass += 1;
  else defaultFail += 1;
}
say(`default path: ${defaultPass} identical, ${defaultFail} mismatched`);

/*
 * PASS 2 — THE REJECTED PREFILTERS, kept as the evidence behind their rejection.
 * `--fast` is expected to DISAGREE on `legitimateShared`: it classifies pairs
 * the oracle records as SI_NONE. That disagreement, plus a measured gain of only
 * ~5%, is why the prefilters are off in the shipped path. The mismatches printed
 * below are the finding, not a regression.
 */
say('\n=== PASS 2: rejected --fast prefilters (disagreement is the finding) ===');
for (const f of FIXTURES) {
  const args = f.expect?.pathological ? ['--max-tested=2000'] : [];
  if (compare(f.id, f, args)) pass += 1;
  else fail += 1;
}

say('=== Stage 3A generated fixtures ===');
for (const f of GENERATED) {
  if (compare(f.id, f)) pass += 1;
  else fail += 1;
}

// Transformed and permuted variants: a prefilter that is only correct in one
// orientation is not correct.
say('=== transformed variants ===');
const permute = (f) => {
  const n = f.triangles.length / 3;
  const t = [];
  for (let i = n - 1; i >= 0; i -= 1)
    t.push(f.triangles[3 * i], f.triangles[3 * i + 1], f.triangles[3 * i + 2]);
  return { ...f, triangles: t };
};
const reverse = (f) => {
  const t = [];
  for (let i = 0; i < f.triangles.length; i += 3)
    t.push(f.triangles[i], f.triangles[i + 2], f.triangles[i + 1]);
  return { ...f, triangles: t };
};
const shift = (f, d) => ({ ...f, positions: f.positions.map((v, i) => v + (i % 3 === 2 ? d : 0)) });
const scale = (f, s) => ({ ...f, positions: f.positions.map((v) => v * s) });

for (const f of [...FIXTURES, ...GENERATED]) {
  if (f.expect?.pathological) continue;
  for (const [name, make] of [
    ['perm', permute],
    ['rev', reverse],
    ['shift', (x) => shift(x, 512)],
    ['scale', (x) => scale(x, 8)],
  ]) {
    if (compare(`${f.id}/${name}`, make(f))) pass += 1;
    else fail += 1;
  }
}

say(
  `\nrejected-prefilter differential: ${pass} identical, ${fail} disagreed (expected: they are off by default)`,
);
say(
  `\nGATE — default path vs oracle: ${defaultFail === 0 ? 'IDENTICAL ✓' : `${defaultFail} MISMATCHED ✗`}`,
);
