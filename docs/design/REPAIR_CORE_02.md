# REPAIR-CORE-02 — Large-mesh open-boundary repair in Repair model

Status: qualified to 2,000,000 triangles in Chromium (see §9). Builds on
REPAIR-UX-01 (`f8e5252`). Non-manifold vertex repair: DEFERRED, not implemented
(§11).

## 1. What changed for a user

Repair model now also closes **eligible simple flat openings**, as part of the
same single candidate as the four conservative operations — at any part size the
scan admits, not only up to 250,000 triangles. A fifth option, **Fill simple
openings** (on by default), controls it. For the motivating model's shape
(6 simple loops, 7 branched boundaries, 155 non-manifold vertices, 39
components, ~2M triangles) Repair model is now enabled and says
"N openings can be filled. Other detected issues will remain."; the preview
names how many openings it filled and, by reason, which it left open; the
result card lists "N openings filled" and what remains from the new analysis.

The per-opening workflow (select one opening, Preview fill, Apply fill) is
unchanged, including its 250,000-face ceiling.

## 2. Why the old path could not simply be scaled

The per-opening engine (ADR 0018) copies the whole part to the fill worker,
recovers a vertex id for every corner, materialises and radix-sorts every
directed edge, keeps per-component JavaScript arrays, re-extracts boundary
loops for source AND candidate, and builds a BVH over every source face. The
REPAIR-UX-01 audit found 691–1,034 B/face on loose-triangle shapes. Raising the
ceiling would have kept all of that. This stage replaces it with a path whose
part-proportional cost is one small table.

## 3. Architecture

```
geometry worker (authoritative, cooperative cancellation)
  compact boundary scan (mesh-topology/boundary-scan.ts)       O(F), ~21 B/face
  admission per loop (mesh-hole-fill/admission)                bounded by the loop
  local region: faces whose box meets a loop's box             O(F) scan, bounded output
        │  region only (Float64 points, local triangles, patches)
        ▼
disposable fill worker (Geogram kernel; cancel = terminate)
  patch-attributed exact check over the region, per loop
        │  one verdict per loop (scalars)
        ▼
geometry worker
  append passing patches (positions shared, index prefix byte-identical)
  independent Stage 2 re-analysis of the whole candidate
  judgeFilledCandidate: every count must match its exact prediction
  → ONE repair candidate → existing repair/commit and repair/undo
```

### 3.1 Compact boundary scan

One open-addressed hash table of undirected edges keyed by the EXACT stored
coordinates of their endpoints (ADR 0009's hash, `-0` normalised, exact
comparison — never a tolerance). An entry is five bytes: the first directed-edge
slot that produced it (`face·3 + corner`, from which both endpoint corners and
the owning face are recovered) and a byte holding a saturating incidence count
and a "second use ran the same way" (winding conflict) flag. The table grows by
doubling at 70% load.

Everything after it is proportional to the BOUNDARY, and the boundary is capped
(`maxBoundaryEdges` = 100,000) before any of it is allocated: boundary vertices
get ids from a small exact-coordinate table, the absent face's direction gives
the walk, union-find gives components, and the refusal rules and their ORDER are
`extractBoundaryLoops`'s exactly (degenerate segment, non-manifold adjacency,
folded winding, branched, convergent, not closed; then too few / too many /
non-finite). A differential test holds the two implementations to identical
loops — membership, refusal, vertex and edge counts, cyclic order and direction
— on every topology and hole-fill fixture and 2,000 random grid meshes (soup and
indexed, with duplicates, flips and three-way edges).

Loop identity is geometric (`bx-<n>-<hash64>` over the canonical ordered
coordinates), so the plan and the candidate agree on a loop across revisions
whose boundary did not change. Components are vertex-disjoint, so a collision is
astronomically unlikely; if two loops ever do share an id, both are refused
(`AMBIGUOUS_IDENTITY`) rather than one being chosen.

### 3.2 Admission (per loop, never "all")

