# 0018 — Hole-filling qualification

Status: **Research complete. PARTIALLY QUALIFIED.** Stage 4B-1A.

Date: 2026-09-05

Qualifies a bounded, provable hole-filling operation and rejects the obvious
one. Nothing here is implemented in production; this ADR states what Stage
4B-1B should build and what it must not.

## Why this needed qualifying at all

Every repair CAD Fixer ships today is subtractive or a relabelling: remove an
exact duplicate, remove a degenerate triangle, flip a winding. Hole filling
**manufactures surface that was not in the user's file**, and a patch that
looks right can be wrong in ways a boundary-edge count cannot see.

The governing result of this stage is HF25. It is a boundary loop that is flat,
closed, simple and manifold; its patch is two triangles; every topological
postcondition passes and the Euler characteristic moves by exactly the expected
+1 — and the patch passes straight through an internal wall. **A hole is not
fixed because a boundary loop disappeared.**

## What CAD Fixer means by a fillable hole

Production topology already classifies boundary components as `simple-loop`,
`open-chain` or `branched`, which is enough to COUNT openings. It is not enough
to fill one: filling needs an ordered cycle and a stable identity, and neither
exists today. `experiments/hole-fill/boundary-loops.mjs` is the research
answer.

A loop is eligible when all of the following hold, under **exact stored-coordinate
identity** with `+0` and `-0` normalised together:

1. every edge in it has exactly one incident face;
2. every boundary vertex has exactly one outgoing and one incoming boundary
   half-edge — no branch, no convergence;
3. no boundary edge appears twice;
4. the walk closes, visiting no vertex twice before closing;
5. at least three distinct vertices;
6. no segment whose endpoints are the same welded vertex;
7. all coordinates finite;
8. no edge with three or more incident faces touches any of its vertices.

**No tolerance appears anywhere in that list, and none may.** A loop that is
not closed under the stored coordinates is not a hole for this operation. It
may be a hairline crack that tolerance welding would close, and that is a
different operation with a value the user chooses — inventing one here would
make a defect vanish from the report and fill an opening the user never had.

An open boundary is also not automatically an error. A tube is meant to be
open. This stage answers _geometric fillability_; product wording is 4B-1B's.

## Orientation is derived, never chosen

For a boundary edge traversed `u → v` by its one incident face, the absent face
traverses `v → u`. Walking those reversed directions yields a cycle already
wound as the patch must be wound, so orientation falls out of the topology.
Nothing consults a camera, a view direction, a signed volume or a global axis.

Validation then checks the converse directly: every patch edge lying on the
filled boundary must traverse it **opposite** to the source face that owns it.
An agreeing edge means two faces on the same side — a reversed attachment.

HF27 (globally reversed winding) fills correctly, because the rule is relative.
HF28 (a rim-adjacent face reversed) is **refused**: the boundary genuinely has
two half-edges leaving one vertex and the loop is ambiguous.

## Candidate A — PMP, and why it is not the MVP

PMP `af4725ccf6aa308e7ffad9a7bb927c6381b7c858`, MIT, already vendored and built
for Stage 3A-2 (246 KB WASM + 15 KB glue, Emscripten 4.0.16, algorithms only —
no viewers, no GL). Licence reconfirmed: MIT, and the hole-filling path pulls in
no GPL/AGPL component, no CGAL, no Triangle, no TetGen.

It is genuinely capable: it filled HF01–HF09, HF27 and HF30 with χ + 1 and zero
patch-attributed intersections, **including the non-planar loops HF06, HF07 and
HF08 that the in-house candidate refuses**. That is a real capability the MVP
gives up.

Three measured properties disqualify it for a first production operation:

| finding                   | evidence                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **it traps, uncatchably** | HF11, a legal planar 512-vertex loop: `RuntimeError: memory access out of bounds` inside the module. The binding's `catch (...)` never runs; attempting to recover in-process aborted Node. |
| **it is not append-only** | source face prefix preserved on small fixtures, **lost** on HF10 and HF23.                                                                                                                  |
| **it refines heavily**    | 32-vertex loop → **+69 vertices, +168 faces**. 128-vertex loop → **+1,193 vertices, +2,512 faces**.                                                                                         |
| **it times out**          | HF12, a 2,000-vertex loop: no result in 120 s.                                                                                                                                              |

