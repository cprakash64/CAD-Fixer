/**
 * Stage 3C-1A — drives the native self-intersection harness over the corpus.
 * RESEARCH ONLY. Prints one JSON line per fixture.
 */
import { execFileSync } from 'node:child_process';
import { FIXTURES } from './fixtures.mjs';

/** Research output. A named writer, because `no-console` is on repo-wide. */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

const BIN = new URL('./artifacts/si-native', import.meta.url).pathname;
const STATUS = ['CHECKED', 'PARTIAL', 'RESOURCE_LIMIT', 'INTERNAL_FAILURE'];

export function runFixture(fixture, args = []) {
  const vertexCount = fixture.positions.length / 3;
  const faceCount = fixture.triangles.length / 3;
  const input = `${vertexCount} ${faceCount}\n${fixture.positions.map((v) => v.toPrecision(21)).join(' ')}\n${fixture.triangles.join(' ')}\n`;
  const out = execFileSync(BIN, args, { input, maxBuffer: 1 << 28 }).toString();
  const parsed = JSON.parse(out.trim().split('\n').pop());
  return { ...parsed, statusName: STATUS[parsed.status] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[2];
  for (const f of FIXTURES) {
    if (only && f.id !== only) continue;
    const args = f.expect?.pathological ? ['--max-tested=2000'] : [];
    let r;
    try {
      r = runFixture(f, args);
    } catch (e) {
      say(JSON.stringify({ id: f.id, error: String(e.message).slice(0, 300) }));
      continue;
    }
    say(
      JSON.stringify({
        id: f.id,
        name: f.name,
        status: r.statusName,
        cand: r.candidatePairCount,
        tested: r.testedPairCount,
        isect: r.intersectingPairCount,
        affected: r.affectedFaceCount,
        cross: r.properCrossing,
        coplanar: r.coplanarOverlap,
        ptTouch: r.nonAdjacentPointTouch,
        edgeTouch: r.nonAdjacentEdgeTouch,
        adjBeyond: r.adjacentOverlapBeyondShared,
        dup: r.duplicateTopologyDefect,
        legit: r.legitimateShared,
        skipF: r.skippedDegenerateFaceCount,
        skipP: r.skippedPairCount,
        samples: r.samplePairCount,
        trunc: r.samplesTruncated,
        posOK: r.positionsUnchanged,
        idxOK: r.indicesUnchanged,
        failed: r.failed,
      }),
    );
  }
}
