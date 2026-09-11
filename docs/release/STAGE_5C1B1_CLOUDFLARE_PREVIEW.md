# Stage 5C-1B1 — Cloudflare Workers Static Assets: tooling, bootstrap configuration and controlled preview

**Status: LOCAL WORK COMPLETE AND QUALIFIED. REMOTE BOOTSTRAP NOT REACHED.**

Stage 5C-1B1 stopped at its own §22 authorization hold point: the Cloudflare
OAuth flow was started and **timed out waiting for the authorization code**, so
no Cloudflare account was authenticated, no Worker was created and no version
was uploaded. Everything that does not require a provider account is finished,
green, committed and reproducible. The remainder resumes at one command.

**Deployed source SHA (the tree the first upload is to be made from):**
`97e82512f5f7114ee428a6fe80d101a8a7d46cca`

**Stage branch:** `stage-5c1b1-cloudflare-preview`, cut from
`main @ 2dbb6641b4d17a5d63cf00b053e563cb8b4f49da`.

`NO DEPLOYMENT PERFORMED. NO CLOUDFLARE AUTHORIZATION PERFORMED. NO CUSTOM
DOMAIN OR DNS CONFIGURED.`

## 1. Baseline before any change

| Gate                       | Result                       |
| -------------------------- | ---------------------------- |
| `npm run verify`           | PASS — 97 files, 2,137 tests |
| `npm run test:e2e`         | PASS — 172 passed, 2 skipped |
| `npm run test:e2e:timing`  | PASS — 11 passed             |
| `npm run test:e2e:harness` | PASS — 77 passed             |
| `npm run build`            | PASS                         |
| Kernel SHA-256             | `507ea5e7…3399fc3` unchanged |

Every figure matched the expected Stage 5C-1B1 baseline exactly.

## 2. Current-documentation gate

Re-checked against Cloudflare's own documentation before installing anything.
All six premises the bootstrap architecture depends on hold:

| #   | Premise                                                        | Result                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `versions upload` cannot create a brand-new Worker             | **CONFIRMED** — _"You must use C3 or wrangler deploy the first time you create a new Workers project. Using `wrangler versions upload` the first time you upload a Worker will fail."_                  |
| B   | `workers_dev: false` disables the stable `*.workers.dev` route | **CONFIRMED** — _"the `workers.dev` route will be disabled"_                                                                                                                                            |
| C   | `preview_urls` is independently configurable                   | **CONFIRMED** — _"Preview URLs default to matching your `workers_dev` setting unless explicitly configured."_                                                                                           |
| D   | A version gets a preview URL without being deployed            | **CONFIRMED** — _"Every time you create a new version of your Worker, a unique static version preview URL is generated automatically."_ Format `<VERSION_PREFIX>-<WORKER_NAME>.<SUBDOMAIN>.workers.dev` |
| E   | No route or custom domain is required for a preview            | **CONFIRMED** — preview URLs are independent of production deployment                                                                                                                                   |
| F   | Static assets are served without invoking Worker code          | **CONFIRMED** — _"that file will be served — without invoking Worker code"_, and _"The `main` key is optional for assets-only Workers."_                                                                |

**Premise C is the one that would have bitten us silently.** `preview_urls`
defaults to the value of `workers_dev`. Setting `workers_dev: false` and
omitting `preview_urls` would have produced a Worker with **no reachable
surface at all** — no production route, and no preview URL either. It is set
explicitly for that reason, and CF04 asserts it.

## 3. Wrangler

|                  |                                                                  |
| ---------------- | ---------------------------------------------------------------- |
| Version          | **4.131.1**, pinned EXACTLY (no caret)                           |
| Licence          | **MIT OR Apache-2.0** — permissive, dual, no copyleft obligation |
| Node requirement | `>=22.0.0`; repository pins 22.22.2                              |
| Location         | root `devDependencies`                                           |
| Classification   | **development / deployment tooling only**                        |

Pinned exactly rather than with a range because a release pipeline whose tool
floats is not a reproducible release pipeline. 4.131.1 was published the same
day it was selected, so its behaviour was **validated empirically** — schema
introspection plus a dry run — rather than trusted on age.

