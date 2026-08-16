import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  CORPUS,
  box,
  diagnose,
  soup,
  summariseReport,
  toTransfer,
} from '@cadfixer/repair-evaluation';

/**
 * STAGE 3A-3B, STEP 1 OF 3 — prepare the browser cases.
 *
 * WHY THREE STEPS. The Playwright spec cannot import `@cadfixer/repair-evaluation`:
 * every production `e2e/` spec imports only local files, and breaking that
 * convention hung Playwright's loader indefinitely on the workspace package
 * graph. Rather than fight the loader, the work is split into the runtime each
 * part belongs in:
 *
 *   1. THIS FILE (vitest)      builds fixture geometry and the pre-diagnosis
 *   2. e2e-browser/*.spec.ts   drives Chromium, records raw candidate output
 *   3. browser-validate        runs Stage 2 on what the browser produced
 *
 * That separation is better than a workaround. Validation happens in a
 * different process from the one that drove the candidate, using CAD Fixer's
 * own oracle — a candidate cannot influence its own verdict even accidentally.
 *
 * NOT PART OF CI.
 */

const CASES = join(import.meta.dirname, '..', 'experiments', 'browser-harness', '.cases');
const KERNELS = join(import.meta.dirname, '..', 'experiments', 'repair-kernels');
const HARNESS_VERSION = 'stage-3a-3b.1';

const ARTIFACTS: Readonly<Record<string, string>> = {
  manifold: join(KERNELS, 'manifold', 'artifacts', 'manifold-candidate.wasm'),
  geogram: join(KERNELS, 'geogram', 'artifacts', 'geogram-candidate.wasm'),
  pmp: join(KERNELS, 'pmp', 'artifacts', 'pmp-candidate.wasm'),
};

function sha256Of(path: string): string {
  if (!existsSync(path)) return 'missing';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const UNIT = 10;

it('writes the browser case payloads and their pre-diagnosis', () => {
  mkdirSync(CASES, { recursive: true });

  const corpusHash = createHash('sha256');
  for (const fixture of CORPUS) {
    corpusHash.update(fixture.id);
    corpusHash.update(new Uint8Array(fixture.build().positions.buffer));
  }
  const corpusVersion = corpusHash.digest('hex').slice(0, 16);

  const meshes: Record<string, { positions: number[]; triangles: number[]; pre: unknown }> = {};

  const add = (name: string, mesh: ReturnType<typeof soup>): void => {
    const transfer = toTransfer(mesh);
    meshes[name] = {
      positions: [...transfer.positions],
      triangles: [...transfer.triangles],
      pre: summariseReport(diagnose(mesh)),
    };
  };

  // Corpus fixtures the browser matrix needs. The exam is NOT edited; these are
  // the frozen fixtures, transferred exactly as the Node harness transfers them.
  for (const id of ['R02', 'R08', 'R11', 'R16', 'R17', 'R19', 'R21', 'R28']) {
    const fixture = CORPUS.find((entry) => entry.id === id);
    if (fixture === undefined) throw new Error(`missing fixture ${id}`);
    add(id, fixture.build());
  }

  // Boolean operands — valid closed solids, matching the Stage 3A-3A Node suite
  // so browser and Node results are directly comparable.
  add('cubeA', soup(box([0, 0, 0], [UNIT, UNIT, UNIT])));
  add(
    'cubeOverlap',
    soup(box([UNIT / 2, UNIT / 2, UNIT / 2], [UNIT * 1.5, UNIT * 1.5, UNIT * 1.5])),
  );
  add('cubeFar', soup(box([UNIT * 10, 0, 0], [UNIT * 11, UNIT, UNIT])));
  add('cubeNearCoplanar', soup(box([UNIT - 1e-6, 0, 0], [UNIT * 2, UNIT, UNIT])));
  add('cubeFarOriginA', soup(box([1e6, 1e6, 1e6], [1e6 + UNIT, 1e6 + UNIT, 1e6 + UNIT])));
  add(
    'cubeFarOriginB',
    soup(
      box(
        [1e6 + UNIT / 2, 1e6 + UNIT / 2, 1e6 + UNIT / 2],
        [1e6 + UNIT * 1.5, 1e6 + UNIT * 1.5, 1e6 + UNIT * 1.5],
      ),
    ),
  );
  add('cubeTinyA', soup(box([0, 0, 0], [1e-4, 1e-4, 1e-4])));
  add('cubeTinyB', soup(box([5e-5, 5e-5, 5e-5], [1.5e-4, 1.5e-4, 1.5e-4])));

  // R16's two shells, separated. Decomposition is a precondition of the union,
  // not a capability of the kernel — Stage 3A-3A established that distinction.
  add('r16ShellA', soup(box([0, 0, 0], [UNIT, UNIT, UNIT])));
  add('r16ShellB', soup(box([UNIT / 2, UNIT / 2, UNIT / 2], [UNIT * 1.5, UNIT * 1.5, UNIT * 1.5])));

  writeFileSync(
    join(CASES, 'cases.json'),
    JSON.stringify({
      harnessVersion: HARNESS_VERSION,
      corpusVersion,
      artifactShas: Object.fromEntries(
        Object.entries(ARTIFACTS).map(([id, path]) => [id, sha256Of(path)]),
      ),
      meshes,
    }),
  );

  process.stdout.write(
    `\nbrowser cases prepared: ${String(Object.keys(meshes).length)} meshes, corpus ${corpusVersion}\n`,
  );
}, 300_000);
