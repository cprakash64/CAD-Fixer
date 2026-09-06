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

---

# Closure addendum — Stage 4B-1B1-R1

Three gaps in the Stage 4B-1B1 addendum above were closed. Recorded here rather
than by editing that text, so what was believed and what was found stay
distinguishable.

## 1. Source preservation is now checked where the two sides are independent

**The gap.** The engine's `validateSourcePreservation` compares the candidate's
positions with the source's — but inside the fill worker the candidate SHARES
the source's position buffer, because the triangulator adds no vertex and moves
none. Comparing one view of a buffer with another view of the same buffer is
trivially true: it proves the variables alias, not that nothing was rewritten.
A worker that modified a source position would have moved BOTH sides of that
comparison together, and the check would still have passed. The Stage 4B-1B1
report named this as a weakness; it is now closed rather than noted.

**The closure.** The authoritative geometry worker compares the returned
candidate against its OWN resident part, byte for byte, immediately before
registration. Those two are genuinely independent: `part.mesh` never left this
worker, and the candidate crossed a MessageChannel from another thread.

The order of acceptance is now:

```
worker returned VALID_CANDIDATE
  → document still exists
  → revision still matches
  → part still resolves
  → candidate positions BYTE-EQUAL the authoritative source
  → candidate index PREFIX BYTE-EQUAL the authoritative source
  → register
```

Either comparison failing returns `INTERNAL_FAILURE` and registers nothing — not
a refusal, because a refusal says "this geometry is outside what the operation
supports" and this says "a candidate came back whose original bytes do not match
the model it was built from", which is only possible if CAD Fixer's own
append-only contract was violated.

**Bytes, not numbers, and not a hash.** A numeric comparison calls `NaN` unequal
to itself and `-0` equal to `+0` — the first invents a difference, the second
hides one. A hash would answer "probably", and this gate decides whether
geometry may later replace the user's model.

**Proven by injection, not by inspection.** `hole-fill-handlers.test.ts`
substitutes a corrupted publication at the channel boundary — one original
position changed by one representable step, one original face index swapped, a
truncated index buffer, and a `-0` flipped to `+0`. Each is rejected, registers
nothing, leaves the resident bytes and the revision untouched, and a normal retry
succeeds. **The corruption path exists only in that test**: no production seam,
no debug flag, and a boundary test scans for one.

## 2. New non-manifold topology is detected by IDENTITY, not by kind

**The gap.** The postcondition compared the SET OF REFUSAL KINDS present before
and after. That is defeated by the commonest real case:

```
source    non-manifold edges = { X }      kinds = { NON_MANIFOLD }
candidate non-manifold edges = { X, Y }   kinds = { NON_MANIFOLD }
```

The kind sets are equal, so the check reported no regression while the patch had
manufactured a new non-manifold edge Y. A COUNT would have caught that example
and would still have missed a candidate that removed X and added Y.

**The closure.** `collectNonManifoldDefects` returns the defects themselves:
non-manifold edges by welded endpoint pair (`min:max` — the undirected identity
`groupEdges` already produces), non-manifold vertices by welded id, and
winding-conflicted edges by the same edge identity. Vertices are included
because edge manifoldness does not imply vertex manifoldness — the bow-tie has
every edge at exactly two faces and is still pinched.

The contract is a SUBSET, deliberately one-directional:

```
candidateDefects ⊆ sourceDefects
```

A fill legitimately removes a boundary condition and may incidentally remove a
defect; neither is a regression. What it may never do is introduce one.
`newNonManifoldDefectCount` reports the size of the difference in the direction
that matters, and success requires zero. Pre-existing defects are not this
operation's to fix, exactly as a pre-existing self-intersection is not.

The differential runs on the FINAL canonical candidate — the one that would be
registered — and the identities are directly comparable because an append-only
candidate shares the source's position buffer and therefore its first-appearance
vertex numbering, which the byte gate above independently confirms.

**The regression fixture.** `tp03ChordCollisionWithExistingDefect` is a tube
whose rim ear-clips to the single internal diagonal `(2,0,0)–(0,2,0)`, plus a
CLOSED tetrahedron that already owns that edge with exactly two faces, plus an
unrelated three-triangle non-manifold cluster far away. The tetrahedron adds no
boundary, so the rim stays eligible; it shares only topology the patch is
entitled to share, so the exact narrowphase classifies every contact as a
legitimate shared edge and reports **zero** invalid pairs. Adding the patch takes
that edge to FOUR incident faces.

