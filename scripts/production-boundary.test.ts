import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  /*
   * STAGE 4B-1B1. The hole-fill engine carries the triangulator, the
   * broadphase, every validator and — through `mesh-topology` — the whole
   * topology engine. The application names a fill STATUS and a summary, both of
   * which `geometry-runtime` restates without a runtime edge; see
   * `packages/geometry-runtime/src/hole-fill.ts`.
   */
  '@cadfixer/mesh-hole-fill',
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
  /*
   * STAGE 4A-2B1. Three more parsers now live behind the same boundary, and
   * each is a different way to pull whole-file work into the application
   * bundle: `readObj` is a character scan, `read3mf` inflates an archive and
   * scans XML, and `identifyFormat` reads the head of the bytes. The main
   * thread never does any of it — it hands the file to the worker and receives
   * scalars back.
   */
  'readObj',
  'read3mf',
  'identifyFormat',
  'readZipDirectory',
  'readZipEntry',
  'scanXml',
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

  it('keeps the TEST-ONLY fixture and context modules out of production code', () => {
    /*
     * `file-formats` ships three modules that exist only for tests: the STL
     * fixture builders, the hand-authored ZIP/3MF archives, and the read
     * context that supplies `TextDecoder` and `DecompressionStream`. The
     * archives are deliberately EXPORTED from the package so the worker and
     * application suites exercise the same corpus the reader package does —
     * which is exactly why this check has to exist: an export is reachable, and
     * a production file that reached for one would ship a corpus of hostile
     * archives inside the application bundle.
     */
    const TEST_ONLY = [
      '@cadfixer/file-formats/threemf-fixtures',
      'threemf/zip-fixtures',
      'stl/fixtures',
      'file-formats/src/test-context',
      './test-context',
      '../test-context',
    ];
    const offenders: string[] = [];

    const productionFiles = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
      // Tests may import fixtures; so, obviously, may the fixture and
      // test-context modules themselves.
    ].filter(
      (file) =>
        !/\.(test|bench-suite)\.(ts|tsx)$/.test(file) &&
        !file.endsWith('fixtures.ts') &&
        !file.endsWith('test-context.ts'),
    );

    for (const file of productionFiles) {
      const contents = readFileSync(file, 'utf8');
      const importBlocks = contents.match(/(?:import|export)[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
      for (const block of importBlocks) {
        for (const specifier of TEST_ONLY) {
          if (block.includes(specifier))
            offenders.push(`${relative(REPO_ROOT, file)}: ${specifier}`);
        }
      }
    }

    expect(offenders, 'a test-only fixture module became reachable from production').toEqual([]);
  });

  it('keeps the WRITER ORACLES out of production code', () => {
    /*
     * `obj-oracle.ts`, `threemf-oracle.ts` and `stl-oracle.ts` are structural
     * checkers that share
     * no code with the production readers ON PURPOSE: parse-back validation runs
     * our reader over our writer, which proves the two agree and nothing more,
     * so the oracles exist to catch a shared misunderstanding. Production
     * importing one would make them a second parser — the exact thing they must
     * not become.
     */
    const ORACLES = ['obj-oracle', 'threemf-oracle', 'stl-oracle'];
    const offenders: string[] = [];
    const productionFiles = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.(test|bench-suite)\.(ts|tsx)$/.test(file));

    for (const file of productionFiles) {
      const contents = readFileSync(file, 'utf8');
      const importBlocks = contents.match(/(?:import|export)[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
      for (const block of importBlocks) {
        for (const oracle of ORACLES) {
          if (block.includes(oracle)) offenders.push(`${relative(REPO_ROOT, file)}: ${oracle}`);
        }
      }
    }

    expect(offenders, 'a test oracle became reachable from production').toEqual([]);
  });

  it('keeps the document WRITERS out of the main-thread bundle', () => {
    /*
     * STAGE 4A-2B3 CHANGED WHAT THIS PROTECTS, and deliberately did not delete
     * it.
     *
     * Until B3 the rule was that NOTHING in the application could reach the
     * export engine, because the engine existed and the workflow did not. The
     * workflow now exists, so that rule is gone — `use-document-conversion.ts`
     * reaches `DocumentExportService` on purpose, which is the feature.
     *
     * What survives is the rule that actually matters for the shipped product:
     * the SERIALISERS stay behind the worker boundary. `writeObjDocument`,
     * `write3mfDocument`, `writeStlDocument`, `exportDocument` and the ZIP
     * writer are tens of kilobytes of code that only ever runs off-thread, and
     * a main-thread import of any of them would pull all of it into the initial
     * bundle — paid for by every user who opens the page and never exports
     * anything. It would also be main-thread geometry work waiting to happen.
     */
    /*
     * THE READERS ARE ON THIS LIST TOO, and for the same reason. Import runs in
     * the authoritative worker; a main-thread import of `readStl` or `read3mf`
     * would pull the XML scanner, the ZIP reader and the STL detector into the
     * initial bundle. It has happened once already: the conversion policy
     * reached into the STL writer for `84 + n * 50` and arrived carrying
     * `stl/detect.ts`'s ASCII keyword tables, which are built at module scope
     * and therefore survive tree-shaking. The numbers now live in leaf modules
     * (`export/stl-layout.ts`, `threemf/units.ts`) that import nothing.
     */
    const WORKER_ONLY = [
      'writeObjDocument',
      'write3mfDocument',
      'writeStlDocument',
      'exportDocument',
      'buildZipArchive',
      'writeBinaryStl',
      'writeAsciiStl',
      'readStl',
      'readObj',
      'read3mf',
      'detectStlEncoding',
      'readZipDirectory',
      'readZipEntry',
      'scanXml',
      'parseModelXml',
    ];

    const offenders = mainThreadFiles()
      .filter((file) => {
        const contents = readFileSync(file, 'utf8');
        const blocks = contents.match(/import[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
        return blocks.some(
          (block) =>
            block.includes('@cadfixer/file-formats') &&
            WORKER_ONLY.some((name) => new RegExp(`\\b${name}\\b`).test(block)),
        );
      })
      .map((file) => relative(REPO_ROOT, file));

    expect(offenders, 'a codec became reachable from the application bundle').toEqual([]);
  });

  it('keeps the size and unit constants in leaf modules with no imports', () => {
    /*
     * THE MECHANISM THAT MAKES THE RULE ABOVE KEEPABLE.
     *
     * The main thread genuinely needs two things from the format layer: how big
     * a binary STL of N triangles is, and which unit tokens 3MF allows. Both are
     * arithmetic and constants. They live in modules that import NOTHING, so a
     * main-thread import of either cannot drag a codec along with it — and a
     * future import added to one of them would fail here rather than silently
     * adding kilobytes to every page load.
     */
    for (const leaf of [
      join(REPO_ROOT, 'packages', 'file-formats', 'src', 'export', 'stl-layout.ts'),
      join(REPO_ROOT, 'packages', 'file-formats', 'src', 'threemf', 'units.ts'),
    ]) {
      const contents = readFileSync(leaf, 'utf8');
      const imports = contents.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]/gm) ?? [];
      expect(imports, `${relative(REPO_ROOT, leaf)} must import nothing`).toEqual([]);
    }
  });

  it('constructs the export worker from exactly one place', () => {
    /*
     * ONE OWNER OF THE DISPOSABLE WORKER.
     *
     * `DocumentExportService` cancels by TERMINATING its worker, which is only
     * safe while it is the only thing that made one. A component that built its
     * own `export.worker.ts` would be a second lifecycle: two exports racing for
     * the same ceilings, and a Cancel that killed one of them.
     */
    const files = sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')).filter(
      (file) => !/\.test\.(ts|tsx)$/.test(file),
    );

    const constructors = files
      .filter((file) => /new Worker\([\s\S]*?export\.worker/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));

    expect(constructors).toEqual([
      join('apps', 'web', 'src', 'runtime', 'document-export-service.ts'),
    ]);
  });

  it('keeps the 3MF expansion counters out of production code', () => {
    /*
     * `ThreeMfExpansionStats` exists so a test can prove that an over-large
     * expansion stops at the ceiling instead of running to completion. It is
     * instrumentation, and instrumentation that production passes is a debug
     * channel: it would mean the shipped reader writes counters nobody reads,
     * on a path taken by every import.
     */
    const offenders: string[] = [];
    const productionFiles = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter(
      (file) =>
        !/\.(test|bench-suite)\.(ts|tsx)$/.test(file) &&
        !file.endsWith(join('threemf', 'threemf-reader.ts')),
    );

    for (const file of productionFiles) {
      const contents = readFileSync(file, 'utf8');
      // The type name is the exact marker: naming it is the only way to pass
      // one, and `stats:` alone matches unrelated fields elsewhere.
      if (/\bThreeMfExpansionStats\b/.test(contents)) offenders.push(relative(REPO_ROOT, file));
    }

    expect(offenders, 'expansion counters must stay test-only').toEqual([]);
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
     * (`SelfIntersectionService`) and, since Stage 4A-2B2, for the export worker
     * (`DocumentExportService`). All three are worker-factory DECLARATIONS, each
     * inside its own module, and none is a call site anywhere else. The list is
     * exact rather than a maximum so that a fourth one has to be argued for.
     */
    const entry = readFileSync(join(REPO_ROOT, 'apps', 'web', 'src', 'main.tsx'), 'utf8');
    expect(entry).not.toContain('createWorker');

    const injectors = mainThreadFiles()
      .filter((file) => readFileSync(file, 'utf8').includes('createWorker'))
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    expect(injectors).toEqual(
      [
        join('apps', 'web', 'src', 'runtime', 'document-export-service.ts'),
        join('apps', 'web', 'src', 'runtime', 'geometry-client.ts'),
        join('apps', 'web', 'src', 'runtime', 'hole-fill-service.ts'),
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
  const HOLE_FILL_NARROWPHASE = join('apps', 'web', 'src', 'workers', 'hole-fill-narrowphase.ts');

  it('is imported by exactly the files named here, all of them worker code', () => {
    /*
     * THE LIST IS EXACT RATHER THAN A MAXIMUM, so a fourth importer has to be
     * argued for in review instead of appearing quietly.
     *
     * STAGE 4B-1B1 added two entries. `hole-fill-narrowphase.ts` wraps the
     * kernel as the fill engine's exact predicate and is imported only by the
     * disposable fill worker; its `.node.test.ts` runs the HP corpus against
     * that predicate and never ships. Both are under `apps/web/src/workers/`,
     * which the main-thread scan below excludes wholesale.
     */
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ];
    const importers = files
      .filter((file) =>
        new RegExp(`from\\s+['"]${KERNEL_PACKAGE}`).test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    expect(importers, 'the WASM kernel must be reachable from worker code only').toEqual(
      [
        DIAGNOSTIC_WORKER,
        HOLE_FILL_NARROWPHASE,
        join('apps', 'web', 'src', 'workers', 'node-tests', 'hole-fill-kernel.test.ts'),
        /*
         * STAGE 4B-1B1-R1. The rebuilt artifact is compared, fixture by
         * fixture, against the pre-B1B1 one extracted from git — so this test
         * instantiates the CURRENT kernel beside the historical one. It never
         * ships.
         */
        join('apps', 'web', 'src', 'workers', 'node-tests', 'kernel-differential.test.ts'),
      ].sort(),
    );
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
      /*
       * AN IMPORT OF THE EXPERIMENTS TREE, in any form a bundler would follow.
       *
       * TESTS ARE EXEMPT, and deliberately so. Stage 4A-2B1's differential
       * suite runs the same bytes through the production parsers and through
       * the qualified research readers and compares the results — which is the
       * whole point: a parser that is its own oracle proves only that it is
       * self-consistent. A `.test.ts` never ships, so importing a reference
       * implementation into one puts nothing in front of a user.
       *
       * The ban stays absolute for everything else, including test HELPERS that
       * are not themselves tests, because those can be imported by anything.
       */
      const isTest = /\.test\.(ts|tsx)$/.test(file);
      if (!isTest && /from\s+['"][^'"]*experiments\//.test(contents)) {
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

  it('lets ONLY tests reach the research tree, and names the ones that do', () => {
    /*
     * The exemption above is narrow, and this is what keeps it narrow: the list
     * of files allowed to import a research reference is written down, so
     * adding another is a deliberate act that shows up in review rather than a
     * quiet widening of the rule.
     */
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ];

    const importers = files
      .filter((file) => /from\s+['"][^'"]*experiments\//.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    expect(importers).toEqual(
      [
        join('packages', 'file-formats', 'src', 'format-differential.test.ts'),
        /*
         * STAGE 4B-1B1-R1. The Stage 3C kernel differential runs the FROZEN
         * research corpus — the 24 hand-authored adversarial fixtures and the
         * three regenerated shells — through the old and new artifacts. Reusing
         * the frozen corpus is the point: a differential over a corpus invented
         * for the occasion would prove the rebuild agrees with itself on cases
         * chosen after the fact.
         */
        join('apps', 'web', 'src', 'workers', 'node-tests', 'kernel-differential.test.ts'),
      ].sort(),
    );
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

describe('the hole-fill engine stays where Stage 4B-1B1 put it', () => {
  /*
   * WHAT THIS SECTION PROTECTS, and why each rule is separate.
   *
   * The engine is production, the workflow is not. Stage 4B-1B1 ships an engine
   * behind the worker boundary with NO user-facing control; Stage 4B-1B2 will
   * add selection, preview and Apply. Until it does, an accidental import from
   * a component would put a half-finished feature in front of users, and an
   * accidental import from `experiments/` would put research code in the
   * bundle.
   */
  const HOLE_FILL_ENGINE = '@cadfixer/mesh-hole-fill';

  it('is imported only by worker code and by the runtime restatement', () => {
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const importers = files
      .filter((file) =>
        new RegExp(`from\\s+['"]${HOLE_FILL_ENGINE}`).test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    expect(importers).toEqual(
      [
        join('apps', 'web', 'src', 'workers', 'hole-fill.worker.ts'),
        join('apps', 'web', 'src', 'workers', 'hole-fill-narrowphase.ts'),
        join('packages', 'geometry-runtime', 'src', 'hole-fill.ts'),
        /*
         * THE HARNESS, and it is named rather than excluded so its access is
         * visible in review. It imports the TEST-ONLY fixture corpus in order to
         * build documents the shipped importers cannot — a 512-vertex rim, and
         * the HP23 configuration whose patch pierces a wall — and it is not an
         * input to the application build, which the checks above assert.
         */
        join('apps', 'web', 'e2e-harness', 'fixtures.ts'),
      ].sort(),
    );
  });

  it('ships NO narrowphase of its own', () => {
    /*
     * The engine takes its exact predicate as a parameter. A local
     * implementation inside the package would be a second, weaker predicate
     * shipped beside the qualified one — and `fixtures.ts` deliberately holds a
     * separating-axis checker for tests, which must never become reachable from
     * production.
     */
    const production = sourceFilesUnder(join(REPO_ROOT, 'packages', 'mesh-hole-fill')).filter(
      (file) => !file.endsWith('.test.ts') && !file.endsWith('fixtures.ts'),
    );
    for (const file of production) {
      const contents = readFileSync(file, 'utf8');
      expect(
        contents.includes('trianglesIntersect'),
        `${relative(REPO_ROOT, file)} must not carry a triangle intersection predicate`,
      ).toBe(false);
      expect(contents.includes('referenceNarrowphase')).toBe(false);
    }
  });

  /*
   * STAGE 4B-1B2 REPLACED THE "NO CONTROL" ASSERTION.
   *
   * Stage 4B-1B1 asserted that no Fill control existed anywhere, because the
   * engine shipped without a workflow and "we will wire it up later" had to be
   * kept from becoming "it is already wired up". That stage is closed and the
   * workflow now exists, so the old assertion describes behaviour that has
   * legitimately changed. It is REPLACED rather than deleted: the checks below
   * assert precisely what the workflow may and may not offer, which is a
   * stronger statement than the absence it replaces.
   */
  it('offers exactly ONE fill control, and it is not a batch one', () => {
    /*
     * FILL-ALL IS STILL FORBIDDEN, and always will be without an explicit
     * decision: it would close every opening in a model, including the
     * intentional ones, from a single click. So is any wording that promises to
     * fill more than the one opening the user selected.
     */
    const BANNED = ['Fill All', 'fill all', 'Fill Holes', 'fill every', 'Close All'];
    const componentFiles = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src', 'components')),
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src', 'state')),
    ];

    const offenders: string[] = [];
    for (const file of componentFiles) {
      const contents = readFileSync(file, 'utf8');
      for (const banned of BANNED) {
        if (contents.includes(banned)) offenders.push(`${relative(REPO_ROOT, file)}: ${banned}`);
      }
    }
    expect(offenders, 'batch filling is out of scope and must stay out').toEqual([]);
  });

  it('commits a hole-fill candidate from exactly ONE place', () => {
    /*
     * THE STAGE 4B-1B2 COUNTERPART of the registration check below. `Apply` is
     * the only path by which proposed geometry becomes the user's model, and it
     * goes through `HoleFillCandidateStore.prepareCommit` — which applies every
     * identity, lifecycle and staleness guard — followed by
     * `residentDocuments.replace`. A second commit path would be a second set of
     * rules, and the two would eventually disagree.
     */
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const callers = files
      .filter((file) => readFileSync(file, 'utf8').includes('holeFillCandidates.prepareCommit('))
      .map((file) => relative(REPO_ROOT, file));

    expect(callers).toEqual([
      join('apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
    ]);

    const handlers = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
      'utf8',
    );
    // And the guard runs BEFORE the swap. An ordering inversion would let a
    // stale or consumed candidate replace a part and only then be refused.
    const guard = handlers.indexOf('holeFillCandidates.prepareCommit(');
    const swap = handlers.indexOf('residentDocuments.replace(');
    expect(guard).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(guard);
  });

  it('builds every fallible answer BEFORE the authoritative swap', () => {
    /*
     * THE TRANSACTION ORDERING, asserted structurally — Stage 4B-1B2-R2.
     *
     * `residentDocuments.replace` is the atomic step: before it the user has the
     * old document, after it the new one. Everything that CAN FAIL has to happen
     * before it, because a failure afterwards would be reported to the caller as
     * an ordinary error while the document had already changed — telling a user
     * their fill failed when it succeeded, which the interface then acts on.
     *
     * `buildRenderSnapshot` allocates megabytes for a large part, `describeParts`
     * allocates a descriptor per part, and `reportProgress` posts on a channel
     * that can be gone. All three now precede the swap. What follows it is a
     * string concatenation, two bounded map writes and an object literal.
     *
     * Source order is asserted here and the BEHAVIOUR is exercised in
     * `hole-fill-atomicity.test.ts`, which injects a failing snapshot builder
     * through a construction seam. Neither alone is enough: order does not prove
     * the handler copes with a failure, and a passing failure test would not
     * notice a future statement quietly added below the swap.
     */
    const commit = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
      'utf8',
    );
    const commitBody = commit.slice(commit.indexOf('createHoleFillCommitHandler'));
    const snapshot = commitBody.indexOf('work.buildRenderSnapshot(');
    const describe_ = commitBody.indexOf('work.describeParts(');
    const progress = commitBody.indexOf('context.reportProgress(');
    const swap = commitBody.indexOf('residentDocuments.replace(');
    const consume = commitBody.indexOf('holeFillCandidates.markCommitted(');
    const record = commitBody.indexOf('repairHistory.record(');
    for (const [name, at] of [
      ['buildRenderSnapshot', snapshot],
      ['describeParts', describe_],
      ['reportProgress', progress],
      ['replace', swap],
      ['markCommitted', consume],
      ['record', record],
    ] as const) {
      expect(at, `${name} is missing from holefill/commit`).toBeGreaterThan(-1);
    }
    expect(snapshot).toBeLessThan(swap);
    expect(describe_).toBeLessThan(swap);
    expect(progress).toBeLessThan(swap);
    expect(consume).toBeGreaterThan(swap);
    expect(record).toBeGreaterThan(consume);

    /*
     * AND NOTHING ALLOCATING SURVIVES BELOW THE SWAP. Named rather than
     * inferred: these are the calls that would reintroduce the defect, and a
     * substring scan of the committed region is what catches one being added
     * back without anybody thinking about the ordering.
     */
    /*
     * BOUNDED AT THE END OF THE HANDLER, not at the end of the file. The
     * successor-document helper is defined below the factory and legitimately
     * calls `assertGeometryDocument`; scanning past the handler would flag it
     * for running "after the swap" when it runs before, from inside the
     * preparation.
     */
    const commitEnd = commitBody.indexOf('export const holeFillCommitHandler =');
    expect(commitEnd).toBeGreaterThan(swap);
    const committedRegion = commitBody.slice(swap, commitEnd);
    for (const banned of [
      'buildRenderSnapshot',
      'describeParts',
      'reportProgress',
      'computeBounds',
      'documentByteLength',
      'assertMeshStructure',
      'assertGeometryDocument',
    ]) {
      expect(
        committedRegion.includes(banned),
        `${banned} runs after the authoritative swap in holefill/commit`,
      ).toBe(false);
    }
  });

  it('CRT13: repair/commit builds every fallible answer BEFORE the authoritative swap', () => {
    /*
     * THE SAME PROTECTION HOLE FILLING GOT IN STAGE 4B-1B2-R2, extended to
     * conservative repair in Stage 4B-1C. `buildRenderSnapshot` allocates and
     * can fail; running it after `replace` meant a failure was reported to the
     * caller as an ordinary error while the document had already changed.
     */
    const commit = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'repair-handlers.ts'),
      'utf8',
    );
    const body = commit.slice(commit.indexOf('createRepairCommitHandler'));
    const snapshot = body.indexOf('work.buildRenderSnapshot(');
    const describe_ = body.indexOf('work.describeParts(');
    const progress = body.indexOf('context.reportProgress(');
    const swap = body.indexOf('residentDocuments.replace(');
    const consume = body.indexOf('repairCandidates.markCommitted(');
    const record = body.indexOf('repairHistory.record(');
    for (const [name, at] of [
      ['buildRenderSnapshot', snapshot],
      ['describeParts', describe_],
      ['reportProgress', progress],
      ['replace', swap],
      ['markCommitted', consume],
      ['record', record],
    ] as const) {
      expect(at, `${name} is missing from repair/commit`).toBeGreaterThan(-1);
    }
    expect(snapshot).toBeLessThan(swap);
    expect(describe_).toBeLessThan(swap);
    expect(progress).toBeLessThan(swap);
    expect(consume).toBeGreaterThan(swap);
    expect(record).toBeGreaterThan(consume);

    const end = body.indexOf('export const repairCommitHandler =');
    expect(end).toBeGreaterThan(swap);
    const committedRegion = body.slice(swap, end);
    for (const banned of [
      'buildRenderSnapshot',
      'describeParts',
      'reportProgress',
      'computeBounds',
      'documentByteLength',
      'assertMeshStructure',
      'assertGeometryDocument',
    ]) {
      expect(
        committedRegion.includes(banned),
        `${banned} runs after the authoritative swap in repair/commit`,
      ).toBe(false);
    }
  });

  it('reconstructs undo from a RETAINED MESH, never from a patch', () => {
    /*
     * STAGE 4B-1C. Repair's undo rebuilt the pre-repair mesh from a patch of
     * removed triangles, which returned an indexed OBJ or 3MF as triangle soup
     * and turned one shared mesh into two byte-equal ones. The patch is gone —
     * along with the module that defined it — so there is ONE reconstruction and
     * the two kinds of change cannot drift apart.
     */
    /*
     * SHIPPED SOURCE ONLY. Tests may still NAME the removed functions — the
     * repair suite explains what they did and why they went, which is the record
     * of the defect and is worth keeping readable.
     */
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
      ...sourceFilesUnder(join(REPO_ROOT, 'scripts')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const banned of ['restoreFromInverse', 'buildInversePatch', 'RepairInversePatch']) {
        if (contents.includes(banned)) offenders.push(`${relative(REPO_ROOT, file)}: ${banned}`);
      }
    }
    expect(offenders, 'undo reconstruction from a patch must stay removed').toEqual([]);

    // And the module that defined them is gone, not merely unreferenced.
    expect(existsSync(join(REPO_ROOT, 'packages', 'mesh-repair', 'src', 'inverse.ts'))).toBe(false);
  });

  it('builds every fallible answer BEFORE the authoritative swap, in undo too', () => {
    const undo = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'repair-handlers.ts'),
      'utf8',
    );
    const undoBody = undo.slice(undo.indexOf('createRepairUndoHandler'));
    const snapshot = undoBody.indexOf('work.buildRenderSnapshot(');
    const describe_ = undoBody.indexOf('work.describeParts(');
    const swap = undoBody.indexOf('residentDocuments.replace(');
    const mark = undoBody.indexOf('repairHistory.markUndone(');
    const release = undoBody.indexOf('holeFillCandidates.releaseDocument(');
    expect(snapshot).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(swap);
    expect(describe_).toBeLessThan(swap);
    expect(mark).toBeGreaterThan(swap);
    expect(release).toBeGreaterThan(mark);

    const undoEnd = undoBody.indexOf('export const repairUndoHandler =');
    expect(undoEnd).toBeGreaterThan(swap);
    const committedRegion = undoBody.slice(swap, undoEnd);
    for (const banned of [
      'buildRenderSnapshot',
      'describeParts',
      'reportProgress',
      'computeBounds',
      'restoreFromInverse',
      'assertMeshStructure',
    ]) {
      expect(
        committedRegion.includes(banned),
        `${banned} runs after the authoritative swap in repair/undo`,
      ).toBe(false);
    }
  });

  it('registers the production handlers, and only those', () => {
    /*
     * THE SEAM IS A CONSTRUCTION SEAM, NOT A FAULT SWITCH — Stage 4B-1B2-R2.
     *
     * `createHoleFillCommitHandler` and `createRepairUndoHandler` take their
     * fallible work as a parameter so a test can make it fail. That is only safe
     * while the APPLICATION builds exactly one of each, from the production
     * defaults — otherwise the parameter becomes a way to divert real work,
     * which is the bypass hook the scan above forbids.
     */
    const files = sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')).filter(
      (file) => !/\.test\.(ts|tsx)$/.test(file),
    );
    const callers = files
      .filter((file) =>
        /createHoleFillCommitHandler\(|createRepairUndoHandler\(|createRepairCommitHandler\(/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(REPO_ROOT, file))
      .sort();
    expect(callers).toEqual(
      [
        join('apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
        join('apps', 'web', 'src', 'workers', 'repair-handlers.ts'),
      ].sort(),
    );

    // And each builds its exported handler from the production defaults.
    const commit = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
      'utf8',
    );
    expect(commit).toContain('createHoleFillCommitHandler(PRODUCTION_COMMIT_WORK)');
    const undo = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'repair-handlers.ts'),
      'utf8',
    );
    expect(undo).toContain('createRepairUndoHandler(PRODUCTION_UNDO_WORK)');
    expect(undo).toContain('createRepairCommitHandler(PRODUCTION_COMMIT_WORK)');
  });

  it('keeps the undo inverse OUT of the wire protocol', () => {
    /*
     * STAGE 4B-1B2-R1. `UndoableInverse` now carries a `CanonicalMesh` — the
     * exact mesh a part held before a fill — so that undo can restore the
     * document's sharing and not merely its bytes. That mesh is authoritative
     * geometry and must never reach the page (ADR 0008).
     *
     * It cannot today, because no payload or result names the type. This asserts
     * that, so the day someone reaches for the inverse to describe an undo over
     * the wire, they are told rather than shipping a mesh to React.
     */
    const protocol = readFileSync(
      join(REPO_ROOT, 'packages', 'geometry-runtime', 'src', 'protocol.ts'),
      'utf8',
    );
    expect(protocol).not.toContain('UndoableInverse');
    expect(protocol).not.toContain('previousMesh');
    // `UndoableChangeKind` — a string union — IS on the wire, and that is fine:
    // it is what lets a result say which kind of change was reversed.
    expect(protocol).toContain('UndoableChangeKind');
  });

  it('never re-runs the engine while applying a candidate', () => {
    /*
     * THE CORE PRODUCT-SAFETY GUARANTEE OF STAGE 4B-1B2: what the user previewed
     * is what Apply commits. That holds because the commit path reads the mesh
     * the candidate store already holds and does nothing else — no
     * triangulation, no planarity test, no broadphase, no narrowphase, no
     * boundary-loop extraction of the candidate.
     *
     * Asserted structurally rather than by measurement, because a timing test
     * would pass on a fast machine with the re-run present.
     */
    const handlers = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
      'utf8',
    );
    const commit = handlers.slice(handlers.indexOf('holeFillCommitHandler'));
    for (const banned of [
      'runHoleFill',
      'earClip',
      'assessPlanarity',
      'FaceBvh',
      'narrowphase',
      'sendForFill',
    ]) {
      expect(commit.includes(banned), `holefill/commit must not reach ${banned}`).toBe(false);
    }

    // And the engine is not even importable from the commit module.
    expect(handlers).not.toContain("from '@cadfixer/mesh-hole-fill'");
  });

  it('registers a hole-fill candidate from exactly ONE place', () => {
    /*
     * STAGE 4B-1B1-R1. `HoleFillCandidateStore.create` is the only way geometry
     * becomes a candidate, and the byte-preservation gate sits immediately
     * before the single call site. A second caller would be a second way in —
     * one that had not compared the candidate against the resident source — so
     * the number of call sites is asserted rather than assumed.
     */
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const callers = files
      .filter((file) =>
        /holeFillCandidates\.create\(|CandidateStore\(\)\.create\(/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(REPO_ROOT, file));

    expect(callers).toEqual([join('apps', 'web', 'src', 'workers', 'hole-fill-handlers.ts')]);

    // And that one call site is guarded: the gate has to be in the same file,
    // above it.
    const handlers = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-handlers.ts'),
      'utf8',
    );
    const gate = handlers.indexOf('sourcePositionsPreserved');
    const registration = handlers.indexOf('holeFillCandidates.create(');
    expect(gate).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(gate);
  });

  it('exposes no corruption or bypass hook in shipped code', () => {
    /*
     * The mutation injection that proves the gate works lives entirely in
     * `hole-fill-handlers.test.ts`, which substitutes a corrupted reply at the
     * channel boundary. Nothing in production can produce one.
     */
    const BANNED = ['corruptCandidate', 'skipPreservationCheck', 'bypassPreservation'];
    const offenders: string[] = [];
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const banned of BANNED) {
        if (contents.includes(banned)) offenders.push(`${relative(REPO_ROOT, file)}: ${banned}`);
      }
    }
    expect(offenders, 'the corruption path must remain test-only').toEqual([]);
  });

  it('wraps the application in an error boundary, outside the providers', () => {
    /*
     * STAGE 5A. React unmounts the whole tree when a component throws during
     * render, so without a boundary one unexpected interface bug replaced the
     * entire application with a blank page — no message, no reload affordance,
     * and a model still sitting in a worker the user could no longer reach.
     *
     * ASSERTED AS AN ORDERING, not merely as an import. The boundary has to be
     * OUTSIDE the providers: a throw inside a provider's own render would
     * otherwise be outside anything that could catch it, which is exactly the
     * case being defended against.
     */
    const entry = readFileSync(join(REPO_ROOT, 'apps', 'web', 'src', 'main.tsx'), 'utf8');
    const boundary = entry.indexOf('<ErrorBoundary>');
    const workspace = entry.indexOf('<WorkspaceProvider');
    const app = entry.indexOf('<App />');

    expect(boundary, 'the application must be wrapped in ErrorBoundary').toBeGreaterThan(-1);
    expect(workspace).toBeGreaterThan(boundary);
    expect(app).toBeGreaterThan(workspace);
  });

  it('sends nothing off-origin when the interface fails', () => {
    /*
     * A crash reporter would be the first thing in this application to transmit
     * anything, and the privacy architecture has no exception for one. The
     * boundary's only sink is the console.
     */
    const boundary = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'components', 'ErrorBoundary.tsx'),
      'utf8',
    );
    for (const banned of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'new Image(']) {
      expect(boundary, `the error boundary must not reach for ${banned}`).not.toContain(banned);
    }
  });

  it('constructs the fill worker from exactly one place', () => {
    const files = sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')).filter(
      (file) => !/\.test\.(ts|tsx)$/.test(file),
    );
    const constructors = files
      .filter((file) => /new Worker\([\s\S]*?hole-fill\.worker/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));

    expect(constructors).toEqual([join('apps', 'web', 'src', 'runtime', 'hole-fill-service.ts')]);
  });
});

