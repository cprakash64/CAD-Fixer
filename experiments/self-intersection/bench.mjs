/**
 * Stage 3C-1A — scaling evidence. RESEARCH ONLY.
 *
 * Sizes are chosen to match the STL byte sizes the rest of CAD Fixer benchmarks
 * against (docs/PERFORMANCE_BASELINE.md), so this table can be read beside the
 * parse and topology tables rather than in isolation.
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

/** A clean grid with `n` crossing blades pushed through it: sparse defects. */
function gridWithCrossings(side, n) {
  const g = grid(side);
  const v0 = g.positions.length / 3;
  for (let k = 0; k < n; k += 1) {
    const x = 1 + ((k * 7) % (side - 2));
    const y = 1 + ((k * 13) % (side - 2));
    g.positions.push(x + 0.25, y + 0.25, -1, x + 0.75, y + 0.25, 1, x + 0.25, y + 0.75, 1);
    g.triangles.push(v0 + k * 3, v0 + k * 3 + 1, v0 + k * 3 + 2);
  }
  return g;
}

const SIZES = [
  { label: '~1 MiB', side: 102 },
  { label: '~10 MiB', side: 323 },
  { label: '~50 MiB', side: 724 },
];

say(
  'kind        size      faces      cand      tested   isect  degen_ms  aabb_ms  scan_ms  total_ms   status',
);
for (const { label, side } of SIZES) {
  for (const kind of ['clean', 'sparse']) {
    const f = kind === 'clean' ? grid(side) : gridWithCrossings(side, 64);
    const faces = f.triangles.length / 3;
    const t0 = performance.now();
    const r = runFixture(f);
    const wall = performance.now() - t0;
    say(
      `${kind.padEnd(11)} ${label.padEnd(8)} ${String(faces).padStart(9)} ${String(r.candidatePairCount).padStart(9)} ` +
        `${String(r.testedPairCount).padStart(9)} ${String(r.intersectingPairCount).padStart(6)} ` +
        `${r.degeneracyMs.toFixed(1).padStart(8)} ${r.aabbMs.toFixed(1).padStart(8)} ${r.scanMs.toFixed(1).padStart(8)} ` +
        `${wall.toFixed(0).padStart(9)} ${r.statusName} ${r.positionsUnchanged && r.indicesUnchanged ? 'src-OK' : 'SRC-CHANGED'}`,
    );
  }
}