A loop is admitted only if it independently: is a simple closed cycle; has at
most 512 points; is relatively planar (ADR 0018's dimensionless 1e-4 ratio —
unchanged); is ear-clipped deterministically into exactly n−2 triangles with no
added point; has no zero-area patch triangle (the topology engine's own exact
predicate and area formula, first corner as origin); adds no diagonal the part
already has (edge-table lookup); uses each rim edge exactly once in loop order
and each diagonal exactly twice, opposite ways; and, for n = 3, is not the
reverse of the single face that owns all three rim edges.

Independence: a loop whose bounding box touches (inclusive) an already-admitted
loop's box is deferred (`INTERACTS_WITH_ANOTHER_OPENING`), so patch order can
never decide topology; it is filled by the next Repair model once its neighbour
is closed. Batch caps: 64 loops and 4,096 rim points per candidate
(`BATCH_LIMIT`).

### 3.3 Local intersection check — why it is complete

A patch triangle can take part in an invalid pair with an existing face only if
their axis-aligned boxes overlap; every patch vertex is a loop vertex, so every
patch lies inside its loop's box. Collecting every face whose box meets a loop's
box (inclusive, as the existing broadphase is) therefore loses no pair the
whole-part check would test. The region is welded by exact coordinates into a
small Float64 geometry, the patches appended, and the disposable worker runs the
same inclusive BVH, the same streamed pair buffer, the same budgets (per loop)
and the same qualified Geogram narrowphase as the per-opening engine. A loop is
clean only if its scan was complete; an unclassifiable pair or a budget stop is
`NOT_VERIFIABLE`, never clean. The region is capped at 250,000 faces in total —
the workload the per-opening engine was qualified at — and a loop whose region
does not fit is excluded (`REGION_TOO_LARGE`), never checked partially.

### 3.4 The candidate and its independent verdict

Append-only: positions are the source's buffer by reference; the index buffer's
prefix is the source's bytes verbatim; patches follow; groups are carried and
patch faces join none. `sourcePreserved` checks the bytes. Stage 2 then
re-analyses the WHOLE candidate and `judgeFilledCandidate` requires, exactly:
faces +Σ(n−2); boundary edges −Σn; boundary components −(loops filled);
non-manifold edges, winding conflicts, components, vertices, duplicates and
degenerate faces unchanged; non-manifold vertices never more; surface area
+Σ patch area (relative 1e-9, because summation order changes). Any mismatch
fills nothing (`REJECTED`). Volume is informative only and reported as not
interpretable: closing an opening changes whether a signed volume means anything.

When conservative operations also run, they run first (their own staged
validation, unchanged), the fill stage runs on their accepted result, and the
combined validation describes source → final candidate. Filling never rescues a
rejected conservative candidate.

### 3.5 Transaction

The combined candidate is registered in the existing `RepairCandidateStore` and
committed by the existing `repair/commit` (every guard worker-side, all fallible
work before the swap). Undo is the existing `repair/undo`, restoring the exact
retained mesh object. One Repair transaction, however many loops.

### 3.6 Staleness

The plan's `boundaryFill.planHash` binds the admitted set to the document,
revision and part; `repair/create-candidate` recomputes it from the source and
refuses a mismatch. Candidates and plans are keyed by revision; the fill plan
cache is released on commit. A verifier reply is awaited with the operation's
cancellation, so a replaced document cannot receive a stale candidate.

### 3.7 Preview

A fill-only candidate (conservative stage a no-op) sends ONLY its patch
triangles, drawn beside the unchanged model with the per-opening overlay; a full
render snapshot of a 2M-triangle part is ~144 MB and a multi-second main-thread
upload for a change of a few dozen triangles. When conservative operations
changed existing triangles the full snapshot is sent, as before.

## 4. Boundary changes, stated

- `@cadfixer/mesh-hole-fill/admission` is a new subpath, and the ONLY part of
  the package the geometry worker may import (`apps/web/src/workers/boundary-fill.ts`).
  It reaches ear clipping, planarity, admission, the region builder and the
  candidate judge — never `engine.ts`, `bvh.ts`, `local-intersection.ts`,
  `validate.ts` or the index. A production-boundary test walks the import graph
  and holds that; the built geometry-worker bundle contains exactly those five
  modules and no WASM.
