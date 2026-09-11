# Stage 5C-1A — Production Hosting Selection & Deployment Architecture

**Source commit:** `5b611636130c032c08e5004dd1a998adc36bcd41` (branch
`stage-5c1a-host-selection`).
**No deployment, no provider account, no DNS change was made.** This document is
research and a plan.

## 1. The release contract this host must fit

Frozen by Stage 5B and not broadened here: Chromium-based desktop browsers;
8 GiB minimum host; one active large workspace per browser; effective DPR
ceiling 2; minimum editor width 900 px; qualified through 3840 × 2160 at ratio 2;
Firefox and Safari not release-qualified; WebKit capability-compatible evidence
only; reload-based WebGL recovery; **all geometry processed locally and never
transmitted**.

The provider must fit the application. The application does not change to suit a
provider.

## 2. Deployment shape, established from source

| Question                       | Answer   | How it was established                                                           |
| ------------------------------ | -------- | -------------------------------------------------------------------------------- |
| Purely static client-side SPA? | **Yes**  | Build output is 13 files: `index.html` + hashed JS/CSS/workers/WASM              |
| Server-side rendering?         | No       | No SSR framework anywhere in the manifests                                       |
| API server?                    | No       | Repo-wide ESLint ban on `fetch`/XHR/WebSocket; zero off-origin requests measured |
| Database?                      | No       | No client or driver in any manifest                                              |
| Persistent server storage?     | No       | No storage API in production source                                              |
| Server-side geometry?          | No       | ADR 0008: geometry is worker-resident in the browser                             |
| WebSockets?                    | No       | Banned repo-wide                                                                 |
| Edge/serverless functions?     | No       | Nothing in the build needs one                                                   |
| Environment secrets?           | **None** | No `import.meta.env` or `process.env` in shipped source                          |
| Runtime Node after build?      | No       | Static files only                                                                |

Artifact: **2.45 MiB across 8 files** excluding source maps (main JS 933.61 kB,
Geogram WASM 1,272.71 kB, four worker chunks, CSS 20.64 kB). With source maps the
directory is 8.7 MB. **No router** — single route, so SPA fallback is
future-proofing rather than a present requirement.

> **Deployment recommendation:** do not publish `.map` files. They are 6+ MB of
> assets no user needs, and while the repository is public so nothing is
> _revealed_, serving them triples transfer for no benefit. This is a Stage 5C-1B
> build-config decision, not a source change.

## 3. Hard hosting requirements

1. **`Cross-Origin-Opener-Policy: same-origin`** and
   **`Cross-Origin-Embedder-Policy: require-corp`** on the document, plus
   `Cross-Origin-Resource-Policy: same-origin` on our assets. Without these the
   browser withholds `SharedArrayBuffer` and conservative repair fails closed.
   **This is the decisive requirement** and it eliminates otherwise reasonable
   hosts.
2. **`application/wasm`** for `.wasm`; a JavaScript type for module workers;
   correct HTML and CSS types.
3. **HTTPS**, automatic.
4. **Caching:** hashed assets immutable; `index.html` revalidated.
5. **Deterministic, version-controlled header configuration** — not a dashboard
   setting someone has to remember.
6. **Atomic deployments** and **fast rollback**.
7. **Preview URL carrying the same headers as production.**

## 4. Privacy requirements

Static file serving only. The host must not introduce request-body analytics,
session replay, client monitoring, asset proxying that receives model files, or
automatic upload handling. **No analytics, replay, monitoring or telemetry SDK is
to be enabled.**

One distinction worth stating rather than blurring: a static host will keep
**request logs** for asset fetches (URL, IP, user agent). That is categorically
different from geometry transmission — the user's mesh is never in a request
body, and a full flow makes zero off-origin requests. Both facts belong in any
future privacy statement.

## 5. Sources

Consulted 2026-09-11, provider-owned documentation only:

