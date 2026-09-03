# Self-intersection diagnostic

Read-only. It answers one question — **does this mesh intersect itself?** — and
nothing else. Stage 3C-1B integrated the architecture qualified in Stage 3C-1A
and 3C-1A-R1; the evidence behind every number here is in
[ADR 0012](adr/0012-read-only-self-intersection-diagnostic.md) and
`docs/self-intersection/qualification.json`.

## What it does not tell you

A completed check with nothing found establishes that the exact stored mesh does
not intersect itself under the qualified classifier. It says nothing about wall
thickness, minimum feature size, supports, slicer behaviour or manufacturing
viability. The words _printable_, _watertight_, _print-ready_ and _error free_
are banned from every string this feature can emit, and a test asserts it.

## When it runs

Keyed on **face count**, never file bytes: the same geometry has very different
byte counts as STL, OBJ or 3MF.

| Band             | Faces            | Behaviour                                      |
| ---------------- | ---------------- | ---------------------------------------------- |
| `AUTO_ELIGIBLE`  | ≤ 25,000         | Checked automatically once the model is usable |
| `EXPLICIT_CHECK` | 25,001 – 250,000 | Offered as a button; never started on its own  |
| `SIZE_LIMIT`     | > 250,000        | Not started at all                             |

Measured latency behind those thresholds (median of three, reference device):
20k **0.70 s**, 50k **1.79 s**, 100k **3.55 s**, 200k **7.50 s**, 500k **17.5 s**,
1M **34.8 s**. These are a conservative MVP product decision about acceptable
waiting, not a hardware-independent guarantee.

**The ceiling is a preflight gate.** Above it no diagnostic worker is created, no
WebAssembly is instantiated, no geometry is copied and no broadphase is built —
at a million faces the broadphase alone allocated ~272 MiB during qualification,
so rejecting after allocating would not be rejecting.

## What the statuses mean

Five of the six carry an intersection count of zero. Exactly one of them means
the mesh has none.

| Status                | Meaning                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHECKED`             | Every face examined, nothing skipped, no cap fired. **The only status that may be shown as "None found".**                                                    |
| `PARTIAL`             | It ran, but degenerate faces were skipped or a pair could not be classified. Counts are a **lower bound**.                                                    |
| `RESOURCE_LIMIT`      | It started and a deterministic work cap stopped it. Counts are a **lower bound**.                                                                             |
| `CANCELLED`           | The user stopped it. No verdict.                                                                                                                              |
| `INTERNAL_FAILURE`    | The diagnostic worker failed. No verdict.                                                                                                                     |
| `NOT_RUN_SIZE_POLICY` | It never started, because the model is above the ceiling. **Distinct from `RESOURCE_LIMIT`**: one means "we did not look", the other "we looked and ran out". |

Findings are never discarded because a scan was incomplete. A `PARTIAL` result
that found three intersections reports three, and says why it may have missed
more.

## Categories

| Category                                       | Counts as a self-intersection                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Proper crossing (interiors cross)              | yes                                                                                            |
| Coplanar overlap (shared area)                 | yes                                                                                            |
| Non-adjacent point touch                       | yes — reported as contact                                                                      |
| Non-adjacent edge touch                        | yes — reported as contact                                                                      |
| Adjacent overlap beyond the shared edge/vertex | yes                                                                                            |
| Duplicate topology defect                      | **no** — Stage 2 already reports duplicates; counting them here would report one problem twice |

Adjacency comes from Stage 2's exact stored-coordinate vertex identity. There is
no second, fuzzier merging rule in the diagnostic.

## Precision

Canonical storage is Float32. Each stored value is **widened exactly** to Float64
for the kernel's exact predicates. No epsilon, no tolerance, no welding, no
snapping. Two coordinates are the same point only if they are the same stored
value — which also means a self-intersection that exists only below Float32
storage resolution cannot be detected, because that detail was lost at import.

## Architecture

```
UI  ──creates──►  MessageChannel + disposable diagnostic worker
                        │                    │
                     port A               port B
                        ▼                    ▼
        authoritative geometry worker ═════► diagnostic worker  (Geogram WASM)
                    disposable Float64 copy
```

The page coordinates the ports and never reads a coordinate. The authoritative
worker builds a **copy** and transfers that, so its own canonical buffers are
never detached and survive whatever happens to the diagnostic worker — asserted
byte for byte by test.

**Cancellation is `Worker.terminate()`.** Geogram's narrowphase is a long
synchronous C++ call that does not poll a JavaScript flag, so the cooperative
shared-memory cancellation used for repair cannot reach inside it. Offering a
Cancel backed by a flag the kernel never reads would be dishonest, so the worker
is disposable and Cancel kills it. The authoritative worker is never terminated.

## Resource caps

Deterministic **work counts**, not a clock, so the same mesh reaches the same
verdict on any machine:

- `MAX_CANDIDATE_PAIRS` 40,000,000
- `MAX_TESTED_PAIRS` 20,000,000
- `MAX_SAMPLES` 4,096 — bounds memory only; aggregate counts keep rising
- face ceiling 250,000

A caller may only **narrow** these. Samples are the N lexicographically smallest
face pairs, so they do not depend on traversal order.

There is **no wall-clock watchdog** in this stage. No defensible default could be
derived from the existing evidence without measuring termination behaviour that
was never measured, and inventing one would have put a number in the product
that nothing supports.

## Kernel provenance and licence

Geogram **v1.10.0**, commit `c8529bb00838186938ab31d96008a59b6a892dee`, built
with emsdk 4.0.16. `GEOGRAM_WITH_TETGEN=OFF` and `GEOGRAM_WITH_TRIANGLE=OFF`
exclude the AGPL and non-free components; the build script runs the licence
build-input audit **and** scans the emitted artifact, and refuses to produce one
if either fails. Geogram's core is BSD-3-Clause and carries an attribution
obligation recorded in `docs/DEPENDENCIES.md`.

The kernel is imported by exactly one file — the diagnostic worker — so a user
who never runs a check never downloads it. The production boundary test asserts
that.

## Known limitations

- Models above 250,000 faces are not checked in this stage.
- Float32 storage bounds what is detectable.
- Cancellation terminates a disposable worker; cooperative cancellation inside
  Geogram is **not** claimed.
- There is no self-intersection **repair**, and none is planned in this stage.
- Wall thickness is still not checked, and no result here implies printability.