Every defect kind is identical before and after. The old check accepted it; the
new one reports `newNonManifoldDefectCount: 1` and `NON_MANIFOLD_CREATED`. The
negative control confirms it directly: restoring the kind comparison makes that
test fail.

## 3. The rebuilt Geogram artifact is proven semantically identical

**The gap.** Adding `cf_hf_*` changed the shipped `.wasm`, so it is no longer
the byte-identical artifact Stage 3C-1A-R1 qualified. Three facts were already
established — the unchanged source rebuilt byte-identically before the addition,
`si_core.h` and `si_bvh.h` are still byte-identical to the research copies, and
the Stage 3C suites are green. None of them is the same claim as "the diagnostic
answers the same thing": a changed link order, a different heap layout or a new
global with a constructor could in principle move a result without moving a
header.

**The closure.** `kernel-differential.test.ts` extracts the pre-B1B1 artifact
from git at `34efd8b` — read-only, into a temporary directory, no history
touched — and runs the **whole frozen Stage 3C corpus** through both artifacts:
the 24 hand-authored adversarial fixtures and the three regenerated Stage 3A
shells, 27 in total. Every deterministic field is compared: terminal status,
failure flag, candidate and tested pair counts, intersecting pairs, affected
faces, all seven taxonomy counters, skipped faces and pairs, unclassified pairs,
sample count, truncation flag, and the sample array itself. Timings are excluded
because they are not deterministic.

Compared at the default ceilings, at three tight ceiling settings chosen to fire
mid-traversal, and over the degenerate/PARTIAL subset specifically — because
PARTIAL is the one verdict a rebuild could silently upgrade to CHECKED and make
a lost diagnosis look like a clean bill of health.

**Result: zero semantic differences.** The hashes differ, as expected; behaviour
does not. The negative control perturbs one reading by one and confirms the
comparison fails.

## What the closure cost

Measured with `npm run bench:hole-fill`, median of three after a warm-up:

| part faces | byte comparison | defect differential | topology phase | total      | share of total |
| ---------- | --------------- | ------------------- | -------------- | ---------- | -------------- |
| 10,000     | 0.54 ms         | 5.78 ms             | 24.2 ms        | 31.0 ms    | 20.4%          |
| 100,000    | 5.41 ms         | 38.9 ms             | 316.5 ms       | 384.2 ms   | 11.5%          |
| 249,000    | 13.4 ms         | 95.1 ms             | 1,077.6 ms     | 1,267.1 ms | 8.6%           |

Both checks are linear and both shrink as a share of the whole. End-to-end the
249,000-face case is unchanged within run-to-run noise (1,286 ms before, 1,267 ms
after). No persistent memory is added: the byte comparison is `Uint8Array` views
over buffers that already exist, and the differential's arrays are released with
the call.

## What did not change

Everything the Stage 4B-1B1 addendum settled: the 512-vertex and 250,000-face
ceilings, one selected loop, exact stored-coordinate identity, the relative
planarity policy at 1e-4, deterministic ear clipping with zero generated
vertices, patch provenance by face suffix, the disposable worker, the Geogram
narrowphase, streamed bounded candidate pairs, no PMP, no non-planar filling, no
batch filling, and no inter-part collision checking. Still no user-facing
control, and still candidates only.

---

# Production workflow addendum — Stage 4B-1B2

**Status: implemented.** Stage 4B-1B1 shipped the engine and deliberately no
user-facing control. This stage puts a workflow in front of it: an inventory of
open boundaries, selection of ONE of them, a patch preview, an explicit Apply and
an Undo. The engine is unchanged — not extended, not relaxed, not re-tuned — and
every ceiling, refusal and validator it enforces is exactly what it enforced
before.

## What the workflow is, in one line

Select one open boundary, generate a validated candidate, look at the exact
surface that would be committed, and choose to commit it.

## The three separations the design turns on

### 1. Listing answers a TOPOLOGICAL question; the engine answers a GEOMETRIC one

`holefill/list-loops` walks the same connectivity `analyseTopology` walks and
reports, per boundary component, whether it is one ordered, closed, simple,
manifold cycle. That is exactly decidable from the stored coordinates and it is
all the listing claims.