- The fill worker is still constructed in exactly one place
  (`runtime/hole-fill-service.ts`, now also `openFillVerifier`), only when a
  preview needs it.
- The "no batch fill" rule is superseded by the stage brief's explicit decision:
  Repair model fills openings that each qualify independently, bounded per
  repair, with a user option to turn it off. The banned wording (`Fill All`,
  `Close All`, …) stays banned.

## 5. Format consistency

Patch triangles reference existing corners, so the candidate is ordinary
geometry to every writer; e2e RCF3 exports STL, OBJ and 3MF after applying,
re-imports each, and requires the filled openings to remain filled (only the 7
complex boundaries remain open).

## 6. Resource policy (compound, measured)

| Limit                     | Value                                              | Why                                                                    |
| ------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| Boundary edges assembled  | 100,000                                            | caps all boundary-proportional work; loose-triangle meshes refuse here |
| Points per loop           | 512                                                | the engine's qualified ceiling, unchanged                              |
| Openings per repair       | 64                                                 | bounds admission and the per-loop verify                               |
| Rim points per repair     | 4,096                                              | bounds patch faces (≤ 4,096 − 2·loops)                                 |
| Faces in the local region | 250,000                                            | the narrowphase workload already qualified                             |
| Narrowphase budgets       | ADR 0018's, per loop                               | unchanged                                                              |
| Part size                 | the repair preflight (1 GiB peak model), unchanged | the scan adds ~21 B/face                                               |

## 7. What is informative and what is authoritative

Authoritative: every count in `judgeFilledCandidate`, byte preservation, the
per-loop exact check. Informative: surface area within 1e-9 (summation order),
signed volume (not compared), bounds (unchanged by construction, reported).

## 8. Tests

- `mesh-hole-fill/src/boundary-scan.test.ts` — scan ≡ `extractBoundaryLoops`
  (fixtures + 2,000 random meshes), resource refusal, determinism, face-order
  independence, no canonical writes.
- `mesh-hole-fill/src/local-fill.test.ts` — fixtures A–J end to end with the
  reference narrowphase; agreement with the whole-part engine.
- `workers/node-tests/local-fill-kernel.test.ts` — the same with the shipped
  Geogram kernel; agreement with the whole-part engine per fixture.
- `workers/boundary-repair.test.ts` — the real handlers: large-part admission,
  one combined candidate, atomic commit, exact undo, fail-closed without a
  verifier, HP23 refused by the exact check, conservative + fill combined,
  determinism, stale fill plan refused, cancellation while awaiting the
  verifier registers nothing, patch-only preview.
- `workspace-repair.test.ts`, `RepairWorkspace.test.tsx`,
  `repair-workspace-presentation.test.ts` — Repair model enabled for fills
  alone; truthful scope; option toggle.
- `e2e/repair-core.spec.ts` — the 270,000-triangle holed cube through the real
  UI: enabled CTA, preview counts, apply, truthful result, undo, STL/OBJ/3MF
  round trips, cancellation, option off.
- `scripts/boundary-fill.bench-suite.ts`, `scripts/boundary-fill.qualify.mjs` —
  §9.

## 9. Measurements

Host: Apple M1, 8 GiB, macOS 27.0, Node 22.22.2, Playwright Chromium 1.62.1.
Fixture: the holed cube (`scripts/boundary-fill-fixture.mjs`) — closed except
for 6 simple planar openings and 7 branched boundaries, the motivating model's
shape. Memory is macOS `phys_footprint_peak`. Machine-dependent; re-run with the
commands in each script's header.

### 9.1 Engine phases (Node, `NODE_OPTIONS=--expose-gc npm run bench:boundary-fill`)

| Faces     | Scan   | Scan table          | Old walk, modelled peak | Region          | Kernel | Re-analysis | Result                 |
| --------- | ------ | ------------------- | ----------------------- | --------------- | ------ | ----------- | ---------------------- |
| 99,332    | 61 ms  | 1.3 MiB (13 B/face) | 160 B/face              | 96 faces        | 9 ms   | 131 ms      | 6 of 13, 0 regressions |
| 1,997,528 | 1.28 s | 40 MiB (21 B/face)  | 322 MiB (169 B/face)    | 96 faces, 74 ms | 4 ms   | 1.23 s      | 6 of 13, 0 regressions |

