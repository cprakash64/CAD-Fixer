# Repair policy

Status: Stage 3A-1 (design). **No repair is implemented.** This document decides
what each repair would be allowed to do, before any kernel exists to do it — so
that the kernel choice is made against our requirements rather than our
requirements being written to match whatever a kernel happens to do.

---

## 1. Confidence classes

Every repair operation belongs to exactly one class. The class determines
whether it can run automatically, whether it needs a parameter, and what the
interface must say about it.

### Deterministic

The intended result is determined by exact structure alone. No parameter, no
threshold, no interpretation. Running it twice changes nothing the second time.

> If two people who understand the format would produce the same result, and a
> program can find that result from exact data, the operation is deterministic.

### Parameter-dependent

A valid result exists, but **which** valid result depends materially on a
user-visible parameter — almost always a tolerance. The same input with two
different tolerances gives two different, both-defensible answers.

> These are never "safe cleanup". The parameter is the operation.

### Reconstructive

The operation creates significant new geometry, or resolves an ambiguity by
choosing among several possible surfaces. Hole filling and intersection
resolution live here: the vertices that come out did not exist going in.

### Destructive fallback

The operation deliberately abandons the original surface to recover _something_
printable — voxel remesh, SDF rebuild, convex approximation. Feature detail is
lost by design. Legitimate as a clearly labelled last resort; never a default.

**The naming rule.** Parameter-dependent and reconstructive operations must
never be presented as "cleanup", "fix", or "safe". They change the model in ways
the user needs to see and agree to.

---

## 2. Repair modes

Product-level groupings, designed here and implemented later.

### Conservative Repair

- **Permitted:** deterministic operations only.
- **Geometry may move:** never. No vertex position changes.
- **Topology may change:** yes — faces may be removed, winding may be flipped.
- **Never silently:** nothing here is silent; every removal is counted and shown.
- **Validation:** structural + full topology report, before and after.
- **Warnings:** a per-operation list of exactly what was removed or flipped.

### Assisted Repair

- **Permitted:** deterministic plus parameter-dependent plus clearly disclosed
  reconstructive operations.
- **Geometry may move:** yes, bounded by the stated tolerance, and the bound is
  reported as a measured maximum displacement rather than assumed.
- **Topology may change:** yes, including new faces from hole filling.
- **Never silently:** a tolerance is never chosen for the user; an intentional
  opening is never filled without an explicit instruction naming that loop.
- **Validation:** as above, plus a geometry-preservation report.
- **Warnings:** every parameter used, every loop filled, every weld performed.

### Rebuild as Solid

- **Permitted:** destructive fallback.
- **Geometry may move:** everywhere. This is a reconstruction.
- **Topology may change:** completely; the output shares no vertices with input.
- **Never silently:** the mode name must appear in the interface and in the
  result; a user must not arrive here by pressing "Repair".
- **Validation:** as above, plus an explicit surface-deviation measurement.
- **Warnings:** a statement that the original surface was replaced, with the
  measured deviation.

Names are provisional. What is not provisional is the three-way split between
_changes nothing geometric_, _changes geometry within a stated bound_, and
_replaces the surface_.

---

## 3. Policy matrix

`Auto?` means "may run in Conservative Repair without asking".