- Cloudflare Pages — [Headers](https://developers.cloudflare.com/pages/configuration/headers/),
  [Rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/),
  [Preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/),
  [Limits](https://developers.cloudflare.com/pages/platform/limits/),
  [Pricing](https://developers.cloudflare.com/pages/functions/pricing/)
- Vercel — [Project Configuration](https://vercel.com/docs/project-configuration)
  (updated 2026-08-25), [Limits](https://vercel.com/docs/limits) (2026-09-03),
  [Hobby Plan](https://vercel.com/docs/plans/hobby) (2026-08-31)
- Netlify — [Headers](https://docs.netlify.com/manage/routing/headers/)
- GitHub Pages — [community discussion #13309](https://github.com/orgs/community/discussions/13309)

**Not independently verified, because it requires a live deployment:** the
_default_ `Content-Type` each provider sends for `.wasm`, and whether `_headers`
is applied to preview deployments identically to production. Both are Stage
5C-1B's first checks. Neither is a blocker — every candidate lets us set
`Content-Type` explicitly.

## 6. Provider scorecard

| Criterion              | Cloudflare Pages                                                | Vercel                                             | Netlify                          | GitHub Pages     | Object store + CDN                         |
| ---------------------- | --------------------------------------------------------------- | -------------------------------------------------- | -------------------------------- | ---------------- | ------------------------------------------ |
| COOP configurable      | PASS (`_headers`)                                               | PASS (`vercel.json` `headers`)                     | PASS (`_headers`/`netlify.toml`) | **FAIL**         | PASS                                       |
| COEP configurable      | PASS                                                            | PASS                                               | PASS                             | **FAIL**         | PASS                                       |
| CORP configurable      | PASS                                                            | PASS                                               | PASS                             | FAIL             | PASS                                       |
| WASM MIME              | NOT VERIFIED (overridable)                                      | NOT VERIFIED (overridable)                         | NOT VERIFIED (overridable)       | n/a              | PASS (explicit)                            |
| Module workers         | PASS (plain static JS)                                          | PASS                                               | PASS                             | n/a              | PASS                                       |
| Preview URLs           | PASS — immutable per-commit, "atomic and may always be visited" | PASS                                               | PASS                             | PARTIAL          | FAIL (build it yourself)                   |
| Atomic deploy          | PASS                                                            | PASS                                               | PASS                             | PARTIAL          | PARTIAL                                    |
| Rollback               | PASS — "instantly revert", no rebuild                           | PASS (promote)                                     | PASS                             | FAIL             | Manual                                     |
| Custom domain          | PASS (100 free)                                                 | PASS (50 Hobby)                                    | PASS                             | PASS             | PASS                                       |
| TLS                    | PASS automatic                                                  | PASS                                               | PASS                             | PASS             | Manual/ACM                                 |
| Cache rules            | PASS                                                            | PASS                                               | PASS                             | FAIL             | PASS                                       |
| SPA routing            | PASS (not needed)                                               | PASS                                               | PASS                             | PARTIAL          | Manual                                     |
| GitHub integration     | PASS                                                            | PASS                                               | PASS                             | PASS             | FAIL                                       |
| Cost at MVP            | **PASS — static requests and bandwidth "free and unlimited"**   | **PARTIAL — Hobby is non-commercial only; 100 GB** | PARTIAL — credit-based           | PASS             | PARTIAL                                    |
| Operational simplicity | PASS                                                            | PASS                                               | PASS                             | PASS             | **FAIL**                                   |
| Migration ease         | PASS (`dist/` is portable)                                      | PASS                                               | PASS                             | PASS             | PASS                                       |
| Privacy                | PASS (no SDK required)                                          | PASS                                               | PASS                             | PASS             | PASS                                       |
| **Overall**            | **QUALIFIED**                                                   | QUALIFIED (licence caveat)                         | QUALIFIED                        | **DISQUALIFIED** | Architecturally valid, operationally wrong |

## 7. Disqualified

**GitHub Pages — DISQUALIFIED FOR THE CURRENT CAD FIXER RELEASE ARCHITECTURE.**
It cannot set custom response headers, so COOP and COEP cannot be sent, so
`SharedArrayBuffer` is unavailable, so conservative repair would permanently fail
closed. GitHub has acknowledged the gap with no committed timeline.

The known workaround — a service worker that synthesises the headers
(`coi-serviceworker`) — is **rejected**, and not on taste: Stage 5B §15 forbids
it, a service worker is precisely the component that could serve a stale shell
against new chunks, and making the product's cancellation guarantee depend on a
worker that must win a race on first load trades a hard guarantee for a
best-effort one. A client-side `<meta>` tag is not a substitute for an HTTP
header either.

**Object storage + CDN** is architecturally fine and is the reference model, but
it means owning cache invalidation, TLS, atomic promotion and rollback by hand.
That is infrastructure a one-person MVP does not need.

## 8. Recommendation

### Primary: **Cloudflare Pages**

1. **It satisfies the decisive requirement in version control.** `_headers` is a
   plain text file in the repository: 100 rules, 2,000 characters per line. The
   isolation contract is reviewable in a diff, not a dashboard setting.
2. **Cost fits, without a licensing asterisk.** Static asset requests and
   bandwidth are **free and unlimited on the free plan**. CAD Fixer's 1.27 MB
   lazy WASM therefore has no billing consequence at any MVP traffic level —
   which matters because Geogram dominates transfer for any user who runs the
   self-intersection check.
3. **Rollback is instant and needs no rebuild** — "instantly revert your project
   to a previous production deployment", and any successfully built production
   deployment is a valid target.
4. **Preview deployments are immutable per commit** — "atomic and may always be
   visited in the future" — which is exactly the smoke-then-promote workflow
   Stage 5C needs, and they can be locked behind Cloudflare Access so a preview
   URL is not a public launch.
5. Limits are comfortable: 20,000 files (we ship 13), 25 MiB per file (largest is
   1.27 MB), 500 builds/month, 100 custom domains.

### Fallback: **Netlify**

Same `_headers` mechanism, same capability set, with a credit-based cost model
that is harder to predict at low traffic. Chosen over Vercel as fallback for one
concrete reason: **Vercel's Hobby plan "restricts users to non-commercial,
personal use only"**, and `CLAUDE.md` states CAD Fixer is intended to become a
commercial product. Vercel is fully capable — `vercel.json` `headers` is
confirmed current — but it costs $20/seat/month from day one to be used honestly,
and its 100 GB Hobby transfer cap would matter for a 1.27 MB WASM asset.

## 9. Cost

Assumptions stated, not hidden: a first-visit user transfers ~1.2 MB (HTML + main
JS + CSS + geometry worker, gzipped); a user who runs the self-intersection check
additionally transfers ~400 kB gzipped of Geogram. Say **~1.6 MB per engaged new
visitor**, and near zero for repeat visitors because hashed assets are immutably
cached.

| Monthly users | Transfer | Cloudflare Pages | Netlify      | Vercel                      |
| ------------- | -------- | ---------------- | ------------ | --------------------------- |
| 100           | ~0.16 GB | **$0**           | $0           | $0 but non-commercial       |
| 1,000         | ~1.6 GB  | **$0**           | $0           | Pro $20/mo to be commercial |
| 10,000        | ~16 GB   | **$0**           | credit-based | Pro $20/mo, within 1 TB     |

Cloudflare's unlimited static bandwidth makes the cost question uninteresting,
which for a solo MVP is the right kind of boring.

## 10. Build contract

```
Node        22.22.2 (.nvmrc; engines ">=22.12.0")
Install     npm ci          (lockfile authoritative)
Build       npm run build
Output      apps/web/dist
Secrets     none
```

`No production application secret is required for the current static MVP.`

## 11. Production configuration (proposed, NOT activated)

To be added in Stage 5C-1B as `apps/web/public/_headers` so Vite copies it into
`dist/`:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer

/index.html
  Cache-Control: no-cache

/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

Deliberately **not committed in 5C-1A**: §53 forbids speculative provider
configuration, and a `_headers` file is only meaningful once the provider is
approved. `scripts/release-server.mjs` already encodes exactly this contract and
is what the Stage 5B suites assert against, so the behaviour is qualified even
though the provider file is not yet written.

### MIME contract

`.html` → `text/html; charset=utf-8` · `.js` → a JavaScript type · `.css` →
`text/css` · `.wasm` → **`application/wasm`** · `.map` → `application/json` (or
not served).

### Cache contract

`index.html` `no-cache`; `/assets/*` `public, max-age=31536000, immutable`.
Never immutable on HTML.

### Routing contract

Single route today. A request for a missing hashed asset must **404** — it must
never fall back to `index.html`, because a shell returned with a JavaScript
content type is a confusing failure instead of a clear one.

## 12. Deployment model

**Recommended: provider Git integration with controlled promotion.**

```
reviewed commit on main
  → Cloudflare Pages builds a PREVIEW deployment (immutable, per-commit URL)
  → automated PD smoke suite against that URL
  → manual smoke
  → rollback rehearsal
  → promote that exact deployment to production
```

Chosen over a CI-built artifact push because it needs no deployment token in
GitHub Actions, and because Cloudflare's immutable per-commit previews already
give the artifact identity a CI pipeline would be built to provide. **Production
auto-deploy on every push to `main` is not recommended**: promotion should be a
deliberate act after smoke, so an unreviewed commit can never become the public
site.

### Release artifact identity

```
commit SHA → npm ci → npm run build → hash manifest
  → deployment → fetch deployed assets → compare hashes
```

Stage 5B already proved the build is reproducible (two consecutive builds,
identical names, sizes and hashes), so comparing a locally built manifest against
what the CDN serves is a sound identity proof. **Recommended:** generate
`dist/release-manifest.json` at build time containing the commit SHA, asset
filenames with SHA-256, and the Geogram SHA-256 — no local paths, no
user-facing build ID in the UI.

## 13. CSP decision

**Option B — explicitly defer to a post-MVP hardening stage.**

Not a shrug. A correct policy for this application must allow module workers
(`worker-src 'self' blob:`), WebAssembly compilation (`script-src` with
`'wasm-unsafe-eval'`), and `blob:` for export object URLs. Getting any of those
wrong breaks the product in production only — exactly the failure class Stage 5B
exists to prevent — and the marginal benefit for a static site with **no
third-party scripts, no `innerHTML`, no `eval`, and a repo-wide network-API ban**
is small. The threat a CSP mitigates is largely absent by construction.

Deferring is conditional: a CSP becomes required the moment any third-party
script, embed or external asset is introduced.

`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` **are**
recommended now — `nosniff` especially, because correct WASM and worker types are
load-bearing and sniffing is how a misconfigured host appears to work.
Frame-ancestors and Permissions-Policy are not justified by the current threat
model.

## 14. Custom domain

**No domain is documented anywhere in the repository.** Searched the docs, config
and manifests: nothing names a CAD Fixer domain.

`PUBLIC DOMAIN SELECTION REQUIRED BEFORE FINAL PROMOTION`

When chosen: apex via CNAME-flattening or `ALIAS`, or `www` via `CNAME` to the
`.pages.dev` host, with one canonical host and a permanent redirect from the
other. TLS is issued automatically. **No DNS change was made and none should be
until a domain is chosen and a preview deployment has passed smoke.**

## 15. PD01–PD40 smoke plan

Grouped by what each group would tell us, and every item is a real assertion the
existing suites already know how to make.

**Transport and headers (PD01–PD11).** HTTPS; HTML status and type; main JS; CSS;
module worker loads; `.wasm` served as `application/wasm`; COOP, COEP and CORP
exactly as contracted; **`crossOriginIsolated === true`**; `SharedArrayBuffer`
present. PD07–PD11 are the promotion gate — if any fails, do not promote.

**Load (PD12–PD13).** Cold load to usable shell; warm load with cache, shell
still correct and isolation still intact.

**Product flows (PD14–PD28).** STL, OBJ and 3MF import; topology; repair preview,
Apply, Undo; hole inventory, preview, Apply, Undo; SI diagnostic; STL, OBJ and
3MF export. These are `e2e/*.spec.ts` retargeted at the deployment URL.

**Safety and privacy (PD29–PD32).** Malformed import recovery; **zero off-origin
requests**; **no request body**; Geogram still lazy.

**Resilience and policy (PD33–PD37).** Reload; WebGL fault then reload; 900 px
viewport; DPR clamp 2; the large one-tab reference workflow.

**Serving detail (PD38–PD40).** Cache headers per contract; unknown hashed asset
**404s rather than returning HTML**; rollback candidate passes the same suite.

## 16. Rollback rehearsal

```
A = current known-good deployment
B = release candidate

deploy B to its immutable preview URL
  → PD suite against B
  → promote B to production
  → PD suite against production
  → ROLLBACK to A          (instant, no rebuild)
  → PD subset against production, confirm A is serving
  → re-promote B
  → PD suite again
```

Cloudflare's model is promotion between immutable deployments rather than a
destructive revert, which is the safer shape — A is never overwritten, so the
rehearsal cannot damage the known-good release.

## 17. Deployment failure policy

| Finding                                        | Action                               |
| ---------------------------------------------- | ------------------------------------ |
| COOP/COEP wrong or `crossOriginIsolated` false | **STOP.** Do not promote             |
| Worker or WASM MIME wrong                      | **STOP.** Do not promote             |
| Any geometry leaves the browser                | **Critical — roll back immediately** |
| Smoke failure                                  | Roll back                            |
| CDN cache inconsistency                        | Roll back or hold                    |
| GitHub CI red                                  | Do not promote                       |

No "ship now, fix later" for Critical or High.

## 18. Version and positioning

**Recommended tag: `v0.1.0`.** `package.json` is at `0.0.0` and no tag exists.

**Recommended positioning: Technical Preview** (or "Early Access" if a warmer
word is wanted). Not "Beta", which implies feature-completeness pending polish,
and certainly not `v1.0.0`. The honest reasons are all documented: Chromium
desktop only; Firefox and Safari unqualified; one large workspace; reload-only
WebGL recovery; conservative repair is four named operations, not arbitrary mesh
repair; hole filling is bounded planar openings only. A product that says
"technical preview" and then behaves exactly as documented earns more trust than
one that says "1.0" and surprises people.

## 19. Monitoring and error observability

**Recommended, not implemented:** an external uptime check on the homepage, plus
synthetic fetches of one worker chunk and the WASM. These observe _our own_ site
from outside and collect nothing about users.

**No Sentry or equivalent.** It would be the first thing in this application to
transmit anything off-origin, stack traces can carry file and model names, and
the `ErrorBoundary` already reports to the console for a developer. The trade-off
is real and accepted: we will not see users' crashes. For a preview release whose
whole proposition is local processing, that is the right side of the trade.

## 20. Exit strategy

`dist/` is portable. Moving to Netlify, an object store, or self-hosting means
reproducing the header contract — which `scripts/release-server.mjs` already
states executably — and changing nothing about the application. No proprietary
provider API is used or proposed.

## 21. Branch and cleanup

Keep `main` plus a short-lived Stage 5C branch, and tag releases. No long-lived
release branch. `stage-5a-mvp-hardening` and `stage-5b-release-qualification` are
fully merged and **should be deleted only after a successful public release** —
not during qualification, while they are still the cleanest reference points.

## 22. What the user must authorize

1. A **Cloudflare account** (free) and a Pages project.
2. **GitHub authorization** for Cloudflare Pages to read the repository.
3. A **domain decision** before public promotion.

Authorization should happen through Cloudflare's own browser flow. **No API token
should be pasted into this conversation**, and none is needed for the recommended
model.

## 23. Stage 5C-1B plan

1. User authorizes Cloudflare Pages against the repository.
2. Add `apps/web/public/_headers` with the contract above, plus a static contract
   test asserting its content.
3. Decide source-map publication.
4. Build a preview deployment from an exact reviewed commit.
5. Run PD01–PD40 against the preview URL.
6. Rollback rehearsal.
7. Promote, re-smoke, then decide on the domain and the public release.
