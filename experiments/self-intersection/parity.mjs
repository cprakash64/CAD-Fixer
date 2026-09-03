/** Stage 3C-1A — native vs WASM parity over the corpus. RESEARCH ONLY. */
import { FIXTURES } from './fixtures.mjs';
import { runFixture } from './run-native.mjs';
import { runFixtureWasm } from './run-wasm.mjs';

/** Research output. A named writer, because `no-console` is on repo-wide. */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

const KEYS = [
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
  'samplePairCount',
  'samplesTruncated',
];

let mismatches = 0,
  n = 0;
for (const f of FIXTURES) {
  const limits = f.expect?.pathological ? { maxTestedPairs: 2000 } : {};
  const args = f.expect?.pathological ? ['--max-tested=2000'] : [];
  const nat = runFixture(f, args);
  const wsm = await runFixtureWasm(f, limits);
  const diffs = KEYS.filter((k) => String(nat[k]) !== String(wsm[k]));
  // Sample pairs must agree element-for-element, not merely in count.
  const sampleDiff = JSON.stringify(nat.samples) !== JSON.stringify(wsm.samples);
  n += 1;
  if (diffs.length || sampleDiff) {
    mismatches += 1;
    say(`${f.id.padEnd(6)} *** DIFFERS: ${diffs.join(',')}${sampleDiff ? ' samples' : ''}`);
    for (const k of diffs) say(`         ${k}: native=${nat[k]} wasm=${wsm[k]}`);
  } else {
    say(
      `${f.id.padEnd(6)} PARITY  ${wsm.statusName.padEnd(15)} isect=${wsm.intersectingPairCount} samples=${wsm.samplePairCount}`,
    );
  }
}
say(`\nnative/WASM parity: ${n - mismatches}/${n} identical`);
