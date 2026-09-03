# 0012 — Read-only self-intersection diagnostic architecture

Status: **Accepted for Stage 3C-1B integration.** Stage 3C-1A research, revised
by Stage 3C-1A-R1. Nothing in this ADR is implemented in production yet.

Date: 2026-09-03 (Stage 3C-1A), revised 2026-09-03 (Stage 3C-1A-R1)

> **Reading this document.** The Stage 3C-1A sections below are the original
> evidence and are preserved unchanged, including measurements that R1 later
> improved on. Sections marked **R1** record what the follow-up stage
> established. Where the two disagree, R1 governs and says so explicitly.

## Context

`selfIntersectionStatus` has been `not-checked` since Stage 2, and every repair
verdict in the product is followed by the qualifier that self-intersections and
wall thickness have not been checked. That is truthful, and it stays truthful
until a diagnostic exists that can be trusted.

This ADR records what Stage 3C-1A established experimentally about building one.

## Decision

Build the diagnostic from **two narrow, read-only Geogram entry points**, not
from Geogram's surface-intersection workflow:

```
canonical mesh (worker-resident, Float32 storage)
        │  disposable Float64 copy, transferred worker → worker
        ▼
GEO::MeshFacetsAABB(const Mesh&)              read-only broadphase, streaming
        ▼  candidate pair (f1 < f2), one callback invocation at a time
topology-aware adjacency  (Stage 2 exact vertex identity)
        ▼
GEO::triangles_intersections(..., global indices, TriangleIsects)
        ▼  symbolic TriangleRegion pairs
classification → bounded aggregate counts + bounded samples
```

## Pinned kernel

|              |                                                                               |
| ------------ | ----------------------------------------------------------------------------- |
| Geogram      | v1.10.0, `c8529bb00838186938ab31d96008a59b6a892dee`                           |
| Emscripten   | emsdk 4.0.16                                                                  |
| Licence gate | `GEOGRAM_WITH_TETGEN=OFF`, `GEOGRAM_WITH_TRIANGLE=OFF`, audit re-run and PASS |

No upgrade was taken and none is proposed here. The APIs this design needs all
exist at the pinned revision, verified by reading that revision's source rather
than current documentation.

## Why the high-level path is rejected

`MeshSurfaceIntersection` takes `Mesh&` and `intersect()` rewrites the mesh it
was handed (`mesh_surface_intersection.h:74,84,586`). It is a **resolver**, not a
detector. Using it to answer a diagnostic question would mean mutating
authoritative geometry to discover whether that geometry was broken, which
inverts the entire point. It is not used, and immutability is not inferred from
any method name.

The AABB constructor needs the same care: `initialize(Mesh&, AABB_INPLACE)`
calls `mesh_reorder()` and **does** permute the mesh (`mesh_AABB.cpp:402-405`).
The design uses `MeshFacetsAABB(const Mesh&)`, which selects `AABB_INDIRECT` and
keeps its ordering in a side vector (`mesh_AABB.h:484`).

## Precision contract

Canonical storage is Float32 today. The diagnostic **widens the stored values to
Float64** for the working copy and invents nothing: no epsilon, no weld, no
snap, no proximity threshold. Two coordinates are the same point only if they
are the same stored value.

**Narrow claim, deliberately.** Geogram's `PCK` orientation predicates used here
are exact sign predicates, and the classification is exact _with respect to the
Float64 values it is given_. This is **not** a claim that "Geogram geometry is
exact" in general, and it is not a claim of exact geometric construction.

Consequence, and it is honest rather than convenient: a model whose true
geometry only self-intersects below Float32 storage resolution cannot be
detected, because that information was lost at import, not here.

## Frozen taxonomy

Adjacency comes from **Stage 2's exact stored-coordinate vertex identity** — the
same identity the rest of CAD Fixer uses. No second merging scheme exists in the
diagnostic; one that welded differently from the analyser would disagree with it
about what the model is.

