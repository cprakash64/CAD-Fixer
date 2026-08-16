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
    include: ['scripts/**/*.bench-suite.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    // Large sizes genuinely take a while; the default 5s timeout is not enough.
    testTimeout: 600_000,
  },
});
