import { defineConfig } from '@playwright/test';

/**
 * Stage 3C-1A research Playwright project. RESEARCH ONLY — deliberately NOT
 * part of `npm run test:e2e`, because these specs qualify a kernel rather than
 * verify the product, and a red research probe must not fail the product suite.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /browser\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4319' },
  webServer: {
    command: 'node harness/server.mjs',
    cwd: new URL('.', import.meta.url).pathname,
    url: 'http://localhost:4319/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
