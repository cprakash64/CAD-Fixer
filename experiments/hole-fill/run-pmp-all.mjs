/**
 * Drives `run-pmp.mjs` ONE FIXTURE PER PROCESS. RESEARCH ONLY.
 *
 * A PMP trap aborts the host process outright — the binding's `catch(...)` does
 * not see it and neither does JavaScript. Process isolation is therefore the
 * only way to measure the rest of the corpus after one, and it is the same
 * containment argument that decides the production worker architecture.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpus } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'run-pmp.mjs');

const rows = [];
for (const testCase of corpus()) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [RUNNER, testCase.id], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const wallMs = Date.now() - started;

  if (result.status !== 0 || result.stdout.trim() === '') {
    rows.push({
      id: testCase.id,
      what: testCase.what,
      outcome: result.signal === 'SIGTERM' ? 'KERNEL_TIMEOUT' : 'KERNEL_PROCESS_ABORT',
      exitStatus: result.status,
      signal: result.signal,
      wallMs,
      // The abort message, trimmed: evidence that this is a trap rather than a
      // thrown exception.
      stderrHead:
        (result.stderr ?? '')
          .split('\n')
          .filter((line) => /Error|abort|RuntimeError/.test(line))[0] ?? '',
    });
    process.stderr.write(`${testCase.id} -> PROCESS ABORT (${wallMs}ms)\n`);
    continue;
  }

  const parsed = JSON.parse(result.stdout);
  for (const row of parsed.rows) rows.push({ ...row, wallMs });
  process.stderr.write(`${testCase.id} -> ${parsed.rows[0]?.outcome} (${wallMs}ms)\n`);
}

process.stdout.write(`${JSON.stringify({ rows }, null, 2)}\n`);
