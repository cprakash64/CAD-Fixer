/**
 * Stage 3C-1A-R1 — broadphase equivalence and abortability. RESEARCH ONLY.
 *
 * A replacement broadphase that MISSES a pair converts a defect into a clean
 * bill of health, so it is validated against two independent references: a
 * brute-force all-pairs box test written here in JavaScript, and Geogram's own
 * AABB tree. The new tree is never its own oracle.
 */
import { FIXTURES } from './fixtures.mjs';
import { GENERATED } from './run-generated.mjs';
import { runFixture } from './run-native.mjs';

/** Research output. A named writer, because `no-console` is on repo-wide. */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function bruteForcePairs(f) {
  const faces = f.triangles.length / 3;
  const box = [];
  for (let i = 0; i < faces; i += 1) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 3; c += 1) {
      const v = f.triangles[3 * i + c];
      for (let k = 0; k < 3; k += 1) {
        const val = f.positions[3 * v + k];
        if (val < lo[k]) lo[k] = val;
        if (val > hi[k]) hi[k] = val;
      }
    }
    box.push([lo, hi]);
  }
  let n = 0;
  for (let a = 0; a < faces; a += 1) {
    for (let b = a + 1; b < faces; b += 1) {
      const [alo, ahi] = box[a];
      const [blo, bhi] = box[b];
      if (
        alo[0] <= bhi[0] &&
        blo[0] <= ahi[0] &&
        alo[1] <= bhi[1] &&
        blo[1] <= ahi[1] &&
        alo[2] <= bhi[2] &&
        blo[2] <= ahi[2]
      )
        n += 1;
    }
  }
  return n;
}

const CLASS_KEYS = [
  'statusName',
  'candidatePairCount',
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
];

let pass = 0,
  fail = 0;
say('fixture   brute   geogram   bvh   classifications');
for (const f of [...FIXTURES, ...GENERATED]) {
  if (f.expect?.pathological) continue;
  const brute = bruteForcePairs(f);
  const geo = runFixture(f);
  const bvh = runFixture(f, ['--abortable']);
  const sameCount =
    Number(geo.candidatePairCount) === brute && Number(bvh.candidatePairCount) === brute;
  const diffs = CLASS_KEYS.filter((k) => String(geo[k]) !== String(bvh[k]));
  const sampleSame = JSON.stringify(geo.samples) === JSON.stringify(bvh.samples);
  const ok = sameCount && diffs.length === 0 && sampleSame;
  if (ok) pass += 1;
  else {
    fail += 1;
    say(
      `${f.id.padEnd(9)} ${String(brute).padStart(6)} ${String(geo.candidatePairCount).padStart(8)} ` +
        `${String(bvh.candidatePairCount).padStart(6)}  *** ${diffs.join(',')}${sampleSame ? '' : ' samples'}`,
    );
  }
}
say(`\nbroadphase equivalence: ${pass} identical, ${fail} mismatched`);