**Telemetry disabled.** Wrangler collects anonymous usage telemetry by default.
It concerns CLI usage rather than user geometry, so it is not a breach of the
product's privacy guarantee — but a repository that bans network APIs repo-wide
should not quietly run a phoning-home build tool. Disabled with
`wrangler telemetry disable`.

No Cloudflare runtime package was installed: no `@cloudflare/workers-types`, no
KV/D1/R2 client, no Worker framework.

### Two dependency findings, recorded rather than rounded away

**One LGPL package, in tooling only.** A whole-tree licence scan finds
`wrangler → miniflare → sharp → @img/sharp-libvips-darwin-arm64`, LGPL-3.0-or-later.
`CLAUDE.md` rule 17 requires evaluation rather than reflex: it is not in
`apps/web/dist`, it is not redistributed, and it arrives through Wrangler's
**local dev simulator**, which the deployment path does not use. No obligation
attaches to the product. Full reasoning in `docs/DEPENDENCIES.md`.

**Two moderate advisories, pre-existing.** `npm audit` reports 2 moderate
advisories in `vitest` / `@vitest/mocker` 4.1.10. The lockfile pinned that exact
version before and after, and `wrangler` does not depend on `vitest`, so they
**predate this change and are unrelated to it**. `docs/DEPENDENCIES.md` now
records them instead of carrying a stale "0 vulnerabilities" claim.

