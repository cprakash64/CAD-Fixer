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
