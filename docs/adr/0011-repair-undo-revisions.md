# ADR 0011 — Undo produces a new revision, and there is exactly one step of it

**Status:** Accepted (Stage 3B-1B)
**Supersedes:** nothing
**Related:** [ADR 0008](0008-worker-resident-geometry.md),
[ADR 0010](0010-repair-transactions-and-revisions.md)

## Context

Stage 3B-1A made conservative repair transactional: a candidate is built and
validated separately, and `repair/commit` swaps one reference after every guard
passes. It also built an **inverse patch** for every accepted repair — the
removed triangles' coordinates plus two index lists — and proved by test that
applying it to the candidate reproduces the source mesh with byte-identical
coordinates, the original face order, the original group ranges and the original
metadata.

What it did not do is give that patch anywhere to live, or decide what "undo"
means to the revision system. Stage 3B-1B has to, because undo is the first
user-facing action that reverses a committed change to the user's geometry.

Three questions had to be answered together.

### 1. Where does the pre-repair geometry live?

The obvious shortcut is to keep the previous render snapshot in React and swap it
back. It is wrong for a reason that has nothing to do with taste: **a render
snapshot is not geometry.** It is non-indexed float32 display data with derived
normals, no groups, no metadata and no index buffer. Restoring it would give the
user a model that looks right and exports wrong.

The second shortcut is to keep the previous `CanonicalMesh` in React. That makes
the UI a second owner of the user's data, which ADR 0008 exists to prevent, and
costs the model's full size per undo step on the main thread.

### 2. Does undo move the revision backwards?

`ResidentModelStore` guarantees one thing above all: **a revision only ever moves
forwards.** Every stale-operation guard in the runtime — analysis, export,
repair planning, candidate commit — is built on comparing a revision number and
refusing a mismatch.

Reactivating revision N after N+1 has existed breaks that. Two different meshes
would have worn the number N in one session, so "is this handle stale?" becomes
unanswerable: an export queued against the first N would be accepted against the
second. That is precisely the aliasing the revision system exists to catch, and
it would be reintroduced by the feature meant to make repair safe to try.

### 3. How deep is the history?

An inverse patch is proportional to what its repair removed, not to a fixed cost.
A repair that removes half a large mesh produces a large patch. Retaining one per
step, for the lifetime of a session, is an unbounded memory commitment made on
the user's behalf without their knowledge.

## Decision

**Undo restores geometry in the worker and commits it as a NEW, higher
revision.** It is a forward transaction whose effect happens to be the inverse of
an earlier one.

- The inverse patch is retained in the **worker**, in `RepairHistoryStore`, beside
  the resident models it describes. The main thread holds a record id and a
  boolean.
- `repair/undo` names the record AND the revision the caller believes is
  authoritative, exactly as `repair/commit` does. Both are re-checked in the
  worker.
- The worker rebuilds the previous mesh with `restoreFromInverse`, runs
  `assertMeshStructure` on it, checks its triangle count against the patch, and
  only then calls `ResidentModelStore.replace` — which produces revision N+2.
- **Exactly one repair per model is undoable: the most recent.** A second repair
  supersedes the first and releases its patch immediately. Older repairs survive
  as descriptors — what was applied, between which revisions — with no geometry
  attached.

So a session reads: M0 (revision 1) → repair → M1 (revision 2) → undo → M2
(revision 3), where M2's geometry equals M0's.

## Consequences

**Good.**

- Revision identity stays monotonic, so every existing staleness guard keeps
  working unchanged. A handle for M1 fails after an undo for the same reason it
  fails after any other replacement, and the user gets the same message.
- Undo is validated like any other geometry operation. Rule 11 applies to it: the
  restored mesh passes `assertMeshStructure` before it becomes authoritative.
  "The patch promised it would be identical" is not a check.
- Retained memory is bounded and proportional: one patch per model, released as
  soon as it can no longer be used.
- The restored revision is analysed automatically, exactly as a repaired one is,
  so Mesh Health always describes the geometry on screen.

**Costs, accepted.**

- **The revision number does not tell a user "you are back where you started."**
  Three revisions exist where a naive reading expects two. This is invisible in
  the interface, which talks about the model rather than about revisions, but it
  is real in the protocol and in the logs.
- **Undo is one step, not a stack.** Repairing twice and then undoing twice is not
  possible; the second undo is refused with "a later repair replaced that one".
  This is a deliberate limitation of this stage rather than an oversight, and the
  interface hides the Undo control rather than offering one that fails.
- **The restored mesh is a new set of buffers.** Object identity is not preserved
  and nothing depends on it; positions are compared by value, which for a float32
  canonical store is the same thing as by bits for every value that round-trips
  through it.

## Redo is not implemented

Undoing retains no forward patch, so redo is not merely absent — it is not
derivable from what is kept. Building it would mean retaining the repaired
geometry as well as the patch, which doubles the commitment for a capability
nobody has asked for yet.

The user's recourse is to run the repair again: conservative repair is
deterministic, so repeating it on the restored model produces the same plan and
the same result. That is stated here so a future stage does not implement redo
"for symmetry" without noticing it is a new memory commitment.

## Alternatives rejected

**Reactivate the retained prior revision.** Rejected in section 2 above: it makes
revision numbers ambiguous within a session, and every guard in the runtime
depends on them not being.

**Keep the pre-repair mesh in React and swap it back.** Rejected: it makes the UI
an owner of authoritative geometry (ADR 0008), and a render snapshot — the only
thing the UI actually holds — is display data, not the user's model.

**A general multi-step history stack.** Rejected for this stage. It is a real
feature with real design questions — how deep, what evicts, what happens when an
import interleaves — and answering them badly would be worse than not answering
them yet. One step is what the current architecture supports without inventing a
memory policy.

**Commit the previous geometry as a full copy rather than a patch.** Rejected:
that is the copy cost the patch exists to avoid, and Stage 3A-1 measured the
difference. `fullCopyBytes` is retained in the engine so the comparison stays
measurable rather than assumed — for a repair that removes most of a mesh, the
patch is genuinely not smaller, and a future stage may want to choose per repair.
