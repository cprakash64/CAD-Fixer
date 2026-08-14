# Deployment Requirements

CAD Fixer is a static site. It has no backend, no database, and no server-side
geometry processing. Hosting it correctly is mostly a matter of sending the
right headers.

## 1. Cross-origin isolation (required)

Multithreaded WebAssembly geometry kernels need `SharedArrayBuffer` and
pthreads. Browsers only expose `SharedArrayBuffer` in a **cross-origin isolated**
context. The host must therefore serve the application document with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

and every subresource must either be same-origin or carry
`Cross-Origin-Resource-Policy` / valid CORS headers. We additionally send
`Cross-Origin-Resource-Policy: same-origin` on our own assets.

Verify with `globalThis.crossOriginIsolated === true`. The Runtime panel in the
application shows this, and the Playwright suite asserts it.

### Why this is configured now

Cross-origin isolation is easy to satisfy on an empty application and painful to
retrofit onto one that has accumulated third-party embeds. Configuring it in
Stage 0 means any resource that would break it fails immediately, in local
development, rather than during a deployment months from now.

### Local development

`apps/web/vite.config.ts` sends the same three headers from both the dev server
(`vite`) and the preview server (`vite preview`). No workaround or proxy is
needed, and development is not degraded to simulate production.

### Consequences for third-party resources

**Every future third-party resource must be evaluated for cross-origin
isolation compatibility before adoption.** Under `require-corp`, a cross-origin
resource that does not send `Cross-Origin-Resource-Policy` or appropriate CORS
headers **will not load at all**.

This rules out, by default: CDN-hosted fonts and scripts, third-party analytics
snippets, embedded iframes without CORP, and hotlinked images. The project
avoids all of these for privacy reasons anyway — see
[PRIVACY_ARCHITECTURE.md](PRIVACY_ARCHITECTURE.md) — so the two constraints
reinforce each other.

If isolation ever has to be dropped, the cost is losing multithreaded WASM.
That is an architectural decision requiring an ADR, not a hosting tweak.

## 2. Additional security headers (recommended)

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

`connect-src 'none'` is the browser-level counterpart to the lint rule banning
network APIs: it makes the privacy promise enforceable by the user's browser
rather than only by our CI. It must be revisited if update checks or
authentication are ever added.

`worker-src 'self' blob:` is required because the geometry worker is a separate
bundled chunk.

**These headers are documented, not yet applied** — no deployment environment
exists yet. They must be configured when one is chosen, and the CSP in
particular needs testing against the built output before it is enabled.

## 3. Serving requirements

- **HTTPS.** `crossOriginIsolated` and workers require a secure context.
- **Correct MIME types.** `.js` as `text/javascript`, `.wasm` as
  `application/wasm`. A wrong WASM type breaks streaming compilation.
- **SPA fallback** is not needed today — the application is a single document
  with no client-side routing.
- **Immutable asset caching.** Vite emits content-hashed filenames, so
  `assets/*` can be `Cache-Control: public, max-age=31536000, immutable`.
  `index.html` must **not** be cached that way.

## 4. Build output

```bash
npm run build
```

produces `apps/web/dist/`: `index.html`, hashed assets, and the geometry worker
as its own chunk. It is fully static — any static host that can set the headers
above will serve it.

## 5. What deployment must never introduce

- A server-side geometry endpoint.
- A file upload endpoint.
- Injected third-party tags at the edge (analytics, tag managers, session
  replay). These would break both the privacy promise and, under
  `require-corp`, quite possibly the application.
