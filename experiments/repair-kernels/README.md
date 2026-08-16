# Repair kernel experiments

**RESEARCH ONLY.** Nothing here is imported by `apps/**`, by any worker, or by
any production bundle. A test asserts the evaluation package stays out of the
application, and `npm run build` is checked for candidate code after every
experimental change.

**No kernel is integrated. Repair remains disabled.**

## What is committed, and what is not

Committed: build scripts, our bindings, the manifests, the runners, and the
results. **Not** committed (see `.gitignore`): upstream sources, the Emscripten
SDK, build trees, and the `.wasm`/`.js` artifacts — they are gigabytes, they
belong to their upstreams, and committing them would muddy this repository's
licence position.

To reproduce from a clean checkout: fetch the pinned sources with
`scripts/fetch-candidate.sh`, then run the build scripts below.

## Builds

```bash
bash experiments/repair-kernels/manifold/build.sh
bash experiments/repair-kernels/geogram/build.sh          # WASM
bash experiments/repair-kernels/geogram/build-native.sh   # native reference
bash experiments/repair-kernels/pmp/build.sh
```

Every candidate is pinned to an immutable commit in `candidates.json` and built
with one shared toolchain (emsdk 4.0.16), so build-mode differences cannot be
mistaken for algorithmic ones.

**The Geogram licence gate is part of the build**, for both the WASM and the
native target. `GEOGRAM_WITH_TETGEN=OFF` and `GEOGRAM_WITH_TRIANGLE=OFF` exclude
the AGPL and non-free components, and `scripts/audit-build-inputs.mjs` refuses
to emit an artifact if it cannot prove they are absent.

## Runners

Each runs **one operation in one process**, then exits.

| Runner                    | Purpose                                                   |
| ------------------------- | --------------------------------------------------------- |
| `run-candidates.mjs`      | the Stage 3A-2 corpus sweep, one candidate per invocation |
| `run-geogram-single.mjs`  | one Geogram operation, with a selectable `initMode`       |
| `run-manifold-single.mjs` | one Manifold operation or two-solid boolean               |
| `run-idempotence.mjs`     | applies one operation **twice** and returns both outputs  |

**Why separate processes.** A synchronous WASM call cannot be interrupted from
inside its own process, so killing the process is the only cancellation
available. Stage 3A-2 ran a whole fixture per process, which meant one
non-returning call erased every later case in that process — a fixture's result
depended on what ran before it. One operation per process makes a hang cost
exactly one row.

**Why plain Node and not vitest.** Emscripten's ES6 glue does not survive Vite's
transform; loaded through vitest, the Geogram module threw on every call while
the identical artifact worked under plain `node`. Stage 3A-2 recorded 321
fabricated "crashes" that were entirely the bundler's. Candidates now run
untouched in a child process.

## Experiments

Run one at a time — the development machine has suffered contention, and these
timings are machine-dependent. None is part of CI.

```bash
npx vitest run --config vitest.bench.config.ts scripts/repair-bakeoff.bench-suite.ts
npx vitest run --config vitest.bench.config.ts scripts/geogram-root-cause.bench-suite.ts
npx vitest run --config vitest.bench.config.ts scripts/manifold-boolean.bench-suite.ts
npx vitest run --config vitest.bench.config.ts scripts/idempotence-preservation.bench-suite.ts
npx vitest run --config vitest.bench.config.ts scripts/scalar-precision.bench-suite.ts
```

Results land in `docs/repair/bakeoff/*.json`. Those files are machine-generated
and excluded from Prettier — their serialisation is owned by the generator — but
their integrity is asserted by `scripts/results-integrity.test.ts`, which runs
in CI and checks parsing, provenance, absence of raw geometry, and stale-row
contamination.

## The `initMode` control

`cf_g_set_init_mode` on the Geogram binding selects the initialisation under
test:

- **0** — `GEO::initialize()` and nothing else. Stage 3A-2's sequence, retained
  as a **negative control**, not as a fallback.
- **1** — additionally imports the `algo` and `sys` argument groups, which the
  pinned source shows the colocate path reads.

Keeping mode 0 available is what lets the native/WASM comparison vary
initialisation while holding everything else fixed. That comparison is what
turned "Geogram's colocate is unusable" into a proven defect in our own binding.

## Marked-invalid experiments

Kept deliberately, excluded from every score:

- **`selfUnion`** (`CF_OP_SELF_UNION_INVALID`) — unions against an empty
  Manifold, which is the identity. It measured nothing. Retained so the
  correction can be demonstrated rather than asserted.

A silently deleted experiment teaches nobody why its number was wrong.

## Rules

- Never modify upstream algorithm source. Initialisation, binding, build and
  harness fixes only — anything else invalidates the comparison.
- Never weaken or disable an upstream assertion.
- A candidate does not decide whether it succeeded. It reports; CAD Fixer's own
  Stage 2 validators judge.
- Never pre-process a fixture with one candidate to make another look better.
