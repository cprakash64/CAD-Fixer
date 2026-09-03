/**
 * Stage 3C-1A — independent validation. RESEARCH ONLY.
 *
 * TWO THINGS GEOGRAM IS NOT ALLOWED TO BE ITS OWN JUDGE OF.
 *
 * 1. BROADPHASE COMPLETENESS. The AABB tree is checked against a brute-force
 *    all-pairs bounding-box overlap count computed here in JavaScript. Using the
 *    tree as its own oracle would prove only that it is self-consistent; a tree
 *    that silently pruned a whole subtree would still agree with itself.
 *
 * 2. DETERMINISM UNDER PERMUTATION. The same geometry is re-fed with its faces
 *    reordered, its winding reversed, translated, and exactly scaled. Aggregate
 *    classifications must not move. Face IDS legitimately change under
 *    permutation, so only the aggregates are compared.
 */
import { FIXTURES } from './fixtures.mjs';
import { runFixture } from './run-native.mjs';

/** Research output. A named writer, because `no-console` is on repo-wide. */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

/** Brute-force AABB overlap pair count, normalised f1 < f2. */
function bruteForceCandidatePairs(fixture) {
  const { positions, triangles } = fixture;
  const faces = triangles.length / 3;
  const box = [];
  for (let f = 0; f < faces; f += 1) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 3; c += 1) {
      const v = triangles[3 * f + c];
      for (let k = 0; k < 3; k += 1) {
        const val = positions[3 * v + k];
        if (val < lo[k]) lo[k] = val;
        if (val > hi[k]) hi[k] = val;
      }
    }
    box.push([lo, hi]);
  }
  let count = 0;
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
        count += 1;
    }
  }
  return count;
}

const AGG = (r) => ({
  status: r.statusName,
  isect: r.intersectingPairCount,
  cross: r.properCrossing,
  coplanar: r.coplanarOverlap,
  pt: r.nonAdjacentPointTouch,
  edge: r.nonAdjacentEdgeTouch,
  adj: r.adjacentOverlapBeyondShared,
  dup: r.duplicateTopologyDefect,
  affected: r.affectedFaceCount,
  skipF: r.skippedDegenerateFaceCount,
});

function permuteFaces(f) {
  const faces = f.triangles.length / 3;
  const order = [...Array(faces).keys()].reverse();
  const triangles = [];
  for (const i of order)
    triangles.push(f.triangles[3 * i], f.triangles[3 * i + 1], f.triangles[3 * i + 2]);
  return { ...f, triangles };
}
function reverseWinding(f) {
  const triangles = [];
  for (let i = 0; i < f.triangles.length; i += 3) {
    triangles.push(f.triangles[i], f.triangles[i + 2], f.triangles[i + 1]);
  }
  return { ...f, triangles };
}
function translate(f, d) {
  return { ...f, positions: f.positions.map((v, i) => v + (i % 3 === 0 ? d : 0)) };
}
function scale(f, s) {
  return { ...f, positions: f.positions.map((v) => v * s) };
}

let broadFail = 0,
  detFail = 0,
  checked = 0;

say('=== BROADPHASE vs BRUTE-FORCE AABB ORACLE ===');
for (const f of FIXTURES) {
  if (f.expect?.pathological) continue;
  const r = runFixture(f);
  const expected = bruteForceCandidatePairs(f);
  const ok = Number(r.candidatePairCount) === expected;
  if (!ok) broadFail += 1;
  checked += 1;
  say(
    `${f.id.padEnd(6)} geogram=${String(r.candidatePairCount).padStart(6)} brute=${String(expected).padStart(6)} ${ok ? 'MATCH' : '*** MISMATCH ***'}`,
  );
}

say('\n=== DETERMINISM: repeat / permute / reverse / translate / scale ===');
for (const f of FIXTURES) {
  if (f.expect?.pathological) continue;
  const base = AGG(runFixture(f));
  const variants = {
    repeat: AGG(runFixture(f)),
    facePermuted: AGG(runFixture(permuteFaces(f))),
    windingReversed: AGG(runFixture(reverseWinding(f))),
    translated: AGG(runFixture(translate(f, 1024))),
    scaled: AGG(runFixture(scale(f, 4))),
  };
  const bad = Object.entries(variants)
    .filter(([, v]) => JSON.stringify(v) !== JSON.stringify(base))
    .map(([k]) => k);
  if (bad.length) detFail += 1;
  say(
    `${f.id.padEnd(6)} ${bad.length === 0 ? 'STABLE' : '*** DIFFERS: ' + bad.join(',') + ' ***'}`,
  );
}

say(
  `\nbroadphase: ${checked - broadFail}/${checked} match   determinism: ${checked - detFail}/${checked} stable`,
);
