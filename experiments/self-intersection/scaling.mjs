/**
 * Stage 3C-1A-R1 — scaling by FACE COUNT. RESEARCH ONLY.
 *
 * Keyed on faces and candidate pairs, not file MiB: an STL, an OBJ and a 3MF of
 * the same model have very different byte counts, so a policy keyed on bytes
 * would move when the container changed while the geometry did not. Approximate
 * binary-STL MiB is reported alongside only for continuity with the earlier
 * tables.
 */
import { runFixture } from './run-native.mjs';

/** Research output. A named writer, because `no-console` is on repo-wide. */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function grid(side) {
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

const TARGETS = [
  ['20k', 100],
  ['50k', 158],
  ['100k', 224],
  ['200k', 316],
  ['500k', 500],
  ['1M', 707],
];
const RUNS = 3;

say('label   faces      cand    ~MiB  mode        median_ms   range_ms       status');
for (const [label, side] of TARGETS) {
  const f = grid(side);
  const faces = f.triangles.length / 3;
  const mib = ((84 + faces * 50) / (1024 * 1024)).toFixed(1);
  for (const mode of ['geogram', 'abortable']) {
    const args = mode === 'abortable' ? ['--abortable'] : [];
    const times = [];
    let last;
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = performance.now();
      last = runFixture(f, args);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(RUNS / 2)];
    say(
      `${label.padEnd(7)} ${String(faces).padStart(7)} ${String(last.candidatePairCount).padStart(9)} ` +
        `${mib.padStart(6)}  ${mode.padEnd(10)} ${median.toFixed(0).padStart(9)} ` +
        `${times[0].toFixed(0)}-${times[times.length - 1].toFixed(0)}`.padStart(13) +
        `   ${last.statusName}`,
    );
  }
}