| Defect                               | Detectable today | Proposed operation                       | Confidence                                        | Auto?                              | Confirm?        | Parameter               | Output validation                         | Information loss                           | Geometry moves | Engine role        |
| ------------------------------------ | ---------------- | ---------------------------------------- | ------------------------------------------------- | ---------------------------------- | --------------- | ----------------------- | ----------------------------------------- | ------------------------------------------ | -------------- | ------------------ |
| Exact duplicate face, same winding   | Yes              | Remove extras beyond the first           | Deterministic                                     | **Yes**                            | No              | None                    | Structural + topology                     | None that affects the surface              | No             | Own code           |
| Reversed duplicate face              | Yes              | Report; remove **only** on request       | Deterministic detection, ambiguous resolution     | **No**                             | Yes             | None                    | Structural + topology                     | The pair may encode a zero-thickness sheet | No             | Own code           |
| Repeated-position degenerate face    | Yes              | Remove                                   | Deterministic                                     | **Yes**                            | No              | None                    | Structural + topology                     | None — it has no area                      | No             | Own code           |
| Zero-area (collinear) face           | Yes              | Remove                                   | Deterministic                                     | **Yes**, with a connectivity check | No              | None                    | Structural + topology + component count   | None if component count is unchanged       | No             | Own code           |
| Winding conflict, orientable surface | Yes              | Reorient by BFS over face adjacency      | Deterministic                                     | **Yes**                            | No              | None                    | Structural + topology                     | None                                       | No             | Own code           |
| Winding conflict, non-orientable     | Yes              | Report; refuse                           | —                                                 | No                                 | —               | —                       | —                                         | —                                          | —              | Own code           |
| Inverted closed shell                | Partly           | Flip whole component                     | Deterministic **only** under stated preconditions | **No**                             | Yes             | None                    | Structural + topology + volume sign       | None                                       | No             | Own code           |
| Boundary edges forming a simple loop | Yes              | Fill                                     | Reconstructive                                    | **No**                             | Yes, per loop   | Fill method             | Structural + topology + self-intersection | New geometry invented                      | Adds geometry  | Kernel             |
| Open boundary chain                  | Yes              | Report only                              | —                                                 | No                                 | —               | —                       | —                                         | —                                          | —              | —                  |
| Branched boundary                    | Yes              | Report only; refuse to fill              | —                                                 | No                                 | —               | —                       | —                                         | —                                          | —              | —                  |
| Non-manifold edge                    | Yes              | Report; offer edge split or face removal | Reconstructive                                    | **No**                             | Yes             | Strategy                | Structural + topology                     | Depends on strategy                        | Possibly       | Kernel             |
| Non-manifold vertex (bow-tie)        | Yes              | Report; offer vertex split               | Reconstructive                                    | **No**                             | Yes             | Strategy                | Structural + topology + component count   | Component count intentionally increases    | No             | Kernel             |
| Disconnected components              | Yes              | Report; offer _select_, never auto-merge | Deterministic detection                           | **No**                             | Yes             | Selection               | Structural + topology                     | Discarding a component is data loss        | No             | Own code           |
| Tiny crack / near-coincident seam    | **No**           | Weld within tolerance                    | Parameter-dependent                               | **No**                             | Yes             | **Tolerance, required** | Structural + topology + displacement      | Distinct vertices merged irreversibly      | Yes, bounded   | Kernel or own      |
| Self-intersection                    | **No**           | Resolve                                  | Reconstructive                                    | **No**                             | Yes             | Strategy                | Structural + topology + self-intersection | Original surface altered at intersections  | Yes            | Kernel             |
| Intersecting shells                  | **No**           | Union                                    | Reconstructive                                    | **No**                             | Yes             | —                       | All of the above                          | Shell identity lost                        | Yes            | Kernel (boolean)   |
| Sliver triangles                     | **No**           | Collapse / remesh                        | Parameter-dependent                               | **No**                             | Yes             | Threshold               | Structural + topology + displacement      | Small features may vanish                  | Yes            | Kernel             |
| Catastrophic soup                    | Partly           | Rebuild as solid                         | Destructive fallback                              | **No**                             | Yes, explicitly | Resolution              | All + deviation                           | Entire original surface                    | Everywhere     | Kernel (SDF/voxel) |

---

## 4. The reasoning behind the contested rows

The stage brief asks these directly. Answers, with reasons rather than
precedent — "a slicer does this" is not a reason.

### Should exact same-winding duplicate faces be removable automatically?

**Yes.** Two triangles occupying the same three recovered vertices in the same
cyclic order describe the same surface patch twice. Removing the extra changes
no point of the surface, no area, no enclosed volume, and no connectivity —
every edge it contributed is contributed identically by the survivor. The
operation is exactly reversible in principle (we know what was removed) and the
count is reported.

### Should reversed duplicates be treated identically?

**No, and this is the trap.** A reversed duplicate is geometrically the same
triangle but topologically the opposite: the pair forms a closed, zero-volume
two-sided sheet. Removing one leaves a single-sided face; removing both deletes
the surface there entirely. Which is correct depends on whether the pair is

- redundancy from a bad export (remove one), or
- a genuine zero-thickness feature the user modelled (removing either destroys it).

