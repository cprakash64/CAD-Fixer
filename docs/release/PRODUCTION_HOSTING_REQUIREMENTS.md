# Production Hosting Requirements

CAD Fixer is a **static site**. No backend, no database, no server-side geometry,
no upload endpoint. Hosting it correctly is almost entirely a matter of sending
the right headers and the right content types.

Qualified against commit `8a800b5e137602008eced0aef3fd9beee5bcfe9c` in Stage 5B.
A reference implementation of everything below lives in
`scripts/release-server.mjs` — about a hundred lines of dependency-free Node,
kept so this document has something executable behind it. **It is a test and
documentation fixture, not a production server.**

## 1. Cross-origin isolation — required

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

Send these on the **document**. Every subresource must be same-origin or carry
valid CORP/CORS.

**Why it is not optional.** Conservative repair is one long synchronous pass, and
the only way to interrupt it is a flag in a `SharedArrayBuffer` that the worker
can read mid-loop. Browsers expose `SharedArrayBuffer` only in a cross-origin
isolated context. Measured in Chromium 151 and WebKit 26.5: with the headers,
`crossOriginIsolated === true` and `SharedArrayBuffer` is present; without them,
**both are absent**.

**What happens if a host forgets them.** CAD Fixer fails closed and says so — the
repair panel is replaced by a refusal naming the cause, and import, Mesh Health
and export continue to work. It does **not** silently offer a repair it could not
cancel. This is qualified by `e2e/release-isolation.spec.ts`, which serves the
real production build without the headers.

**Verification after any deployment:** open the site and confirm
`globalThis.crossOriginIsolated === true`. The Runtime panel shows it.

## 2. Content types

Getting these wrong produces failures that appear **only** in production, because
dev servers guess them correctly.

| Asset                             | Required `Content-Type`               |
| --------------------------------- | ------------------------------------- |
| `index.html`                      | `text/html; charset=utf-8`            |
| `assets/*.js` (including workers) | a JavaScript type (`text/javascript`) |
| `assets/*.css`                    | `text/css; charset=utf-8`             |
| `assets/*.wasm`                   | **`application/wasm`**                |
| `assets/*.map`                    | `application/json`                    |

`application/wasm` is mandatory: `WebAssembly.instantiateStreaming` rejects any
other type. Workers are ES modules and will not instantiate if served as
`text/plain`. Both are asserted in `e2e/release-hosting.spec.ts`.

## 3. Caching

| Asset             | Policy                                | Why                                                                                                                                                                                              |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hashed `assets/*` | `public, max-age=31536000, immutable` | The filename contains a content hash, so the bytes can never change under a given name.                                                                                                          |
| `index.html`      | `no-cache` (revalidate)               | The shell names the current hashed chunks. A cached shell outlives the chunks a later deployment removed, and the app then fails to load with no way for the user to recover but a hard refresh. |

## 4. SPA serving

Serve `index.html` for any path that does not match a file. The application is
currently single-route, so this is future-proofing rather than a present
requirement — but a host that 404s unknown paths will break the first time a
route is added.

## 5. Deployment atomicity

A deployment must never expose:

- **new HTML with chunks not yet uploaded**, or
- **old HTML whose hashed chunks have already been deleted**.

Upload new assets **before** switching the HTML, and retain the previous
generation of hashed assets for at least as long as a cached shell might live.
Most static hosts do this by default with atomic releases; verify rather than
assume. Stage 5C selects the host and proves this.

## 6. Additional security headers

Sent by the reference server and recommended:

```
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

`nosniff` matters here specifically because correct WASM and worker types are
load-bearing — sniffing is a way for a misconfigured host to appear to work.
`no-referrer` is appropriate for an application that has no reason to tell
anyone where its users came from.

**No Content-Security-Policy is currently defined.** See
`docs/release/STAGE_5B_RELEASE_QUALIFICATION.md` for the reasoning; a CSP that
forgets `worker-src` or WASM evaluation breaks the product, so it is deliberately
deferred rather than added untested.

## 7. What the host must NOT do

- **No upload endpoint, ever.** Imported files are read in the browser and never
  transmitted. A full import → analyse → repair → export flow makes **zero
  off-origin requests and sends no request body at all** (asserted in
  `e2e/release-hosting.spec.ts`).
- **No injected analytics, tag managers or third-party scripts.** Besides the
  privacy commitment, a cross-origin script without CORP breaks isolation and
  therefore silently disables repair.
- **No service worker.** None exists; one added by a host could serve a stale
  shell against new chunks, or cache a user's exported geometry.
- **No header stripping at a CDN or proxy layer.**

## 8. Lazy loading

The Geogram WASM kernel (1.2 MB) must remain lazy. Measured: loading the shell
and importing a model fetches **no `.wasm` at all** — it arrives only when the
self-intersection diagnostic runs. A host that speculatively preloads or pushes
all assets would make every first paint pay for a feature most sessions never
reach.
