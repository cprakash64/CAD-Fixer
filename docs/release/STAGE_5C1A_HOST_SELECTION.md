# Stage 5C-1A — Production Hosting Selection & Deployment Architecture

**Source commit:** `5b611636130c032c08e5004dd1a998adc36bcd41` (branch
`stage-5c1a-host-selection`).
**No deployment, no provider account, no DNS change was made.** This document is
research and a plan.

> **SUPERSEDED BY USER INFRASTRUCTURE DECISION (2026-09-11).** The production
> target is now the user's **existing Hostinger VPS**, not Cloudflare. Cloudflare
> Workers Static Assets remains **technically qualified** — it is no longer the
> selected deployment target, which is an infrastructure choice, not a defect.
> The current plan is
> [`STAGE_5C_HOSTINGER_VPS_PLAN.md`](STAGE_5C_HOSTINGER_VPS_PLAN.md). The
> Cloudflare deployment work on `stage-5c1b1-cloudflare-preview` was never
> merged and must not be. Everything below is retained as auditable historical
> reasoning.

> **SUPERSEDED IN PART — read Stage 5C-1A-R1 at the end of this document before
> acting on anything here.** The provider recommendation in §8 (Cloudflare
> Pages) was corrected on 2026-09-11 to **Cloudflare Workers Static Assets**,
> after Cloudflare's own Pages overview was found to state that Workers is its
> primary platform and that new projects should start there. Sections §1–§7 and
> §9–§21 remain current. The Pages analysis is retained deliberately: Pages is
> still fully supported and remains a qualified fallback.

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

### Primary: **Cloudflare Pages** — SUPERSEDED by Stage 5C-1A-R1

> **This recommendation was superseded on 2026-09-11.** Every finding below was
> verified and remains accurate; Pages satisfies all of CAD Fixer's hard
> requirements. It was superseded because Cloudflare now directs new projects to
> Workers, and Workers Static Assets satisfies the same requirements with
> artifact-addressed promotion. See **R1.24**. Pages remains a qualified
> fallback behind Netlify.

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

---

# Stage 5C-1A-R1 — Correction: Cloudflare Workers Static Assets supersedes Cloudflare Pages

**Status of everything above: retained, and superseded only where this section
says so.** The release contract (§1), the deployment shape (§2), the hard
requirements (§3), the privacy requirements (§4), the non-Cloudflare scorecard
(§6), the GitHub Pages disqualification (§7), the build contract (§10), the MIME
/ cache / routing contracts (§11), the PD01–PD40 plan (§15), the failure policy
(§17), versioning (§18), monitoring (§19) and the exit strategy (§20) are
**unchanged**. What changes is **which Cloudflare product surface** we deploy to.

**Still no deployment, no Cloudflare account, no authorization, no DNS change,
no Wrangler installation.** This remains research.

Sources consulted **2026-09-11**, Cloudflare-owned documentation only. Every
claim below is attributed.

## R1.1 What prompted the correction

Stage 5C-1A recommended Cloudflare Pages on the strength of `_headers`,
unlimited static bandwidth, immutable per-commit previews and instant rollback.
Every one of those findings was correct. What Stage 5C-1A did not establish is
that **Cloudflare now tells new projects to start somewhere else.**

## R1.2 Current Cloudflare platform direction — VERIFIED

