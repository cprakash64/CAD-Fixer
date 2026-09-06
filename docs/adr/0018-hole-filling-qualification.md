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

---

# Production addendum — Stage 4B-1B1

Status: **Engine implemented.** Recorded here rather than in a new ADR because
it answers the questions this one deliberately left open, and a reader who has
just read the qualification should not have to find a second document to learn
what was actually built.

## What shipped, and what did not

`packages/mesh-hole-fill` is the engine described by the recommended scope
above, in full: one selected loop, exact-identity eligibility, the relative
planarity policy at 1e-4, in-house ear clipping only, zero added vertices,
append-only provenance, a disposable worker, termination for cancellation, and
independent validation of the final canonical Float32 candidate.

**There is no user-facing control, and a boundary test asserts there is none.**
Selection, patch preview, Apply and Undo are Stage 4B-1B2. The engine is
reachable through three protocol operations — `holefill/list-loops`,
`holefill/send-for-fill`, `holefill/discard` — and through nothing else.

**Stage 4B-1B1 produces candidates only.** The resident document is never
replaced, its revision never moves, and no undo record is written, for any
outcome: success, refusal, cancellation, or a crash of the worker that ran it.

## The three questions the qualification left open

### 1. The boundary-vertex ceiling: **512**

ADR 0018 said "low hundreds" and explicitly deferred the number until a spatial
index existed, because the research validator's pairwise scan exhausted a 1.7 GB
heap. `npm run bench:hole-fill` measures the production path end to end, median
of three after a warm-up:

| boundary vertices | total   | broadphase | narrowphase | ear clipping | candidate pairs |
| ----------------- | ------- | ---------- | ----------- | ------------ | --------------- |
| 8                 | 2.3 ms  | 0.10 ms    | 0.60 ms     | 0.01 ms      | 106             |
| 32                | 6.6 ms  | 0.48 ms    | 3.58 ms     | 0.10 ms      | 1,404           |
| 128               | 58.4 ms | 37.2 ms    | 53.2 ms     | 0.66 ms      | 20,988          |
| 256               | 227 ms  | 219 ms     | 220 ms      | 0.12 ms      | 82,940          |
| 384               | 516 ms  | 492 ms     | 504 ms      | 0.26 ms      | 185,852         |
| 511               | 883 ms  | 870 ms     | 869 ms      | 0.42 ms      | 328,183         |
| **512**           | 897 ms  | 883 ms     | 884 ms      | 0.42 ms      | 329,724         |

The qualification's central finding holds exactly: **validation dominates**, and
the triangulator is noise. Doubling to 1,024 would cost roughly three and a half
seconds for the same hole, which is the shape of the curve rather than an
accident of one machine. 512 keeps the operation under a second — an explicit,
cancellable action in a disposable worker, in a band the self-intersection
diagnostic already extends to ~9.4 s.

A loop above the ceiling is refused BEFORE triangulation, so an oversized
boundary costs the walk and nothing more.

### 2. The part-size ceiling: **250,000 faces**, and the evidence agrees

ADR 0018 permits inheriting the Stage 3C band "only once the intersection check
uses a spatial index". It now does. Measured with a four-vertex hole, so the
number is the part's cost rather than the boundary's:

| part faces | total    | topology validation | broadphase | candidate pairs |
| ---------- | -------- | ------------------- | ---------- | --------------- |
| 10,000     | 28.3 ms  | 20.9 ms             | 2.5 ms     | 20              |
| 50,000     | 169.6 ms | 135.3 ms            | 14.5 ms    | 20              |
| 100,000    | 378.4 ms | 309.1 ms            | 29.5 ms    | 20              |
| 200,000    | 927.8 ms | 781.6 ms            | 60.5 ms    | 20              |
| 249,000    | 1,285 ms | 1,085 ms            | 78.6 ms    | 20              |

**Twenty candidate pairs at every size.** The intersection check now costs what
the patch's NEIGHBOURHOOD costs, not what the model costs. What still grows is
topology validation, because the candidate's boundary loops are re-extracted
over the whole part — which is unavoidable if the postconditions are to be
checked over the whole part.

The worst in-policy combination measured, a 512-vertex boundary on a
248,000-face part, is 2.18 s.

### 3. The spatial index: a TypeScript port, and why not the C++ one

ADR 0018 said production needs "a spatial index or the existing Stage 3C BVH".
The Stage 3C BVH could not be reused, for two reasons that are facts about the
code rather than preferences:

1. **It is C++ compiled into the Geogram WASM module**, whose only exported
   surface is the flat `cf_si_*` C ABI. There is no way to call it from
   TypeScript and no way to hand it a JavaScript visitor.
