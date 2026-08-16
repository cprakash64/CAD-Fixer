# Repair defect taxonomy

Status: Stage 3A-1 (design). Nothing here is implemented as a repair.

This classifies what can be wrong with a mesh, organised by **what kind of
knowledge is needed to fix it**. That is the axis that matters, because it
decides whether a repair is a bookkeeping operation, a judgement call, or a
reconstruction — and therefore whether it can ever run without asking.

Stage 2 measures the first class exactly. The rest are either undetectable
today, or detectable only with a parameter we have no principled value for.

---

## Class A — Exact topology defects

**Detectable today, exactly, with no parameter.** These are facts about the
recovered connectivity, and Stage 2's engine reports every one of them. No
tolerance, no threshold, no interpretation.

| Defect                              | Stage 2 field                       | What it means                                                                    |
| ----------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| Exact duplicate face (same winding) | `sameOrientationDuplicateCount`     | Another triangle uses the same three recovered vertices in the same cyclic order |
| Reversed duplicate face             | `reversedOrientationDuplicateCount` | Same three vertices, opposite cyclic order                                       |
| Repeated-position degenerate face   | `repeatedPositionFaceCount`         | Fewer than three distinct recovered vertices                                     |
| Zero-area face                      | `zeroAreaFaceCount`                 | Three distinct vertices, exactly collinear                                       |
| Winding conflict                    | `windingConflictEdgeCount`          | Two faces traverse a shared edge in the same direction                           |
| Boundary edge                       | `boundaryEdgeCount`                 | Exactly one incident face                                                        |
| Simple boundary loop                | `simpleBoundaryLoopCount`           | A closed cycle of boundary edges, every vertex of boundary degree 2              |
| Open boundary chain                 | `openBoundaryChainCount`            | Boundary edges forming a path, exactly two degree-1 ends                         |
| Branched boundary                   | `branchedBoundaryCount`             | A boundary vertex of degree 3+, or an odd number of ends                         |
| Non-manifold edge                   | `nonManifoldEdgeCount`              | More than two incident faces                                                     |
| Non-manifold vertex                 | `nonManifoldVertexCount`            | Incident faces do not form one connected fan                                     |
| Disconnected face components        | `componentCount`                    | Face-connected pieces, joined only through shared edges                          |

**Why this class is special.** Every entry is derived from exact stored
coordinates. Two runs on the same file agree exactly, and a repair targeting one
of these can state precisely what it will change before it changes anything.

---

## Class B — Geometric defects

**Not detectable today.** These require intersection tests or metric
thresholds, and Stage 2 implements neither. Every one of them can be present in
a model whose Class A report is completely clean — which is exactly why the
interface never says "printable".

| Defect                             | Why Stage 2 cannot see it                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Self-intersection within one shell | Needs triangle/triangle intersection testing                                                                |
| Intersecting shells / components   | Same, across components                                                                                     |
| Overlapping coplanar faces         | Two faces occupying the same plane region share no recovered vertices unless their corners coincide exactly |
| Extremely thin slivers             | "Thin" is a metric judgement with no unit                                                                   |
| Near-degenerate triangles          | Exactly-collinear is detected; _nearly_ collinear needs a scale-relative threshold                          |

**The sliver problem.** A triangle can have three distinct, non-collinear
vertices and still be geometrically useless — an aspect ratio of 10⁶ to 1. That
is a numerical-robustness hazard for downstream operations, not a topological
defect, and calling it one would be a category error.

---

## Class C — Near-connectivity defects

**Not detectable today, and not detectable without a tolerance.** This is the
class that exists _because_ Stage 2 uses exact identity.

| Defect                     | What it looks like exactly                                                             |
| -------------------------- | -------------------------------------------------------------------------------------- |
| Near-coincident seam       | Two surfaces meant to join; their vertices differ in the last few float bits           |
| Tiny crack                 | A boundary loop whose two sides are separated by a distance far below any feature size |
| Nearly duplicated vertices | Two vertices a few ULPs apart, from inconsistent rounding upstream                     |
| Almost-touching shells     | Two components separated by a gap smaller than a nozzle                                |

**These are NOT Class A defects, and the distinction is load-bearing.** A tiny
crack reports as boundary edges — Class A — and it is tempting to treat "has
boundary edges" as "has a crack". It is not the same thing:

- A crack is boundary edges that **should** be joined.
- An intentional opening is boundary edges that **should not** be.

Topology cannot tell them apart. Only a tolerance plus a judgement can, and the
tolerance has no principled value while STL states no unit. See
[ADR 0009](../adr/0009-exact-topology-recovery.md) and §9 of the stage brief.

---

## Class D — Solid-semantic defects

**Partly detectable, with important gaps.** These are defects in what the
surface _means_ as a solid, not in its connectivity.

| Defect                                   | Detectable today?                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inverted closed shell                    | **Partly.** A closed, manifold, consistently wound component with negative signed volume is inverted — but only if it does not self-intersect, which is unchecked |
| Internal shell                           | **No.** Requires point-in-solid or winding-number queries against another component                                                                               |
| Nested shells with incorrect orientation | **No.** Requires nesting depth, which requires containment tests                                                                                                  |
| Zero-thickness sheet                     | **No.** A closed shell of zero enclosed volume is detectable; a sheet folded onto itself is not                                                                   |
| Open surface that may be intentional     | **Undecidable from topology.** This is not a defect at all until the user says it is                                                                              |

**The inversion trap.** Signed volume looks like a reliable orientation
detector, and for a simple closed shell it is. It is not reliable for a shell
with an internal cavity, where the sign depends on the cavity's orientation too,
nor for a self-intersecting shell, where the algebraic sum counts overlapping
regions more than once. Any automatic flip based on volume sign must state those
preconditions.

---

## Class E — Catastrophic / fallback cases

**Cases where the intended surface cannot be recovered, only approximated.**

| Case                              | Why it defeats structured repair                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Extremely corrupted triangle soup | No coherent connectivity to recover; the "intended" surface is a guess              |
| Dense self-intersection           | Resolving intersections produces more intersections; local repair does not converge |
| Massive scan noise                | Every triangle is slightly wrong; there is no defect to target                      |
| Unrecoverable intent              | Several equally plausible intended surfaces exist                                   |

For this class, structured repair is the wrong tool. The honest options are a
**reconstruction** (voxel/SDF rebuild, which discards the original surface and
returns something printable) or **refusing and saying why**. Both are legitimate;
silently returning a mangled mesh is not.

---

## What this taxonomy implies

1. **Class A is the only class we can repair deterministically today**, and even
   within it, only some entries (see [REPAIR_POLICY.md](REPAIR_POLICY.md)).
2. **Class C is the largest product gap** — tiny cracks are the single most
   common real-world complaint — and it cannot be closed without a tolerance
   model, which needs a unit model first.
3. **Class B is the largest diagnostic gap.** Until self-intersection detection
   exists, the product cannot make any printability claim, whatever else it fixes.
4. **Class D needs containment queries**, which is a kernel capability rather
   than something to hand-roll.
5. **Class E needs a fallback path** that is honest about being a reconstruction.
