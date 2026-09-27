/**
 * The security response headers the production host sends, stated ONCE.
 *
 * `vite.config.ts` sends them from `vite preview`, so every end-to-end run
 * exercises the shipped application under them; `deploy/nginx/
 * cad-fixer-security-headers.conf` sends them in production, and
 * `scripts/hostinger-deployment.test.ts` holds that file's values to these.
 *
 * THE POLICY IS THE NARROWEST ONE THE PRODUCT RUNS UNDER, measured (PR-01):
 *
 *   - `script-src 'self' 'wasm-unsafe-eval'` — the two geometry kernels are
 *     WebAssembly, and compiling a module needs `wasm-unsafe-eval`. No `eval`,
 *     no inline script: the build emits neither.
 *   - `connect-src 'self'` — each kernel's Emscripten loader `fetch()`es its
 *     own `.wasm` from this origin. That is the only request the application
 *     makes after load; `'none'` broke Split, Texture and the self-intersection
 *     check.
 *   - `worker-src 'self'` — every worker is a same-origin module file.
 *   - `img-src 'self' data: blob:` — the favicon is a data: URI.
 *   - `style-src 'self'` — the stylesheet is a file; React's `style` props and
 *     the view cube's transform go through the CSSOM, which CSP does not govern.
 *   - `frame-ancestors 'none'`, with `X-Frame-Options: DENY` for older
 *     browsers — nothing may embed the editor.
 *
 * `vite dev` does NOT send the policy: its hot-reload preamble is an inline
 * script. Development is not what ships.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Powerful features the editor never uses, switched off for this origin. */
export const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'bluetooth=()',
  'hid=()',
].join(', ');

export const PRODUCTION_SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Permissions-Policy': PERMISSIONS_POLICY,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;