[Cloudflare Pages overview](https://developers.cloudflare.com/pages/), page
title **"Cloudflare Pages"**, last updated **2026-08-25**, states:

> Workers supports most Pages use cases and offers a broader feature set. It is
> Cloudflare's primary platform for building applications. Start new projects
> with Workers.

Paraphrased recommendation: **Workers is the primary application platform; new
projects should begin on Workers rather than Pages.** This is Cloudflare's own
current wording on Pages' own overview page, not a third-party reading.

**Pages is NOT deprecated.** The same page lists Pages as _Available on all
plans_ and continues to document Functions, Rollbacks, Redirects and preview
deployments as live features. The accurate classification is therefore:

`CLOUDFLARE PAGES — SUPPORTED, FULLY FUNCTIONAL, NOT PREFERRED FOR NEW PROJECTS`

Anything stronger than that would be inaccurate, and Stage 5C-1A's Pages
analysis is not withdrawn on grounds of correctness.

## R1.3 Workers Static Assets — static-only feasibility

The decisive question is whether CAD Fixer can deploy as pure static files
**without writing a Worker**, because a `fetch()` handler would be application
backend code this product has no use for and must not acquire by accident.

[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/):

> The `main` key is optional for assets-only Workers.

[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/):

> By default, if a requested URL matches a file in the static assets directory,
> that file will be served — without invoking Worker code.

and, where no Worker script exists, an unmatched request returns `404 Not Found`.

**Result: a Worker script is NOT REQUIRED.** The deployable shape is exactly:

```
apps/web/dist  →  Workers Static Assets  →  browser
```

with no entrypoint, no `fetch()` handler, no bindings, no KV, no D1, no R2, no
secrets and no Functions. This is the smallest architecture on offer and it is
strictly smaller than Pages, which carries a Functions surface CAD Fixer also
does not use.

`WORKER RUNTIME REQUIREMENT: NOT REQUIRED`

## R1.4 `_headers` — the decisive gate

[Workers Static Assets → Headers](https://developers.cloudflare.com/workers/static-assets/headers/)
supports a `_headers` file placed in the static asset directory, with **100
header rules** and **2,000 characters per line** — numerically identical to the
Pages limits Stage 5C-1A qualified. The
[Pages→Workers migration guide](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
confirms `_headers` and `_redirects` are _supported natively in Workers with
static assets_, handled by Wrangler without an `.assetsignore` entry.

So `apps/web/public/_headers` remains the correct location: Vite copies it into
`dist/`, and Wrangler consumes it as configuration rather than uploading it as
an asset.

### The Worker-code caveat — VERIFIED, and structurally inapplicable here

The same page states:

> Custom headers defined in the `_headers` file are not applied to responses
> generated by your Worker code, even if the request URL matches a rule defined
> in `_headers`.

> If you use a server-side rendered (SSR) framework, have configured
> `assets.run_worker_first`, or otherwise use a Worker script, you will likely
> need to attach any custom headers you wish to apply directly within that
> Worker script.

**This is exactly the failure mode that would silently destroy cross-origin
isolation**, and it is worth being blunt about why: a Worker that returns a
response bypasses `_headers`, so COOP and COEP would quietly stop being sent,
`crossOriginIsolated` would become `false`, `SharedArrayBuffer` would disappear,
and conservative repair would fail closed **in production only** — the precise
failure class Stage 5B exists to prevent.

CAD Fixer is immune to it only because it ships no Worker code. That immunity is
a property of the architecture, not a guarantee from the platform, so it is
frozen as a design principle:

> **CAD Fixer's release-critical static asset requests must not pass through
> custom Worker code.** No `fetch()` handler, and `run_worker_first` is not to be
> enabled — availability is not a reason to use it. Introducing Worker code
> would move the isolation headers out of `_headers` and into JavaScript that no
> existing test asserts.

### Preview/deploy parity

A Worker **version** captures its static assets, and a preview URL serves a
version through the same asset path as production, so `_headers` is expected to
apply identically. The documentation does not state preview-specific header
behaviour either way. Classified honestly:

`_headers ON DEPLOY: DOCUMENTED · ON PREVIEW: EXPECTED, REMOTE VERIFICATION REQUIRED`

This costs nothing, because PD07–PD11 already run against the preview URL and
are already the promotion gate. The smoke suite _is_ the proof.

## R1.5 COOP / COEP / CORP

`_headers` sets arbitrary response headers on static asset responses, so the
five required headers are expressible in version-controlled text exactly as they
were under Pages. Nothing about the isolation contract weakens, and the contract
itself is unchanged from §3 and §11.

`COOP / COEP / CORP: PASS (configuration) · crossOriginIsolated: REMOTE VERIFICATION REQUIRED (PD07–PD11)`

## R1.6 WASM MIME

Wrangler derives an asset's MIME type from its **file extension**, and the
[Direct Uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
API allows an explicit `Content-Type` per file part where an override is needed
— so a correct type is derivable and, in the worst case, forceable.

Separately, a
[2025-08-25 changelog entry](https://developers.cloudflare.com/changelog/2025-08-25-workers-assets-javascript-content-type/)
records that JavaScript assets are now served as `text/javascript` rather than
`application/javascript`. Both are valid JavaScript MIME types for module
workers, so this does not affect CAD Fixer.

What is **not** documented anywhere we can find is the literal string Workers
sends for `.wasm`. Per §8 of the task, and consistent with Stage 5C-1A which
declined to claim this for any provider:

`WASM MIME: DOCUMENTATION QUALIFIED / REMOTE VERIFICATION REQUIRED`

`X-Content-Type-Options: nosniff` is in the header set, which makes a wrong
`.wasm` type a loud failure rather than a quiet one — the right way round.

## R1.7 Browser module workers — and a naming hazard

CAD Fixer ships four **browser Web Workers** (`geometry`, `export`,
`hole-fill`, `self-intersection`) as hashed `.js` files. These are **static
JavaScript assets fetched by the browser**. They are **not Cloudflare Workers**,
they do not run on Cloudflare's edge, and they are not billed as Worker
invocations.

The collision of names is a genuine hazard for anyone reading a future
configuration file: `wrangler.jsonc` will contain the word "Worker" meaning the
Cloudflare compute unit, while `apps/web/src/workers/` means the browser
threads that hold authoritative geometry. **They are unrelated concepts and the
deployment must never be reasoned about as if they were the same thing.**

Served as ordinary static assets with a JavaScript content type, module workers
qualify: `PASS`.

## R1.8 Static asset billing

[Billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/):

> Requests to static assets are free and unlimited. Requests to the Worker
> script (for example, in the case of SSR content) are billed according to
> Workers pricing.

and _There is no additional cost for storing Assets._

Billable Worker invocation occurs when a request does **not** match a static
asset and a Worker script exists, or when `run_worker_first` routes a path to
the Worker. **CAD Fixer has no Worker script and will not enable
`run_worker_first`, so every request it serves falls in the free, unlimited
class.** This matches the Pages cost finding — free and unlimited static
requests and bandwidth — so the §9 cost table stands unchanged: **$0 at every
MVP traffic level modelled.**

## R1.9 Limits vs the actual artifact

[Platform limits](https://developers.cloudflare.com/workers/platform/limits/):
**20,000 files per version** (Workers Free), **100,000** (Paid), **25 MiB per
individual file**. Measured from `apps/web/dist` at commit `24c701b`:

| Measure             | Including `.map`          | Excluding `.map`               | Free-plan limit | Margin (excl. maps) |
| ------------------- | ------------------------- | ------------------------------ | --------------- | ------------------- |
| File count          | 13                        | 8                              | 20,000          | **0.04 % of limit** |
| Total size          | 8,695,696 B (8.67 MiB)    | 2,569,581 B (2.45 MiB)         | no stated total | n/a                 |
| Largest single file | 4.42 MiB (`index.js.map`) | **1.21 MiB** (Geogram `.wasm`) | 25 MiB          | **20.6× headroom**  |

Even shipping source maps, the largest file (4.42 MiB) sits at 17.7 % of the
25 MiB ceiling and the file count at 0.065 % of 20,000. **No limit is remotely
in play.** The 100-version deployable window (R1.11) is the only Workers limit
that could ever bind, and only after 100 releases.

## R1.10 Preview URLs

[Preview URLs](https://developers.cloudflare.com/workers/configuration/previews/):

> Every time you create a new version of your Worker, a unique static version
> preview URL is generated automatically.

> If Preview URLs have been enabled, they are public and available immediately
> after version creation.

- **Unique per version:** yes.
- **Requires production deployment:** **no** — this is the property Stage 5C
  needs, and it is cleaner than Pages, where a preview is a per-commit _branch_
  deployment rather than a URL attached to an uploadable artifact.
- **Public by default:** **yes.**

That last point deserves precision rather than alarm. A versioned preview URL is
**technically publicly reachable by anyone holding the URL**. It is **not**
equivalent to a public product launch: no custom domain, no announcement, no
indexing incentive, no promotion. Treating "reachable" as "released" would be as
wrong as treating it as "private".

Cloudflare Access can require sign-in before a preview URL is served, and
preview URLs can be disabled entirely. **Documented as available and
deliberately NOT configured now** — that is a Stage 5C-1B decision, and for a
technical preview of a static tool the balance may well favour leaving them
open.

`PREVIEW URLS: PASS`

## R1.11 Version identity

[Versions and deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/):
a version captures

> the complete state of your Worker at a point in time: its bundled code, static
> assets, bindings, and compatibility settings

with a unique identifier plus creation metadata.

Compared with a Pages deployment, which is a build output tied to a commit, a
Workers version additionally captures **configuration** in the same immutable
unit. For CAD Fixer that means `_headers` — the isolation contract itself — is
part of the versioned artifact rather than adjacent to it, so a rollback cannot
restore old assets under new header configuration.

```
Git commit → deterministic build → dist/ → Worker version (ID) → preview URL
```

`VERSION IDENTITY: STRONGER THAN PAGES` — same commit-to-artifact traceability,
plus configuration inside the immutable unit.

One caveat worth recording rather than discovering later: **only the last 100
uploaded versions can be deployed**, and rollback reaches only the 100 most
recently published versions. At CAD Fixer's release cadence this is not a
constraint, but it is a real boundary and it is not a boundary Pages states.

## R1.12 Upload separated from production deployment

[Deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/):

- `npx wrangler versions upload` — creates a version **without** deploying it.
- `npx wrangler versions deploy` — deploys a chosen already-uploaded version.
- `npx wrangler deploy` — the _default_, which creates **and** immediately
  deploys a version to 100 % of traffic.

> You can decouple them so that uploading a version and deploying it are
> independent actions.

**This is precisely the workflow Stage 5C-1A asked for and Pages does not
natively express.** Pages builds a preview deployment and promotes it; Workers
lets us upload an artifact, address it, smoke it, and then deploy _that exact
version_. The distinction matters because the thing promoted is the thing
tested, by identity.

**`wrangler deploy` must not be the release command.** Its immediate-100 %
behaviour is the one shape Stage 5C is designed to avoid.

`UPLOAD/DEPLOY SEPARATION: PASS`

## R1.13 Rollback

[Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/):

> Rolling back to a previous version of your Worker will immediately create a
> new deployment with the version specified and become the active deployment.

- **No rebuild required** — PASS.
- **Immediate** — PASS.
- **Static assets and configuration are tied to the version**, so a rollback
  restores the assets _and_ the headers together — PASS.
- Reachable via `wrangler rollback` or the dashboard.
- Limit: the **100 most recently published versions**.
- The documented binding hazards (KV/D1/R2/Durable Object resources changing
  between versions) are **inapplicable** — CAD Fixer declares no bindings.

Worth noting for anyone who works on this repository: rollback **creates a new
deployment** rather than reactivating an old one. That is structurally the same
decision CAD Fixer made for its own undo — `docs/adr/0011-repair-undo-revisions.md`,
"undo produces a NEW, higher revision" — and for the same reason: identity moves
forward so that staleness is always decidable. Pages' model (promote a retained
deployment) is equally safe in practice; Workers' is the one this codebase
already reasons in.

`ROLLBACK: PASS — equal to Pages in capability, better in that configuration rolls back with the assets`

## R1.14 Gradual deployments — NOT NEEDED

`wrangler versions deploy` supports splitting traffic below 100 %.
**Recommendation: do not use it for the MVP.** CAD Fixer has no server state and
no backend to drain; rollback is instant; and a split deployment means two
versions serving differently-hashed assets against one HTML shell, which is a
cache-coherence problem invented for no benefit. `NOT ENABLED.`

## R1.15 Custom domain — the one place Workers is NARROWER than Pages

[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/):

> Custom Domains allow you to connect your Worker to a domain or subdomain,
> without having to make changes to your DNS settings or perform any certificate
> management.

> Cloudflare will create DNS records and issue necessary certificates on your
> behalf.

TLS is automatic (an Advanced Certificate on the target zone). Operationally
this is **simpler** than Pages, because the DNS record is created for us.

**But there is a genuine asymmetry, and it must not be buried.** The migration
guide states:

> Workers does not support any domain whose nameservers are not managed by
> Cloudflare

— a limitation Pages does not share, since a Pages project can be reached by
`CNAME` from a domain hosted elsewhere. The custom-domain page reinforces it:
a Custom Domain cannot be created on a zone you do not own or on a hostname with
an existing `CNAME`.

**Impact on CAD Fixer: none today, and it is a constraint on a decision not yet
made.** §14 established that no domain is documented anywhere in the repository.
So this is not migration cost; it is an input to domain selection:

`PUBLIC DOMAIN SELECTION REQUIRED BEFORE FINAL PROMOTION — AND THE CHOSEN DOMAIN MUST USE CLOUDFLARE NAMESERVERS`

If a future requirement forces a domain that must keep third-party nameservers,
that is the one scenario in which Pages would have been the better choice, and
it should be raised before a domain is bought rather than after. **No DNS change
is made or proposed now.**

## R1.16 Git integration — recommended model

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) connects
a GitHub repository, builds on push, and creates versions. Two findings decide
the shape:

1. It is possible to **disable automatic deployments while still building and
   saving versions**, without promoting them to an active deployment.
2. The **default deploy command for non-production branches is already
   `npx wrangler versions upload`** — upload without deploy.

So the controlled-promotion model Stage 5C-1A recommended is not something we
have to fight the platform for; it is a supported configuration:

```
reviewed commit
  → Workers Builds: npm ci → npm run build
  → wrangler versions upload      (immutable version, NOT deployed)
  → versioned preview URL
  → PD01–PD40 against that URL
  → rollback rehearsal
  → wrangler versions deploy <that exact version ID>
  → PD re-smoke against production
```

**Automatic production deployment on push remains NOT RECOMMENDED**, for the
reason §12 already gave and which platform support does not change: promotion
should be a deliberate act after smoke, so no unreviewed commit can become the
public site. Git integration supporting it is not an argument for enabling it.

This is also strictly better than the Pages plan in §12, which promoted a
_preview deployment_; here we deploy a _version by ID_, and the identity is
explicit.

## R1.17 Wrangler requirement

Workers Static Assets is a Wrangler-deployed product; there is no dashboard
drag-and-drop equivalent in the recommended flow, and
[build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
states Workers Builds _will use the Wrangler version set in your `package.json`_.

**Stage 5C-1B will therefore need `wrangler` as a pinned repository
`devDependency`.** Recorded honestly against `CLAUDE.md` rule 15 (_keep
dependencies minimal_), because it is a real addition and should be argued for
rather than slipped in:

- It is **build/release tooling**, not a runtime dependency. It appears in no
  bundle, ships no byte to a browser, and is imported by no source file.
- It is the **only** supported way to produce the versioned, separately-deployed
  artifact that R1.12 identifies as the reason to choose this platform.
- Pinning it in `package.json` is what makes the CI build reproducible; leaving
  it to `npx` floating latest would make the release pipeline non-deterministic,
  which the Stage 5B reproducible-build finding exists to prevent.
- It requires a licence check and a `docs/DEPENDENCIES.md` entry under
  `CLAUDE.md` rule 16 **before** installation.

**NOT INSTALLED IN THIS CORRECTION. No dependency, lockfile or manifest was
changed.** Pages would have needed the same tool for equivalent control, so this
is not a cost Workers uniquely imposes.

## R1.18 Routing — default behaviour is exactly what CAD Fixer wants

`not_found_handling` defaults to **`"none"`**
([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)),
with `"single-page-application"` and `"404-page"` as opt-in alternatives.
`html_handling` defaults to `"auto-trailing-slash"`.

CAD Fixer has **no router**, so the §11 routing contract is satisfied by the
defaults with no configuration at all:

```
/                 → index.html
/assets/<hashed>  → that exact asset
/missing.js       → 404
/random-route     → 404
```

**SPA fallback must NOT be enabled.** §11 gave the reason and it is unchanged:
a shell returned under a JavaScript content type is a confusing failure instead
of a clear one. Cloudflare supporting `"single-page-application"` is not a
reason to set it. `ROUTING: PASS by default.`

## R1.19 Cache policy

Workers Static Assets default: assets are served cacheable **but requiring
revalidation**, accompanied by an **`ETag`** whose value is a hash of the file —
a conservative default that never serves a stale shell. Headers defined in
`_headers` override what Cloudflare ordinarily sends, and Cloudflare's own
guidance for fingerprinted assets is `Cache-Control: public, max-age=31556952,
immutable`.

The Stage 5B contract is therefore expressible unchanged: `index.html`
revalidated, `/assets/*` immutable. We keep `max-age=31536000` rather than
Cloudflare's `31556952` — both are "a year", and the existing value is what
`scripts/release-server.mjs` already asserts. **Never immutable on HTML.**

`CACHE POLICY: PASS`

## R1.20 Source maps — recommendation for Stage 5C-1B

`apps/web/vite.config.ts:38` sets `sourcemap: true`, and `dist/` contains **five
`.map` files totalling 6,526,115 B (6.22 MiB)** — **71.7 % of the 8.67 MiB
build**, against 2.45 MiB of assets users actually need.

**Recommendation: do not publish `.map` files in the initial public
deployment.** Reasoning, with the weak argument named and discarded:

- **Not a security measure.** The repository is public; the source is already
  readable. Withholding maps reveals nothing and would be security by obscurity
  if claimed as protection. It is not claimed.
- **It is a transfer argument.** Serving maps would nearly quadruple deployment
  size for bytes no user requests during normal operation.
- **Debugging value is retained**, because maps stay reproducible: the build is
  deterministic (Stage 5B), so a map for any released commit can be regenerated
  locally on demand.

**Not changed here**, per the task's instruction not to alter build behaviour in
a research correction. Stage 5C-1B should implement it as a release-build
decision — the cleanest form being an `.assetsignore` entry excluding `*.map`
from asset upload, which leaves `sourcemap: true` and local debugging intact
while keeping maps off the CDN. That mechanism is Workers-specific and should be
verified against current docs when implemented.

## R1.21 CSP — prior result retained

Unchanged: **defer to a post-MVP hardening stage.** Workers Static Assets
introduces **no third-party application script execution** — with no Worker
script, no Functions and no injected runtime, nothing executes that §13 did not
already account for. The deferral remains conditional on no third-party script,
embed or external asset being introduced. `nosniff` and `Referrer-Policy:
no-referrer` remain recommended now.

## R1.22 Pages → Workers migration assessment

The [migration guide](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
describes static-only migration as _often a straightforward process_: add a
`wrangler.jsonc` pointing `assets.directory` at the build output, keep `_headers`
where it is, and no `main` is needed.

**Question posed: would launching on Pages now create avoidable future migration
work? Answer: yes — a small amount, and it is entirely avoidable today.**

Being precise rather than dramatic, launching on Pages would later cost:

| Migration step      | Cost                                          |
| ------------------- | --------------------------------------------- |
| Build config        | Trivial — add `wrangler.jsonc`                |
| `_headers`          | **Zero** — file is unchanged                  |
| Application source  | **Zero**                                      |
| CI/Git integration  | Reconnect the repository to a Workers project |
| Deployment identity | Deployment history does not carry over        |
| **Custom domain**   | **DNS cutover on the live public domain**     |

Only the last row is materially unpleasant, and only because it would land on a
**live public domain with users on it** rather than on a preview URL. Everything
else is minutes of work.

The honest summary: **migration from Pages would not be difficult, but it would
be entirely unnecessary**, and the one step with real risk is the one you cannot
rehearse safely after launch. Starting on Workers makes that step never happen.
This weighs toward Workers without needing to be exaggerated.

## R1.23 Workers Static Assets vs Pages scorecard

All results from Cloudflare documentation consulted 2026-09-11.

| Criterion                               | Workers Static Assets                                                     | Pages                                                |
| --------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| Cloudflare-recommended for new projects | **PASS** — _"Start new projects with Workers"_                            | **FAIL** — supported, explicitly not preferred       |
| Pure static hosting, no runtime code    | **PASS** — `main` optional for assets-only Workers                        | PASS                                                 |
| `_headers`                              | PASS — 100 rules, 2,000 chars/line                                        | PASS — identical limits                              |
| COOP                                    | PASS (config) · PD07–PD11 remote proof                                    | PASS (config)                                        |
| COEP                                    | PASS (config) · PD07–PD11 remote proof                                    | PASS (config)                                        |
| CORP                                    | PASS (config)                                                             | PASS (config)                                        |
| WASM MIME                               | NOT VERIFIED — extension-derived, overridable on upload                   | NOT VERIFIED — overridable                           |
| Browser module workers                  | PASS — static JS, `text/javascript`                                       | PASS                                                 |
| Preview URLs                            | **PASS** — unique per version, no production deploy required              | PASS — per-commit branch deployment                  |
| Immutable deployment identity           | **PASS** — code + **assets + configuration** in one version ID            | PARTIAL — build output per commit; config adjacent   |
| Separate upload vs production deploy    | **PASS** — `versions upload` / `versions deploy`                          | PARTIAL — build-then-promote, not artifact-addressed |
| Rollback                                | PASS — instant, no rebuild, config rolls back too; last 100 versions      | PASS — instant revert, no rebuild                    |
| Custom domain                           | PARTIAL — automatic DNS + cert, **requires Cloudflare nameservers**       | **PASS** — also works via CNAME from external DNS    |
| TLS                                     | PASS — automatic Advanced Certificate                                     | PASS — automatic                                     |
| Caching                                 | PASS — revalidate + `ETag` default, `_headers` overrides                  | PASS                                                 |
| Git integration                         | **PASS** — auto-deploy disableable; non-prod default is `versions upload` | PASS — preview + manual promotion                    |
| Static bandwidth / request cost         | **PASS** — _"free and unlimited"_, no storage cost                        | PASS — free and unlimited                            |
| Operational complexity                  | PASS — one config file, no entrypoint                                     | PASS — slightly less tooling, less control           |
| Future platform direction               | **PASS** — the platform receiving investment                              | PARTIAL — maintained, not the strategic surface      |
| Provider lock-in                        | PASS — `dist/` portable; `_headers` is a portable convention              | PASS — identical                                     |
| Migration risk                          | **PASS** — none pending                                                   | PARTIAL — a known, small, avoidable future move      |

Workers is ahead on six criteria, equal on thirteen, and behind on exactly one
(custom domain nameserver requirement).

## R1.24 Corrected provider decision

### Primary: **Cloudflare Workers Static Assets** — Outcome A

**This supersedes the Stage 5C-1A recommendation of Cloudflare Pages.** The
Pages analysis above is retained and was not wrong; it is superseded because the
platform question it answered was narrower than the one that mattered.

The §25 decision rule is satisfied on all three premises, each verified rather
than assumed:

1. Cloudflare explicitly recommends Workers for new projects — **verified**
   on the Pages overview, updated 2026-08-25.
2. Workers provides equal-or-better version preview and rollback — **verified**;
   preview URLs are per-version without deployment, and a version captures
   configuration alongside assets.
3. Workers does not require an unnecessary runtime backend — **verified**;
   `main` is optional for assets-only Workers.

And every CAD Fixer hard requirement is met: cross-origin isolation
configurable in version-controlled text; preview before production; instant
rollback without rebuild; static-only architecture with no server runtime;
correct module-worker delivery with `.wasm` type derived from extension and
overridable; $0 at MVP scale; and controlled promotion by version ID.

The decision is **not** "Workers because it is newer". It is Workers because
**artifact-addressed promotion** — upload a version, smoke _that_ version,
deploy _that exact version ID_ — is a materially better release model for a tool
whose isolation headers are load-bearing, and because starting on the surface
Cloudflare tells new projects to avoid would be knowingly buying a future DNS
cutover on a live domain for no benefit.

### Fallback: **Netlify** — unchanged

Stage 5C-1A's Netlify qualification is **retained and not re-researched**; this
correction found nothing that bears on it. Netlify remains the non-Cloudflare
fallback: same `_headers` mechanism, same capability set, credit-based cost.
Vercel remains capable but carries the Hobby-plan non-commercial restriction
that §8 documented against a product intended to be commercial.

**Cloudflare Pages is now third**, not disqualified. If anything in Stage 5C-1B
makes Workers unworkable — most plausibly a custom-domain constraint from
R1.15 — Pages remains fully qualified and Stage 5C-1A's plan for it is intact
and directly usable.

## R1.25 Corrected Stage 5C-1B architecture

```
reviewed Git commit on stage branch
        ↓
npm ci                                   (lockfile authoritative)
        ↓
npm run build                            (Node 22.22.2)
        ↓
apps/web/dist                            (8 assets + _headers; maps excluded)
        ↓
wrangler versions upload                 (immutable version — NOT deployed)
        ↓
Worker version ID + versioned preview URL
        ↓
PD01–PD40 smoke against the preview URL
  PD07–PD11 (COOP/COEP/CORP/crossOriginIsolated/SharedArrayBuffer) = promotion gate
        ↓
rollback rehearsal
        ↓
wrangler versions deploy <that exact version ID>
        ↓
PD re-smoke against production
        ↓
custom domain (Cloudflare-nameserver domain) — later, separate decision
```

Commands are recorded as documentation research, derived from current Cloudflare
docs. **None was executed and none is to be executed before Stage 5C-1B
approval.**

## R1.26 Minimal Cloudflare configuration — PROPOSAL ONLY, NOT COMMITTED

`wrangler.jsonc` is Cloudflare's recommended format for new projects (_"Cloudflare
recommends using `wrangler.jsonc` for new projects"_). The minimum this product
needs, using only fields verified to exist in the current schema:

```jsonc
{
  "name": "cad-fixer",
  "compatibility_date": "2026-09-11",
  "assets": {
    "directory": "./apps/web/dist",
  },
}
```

That is the whole file. Deliberately absent, each for a stated reason:

| Omitted                                 | Why                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `main`                                  | Optional for assets-only Workers; adding it creates the Worker-code path that bypasses `_headers` |
| `run_worker_first`                      | Would route requests through Worker code — forbidden by R1.4                                      |
| `not_found_handling`                    | Default `"none"` is already the required 404 behaviour                                            |
| `html_handling`                         | Default `"auto-trailing-slash"` is correct for a single route                                     |
| `assets.binding`                        | Only needed to read assets from Worker code; there is none                                        |
| KV / D1 / R2 / DO / secrets / Functions | CAD Fixer has no server state of any kind                                                         |

No field above is invented; each is documented in the current Wrangler
configuration reference. **The exact `directory` path and the
`compatibility_date` must be confirmed against the repository root Wrangler
runs from at Stage 5C-1B**, and this file is **not committed in 5C-1A-R1** —
§53's prohibition on speculative provider configuration applies to Workers
exactly as it applied to Pages.

## R1.27 `_headers` proposal

Unchanged from §11, because the mechanism and its limits are identical. For
`apps/web/public/_headers`, which Vite copies into `dist/` and Wrangler consumes
as configuration:

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

Syntax verified against the current Workers `_headers` documentation: path
pattern on its own line, headers indented beneath, `Name: value`. Well within
100 rules and 2,000 characters per line. `scripts/release-server.mjs` already
encodes this exact contract and the Stage 5B suites assert against it, so the
_behaviour_ is qualified even though the provider file is not yet written.

**Not committed in this correction.**

## R1.28 What changed, and what did not

**Changed:** the target Cloudflare product surface (Pages → Workers Static
Assets); the deployment model (promote a preview deployment → deploy a version
by ID); the Stage 5C-1B tooling requirement (`wrangler` devDependency); and one
new constraint on domain selection (Cloudflare nameservers).

**Unchanged:** the application, the build, the header contract, the MIME
contract, the cache contract, the routing contract, the privacy position, the
CSP deferral, the PD01–PD40 plan, the rollback rehearsal, the failure policy,
the version tag and the Technical Preview positioning.

`docs/release/PRODUCTION_HOSTING_REQUIREMENTS.md` is **not modified**: this
correction surfaced no new _provider-independent_ requirement. Everything
learned here is provider-specific configuration and belongs in this Stage 5C
document, which is where it now lives.

## R1.29 What the user must authorize (corrected)

1. A **Cloudflare account** (free) and a **Workers** project — not a Pages
   project.
2. **GitHub authorization** for Workers Builds to read the repository.
3. Approval to add **`wrangler` as a pinned devDependency**, with a licence
   check and a `docs/DEPENDENCIES.md` entry first.
4. A **domain decision**, now carrying the constraint that the domain must use
   Cloudflare nameservers.

Authorization must happen through Cloudflare's own browser flow. **No API token
should be pasted into this conversation**, and none is needed for the
recommended model.

`NO DEPLOYMENT PERFORMED. NO CLOUDFLARE AUTHORIZATION PERFORMED.`
