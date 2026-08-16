# Precision findings

Stage 3A-2. **ADR 0004 remains OPEN.** This records what was measured and what
was not, because the measurements that would settle it were not all performed.

## Transfer precision

Every candidate received **Float64** coordinates, widened once at the boundary
from the Float32 canonical store. Identical treatment for all three, so no
candidate is advantaged or handicapped by our storage choice.

That widening is also what a production integration would do, which makes the
comparison representative rather than synthetic.

## Candidate internal precision — from the built artifacts

| Candidate | Coordinate storage               | Predicates                                                   | Constructions                                              |
| --------- | -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Manifold  | double (`MeshGL64`)              | floating-point with a tracked accumulated `tolerance()`      | floating-point                                             |
| Geogram   | double                           | **robust/exact predicates available** in relevant algorithms | **not exact** — constructed coordinates are floating-point |
| PMP       | `pmp::Scalar` (float by default) | plain floating-point                                         | floating-point                                             |

**The wording correction Stage 3A-1 needed.** Describing Geogram as "exact" is
too broad and this stage does not repeat it. Exact _predicates_ answer
orientation and in-sphere questions robustly; they do **not** make coordinate
storage exact, do **not** make constructed intersection points exact, and do
**not** make every algorithm numerically exact. Those are three separate
properties and only the first is claimed.

Note also that PMP's default scalar is **float**, not double — so the Float64
we hand it is narrowed on ingest. That is a real precision consideration for the
hole-filling role and was not further quantified here.

## Scale fixtures that ran

R26 (small solid translated 10⁶ units from the origin) and R27 (whole extent
10⁻⁴) were both **accepted and processed without incident** by Manifold and
Geogram, and both were preserved unchanged — they appear in the control set that
no candidate modified.

That is a genuine but weak result: it shows no candidate fell over at those
magnitudes. It does **not** measure coordinate drift, because the operations
that ran on them were non-mutating.

## What was NOT measured, and therefore what ADR 0004 still lacks

1. **Float32 versus Float64 canonical storage side by side.** The disagreement
   rate in recovered vertex count at 10⁶ magnitudes — the number the ADR
   actually needs — was not produced.
2. **Coordinate drift through a mutating operation** at extreme magnitudes.
3. **Intersection-generated coordinates.** Geogram's `intersectSurface` ran, but
   the precision of the coordinates it constructs was not compared against a
   higher-precision reference.
4. **Boolean-generated coordinates.** The Manifold boolean micro-suite was not
   completed (see RESULTS.md — the self-union binding was defective).
5. **Tolerance-welding precision.** The colocate path crashed or hung, so no
   welding precision data exists at all.

## Status

**ADR 0004 stays open.** Nothing here justifies closing it, and closing it on
this evidence would be exactly the argument-over-measurement mistake the ADR
warns against.

The one thing this stage adds: since candidates work in double and at least one
narrows to float internally, a future architecture of _Float32 source ingest →
Float64 repair working representation_ is not contradicted by anything observed
— but it is not yet supported by measurement either.

---

## Stage 3A-3A — measured scalar behaviour, and a corpus blind spot

**The corpus cannot detect candidate float32 narrowing.**
`PositionArray = Float32Array` (`packages/mesh-core/src/mesh.ts:27`), so every
fixture is already float32 before a candidate sees it. R26 is blind twice over:
its coordinates are integers below 2^24, which binary32 represents exactly.

This does not make the fixtures defective — they test what they were built to
test — but it means the Stage 3A-1/3A-2 description of R26/R27 as the strongest
precision evidence is wrong **for this question**. No fixture was changed. A
separate probe (`scripts/scalar-precision.bench-suite.ts`) bypasses the corpus,
feeding the Float64 transfer buffers coordinates binary32 cannot hold, with the
expected delta stated in advance as `|v - Math.fround(v)|`.

| Candidate | offset 0 (predicted 4.77e-08) | offset 1e6 (predicted 2.50e-02) | Verdict                  |
| --------- | ----------------------------- | ------------------------------- | ------------------------ |
| Manifold  | 0                             | 0                               | `PRESERVES_FLOAT64`      |
| Geogram   | 0                             | 0                               | `PRESERVES_FLOAT64`      |
| PMP       | 4.768e-08                     | 2.500e-02                       | **`NARROWS_TO_FLOAT32`** |

