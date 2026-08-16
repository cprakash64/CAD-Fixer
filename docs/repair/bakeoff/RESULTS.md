# Repair kernel bakeoff — results

Stage 3A-2, corrected and extended by **Stage 3A-3A**. **Experimental. No kernel
is integrated into the CAD Fixer runtime, and user-facing Repair remains
disabled.**

> **Stage 3A-3B has now run the browser gate.** All three candidates load,
> instantiate, compute and return independently-validated geometry inside a
> cross-origin-isolated Chromium worker; `Worker.terminate()` cancels real WASM
> work safely for all three; and scaling was measured to 50 MiB. No kernel is
> integrated and Repair remains disabled.
>
> **Evidence classes are kept separate throughout:** `Node/native verified`,
> `browser verified`, `production integrated`. **Nothing is production
> integrated.**

## Artifact generations — do not mix rows across them

Stage 3A-3A rebuilt two candidates, so `results.json` (Stage 3A-2) and the four
Stage 3A-3A files were measured against **different binaries**. Each file
correctly records the artifact it actually measured; none was retroactively
edited.

| Candidate | Stage 3A-2 artifact (`results.json`) | Stage 3A-3A artifact    |
| --------- | ------------------------------------ | ----------------------- |
| geogram   | `057ac90d…` **superseded**           | `73cabc53…`             |
| manifold  | `579f3738…` **superseded**           | `8bd72c68…`             |
| pmp       | `a4e1263c…`                          | `a4e1263c…` (unchanged) |

**Rows from `results.json` for Geogram and Manifold must not be summarised
beside Stage 3A-3A rows**, and are excluded from every Stage 3A-3A conclusion.
PMP's rows are directly comparable — same artifact.
`scripts/results-integrity.test.ts` asserts that no single file mixes
generations.

## Stage 3A-3A corrections to Stage 3A-2

Three Stage 3A-2 conclusions were wrong, and the corrections change the picture
materially.

| Stage 3A-2 said                                                            | Stage 3A-3A found                                                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Geogram's colocate path is "unusable as built", cause unattributed         | **Our initialisation defect.** Fixed; all 36 tolerance runs now succeed in ~5 ms each, on both native and WASM                |
| Geogram colocate times out at every epsilon > 1e-5                         | **No timeouts exist.** The 30 s budget was never approached once initialisation was correct                                   |
| Manifold could not resolve interpenetrating shells (R16 24 → 24 triangles) | **INVALID_EXPERIMENT.** The binding unioned against an empty solid. A real two-solid union resolves R16 into one closed solid |
| R26/R27 are the strongest available precision evidence                     | **They cannot detect scalar narrowing at all** — see Precision below                                                          |

Generated from the JSON files in this directory. Re-run with:

```bash
npx vitest run --config vitest.bench.config.ts scripts/repair-bakeoff.bench-suite.ts
npx vitest run --config vitest.bench.config.ts scripts/geogram-root-cause.bench-suite.ts
npx vitest run --config vitest.bench.config.ts scripts/manifold-boolean.bench-suite.ts
npx vitest run --config vitest.bench.config.ts scripts/idempotence-preservation.bench-suite.ts
npx vitest run --config vitest.bench.config.ts scripts/scalar-precision.bench-suite.ts
```

## Run identity

|                         |                                                                          |
| ----------------------- | ------------------------------------------------------------------------ |
| Corpus version          | `e42e7be9ad00a58a` (SHA-256 over R01–R30 geometry)                       |
| Rows                    | 612 (30 fixtures × candidates × operations × 3 runs)                     |
| Emscripten              | 4.0.16 (`09534bba7f0ee767bf6f6f8cb5b7bf9519b8d63a`), LLD 22.0.0          |
| Host                    | Apple Silicon, 8 GB, macOS; Node v22.22.2                                |
| Transfer representation | Welded positions + indices, via Stage 2 exact stored-coordinate identity |

## Candidate identity

| Candidate         | Commit                                     | Artifact                       | wasm bytes | JS glue |
| ----------------- | ------------------------------------------ | ------------------------------ | ---------- | ------- |
| Manifold v3.5.2   | `11235e6b8ebea2dbed8aec4285685aafd3d95667` | sequential, `MANIFOLD_PAR=OFF` | 296,885    | 9,846   |
| Geogram v1.10.0   | `c8529bb00838186938ab31d96008a59b6a892dee` | tetgen/triangle EXCLUDED       | 1,319,496  | 71,046  |
| PMP (branch head) | `af4725ccf6aa308e7ffad9a7bb927c6381b7c858` | algorithms only, no viewers    | 246,095    | 15,379  |

## R01–R30 matrix

Status is the worst outcome observed across the three runs of each fixture.
"ran" means the candidate produced a mesh that CAD Fixer then validated
independently; it is not a claim that the result was correct.

| Fixture | Manifold              | Geogram            | PMP               |
| ------- | --------------------- | ------------------ | ----------------- |
| R01     | ran                   | ran                | ran               |
| R02     | ran                   | ran                | ran               |
| R03     | rejected(NotManifold) | ran                | UNSUPPORTED_INPUT |
| R04     | rejected(NotManifold) | ran                | UNSUPPORTED_INPUT |
| R05     | ran                   | non-orientable+ran | UNSUPPORTED_INPUT |
| R06     | rejected(NotManifold) | ran                | UNSUPPORTED_INPUT |
| R07     | rejected(NotManifold) | ran                | UNSUPPORTED_INPUT |
| R08     | rejected(NotManifold) | ran                | ran               |
| R09     | rejected(NotManifold) | ran                | ran               |
| R10     | rejected(NotManifold) | ran                | UNSUPPORTED_INPUT |
| R11     | rejected(NotManifold) | ran                | UNSUPPORTED_INPUT |
| R12     | rejected(NotManifold) | ran                | ran               |
| R13     | ran                   | ran                | UNSUPPORTED_INPUT |
| R14     | ran                   | ran                | UNSUPPORTED_INPUT |
| R15     | ran                   | ran                | ran               |
| R16     | ran                   | ran                | ran               |
| R17     | ran                   | ran                | ran               |
| R18     | rejected(NotManifold) | ran                | ran               |
| R19     | rejected(NotManifold) | CRASH+TIMEOUT+ran  | ran               |
| R20     | rejected(NotManifold) | CRASH+TIMEOUT+ran  | ran               |
| R21     | rejected(NotManifold) | CRASH+TIMEOUT+ran  | ran               |
| R22     | ran                   | ran                | ran               |
| R23     | ran                   | ran                | ran               |
| R24     | ran                   | ran                | ran               |
| R25     | ran                   | ran                | ran               |
| R26     | ran                   | ran                | ran               |
| R27     | ran                   | ran                | ran               |
| R28     | rejected(NotManifold) | ran                | UNSUPPORTED_INPUT |
| R29     | rejected(NotManifold) | ran                | ran               |
| R30     | ran                   | ran                | ran               |

