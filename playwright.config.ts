import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke tests.
 *
 * These run against the production build served by `vite preview`, because
 * preview is the only local surface that sends the cross-origin isolation
 * headers the real deployment must send. Testing against the dev server would
 * not exercise the built worker chunk.
 */
export default defineConfig({
  testDir: './e2e',
  /*
   * TIMING PROOFS DO NOT RUN HERE.
   *
   * `*.timing.spec.ts` measures how long cancellation takes RELATIVE to an
   * uncancelled run of the same work. That comparison is only meaningful when
   * both halves see the same machine load, and four parallel workers guarantee
   * they do not: measured over five full-suite runs the ratio ranged from 0.640
   * to 1.17 — a "cancelled" run that took LONGER than the uncancelled one, which
   * is impossible as a statement about cancellation and only possible as a
   * statement about CPU contention.
   *
   * They run instead under `npm run test:e2e:timing`, single-worker, where the
   * same implementation measures 0.608-0.640 across ten consecutive runs. That
   * keeps the strong acceptance threshold intact instead of loosening it to
   * accommodate a measurement error.
   */
  testIgnore: '**/*.timing.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: process.env.CI === undefined,
    timeout: 180_000,
  },
});