### PMP configuration, verified against the pinned source and the built artifact

- `using Scalar = float` — `src/pmp/types.h:17-21`, selected because
  `PMP_SCALAR_TYPE_64` is **not** defined.
- Not defined in our build: absent from the build `CMakeCache.txt` and from the
  `em++` command line that compiles `binding.cpp`.
- A double build **is** supported: `-DPMP_SCALAR_TYPE=64` causes
  `CMakeLists.txt:167` to define `PMP_SCALAR_TYPE_64`.
- **Not rebuilt in double.** Artifact size and memory cost of a double build are
  unmeasured. This describes only the benchmarked artifact
  (`a4e1263c…`, 246,095 bytes).

### Generated-coordinate precision — the evidence Stage 3A-2 lacked

Stage 3A-2's precision rows came from **non-mutating** operations, which cannot
show coordinate generation. Manifold booleans generate intersection vertices;
compared against exact set algebra:

| Case | Magnitude | Kernel volume          | Exact     | Relative error |
| ---- | --------- | ---------------------- | --------- | -------------- |
| MB01 | ~1e1      | 1875                   | 1875      | 0              |
| MB06 | ~1e6      | 1875.000000002794      | 1875      | 1.5e-12        |
| MB07 | ~1e-4     | 1.8750001853186634e-12 | 1.875e-12 | 9.9e-08        |

**The small-scale case is five orders of magnitude worse than the large-scale
one** — the opposite of the usual intuition, and the single most useful number
here for ADR 0004.

### Open

- A float32 canonical store is coarser than Manifold's and Geogram's float64
  pipelines. Feeding a kernel float64 is pointless if the model was already
  quantised on import. ADR 0004 stays **open**; this is evidence, not a decision.
- Browser-side precision is unmeasured (`BROWSER_GATE_PENDING`).

---

## Stage 3A-3B — browser precision, and the widening trap

### Browser reproduces Node exactly

Every Manifold volume matched the Node figure to the last digit:

| Case                | Browser volume         | Node volume (Stage 3A-3A) |
| ------------------- | ---------------------- | ------------------------- |
| overlapping union   | 1875                   | 1875                      |
| union at 1e6        | 1875.000000002794      | 1875.000000002794         |
| union at 1e-4 scale | 1.8750001853186634e-12 | 1.8750001853186634e-12    |

Precision behaviour is a property of the candidate, not of the host. The
small-scale case remains **five orders of magnitude worse** than the
large-coordinate case (9.9e-08 vs 1.5e-12 relative), in the browser too.

### The layered picture, stated carefully

| Layer                         | Precision                                               | Verified                    |
| ----------------------------- | ------------------------------------------------------- | --------------------------- |
| Canonical source storage      | **Float32** (`PositionArray`, mesh-core/src/mesh.ts:27) | by inspection               |
| Transfer to candidate         | Float64                                                 | by construction             |
| Manifold working precision    | Float64 (`MeshGL64`)                                    | probe, Node + browser       |
| Geogram working precision     | Float64                                                 | probe, Node + browser       |
| PMP working precision         | **Float32** (`Scalar = float`)                          | probe, Node                 |
| Generated boolean coordinates | Float64 quality                                         | volume vs exact set algebra |
| Render snapshot               | Float32                                                 | by design (ADR 0004)        |

### WIDENING IS NOT RECOVERY

Float32 canonical coordinates widened to Float64 before a kernel **do not
regain the bits lost at import**. The widening is not useless — it stops the
kernel from adding a _second_ rounding, and it is what lets a boolean compute
new intersection coordinates at full double precision — but it cannot undo the
first one.

This distinction decides where precision actually matters:

- **Preserved coordinates** — nothing is recovered by widening. If the source
  was quantised at import, that is permanent.
- **Newly constructed coordinates** — boolean intersection vertices, hole-fill
  interiors, future offsets — are computed at working precision and _are_
  affected. This is where Float64 earns its cost, and where storing the result
  back into a Float32 canonical buffer would immediately throw away what the
  kernel just computed carefully.

### Not done

A double-precision PMP build (`-DPMP_SCALAR_TYPE=64`) was **not** produced. The
comparison was optional and the browser gate was the priority; PMP's
float32-ness is already established by direct probe.
