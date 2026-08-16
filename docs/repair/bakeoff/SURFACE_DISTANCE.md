# Symmetric sampled surface distance

Stage 3A-3A. **Evaluation only.** Lives in `@cadfixer/repair-evaluation`, which
is never imported by `apps/**` or by any worker, and a test asserts that. It is
not production geometry code and must not become production geometry code
without a deliberate decision.

## What it is, and what it is not

For each direction it draws a bounded, deterministic, area-weighted set of
sample points on one surface and measures each one's **exact** distance to the
nearest triangle of the other, then reports the distribution — in both
directions.

**It is not the Hausdorff distance, and it is not named as one.** Hausdorff is a
supremum over the entire surface; this is a maximum over a finite sample, and a
sample can miss a spike thinner than its own spacing. Calling it Hausdorff would
convert a bounded estimate into a guarantee that has not been earned.

The failure mode is one-directional and worth stating plainly: **this metric can
report a change as smaller than it is. It cannot report a change that is not
there.** Section "Measured blind spot" below shows this happening in practice.

## Why symmetry is not optional

One direction alone is blind in a way that matters for repair evaluation:

- Sampling only A→B **cannot see geometry B added**. Every sample of A still
  sits on B's surface, so a protrusion grown by a repair scores zero.
- Sampling only B→A **cannot see geometry B deleted**.

A repair kernel does both, so the evaluator must measure both. The tests
`detects removed geometry in the forward direction` and `detects added geometry
in the reverse direction` pin exactly this: the same two meshes, swapped, with
the non-zero result moving from one direction to the other.

## Sampling

**Area-weighted stratified, deterministic, bounded.**

- Triangle areas are accumulated once; sample _k_ targets cumulative area
  `(k + 0.5)/N · total` and is located by binary search. A triangle holding 40%
  of the surface receives ~40% of the samples; a sliver receives approximately
  none. This is why a subdivided-but-identical surface scores the same as its
  original — samples follow **area**, not triangle count.
- Barycentric coordinates come from a **Halton sequence** (radical inverse, bases
  2 and 3) offset by the seed, warped onto the triangle with the standard
  square-root map. Chosen over `Math.random` (not reproducible) and over a seeded
  LCG (reproducible but clumpy at these counts).
- `N` is **fixed**, never proportional to area or triangle count. A metric whose
  cost grew with the model would be unusable on exactly the large models where
  preservation matters most. Default 20 000 per direction.
- The seed and sample count are recorded in every result.

**Degenerate fallback.** A mesh of only zero-area faces has no area to weight by
— R05 and R06 contain such faces, and a candidate can emit a mesh made entirely
of them. Sampling then spreads evenly across triangles, and the result sets
`degenerateAreaFallback: true` with `samplingMode:
'uniform-per-triangle-zero-area'`, so a reader never mistakes those numbers for
area-weighted ones.

## Nearest-point query

Point-to-triangle distance is the standard Voronoi-region solution (Ericson,
_Real-Time Collision Detection_): classify the point against vertex, edge and
face regions and clamp barycentric coordinates accordingly. Written out in full
rather than projected-and-clamped, because the naive version is wrong precisely
at edges and corners — which is where a repaired seam puts its samples.

**Degenerate targets are handled, not assumed away.** When a triangle has no
area the region denominators vanish, so they are checked and the function falls
back to the closest point on the three edges — correct for a sliver or a
collapsed segment. Tested directly.

All arithmetic is Float64. Narrowing here would put the metric's own error on
the same order as the differences it exists to detect.

## Acceleration

An **evaluation-only BVH**, flat typed arrays, `LEAF_SIZE = 4`:

- **Deterministic build.** Split axis from the node's own extent; split position
  the median of an explicitly **sorted** array, with ties broken on triangle
  index so the order is total even when centroids coincide (coplanar and
  duplicated fixtures produce exactly that). A quickselect partition would be
  faster and would _not_ be reproducible among equal keys.
- **Typed arrays, not one object per node** — bounds in a `Float64Array`, links
  in `Int32Array`s.
- **Iterative traversal**, nearer child first, pruning against the running best.
  Traversal order changes only how much is pruned, never the result.
- **Bounded memory**, capacity `triangleCount + 2`, checked and thrown on rather
  than trusted.