## What each result means

**Manifold rejected 15 of 30 fixtures** with `Error::NotManifold`, and accepted 15. That is the documented precondition doing exactly what upstream says it
does. `Merge()` was invoked as an explicit, separately recorded operation and
did **not** rescue any rejected fixture — it recovers near-manifold input, not
broken topology, confirming the Stage 3A-1 assessment from behaviour rather than
from documentation.

**PMP refused 10 fixtures** with `UNSUPPORTED_INPUT_CLASS`: R03, R04, R05, R06,
R07, R10, R11, R13, R14, R28. `pmp::SurfaceMesh` cannot represent them, and
`add_face` throws `TopologyException` before any algorithm runs. This is a role
boundary, not an algorithmic failure, and it is recorded as a distinct status so
it is never scored as one.

**PMP hole filling is verified** — the capability Stage 3A-1 left unverified.
On R08 (cube missing one face) `fill_hole` closed the opening: 10 → 12
triangles, boundary edges 4 → 0, one loop filled. It was invoked only where a
fixture asks for filling.

**Geogram ran the widest range of malformed input**, producing validated output
on 282 rows including every fixture Manifold and PMP refused.

## Control preservation — no candidate damaged a clean model

R01, R02, R15, R21, R22 and R30 were compared before and after on triangle
count, recovered vertex count, component count and surface area.

**Zero control fixtures were modified by any candidate.** No unnecessary
reconstruction, no merging of the disjoint shells in R15, no welding of R21's
deliberately-close parallel sheets, no loss of R22's thin feature.

## R09 — intentional openings survived

The open tube kept both rim loops under every operation that ran:
boundary edges 24 → 24, simple loops 2 → 2, for Geogram's `repairTopology`,
`repairDuplicateFacets` and `reorient`, and for PMP's ingest. Manifold rejected
R09 as non-manifold, which also leaves the openings intact.

No candidate filled an opening it was not asked to fill.

## Geogram colocate — ROOT CAUSE FOUND (Stage 3A-3A)

**The failure was ours, not Geogram's.** Attribution: `INITIALIZATION_DEFECT`.

### The exact path

Reading the pinned source (`c8529bb0`) gives a complete chain from the epsilon
to the assertion:

| Location                    | What happens                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `mesh/mesh_repair.cpp:1186` | `epsilon == 0` selects `colocate_by_lexico_sort`; **non-zero** selects `Geom::colocate` |
| `points/colocate.cpp:231`   | `Geom::colocate` calls `NearestNeighborSearch::create(dim, "default")`                  |
| `points/nn_search.cpp:133`  | name `"default"` triggers `CmdLine::get_arg("algo:nn_search")`                          |
| `points/colocate.cpp:238`   | also reads `CmdLine::get_arg_bool("sys:multithread")`                                   |
| `basic/environment.cpp:217` | undeclared variable reaches `geo_assert(variable_exists)` and aborts                    |

`algo:nn_search` is declared only by `import_arg_group_algo()`
(`basic/command_line_args.cpp:187`); `sys:multithread` only by
`import_arg_group_sys()` (`:306`). **`GEO::initialize()` imports no argument
group at all.** Stage 3A-2's binding called `GEO::initialize()` and nothing
else.

This also explains why _only_ colocate failed: `repairTopology`,
`repairDuplicateFacets` and `reorient` all pass epsilon 0 and take the
lexicographic path, which consults no environment variable.

Upstream corroborates rather than us inferring from a variable name:
`src/tests/test_nn_search/main.cpp:72` imports `"algo"` before using the same
factory, as do `vorpalite` and `vorpastat`.

**Fix:** `CmdLine::import_arg_group("algo")` and `("sys")` — those two only.
Upstream tools also import `"standard"`, which pulls `global`/`nl`/`log`/
`biblio`; this operation reads none of them. No Geogram source was modified, no
assertion was weakened.

### The 2x2 that proves it

One binary per engine, one input, one operation; only initialisation varies.
`initMode 0` reproduces Stage 3A-2 verbatim.

| Engine                      | initMode 0 (Stage 3A-2)                                  | initMode 1 (+ algo, sys) |
| --------------------------- | -------------------------------------------------------- | ------------------------ |
| native (clang, same commit) | 12/12 `EXCEPTION` — `Assertion failed: variable_exists.` | **36/36 RAN**            |
| WASM (emcc 4.0.16)          | 12/12 `ABORTED`                                          | **36/36 RAN**            |

Native reproduces the identical assertion text Stage 3A-2 recorded, so the
failure is not Emscripten-specific. Native and WASM agree on published vertex
and triangle counts for **all 12** (fixture x epsilon) combinations, so there is
no WASM-specific divergence either.

**There were never any timeouts.** Every run completes in ~5–15 ms against a
20 s budget. The Stage 3A-2 "TIMEOUT at every larger epsilon" rows were the
process dying on the assertion, not the algorithm failing to return.

## Tolerance matrix — R19/R20/R21 (Stage 3A-3A)

Three runs each, WASM, `initMode 1`. **Every group was deterministic**: all
three runs identical on every column.

