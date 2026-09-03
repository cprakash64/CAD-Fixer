# Stage 3C-1A — read-only self-intersection qualification

**RESEARCH ONLY.** Nothing here is imported by `apps/**` or `packages/**`, and
the bundle scan checks it. This directory qualifies an architecture; Stage 3C-1B
integrates one.

Conclusions and evidence: `docs/adr/0012-read-only-self-intersection-diagnostic.md`
Machine-readable corpus results: `docs/self-intersection/qualification.json`

## What is here

| File                              | Role                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| `si_core.h`                       | The diagnostic: broadphase → adjacency → narrowphase → classification    |
| `native_main.cpp`                 | Native harness; also hashes the input before/after to prove immutability |
| `wasm_binding.cpp`                | Flat C ABI for the browser                                               |
| `fixtures.mjs`                    | SI01–SI27 corpus, hand-authored on exact coordinates                     |
| `run-native.mjs` / `run-wasm.mjs` | Harness drivers                                                          |
| `validate.mjs`                    | Broadphase vs brute-force AABB oracle, and determinism                   |
| `parity.mjs`                      | Native vs WASM agreement                                                 |
| `bench.mjs` / `memory.mjs`        | Scaling and memory amplification                                         |
| `harness/`                        | Isolated (COOP/COEP) browser harness: two workers + `MessageChannel`     |
| `browser.spec.ts`                 | Chromium qualification, cancellation, transfer, privacy                  |

## Reproducing

Requires the pinned Geogram and emsdk already fetched under
`experiments/repair-kernels/` (see that directory's README), and the licence gate
to pass.

```bash
# native
clang++ -O3 -std=c++17 \
  -Iexperiments/repair-kernels/geogram/upstream/src/lib \
  -Iexperiments/repair-kernels/geogram/upstream/src/lib/geogram/third_party/zlib \
  -Iexperiments/self-intersection \
  experiments/self-intersection/native_main.cpp \
  experiments/repair-kernels/geogram/build-native/lib/libgeogram.a \
  -o experiments/self-intersection/artifacts/si-native

node experiments/self-intersection/run-native.mjs   # SI01-SI27
node experiments/self-intersection/validate.mjs     # oracle + determinism
node experiments/self-intersection/parity.mjs       # native vs WASM
node experiments/self-intersection/bench.mjs        # 1/10/50 MiB
node experiments/self-intersection/memory.mjs       # amplification

npx playwright test --config experiments/self-intersection/playwright.si.config.ts
```

The WASM artifact is rebuilt with the same `em++` invocation recorded in the ADR.
Built artifacts under `artifacts/` are NOT committed — they are reproducible and
large, exactly as the Stage 3A kernel artifacts are treated.

## The two findings most likely to bite later

1. **`GEO::TriangleIsects` is a fixed 20-element buffer with an always-on
   assertion.** Duplicate triangles overflow it and abort the process. The
   classifier never sends a topological duplicate to the narrowphase; treat a
   module abort as recoverable anyway.

2. **~6.0 µs per candidate pair.** ~63 s at 50 MiB. This cannot be an always-on
   analysis at large sizes.