The trap is the decisive one. A kernel that can trap cannot share an address
space with authoritative geometry, and "valid before quantisation" is not the
only way a repair can be unsafe — an unrecoverable memory fault is worse.

PMP also refuses non-manifold input itself (`TopologyException`) on HF15, HF16,
HF18, HF19, HF20 and HF28. That is welcome defence in depth and **not** a
substitute for preflight: HF17 and HF21 passed its ingest and simply filled
nothing, and HF22 — an entirely collinear loop — it filled, producing a
zero-area patch that only CAD Fixer's validator rejected.

## Candidate B — in-house ear clipping, and why it is the MVP

`ear-clip.mjs`. No dependency, no WASM, no kernel. Eligible only for loops it
**proves** planar.

Measured over the corpus, twice, **byte-identical between runs**:

- **zero added vertices** and exactly `n − 2` triangles, in every case;
- **χ + 1** in every case;
- projected patch area matches the analytic polygon area to ≤ 5e-8 relative,
  including the concave HF04 (L-shape) and HF05 (deep notch) — which is the
  proof that it is not fanning. A fan from one vertex covers area outside a
  concave polygon, which is the same defect the OBJ reader refuses to commit;
- refuses HF07/HF08 as not planar, and HF22 as degenerate.

An algorithm that cannot add a vertex cannot move one either, so whole classes
of failure — kernel-introduced points, refinement, fairing, surrounding-vertex
drift — are absent **by construction rather than by measurement**. For the
commonest real hole, a flat missing cap, this is the least invasive operation
that produces correct geometry, which is what the MVP should be.

### The planarity policy

Absolute epsilons are wrong here for the same reason a weld tolerance is: an
STL states no unit, so `1e-6` is strict for a 2 mm loop and meaningless for a
2 m one. The test is therefore **relative and derived from the loop itself**:

1. a plane from the loop's centroid and its **Newell** area-weighted normal —
   every vertex contributes, so no nearly-collinear triple decides it;
2. `scale` = the loop's largest bounding-box extent, a length the loop actually
   has, in whatever unit the model is in;
3. planar iff `maxDeviation / scale <= 1e-4`.

`1e-4` is an **algorithm-eligibility** threshold, never a topology-identity one:
nothing welds, merges or moves. A loop that fails it is not "not a hole", it is
"not a hole this triangulator may attempt". The value leaves two orders of
magnitude above Float32's own quantisation at these scales, and the measured
separation is wide — accepted cases sit at 0 to 2.5e-5, refused ones at 1.5e-1.

A zero Newell normal is reported as **degenerate, not planar**: a collinear loop
has no plane, and calling it perfectly planar would send a zero-area loop into a
triangulator with nothing to triangulate.

## Independent validation

The kernel creates; CAD Fixer validates. Nothing asks the thing that produced
the patch whether the patch is good, and every check runs on the **final
canonical Float32** representation — a patch can be valid in double precision
and collapse after narrowing, so validating the kernel's own representation
would be validating something that never becomes the model.

Checked, with provenance `[0, sourceFaceCount)` = source and the remainder =
patch:

1. source positions and indices **byte-identical**;
2. all coordinates finite;
3. no degenerate patch face, measured after narrowing;
4. no duplicate patch face under welded identity;
5. the selected loop, identified by its **coordinate-derived stable id**, is
   gone; boundary-loop count down by exactly one;
6. no new non-manifold structure;
7. every patch boundary edge opposes its source face;
8. no patch corner uses a source vertex outside the filled loop;
9. **no intersection involving a patch face** — patch × source and patch ×
   patch, excluding pairs sharing a welded vertex;
10. Euler as corroboration.

**Self-intersection is patch-attributed, never aggregate.** A pre-existing
crossing must not be blamed on this operation, and an unchanged total must not
be read as proof: HF24 has a pre-existing crossing elsewhere and validates
cleanly with zero patch intersections. The test is a second implementation
(separating axis) sharing no code with the Stage 3C kernel, because running the
same kernel a production path would run and calling agreement proof is the
mistake the writer oracles exist to prevent.

Euler is corroboration only. HF25 has the right χ and is wrong.

## Worker architecture

**Disposable worker, terminated for cancellation.** Not a preference — PMP's
trap aborted the host process, so containment cannot be optional if a kernel is
ever used. Even for the kernel-free MVP the same shape holds: the authoritative
worker copies the selected part, hands it over, and a candidate comes back. The
authoritative document is never mutated before Apply.