| Fixture                        | eps      | components | boundary edges | topological vertices | merged?               | RMS distance | max sampled |
| ------------------------------ | -------- | ---------- | -------------- | -------------------- | --------------------- | ------------ | ----------- |
| R19 (crack 1e-3)               | 1e-5     | 2 → 2      | 32             | 50                   | no                    | 5.4e-17      | 4.5e-16     |
| R19                            | 5e-4     | 2 → 2      | 32             | 50                   | no                    | 5.4e-17      | 4.5e-16     |
| R19                            | **1e-3** | **2 → 1**  | **24**         | 45                   | **yes**               | 5.8e-17      | 4.5e-16     |
| R19                            | 5e-3     | 2 → 1      | 24             | 45                   | yes                   | 5.8e-17      | 4.5e-16     |
| R20 (gaps 1e-4/1e-3/1e-2)      | 1e-5     | 4 → 4      | 48             | 64                   | no                    | 4.5e-17      | 4.5e-16     |
| R20                            | 5e-4     | 4 → 3      | 42             | 60                   | partial               | 4.5e-17      | 4.6e-16     |
| R20                            | 1e-3     | 4 → 2      | 36             | 56                   | more                  | 4.3e-06      | 3.9e-04     |
| R20                            | 5e-3     | 4 → 2      | 36             | 56                   | more                  | 4.3e-06      | 3.9e-04     |
| **R21 (INTENTIONAL 5e-4 gap)** | 1e-5     | 2 → 2      | 24             | 32                   | no                    | 6.1e-17      | 4.5e-16     |
| **R21**                        | 5e-4     | 2 → 2      | 24             | 32                   | no                    | 6.1e-17      | 4.5e-16     |
| **R21**                        | **1e-3** | **2 → 1**  | **0**          | 16                   | **CONTROL DESTROYED** | **2.5e-04**  | **5.0e-04** |
| **R21**                        | 5e-3     | 2 → 1      | 0              | 16                   | **CONTROL DESTROYED** | 2.5e-04      | 5.0e-04     |

**R20's response is monotonic**, satisfying its acceptance criterion: 4 → 4 → 3
→ 2 → 2 as tolerance rises, never fewer components at a smaller tolerance.

### The finding that matters for the product

**The tolerance that heals R19 is exactly the tolerance that destroys R21.**

R19's crack is 1e-3 and needs eps >= 1e-3 to close. R21's _intentional_ gap is
5e-4 and survives only while eps < 1e-3. There is no single global tolerance
that satisfies both, and R21 exists precisely to establish that. The measured
damage at eps = 1e-3 is unambiguous: two parallel sheets become one closed
shell, boundary edges 24 → 0, and the surface moves by exactly the gap
(max 5.0e-4, RMS 2.5e-4 — half the gap, as expected when both sheets move to
meet in the middle).

**No production default tolerance is proposed, and none should be.** This is
evidence that tolerance must be per-operation and user-visible, not a constant.

## Geogram intersection semantics (Stage 3A-3A)

Stage 3A-2 saw `intersectSurface` turn a clean 4-triangle tetrahedron into 8
triangles and flagged it for follow-up. The pinned header answers it:

`MeshSurfaceIntersection::intersect()` (`mesh/mesh_surface_intersection.h:84`)
is a **mutating insertion-and-resolution pipeline**, not a detector. Its own
documented substeps are: prepare the mesh, find intersection points, **insert**
the intersection points, then clean and retriangulate the result. Retriangulating
clean input is therefore correct behaviour for this API, not a defect — it is
simply not a diagnostic.

| Capability                   | Available in pinned v1.10.0?                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detection only, non-mutating | **No dedicated API.** `set_dry_run(true)` (`:209`) computes local triangulations without inserting them — documented "for benchmarking", not as a query interface     |
| Pair enumeration             | Not exposed as a public result. `mesh_repair.h` offers `mesh_detect_colocated_vertices`, `_isolated_vertices`, `_degenerate_facets` — no self-intersection equivalent |
| Insertion / retriangulation  | Yes — this is what `intersect()` does                                                                                                                                 |
| Resolution                   | Yes, via `intersect()` plus `remove_internal_shells()` / `remove_external_shell()`                                                                                    |

**Consequence for the architecture:** Geogram's intersection machinery cannot be
used as CAD Fixer's self-intersection _diagnostic_ without either running a
mutating operation and discarding the result, or using `dry_run` in a way
upstream does not document as a query API. Neither is acceptable for a
read-only diagnostic. This is recorded for Stage 3A-3B; no self-intersection
system is implemented here.

## Determinism — 201 of 204 groups deterministic

Each (candidate, fixture, operation, parameter) ran three times and was compared
on output triangle count, recovered vertex count, component count and surface
area to nine decimal places.

The only three non-deterministic groups are the ε = 1e-5 colocate cases, which
alternate between CRASH and TIMEOUT. That is a non-deterministic **failure
mode**, not non-deterministic geometry: no candidate produced two different
valid meshes from the same input. The distinction matters and is recorded
separately, per the frozen determinism rule.

## Timing — kernel versus our validation

Median and maximum over validated rows, in milliseconds.

| Candidate | Kernel median | Kernel max | CAD Fixer validation median | validation max |
| --------- | ------------- | ---------- | --------------------------- | -------------- |
| Manifold  | 0.031         | 3.31       | 0.790                       | 8.41           |
| Geogram   | 0.014         | 3726.90    | 0.679                       | 408.25         |
| PMP       | 0.086         | 8.91       | 0.634                       | 1.73           |

Initialisation, measured separately and excluded from operation time:
Manifold 1.7–8.7 ms, Geogram 6.7–15.0 ms, PMP 2.3–5.6 ms.

**Our own validation costs more than most kernel calls at corpus scale.** On
these small fixtures the independent Stage 2 analysis dominates. That is the
right trade — a repair we cannot validate is not a repair — but it means
production repair budgets must include validation, not just kernel time.

Geogram's 3.7 s maximum is `intersectSurface`, the only operation in the run
whose cost is visible at fixture scale.

## Memory

No heap growth was observed on any candidate at corpus scale: Manifold and PMP
stayed at their 32 MiB initial heap, Geogram at 64 MiB. These fixtures are far
too small to exercise growth, so this is a **negative result at this scale
only** and says nothing about large models.

## Manifold — the corrected boolean evidence (Stage 3A-3A)