- Empty hierarchies return `Infinity`, never 0. "We compared against nothing"
  must not read as "the surfaces coincide".

### The capacity bug, recorded because it nearly fabricated evidence

The first version sized nodes as `2·ceil(N / LEAF_SIZE)`, assuming leaves fill to
`LEAF_SIZE`. Median splitting produces leaves of 2 or 3, so 200 triangles wanted
~133 nodes against a 100-node allocation. **Typed arrays discard out-of-range
writes silently**, so overflowed nodes read back as an internal node whose left
child is the root, and the query looped forever.

It is now provably bounded — splitting only happens above `LEAF_SIZE`, so
children hold ≥ 2 and leaves are ≥ 2, giving ≤ N nodes — the invariant is
asserted at runtime, and a regression test builds at nine sizes from 1 to 501,
checking capacity, that every triangle survives, and that queries terminate and
agree with brute force.

## The brute-force oracle

`bruteForceNearestDistanceSquared` is exported for **tests only** and is
deliberately O(triangles) per query. Both paths minimise the same function over
the same set, so anything but **exact equality** is a bug. Checked over a
343-point grid against a 200-triangle mesh and at four probe points against
every corpus fixture.

If the accelerated path ever disagreed, preservation numbers would come out too
small and every candidate would look more conservative than it is. That is the
specific failure this pair exists to catch.

## Reported values

Per direction: sample count, mean, RMS, **sampled** maximum, P95, P99.
Combined (pooled over both directions' samples): RMS, sampled maximum, P95, P99.

**Percentiles are computed from the actual sorted sample distances**
(nearest-rank), never approximated from RMS or maximum. All distances for the
bounded sample count are retained, which is affordable precisely because the
count is bounded.

## Normalisation

Absolute distances are in **model coordinate units**. STL states no unit, so
these are never labelled millimetres.

A normalised value is also reported, against the **bounding-box diagonal of mesh
A** (pass the input as A). When that diagonal is zero — a single point, an empty
mesh, R27-scale degeneracy — `referenceBoundingBoxDiagonal` and both normalised
fields are `undefined`. Never substituted with 1: a number computed against an
invented scale is worse than an absent one.

## Measured blind spot

Welding a 1e-4 seam moves a sliver holding ~1e-5 of the surface area, so whether
any sample lands on it is close to chance. Observed on R19 and R20:

| Fixture / operation | 2 000 samples | 8 000   | 32 000  |
| ------------------- | ------------- | ------- | ------- |
| R19 colocate 1e-3   | 4.5e-16       | 2.7e-04 | 4.0e-04 |
| R20 colocate 1e-3   | 4.5e-16       | 4.6e-16 | 3.8e-04 |
| R21 colocate 1e-3   | 5.0e-04       | 5.0e-04 | 5.0e-04 |

Where the change covers meaningful area (R21's whole sheet, R08's filled face)
the metric is stable across a 16× density range. **For thin-seam operations,
component and boundary counts are the reliable evidence and sampled distance is
a lower bound.** Results therefore record a sample-count sensitivity sweep rather
than a single number.

## Tests

`packages/repair-evaluation/src/surface-distance.test.ts` — 27 cases:

| Property                           | Expected                                                |
| ---------------------------------- | ------------------------------------------------------- |
| Identical mesh                     | all metrics ≈ 0                                         |
| Face reordering                    | ≈ 0                                                     |
| Vertex renumbering                 | ≈ 0                                                     |
| Subdivision preserving the surface | ≈ 0                                                     |
| Known translation                  | exactly the translation                                 |
| One displaced vertex               | non-zero                                                |
| Removed feature                    | forward direction detects it                            |
| Added feature                      | **reverse** direction detects it                        |
| Same local change at 1e6           | matches the origin case                                 |
| Repeated runs                      | byte-identical result                                   |
| Changed seed                       | different samples, same statistic                       |
| Zero bounding-box diagonal         | normalisation omitted, not `Infinity`                   |
| Area weighting                     | a 5e-9-area speck does not move P95                     |
| Percentile ordering                | P95 ≤ P99 ≤ max                                         |
| BVH vs brute force                 | exact equality                                          |
| BVH capacity, 9 sizes              | within bound, terminates, all triangles present         |
| Point-triangle regions             | interior, vertex, edge, on-vertex, zero-area, collapsed |
