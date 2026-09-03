/**
 * Stage 3C-1A-R1 — the candidate funnel, and what the prefilters remove.
 * RESEARCH ONLY.
 */
import { runFixture } from './run-native.mjs';

/** Research output. A named writer, because `no-console` is on repo-wide. */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function grid(side) {
  const positions = [];
  for (let y = 0; y <= side; y += 1) {
    for (let x = 0; x <= side; x += 1) positions.push(x, y, 0);
  }
  const triangles = [];
  const at = (x, y) => y * (side + 1) + x;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      triangles.push(at(x, y), at(x + 1, y), at(x, y + 1));
      triangles.push(at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
    }
  }
  return { positions, triangles };
}

/** A closed-ish shell in 3D so shared edges are genuinely non-coplanar. */
function corrugated(side) {
  const positions = [];
  for (let y = 0; y <= side; y += 1) {
    for (let x = 0; x <= side; x += 1) positions.push(x, y, (x % 2) * 0.5);
  }
  const triangles = [];
  const at = (x, y) => y * (side + 1) + x;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      triangles.push(at(x, y), at(x + 1, y), at(x, y + 1));
      triangles.push(at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
    }
  }
  return { positions, triangles };
}

const SIZES = [
  ['20k', 102],
  ['200k', 323],
  ['1M', 724],
];

for (const [shape, make] of [
  ['planar', grid],
  ['corrugated', corrugated],
]) {
  say(`\n=== ${shape} surface ===`);
  say(
    'size   faces      cand      dup   degen  sharedE  sharedV  disjoint  planeSep  narrow    scan_ms',
  );
  for (const [label, side] of SIZES) {
    const f = make(side);
    for (const mode of ['baseline', 'fast']) {
      const args = mode === 'fast' ? ['--fast'] : [];
      const r = runFixture(f, args);
      say(
        `${(label + '/' + mode).padEnd(14)} ${String(r.candidatePairCount).padStart(9)} ` +
          `${String(r.funnelDuplicate).padStart(6)} ${String(r.funnelDegenerate).padStart(6)} ` +
          `${String(r.funnelSharedEdge).padStart(8)} ${String(r.funnelSharedVertex).padStart(8)} ` +
          `${String(r.funnelDisjoint).padStart(9)} ${String(r.funnelPlaneSeparated).padStart(9)} ` +
          `${String(r.funnelNarrowphase).padStart(9)} ${r.scanMs.toFixed(0).padStart(9)}`,
      );
    }
  }
}