## 4. Configuration — `wrangler.jsonc` (repository root)

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "cad-fixer",
  "compatibility_date": "2026-09-11",
  "workers_dev": false,
  "preview_urls": true,
  "assets": {
    "directory": "./apps/web/dist",
    "run_worker_first": false,
  },
}
```

**Every field was validated against the pinned Wrangler's own
`config-schema.json`**, not copied from a documentation example:
`name` string, `compatibility_date` string, `workers_dev` boolean,
`preview_urls` boolean, `assets.directory` string,
`assets.run_worker_first` boolean-or-array.

Deliberately absent: `main`, `routes`, `route`, `assets.binding`, `vars`,
secrets, `kv_namespaces`, `d1_databases`, `r2_buckets`, `durable_objects`,
`queues`, `triggers`, `services`, `observability`.

`run_worker_first: false` is the default and is stated anyway, so that changing
it is a visible change in a diff rather than an omission nobody reviews.

## 5. Static-only architecture — why this is load-bearing

```
Cloudflare Worker runtime application handler: NONE
```

There is no `main`, and no `worker.ts`, `worker.js`, `src/worker.ts`,
`src/index.ts` or `_worker.js` exists anywhere — asserted from both the config
and the filesystem by CF02.

The reason is not minimalism. **Cloudflare does not apply `_headers` to
responses generated by Worker code.** A Worker entrypoint would therefore stop
COOP and COEP being sent, the browser would withhold `SharedArrayBuffer`, and
conservative repair would fail closed — **in production only**, which is exactly
the failure class Stage 5B exists to prevent. Nothing in the type system can
catch that, which is why CF02 and CF06 exist.

## 6. `_headers`

Source `apps/web/public/_headers`; Vite copies it to `apps/web/dist/_headers`,
verified by CF17 byte-for-byte.

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

Identical to the contract `scripts/release-server.mjs` already encodes and the
Stage 5B suites already assert. No CSP — Stage 5C-1A deferred it deliberately,
and CF16 refuses one added by accident.

### `_headers` is configuration, not a public asset — resolved empirically

A `--dry-run` with debug logging shows Wrangler's own decision:

```
Ignoring asset: .assetsignore
Ignoring asset: _headers
```

Wrangler withholds `_headers` from the public asset set **on its own**, while
still consuming it as static-asset configuration. It is therefore deliberately
**NOT** listed in `.assetsignore`, and CF18 asserts that it never is — listing
it would risk a future reader concluding it is optional.

## 7. Source-map exclusion

`apps/web/public/.assetsignore` contains exactly one rule: `*.map`.

Confirmed by the same dry run — all five maps reported as
`Ignoring asset:`. The build is untouched: `sourcemap: true` remains set, maps
are still produced for local debugging, and **two consecutive builds produce
byte-identical runtime assets**.

|                                    | Files | Bytes                    |
| ---------------------------------- | ----- | ------------------------ |
| Source maps excluded from upload   | 5     | 6,526,115 (6.22 MiB)     |
| Provider configuration, not served | 2     | 2,018                    |
| **Deployable**                     | **8** | **2,569,581 (2.45 MiB)** |

Excluding maps removes **71.7 %** of the build directory. This is a transfer
decision, not a security one: the repository is public and the build is
reproducible, so a map for any released commit can be regenerated locally.

## 8. Release artifact manifest

`scripts/release-manifest.mjs` → `artifacts/release/release-manifest.json`
(gitignored). Node core modules only — a release-verification tool that needs a
dependency tree can be compromised by one.

Records the source commit, whether the working tree was clean, every deployable
file with SHA-256 and size, every exclusion **with its reason**, and the kernel
hash. Contains no absolute path, user name, host name or environment value. It
is written **outside** the asset directory, so it is never uploaded and cannot
become self-referential.

It reports a dirty tree explicitly rather than describing a commit it was not
built from. The recorded manifest was generated from a **clean** tree at
`97e82512f5f7114ee428a6fe80d101a8a7d46cca`.

### Deployable inventory

| File                                          | Bytes     |
| --------------------------------------------- | --------- |
| `assets/self-intersection-DH0HBovf.wasm`      | 1,272,716 |
| `assets/index-X0_DrFIY.js`                    | 933,619   |
| `assets/geometry.worker-B0TRQnh6.js`          | 143,004   |
| `assets/hole-fill.worker-5KWd2-9h.js`         | 82,794    |
| `assets/export.worker-C64QFa64.js`            | 65,348    |
| `assets/self-intersection.worker-DwfIxclc.js` | 50,939    |
| `assets/index-CY7q0NMc.css`                   | 20,641    |
| `index.html`                                  | 520       |

8 files, 2,569,581 bytes, largest 1.21 MiB — against Cloudflare's free-plan
limits of 20,000 files and 25 MiB per file. No test, fixture, corpus, benchmark,
report, source map, debug dump or environment file is in the set.

The shipped WASM's SHA-256 is `507ea5e7…3399fc3` — **identical to the qualified
kernel artifact**, so the deployable set carries the exact kernel Stage 3C-1B
qualified.

## 9. CF01–CF20 deployment contract tests

`scripts/cloudflare-deployment.test.ts`, 21 assertions, all passing, running in
the ordinary unit suite. They read **configuration**, not a build, so they
cannot silently pass when `dist` is absent.

| ID        | Asserts                                                                    |
| --------- | -------------------------------------------------------------------------- |
| CF01      | `wrangler.jsonc` parses; name and compatibility date well-formed           |
| CF02      | no `main`, and no Worker source file exists on disk                        |
| CF03      | `workers_dev === false`                                                    |
| CF04      | `preview_urls === true` (explicitly, not inherited)                        |
| CF05      | `assets.directory === './apps/web/dist'`                                   |
| CF06      | `run_worker_first === false`, and cannot be `true` or an array             |
| CF07      | no `route`, `routes` or custom domain                                      |
| CF08      | none of 19 binding/resource keys; no assets binding                        |
| CF09–CF13 | the five header values, exactly                                            |
| CF14      | HTML is `no-cache` and never `immutable`                                   |
| CF15      | `/assets/*` is `public, max-age=31536000, immutable`                       |
| CF16      | no Content-Security-Policy                                                 |
| CF17      | the build copies `_headers` byte-for-byte                                  |
| CF18      | `.assetsignore` excludes `*.map`, never `_headers`, never JS/CSS/WASM/HTML |
| CF19      | runtime assets present and referenced by the shell                         |
| CF20      | the qualified kernel artifact is present                                   |

Plus one assertion that the five global headers apply to `/*` in exact order.

## 10. Regression after all changes

| Gate                       | Result                                           |
| -------------------------- | ------------------------------------------------ |
| `npm run verify`           | PASS — 98 files, **2,158 tests** (2,137 + 21 CF) |
| `npm run test:e2e`         | PASS — 172 passed, 2 skipped                     |
| `npm run test:e2e:timing`  | PASS — 11 passed                                 |
| `npm run test:e2e:harness` | PASS — 77 passed                                 |
| `npm run build`            | PASS                                             |
| Kernel SHA-256             | `507ea5e7…3399fc3` unchanged                     |

No threshold was weakened and no test loosened. Two genuine defects in the new
test file were fixed at the cause rather than suppressed: a JSONC parser that
rejected the trailing commas Prettier writes and Wrangler accepts, and two
`noUncheckedIndexedAccess` violations.

### Build reproducibility

Two consecutive builds produced identical names and identical SHA-256 for every
runtime asset. Source-map exclusion changed no runtime byte — the hashes match
the pre-change build exactly.

## 11. Where this stopped, and why

The §22 authorization hold point was reached with every preceding gate green.
`npx wrangler login` was run; it opened Cloudflare's OAuth consent page and then
**timed out waiting for the authorization code**. `wrangler whoami` confirms
`You are not authenticated`.

Nothing was improvised in response. Specifically **not** done:

- **No API token.** The task permits one only if interactive login is impossible
  and the user explicitly approves, and neither is true.
- **No `wrangler deploy --temporary`.** Wrangler offers a temporary preview
  account that needs no login. It is refused: a Worker on an account the user
  does not control cannot be managed, rolled back or promoted, so it would
  produce a URL that looks like progress and satisfies none of the release
  requirements.
- **No retry loop.**

A project-local `.wrangler/` directory was created and is **empty**; it is
gitignored. No Cloudflare account, Worker, version, deployment, route, domain or
DNS record exists as a result of this stage.

### One disclosure about the OAuth flow

Wrangler's OAuth request asks for a **broad fixed scope set** — including
`workers:write`, `pages:write`, `d1:write`, `zone:read`, `ssl_certs:write`,
`queues:write`, `containers:write` and `email_sending:write`. CAD Fixer needs
essentially one of them (`workers_scripts:write`). The breadth is Wrangler's,
not this project's, and it cannot be narrowed in the CLI flow. It grants the CLI
capability on the account; it changes nothing on its own. Recorded because
approving it is the user's decision and it should be an informed one.

## 12. What remains, and the exact resume point

Everything below is unchanged and ready; none of it has been performed.

```
npx wrangler login                     ← resume here (interactive, user approves)
npx wrangler whoami                    ← record account; STOP if ambiguous
check `cad-fixer` does not already exist
npx wrangler deploy --autoconfig false ← FIRST creation only (see §13)
   ↓
version ID + versioned preview URL
   ↓
remote header / MIME / source-map-404 / missing-asset-404 proof
browser crossOriginIsolated + SharedArrayBuffer + Atomics
basic shell load, lazy WASM, network privacy capture
remote-vs-manifest hash comparison
```

**`--autoconfig false` is required.** `wrangler deploy` enables framework
detection and automatic configuration by default, which can rewrite
`wrangler.jsonc`. Every dry run in this stage used the flag and the config was
verified byte-identical afterwards.

## 13. The first-upload exception — frozen rule

Cloudflare prohibits `wrangler versions upload` for the creation of a new
Worker, so the first bootstrap **must** use `wrangler deploy`. That command is
authorized **once**, and only because:

- the Worker does not yet exist,
- `workers_dev: false` means it creates no stable production route,
- there are no routes and no custom domain,
- `preview_urls: true` means the only reachable surface is the versioned
  preview URL.

**FROZEN FOR ALL LATER CANDIDATES:**

> Once the Worker exists, every subsequent candidate is uploaded with
> `npx wrangler versions upload`. `wrangler deploy` must not be run again — it
> creates _and immediately deploys to 100 % of traffic_, which is precisely the
> promotion Stage 5C is designed to make deliberate.

## 14. Publicness, once the preview exists

To be stated when it does, and stated accurately in advance so it is not
discovered later:

`VERSIONED PREVIEW URL IS INTERNET-REACHABLE BUT HAS NOT BEEN PROMOTED OR
CONNECTED TO A PUBLIC PRODUCT DOMAIN.`

It is not private. Cloudflare Access could gate it and is **not** being enabled
now; whether the added complexity is worth it is a later decision.

## 15. Stage 5C-1B2 eligibility

**NOT YET ELIGIBLE.** Stage 5C-1B2 (full PD01–PD40 against a preview, a second
version via `versions upload`, rollback rehearsal) requires a preview URL that
does not exist. Eligibility begins when §12 completes and its hard gates —
`crossOriginIsolated === true`, `application/wasm`, source-map 404, missing-asset
404 — pass against the real deployment.