| Category                         | Shared topological vertices    | Counts as self-intersection         |
| -------------------------------- | ------------------------------ | ----------------------------------- |
| `PROPER_CROSSING`                | 0                              | yes                                 |
| `COPLANAR_OVERLAP`               | 0                              | yes                                 |
| `NON_ADJACENT_EDGE_TOUCH`        | 0                              | yes — reported as contact           |
| `NON_ADJACENT_POINT_TOUCH`       | 0                              | yes — reported as contact           |
| `ADJACENT_OVERLAP_BEYOND_SHARED` | 1 or 2                         | yes                                 |
| `LEGITIMATE_SHARED`              | 1 or 2, contact confined to it | **no**                              |
| `DUPLICATE_TOPOLOGY_DEFECT`      | 3                              | **no** — Stage 2 already reports it |

Exact touches between topologically unrelated faces are **reported**, not
silently dropped: they are real geometric contact, and a diagnostic that hid
them would be quietly choosing which truths to tell.

Duplicates are counted in their own bucket and excluded from
`intersectingPairCount`, so one defect is never reported twice under two names.

## Degenerate policy, and why the report can say `PARTIAL`

The pinned narrowphase documents its own precondition: inputs "are supposed to
be non-degenerate (their three vertices are supposed to be distinct and not
co-linear)" (`triangle_intersection.h:196`). Repeated-position and collinear
faces are therefore **skipped and counted**, and any mesh with a skipped face
reports `PARTIAL`, never `CHECKED`.

A mesh that was not fully examined must not receive a clean bill of health.

## The duplicate guard is load-bearing

`GEO::TriangleIsects` is a **fixed 20-element stack buffer** whose `push_back` is
`geo_assert(size_ < capacity_)` — an always-on assertion, not a debug one
(`triangle_intersection.h:151,185`). Two identical triangles generate more
transient symbolic vertices than that and **abort the process**; under
Emscripten that kills the module outright. This was reproduced: SI10 aborted the
native harness with a stack trace through `TriangleIsects::push_back`.

Mitigation, and it is complete for exact duplicates: a pair sharing all three
topological vertices is classified from topology and **never reaches the
narrowphase**. Under exact stored-coordinate identity a geometric duplicate is a
topological duplicate, so the guard covers the case that crashes.

**Residual risk, unresolved:** whether any non-duplicate configuration can also
exceed 20 transient symbolic vertices. Nothing in the corpus did. Stage 3C-1B
must treat a module abort as a recoverable outcome regardless.

## Resource limits

Deterministic **work counts**, not a wall clock, so the same mesh yields the same
verdict on a fast machine and a slow one:

- `maxCandidatePairs`, `maxTestedPairs`, `maxSamples`
- hitting either pair cap ⇒ status `RESOURCE_LIMIT`
- samples are the deterministic first N in traversal order; the cap bounds
  **memory only** — aggregate counts keep rising, so truncated samples can never
  become "fewer intersections"

SI27 (400 faces, every AABB overlapping) produced 79,800 candidates, tested
2,000, and returned `RESOURCE_LIMIT` — not "0 intersections".

## Cancellation: terminate, not cooperate

Geogram does **not** poll a shared JavaScript signal inside its own loops, and
claiming cooperative cancellation would be exactly the dishonesty Stage 3B-1C
removed from repair. The diagnostic therefore runs in a **disposable worker**
that is cancelled with `Worker.terminate()`.

Measured in Chromium: full run 1722 ms, terminate observed at 122 ms
(**ratio 0.071**), authoritative geometry hashes unchanged, retry on a fresh
worker succeeded.

The authoritative geometry worker is a different worker and is never terminated.

## Worker transfer: Option B

| Option                                        | Verdict                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A — main-thread-mediated copy                 | Rejected. The page would transiently own raw coordinate buffers, making UI state a geometry holder and violating ADR 0008.                |
| **B — direct worker→worker `MessageChannel`** | **Chosen.** Main creates the channel and hands one port to each worker; geometry never passes through the page.                           |
| C — nested worker                             | Not chosen. It avoids main-thread forwarding but adds lifecycle and bundling complexity for no benefit Option B does not already provide. |

