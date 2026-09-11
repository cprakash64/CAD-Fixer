# Stage 5B — Release Candidate Browser, Hosting & Resource Qualification

**Tested commit:** `8a800b5e137602008eced0aef3fd9beee5bcfe9c` (branch
`stage-5b-release-qualification`).
**Tested artifact:** the output of `npm run build`, served under the production
header contract — not a dev server.

| Production asset                       | Size                      |
| -------------------------------------- | ------------------------- |
| `index-X0_DrFIY.js`                    | 933.61 kB (gzip 247.70)   |
| `index-CY7q0NMc.css`                   | 20.64 kB (gzip 4.00)      |
| `geometry.worker-B0TRQnh6.js`          | 143.00 kB                 |
| `hole-fill.worker-5KWd2-9h.js`         | 82.79 kB                  |
| `export.worker-C64QFa64.js`            | 65.34 kB                  |
| `self-intersection.worker-DwfIxclc.js` | 50.93 kB                  |
| `self-intersection-DH0HBovf.wasm`      | 1,272.71 kB (gzip 396.84) |

Geogram artifact SHA-256 `507ea5e7c9110781e4d90ade507d1b37a7b95b2832b055cb59418bca43399fc3`
— unchanged. Rewritten kernel baseline `741e649305424aefd06e0a81ab5aa5de09c59b3a`
reachable; differential green.

## Host

macOS 27.0 (26A5421a), Apple Silicon, **8 GiB RAM**, 37 GiB free disk, Node
v22.22.2, npm 12.0.2. `navigator.hardwareConcurrency` 8, `navigator.deviceMemory`
8 (coarsened). Memory pressure level 2 for much of the session — recorded because
it is the reason some measurements had to be taken single-worker.

## What Stage 5B closed

The four items Stage 5A deferred, plus the hosting contract:

| Deferred item                 | Outcome                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| WebGL / context loss          | **Closed.** BQ01–BQ08, 6 new tests, all passing                                                       |
| High-DPR / viewport resources | **Closed.** BQ09–BQ16, 5 new tests, all passing                                                       |
| Firefox / Safari              | **Answered, not all qualified.** WebKit capability-probed; Firefox could not be launched on this host |
| Host-aware resource policy    | **Decided.** Model C, on evidence — see `RESOURCE_POLICY.md`                                          |
| Production serving headers    | **Closed.** BQ23–BQ29, BQ43–BQ54 under a release-like server                                          |

## Findings

| ID    | Severity          | Finding                                                                                                                                                                                    | Fixed                 | Evidence                                                                |
| ----- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------- |
| 5B-01 | Medium            | `e2e/release-isolation.spec.ts` bound one fixed port from `beforeAll`, which runs **per worker** — four parallel workers raced for it and three tested against a server that never started | **Yes**               | Port now derived from `workerIndex`; 3/3 pass under default parallelism |
| 5B-02 | Low               | `scripts/**/*.mjs` had no ESLint Node-globals block, so the new release server reported `process`/`URL` undefined                                                                          | **Yes**               | `eslint.config.js`; lint clean                                          |
| 5B-03 | Medium (accepted) | No automatic WebGL context restoration; recovery is reload-only                                                                                                                            | No — accepted per §82 | BQ01–BQ08 prove geometry survives and stays exportable                  |
| 5B-04 | Medium (accepted) | Firefox runtime unavailable on this host                                                                                                                                                   | No — environmental    | Two launch attempts, 180 s and 300 s                                    |

**No Critical. No unresolved High.** Both defects found were in Stage 5B's own new
test and lint scaffolding, not in the product — which is itself a result worth
stating plainly: attacking the release candidate's browser, hosting, DPR and
isolation behaviour did not surface a product defect.

## WebGL context loss — BQ01–BQ08

Driven by Chromium's `WEBGL_lose_context` debug extension from test code only.
The extension handle is captured **before** the first loss, because
`getExtension` on an already-lost context returns null — a helper that re-fetched
it could lose a context and never restore it.

| Case                                             | Result                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| BQ01 context lost with a model loaded            | Reported as a display failure; Mesh Health identical; message does not claim the model was lost |
| BQ02 revision after loss                         | **Unchanged.** A display fault consumes no revision                                             |
| BQ03 restore, then export                        | Document identical; STL export byte-exact at `84 + 600 × 50`                                    |
| BQ04/BQ05 loss with a repair preview, then Apply | Apply committed the worker's validated candidate; the preview was never the source              |
| BQ06 loss around Undo                            | Exact restoration of the original mesh across a GPU fault                                       |
| BQ07 GPU counters after restore                  | Disposals never exceed creations; no leak, no double free                                       |
| BQ08 replacement import after a fault            | Works — recovery, not merely survival                                                           |

This is the architectural claim of ADR 0008 tested directly: the render snapshot
is a disposable derivative, so losing the GPU is a display failure and nothing
more.

## DPR and viewport — BQ09–BQ16