describe('PMP reaches nothing', () => {
  /**
   * EXPLICIT, AND SEPARATE FROM THE GENERAL KERNEL SCAN.
   *
   * ADR 0018 qualified `pmp::fill_hole` and REJECTED it: it traps uncatchably
   * on a legal 512-vertex loop, loses append-only provenance, refines a
   * 128-vertex loop by +1,193 vertices, and times out at 2,000. It remains
   * research evidence and must never become a runtime dependency, a vendored
   * artifact, or an import — the whole reason CAD Fixer's own triangulator is
   * the MVP.
   */
  const MARKERS = ['pmp-library', 'pmp/', 'pmp::', 'fill_hole', 'SurfaceHoleFilling'];

  it('appears in no shipped source file', () => {
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const marker of MARKERS) {
        // A comment EXPLAINING why PMP was rejected is not a dependency, so
        // only import and require forms count.
        const pattern = new RegExp(
          `(from|require)\\s*\\(?\\s*['"][^'"]*${marker.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}`,
        );
        if (pattern.test(contents)) offenders.push(`${relative(REPO_ROOT, file)}: ${marker}`);
      }
    }
    expect(offenders, 'PMP is research evidence and must not ship').toEqual([]);
  });

  it('leaves no PMP artifact in any shipped package', () => {
    const packageDirectories = readdirSync(join(REPO_ROOT, 'packages'));
    for (const name of packageDirectories) {
      const walk = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
          if (entry === 'node_modules') continue;
          const full = join(directory, entry);
          if (statSync(full).isDirectory()) {
            walk(full);
            continue;
          }
          expect(/pmp/i.test(entry), `${relative(REPO_ROOT, full)} looks like a PMP artifact`).toBe(
            false,
          );
        }
      };
      walk(join(REPO_ROOT, 'packages', name));
    }
  });
});