Topology cannot distinguish these. It is reported and offered, never automatic.

### Can zero-area faces always be removed without changing connectivity?

**No — and this is why the row carries a connectivity check.** A collinear
triangle contributes three real edges to the topology. If it is the only thing
joining two otherwise separate patches, removing it splits one component into
two. The face contributes no area, but it does contribute _connectivity_.

The policy: remove zero-area faces, then re-run component analysis, and treat an
increased component count as a result requiring disclosure rather than a silent
success. It stays automatic in Conservative Repair because the check is cheap
and exact.

### When is a winding correction deterministic?

When the surface is **orientable** and the propagation is unambiguous. Pick a
seed face per component, breadth-first across shared ordinary edges, and flip
any neighbour that traverses the shared edge in the same direction. On an
orientable, edge-manifold component this terminates with a consistent
orientation independent of the seed.

It is **not** deterministic when:

- the component is non-orientable (a Möbius configuration) — propagation reaches
  a contradiction, and the honest response is to refuse;
- the component has non-manifold edges — "the neighbour across this edge" is not
  well defined with three or more faces.

So: deterministic _after_ edge-manifoldness is established, and refusing
otherwise. Note this fixes _relative_ consistency only. Whether the result faces
outward is the separate question below.

### Can a closed component be flipped based on signed volume before

self-intersections are checked?

**No, not automatically.** The inference "negative signed volume ⇒ inward-facing"
holds for a closed, edge- and vertex-manifold, consistently wound, **non-self-
intersecting** shell. The last condition is precisely the one Stage 2 cannot
check. A self-intersecting shell counts overlapping regions more than once, and
the sign can flip without the surface being inverted.

It may be _offered_ with its preconditions stated, and it becomes automatic only
once self-intersection detection exists and reports clean. This is a concrete
example of a diagnostic gap directly limiting a repair.

### Should a simple boundary loop automatically be filled?

**No.** This is the most important "no" in the document. A boundary loop is a
topological fact; whether it is a defect is a statement about intent. The open
end of a tube, a vase, a cut-away section, and a genuine crack all present as
boundary loops. Filling automatically would silently turn a designed opening
into a solid — and the user would have no way to know it happened.

Fill is offered per loop, with the loop highlighted in the viewport, and the
result validated for self-intersection where a detector exists (a filled
non-planar loop can easily produce a patch that intersects the model).

Fixture **R09 (open tube)** exists specifically to catch a candidate whose
"repair" fills every loop and calls it success.

### Should a 0.01-unit gap be welded?

**Unanswerable as posed, and that is the point.** STL states no unit. 0.01 is
1/100 mm on a dental model — a real feature — and 1/100 m on an architectural
model — noise far below any printable detail. The same number is both.

Therefore:

- No global default tolerance is defined in this stage.
- Welding is Assisted Repair only, with a **required** parameter.
- The bakeoff corpus tests **absolute** and **relative** (bbox-fraction)
  tolerance scenarios separately (fixtures R19–R21), because they are different
  models of the same idea and we do not yet know which is right.
- **R21** exists to punish indiscriminate welding: two intentionally parallel
  surfaces closer together than the crack in R19 is wide. Any tolerance large
  enough to heal R19 will destroy R21 if applied blindly, which is the evidence
  needed to decide whether tolerance can be global at all, or must be local.

---

## 5. Rules binding every future repair

1. **A repair operates on a candidate**, never on the resident model. See
   [REPAIR_ARCHITECTURE.md](REPAIR_ARCHITECTURE.md).
2. **Kernel success flags are recorded, never trusted.** Our own topology engine
   is the independent oracle.
3. **Validation is not optional.** Structural validation plus a full topology
   report run on every output before it can be offered.
4. **Nothing is committed without the user accepting it.**
5. **Every commit produces a new revision**, retaining what is needed to revert.
6. **No operation may claim printability.** Until self-intersection and wall
   thickness exist, no repair changes that answer.

---

## Implementation status — Stage 3B-1A

| Confidence class     | Status                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- |
| Deterministic        | **IMPLEMENTED** — duplicate removal, degenerate removal, relative winding unification |
| Parameter-dependent  | not implemented; no epsilon exists in the production repair API                       |
| Reconstructive       | not implemented                                                                       |
| Destructive fallback | not implemented                                                                       |

