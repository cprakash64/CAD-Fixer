import { defineConfig, devices } from '@playwright/test';

/**
 * STAGE 3A-3B — EXPERIMENTAL browser qualification of candidate WASM.
 *
 * SEPARATE FROM THE PRODUCTION E2E SUITE ON PURPOSE. `playwright.config.ts`
 * tests the application against its own production build; this config tests
 * research artifacts that must never enter that build. Keeping them apart means
 * `npm run test:e2e` cannot accidentally depend on a candidate kernel, and this
 * suite cannot be mistaken for evidence about the shipped product.
 *
 * The server is a plain `node:http` process, not Vite: Emscripten's ES6 glue
 * does not survive Vite's transform, and Stage 3A-2 recorded 321 fabricated
 * "crashes" that were entirely the bundler's. It sends the same COOP/COEP
 * headers the application requires, and the tests assert
 * `crossOriginIsolated === true` in the browser rather than trusting headers.
 *
 * NOT PARALLEL, ONE WORKER. Candidate runs are timed and memory-measured, and
 * this machine has already shown contention effects. Sequential execution is
 * part of the measurement, not a convenience.
 */
export default defineConfig({
  testDir: './e2e-browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  timeout: 300_000,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node experiments/browser-harness/server.mjs',
    url: 'http://127.0.0.1:4174/',
    reuseExistingServer: process.env.CI === undefined,
    timeout: 60_000,
  },
});
