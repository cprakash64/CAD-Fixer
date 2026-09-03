/** Stage 3C-1A — memory amplification. RESEARCH ONLY. */
import { runFixtureWasm, getModule } from './run-wasm.mjs';

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

const MiB = (b) => (b / (1024 * 1024)).toFixed(1);
const M = await getModule();
say(`wasm heap at init: ${MiB(M.HEAPU32.buffer.byteLength)} MiB`);
say('\nlabel     faces    verts   canon32  copy64  wasmHeap  scan_ms  status');

for (const [label, side, cap] of [
  ['20k', 100, 40000000],
  ['100k', 224, 40000000],
  ['200k', 316, 40000000],
  ['250k-ceiling', 354, 40000000],
  ['1M-above-ceiling', 707, 2000],
]) {
  const g = grid(side);
  const faces = g.triangles.length / 3;
  const verts = g.positions.length / 3;
  // What the production model actually costs today, vs the diagnostic's copy.
  const canonical32 = verts * 3 * 4 + faces * 3 * 4;
  const copy64 = verts * 3 * 8 + faces * 3 * 4;
  const before = M.HEAPU32.buffer.byteLength;
  const r = await runFixtureWasm(g, { maxTestedPairs: cap });
  const after = M.HEAPU32.buffer.byteLength;
  say(
    `${label.padEnd(9)} ${String(faces).padStart(7)} ${String(verts).padStart(8)} ` +
      `${MiB(canonical32).padStart(8)} ${MiB(copy64).padStart(7)} ${MiB(after).padStart(9)} ` +
      `${r.scanMs.toFixed(0).padStart(8)} ${r.statusName}  (heap grew ${MiB(after - before)} MiB)`,
  );
}
