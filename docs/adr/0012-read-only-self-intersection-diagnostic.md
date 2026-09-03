# 0012 — Read-only self-intersection diagnostic architecture

Status: **Accepted for Stage 3C-1B integration, with one named performance
constraint.** Stage 3C-1A research. Nothing in this ADR is implemented in
production yet.

Date: 2026-09-03

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