### The invalid experiment, and why it was excluded

Stage 3A-2's `selfUnion` was `Boolean(Manifold(), OpType::Add)` — a union
against a **default-constructed, empty** Manifold. Union with the empty set is
the identity, so the call returned its input unchanged (R16: 24 → 24 triangles,
2 → 2 components) and that was read as evidence Manifold could not resolve
interpenetration. **It measured nothing.**

Marked `INVALID_EXPERIMENT` in `manifold-boolean.json`, retained for the record,
and excluded from every score and conclusion. The binding still contains the
call, labelled, so the correction can be demonstrated rather than asserted.
Upstream v3.5.2 exposes no self-union operation; inventing one would have been
worse than admitting the gap.

### The upstream APIs actually invoked

| API                                                                   | Location in pinned v3.5.2         |
| --------------------------------------------------------------------- | --------------------------------- |
| `Manifold Manifold::Boolean(const Manifold& second, OpType op) const` | `include/manifold/manifold.h:222` |
| `enum class OpType : char { Add, Subtract, Intersect }`               | `include/manifold/common.h:626`   |
| `bool MeshGL64::Merge()`                                              | `include/manifold/mesh.h:182`     |

### Boolean micro-suite

Every output was validated independently by CAD Fixer's Stage 2 analysis. All
17 rows: 1 component unless stated, 0 boundary edges, 0 non-manifold edges, 0
non-manifold vertices, winding consistent.

| Case                      | Operation   | Output triangles | Components | Kernel volume     | Exact expected volume       |
| ------------------------- | ----------- | ---------------- | ---------- | ----------------- | --------------------------- |
| MB01 overlapping union    | `Add`       | 36               | 1          | 1875              | 1875 ✓                      |
| MB02 disjoint union       | `Add`       | 24               | **2**      | 2000 (−4.5e-13)   | 2000 ✓ **no bridge**        |
| MB03 subtraction          | `Subtract`  | 24               | 1          | 875               | 875 ✓                       |
| MB04 tangent, shared face | `Add`       | 20               | 1          | 2000              | 2000 ✓                      |
| MB05 overlap 1e-9         | `Add`       | 20               | 1          | 2000              | 2000 ✓                      |
| MB05 overlap 1e-6         | `Add`       | 24               | 1          | 2000              | 2000 ✓                      |
| MB05 overlap 1e-3         | `Add`       | 28               | 1          | 2000              | 2000 ✓                      |
| MB06 translated 1e6       | `Add`       | 36               | 1          | 1875.000000002794 | 1875 (rel. err 1.5e-12)     |
| MB07 scale 1e-5           | `Add`       | 36               | 1          | 1.8750001853e-12  | 1.875e-12 (rel. err 9.9e-8) |
| MB09 intersection         | `Intersect` | 12               | 1          | 125               | 125 ✓                       |
| MB10 containment no-op    | `Add`       | 12               | 1          | 1000              | 1000 ✓                      |

**MB08 determinism:** MB01 and MB03 each ran three times; every run produced
identical triangle counts, component counts and volumes.

**MB04/MB05 tangency:** upstream semantics were measured, not assumed. Exact
face contact and a 1e-9 overlap both produce the same 20-triangle merged solid;
larger overlaps retain the sliver (24 then 28 triangles). Volume stays exact
throughout.

**MB10 preservation:** unioning a cube with a cube wholly inside it must return
the outer cube. Measured surface distance from the original: RMS 8.7e-16, max
3.2e-15, normalised 5.0e-17. **Manifold did not rewrite geometry it had no need
to touch.**

### R16 — two interpenetrating closed shells

**Result: the union succeeds, and R16's acceptance criterion is met.**
36 triangles, **1 component**, 0 boundary edges, 0 non-manifold edges, volume
1875 (exact), identical across 3 runs.

Two things Stage 3A-2 conflated are now separated:

- **Ingestion.** Manifold _accepts_ R16's combined 24-triangle soup (status 0).
  Its precondition is topological, and R16 is topologically clean — two closed,
  manifold, correctly wound shells. Interpenetration is a geometric defect its
  ingest does not look for, and Stage 2 cannot see it either.
- **Resolution.** Resolving the interpenetration requires unioning the two
  solids _against each other_, and a boolean needs two operands. So
  decomposition into the two shells is a precondition of the **operation**, not
  a limitation of ingestion. `manifold-boolean.json` records
  `decompositionMatchesFixture: true`, asserting the reconstructed pair is
  topologically identical to the fixture.

This is a test of Manifold's **solid-reconstruction / boolean role**, and it is
explicitly _not_ a test of arbitrary broken-soup ingestion.

### R17 — self-intersecting single shell

**Not `UNSUPPORTED_INPUT_CLASS` for ingest.** R17 is closed, edge-manifold and
consistently wound, so it satisfies Manifold's topological precondition and is
ingested without complaint (status 0).

The real boundary is elsewhere: a self-intersecting _single_ shell has no
decomposition into two valid solids, so there is no second operand and no honest
two-solid boolean to run. Resolving it would need a self-intersection resolution
pass, which v3.5.2 does not expose.

**It was not pre-processed with Geogram to manufacture an input Manifold
handles.** That would have measured the pair and then credited Manifold.

### Merge, kept explicit

`Merge()` is never called invisibly before a boolean. Its return value is now
recorded, which separates "ran and changed nothing" from "repaired the input" —
a distinction Stage 3A-2 discarded.

| Fixture                     | Ingest status after Merge | Merge changed the mesh? |
| --------------------------- | ------------------------- | ----------------------- |
| R02 clean cube              | 0 accepted                | no                      |
| R03 duplicate face          | 2 NotManifold             | yes                     |
| R11 non-manifold edge       | 2 NotManifold             | yes                     |
| R12 bow-tie                 | 2 NotManifold             | yes                     |
| R16 interpenetrating shells | 0 accepted                | no                      |
| R19 crack                   | 2 NotManifold             | yes                     |

**Merge modifies broken input but rescues none of it.** It changed four of six
meshes and not one of those four became ingestible. This confirms the Stage 3A-2
conclusion from a stronger measurement: it recovers near-manifold input, not
broken topology.

