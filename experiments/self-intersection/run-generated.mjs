/**
 * Stage 3C-1A-R1 — runs the regenerated Stage 3A R16/R17/R18 through the
 * diagnostic, native and WASM. RESEARCH ONLY.
 */
import { readFileSync } from 'node:fs';
import { runFixture } from './run-native.mjs';
import { runFixtureWasm } from './run-wasm.mjs';

/** Research output. A named writer, because `no-console` is on repo-wide. */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

const data = JSON.parse(
  readFileSync(new URL('./generated-fixtures.json', import.meta.url), 'utf8'),
);

export const GENERATED = data.fixtures;

if (import.meta.url === `file://${process.argv[1]}`) {
  let disagreements = 0;
  for (const f of GENERATED) {
    const nat = runFixture(f);
    const wsm = await runFixtureWasm(f);
    const agree =
      nat.statusName === wsm.statusName &&
      String(nat.intersectingPairCount) === String(wsm.intersectingPairCount) &&
      String(nat.properCrossing) === String(wsm.properCrossing) &&
      String(nat.coplanarOverlap) === String(wsm.coplanarOverlap) &&
      String(nat.affectedFaceCount) === String(wsm.affectedFaceCount);
    if (!agree) disagreements += 1;

    say(`${f.id} — ${f.title}`);
    say(`  defects declared by Stage 3A: ${f.intentionalDefects.join(', ')}`);
    say(
      `  status=${nat.statusName} cand=${nat.candidatePairCount} tested=${nat.testedPairCount} ` +
        `intersecting=${nat.intersectingPairCount} affectedFaces=${nat.affectedFaceCount}`,
    );
    say(
      `  properCrossing=${nat.properCrossing} coplanarOverlap=${nat.coplanarOverlap} ` +
        `pointTouch=${nat.nonAdjacentPointTouch} edgeTouch=${nat.nonAdjacentEdgeTouch} ` +
        `adjacentBeyond=${nat.adjacentOverlapBeyondShared} duplicate=${nat.duplicateTopologyDefect} ` +
        `legitimate=${nat.legitimateShared}`,
    );
    say(
      `  sourceUnchanged=${nat.positionsUnchanged && nat.indicesUnchanged}  native/WASM agree=${agree}`,
    );
    say('');
  }
  say(
    `native/WASM agreement on generated fixtures: ${GENERATED.length - disagreements}/${GENERATED.length}`,
  );
}
