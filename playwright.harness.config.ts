import { defineConfig, devices } from '@playwright/test';

/**
 * MULTI-PART DOCUMENT PROOFS, in a real browser.
 *
 * SEPARATE FROM THE APPLICATION SUITE because it serves a different page.
 * `playwright.config.ts` drives the shipped application, which can only import
 * STL and therefore can only ever hold one part — which is exactly why DF07,
 * DF08 and DF10 had no browser evidence after Stage 4A-2A. This config serves
 * the end-to-end harness build instead: the same application, the same worker
 * handlers, the same store and the same viewport, with a synthetic multi-part
 * document put in front of them.
 *
 * ONE WORKER, NOT PARALLEL. Several of these specs measure — render snapshot
 * time at a thousand placements, active-part switch latency, main-thread gaps —
 * and a measurement taken while three other Chromium instances compete for
 * cores is a measurement of the machine. The same reasoning as
 * `playwright.timing.config.ts`, for the same reason.
 */
export default defineConfig({
  testDir: './e2e-harness',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  timeout: 300_000,
  use: {
    baseURL: 'http://localhost:4175',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'npm run build:harness --workspace @cadfixer/web && npm run preview:harness --workspace @cadfixer/web',
    url: 'http://localhost:4175',
    reuseExistingServer: process.env.CI === undefined,
    timeout: 180_000,
  },
});