## Self-intersection — capability by candidate (updated Stage 3A-3A)

| Capability              | Manifold                                      | Geogram                                                                            | PMP  |
| ----------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- | ---- |
| Detection, non-mutating | not exposed                                   | **no dedicated API**; `set_dry_run` is documented for benchmarking, not as a query | none |
| Pair enumeration        | not exposed                                   | not exposed as a public result                                                     | none |
| Resolution              | via two-solid boolean — **verified**, see R16 | via `MeshSurfaceIntersection::intersect()` (mutating)                              | none |
| Boolean reconstruction  | **yes, verified** (MB01–MB10, R16)            | yes                                                                                | no   |

**No independent self-intersection oracle exists yet.** Ground truth for
R16–R18 still rests on fixture construction, not on measurement. Every
self-intersection claim in this document is therefore
`CANDIDATE_DETECTOR_ONLY` or `UNRESOLVED`, never `CONFIRMED_NONE`. Building an
independent cross-check was **not** part of Stage 3A-3A.

What _did_ improve: R16's union output is confirmed by CAD Fixer's own Stage 2
analysis to be a single closed manifold solid with exactly the volume set
algebra predicts (1875). That is strong circumstantial evidence the
interpenetration was resolved — but volume agreement is not a self-intersection
test, and it is not recorded as one.

## Geometry preservation — the metric, and what it found

Stage 3A-3A implements `symmetricSampledSurfaceDistance` in
`@cadfixer/repair-evaluation` (evaluation only; never in a production bundle).
Deterministic, area-weighted, BVH-accelerated, symmetric. **It is not the
Hausdorff distance** — every maximum is a maximum over a finite sample. See
`SURFACE_DISTANCE.md`.

### Controls — no candidate damaged a clean model, now quantified

Distances from input to first-pass output. The bounding-box diagonal is given
for scale; these are model-coordinate units, **not millimetres**.

| Candidate | Fixture                  | Operation      | RMS               | max sampled | normalised max |
| --------- | ------------------------ | -------------- | ----------------- | ----------- | -------------- |
| geogram   | R01 tetrahedron          | repairTopology | 6.9e-16           | 2.8e-15     | 1.6e-16        |
| geogram   | R02 cube                 | repairTopology | 8.7e-16           | 3.2e-15     | 1.8e-16        |
| geogram   | R09 open tube            | repairTopology | 6.2e-15           | 4.1e-14     | 1.2e-15        |
| geogram   | R15 disjoint shells      | repairTopology | 3.5e-15           | 2.8e-14     | 2.6e-16        |
| geogram   | R21 near-parallel sheets | repairTopology | 4.5e-16           | 4.5e-16     | 3.2e-17        |
| geogram   | R22 thin feature         | repairTopology | 2.4e-12           | 1.9e-10     | 1.3e-11        |
| manifold  | R01 / R02 / R15 / R16    | ingest         | 6.9e-16 – 3.5e-15 | ≤ 2.8e-14   | ≤ 2.6e-16      |
| pmp       | R01 / R02                | ingest         | 6.9e-16 – 8.7e-16 | ≤ 3.2e-15   | ≤ 1.8e-16      |

All at floating-point noise level. **R22's thin dimension is 1e-2 and the
largest movement is 1.9e-10 — seven orders of magnitude smaller. The feature
survives.**

### Intentional reconstruction, quantified rather than judged

A non-zero distance means the geometry changed. Whether that is acceptable is
the fixture's acceptance criteria talking, not the metric's.

| Candidate | Fixture | Operation     | RMS       | max         | Δtri   | Δcomp  | Δboundary | Reading                                   |
| --------- | ------- | ------------- | --------- | ----------- | ------ | ------ | --------- | ----------------------------------------- |
| geogram   | R19     | colocate 1e-3 | 2.1e-06   | 2.7e-04     | 0      | **−1** | −8        | crack healed, geometry barely moved       |
| geogram   | R20     | colocate 1e-3 | see below | see below   | 0      | **−2** | −12       | two gaps healed                           |
| geogram   | R21     | colocate 1e-3 | 2.5e-04   | **5.0e-04** | 0      | **−1** | −24       | **control destroyed**                     |
| pmp       | R08     | fillHoles     | 5.9e-01   | 4.87        | **+2** | 0      | −4        | hole filled; large change is correct here |

### A measured limitation of the metric

A sampled maximum can miss a change confined to a strip thinner than the sample
spacing. That is not theoretical — it happened, and is recorded rather than
smoothed over. Same comparison, three sample densities:

| Fixture / operation | 2 000 samples | 8 000   | 32 000  | Stable? |
| ------------------- | ------------- | ------- | ------- | ------- |
| R19 colocate 1e-3   | 4.5e-16       | 2.7e-04 | 4.0e-04 | **no**  |
| R20 colocate 1e-3   | 4.5e-16       | 4.6e-16 | 3.8e-04 | **no**  |
| R21 colocate 1e-3   | 5.0e-04       | 5.0e-04 | 5.0e-04 | yes     |
| R08 fillHoles       | 4.89          | 4.87    | 4.93    | yes     |
| all controls        | ~1e-15        | ~1e-15  | ~1e-15  | yes     |

Welding a 1e-4 seam moves a sliver holding roughly 1e-5 of the surface area, so
whether _any_ sample lands on it is close to chance. Where the change covers
meaningful area — R21's whole sheet, R08's filled face — the metric is stable
across a 16x density range.

**Consequence: for thin-seam operations, component and boundary counts are the
reliable evidence and sampled distance is a lower bound.** The decision-critical
number, R21's 5.0e-04, is in the stable class.

## Idempotence (Stage 3A-3A)

`f(f(x))` vs `f(x)`, asserted over the full Stage 2 summary **and** bounding
box, surface area, signed volume, and the A↔B sampled surface distance — not
triangle counts, which would let a kernel that reshuffled coordinates pass.

**39 PASS, 1 UNSUPPORTED, 0 FAIL.**

