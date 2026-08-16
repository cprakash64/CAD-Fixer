import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Unit and component test configuration.
 *
 * Two projects, because the layers have genuinely different needs: the geometry
 * and format packages are platform-free and run under Node with no DOM at all —
 * which is itself a check that they have not quietly grown a browser
 * dependency — while the application is tested in jsdom.
 *
 * End-to-end tests live in `e2e/` and are run by Playwright, not Vitest.
 */
export default defineConfig({
  test: {
    // Test globals are not injected; every helper is imported explicitly.
    globals: false,
    projects: [
      {
        test: {
          name: 'packages',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
        // Repository tooling: the Node version guard and anything else that has
        // to run before a build exists.
        test: {
          name: 'tooling',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          setupFiles: ['./apps/web/vitest.setup.ts'],
        },
      },
    ],
  },
});