**Planarity is not in it, and must not be.** The relative-planarity policy lives
in `@cadfixer/mesh-hole-fill`, which is confined to the disposable worker; asking
the geometry worker to answer it would put the triangulator, the broadphase and
every validator in the geometry-worker chunk, which the production boundary scan
forbids.

So a perfectly simple rim that curves out of its own plane is listed as
attemptable and refused when the engine looks at it. The interface says so before
the button is pressed — `OPENING_ELIGIBLE` reads "CAD Fixer can attempt this
opening", never "can be filled" — because a row that promised a fill the listing
has no way to deliver would be CAD Fixer breaking its word once per curved rim.
This wording is asserted by test.

### 2. The display index is a LABEL; the `BoundaryLoopId` is the IDENTITY

A row reads "Opening 3" because it is third in the deterministic order
`extractBoundaryLoops` produces — components keyed by their smallest welded
vertex id and sorted by it, so the same geometry always yields the same order.
Every request carries the id the worker produced. The index is never sent
anywhere, never compared and never resolved against anything, so a renumbering
can produce a wrong label and cannot produce a wrong operation.

### 3. The preview is READ FROM the stored candidate, never recomputed

`holefill/patch-preview` reads faces `[sourceFaceCount, candidateFaceCount)` out
of the mesh `HoleFillCandidateStore` is holding — the same object `prepareCommit`
returns and `withPartMesh` installs. There is no second triangulation and no
reconstruction from the summary, so "what you previewed is what Apply commits" is
a structural fact rather than an intention. A boundary test asserts the commit
path reaches no engine symbol at all.

Only the patch travels: a few kilobytes for a 512-vertex rim, whatever the part's
size. Sending the whole candidate would put a second copy of a 250,000-face mesh
on the page to draw at most 510 triangles.

## Apply is one transaction, and every guard is in the worker

`holefill/commit` takes four identifiers and no geometry. In order:

1. resolve the document the caller named;
2. `HoleFillCandidateStore.prepareCommit` checks that the candidate EXISTS, is
   neither committed nor discarded, belongs to THIS document, THIS part and THIS
   opening, and was built from the revision the store actually holds — the
   caller's belief and the store's reading are compared independently, because a
   stale caller would otherwise pass its own stale belief as evidence;
3. `assertMeshStructure` — rule 11, every time;
4. `withPartMesh` builds the successor, sharing every other part BY REFERENCE,
   and `assertGeometryDocument` checks what only a document can be asked;
5. `residentDocuments.replace` re-checks the revision and swaps ONE map entry.
   That swap is the atomic step: there is no moment where the revision has moved
   and the part has not;
6. only then is the candidate consumed and the undo record written.

**A refusal at any step leaves the candidate RESOLVED and retryable.** Consuming
it before the swap succeeded would destroy a validated fill because of a
transient race.

`expectedPart` and `expectedLoopId` are STATED by the caller and never read off
the candidate — the Stage 4A-2A invariant, written down after getting it wrong
once: a guard that compares the candidate with itself is vacuous.

## Shared geometry is isolated by the swap, and that is the hard gate

Two parts may hold the same `CanonicalMesh` object. Filling one gives that part
the candidate and leaves the other holding the ORIGINAL object — reference
identity, not value equality, because a copy would satisfy a byte comparison and
would still mean the document had silently stopped sharing.

Proven twice: at the contract level in `hole-fill-commit.test.ts` (HC09, HC10),
and in a real browser in `e2e-harness/hole-fill-workflow.spec.ts`, where the
worker-side digest shows part B's positions, indices, transform and byte lengths
unchanged while part A's index buffer grows. No shipped importer can produce a
shared pair, which is why the second proof needs the harness.

## Undo: ONE history, TWO reconstructions

A hole fill is recorded in `RepairHistoryStore` beside conservative repairs and
reversed by the same `repair/undo` transaction. A second, hole-specific history
would be a second answer to "what does Undo do next", and two answers to that
question is how a user ends up undoing a change they did not make last. There is
still exactly ONE undoable change per document, and applying either kind
supersedes whatever was there — which the interface reflects by dropping the
other panel's Undo rather than leaving a button that the worker would refuse.

What differs is only HOW the previous geometry is rebuilt, so that is the only
thing the record varies — `UndoableInverse` is a discriminated union:

- a **repair** removed faces and reordered corners, so `restoreFromInverse`
  rebuilds the original ordering from retained coordinates;
- a **hole fill** only appended, so `truncatePatch` drops the suffix.

