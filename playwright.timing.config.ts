import { defineConfig, devices } from '@playwright/test';
import { DEFAULT_APP_BASE_URL } from './e2e/app-origin';

/*
 * DELIBERATELY LOCAL-ONLY. These specs measure main-thread gaps and
 * cancellation ratios; run against a remote origin they would be measuring
 * network latency, so CAD_FIXER_E2E_BASE_URL is not honoured here. The constant
 * is imported rather than repeated so there is one definition of the local
 * preview origin.
 */

/**
 * Timing proofs, run SERIALLY.
 *
 * WHY A SEPARATE PROJECT RATHER THAN A LOOSER THRESHOLD. These specs assert that
 * cancelling work is materially faster than letting it finish. That is a ratio
 * between two measurements, and it is only valid when both are taken under the
 * same load. Under the main suite's four parallel workers it is not: the two
 * halves land in different contention windows, and the ratio has been observed
 * to exceed 1.0 — the cancelled run "taking longer" than the uncancelled one.
 *
 * One worker, no parallelism, no retries. The measurement becomes stable
 * (0.608-0.640 over ten runs) and the original, stronger acceptance threshold
 * holds without being relaxed.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.timing.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // No retries: a timing proof that only passes on a second attempt is not a
  // proof, and a retry would hide exactly the instability this project exists
  // to eliminate.
  retries: 0,
  timeout: 600_000,
  reporter: 'list',
  use: {
    baseURL: DEFAULT_APP_BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview',
    url: DEFAULT_APP_BASE_URL,
    reuseExistingServer: process.env.CI === undefined,
    timeout: 180_000,
  },
});