The pathological shape — loose triangles, every edge a boundary edge — scans
1M and 2M faces in 1.7 s and 3.6 s with a 63 B/face table and refuses at the
100,000 boundary-edge cap (`TOO_MANY_BOUNDARY_EDGES`) before any
boundary-proportional allocation. Stage 6D-R3 measured the old walk at
691–1,034 B/face on that shape.

### 9.2 The application (Chromium, `npm run qualify:boundary-fill -- <sizes> --hardware-gl`)

Renderer-process peak, and time per phase. Plan = compact scan + admission;
preview = region, disposable-worker exact check, append, independent
re-analysis; apply = commit + re-analysis. "Gap" is the longest interval
between animation frames on the main thread during that phase.

| Triangles | Renderer peak | Plan (gap)     | Preview (gap)   | Apply  | Result                               |
| --------- | ------------- | -------------- | --------------- | ------ | ------------------------------------ |
| 99,332    | 182 MiB       | 124–178 ms (0) | 433–442 ms (17) | 379 ms | 6 filled, 7 left open, +12 triangles |
| 248,792   | 274 MiB       | 366 ms (18)    | 973 ms (18)     | 998 ms | same                                 |
| 499,352   | 387 MiB       | 959 ms (18)    | 1.50 s (66)     | 944 ms | same                                 |
| 1,002,212 | 723 MiB       | 1.49 s (18)    | 2.00 s (50)     | 1.48 s | same                                 |
| 1,997,528 | 942 MiB       | 1.96 s (18)    | 4.04 s (34)     | 2.07 s | same                                 |

At every size the result card reads "remaining: 7 open boundaries, 7
non-manifold vertices" from the new analysis, and no session was lost. For
comparison, the EXISTING automatic analysis of the same 2M part peaks at
735 MiB with an 18 ms gap; the fill preview adds 207 MiB on top of it
(transient: current drops to 397 MiB once it settles), and apply adds nothing
to the peak. The first 100k run of a fresh browser showed a 633 ms gap — a cold
Metal shader compile — and 17 ms on every later run.

**Cancellation** (`--cancel`): pressed during "Revalidating the proposed
result" at 2M, acknowledged in 64 ms (hardware GL; 331 ms headless) and 123 ms
at 1M headless; the part was unchanged (1,997,528 triangles), the maximum gap
was 18 ms, and the workflow was usable again.

**Headless numbers are not responsiveness numbers.** Headless Chromium draws
WebGL through SwiftShader, a CPU rasteriser. There, one redraw of the 2M part
— a viewport resize or an orbit with no repair involved — takes 1.3–1.7 s, and
the preview (which redraws twice: the After view and the patch overlay) showed a
3.3–3.5 s gap. A main-thread CPU profile of that preview attributed under
200 ms to page script, and the same step on the GPU is 34 ms. The headless
renderer peaks are comparable (938 MiB at 2M, 1,247 MiB whole browser); the
hardware-GL whole-browser totals include a 500–860 MiB GPU process and are not
comparable with them.

### 9.3 What the patch-only preview bought

Before the fill-only preview sent only its patch triangles (§3.7), the 2M
whole-browser peak in headless Chromium was 1,587 MiB; after it, 1,247 MiB.

## 10. Out of scope, deliberately

Non-planar or curved openings, surface interpolation, remeshing, any tolerance,
filling branched or complex boundaries, and closing an opening the user did not
leave "Fill simple openings" on for.

## 11. Non-manifold vertices — DEFERRED, NOT IMPLEMENTED

REPAIR-UX-01 proved (`mesh-topology/src/vertex-split-audit.test.ts`) that
splitting a pinched vertex into records at the same coordinate is invisible to
ADR 0009's exact-coordinate identity and cannot survive STL. ADR 0009 is not
amended here. A future stage (REPAIR-CORE-03 / TOPOLOGY-IDENTITY) would have to
introduce format-aware indexed identity first; boundary filling does not need
it.
