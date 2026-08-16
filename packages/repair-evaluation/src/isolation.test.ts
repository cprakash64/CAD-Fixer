import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE ISOLATION GUARD.
 *
 * This package must never be reachable from the application. If a future change
 * imports the corpus or the harness from `apps/**`, the evaluation code — and
 * eventually a geometry kernel behind it — enters the production bundle, and the
 * first anyone would notice is a several-megabyte `.wasm` shipped to users.
 *
 * Asserted here rather than left to review, because it is exactly the kind of
 * import someone adds for a good local reason.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const PACKAGE_NAME = '@cadfixer/repair-evaluation';

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx|js|mjs)$/.test(entry)) found.push(full);
    }
  };
  walk(directory);
  return found;
}

describe('production isolation', () => {
  it('is not imported anywhere in the application', () => {
    const offenders = sourceFilesUnder(join(REPO_ROOT, 'apps')).filter((file) =>
      readFileSync(file, 'utf8').includes(PACKAGE_NAME),
    );

    expect(offenders, `these application files import ${PACKAGE_NAME}`).toEqual([]);
  });

  it('is not imported by any production package', () => {
    const packagesRoot = join(REPO_ROOT, 'packages');
    const offenders = readdirSync(packagesRoot)
      .filter((name) => name !== 'repair-evaluation')
      .flatMap((name) => {
        const source = join(packagesRoot, name, 'src');
        try {
          return sourceFilesUnder(source);
        } catch {
          // A package without a src directory is not an offender; the missing
          // directory is the answer, not an error worth failing on.
          return [];
        }
      })
      .filter((file) => readFileSync(file, 'utf8').includes(PACKAGE_NAME));

    expect(offenders, `these package files import ${PACKAGE_NAME}`).toEqual([]);
  });

  it('is not declared as a dependency of the web application', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, 'apps', 'web', 'package.json'), 'utf8'),
    );
    const declared = manifest as { dependencies?: Record<string, string> };

    expect(Object.keys(declared.dependencies ?? {})).not.toContain(PACKAGE_NAME);
  });

  it('declares no third-party dependency of its own', () => {
    // Stage 3A-1 installs no kernel. When Stage 3A-2 adds one it belongs here,
    // in a research package, and this test is where that change becomes visible.
    const manifest: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    );
    const declared = manifest as { dependencies?: Record<string, string> };
    const external = Object.keys(declared.dependencies ?? {}).filter(
      (name) => !name.startsWith('@cadfixer/'),
    );

    expect(external, 'no geometry kernel is installed in Stage 3A-1').toEqual([]);
  });
});