Proven in Chromium: producer worker → `MessageChannel` → diagnostic worker,
`postMessage` cost **0.37 ms**, full round trip **82.8 ms** for a 1,152-face
model. The producer transfers a `slice()` — a **disposable copy** — so its own
buffers are never detached and survive a terminated diagnostic worker intact.

## Measured performance, and the one constraint

Native, clean conforming grids:

| Input   | Faces     | Candidate pairs | AABB   | Scan      | Total  |
| ------- | --------- | --------------- | ------ | --------- | ------ |
| ~1 MiB  | 20,808    | 174,428         | 2.4 ms | 1,047 ms  | 1.2 s  |
| ~10 MiB | 208,658   | 1,765,849       | 22 ms  | 10,366 ms | 12.1 s |
| ~50 MiB | 1,048,352 | 8,893,624       | 136 ms | 53,686 ms | 62.7 s |

Cost is ~6.0 µs per candidate pair and is dominated by
`triangles_intersections` itself. Reordering the classifier to decide legitimate
neighbours before running the exact coplanarity predicate saved only ~6%, which
is how we know the narrowphase is the cost.

**This is the constraint.** Topology analysis at 50 MiB is 700 ms; this
diagnostic is ~90× that. It is therefore **not** an always-on analysis at large
sizes. Stage 3C-1B must treat it as explicitly invoked, progress-reporting,
cancellable, and resource-capped by default.

WASM is ~25% slower than native (10 MiB: 12.9 s vs 10.4 s).

## Memory

| Input   | Canonical (F32) | Disposable copy (F64) | WASM heap                   |
| ------- | --------------- | --------------------- | --------------------------- |
| ~1 MiB  | 0.4 MiB         | 0.5 MiB               | 64 MiB (initial, no growth) |
| ~10 MiB | 3.6 MiB         | 4.8 MiB               | 64 MiB (no growth)          |
| ~50 MiB | 18.0 MiB        | 24.0 MiB              | 204.9 MiB                   |

~11× the canonical model at 1M faces, bounded and measured. Nothing resembling
the unbounded multi-GiB allocation seen from Manifold in Stage 3A.

## Artifact

1,213,107 B `.wasm` + 72,029 B JS glue — **smaller** than the Stage 3A
full-Geogram candidate (1,368,082 B), because fewer Geogram entry points are
reachable. Measured, not assumed.

## Status model

```
CHECKED           every face examined, no cap hit
PARTIAL           degenerate faces skipped; counts are a lower bound
RESOURCE_LIMIT    a cap stopped the search; counts are a lower bound
CANCELLED         the diagnostic worker was terminated; no result
INTERNAL_FAILURE  the kernel aborted
```

Only `CHECKED` with zero findings may ever be presented as "no self-intersection
found", and even then it is a statement about self-intersection alone.

## What this still does not establish

**No printability claim.** Wall thickness, minimum feature size, unsupported
geometry, slicer behaviour and manufacturing viability all remain unchecked. The
banned vocabulary in `topology-presentation.ts` and `repair-presentation.ts`
applies unchanged.

## Unresolved risks

1. **50 MiB is ~63 s.** Needs an explicit interaction model in 3C-1B.
2. **`TriangleIsects` capacity 20.** Guarded for duplicates; not proven
   unreachable for every other configuration.
3. **Float32 storage bounds detectability**, independent of this design.
4. **Parallel broadphase path unaudited.** The serial path streams; the parallel
   path memorises pairs internally. Sequential WASM never selects it — but a
   future threaded build would, and that would reintroduce unbounded pair
   accumulation.

---

# Stage 3C-1A-R1 — closing the qualification blockers

Stage 3C-1A closed as PARTIALLY QUALIFIED with six open items. This section
records what changed. The Stage 3C-1A measurements above are preserved as
historical evidence; where R1 supersedes them it is stated.

## R1 — SI23–SI25, and a correction

**The Stage 3C-1A report was wrong to call these unreachable.** R16, R17 and
R18 are built by `@cadfixer/repair-evaluation`, a tracked research package, and
are reproducible at any time. They were regenerated rather than substituted:

