import { defineConfig } from '@playwright/test';

/**
 * Stage 4A-1 research project. RESEARCH ONLY — deliberately not part of
 * `npm run test:e2e`: it qualifies formats rather than verifying the product,
 * and a red research probe must not fail the production suite.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /format\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4321' },
  webServer: {
    command: 'node harness/server.mjs',
    cwd: new URL('.', import.meta.url).pathname,
    url: 'http://localhost:4321/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
