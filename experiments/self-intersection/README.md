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

## Stage 3C-1A-R1 additions

| File                      | Role                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `si_bvh.h`                | Abortable read-only broadphase — the traversal callback returns `bool` and unwinds immediately |
| `funnel.mjs`              | Where every candidate goes, and what each prefilter removes                                    |
| `differential.mjs`        | Shipped path vs the Stage 3C-1A oracle; also the rejected-prefilter evidence                   |
| `broadphase.mjs`          | BVH vs Geogram vs brute force, candidates and classifications                                  |
| `abort.mjs`               | Work wasted after the cap fires, both broadphases                                              |
| `scaling.mjs`             | Runtime by face count, median of 3                                                             |
| `fuzz_main.cpp`           | Narrowphase capacity stress, with and without exact identity                                   |
| `run-generated.mjs`       | The regenerated Stage 3A R16/R17/R18                                                           |
| `generated-fixtures.json` | Those fixtures with provenance and SHA-256                                                     |

Regenerate the Stage 3A fixtures with:

```bash
npx vitest run --config vitest.bench.config.ts \
  scripts/self-intersection-fixtures.bench-suite.ts
```

## The findings most likely to bite later

1. **`GEO::TriangleIsects` is a fixed 20-element buffer with an always-on
   assertion** — but it THROWS rather than aborting, and the throw is caught.
   Over 1,175,792 production-realistic pairs it never overflowed; it overflows
   only when coincident vertices carry distinct ids, which exact identity
   recovery eliminates first.

2. **~4–6 µs per candidate pair, and it is not prefilterable.** Two
   mathematically sound prefilters were implemented, measured and rejected. The
   production answer is the 250,000-face ceiling and the invocation bands in
   ADR 0012, not a faster kernel.

3. **The face ceiling must be a PREFLIGHT gate.** At 1M faces the BVH allocates
   ~272 MiB before any pair cap can fire.