```bash
npx vitest run --config vitest.bench.config.ts \
  scripts/self-intersection-fixtures.bench-suite.ts
```

The corpus emits a triangle SOUP; the diagnostic reasons about TOPOLOGICAL
vertices, so the export applies Stage 2's exact identity recovery — the same
function the product uses, introducing no second merging rule. Provenance and
per-fixture SHA-256 are recorded in
`experiments/self-intersection/generated-fixtures.json`.

| Fixture                         | Declared defect          | Result                                                |
| ------------------------------- | ------------------------ | ----------------------------------------------------- |
| R16 interpenetrating shells     | inter-shell intersection | CHECKED, **18** intersecting pairs, 12 affected faces |
| **R17 self-intersecting shell** | self-intersection        | CHECKED, **8** intersecting pairs, 8 affected faces   |
| R18 coplanar overlap            | coplanar overlap         | CHECKED, **1** coplanar overlap                       |

**R17 is detected.** Its contacts classify as 4 edge-touch plus 4
adjacent-overlap-beyond-shared rather than interior crossings, and that is
geometrically correct: the bow-tie cross-section's two diagonals meet at a
point, so the swept walls meet along a _segment_, not over an area. Native, WASM
and Chromium agree.

## R1 — `TriangleIsects` capacity 20: resolved

Source facts, all from the pinned revision:

- `capacity_ = 20`, a fixed stack buffer; `push_back` is
  `geo_assert(size_ < capacity_)` (`triangle_intersection.h:151,185`).
- `geo_assert` has **no NDEBUG guard** (`assert.h:149`) — it is live in Release.
- `geo_assertion_failed` **throws `std::runtime_error`** under `ASSERT_THROW`
  and only calls `abort()` under `ASSERT_ABORT` (`assert.cpp:109-113`). Stage
  3C-1A described this as a process abort; it is a **catchable exception**, and
  the mode is now set explicitly rather than inherited.

Fuzz over small integer coordinates — the range that manufactures the exact
coincidences an overflow needs — with duplicates guarded and degenerates
skipped:

| Input regime                                                   | Pairs tested  | Max symbolic result | Overflows |
| -------------------------------------------------------------- | ------------- | ------------------- | --------- |
| **With exact identity recovery** (what production always does) | **1,175,792** | 6 / 20              | **0**     |
| Without merging (an input CAD Fixer cannot be handed)          | 237,889       | 6 / 20              | 2,481     |

The overflow is reachable **only** when geometrically coincident vertices carry
distinct ids — exactly what Stage 2's identity recovery eliminates before the
diagnostic runs. The first offending case is a triangle pair whose third
vertices are the same point under two ids.

Defence in depth regardless: the narrowphase call is wrapped, an overflow is
counted as `narrowphaseRefusals`, and the verdict is forced to `PARTIAL`.
Verified in **both native and WASM**: the module survives, reports `PARTIAL`,
and never claims a clean result. WASM therefore links `-fexceptions`.

## R1 — the performance funnel

Measured per candidate, 1M-face conforming surface:

| Stage                             | Count         | Share   |
| --------------------------------- | ------------- | ------- |
| AABB candidates                   | 8,893,624     | 100%    |
| duplicates (settled by topology)  | 0             | —       |
| degenerate (skipped)              | 0             | —       |
| shared edge                       | 1,571,080     | 18%     |
| **shared vertex**                 | **4,707,453** | **53%** |
| topologically disjoint            | 2,615,091     | 29%     |
| reached `triangles_intersections` | 8,893,624     | 100%    |

The cost is the narrowphase, and there is almost nothing else in the funnel to
remove: on a conforming surface essentially every candidate is a legitimate
neighbour that must still be proven legitimate.

## R1 — prefilters: both proven correct, both REJECTED on measurement

**Non-coplanar shared edge.** If A=(u,v,w) and B=(u,v,x) share exactly edge uv
and their planes are distinct, then A∩B = [u,v] exactly. (Distinct planes meet
in one line; both contain u,v, so that line is line(u,v); a convex triangle
meets a line through two of its vertices in exactly that segment.) Sound, and
checkable with a single `orient_3d`. **Removed ~6% of narrowphase calls on a
corrugated surface and none on a planar one — where every shared-edge pair is
coplanar and must be analysed anyway. Measured slower than the path it replaced.**

