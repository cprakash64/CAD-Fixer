import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE PRODUCTION BOUNDARY, asserted from source rather than from a build.
 *
 * Two things have to stay true and neither is visible in review:
 *
 *   1. NO GEOMETRY KERNEL REACHES PRODUCTION. Manifold, Geogram and PMP are
 *      research artifacts under `experiments/`. A single import from `apps/**`
 *      or `packages/**` would put a multi-megabyte `.wasm` in front of users,
 *      and the first anyone would notice is the download.
 *
 *   2. THE ENGINES STAY IN THE WORKER CHUNK. `apps/web/src/workers/**` is the
 *      only main-application code allowed to import the topology engine, the
 *      repair engine or the format codecs. Everywhere else in `apps/web/src`
 *      talks to `@cadfixer/geometry-runtime`, which restates the contract's
 *      constants rather than re-exporting them — see
 *      `packages/geometry-runtime/src/repair.ts`.
 *
 * CHECKED FROM SOURCE, not from `dist`, on purpose. A test that reads a build
 * output either has to run a build — making the unit suite depend on the
 * bundler — or silently pass when `dist` is absent, which is the worst of both.
 * The import graph is what actually decides the answer, and it is always there.
 */

const REPO_ROOT = join(import.meta.dirname, '..');

/** Packages whose code must never be reachable from the main-thread bundle. */
const WORKER_ONLY_PACKAGES: readonly string[] = [
  '@cadfixer/mesh-topology',
  '@cadfixer/mesh-repair',
];

/**
 * Codec entry points, which are a narrower rule than the package they live in.
 *
 * `@cadfixer/file-formats` IS a legitimate main-thread dependency: filename
 * screening and the declared capability list are exactly the parts the UI needs,
 * and they carry no parser. What must never cross is the CODEC surface — reading
 * and writing geometry — because codecs register inside the worker by design and
 * a main-thread import would pull a parser into the application bundle to do
 * nothing.
 */
const WORKER_ONLY_IMPORTS: readonly string[] = [
  'readStl',
  'requireWriter',
  'requireReader',
  'registerBuiltInFormats',
];

/** Kernels qualified by research and deliberately not shipped. */
const RESEARCH_KERNELS: readonly string[] = [
  'manifold-3d',
  'geogram',
  'pmp-library',
  'lib3mf',
  'openvdb',
  'cgal',
  'opencascade',
  'occt-import-js',
];

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
      if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
  };
  walk(directory);
  return found;
}

/** Files under `apps/web/src` that are NOT part of the worker entry point. */
function mainThreadFiles(): string[] {
  const root = join(REPO_ROOT, 'apps', 'web', 'src');
  const workerDirectory = `workers${sep}`;
  return sourceFilesUnder(root).filter((file) => {
    const rel = relative(root, file);
    if (rel.startsWith(workerDirectory)) return false;
    // Tests may name anything: they run under Node, never in the browser, and
    // excluding them keeps the rule about SHIPPED code rather than about which
    // modules a test is allowed to look at.
    return !/\.test\.(ts|tsx)$/.test(rel);
  });
}

describe('the geometry engines stay in the worker', () => {
  for (const packageName of WORKER_ONLY_PACKAGES) {
    it(`is not imported by main-thread code: ${packageName}`, () => {
      const offenders = mainThreadFiles()
        .filter((file) => readFileSync(file, 'utf8').includes(packageName))
        .map((file) => relative(REPO_ROOT, file));

      expect(
        offenders,
        `these main-thread files import ${packageName}, which would pull the engine into the ` +
          `application bundle. Go through @cadfixer/geometry-runtime instead.`,
      ).toEqual([]);
    });
  }

  it('keeps the format CODECS out of main-thread code', () => {
    const offenders: string[] = [];
    for (const file of mainThreadFiles()) {
      const contents = readFileSync(file, 'utf8');
      // Only imports count. The word appearing in a comment is not a dependency.
      const importBlocks = contents.match(/import[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
      for (const block of importBlocks) {
        if (!block.includes('@cadfixer/file-formats')) continue;
        for (const symbol of WORKER_ONLY_IMPORTS) {
          if (new RegExp(`\\b${symbol}\\b`).test(block)) {
            offenders.push(`${relative(REPO_ROOT, file)}: ${symbol}`);
          }
        }
      }
    }

    expect(offenders, 'a format codec became reachable from the application bundle').toEqual([]);
  });

  it('routes the repair contract through the runtime’s restatement', () => {
    // The positive half of the rule: the UI does name repair decisions, and it
    // gets them from the package that restates them without a runtime edge to
    // the engine.
    const presentation = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'state', 'repair-presentation.ts'),
      'utf8',
    );

    expect(presentation).toContain("from '@cadfixer/geometry-runtime'");
    expect(presentation).not.toContain('@cadfixer/mesh-repair');
  });
});

describe('no geometry kernel reaches production', () => {
  it('is not imported anywhere in the application or its packages', () => {
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ];

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      // An import OF the experiments tree, in any form a bundler would follow.
      if (/from\s+['"][^'"]*experiments\//.test(contents)) {
        offenders.push(`${relative(REPO_ROOT, file)} (imports from experiments/)`);
      }
      for (const kernel of RESEARCH_KERNELS) {
        if (new RegExp(`from\\s+['"]${kernel}`).test(contents)) {
          offenders.push(`${relative(REPO_ROOT, file)} (imports ${kernel})`);
        }
      }
    }

    expect(offenders, 'a geometry kernel became reachable from production code').toEqual([]);
  });

  it('is not declared as a dependency of any shipped package', () => {
    const manifests = [
      join(REPO_ROOT, 'package.json'),
      join(REPO_ROOT, 'apps', 'web', 'package.json'),
      ...readdirSync(join(REPO_ROOT, 'packages')).map((name) =>
        join(REPO_ROOT, 'packages', name, 'package.json'),
      ),
    ];

    for (const manifest of manifests) {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      const declared = parsed as { dependencies?: Record<string, string> };
      const names = Object.keys(declared.dependencies ?? {});

      for (const kernel of RESEARCH_KERNELS) {
        expect(names, `${relative(REPO_ROOT, manifest)} declares ${kernel}`).not.toContain(kernel);
      }
    }
  });
});

describe('no network API reaches production', () => {
  /**
   * The lint config bans these repo-wide, and this is the second, independent
   * check — a rule can be disabled in a config file, and the whole privacy
   * argument rests on this one property. See docs/PRIVACY_ARCHITECTURE.md.
   */
  const BANNED = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon'];

  it('appears nowhere in shipped application or package source', () => {
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const api of BANNED) {
        if (contents.includes(api)) offenders.push(`${relative(REPO_ROOT, file)}: ${api}`);
      }
    }

    expect(offenders, 'a network API reached shipped code').toEqual([]);
  });
});
