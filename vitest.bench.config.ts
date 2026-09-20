import { defineConfig } from 'vitest/config';

/**
 * Benchmark configuration, deliberately separate from `vitest.config.ts`.
 *
 * Benchmarks are NOT part of `npm test` or CI. Their numbers depend on the
 * machine they run on, so asserting thresholds would produce failures that say
 * nothing about the code. They are run on demand with `npm run bench:stl`, and
 * their output is transcribed into docs/PERFORMANCE_BASELINE.md together with
 * the hardware it came from.
 *
 * One worker, no parallelism, so measurements are not competing with other
 * test workers for cores.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // The Stage 3A-2 kernel bakeoff lives here too. It is deliberately NOT
    // matched under experiments/: adding that glob made Vite crawl the 2 GB
    // Emscripten SDK and fetched upstream trees, which turned a 30-second run
    // into a ten-minute one. The suite lives in scripts/ and reaches into
    // experiments/ by relative import instead.
    /*
     * `threemf-corpus.suite.ts` IS NAMED SEPARATELY BECAUSE IT IS NOT A
     * BENCHMARK. It reports what the production reader makes of a directory of
     * real 3MF files, and it ships none of them — the directory comes from
     * `CADFIXER_CORPUS` and the repository stays dataless. It belongs here
     * rather than in `npm test` for the same reason the benchmarks do: its
     * result depends on what is on the machine, so asserting anything would
     * produce failures that say nothing about the code.
     *
     * `interop-corpus.suite.ts` is the Stage 6D-A4 generalisation of it to STL,
     * OBJ and 3MF, run through every gate the worker applies, with optional
     * export and parse-back. Same arrangement, same reason.
     */
    include: [
      'scripts/**/*.bench-suite.ts',
      'scripts/threemf-corpus.suite.ts',
      'scripts/interop-corpus.suite.ts',
      // Stage 6E-A2: buffered versus streamed ingestion over the same corpus.
      'scripts/streaming-corpus.suite.ts',
    ],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    // Large sizes genuinely take a while; the default 5s timeout is not enough.
    testTimeout: 600_000,
    /*
     * THE EMSCRIPTEN GLUE IS LOADED BY NODE, NOT BY VITEST'S TRANSFORM — the
     * same reason `vitest.config.ts` externalises it for the worker-kernel
     * project. Geogram's start-up `EM_ASM` detects a CommonJS host by testing
     * `typeof module !== "undefined"`, which Vitest's module runner satisfies,
     * and then dereferences `this` in a strict ES module.
     */
    server: { deps: { external: [/self-intersection\.js$/] } },
  },
});
