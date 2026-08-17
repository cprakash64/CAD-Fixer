# ADR 0010 — Repair transactions, revisions, and relative winding

Status: **Accepted** (Stage 3B-1A)

## Context

Stage 3A qualified three geometry kernels and then declined to use any of them
first. The evidence said the honest opening move was the operations CAD Fixer
can decide from its own exact topology: duplicate removal, degenerate removal
and winding unification. Those need a transaction model before they need a UI —
a repair that mutates the user's model in place cannot be previewed, cannot be
refused after the fact, and cannot be undone.

Three questions had to be settled together.

## Decision 1 — A repair produces a CANDIDATE, never an in-place mutation

The authoritative mesh M0 is never written. Operations compute face masks
against it; one compaction produces a separate candidate; the candidate is
validated; only `repair/commit` swaps the reference.

There is therefore no state in which partially repaired geometry is
authoritative — not because the code is careful about ordering, but because the
authoritative buffer is never the target of a write.

`RepairCandidateHandle` is deliberately **not** a `ModelHandle`. Export and
analysis take a `ModelHandle`, so a candidate cannot be handed to them by
mistake; the compiler refuses. Two structurally identical "id plus revision"
types would have been simpler and would have allowed a candidate to be exported
as though it were the user's model.

**One active candidate per model.** A second proposal deterministically
supersedes and releases the first. Allowing several would mean deciding which
one a commit meant, and a wrong answer there applies the wrong repair silently.

## Decision 2 — Commit is guarded by revision AND plan identity

`prepareCommit` refuses unless all of these hold:

| Guard                                                 | Failure it prevents                                 |
| ----------------------------------------------------- | --------------------------------------------------- |
| candidate state is `resolved`                         | committing unvalidated geometry                     |
| validation acceptance is `ACCEPTED`                   | committing a repair the validators rejected         |
| candidate's source revision is still current          | a stale repair landing on newer geometry            |
| caller's `expectedSource` matches                     | a caller committing against a model it has not seen |
| `planHash` matches the validated one                  | committing something other than what was previewed  |
| candidate has not already committed or been discarded | double-apply, or reviving a cancelled repair        |

Commit creates a **new revision** of the same lineage, records the parent, and
returns a deterministic `repairRecordId` built from lineage, parent, result and
plan hash — **not** a wall clock, so two repairs a millisecond apart remain
distinguishable by what they did.

If the swap itself fails, the candidate stays `resolved` and retryable. A
transient race must not consume a valid repair.

## Decision 3 — Winding unification is RELATIVE, and the seed rule is public

Unification makes adjacent faces traverse shared edges consistently. It does
**not** decide which side is outside.

A connected orientable component admits two globally reversed solutions, and
this stage has no sound basis for choosing between them: signed volume, world
axes, the bounding box and the stored STL facet normal are all unreliable when
self-intersection and containment are unchecked — and Stage 3A-3B established
that they are unchecked, with no independent oracle available.

**The rule: the lowest-indexed surviving face in each component keeps its
orientation (flip parity 0).** Everything else follows from the parity solve.

This is why `CR10` expects _three_ flips on a tetrahedron whose face 0 is
reversed, not one. Flipping only face 0 would be the prettier answer and would
be a volume-based claim about inside and outside. The test asserts three flips
precisely so that such a heuristic cannot be introduced unnoticed.

Contradictory parity constraints yield `BLOCKED_BY_PRECONDITION`, never an
arbitrary choice.

## Decision 4 — Undo is an inverse patch, not a model copy

Retaining M0 per history step costs the model's own size — ~100 MiB for a
100 MiB import, before any depth. Conservative repair only removes faces and
reorders corners within a face, so the exact inverse is small: the removed
triangles' coordinates, their source indices, the flipped face indices, and the
source group table.

`restoreFromInverse` reproduces the source with byte-identical coordinates,
original face order and original groups, and a test asserts exactly that
against the real source rather than against a summary.

No history stack is built yet. The patch exists so that one can be, and its
size is measured rather than assumed.

## What this ADR does NOT decide

- Tolerance welding, hole filling, non-manifold reconstruction and
  self-intersection repair remain out of scope. There is no epsilon anywhere in
  this API, by design.
- Reversed duplicates are reported and never removed: they may encode a
  zero-thickness feature.
- Self-intersection remains `not-checked`, and no code path may claim otherwise.
- Repair acceptance is **not** printability acceptance.

## Consequences

The cost is one extra compaction and one extra connectivity build, because
winding is solved on the post-removal topology rather than on the source with
adjustments. That was not an optimisation choice: solving on the source made
the operation non-idempotent, because a duplicate's non-manifold _vertices_
blocked a repair the same pipeline had already made safe. The idempotence test
caught it. Incremental adjustment of three interacting analyses would have been
faster and would have been the kind of cleverness that produces plausible,
wrong answers.
