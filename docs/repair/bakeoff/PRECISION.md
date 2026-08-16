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