| Case                                 | Result                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BQ09–BQ11 DPR 1, 2, 3                | Effective ratio ≤ 2 at every scale factor. **DPR 3 is the case that proves the clamp** — at 1 and 2 a clamped and unclamped renderer are indistinguishable |
| BQ12/BQ13 3840 × 2160 at DPR 1 and 2 | Ratio ≤ 2, ≈33.2 M pixels, under the 40 M envelope                                                                                                         |
| BQ14–BQ16 100 resize cycles          | Backing store tracks the current box, not the largest ever seen; model still drawn (600 triangles, 1 object); no viewport error                            |

## Cross-origin isolation and hosting — BQ23–BQ29, BQ43–BQ54

Against the production build served with the contract headers:

- COOP `same-origin`, COEP `require-corp`, CORP `same-origin` all present on the
  document, and **`crossOriginIsolated === true`** with `SharedArrayBuffer`,
  `Atomics`, `WebAssembly`, `Worker`, `DecompressionStream`, `Blob` and
  `createObjectURL` all available.
- Content types correct for HTML, JS, CSS and the module worker; **no response
  with status ≥ 400 anywhere in the flow**, which is how a COEP misconfiguration
  actually manifests.
- A full import → analyse → export flow made **zero off-origin requests** and
  **no request carried a body at all**.
- **No `.wasm` fetched** before or during import and topology — Geogram stays lazy.

### Fail-closed without the headers — BQ25

Served by `scripts/release-server.mjs --no-isolation`, the same build minus the
three headers:

- `crossOriginIsolated === false`, `SharedArrayBuffer` absent — the browser's
  own behaviour.
- The repair panel is **replaced by a refusal** (`role="alert"`) naming
  cross-origin isolation as the cause and stating that export still works. No
  `preview-repair` or `apply-repair` control exists in the DOM.
- Import, topology and export **still work**: 500 triangles reported, STL export
  byte-exact.

This is the release-critical behaviour. A host that forgets a header gets a
visible, explained, feature-level refusal — never a Cancel button that cannot
cancel.

## Browser support

See `BROWSER_SUPPORT.md`. Summary: **Chromium 151.0.7922.34 release qualified**;
**WebKit 26.5 capability compatible but not release qualified** (all required APIs
present under isolation, including `SharedArrayBuffer` and `Atomics.wait`, but no
product flow run — and Playwright's WebKit is _not_ Safari); **Firefox not
qualified** (could not launch on this host); Safari and touch not qualified.

`navigator.deviceMemory` is **absent in WebKit** and coarsened in Chromium, which
is the measured basis for rejecting a `deviceMemory`-driven policy.

## Host policy

**Model C — documented minimum host requirements.** Full reasoning in
`RESOURCE_POLICY.md`. The decisive measurement:

| Condition                                              | 900k-triangle STL import                   |
| ------------------------------------------------------ | ------------------------------------------ |
| 4 parallel Playwright browsers, 65 MiB free, load > 30 | Fails; renderer once killed                |
| **1 browser, 1 tab**                                   | **3 / 3 pass**, free RAM rising to 1.4 GiB |

So Stage 5A's failures were test-runner concurrency, not user behaviour. **An
8 GiB machine is a supported MVP host** for one active workspace. No ceiling was
raised; none was lowered without cross-machine evidence.

## Service worker and CSP

**No service worker exists**, and none was added. **No CSP is defined.** A CSP
that omits `worker-src` or WASM evaluation breaks this product outright, so
rather than add an untested one, `PRODUCTION_HOSTING_REQUIREMENTS.md` records the
requirement and Stage 5C can add one with the whole suite behind it.
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` are in the
contract and sent by the reference server.

## Final gates

| Gate                       | Result                                                     |
| -------------------------- | ---------------------------------------------------------- |
| `npm run verify`           | 97 files, 2,137 tests, exit 0                              |
| `npm run test:e2e`         | **172 passed**, 2 skipped, exit 0 (154 baseline + 18 new)  |
| `npm run test:e2e:timing`  | 11 passed                                                  |
| `npm run test:e2e:harness` | 77 passed                                                  |
| `npm run build` ×2         | Identical asset names, sizes and hashes — **reproducible** |

18 tests added, none removed, no threshold weakened, **no production source
changed**.

## Accepted Medium / Low debt

- **5B-03** reload-only WebGL recovery. Geometry survives and stays exportable.
- **5B-04** Firefox unqualified; WebKit capability-compatible but unqualified.
- No CSP yet; Stage 5C.
- Touch and mobile not qualified; out of MVP scope.
- OS-level tab termination under genuine memory exhaustion cannot be caught by
  in-page code. Stated in `RESOURCE_POLICY.md` rather than glossed.

## Stage 5C eligibility

The release candidate has a qualified browser, an executable hosting contract, a
proven fail-closed isolation path, a bounded DPR and viewport policy, an
evidence-based host policy, reproducible builds and no unresolved Critical or High
blocker. It is eligible for Stage 5C production deployment qualification.

**Not deployed. No host selected. No tag.**
