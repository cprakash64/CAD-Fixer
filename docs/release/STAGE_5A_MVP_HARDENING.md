# Stage 5A — MVP Production Readiness & Adversarial Hardening

**Tested commit:** `1796ffaf733a4979418fa0978270db5c09cf2e19` (branch
`stage-5a-mvp-hardening`, cut from `main`).
**Rewritten-history kernel baseline:** `741e649305424aefd06e0a81ab5aa5de09c59b3a`
(the old `34efd8b…` no longer resolves; see ADR 0010's Stage 4B-1D closure).
**Geogram artifact:** `507ea5e7c9110781e4d90ade507d1b37a7b95b2832b055cb59418bca43399fc3`.

## Host

|                                             |                                   |
| ------------------------------------------- | --------------------------------- |
| macOS                                       | 27.0 (26A5421a), arm64            |
| RAM                                         | **8 GiB**                         |
| Free disk                                   | 37 GiB of 460 GiB                 |
| Node                                        | v22.22.2                          |
| npm                                         | 12.0.2                            |
| Chromium                                    | 151.0.7922.34 (Playwright 1.62.1) |
| `crossOriginIsolated` under the test server | `true`                            |

**The 8 GiB figure matters and is recorded first for that reason.** It is the
single biggest constraint on what this stage could honestly qualify, and it is
the cause of the one baseline failure discussed below.

## Baseline (before any Stage 5A edit)

| Gate                       | Result                              |
| -------------------------- | ----------------------------------- |
| `npm run verify`           | 96 files, **2,126 tests**, exit 0   |
| `npm run test:e2e`         | 153 passed, **1 failed**, 2 skipped |
| `npm run test:e2e:timing`  | 11 passed                           |
| `npm run test:e2e:harness` | 77 passed                           |
| `npm run build`            | exit 0                              |

Bundle: main JS 932.55 kB (gzip 247.33), CSS 20.05 kB, `geometry.worker`
143.00 kB, `hole-fill.worker` 82.79 kB, `export.worker` 65.34 kB,
`self-intersection.worker` 50.93 kB, Geogram WASM 1,272.71 kB (gzip 396.84).

## Final gates (after the Stage 5A fixes)

| Gate                       | Result                            |
| -------------------------- | --------------------------------- |
| `npm run verify`           | 97 files, **2,137 tests**, exit 0 |
| `npm run test:e2e`         | **154 passed**, 2 skipped, exit 0 |
| `npm run test:e2e:timing`  | 11 passed, exit 0                 |
| `npm run test:e2e:harness` | 77 passed, exit 0                 |
| `npm run build`            | exit 0                            |

Eleven tests added, none removed, no threshold weakened. The large-STL
responsiveness case passed in the final run, on the same host that failed it at
baseline, with no change to the test — which is the clearest evidence available
that 5A-03 is memory pressure rather than a regression.

Bundle change: main JS 932.55 → **933.61 kB** (gzip 247.33 → 247.70), CSS
20.05 → **20.64 kB**, both from the error boundary and its styles. Every worker
chunk and the Geogram WASM are **byte-identical** (same content hashes).

## Frozen MVP scope

Supported: STL/OBJ/3MF import and export, conversion, multi-part documents with
structural mesh sharing, topology analysis, self-intersection diagnostics,
conservative repair (preview / exact Apply / exact Undo / representation-
preserving indexed candidates), validated planar hole fill (inventory / preview /
Apply / Undo), cancellation, stale-result protection, worker-resident geometry,
bounded resource policies, entirely local processing.

Not supported, and the interface must not imply otherwise: seam repair, tolerance
welding, arbitrary self-intersection repair, non-planar or batch hole filling,
splitting, hollowing, texturing, printability or manufacturing claims, accounts,
payments, cloud processing.

## Findings

| ID    | Severity             | Finding                                                                                                                                                                                                                                                                                                                                                        | Fixed?                 | Evidence                                                                                                                                                 |
| ----- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5A-01 | **High**             | No React error boundary. A component throwing during render unmounted the whole tree, leaving a blank page — no message, no reload affordance, and a model still resident in a worker the user could no longer reach.                                                                                                                                          | **Yes**                | `ErrorBoundary.test.tsx` (6 cases) failed before the component existed; two `production-boundary` cases assert the wiring and that it transmits nothing. |
| 5A-02 | Low                  | Three declared memory ceilings (`maxResidentBytes`, `maxExportPeakBytes`, `maxRenderBytes`) had no production enforcement path. Not a hole — the bytes are bounded at equal or tighter values by `mesh-core`'s `maxTotalGeometryBytes` and `export-contract`'s own incrementally-enforced caps — but a ceiling nobody checks reads like a guarantee it is not. | **Yes** (drift guard)  | `memory-budget.test.ts` now fails if a field is neither enforced from production nor recorded as superseded with its real gate named.                    |
| 5A-03 | Medium (environment) | A 900,000-triangle STL import can kill the Chromium renderer on this host.                                                                                                                                                                                                                                                                                     | No — not a code defect | See below.                                                                                                                                               |

No Critical findings. No unresolved High findings.

### 5A-03, in detail, because it deserves care

The baseline `test:e2e` failure was `the main thread stays responsive while a
large STL parses`, and it did not merely time out — Playwright reported
`Protocol error (Runtime.callFunctionOn): Internal server error, session closed`.
The browser process died.

Controlled repeated trials, with memory state captured per trial:

| Trial | Result                | Load avg | Free RAM |
| ----- | --------------------- | -------- | -------- |
| 1     | failed (30 s timeout) | 31.98    | 65 MiB   |
| 2     | **passed**            | 60.94    | 66 MiB   |
| 3     | failed (30 s timeout) | 65.03    | 67 MiB   |

`kern.memorystatus_vm_pressure_level` was **2 (warning)** throughout. The host
had ~65 MiB free of 8 GiB, with the user's own browser and desktop applications
resident, and load averages above 30 — driven partly by swapping.

**Classification: §74 category (1), environment-only.** The same test passed
repeatedly on this same machine throughout Stage 4B-1C and 4B-1D, and passes here
whenever memory is available. Nothing was weakened to make it pass, and no
threshold was touched.

**The substantive point it raises, which is not environmental.** A 900k-triangle
STL is ~4% of the declared 20,000,000-triangle screening ceiling, and it is at
the edge of what an 8 GiB machine survives while a browser and a couple of
desktop applications are running. The ceilings are internally coherent and all
enforced before allocation (see the table below) — the effective binding gate for
STL import is `maxEstimatedPeakBytes` at roughly 12M triangles, and topology
analysis refuses above roughly 4.8M faces — but **the declared ceilings describe
what the architecture will attempt, not what a modest machine can finish.**
Publishing a triangle ceiling without publishing the memory it implies would be
the kind of overclaim this project's honesty rules exist to prevent. Stage 5B
should set a _host-aware_ advertised limit; §16 explicitly forbids raising limits
here, and lowering them without cross-machine evidence would be guessing.

## Resource ceilings

All enforced before the dangerous allocation.

| Subsystem                          | Ceiling                                         | Enforced in                                    | Pre-allocation?    |
| ---------------------------------- | ----------------------------------------------- | ---------------------------------------------- | ------------------ |
| Input bytes (all formats)          | 512 MiB                                         | `budget.ts`, `obj/limits.ts`, `threemf/zip.ts` | Yes                |
| STL triangles                      | 20,000,000                                      | `budget.ts` `checkAllocation`                  | Yes                |
| STL import peak                    | 1,536 MiB → **~12M triangles binds first**      | `checkImportPeak`                              | Yes                |
| OBJ line length / objects / groups | 65,536 each                                     | `obj/limits.ts`                                | Yes                |
| OBJ vertices                       | 40,000,000                                      | `obj/limits.ts`                                | Yes                |
| OBJ face vertices                  | 3 (n-gons refused, never fanned)                | `obj-reader.ts`                                | Yes                |
| 3MF archive                        | 512 MiB                                         | `zip.ts`                                       | Yes                |
| 3MF entries                        | 4,096                                           | `zip.ts`                                       | Yes                |
| 3MF expanded total                 | 512 MiB, charged **per chunk during inflation** | `InflationBudget`                              | Yes                |
| 3MF compression ratio              | 200:1                                           | `zip.ts`                                       | Yes                |
| 3MF path length                    | 512                                             | `zip.ts`                                       | Yes                |
| 3MF objects                        | 65,536                                          | `threemf-reader.ts`                            | Yes                |
| 3MF component depth                | 16                                              | `threemf-reader.ts`                            | Yes                |
| 3MF vertices per object            | 40,000,000                                      | `threemf-reader.ts`                            | Yes                |
| XML elements / depth / attribute   | 80,000,000 / 64 / 65,536                        | `xml-scan.ts`                                  | Yes                |
| Document parts                     | 4,096                                           | `document.ts`                                  | Yes                |
| Document triangles / vertices      | 20,000,000 / 60,000,000                         | `document-validation.ts`                       | Yes                |
| Document geometry bytes            | 768 MiB                                         | `document-validation.ts`                       | Yes                |
| Part name length                   | 512                                             | `document-validation.ts`                       | Yes                |
| Topology workspace                 | 1,024 MiB → **~4.8M faces**                     | `requestAnalysisWorkspace`                     | Yes                |
| SI automatic band                  | 25,000 faces                                    | `policy.ts`                                    | Yes                |
| SI hard ceiling                    | 250,000 faces                                   | `policy.ts`                                    | Yes                |
| Conservative repair peak           | 1,024 MiB                                       | `requestRepairPeak`                            | Yes                |
| Hole-fill boundary vertices        | 512                                             | `mesh-hole-fill/limits.ts`                     | Yes                |
| Hole-fill part faces               | 250,000                                         | `mesh-hole-fill/limits.ts`                     | Yes                |
| Export output                      | 256 MiB                                         | `export-contract.ts`                           | Yes, incrementally |
| Export serialised                  | 512 MiB                                         | `export-contract.ts`                           | Yes, incrementally |

None raised in Stage 5A.

## Security and privacy

Static audit of production source (`apps/web/src`, `packages/*/src`, excluding
tests):

- **No** `dangerouslySetInnerHTML`, `innerHTML`, `eval(`, `new Function`,
  `document.write`, or dynamic script creation. (Apparent `document.write` hits
  are the filename `stl-document-writer`.)
- **No** `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` —
  and these are ESLint errors repo-wide.
- **No** `localStorage`, `sessionStorage`, `IndexedDB`, or Cache API. Raw
  geometry is session-memory-only, which is what the interface says.
- **No** analytics or telemetry package, and none added.
- **Secret scan** of tracked content: no private keys, tokens, cloud
  credentials, `.env` files or credential-shaped assignments.
- **Export filenames** are sanitised at `runtime/download.ts`: path components
  dropped, control and Unicode bidi-override characters stripped, Windows-
  reserved characters removed, length bounded to 100, dot-only names replaced,
  and the **extension decided by the writer** rather than by the source name.
  3MF archive entry paths are a fixed list the writer owns; no filename reaches
  them.
- **Object URL lifecycle**: created per export, revoked on the next macrotask
  (immediate revocation cancels the download in some browsers).

## Production build boundary

Scanned the built `dist/assets/*.js` (5 chunks) for every excluded artifact —
`cadfixerHarness`, `harness-bar`, `HarnessFixtureId`, `corruptCandidate`,
`skipPreservationCheck`, `bypassPreservation`, `experiments/`,
`repair-evaluation`, `PMP`, `bakeoff`, injection globals: **zero hits in zero
files**. The 41-case `production-boundary` suite enforces the same from source,
plus codec/writer confinement, single-entry build, no worker injection, research-
tree exclusion and the Stage 4B commit-ordering invariants.

## Dependencies

Production runtime closure is **four packages**: `react` 19.2.8 (MIT),
`react-dom` 19.2.8 (MIT), `three` 0.185.1 (MIT), and one transitive. No GPL,
AGPL, SSPL or non-commercial licence anywhere in it. Everything else is
workspace-internal. **Nothing changed in Stage 5A.**

## Cross-origin isolation

Required headers, already sent by both the dev and preview servers
(`apps/web/vite.config.ts`) and documented in `docs/DEPLOYMENT_REQUIREMENTS.md`:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

`isInterruptibleRepairSupported()` fails closed on **both** conditions — it
requires `crossOriginIsolated === true` _and_ `SharedArrayBuffer` — so a context
that exposes the constructor but refuses to let the buffer cross a `postMessage`
boundary does not get a Cancel control that would throw. **No production host
configuration exists in the repository yet**; that is Stage 5B's work, and the
headers above are the exact requirement.

## Browser status

- **Chromium 151.0.7922.34 — qualified.** Full MVP flow green across 154 E2E,
  11 timing and 77 harness cases.
- **Firefox — not yet qualified.** No evidence gathered.
- **Safari — not yet qualified.** No evidence gathered.

Cross-browser qualification is Stage 5B.

## Accepted Medium / Low debt

- **5A-03** — the advertised triangle ceiling is not host-aware. Stage 5B.
- Render snapshots are larger than canonical geometry for indexed input. Correct
  and documented (Stage 4B-1D); a non-indexed draw requires three corners per
  face.
- A pre-existing unreferenced vertex is compacted away by a repair (Policy B,
  documented in ADR 0010).
- One undo step, no redo. Deliberate.

## Deferred to Stage 5B, honestly

These were **not** given new browser evidence in Stage 5A, because this host
could not produce trustworthy evidence for them at 65 MiB free RAM and load
averages above 30, and fabricating coverage would be worse than naming the gap:

- WebGL context-loss simulation (§42).
- High-DPR and multi-monitor viewport stress (§43).
- Firefox and Safari discovery (§69).
- Cross-machine performance distributions and a host-aware size policy (§75,
  and 5A-03 above).

Everything else in the matrix is covered either by new Stage 5A evidence or by
the pre-existing qualified suites, which were re-run green at this commit.

## Stage 5B eligibility

The application has no unresolved Critical or High release blocker, no
transmission of user geometry, no persistence of user geometry, a coherent and
pre-allocation-enforced resource policy, a single-contributor clean history, and
green CI. It is eligible for Stage 5B browser, hosting and security-header
qualification.
