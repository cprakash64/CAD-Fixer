# Repair kernel bakeoff — results

Stage 3A-2. **Experimental. No kernel is integrated into the CAD Fixer runtime,
and user-facing Repair remains disabled.**

Generated from `results.json`. Re-run with:

```bash
npx vitest run --config vitest.bench.config.ts scripts/repair-bakeoff.bench-suite.ts
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

## Tolerance experiments — R19/R20/R21

**This experiment did not produce usable tolerance data, and the reason is a
hard-gate failure.**

Geogram's `mesh_repair(MESH_REPAIR_COLOCATE, ε)` was run at ε = 1e-5, 5e-4,
1e-3 and 5e-3 against all three near-connectivity fixtures:

| ε    | R19 (crack 1e-3) | R20             | R21 (intentional gap 5e-4) |
| ---- | ---------------- | --------------- | -------------------------- |
| 1e-5 | CRASH / TIMEOUT  | CRASH / TIMEOUT | CRASH / TIMEOUT            |
| 5e-4 | TIMEOUT          | TIMEOUT         | TIMEOUT                    |
| 1e-3 | TIMEOUT          | TIMEOUT         | TIMEOUT                    |
| 5e-3 | TIMEOUT          | TIMEOUT         | TIMEOUT                    |

At ε = 1e-5 the process aborts with

```
Assertion failed: variable_exists.
File: src/lib/geogram/basic/environment.cpp, Line: 217
```

At every larger ε the call does not return within a 30 s budget; an earlier
un-timed run consumed **28 minutes of CPU on a single case** before being
killed.

**Honest attribution: it is NOT established that this is a Geogram defect.**
The assertion names a missing Geogram environment variable, which is consistent
with our minimal binding calling `GEO::initialize()` without whatever
configuration the colocate path expects. Establishing whether this is our
initialisation or an upstream limitation is required before Geogram is judged on
seam healing. Recorded as an open question, not as a verdict.

What the experiment DOES establish: as built and driven here, Geogram's
colocation path is **not usable for tolerance welding**, and it exhibits the
uninterruptible-synchronous-call hazard in its most acute form.

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

## Self-intersection — capability by candidate

| Capability             | Manifold                        | Geogram                                    | PMP  |
| ---------------------- | ------------------------------- | ------------------------------------------ | ---- |
| Detection              | not exposed                     | via intersection machinery                 | none |
| Pair enumeration       | not exposed                     | not bound in this experiment               | none |
| Resolution             | only via boolean reconstruction | `MeshSurfaceIntersection::intersect()` ran | none |
| Boolean reconstruction | yes                             | yes                                        | no   |

**The Manifold self-union experiment was inconclusive because of our binding.**
`selfUnion` was implemented as `Boolean(empty, Add)`, which returns the input
unchanged — R16 came back 24 → 24 triangles with 2 → 2 components. That is a
defect in the binding, not evidence about Manifold: resolving interpenetrating
shells requires unioning the decomposed components against each other. Recorded
as a limitation; the experiment must be repeated before Manifold is judged on
intersection resolution.

Geogram's `intersectSurface` did run on R16, R17, R18, R28 and R29. Note that on
a clean tetrahedron it returned 8 triangles for a 4-triangle input — it
re-triangulates rather than passing clean input through, which is relevant to
its suitability as a general repair pass and deserves follow-up.

**No independent self-intersection oracle was implemented.** Ground truth for
R16–R18 therefore rests on fixture construction, not on measurement, and is
marked accordingly.