The deterministic class is implemented as a _transaction_, not a mutation: plan,
candidate, independent validation, guarded commit, inverse patch. No user-facing
Repair workflow exists yet — Stage 3B-1B builds that on these contracts.

**General mesh repair is NOT complete**, and nothing in the interface may
suggest it is.

---

## Implementation status — Stage 3B-1B (the workflow)

The engine's policy is unchanged. What this stage adds is the policy governing
how that engine is **offered**, which is a separate set of decisions with its own
ways of going wrong.

### The default selection is all four operations

All four conservative operations are selected by default. This is not
"repair everything", and the distinction is load-bearing:

- Each is decidable **exactly** from the stored coordinates. No tolerance exists
  in the API to get wrong.
- Each **refuses itself** when it cannot be safe. Selecting an operation does not
  make it run; it makes the engine consider it and say what it decided.
- Nothing runs on selection. The plan is computed, shown, and only then can a
  candidate be built — and only then can it be applied.

Defaulting them off would have meant a user seeing four "Not selected" rows and
having to guess which are safe, which is exactly the judgement CAD Fixer is
supposed to be making for them.

### Every operation is listed, always

Including the ones with nothing to do, and especially the ones that were refused.
An absent row leaves a user wondering whether the check ran; a refused row that
says why is the most useful thing on the screen for a model CAD Fixer cannot fix.

### A refusal is not an error

`REFUSED_UNSAFE` and `BLOCKED_BY_PRECONDITION` are a conservative engine working
correctly. They are shown as decisions with reasons, in a distinct visual
register from errors. Styling a considered refusal in red teaches users that a
careful tool is a broken one, and the next thing they do is look for a tool that
does not refuse.

### Selection cannot widen what the engine will do

A refused or blocked operation is **not selectable**. Selecting it would produce
a plan that refuses it again, which reads as the checkbox not working. The plan
is recomputed when the selection changes — which operations apply depends on
which others run first, because duplicates are removed before winding is solved.

### The wording rules

Enforced by test against every string
`apps/web/src/state/repair-presentation.ts` can emit:

| Never say                        | Because                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| printable, ready to print        | wall thickness is not measured; self-intersections are unchecked |
| watertight                       | implies a verified closed solid                                  |
| fully repaired, all errors fixed | four defect classes were attempted; the rest were refused        |
| fix everything, make printable   | the same claim, as an imperative or a promise                    |
| hole                             | a boundary loop may be an intended opening                       |
| faces outward, outward-facing    | winding is unified RELATIVE to neighbours only — ADR 0010        |

What may be said, after a validated and committed repair:

> **Conservative repair applied.** Selected topological issues were repaired and
> revalidated.
>
> Self-intersections and wall thickness have not yet been checked.

The qualifier is a required field on every verdict rather than a suffix a caller
may forget — including on success, which is the case where it is most tempting to
drop and most misleading to omit.

### An expected change is not a regression

Once the validator ACCEPTS a candidate, every remaining difference was predicted
before the rebuild and confirmed after it. The interface labels those `(expected)`
and never as damage.

The case this exists for: removing a duplicate can make the boundary-edge count
go **up**. Two coincident triangles pair each other's edges and look closed, so
deleting the redundant copy reveals the boundary that was always there. Reporting
"3 new boundary errors" would be the interface inventing a problem the engine
explicitly reasoned about and allowed — and would push a user to undo a correct
repair.

### Warnings are a third register

Not silence, not an error. A bounding box that changed because removed geometry
defined an extreme, a signed volume that moved because orientation moved, a
component that disappeared because every one of its faces was removable — these
are reported as things worth knowing, in their own styling, beside a repair that
was accepted.

### A preview is never an application

Nothing in the interface describes a candidate as having changed the model. The
viewport is labelled while a proposal is shown. Discarding is always available and
always leaves the model exactly as it was.

### One step of undo, and no redo

Undo is offered for the most recent repair only. Redo is not implemented and is
not derivable from what is retained — see
[ADR 0011](../adr/0011-repair-undo-revisions.md). The recourse after an undo is to
run the repair again, which is safe precisely because conservative repair is
deterministic.
