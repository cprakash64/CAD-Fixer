# Performance baseline — Stage 1

Measurements for the STL import/export pipeline, recorded so later changes have
something to regress against.

**These numbers are not tested in CI.** They depend on the machine, and a timing
assertion in CI fails for reasons unrelated to the code. Reproduce with:

```bash
npm run bench:stl
```

Sizes are configurable: `CADFIXER_BENCH_MB=1,10,50,100,250 npm run bench:stl`.

## Environment

|         |                                              |
| ------- | -------------------------------------------- |
| Date    | 2026-08-14                                   |
| Machine | Apple M1, 8 cores, 8 GB RAM                  |
| OS      | macOS 27.0                                   |
| Runtime | Node v22.22.2 (darwin/arm64)                 |
| Harness | Vitest 4.1.10, single worker, no parallelism |

**Measured under Node, not in a browser.** The codec is platform-free and runs
identically in both, but these numbers exclude everything the browser adds:
`File.arrayBuffer()`, `postMessage` transfer, and GPU upload. Browser-side
timings are not yet captured — see [Not yet measured](#not-yet-measured).

Input files are synthetic lattices of distinct triangles, generated in memory
and never written to disk. Distinct — not one triangle repeated — so the numbers
are not flattered by a fixture with unrealistic cache behaviour.

**One caveat on the parse timings.** Codecs yield to the event loop once per
65,536-triangle batch so a queued cancel message can be delivered. The benchmark
supplies a yield that resolves immediately, so these numbers exclude the cost of
a real task switch. In the browser the worker yields via `MessageChannel`
(unclamped, unlike `setTimeout`), which adds roughly 32 message tasks over a
100 MiB parse — small next to the 97 ms of parsing, but not zero, and not
measured here.

## Results

| Input   | Triangles | Parse | Validate | Bounds | Render normals | Write binary | Write ASCII | Parse ASCII |
| ------- | --------- | ----- | -------- | ------ | -------------- | ------------ | ----------- | ----------- |
| 1 MiB   | 20,969    | 6 ms  | 8 ms     | 4 ms   | 6 ms           | 8 ms         | 129 ms      | 155 ms      |
| 10 MiB  | 209,713   | 12 ms | 22 ms    | 8 ms   | 11 ms          | 27 ms        | 958 ms      | 1,423 ms    |
| 50 MiB  | 1,048,574 | 50 ms | 105 ms   | 25 ms  | 34 ms          | 72 ms        | 4,690 ms    | 7,836 ms    |
| 100 MiB | 2,097,150 | 97 ms | 215 ms   | 25 ms  | 65 ms          | 148 ms       | 8,565 ms    | skipped¹    |

¹ The ASCII rendering of a 100 MiB binary STL is 522 MiB, which exceeds the
512 MiB intake limit. That is the budget working as designed, not a defect — see
[ASCII is 5.2x larger](#ascii-is-52x-larger).

### Memory

| Input   | positions | indices  | render normals | canonical        | working set       |
| ------- | --------- | -------- | -------------- | ---------------- | ----------------- |
| 1 MiB   | 0.7 MiB   | 0.2 MiB  | 0.7 MiB        | 1.0 MiB (0.96x)  | 1.7 MiB (1.68x)   |
| 10 MiB  | 7.2 MiB   | 2.4 MiB  | 7.2 MiB        | 9.6 MiB (0.96x)  | 16.8 MiB (1.68x)  |
| 50 MiB  | 36.0 MiB  | 12.0 MiB | 36.0 MiB       | 48.0 MiB (0.96x) | 84.0 MiB (1.68x)  |
| 100 MiB | 72.0 MiB  | 24.0 MiB | 72.0 MiB       | 96.0 MiB (0.96x) | 168.0 MiB (1.68x) |

"Working set" is canonical geometry plus the derived render normals. During the
parse itself the input buffer is also live, so true peak is roughly
`working + input` — which is what `planAllocation` estimates and enforces.

## What the numbers say

**Binary parsing is not the bottleneck.** ~1 GiB/s sustained; a 100 MiB model
parses in under 100 ms. The `DataView` + typed-array design with no per-triangle
object allocation is doing its job. This is comfortably fast enough that
optimising it further would be premature.

**Validation costs about twice as much as parsing.** 215 ms against 97 ms at
100 MiB. That is expected — it scans every coordinate for finiteness and every
index for range — and it is the price of the rule that a returned mesh is not a
successful import until it passes the gate. It stays off the UI thread, so the
cost is latency, not jank.

**ASCII is roughly 25x slower to write and 30x slower to parse**, per byte of
model. (ASCII parsing lost roughly a third of its throughput late in Stage 1
when every numeric token gained a decimal-shape check. That check exists because
`Number()` happily accepts `0x41` as 65, so without it a file that should be
refused was silently reinterpreted. Correctness on the trusted boundary is worth
more than throughput on the compatibility format.) At ~50 MiB/s parsing and ~8.5 s to write a 2M-triangle file, ASCII is
firmly the slow path. The cause is not the tokeniser's scanning — it is
per-number work. The writer makes 12 `toExponential` calls per triangle (~25
million at 100 MiB); the reader does the inverse, and additionally allocates one
short-lived token object and one short string per number, so an ASCII parse puts
roughly 12 small allocations per triangle through the garbage collector. The
binary reader allocates nothing per triangle, which is most of the 20x gap. This is acceptable because ASCII STL is a
compatibility format, not the one anybody uses at scale, but it is why binary is
the default export.

### ASCII is 5.2x larger

An ASCII STL of the same model is consistently ~5.2x the binary size, because
nine significant digits per coordinate cost far more than four bytes. Two
consequences worth knowing:

- Exporting a large model as ASCII produces a very large file (100 MiB binary →
  522 MiB ASCII).
- **A model near the top of the size range cannot be round-tripped through
  ASCII within the default budget**, because its own ASCII form exceeds the
  512 MiB intake limit. Binary round-trips fine at every size tested.

## Float32 vs Float64

The canonical position type has been an open decision since Stage 0
([ADR 0004](adr/0004-canonical-mesh-model.md)). Stage 1 was asked to collect
evidence rather than decide by intuition.

### Memory cost — measured, exact

Doubling position width doubles the largest buffer:

| Input   | Float32 positions | Float64 positions | Canonical total  | Increase |
| ------- | ----------------- | ----------------- | ---------------- | -------- |
| 10 MiB  | 7.2 MiB           | 14.4 MiB          | 9.6 → 16.8 MiB   | +75%     |
| 50 MiB  | 36.0 MiB          | 72.0 MiB          | 48.0 → 84.0 MiB  | +75%     |
| 100 MiB | 72.0 MiB          | 144.0 MiB         | 96.0 → 168.0 MiB | +75%     |

Including render normals (which would stay Float32: float32 is the selected
WebGL/Three.js vertex-attribute representation, and render precision is
deliberately decoupled from canonical precision), a 100 MiB model's working set goes from 168 MiB to 240 MiB.

### Conversion cost

Float32 positions upload to the GPU directly: the same `Float32Array` backs both
the canonical mesh and the `BufferAttribute`, with no copy. Float64 would force
a full Float32 conversion pass on every model load, adding both time and a
transient second copy of the position data. That conversion is not currently
measured, because measuring it honestly requires building the Float64 variant.

### Precision — what is actually at stake

Binary STL stores Float32. **For STL import specifically, Float64 canonical
positions buy nothing**: the source data has no more precision to preserve, so
widening would store exactly the same values in twice the space. This is why
Stage 1 alone cannot settle the question.

The real argument for Float64 is about operations that do not exist yet:

- Float32 has ~7 significant decimal digits. A part 500 mm from the origin
  resolves to about 30 µm — coarse relative to a 3D printer's tolerance.
- Coincident-vertex welding and boolean operations compare against absolute
  tolerances. At large coordinate magnitudes, Float32 spacing can exceed the
  tolerance being tested, which makes "are these two vertices the same point?"
  answer inconsistently.
- Offsetting, hollowing, and connector placement all accumulate error.

### Recommendation

**Keep Float32 as the canonical position type for now, and keep ADR 0004 open.**

Reasoning:

- The measured cost of Float64 is real and immediate (+75% canonical memory,
  plus a conversion pass on every load and GPU upload).
- The measured benefit for the only implemented workflow is exactly zero,
  because STL sources are Float32.
- The plausible benefit is entirely in operations that have not been written, so
  the evidence needed to justify the cost cannot be gathered yet.

Deciding now in either direction would be guessing. Float32 is the reversible
choice: the alias `PositionArray` exists precisely so this can change in one
place, and no call site assumes the width.

**ADR 0004 remains OPEN.** The benchmark that would close it, and which this
stage could not run:

1. Implement coincident-vertex welding with an absolute tolerance.
2. Run it over models translated 10 mm, 1 m, and 100 m from the origin, at
   feature sizes from 10 µm to 1 mm.
3. Measure how often Float32 and Float64 disagree about whether two vertices are
   the same point.

If they never disagree within the coordinate ranges 3D printing actually uses,
Float32 is correct and the decision closes. If they diverge at realistic
magnitudes, the memory cost is justified and worth paying.

## Not yet measured

Stated rather than estimated, because inventing these numbers would be worse
than admitting they are missing:

- **Browser-side timings.** Everything above is Node. `File.arrayBuffer()`,
  `postMessage` transfer latency, and GPU upload are unmeasured. The end-to-end
  Playwright suite proves the pipeline stays responsive on a 900,000-triangle
  model, but does not time it.
- **True peak RSS.** `heapUsed` does not account for typed arrays allocated
  outside the JS heap, so process-level peak memory is not reported here rather
  than reported wrongly.
- **Files above 100 MiB.** Not run on this 8 GB machine, where a 250 MiB test
  would measure swap behaviour rather than the parser.
- **Transfer cost as a function of size.** Transfer is O(1) in principle, but
  this is asserted from the specification, not measured.
- **The export clone.** Export sends the mesh to the worker by structured clone
  rather than by transfer, because the viewport is still rendering from those
  buffers and transferring would detach them mid-frame. From the memory table
  above, that copies roughly 96 MiB for a 2-million-triangle model, on the main
  thread, on every export. It has not been timed. The fix is architectural
  rather than an optimisation: keep canonical geometry worker-side and hand the
  main thread only render buffers, so there is nothing to copy back.

---

# Performance baseline — Stage 2

Adds worker-resident geometry and topology diagnostics. Reproduce with:

```bash
npm run bench:pipeline
```

Sizes are configurable: `CADFIXER_PIPELINE_MB=1,10,50,100 npm run bench:pipeline`.
A smaller topology-only run is `npm run bench:topology`.

**Still not tested in CI**, for the same reason as Stage 1: a timing assertion on
shared hardware fails for reasons unrelated to the code.

## Environment

|         |                                              |
| ------- | -------------------------------------------- |
| Date    | 2026-08-16                                   |
| Machine | Apple M1, 8 cores, 8 GB RAM                  |
| OS      | macOS 27.0 (darwin/arm64)                    |
| Runtime | Node v22.22.2                                |
| Harness | Vitest 4.1.10, single worker, no parallelism |

## Whole pipeline, Node

Every stage the worker runs, in order, measured in one process so the numbers
relate to each other. The fixture is a triangulated height grid whose
neighbouring quads share bit-identical corners, so vertex canonicalisation does
real merging rather than exercising only the hash table's insert path.

| Input    | Triangles | Corners   | Recovered vertices | Unique edges | Components |
| -------- | --------- | --------- | ------------------ | ------------ | ---------- |
| 1.0 MiB  | 20,808    | 62,424    | 10,609             | 31,416       | 1          |
| 9.9 MiB  | 208,658   | 625,974   | 104,976            | 313,633      | 1          |
| 50.0 MiB | 1,048,352 | 3,145,056 | 525,625            | 1,573,976    | 1          |
| 99.8 MiB | 2,093,058 | 6,279,174 | 1,048,576          | 3,141,633    | 1          |

| Stage                      | 1 MiB  | 10 MiB | 50 MiB | 100 MiB  |
| -------------------------- | ------ | ------ | ------ | -------- |
| Parse                      | 6 ms   | 18 ms  | 52 ms  | 99 ms    |
| Structural validation      | 9 ms   | 27 ms  | 98 ms  | 199 ms   |
| Render snapshot            | 12 ms  | 14 ms  | 66 ms  | 145 ms   |
| — canonicalizing vertices  | 9 ms   | 45 ms  | 193 ms | 299 ms   |
| — building edges           | 2 ms   | 6 ms   | 43 ms  | 23 ms    |
| — grouping edges           | 32 ms  | 27 ms  | 162 ms | 135 ms   |
| — analyzing edge incidence | 4 ms   | 5 ms   | 17 ms  | 14 ms    |
| — analyzing vertex fans    | 17 ms  | 38 ms  | 148 ms | 242 ms   |
| — finding components       | 5 ms   | 11 ms  | 29 ms  | 40 ms    |
| — analyzing boundaries     | 4 ms   | 12 ms  | 32 ms  | 40 ms    |
| — checking faces           | 10 ms  | 26 ms  | 126 ms | 204 ms   |
| — measuring geometry       | 11 ms  | 23 ms  | 54 ms  | 62 ms    |
| — preparing report         | 10 ms  | 29 ms  | 114 ms | 220 ms   |
| **Topology total**         | 105 ms | 223 ms | 918 ms | 1,280 ms |
| Binary export              | 10 ms  | 25 ms  | 75 ms  | 99 ms    |

**On reading these numbers.** Four data points do not establish asymptotic
complexity, and nothing here should be read as evidence of sub-linear growth:
analysis must visit every corner and every face, so it cannot be below Ω(N). The
implemented complexity is O(N) expected for the hashing and radix stages plus
O(F log F) for the one comparison sort in duplicate-face detection. What the
table is good for is noticing a catastrophe — a size increase that cost far more
than proportionally would mean quadratic behaviour crept in.

## Memory, modelled

**Modelled, not measured RSS.** Typed arrays live outside the JS heap, so
`process.memoryUsage()` would not tell the truth here. These are computed from
actual typed-array byte lengths, and the estimator column is what the preflight
would have predicted before allocating — which is the number that has to be
right, because it is what decides whether an analysis is allowed to start.

| Input   | Resident canonical | Render snapshot | Topology scratch (est.) | Bounded detail | Modelled app peak |
| ------- | ------------------ | --------------- | ----------------------- | -------------- | ----------------- |
| 1 MiB   | 1.0 MiB            | 1.4 MiB         | 4.7 MiB                 | 0.0 MiB        | 7.1 MiB           |
| 10 MiB  | 9.6 MiB            | 14.3 MiB        | 47.0 MiB                | 0.0 MiB        | 70.9 MiB          |
| 50 MiB  | 48.0 MiB           | 72.0 MiB        | 235.9 MiB               | 0.1 MiB        | 356.0 MiB         |
| 100 MiB | 95.8 MiB           | 143.7 MiB       | 471.1 MiB               | 0.1 MiB        | 710.7 MiB         |

Resident and render figures matched their estimators exactly at every size.

**The detail payload does not scale with the model.** It is bounded by the
sample limit, not by mesh size: 0.1 MiB at 100 MiB of input, against a ceiling of
8.6 MiB at the default limit of 50,000 samples per category.

**100 MiB is accepted, not refused.** Projected topology scratch of 471 MiB sits
under the 1,024 MiB analysis ceiling. The refusal path is exercised by a unit
test that decides from counts alone — roughly 4.8M triangles and 14.4M corners,
a ~230 MiB file — without allocating anything, which is the property that matters:
a preflight that needed the workspace in order to decide whether the workspace
fits would not be a preflight.

## Browser

Recorded with Playwright against the production build:

```bash
CADFIXER_BROWSER_BENCH=1 npx playwright test e2e/browser-benchmark.spec.ts
```

Skipped by default — it is slow, and it belongs to a deliberate measuring
session rather than to every E2E run. It records file-to-visible, file-to-report,
export time, the longest main-thread frame gap, and whether controls still
respond. There is exactly one assertion in it, and it is that the run completed;
turning wall-clock numbers into CI thresholds teaches people to ignore failures.

### Environment

|                       |                                         |
| --------------------- | --------------------------------------- |
| Date                  | 2026-08-16                              |
| Host                  | Apple M1, 8 cores, 8 GB RAM, macOS 27.0 |
| Browser               | Chromium 151.0.7922.34 (Playwright)     |
| `hardwareConcurrency` | 8                                       |
| `deviceMemory`        | not exposed (reported 0)                |

The user-agent string this Chromium reports claims Windows; that is Playwright's
stock UA and says nothing about the host. The host row above is the real machine.

### Results

| Triangles | Input    | File → visible | File → Mesh Health | Analysis window | Binary export | Longest frame gap | Fit-view click |
| --------- | -------- | -------------- | ------------------ | --------------- | ------------- | ----------------- | -------------- |
| 45,000    | 2.1 MiB  | 571 ms         | 850 ms             | 279 ms          | 65 ms         | 231 ms            | 27 ms          |
| 180,000   | 8.6 MiB  | 1,344 ms       | 1,490 ms           | 146 ms          | 137 ms        | 592 ms            | 30 ms          |
| 405,000   | 19.3 MiB | 3,041 ms       | 3,400 ms           | 359 ms          | 270 ms        | 1,361 ms          | 33 ms          |

**Reading the frame gaps honestly.** The longest gap grows with model size, and
it is _not_ topology: it is the first-frame GPU upload of the render snapshot and
the initial camera fit, both of which are unavoidable main-thread work at the
moment a model appears. The evidence is the last column — a `Fit view` click
still answered in under 35 ms at every size, and the analysis window (the period
during which topology actually runs) does not track the gap: 180k triangles
analysed _faster_ than 45k here, because the larger fixture has proportionally
more shared vertices.

The E2E responsiveness test `J1` isolates this properly by measuring during a
re-analysis of an already-rendered model, where nothing else touches the main
thread.

**Interaction latency, not throughput, is the number that matters** for the claim
this architecture makes. Throughput is bounded by the machine; responsiveness is
bounded by where the work runs.

A separate E2E test (`J1`) does assert responsiveness, but as a **ratio against
an idle baseline measured on the same machine**, and it measures during a
re-analysis of an already-rendered model so that the first frame's GPU upload is
not attributed to topology.

## Bundle

| Chunk                  | Size     | Contains                                 |
| ---------------------- | -------- | ---------------------------------------- |
| `index-*.js`           | 789.7 kB | React, Three.js, UI, worker transport    |
| `geometry.worker-*.js` | 47.7 kB  | STL codecs, topology engine, worker host |
| `index-*.css`          | 11.1 kB  | Application styles                       |

The topology engine is in the worker chunk and **not** in the main bundle,
verified by grepping the build output for engine-only string literals
(`exact-stored-coordinate` and friends): present in the worker chunk, absent
from the main one. The main bundle carries only the small status-value
restatement in `geometry-runtime/topology.ts`, which exists precisely so the UI
can compare against report values without importing the engine.

Neither shipped chunk contains `fetch`, `XMLHttpRequest`, `WebSocket`,
`sendBeacon`, or `EventSource`. The one `fetch` that used to appear was Vite's
module-preload polyfill; it is now disabled in `vite.config.ts`, because "no code
here can talk to a network" should be checkable by grep with no exceptions to
explain.