2. **Its only query is all-pairs.** `for_each_overlapping_pair` enumerates every
   overlapping pair of ONE mesh; there is no box query, so it cannot answer
   "which source faces might this patch triangle hit". Asking it the all-pairs
   question instead would make hole-fill validation cost a full
   self-intersection scan of the part — the ~9.4 s at 250,000 faces ADR 0012
   measured — to answer a question about at most 510 triangles.

Editing `si_bvh.h` to add a box query was not available either: it is pinned
byte-identical to `experiments/self-intersection/si_bvh.h` by
`kernel-integrity.test.ts`, and changing it would change the evidence that
describes what ships.

So `packages/mesh-hole-fill/src/bvh.ts` is a **port, not an invention**, and
deliberately the same tree: median split on the widest axis, leaf size 8,
inclusive box overlap so exact contact is never discarded, and a deterministic
tie-break on face index. It is validated against a brute-force all-pairs oracle,
for the same reason `si_bvh.h` was — a broadphase that MISSES a pair turns a
defect into a clean bill of health.

Measured reduction against the naive product:

| case                          | naive pairs | generated | ratio  |
| ----------------------------- | ----------- | --------- | ------ |
| 8-vertex rim, 100,000 faces   | 600,096     | 106       | 1.8e-4 |
| 128-vertex rim, 100,000 faces | 12,632,256  | 20,988    | 1.7e-3 |
| 512-vertex rim, 247,000 faces | 126,492,240 | 329,724   | 2.6e-3 |

Candidates are STREAMED through a reused 8,192-pair buffer, so nothing
proportional to `patchFaces × sourceFaces` is ever materialised.

## The narrowphase IS the qualified kernel

The research separating-axis checker was NOT promoted. It exists to be a second
opinion and is deliberately weaker than the production predicate: no exact
predicates, and it excludes any pair sharing a welded vertex, so it cannot see
an overlap that goes BEYOND a legitimately shared edge.

Instead, `binding.cpp` gained one additive entry point — `cf_hf_begin` /
`cf_hf_classify` / `cf_hf_end` — which classifies a caller-supplied LIST of face
pairs and attributes every finding to patch/source or patch/patch. It reuses,
unchanged:

- `GEO::triangles_intersections`, the exact symbolic narrowphase, through the
  INDEXED overload;
- `classify_pair`, the frozen Stage 3C taxonomy, so a legitimate shared edge, a
  coplanar area overlap, an overlap beyond a shared edge and a non-adjacent
  touch mean here exactly what they mean in the diagnostic;
- `is_degenerate_face` and `shared_vertex_count`, so adjacency comes from
  Stage 2's exact stored-coordinate identity;
- the duplicate guard and the capacity guard, so a fixed-buffer overflow becomes
  one unclassified pair and a PARTIAL verdict rather than a dead worker.

`si_core.h` and `si_bvh.h` are byte-identical to the research copies, and
`cf_si_run` is not modified and observes none of the new state. The rebuilt
artifact was verified reproducible: rebuilding the UNCHANGED source produced
byte-identical `.js` and `.wasm` (SHA-256
`5829ce69…` and `8f6b3fa7…`) before the entry point was added.

**A pair that could not be classified is never absorbed into a clean verdict.**
A PARTIAL batch fails the candidate.

## The loop identity was strengthened

The research id was `loop-<fnv1a32(coordinates)>-<length>`. That is fine for
naming a row in a results table and **not** fine for an identifier that selects
which geometry a mutation targets: a 32-bit space collides by birthday around
65,000 items, and the research corpus itself contains a part with 20,165
boundary loops — roughly a 4.6% chance that two of them would become
interchangeable.

Production ids are `bl-<minVertex>-<count>-<hash64>`, and their intra-part
uniqueness is **structural rather than probabilistic**: boundary components are
vertex-disjoint, so no two components of one part can share a smallest welded
vertex id. The 64-bit hash over the sorted (vertex id, coordinate) triples and
the canonical ordered rotation is what makes a STALE id fail to match after an
edit. `boundary-loops.test.ts` finds a real collision in the research function
by brute force and shows the production identity keeping the two loops apart.

One defect was found and fixed during implementation: the identity was initially
hashed only for ELIGIBLE loops, which made the same boundary hash two different
ways depending on whether the caller passed a vertex ceiling. An identity must
be a property of the geometry, never of the options used to enumerate it.

## What remains out of scope

Unchanged from the qualification, and restated because an addendum is where
scope quietly grows: non-planar loops, PMP, batch filling, tolerance welding,
seam snapping, fairing, smoothing, surrounding remeshing, inter-part collision.
Also out of scope for 4B-1B1 specifically: preview, Apply, Undo, and any
user-facing control.
