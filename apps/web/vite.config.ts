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
  },
});
