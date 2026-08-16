import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Headers that put the document into a cross-origin isolated context, which is
 * the precondition for `SharedArrayBuffer` and therefore for multithreaded
 * WebAssembly geometry kernels later on.
 *
 * They are applied in dev and preview so that a resource which would break
 * isolation in production fails here first, rather than during deployment.
 * Production hosting must send the same headers — see
 * docs/DEPLOYMENT_REQUIREMENTS.md.
 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

export default defineConfig({
  plugins: [react()],
  server: {
    headers: { ...crossOriginIsolationHeaders },
  },
  preview: {
    // Pinned so the end-to-end suite can target a known origin without passing
    // arguments through npm workspace indirection.
    port: 4173,
    strictPort: true,
    headers: { ...crossOriginIsolationHeaders },
  },
  worker: {
    // Geometry workers are authored as ES modules and import workspace packages.
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    modulePreload: {
      /**
       * NO MODULE-PRELOAD POLYFILL.
       *
       * Vite injects a small polyfill that calls `fetch()` on the document's own
       * `<link rel="modulepreload">` hrefs for browsers that do not support the
       * hint. It is harmless in itself — same-origin, first-party assets only —
       * but it put the single `fetch(` in the shipped bundle, and this project
       * bans network APIs repo-wide so that "no code here can talk to a network"
       * is a claim anyone can verify by grepping the build output. An exception
       * that has to be explained every time it is found is worth more than the
       * preload hint.
       *
       * Safe to disable: the application already requires cross-origin isolation
       * and an ES2022 target, so every browser that can run it supports
       * `modulepreload` natively.
       */
      polyfill: false,
    },
  },
});