Cancellation is termination. The in-house triangulator is a synchronous loop and
could poll a token between ears, but the validator — not the fill — is the
expensive half, and honest cancellation of the whole operation is a terminate.

## Cost, and where it actually is

| loop                            | extract | fill    | validate |
| ------------------------------- | ------- | ------- | -------- |
| 32                              | 0.4 ms  | 0.6 ms  | 17 ms    |
| 128                             | 1.8 ms  | 1.5 ms  | 36 ms    |
| 512                             | 5.4 ms  | 10 ms   | 293 ms   |
| 2,000                           | 14 ms   | 16 ms   | 753 ms   |
| 40,338-face part, 4-vertex loop | 218 ms  | 0.02 ms | 503 ms   |

**Validation dominates, by one to two orders of magnitude.** That is acceptable
— safety is the product — but it decides where the ceilings go: they belong on
the validator, not on the kernel. The pairwise patch × face scan is O(P·F) and
exhausted a 1.7 GB heap before it was bounded; production needs a spatial index
or the existing Stage 3C BVH.

## Recommended Stage 4B-1B scope

```
- one selected boundary loop per operation, never "fill all"
- the loop must satisfy every eligibility rule above
- the part must be consistently orientable (checked by CAD Fixer, not the kernel)
- the loop must be proven planar by the relative policy
- in-house ear clipping only: no kernel, no refinement, no fairing
- zero added vertices; zero modified source vertices; append-only patch
- built in a disposable worker; cancellation is termination
- final Float32 candidate independently validated, all ten checks
- patch-attributed self-intersection must be zero
- refusal is non-destructive and carries a typed reason
```

Ceilings to set from the numbers above rather than inherited: a boundary-vertex
ceiling in the low hundreds, and a part-size ceiling governed by the validator.
The Stage 3C `CHECKED` band (250,000 faces) is a reasonable upper bound to
inherit **only** once the intersection check uses a spatial index.

Explicitly out of scope: non-planar loops, multi-hole batching, refinement,
fairing, tolerance welding, seam snapping, inter-part collision.

## Truthfulness

`Hole filled` is not `Model repaired`. A model may still have another opening, a
self-intersection, duplicate faces or non-manifold topology.

`Watertight` may only be claimed if independent topology after the fill shows
zero boundary edges and no relevant non-manifold condition across the whole
part — and even then it is not printability. Self-intersection between the patch
and the rest of the part is checked; **inter-part collision in world space is
not checked at all**, because self-intersection remains intra-part. That
limitation must be stated, not implied away.

## Multi-part, transform and unit semantics

The operation targets `documentId + revision + partId + boundaryLoopId`. Other
parts are untouched and stay shared by reference. It works in **part-local**
coordinates: `PartTransform` is unchanged and is never baked in first. It is
purely geometric — no unit conversion, and no threshold depends on an assumed
millimetre, so unknown-unit STL and OBJ documents remain eligible.

## Rejected approaches

- **`pmp::fill_hole` as the MVP** — traps uncatchably, loses provenance,
  refines heavily, times out at 2,000 vertices. Reconsider for non-planar loops
  once it runs in a disposable worker and a per-loop binding exists.
- **Fill-all-holes as one operation** — HF29 has 20,165 boundary loops and did
  not finish in twelve minutes. An operation whose cost is unbounded in the
  number of openings cannot be one user action, and cannot be validated
  afterwards either.
- **A triangle fan** — wrong for every concave polygon, and the area check
  proves it.
- **An absolute planarity epsilon** — meaningless without a unit.
- **Trusting the kernel's refusals** — PMP filled a collinear loop and produced
  a zero-area patch.

## Remaining risks

- The in-house triangulator is O(n²) in ear search; fine to a few hundred
  vertices, and the ceiling must be set rather than discovered.
- The intersection check needs a spatial index before any large-part ceiling.
- Non-planar holes are not addressed at all by the recommended scope.
- Ear clipping can fail to find an ear on a self-intersecting _projection_; it
  refuses with `NO_EAR_FOUND` rather than emitting anything, which is correct
  but means some planar loops are refused.
- A per-loop PMP binding does not exist yet; the vendored one fills every loop
  and republishes a compacted mesh.
