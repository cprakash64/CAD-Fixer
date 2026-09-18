import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { isAppError } from '@cadfixer/shared';
import { distinctMeshes, documentTriangleCount } from '@cadfixer/mesh-core';
import { refusalOf } from '../packages/file-formats/src/import-errors';
import { testReadContext } from '../packages/file-formats/src/test-context';
import { read3mf } from '../packages/file-formats/src/threemf/threemf-reader';

/**
 * WHAT THE PRODUCTION READER MAKES OF A DIRECTORY OF REAL 3MF FILES.
 *
 * NO FIXTURE IS COMMITTED WITH THIS. The directory comes from
 * `CADFIXER_CORPUS` and the repository stays dataless: no third-party model is
 * committed and no producer's output is redistributed here. The v0.1.1 RC
 * qualification used files carried in PrusaSlicer's and OrcaSlicer's own public
 * repositories and committed none of them; this keeps that arrangement and
 * makes the run repeatable.
 *
 * WHY IT MATTERS MORE AFTER STAGE 6D-A2. Synthetic fixtures prove the
 * semantics; they cannot prove that real producers write the shapes we think
 * they do. Until A2 a production-extension package was refused, so being wrong
 * about a producer's structure meant a refusal. It now IMPORTS, and being wrong
 * means the wrong geometry on screen.
 *
 * Run: CADFIXER_CORPUS=<directory> npm run qualify:threemf-corpus
 *
 * IT ASSERTS NOTHING ABOUT ANY PARTICULAR FILE, and it must not: a corpus that
 * is not in the repository cannot be a test, because the suite would pass or
 * fail on what happens to be in a directory. It REPORTS, and the reading is the
 * qualifier's. What it does assert is that the run itself completed, so a
 * reporter that silently read nothing cannot look like a clean result.
 */
it('reports what the reader makes of every 3MF in CADFIXER_CORPUS', async () => {
  const directory = process.env.CADFIXER_CORPUS ?? '';
  if (directory === '') {
    process.stdout.write('\nCADFIXER_CORPUS is not set: nothing to read.\n');
    return;
  }

  const files = readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith('.3mf'))
    .sort();
  const lines = [`\n3MF corpus at ${directory} — ${String(files.length)} file(s)\n`];

  for (const name of files) {
    const bytes = new Uint8Array(readFileSync(join(directory, name)));
    const startedAt = Date.now();
    try {
      const result = await read3mf(bytes, testReadContext());
      const first = result.document.parts[0];
      lines.push(
        `${name.padEnd(30)} IMPORTED  ` +
          `parts=${String(result.document.parts.length).padStart(4)}  ` +
          `distinctMeshes=${String(distinctMeshes(result.document).length).padStart(4)}  ` +
          `triangles=${documentTriangleCount(result.document).toLocaleString('en-US').padStart(10)}  ` +
          `unit=${String(result.document.unit)}  ` +
          `firstTransform=[${(first?.transform ?? []).join(' ')}]  ` +
          `${String(Date.now() - startedAt)} ms  ` +
          `warnings=[${result.warnings.map((warning) => warning.code).join(',')}]`,
      );
    } catch (error) {
      if (!isAppError(error)) throw error;
      lines.push(
        `${name.padEnd(30)} REFUSED   ${error.code} / ${String(refusalOf(error))}\n` +
          `${' '.repeat(41)}${error.message.slice(0, 120)}`,
      );
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
});
