# Stage 4A-1 — multi-format geometry document qualification

**RESEARCH ONLY.** Nothing here is imported by `apps/**` or `packages/**`, and
the production boundary scan checks it. This directory qualifies an
architecture; Stage 4A-2 implements one.

Conclusions: `docs/adr/0013-multi-format-geometry-document.md`

## What is here

| File                    | Role                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `float32-roundtrip.mjs` | How many decimal digits a Float32 needs to survive text          |
| `zip.mjs`               | Bounded, dependency-free ZIP reader on `DecompressionStream`     |
| `zip-fixtures.mjs`      | Hostile archives, built byte by byte (isomorphic)                |
| `zip-security.mjs`      | 18-case refusal matrix plus an unbounded-reader oracle           |
| `obj.mjs`               | OBJ qualification parser and the Float32-exact coordinate writer |
| `obj-matrix.mjs`        | F03–F09 record matrix and the polygon-fan demonstration          |
| `harness/`              | Isolated browser harness (COOP/COEP)                             |
| `format.spec.ts`        | Chromium: XXE policy, ZIP parity, zero-network, OBJ scaling      |

## Reproducing

```bash
node experiments/format-io/float32-roundtrip.mjs
node experiments/format-io/zip-security.mjs
node experiments/format-io/obj-matrix.mjs
npx playwright test --config experiments/format-io/playwright.format.config.ts
```

## The two findings most likely to matter later

1. **`toFixed(6)` fails to round-trip 50.7% of Float32 values.** Text writers
   need nine significant digits, plus explicit handling for negative zero.

2. **A naive polygon fan invents geometry.** On the concave pentagon fixture it
   emits a triangle of the opposite orientation — outside the polygon. OBJ
   n-gons are refused, not triangulated.
