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

---

## Stage 4B-1C closure — the patch is replaced by the mesh it described

**Status:** Accepted (Stage 4B-1C). Additive. Everything above about REVISIONS
still holds unchanged; what changes is WHAT IS RETAINED and how the previous
mesh is recovered.

### What went wrong

The inverse patch reproduced the source mesh's coordinates, face order, group
ranges and metadata, and a test proved it — which is why this survived. What no
test asked was whether it reproduced the source mesh's **representation** or its
**identity**, and it reproduced neither.

1. **Identity.** `restoreFromInverse` returns a NEW `CanonicalMesh`. A document
   whose parts shared one mesh came back holding two byte-equal ones,
   permanently: two entries in the resident document, two GPU geometries on the
   page, two `<object>` resources in every 3MF written afterwards. Undo, the
   operation whose entire promise is that nothing happened, made the document
   permanently larger.
2. **Representation.** The rebuild writes nine coordinates per face and an
   identity index buffer. For an STL — soup already — the round trip was exact,
   which is why every STL test in the suite passed. For a genuinely indexed OBJ
   or 3MF it was not: four shared corners returned as twelve, the document grew,
   and the file exported after an undo no longer matched the file imported.

Stage 4B-1B2-R1 had already hit (1) for hole fills and fixed it there by
retaining the mesh. This ADR's own patch decision was the reason the same fix
had not reached conservative repair.

### The decision

**`RepairHistoryStore` retains the pre-repair `CanonicalMesh` itself, and undo
assigns it back.** `UndoableInverse` collapses to one shape — `previousMesh`
plus the counts and byte length recorded when it was retained — for both
undoable kinds. `UndoableChangeKind` survives so the interface can name what was
reversed; it selects no code path.

`packages/mesh-repair/src/inverse.ts` is **deleted**, not left unused:
`buildInversePatch`, `restoreFromInverse`, `RepairInversePatch` and
`fullCopyBytes` are gone, and a production-boundary test asserts the file and
its symbols cannot return. Two undo implementations capable of diverging is how
one of them stops being tested, which is the mechanism that produced this defect.

### Why the "full copy" alternative above was the wrong shape of the right answer

The alternative this ADR rejected was committing the previous geometry as a full
**copy**. That rejection was correct and is not being reversed. What Stage 4B-1C
retains is a **reference** to an immutable mesh that is already resident — no
allocation, no traversal, and **no additional bytes at all** while any other part
still holds it. The rejected alternative's cost was the copy; there is no copy.

`fullCopyBytes` went with the file for the same reason: it existed to keep the
patch-versus-copy comparison measurable, and there is nothing left to compare.

### What it costs, measured

`RepairMemoryEstimate.undoRetainedBytes` now reports the SOURCE MESH's own size
rather than a patch's, so it is an upper bound that tracks the model instead of
the defect density — 1.3 MiB at 1 MiB of input, 66.7 MiB at 50 MiB, at every
defect rate. The bound is loose by design: at a thousand placements of one shared
mesh the browser harness observes the document at 240 bytes before a repair and
240 bytes after the undo, because the retained object is the one 999 other parts
are still drawing from.

Release is unchanged in shape and stricter in effect: one undoable change per
document, and the reference is dropped the moment the record is undone,
superseded, evicted or its document released.

### What validation replaces `assertMeshStructure`

The section above says rule 11 applies to undo and "the patch promised it would
be identical" is not a check. That reasoning was about a mesh an algorithm
**produced**. Undo now produces none — it hands back a mesh that was
authoritative when it was retained and has been immutable since, so re-validating
it would be re-validating the document's own history.

What is checked instead are the two O(1) postconditions a retained object can
still get wrong through a bookkeeping error: the restored mesh's face count and
index count against the counts recorded at retention. A mismatch is
`INTERNAL_FAILURE`, never a silent success.

### What this closure does NOT change

No repair algorithm, no geometry semantics, no operation set, no acceptance rule,
no revision behaviour. `rebuildCandidate` still writes an **unindexed** candidate,
so applying a repair to an indexed mesh still de-indexes it until it is undone.
That is the repair algorithm's own representation choice, it predates this stage,
and it is recorded here rather than corrected silently as part of a transaction
fix.