**Truncation is exact, and it is exact BECAUSE of the Stage 4B-1B1-R1 gate.** The
authoritative preservation check proved, byte for byte across a thread boundary,
that the candidate's positions ARE the source's positions and its index buffer
BEGINS with the source's index bytes. So dropping the suffix reproduces the
source's bytes — every position, every index, in the original order.

**Running the repair reconstruction over a fill would have been wrong, silently.**
`restoreFromInverse` rebuilds a NON-INDEXED mesh; for an indexed model — every
OBJ and 3MF import — an undo would have round-tripped the part into a different
representation with different bytes while appearing to succeed. The inverse
retains two integers and no coordinates, because there is nothing to keep a copy
of.

### What undo does NOT restore: object sharing

Undo reproduces the part's GEOMETRY exactly — every position, every index, the
placement, the name, the groups. It does not restore the `CanonicalMesh` OBJECT
that two parts were sharing before the fill.

The reason is the patch design itself. ADR 0011 chose an inverse patch over a
copy so that a 100 MiB import does not cost 100 MiB per undo step, and the
consequence is that the restored part is a NEW object holding the same bytes
rather than the object its sibling still holds. The sharing was already broken by
the Apply — that is what isolating the filled part MEANS — and the undo does not
put it back. A document that held one mesh for two parts before a fill holds two
equal ones after a fill and an undo.

**Not fixed, and the alternatives were considered and rejected.** Retaining the
pre-fill mesh in the undo record would restore sharing and would retain a whole
part's geometry for every fill, which is the exact cost the patch design exists
to avoid. Comparing the restored mesh against every sibling and re-sharing on a
byte match would be a whole-document scan on every undo — a thousand comparisons
for a thousand-placement document — and a form of implicit deduplication this
codebase deliberately does not do anywhere else.

The cost is bounded and visible: one extra mesh resource, reported by
`documentByteLength` and by the part descriptors, for a document that had a
shared mesh and has had one of its parts filled and unfilled. It is asserted in
`e2e-harness/hole-fill-workflow.spec.ts` so that a future change to it is
noticed rather than discovered.

## Groups are carried onto the candidate

The Stage 4B-1B1 candidate mesh was built with positions, indices and metadata
and no `groups`. Appending a patch does not invalidate a group range — every
existing range still describes exactly the faces it described and stays inside
the longer index buffer, which is all `assertMeshStructure` asks — so the source's
groups are now carried across. Without this, filling one opening would have been
a silent metadata loss: the OBJ exported afterwards would have lost its object
structure.

The patch faces join no group. They are new geometry the file never carried, and
assigning them to whichever group happened to end last would be CAD Fixer
inventing a membership the user never stated.

## The inventory is bounded, and the count is not

A mesh of loose triangles has one boundary component per face; the research
corpus reached 20,165. The list is capped at 256 rows and the COUNT is exact,
because a truncated list must never become a smaller number of openings — the
same rule the topology report's component summary follows. The cap is disclosed
in words, with both numbers.

Only the SELECTED opening's geometry ever crosses to the page, as a disposable
line buffer. Listing every rim for a model with twenty thousand openings would
move megabytes to draw one.

## Lazy loading, and what the workflow costs

The hole-fill worker is now reachable, so it is now emitted: `hole-fill.worker`
is its own 82.8 kB chunk and is constructed only when Preview Fill is pressed.
Opening the app, opening the panel, listing openings and selecting one construct
no `Worker` at all. The Geogram artifact is unchanged and still loads only inside
a disposable worker.

| artifact          | before            | after     | delta    |
| ----------------- | ----------------- | --------- | -------- |
| main JS           | 897.3 kB          | 931.7 kB  | +34.4 kB |
| CSS               | 18.4 kB           | 20.1 kB   | +1.6 kB  |
| geometry.worker   | 137.5 kB          | 143.8 kB  | +6.4 kB  |
| hole-fill.worker  | —                 | 82.8 kB   | new      |
| self-intersection | 1,272.7 kB (wasm) | unchanged | 0        |

## What is still out of scope

Everything Stage 4B-1B1 excluded, unchanged: non-planar filling, batch or
"fill all" filling, tolerance welding, seam snapping, fairing, smoothing,
surrounding remeshing, inter-part collision analysis, PMP, redo and a multi-step
undo history. `Filled` still means ONE named opening was closed and validated
against the part it came from — not watertight, not printable, not free of other
openings, and not free of pre-existing crossings.