describe('ZIP-B1-T10: the inflation path keeps exactly one destination', () => {
  /*
   * STRUCTURAL, AND DELIBERATELY SO.
   *
   * `zip-inflation.test.ts` proves the OUTPUT is correct, including under a
   * decompressor that reuses its chunk buffer — which a concatenating
   * implementation could not survive. What no behavioural test can prove is
   * that no SECOND full-size buffer exists, because accumulate-then-concatenate
   * produces byte-identical results. This is the assertion that fails if
   * someone reintroduces that shape while keeping every other test green.
   *
   * IT LIVES HERE, not beside the behavioural tests, because reading a source
   * file needs `node:fs` and `@cadfixer/file-formats` compiles with `lib:
   * ES2023` and no Node types — deliberately, so a codec cannot quietly acquire
   * a platform dependency. This suite is tooling-scoped and already asserts
   * boundary properties from source.
   */
  const source = readFileSync(
    join(REPO_ROOT, 'packages', 'file-formats', 'src', 'threemf', 'zip.ts'),
    'utf8',
  );
  const body = source.slice(source.indexOf('export async function readZipEntry'));

  it('retains no array of inflated chunks', () => {
    expect(body).not.toMatch(/chunks\s*:\s*Uint8Array\[\]/);
    expect(body).not.toMatch(/\.push\(chunk\)/);
  });

  it('allocates exactly one output buffer', () => {
    /*
     * A FORWARD GUARD, and honestly less than the two above.
     *
     * The pre-B1 implementation also contained exactly one `new Uint8Array(` —
     * its second full-size buffer was the chunk ARRAY, which the assertions
     * above are what actually catch. This one bounds the future: it fails if a
     * later change reaches for a second destination, for example to grow past a
     * declared size instead of refusing.
     */
    expect(body.match(/new Uint8Array\(/g) ?? []).toHaveLength(1);
  });

  it('proves the declared size is within the entry cap before allocating', () => {
    // The allocation takes its size from attacker-controlled metadata, so the
    // ceiling has to be applied in THIS function rather than inherited from
    // whatever limits the directory happened to be read under.
    const allocation = body.indexOf('new Uint8Array(');
    const check = body.indexOf('declared > limits.maxEntryBytes');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(allocation);
  });
});