| Candidate | Operation             | Fixtures                                        | Result                                               |
| --------- | --------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| geogram   | repairTopology        | R01 R02 R03 R05 R06 R07 R09 R15 R21 R22 R28 R30 | 12 PASS                                              |
| geogram   | repairDuplicateFacets | R01 R02 R03 R04 R28 R30                         | 6 PASS                                               |
| geogram   | reorient              | R01 R02 R07 R28 R30                             | 5 PASS                                               |
| geogram   | repairColocate @ 1e-3 | R19 R20 R21                                     | 3 PASS                                               |
| pmp       | fillHoles             | R08                                             | 1 PASS                                               |
| pmp       | fillHoles             | R28                                             | **UNSUPPORTED** — `SurfaceMesh` cannot represent R28 |
| pmp       | ingest                | R01 R02 R22 R26 R27                             | 5 PASS                                               |
| manifold  | ingest                | R01 R02 R15 R16 R26 R27 R30                     | 7 PASS                                               |

`repairColocate` is parameter-dependent, so it is idempotent only _at a fixed
tolerance_ — which is the only sense in which a tolerance operation can be. R09
is deliberately excluded from hole filling: deciding to fill it is the product
decision R09 exists to catch.

## Precision — and why the corpus could not see it

### The corpus is blind to scalar narrowing

**`PositionArray = Float32Array`** (`packages/mesh-core/src/mesh.ts:27`). Every
corpus fixture is already float32 before any candidate sees it, so asking a
candidate "do you round to float32?" using corpus geometry is a question that
cannot return yes.

R26 is blind twice over: its coordinates are integers below 2^24, which binary32
represents **exactly**, so it cannot detect narrowing at any storage precision.
This makes the Stage 3A-1/3A-2 description of R26/R27 as the strongest available
precision evidence wrong for this question. The fixtures are not defective — they
test what they were built to test — but they cannot answer this.

**No fixture was changed.** A separate probe bypasses the corpus, feeding the
Float64 transfer buffers coordinates binary32 cannot hold, with the expected
delta stated in advance as `|v - Math.fround(v)|`.

| Candidate | offset 0, predicted 4.77e-08 | offset 1e6, predicted 2.50e-02 | Verdict                  |
| --------- | ---------------------------- | ------------------------------ | ------------------------ |
| manifold  | observed 0                   | observed 0                     | `PRESERVES_FLOAT64`      |
| geogram   | observed 0                   | observed 0                     | `PRESERVES_FLOAT64`      |
| pmp       | observed 4.768e-08           | observed 2.500e-02             | **`NARROWS_TO_FLOAT32`** |

PMP matches the float32 prediction to the digit at both magnitudes.

### PMP scalar configuration — fact check

| Question                                      | Answer                 | Evidence                                                                                |
| --------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| Scalar typedef                                | `using Scalar = float` | `src/pmp/types.h:17-21`, `#ifdef PMP_SCALAR_TYPE_64` → `double`, else `float`           |
| Is `PMP_SCALAR_TYPE_64` defined in our build? | **No**                 | absent from the build `CMakeCache.txt` and from the `em++` line compiling `binding.cpp` |
| Does the artifact narrow doubles?             | **Yes, measured**      | see table above                                                                         |
| Is a double build supported?                  | **Yes**                | `-DPMP_SCALAR_TYPE=64` → `CMakeLists.txt:167` defines `PMP_SCALAR_TYPE_64`              |
| Was a double build tested?                    | **No**                 | not rebuilt; artifact/memory cost of a double build is unmeasured                       |

This describes **only** the artifact actually benchmarked
(`a4e1263c…`, 246,095 bytes).

### Generated-coordinate precision (Manifold booleans)

Boolean-generated intersection vertices, compared against exact set algebra:

| Case | Coordinate magnitude | Kernel volume          | Exact     | Relative error |
| ---- | -------------------- | ---------------------- | --------- | -------------- |
| MB01 | ~1e1                 | 1875                   | 1875      | 0              |
| MB06 | ~1e6                 | 1875.000000002794      | 1875      | **1.5e-12**    |
| MB07 | ~1e-4                | 1.8750001853186634e-12 | 1.875e-12 | **9.9e-08**    |

Both are far above float32 resolution, consistent with the float64 pipeline.
The **small-scale case is five orders worse than the large-scale one**, which is
the opposite of the usual intuition and worth carrying into ADR 0004.

## What Stage 3A-3A did NOT do

- No browser execution of any candidate. **`BROWSER_GATE_PENDING` for all three.**
- No `Worker.terminate()` measurement; cancellation evidence is still
  process-kill at Node granularity.
- No large-model scaling — the corpus remains tiny (≤ 200 triangles).
- No independent self-intersection oracle.
- No production integration, and Repair remains disabled.

---

# Stage 3A-3B — browser qualification, cancellation, scaling

Generated files: `browser-qualification.json`, `browser-cancellation.json`,
`browser-scaling.json`. Harness `stage-3a-3b.1`, corpus `e42e7be9ad00a58a`
(unchanged and unedited).

Re-run with:

```bash
npx vitest run --config vitest.bench.config.ts scripts/browser-prepare.bench-suite.ts
npx playwright test --config playwright.browser-harness.config.ts
npx vitest run --config vitest.bench.config.ts scripts/browser-validate.bench-suite.ts
```

## The harness

A plain `node:http` server on `127.0.0.1:4174` sends the **same** COOP/COEP
headers as the application (`same-origin` / `require-corp` / CORP
`same-origin`), serves the harness page, a module Worker, and each candidate's
artifacts as raw bytes. **Vite is not involved** — its transform destroys
Emscripten's ES6 glue, which fabricated 321 "crashes" in Stage 3A-2 — so the
browser instantiates the byte-identical artifact whose SHA-256 the manifests
record.

