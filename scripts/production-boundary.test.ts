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

  it('keeps the end-to-end harness out of the application', () => {
    /*
     * THE HARNESS IS NOT A BACKDOOR, and this is what makes that checkable.
     *
     * `apps/web/e2e-harness/` builds a synthetic multi-part document so the
     * browser suite can test what no shipped codec can produce. It is a
     * separate Vite root with a separate entry, so the application build has no
     * path to it — but "no path" is a property of an import graph, and an
     * import graph is exactly the kind of thing that acquires an edge by
     * accident. One import from `apps/web/src` would put a synthetic-document
     * importer in front of every user.
     */
    const offenders = [...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src'))]
      .filter((file) => readFileSync(file, 'utf8').includes('e2e-harness'))
      .map((file) => relative(REPO_ROOT, file));

    expect(
      offenders,
      'application source must not reference the end-to-end harness in any form',
    ).toEqual([]);
  });

  it('builds the application from exactly one entry, which is not the harness', () => {
    // The structural half of the same guarantee. A second `input` in the
    // application's Vite config would emit the harness into `dist/` for every
    // deployment, whatever the import graph said.
    const appConfig = readFileSync(join(REPO_ROOT, 'apps', 'web', 'vite.config.ts'), 'utf8');

    expect(appConfig).not.toContain('e2e-harness');
    expect(appConfig).not.toContain('rollupOptions');
    expect(appConfig).not.toContain('rolldownOptions');

    // And the harness config inverts the root, so it cannot emit into the
    // application's output directory either.
    const harnessConfig = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'vite.harness.config.ts'),
      'utf8',
    );
    expect(harnessConfig).toContain("root: 'e2e-harness'");
    expect(harnessConfig).toContain("outDir: '../dist-e2e-harness'");
  });

  it('never injects a worker in the production entry point', () => {
    /*
     * `GeometryClientOptions.createWorker` exists so the harness can drive a
     * worker whose importer builds a synthetic document. It chooses a SCRIPT and
     * cannot inject geometry — but the production ENTRY POINT must still not
     * pass one, or the application would be running something other than the
     * geometry worker.
     *
     * The same seam already existed for the diagnostic worker
     * (`SelfIntersectionService`), which is why the allowed list has two entries
     * rather than one: both are worker-factory declarations, and neither is a
     * call site outside its own module.
     */
    const entry = readFileSync(join(REPO_ROOT, 'apps', 'web', 'src', 'main.tsx'), 'utf8');
    expect(entry).not.toContain('createWorker');

    const injectors = mainThreadFiles()
      .filter((file) => readFileSync(file, 'utf8').includes('createWorker'))
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    expect(injectors).toEqual(
      [
        join('apps', 'web', 'src', 'runtime', 'geometry-client.ts'),
        join('apps', 'web', 'src', 'runtime', 'self-intersection-service.ts'),
      ].sort(),
    );
  });

  it('exposes no document-injection global or query parameter in the application', () => {
    // The shapes a reviewer would look for first: a window global, a URL switch,
    // or a debug hook that reaches authoritative geometry.
    const BANNED = [
      '__CADFIXER',
      'cadfixerHarness',
      'window.cadfixer',
      'globalThis.cadfixer',
      "searchParams.get('document",
      "searchParams.get('fixture",
    ];
    const offenders: string[] = [];

    for (const file of [...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src'))].filter(
      (file) => !/\.test\.(ts|tsx)$/.test(file),
    )) {
      const contents = readFileSync(file, 'utf8');
      for (const banned of BANNED) {
        if (contents.includes(banned)) offenders.push(`${relative(REPO_ROOT, file)}: ${banned}`);
      }
    }

    expect(offenders, 'the application must expose no route to inject a document').toEqual([]);
  });

  it('keeps AUTHORITATIVE geometry types out of main-thread code', () => {
    /*
     * STAGE 4A-2A. The main thread holds a `DocumentHandle`, scalar part
     * descriptors and disposable render snapshots. It must never hold — or even
     * be able to name — the authoritative types, because a component that can
     * name a `CanonicalMesh` is one refactor away from storing one, and React
     * state holding a multi-hundred-megabyte document is exactly the ownership
     * inversion ADR 0008 exists to prevent.
     *
     * Names in COMMENTS are fine and deliberate: several files explain what they
     * are NOT holding. Only imports count.
     */
    const AUTHORITATIVE = ['CanonicalMesh', 'GeometryDocument', 'GeometryPart'];
    const offenders: string[] = [];

    for (const file of mainThreadFiles()) {
      const contents = readFileSync(file, 'utf8');
      const importBlocks = contents.match(/import[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
      for (const block of importBlocks) {
        for (const symbol of AUTHORITATIVE) {
          if (new RegExp(`\\b${symbol}\\b`).test(block)) {
            offenders.push(`${relative(REPO_ROOT, file)}: ${symbol}`);
          }
        }
      }
    }

    expect(
      offenders,
      'the main thread must name handles and descriptors, never authoritative geometry',
    ).toEqual([]);
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

describe('the self-intersection kernel is confined to its own worker', () => {
  /*
   * WHAT CHANGED IN STAGE 3C-1B, and why this section had to be rewritten.
   *
   * Geogram now SHIPS. It is compiled into the WebAssembly kernel that backs the
   * read-only self-intersection diagnostic, and pretending otherwise would make
   * this file assert a fiction. What still holds — and what these tests now
   * check — is the boundary: the kernel is reachable ONLY from the disposable
   * diagnostic worker, so a user who never runs a check never downloads it and
   * the main-thread bundle never contains it.
   *
   * The kernel is NOT in RESEARCH_KERNELS. Those are the packages qualified and
   * deliberately not shipped; this one was qualified and deliberately IS.
   */
  const KERNEL_PACKAGE = '@cadfixer/self-intersection-kernel';
  const DIAGNOSTIC_WORKER = join('apps', 'web', 'src', 'workers', 'self-intersection.worker.ts');

  it('is imported by exactly one file, the diagnostic worker', () => {
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ];
    const importers = files
      .filter((file) =>
        new RegExp(`from\\s+['"]${KERNEL_PACKAGE}`).test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(REPO_ROOT, file));

    expect(importers, 'the WASM kernel must be reachable from the diagnostic worker only').toEqual([
      DIAGNOSTIC_WORKER,
    ]);
  });

  it('is never imported by main-thread code', () => {
    const offenders = mainThreadFiles()
      .filter((file) => readFileSync(file, 'utf8').includes(KERNEL_PACKAGE))
      .map((file) => relative(REPO_ROOT, file));

    expect(
      offenders,
      'importing the kernel from the main thread would pull ~1.2 MB of WebAssembly into the ' +
        'application bundle for every user, including those who never run the check',
    ).toEqual([]);
  });

  it('keeps the diagnostic CONTRACT free of the kernel', () => {
    // The contract package carries policy, caps and taxonomy so the application
    // can reason about the diagnostic without loading a geometry kernel to do it.
    const contract = sourceFilesUnder(join(REPO_ROOT, 'packages', 'mesh-self-intersection'));
    for (const file of contract) {
      expect(
        readFileSync(file, 'utf8').includes(KERNEL_PACKAGE),
        `${relative(REPO_ROOT, file)} must not reach for the kernel`,
      ).toBe(false);
    }
  });
});

describe('no UNSHIPPED geometry kernel reaches production', () => {
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
