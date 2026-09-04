import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * BUILDS THE END-TO-END HARNESS PAGE. Never part of the application build.
 *
 * A SEPARATE CONFIG, not a second entry in `vite.config.ts`, and that is the
 * whole point: the application's build has exactly one input — `index.html` —
 * and adding a second would put the harness in `dist/` for every deployment.
 * Here the roles are inverted: the root IS the harness directory, so
 * `npm run build` cannot reach this file and this file cannot leak into that
 * output.
 *
 * The harness is built and previewed in PRODUCTION MODE on its own port,
 * mirroring `playwright.config.ts`'s reason for testing the built application
 * rather than the dev server: the worker chunk a browser actually loads is the
 * built one, and a bundling difference in the worker boundary is exactly the
 * class of defect this suite exists to catch.
 *
 * Same cross-origin isolation headers as the application, because the repair
 * workflow refuses to run without `SharedArrayBuffer` and a harness that could
 * not exercise repair would be missing half its purpose.
 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

export default defineConfig({
  root: 'e2e-harness',
  plugins: [react()],
  server: {
    headers: { ...crossOriginIsolationHeaders },
  },
  preview: {
    // 4175: 4173 is the application suite and 4174 is the research kernel
    // harness, so all three can be up at once without a port collision.
    port: 4175,
    strictPort: true,
    headers: { ...crossOriginIsolationHeaders },
  },
  worker: {
    format: 'es',
  },
  build: {
    // Outside `apps/web/dist`, so a stale harness build can never be mistaken
    // for — or served as — the application.
    outDir: '../dist-e2e-harness',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    modulePreload: { polyfill: false },
  },
});