Three separated steps: prepare (vitest) → drive (Playwright) → **validate
(vitest, separate process, CAD Fixer's own Stage 2 oracle)**. A candidate cannot
influence its own verdict, and neither can the driver.

|                       |                                                          |
| --------------------- | -------------------------------------------------------- |
| Browser               | Chromium `HeadlessChrome/151.0.7922.34`                  |
| `crossOriginIsolated` | **true** — asserted in the browser, not read off headers |
| `SharedArrayBuffer`   | available                                                |
| WASM loading          | the glue's own streaming fetch of a same-origin `.wasm`  |

## Browser candidate matrix — all three pass

Every artifact SHA is the Stage 3A-3A artifact, unchanged. **No rebuild was
required for the browser.**

| Candidate | Artifact SHA-256    | Worker  | Glue import | WASM instantiate | Init total | Initial heap |
| --------- | ------------------- | ------- | ----------- | ---------------- | ---------- | ------------ |
| manifold  | `8bd72c68df6d2785…` | 0.88 ms | 20.2 ms     | 23.6 ms          | 55.0 ms    | 32 MiB       |
| geogram   | `73cabc53caeb3d85…` | 0.09 ms | 5.3 ms      | 16.9 ms          | 29.5 ms    | 64 MiB       |
| pmp       | `a4e1263cb8f41abc…` | 0.10 ms | 2.2 ms      | 6.0 ms           | 15.6 ms    | 32 MiB       |

**16 VALIDATED, 1 UNSUPPORTED_INPUT_CLASS, 0 failures.**

| Case | Candidate | Result                                                   | Kernel | CAD Fixer verdict       |
| ---- | --------- | -------------------------------------------------------- | ------ | ----------------------- |
| BM01 | manifold  | clean solid ingest, 12 tris, volume 1000                 | 4.2 ms | VALIDATED               |
| BM02 | manifold  | overlapping union, 36 tris, 1 component, volume 1875     | 4.6 ms | VALIDATED               |
| BM03 | manifold  | disjoint union, **2 components, no bridge**              | 0.2 ms | VALIDATED               |
| BM04 | manifold  | R16 two-shell union, 1 closed component, volume 1875     | 0.5 ms | VALIDATED               |
| BM05 | manifold  | near-coplanar 1e-6 overlap, 24 tris, volume 2000         | 0.6 ms | VALIDATED               |
| BM06 | manifold  | boolean at 1e6, volume 1875.000000002794                 | 0.3 ms | VALIDATED               |
| BM07 | manifold  | boolean at 1e-4, volume 1.8750001853e-12                 | 0.3 ms | VALIDATED               |
| BG01 | geogram   | clean cube unchanged, 12 tris                            | 5.0 ms | VALIDATED               |
| BG02 | geogram   | R28 mixed defects                                        | 0.3 ms | VALIDATED               |
| BG03 | geogram   | R19 tolerance 1e-5 — **does not weld**, 2 components     | 1.1 ms | VALIDATED               |
| BG04 | geogram   | R19 tolerance 1e-3 — **welds**, 1 component              | 0.2 ms | VALIDATED               |
| BG05 | geogram   | R21 tolerance 5e-4 — **gap survives**, 2 components      | 0.1 ms | VALIDATED               |
| BG06 | geogram   | R21 tolerance 1e-3 — **control destroyed**, 1 component  | 0.1 ms | VALIDATED               |
| BG07 | geogram   | R17 intersection/remeshing, 44 tris (from 12)            | 6.0 ms | VALIDATED               |
| BP01 | pmp       | clean manifold ingest, 12 tris                           | 1.3 ms | VALIDATED               |
| BP02 | pmp       | R08 explicit hole fill, boundary 4 → 0                   | 1.8 ms | VALIDATED               |
| BP03 | pmp       | R11 non-manifold — **refused by our adapter, status 10** | 0.9 ms | UNSUPPORTED_INPUT_CLASS |

**Browser reproduces Node exactly.** Every Manifold volume matches the Stage
3A-3A Node figure to the digit, including `1875.000000002794` at 1e6 and
`1.8750001853186634e-12` at 1e-4. BG06's damage to R21 measures RMS 2.5e-04 /
max 5.0e-04 in the browser — the same numbers Node produced. The R19/R21
tolerance conflict is not a host artefact.

## Privacy — request audit

9 requests, **1 origin**, **0 foreign-origin requests**:

```
http://127.0.0.1:4174/  /harness.js  /candidate-worker.js  /scale-meshes.mjs
/artifacts/{manifold,geogram,pmp}/*-candidate.js
/artifacts/{manifold,geogram,pmp}/*-candidate.wasm
```

No CDN, no remote WASM, no telemetry, no external module loader. The harness
code contains no network API at all — the candidate glue performs its own
same-origin `.wasm` fetch, which is what makes the loading path the real one.

## Worker cancellation — HARD GATE PASSED by all three

Real candidate CPU work, sized at run time until it exceeded 700 ms, then
terminated 200 ms in. No `setTimeout`, no sleep, no unrelated busy-loop. The
page holds the authoritative geometry; the worker gets a structured-clone copy.

|                                       | manifold                | geogram                                    | pmp                            |
| ------------------------------------- | ----------------------- | ------------------------------------------ | ------------------------------ |
| Workload                              | sphere ∪ sphere boolean | intersection of 2 interpenetrating spheres | hole fill, large boundary loop |
| Triangles                             | 210,680                 | 57,120                                     | 487,900                        |
| Calibrated kernel time                | 713 ms                  | 570 ms                                     | **48,829 ms**                  |
| Still computing at terminate          | **yes** (1 pending)     | **yes** (1 pending)                        | **yes** (1 pending)            |
| Main thread responsive during kernel  | 13.8 ms                 | 0.48 ms                                    | 6.7 ms                         |
| `terminate()` call                    | 0.33 ms                 | 0.01 ms                                    | 0.33 ms                        |
| Late messages in a 1.2 s quiet window | **0**                   | **0**                                      | **0**                          |
| Authoritative geometry digest         | unchanged               | unchanged                                  | unchanged                      |
| Restart init                          | 87.0 ms                 | 32.5 ms                                    | 16.4 ms                        |
| Recovery operation                    | 2.4 ms, 4 tris          | 7.4 ms, 4 tris                             | 0.4 ms, 4 tris                 |
| **Verdict**                           | **PASS**                | **PASS**                                   | **PASS**                       |

**Termination latency is an OBSERVATION BOUND, not a kernel-stop time.** The
platform exposes no termination event, so what was measured is that the
`terminate()` call itself returns in well under a millisecond and that nothing
further arrived during a 1.2 s quiet window. It is _not_ a measurement of when
the WASM instruction stream stopped, and it is not described as one.

**Source geometry survives.** FNV-1a digests over the raw bytes are identical
before and after termination, and the buffer is not detached — the harness posts
without a transfer list on purpose, because transferring would have destroyed
the only copy.

### Stale-result protection

A worker terminated mid-boolean, replaced, and the replacement ran its own
small operation: it returned **4 triangles** (its own tetrahedron), not the
sphere boolean the dead worker was computing. Every message carries
`(sessionId, opId)` and the page drops anything that does not match a live
session.

**Stated precisely: 0 stale messages were actually observed.** `terminate()`
prevented the dead worker from posting at all, so the identity guard was not
exercised by a real late message in this run. The guard exists and is asserted;
this run shows the platform did not need it.

## Persistent versus disposable worker — measured, not assumed

Five operations each. The received wisdom is that a disposable worker per
operation is too expensive; that is measurable, so it was measured.

| Candidate | Persistent per-op | Disposable per-op | Disposable penalty |
| --------- | ----------------- | ----------------- | ------------------ |
| manifold  | 3.19 ms           | 10.42 ms          | **+7.2 ms**        |
| geogram   | 5.20 ms           | 21.61 ms          | **+16.4 ms**       |
| pmp       | 1.74 ms           | 8.21 ms           | **+6.5 ms**        |

**The disposable model costs 6–17 ms per operation.** Against repair operations
that take hundreds of milliseconds to tens of seconds at realistic sizes, that
is noise. The assumption that disposable workers are too expensive is **not
supported by the measurements**.

## Scaling — 1 / 10 / 50 MiB, sequential

Geometry generated **in the page** (an earlier version built it in Node and
killed the test runner with a JS heap OOM crossing the Playwright bridge).
Sizes are actual transfer bytes. Every size ran; none hit the safety budget;
the page survived all of them.

| Candidate | Operation      | Input    | Triangles | Ingest | Kernel       | Extract | WASM heap before → after | Output   |
| --------- | -------------- | -------- | --------- | ------ | ------------ | ------- | ------------------------ | -------- |
| manifold  | Boolean Add    | 0.86 MiB | 37,536    | 0.0 ms | 104 ms       | 0.0 ms  | 32 → 32 MiB              | 0.65 MiB |
| manifold  | Boolean Add    | 11.0 MiB | 482,160   | 0.0 ms | 782 ms       | 0.0 ms  | 32 → **288 MiB**         | 8.25 MiB |
| manifold  | Boolean Add    | 45.0 MiB | 1,964,160 | 0.0 ms | **3,508 ms** | 0.0 ms  | 32 → **1,116 MiB**       | 33.5 MiB |
| geogram   | repairTopology | 1.16 MiB | 50,176    | 0.1 ms | 19 ms        | 0.2 ms  | 64 → 64 MiB              | 1.16 MiB |
| geogram   | repairTopology | 10.4 MiB | 451,584   | 1.0 ms | 121 ms       | 1.0 ms  | 64 → 64 MiB              | 10.4 MiB |
| geogram   | repairTopology | 50.8 MiB | 2,214,144 | 4.2 ms | **546 ms**   | 18.8 ms | 64 → **207 MiB**         | 50.8 MiB |
| pmp       | ingest         | 1.01 MiB | 44,310    | 0.3 ms | 35 ms        | 0.1 ms  | 32 → 32 MiB              | 1.01 MiB |
| pmp       | ingest         | 9.69 MiB | 423,150   | 1.1 ms | 261 ms       | 1.0 ms  | 32 → 80 MiB              | 9.69 MiB |
| pmp       | ingest         | 52.1 MiB | 2,277,080 | 9.1 ms | **1,619 ms** | 19.9 ms | 32 → **353 MiB**         | 52.1 MiB |

### The memory finding

**Manifold's boolean is the memory outlier: ~25× the input.** A 45 MiB pair of
solids drove the WASM heap to 1,116 MiB. Geogram's topology repair reached 207
MiB on a _larger_ 50.8 MiB input (~4×), and PMP's ingest 353 MiB on 52.1 MiB
(~7×). Extrapolating Manifold linearly, a 100 MiB boolean would want ~2.4 GiB
of WASM heap — beyond what a browser tab can be relied on to provide. **A
production boolean must impose a size ceiling and refuse above it.**

These are `WebAssembly.Memory` buffer lengths observed inside the worker. They
are **not** process RSS and are not reported as such.

### PMP hole filling does not scale with the loop

| Boundary loop                   | Triangles | Kernel        |
| ------------------------------- | --------- | ------------- |
| 24                              | 504       | 15 ms         |
| 48                              | 2,160     | 37 ms         |
| 96                              | 8,928     | 96 ms         |
| ~220 (cancellation calibration) | 487,900   | **48,829 ms** |

Growth is steep and clearly superlinear. **PMP hole filling must be bounded by
boundary-loop length, not by mesh size**, and a production integration has to
refuse or chunk long loops rather than start a 49-second uninterruptible call.
This is exactly why the cancellation architecture matters.

## Large-run preservation

| Candidate | Operation      | 50 MiB output                   | Expected                                 | Reading                                                        |
| --------- | -------------- | ------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| pmp       | ingest         | area 12.566325, volume 4.188760 | 4π = 12.566371, 4π/3 = 4.188790          | sphere preserved; residual is tessellation, not damage         |
| geogram   | repairTopology | area 1,107,072 exactly          | 2 × 744² grid area                       | **exact**, no geometry change                                  |
| manifold  | Boolean Add    | area 16.964485, volume 6.298015 | converging (16.9587 → 16.9641 → 16.9645) | converges with refinement, as a union of two unit spheres must |

No non-finite coordinate was produced at any size by any candidate.

## What Stage 3A-3B still does NOT establish

- **No independent self-intersection oracle.** R16's browser union is
  topologically clean and has exactly the volume set algebra predicts, but
  volume agreement is not an intersection test. Self-intersection absence is
  **NOT PROVEN** for any output.
- Geogram's `intersect()` remains a mutating retriangulation, not a read-only
  detector.
- No production integration of any kind.