**Half-space argument ignoring shared vertices.** If the non-shared vertices of
B lie strictly on one side of A's plane, then B meets A's plane only at the
shared vertices, so A∩B is exactly the shared primitive. Sound. **Removed 35% of
narrowphase calls at 1M faces but bought only ~5% of wall clock**, because an
exact `orient_3d` costs a large fraction of the call it avoids. It also moved
pairs out of `legitimateShared`; the differential harness caught 26 fixtures
disagreeing with the oracle on that field.

The plain all-three-vertices separation test fires **zero** times on real
meshes: the shared vertex lies ON the other plane, and the AABB broadphase has
already discarded everything far enough apart for it to succeed.

Both remain in the source, unreachable by default, as the evidence behind their
rejection. **The useful conclusion is that this cost is not prefilterable** — it
lives inside the exact narrowphase, and the production answer is a bounded,
explicitly-invoked diagnostic rather than a faster one.

## R1 — abortable broadphase: adopted

Stage 3C-1A left CPU work genuinely unbounded: Geogram's callback returns
`void`, so after the work cap fires the traversal keeps enumerating pairs into a
callback that discards them.

Measured, pathological fixture where every AABB overlaps:

| Faces | Worst-case pairs | Broadphase    | Candidates | Callbacks after cap | Wasted     |
| ----- | ---------------- | ------------- | ---------- | ------------------- | ---------- |
| 400   | 79,800           | Geogram       | 79,800     | 77,799              | 1.5 ms     |
| 400   | 79,800           | **abortable** | **2,001**  | **0**               | **0.0 ms** |
| 2,000 | 1,999,000        | Geogram       | 1,999,000  | 1,996,999           | 5.3 ms     |
| 2,000 | 1,999,000        | **abortable** | **2,001**  | **0**               | **0.0 ms** |
| 6,000 | 17,997,000       | Geogram       | 17,997,000 | 17,994,999          | 52.0 ms    |
| 6,000 | 17,997,000       | **abortable** | **2,001**  | **0**               | **0.0 ms** |

The waste grows as O(N²). `experiments/self-intersection/si_bvh.h` is a
read-only median-split AABB tree whose traversal callback returns `bool` and
unwinds immediately. Float64 conservative boxes, **inclusive** overlap so exact
contacts survive, deterministic ordering.

Validated, never as its own oracle: candidate counts match a brute-force
all-pairs test AND Geogram's own tree on all 26 fixtures, and every
classification field plus the sample list is identical. Runtime is equal to
Geogram's within noise from 20k to 1M faces. **It is therefore the default.**

Adopting it exposed a latent reproducibility bug: samples were "first N in
traversal order", which made a user-visible field depend on which tree produced
it. Samples are now the **N lexicographically smallest (f1,f2) pairs**, so any
correct broadphase yields the same list.

## R1 — measured performance by FACE COUNT

Keyed on faces, not file bytes: the same geometry has different byte counts as
STL, OBJ or 3MF. Median of 3 runs, corrugated conforming surface, native.

| Faces   | Candidates | ~MiB (STL) | Median     | Range     |
| ------- | ---------- | ---------- | ---------- | --------- |
| 20,000  | 167,608    | 1.0        | **0.70 s** | 0.69–0.73 |
| 49,928  | 420,604    | 2.4        | **1.79 s** | 1.73–1.80 |
| 100,352 | 847,624    | 4.8        | **3.55 s** | 3.54–3.64 |
| 199,712 | 1,689,976  | 9.5        | **7.50 s** | 7.01–7.57 |
| 500,000 | 4,238,008  | 23.8       | **17.5 s** | 17.3–20.3 |
| 999,698 | 8,480,473  | 47.7       | **34.8 s** | 34.6–35.3 |

Linear in candidate pairs at ~4.1 µs/pair on this surface. WASM ≈ 25% slower.

