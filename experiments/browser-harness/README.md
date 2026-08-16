# Experimental browser harness

**RESEARCH ONLY — Stage 3A-3B.** Nothing here enters the application, its
routing, or its bundle. No kernel is integrated and Repair remains disabled.

This exists to answer one question the Node experiments could not: **does a
candidate WASM artifact actually work in the browser CAD Fixer ships to?**

## Architecture

```
plain node:http server (127.0.0.1:4174, COOP/COEP)
  └─ index.html + harness.js          the page: owns authoritative geometry
       └─ candidate-worker.js         module Worker, one candidate per worker
            └─ /artifacts/<id>/*.js   Emscripten glue, served as raw bytes
                 └─ *.wasm            fetched by the glue itself, same origin
```

**Vite is deliberately absent.** Its transform destroys Emscripten's ES6 glue —
that defect recorded 321 fabricated "crashes" in Stage 3A-2. Serving raw bytes
means the browser instantiates the byte-identical artifact whose SHA-256 the
manifests record.

**The page owns the geometry; the worker gets a copy.** `harness.js` posts
without a transfer list on purpose. Transferring would detach the page's buffer,
and terminating the worker would then destroy the only copy — precisely the
failure the cancellation gate has to rule out.

**Every message carries `(sessionId, opId)`.** A terminated worker can have a
queued message delivered after its replacement exists; without identity, a dead
worker's output could be attributed to a live operation. The page drops anything
that does not match a live session, and counts what it dropped.

**No network API in our code.** `fetch` and friends are lint errors repo-wide.
The candidate glue performs its own same-origin `.wasm` fetch, which is both why
our code stays clean and why the loading path under test is the real one.

## Running it — three steps, three runtimes

```bash
# 1. prepare: build fixture geometry and its pre-diagnosis (vitest)
npx vitest run --config vitest.bench.config.ts scripts/browser-prepare.bench-suite.ts

# 2. drive: run Chromium (Playwright, separate config from production E2E)
npx playwright test --config playwright.browser-harness.config.ts

# 3. validate: judge the output with CAD Fixer's Stage 2 oracle (vitest)
npx vitest run --config vitest.bench.config.ts scripts/browser-validate.bench-suite.ts
```

Step 1 must run before step 2 — the spec reads `cases.json` at module scope.

### Why three steps and not one

The Playwright spec **cannot** import `@cadfixer/repair-evaluation`. Every
production `e2e/` spec imports only local files, and breaking that convention
hung Playwright's loader indefinitely on the workspace package graph.

The split turned out better than the workaround it replaced: the driver records
and decides nothing, and the oracle runs in a different process. A candidate
cannot influence its own verdict, and neither can the code driving it.

## Suites

| Spec                    | Covers                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `qualification.spec.ts` | isolation, local-only loading, the candidate smoke matrix                                           |
| `cancellation.spec.ts`  | `Worker.terminate()` against real WASM work, stale-result protection, persistent vs disposable cost |
| `scaling.spec.ts`       | 1/10/50 MiB runs, WASM heap, PMP hole-fill loop sensitivity                                         |

## Rules

- **Geometry is generated in the page**, never sent across the Playwright
  bridge. An earlier version built 50 MiB meshes in Node and killed the test
  runner with a JS heap OOM before the browser did any work — it measured the
  bridge, not the candidate.
- **Cancellation workloads must be real candidate CPU work.** No `setTimeout`,
  no sleep, no unrelated busy-loop. Sizes are calibrated at run time until the
  operation exceeds a threshold, and the test asserts the kernel was still
  running when `terminate()` was called.
- **Sizes are estimated before they run** and skipped if the estimate exceeds
  the safety budget. A graceful refusal is an acceptable result; crashing the
  tab is not, and would destroy the run's own evidence.
- **Heap figures are `WebAssembly.Memory` buffer lengths**, never process RSS,
  and are never described as such.
- **Termination latency is an observation bound**, not a kernel-stop time. The
  platform exposes no termination event.
- Run sequentially. This machine has suffered contention, and these are timings.

## Outputs

Raw intermediates land in `.cases/` (gitignored). The committed evidence is
`docs/repair/bakeoff/browser-{qualification,cancellation,scaling}.json`, whose
provenance and integrity are asserted by `scripts/results-integrity.test.ts` in
CI.
