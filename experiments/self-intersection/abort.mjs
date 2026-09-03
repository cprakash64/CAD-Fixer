/**
 * Stage 3C-1A-R1 — is the work cap genuinely abortable? RESEARCH ONLY.
 *
 * THE DEFECT UNDER TEST. Geogram's broadphase callback returns void, so when
 * CAD Fixer's tested-pair cap fires the traversal cannot be told to stop. It
 * keeps walking and keeps calling back for every remaining overlapping pair —
 * an O(N^2) walk performed entirely to throw its own results away. Memory was
 * bounded; CPU was not. This measures exactly how much is wasted, and whether
 * the abortable tree fixes it.
 */
import { runFixture } from './run-native.mjs';

/** Research output. A named writer, because `no-console` is on repo-wide. */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

/** Every triangle spans the whole domain, so every AABB overlaps every other. */
function pathological(n) {
  const positions = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    const a = (i * 2 * Math.PI) / n;
    positions.push(Math.cos(a) * 100, Math.sin(a) * 100, 0);
    positions.push(Math.cos(a) * 100, Math.sin(a) * 100, 1);
  }
  const triangles = [];
  for (let i = 0; i < n; i += 1) triangles.push(0, 1 + i * 2, 2 + i * 2);
  return { positions, triangles };
}

say('faces   pairs(n^2/2)   mode        cand     tested  afterCap   wastedMs   scanMs   status');
for (const n of [400, 2000, 6000]) {
  const f = pathological(n);
  const worst = (n * (n - 1)) / 2;
  for (const mode of ['geogram', 'abortable']) {
    const args = ['--max-tested=2000'];
    if (mode === 'abortable') args.push('--abortable');
    const t0 = performance.now();
    const r = runFixture(f, args);
    const wall = performance.now() - t0;
    say(
      `${String(n).padStart(5)} ${String(worst).padStart(13)}   ${mode.padEnd(10)} ` +
        `${String(r.candidatePairCount).padStart(8)} ${String(r.testedPairCount).padStart(7)} ` +
        `${String(r.callbacksAfterCap).padStart(9)} ${r.wastedAfterCapMs.toFixed(1).padStart(10)} ` +
        `${r.scanMs.toFixed(0).padStart(8)} ${r.statusName} (wall ${wall.toFixed(0)}ms)`,
    );
  }
}