## R1 — invocation policy, derived from the table above

| Band             | Faces            | Evidence                                                                                                  |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `AUTO_ELIGIBLE`  | ≤ 25,000         | ≈0.9 s at the boundary. Short enough to run automatically after import or repair.                         |
| `EXPLICIT_CHECK` | 25,001 – 250,000 | ≈0.9 s to ≈9.4 s. Long enough that it must be user-invoked, with progress and a working Cancel.           |
| `SIZE_LIMIT`     | > 250,000        | 500k is 17.5 s and 1M is 34.8 s on a clean mesh, and far worse on an adversarial one. Not started in MVP. |

**Production face ceiling: 250,000 faces.** Enforced as a **preflight** gate,
not a runtime one — at 1M faces the BVH allocated +271.8 MiB _before_ the pair
cap could fire, so an above-ceiling model must be refused before allocation.

These are conservative reference-device numbers from one machine and will move
with hardware. No hardware-independent guarantee is claimed.

## R1 — status model

```
CHECKED              every face examined, no cap fired
PARTIAL              degenerate faces skipped, or a pair the narrowphase refused
RESOURCE_LIMIT       started, but a deterministic work/memory cap stopped it
CANCELLED            the diagnostic worker was terminated
INTERNAL_FAILURE     the kernel failed
NOT_RUN_SIZE_POLICY  never started: the model exceeds the face ceiling
```

`NOT_RUN_SIZE_POLICY` and `RESOURCE_LIMIT` are different facts and must read
differently: one means "we did not look", the other "we looked and ran out".
A host watchdog, if 3C-1B adds one, contributes `TIME_LIMIT` — a **secondary
backstop only**, never a replacement for the deterministic caps. **None of these
may ever render as "no intersections found".**

## R1 — memory

| Faces                   | Canonical (F32) | Disposable copy (F64) | WASM heap            |
| ----------------------- | --------------- | --------------------- | -------------------- |
| 20,000                  | 0.3 MiB         | 0.5 MiB               | 64.0 MiB (no growth) |
| 100,352                 | 1.7 MiB         | 2.3 MiB               | 64.0 MiB (no growth) |
| 199,712                 | 3.4 MiB         | 4.6 MiB               | 81.8 MiB             |
| 250,632 (ceiling)       | 4.3 MiB         | 5.8 MiB               | **98.1 MiB**         |
| 999,698 (above ceiling) | 17.2 MiB        | 22.9 MiB              | 369.9 MiB            |

## R1 — artifact

|              | Stage 3C-1A | R1          | Change          |
| ------------ | ----------- | ----------- | --------------- |
| `.wasm`      | 1,213,107 B | 1,267,695 B | +54,588 (+4.5%) |
| JS glue      | 72,029 B    | 77,861 B    | +5,832 (+8.1%)  |
| Initial heap | 64 MiB      | 64 MiB      | —               |

The increase is `-fexceptions`, which is what makes the capacity guard work.
Justified: without it a buffer overflow kills the worker instead of degrading to
`PARTIAL`.

## R1 — what remains true, and what is still not known

Unchanged: no tolerance, no welding, no snapping, read-only, duplicates separate
from intersection counts, degenerates force `PARTIAL`, exact non-adjacent
contacts reported, disposable worker cancelled by `terminate()` (T_full 1731 ms
→ 122 ms, ratio 0.070), MessageChannel worker-to-worker transfer with the page
never holding coordinates, and **no printability claim of any kind**.

Remaining limitations:

1. **Above 250,000 faces the diagnostic does not run in MVP.** Truthful, and a
   real product limit.
2. **~4–6 µs per candidate pair is irreducible** without changing semantics.
   Both sound prefilters were measured and rejected.
3. **Float32 storage bounds what is detectable** — information lost at import
   cannot be recovered here.
4. **The parallel Geogram broadphase remains unaudited.** Sequential WASM never
   selects it; the abortable tree makes it moot for the chosen path.
5. **Capacity 20 is not proven sufficient by construction** — only measured over
   1.18M production-realistic pairs, and guarded if it ever fails.
