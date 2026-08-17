# Repair architecture

Status: Stage 3A-1 (design). **No repair is implemented and no kernel is
installed.** This describes the pipeline a repair must fit, designed before any
candidate is chosen so the candidate is judged against our requirements.

---

## The pipeline

```
resident model  (worker-owned, authoritative, unchanged throughout)
      │
      ▼
diagnostics                     Stage 2 topology report — the pre-condition oracle
      │
      ▼
repair plan                     which operations, which parameters, which loops
      │
      ▼
candidate clone                 a SEPARATE mesh; the resident model is not touched
      │
      ▼
repair operation                own code, or a kernel adapter
      │
      ▼
structural validation           assertMeshStructure — buffers and indices
      │
      ▼
topology validation             full Stage 2 report on the OUTPUT
      │
      ▼
self-intersection validation    where a detector exists; recorded as not-checked otherwise
      │
      ▼
geometry-preservation checks    deltas and displacement against the input
      │
      ▼
candidate result                accepted / rejected, with every metric attached
      │
      ▼
user preview / acceptance       the user sees what changed before it is real
      │
      ▼
transactional commit            last statement; resident model replaced atomically
      │
      ▼
new model revision              handle revision increments
      │
      ▼
automatic diagnostics           the new revision is analysed like any import
```

### Why a candidate clone

The resident model must survive a failed repair completely intact. This is the
same rule import already follows — the commit is the last statement, so a
failure leaves the previous model exactly as it was — and it matters more here,
because a repair failure is _expected_ for hard inputs. A repair that mutated in
place would mean the user's model is destroyed by the operation that was
supposed to save it.

The cost is a second copy of the mesh during the operation, on top of the
resident mesh and the render snapshot. That is accepted and must be modelled in
the memory budget before repair ships.

### Why validation cannot be skipped

**A repair is not successful because a kernel returned.** Carried forward from
project rule 11, and it is why the adapter interface does not let a candidate
report its own success. A kernel's `valid`, `manifold`, `repaired`, or `success`
flag is **recorded as data** and never substituted for our own checks. Our
Stage 2 topology engine is an independent oracle, and it is independent
precisely because it did not write the mesh it is judging.

---

## Undo ownership

Undo is **not implemented in this stage**, but repair must not be architected in
a way that makes it impossible.

The model:

- A repair commit produces a **new revision**, never an in-place mutation.
- The previous revision's geometry must remain recoverable for as long as the
  history policy requires.
- Because the worker owns geometry, history is a **worker-side** concern:
  the main thread holds handles, and a revert is "make revision N current
  again", not "send the old mesh back".
- The open question, deliberately not decided here: whether history stores full
  meshes per revision, or an operation log replayed from the import, or a bounded
  window of full snapshots. That is a memory-policy decision needing the repair
  memory numbers Stage 3A-2 will produce.

What is decided: **repair is never an irreversible in-place mutation.**

---

## Cancellation

CAD Fixer already guarantees cancellable long operations. Repair must not be the
exception, and this is the hardest architectural problem in the stage.

**The core difficulty.** A long synchronous WASM call cannot observe a cancel
message. The message sits in the worker's queue until the call returns; a flag
polled inside the call can never change. This is the same failure mode already
documented for synchronous worker handlers, one level deeper.

Three possible answers, in preference order:

1. **Cooperative callback.** The kernel invokes a progress/interrupt callback we
   supply, and we return "stop". Cleanest; requires upstream support, which no
   shortlisted candidate was found to document.
2. **Chunked operation.** The operation is decomposed into steps that return to
   the event loop between them. Only possible if the kernel exposes such a
   decomposition; unlikely for intersection resolution.
3. **Disposable secondary worker.** The repair runs in its own worker, which is
   **terminated** on cancel. Always available, and therefore the fallback.

The costs of (3) are real and must be measured in Stage 3A-2, not assumed:

- the mesh must be copied into the secondary worker, and copied back on success;
- terminating discards the WASM heap — which is the point, but means no partial
  result is recoverable;
- a fresh worker plus WASM instantiation is paid per operation unless pooled;
- the resident-model architecture must not change: the secondary worker is a
  **compute** worker that owns nothing authoritative.

`SharedArrayBuffer` deserves evaluation but does not obviously help: sharing the
canonical mesh across owners would make it mutable from two places, which
contradicts single-ownership. Cross-origin isolation is already configured, so
the option remains open for read-only input sharing.

**Do not change the production worker architecture in Stage 3A-2 before those
numbers exist.**

---

## Precision stress suite

Experiments that could finally produce evidence for
[ADR 0004](../adr/0004-canonical-mesh-model.md) (Float32 vs Float64 canonical
storage), which **remains open**.

Stage 2 sharpened the question rather than answering it: exact-coordinate
identity makes storage precision _directly observable_, because two coordinates
that collapse to the same float32 become one vertex, and two that survive as
distinct float64 values stay two. The disagreement rate is the number nobody has
measured.

Stage 3A-2 should measure:

1. **Large coordinate translation.** Same model at the origin and at 10⁶ units
   out. Count vertices, edges, components, and boundary edges in both storage
   precisions. Divergence means float32 is merging distinct points at realistic
   CAD magnitudes.
2. **Tiny gaps and features.** Sub-ULP-of-float32 separations at those
   magnitudes — the R26 fixture is built for this.
3. **Tolerance welding.** Whether the tolerance needed to heal a seam differs
   between precisions, and by how much.
4. **Intersection construction.** Coordinates produced by intersection
   computations are the strongest argument for float64: they are derived values,
   not file values, and derived values compound error.
5. **Boolean-generated coordinates.** Same, one level worse, and directly
   relevant since booleans are a planned workflow.

**Do not close ADR 0004 on argument.** Close it on those measurements, or leave
it open.

---

## Stage 3A-3B — recommended production repair worker architecture

Evidence-based, from browser measurements. **Nothing below is implemented.**

### The recommendation: HYBRID, defaulting to a disposable repair worker

| Operation class                    | Pattern                                                               | Why                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Conservative deterministic cleanup | **Pattern A** — inside the authoritative worker, CAD Fixer's own code | No kernel needed; exact, bounded, interruptible between batches                                         |
| Explicit tolerance seam healing    | **Pattern C** — disposable candidate worker                           | Parameter-dependent and destructive when wrong; must be cancellable and must never touch resident state |
| Local hole fill                    | **Pattern C** — disposable candidate worker                           | A 220-vertex loop measured 48.8 s uninterruptible; termination is the only cancellation                 |
| Solid / boolean                    | **Pattern C** — disposable candidate worker                           | ~25× memory amplification; a dead worker's heap must become unreachable in one step                     |

**Pattern B (a long-lived secondary repair worker) is not recommended**, despite
being cheaper per operation. The measured saving is 6–17 ms; the cost is that a
kernel's memory and any corrupted internal state persist between unrelated
operations. For a 3.5-second, 1.1 GiB boolean that trade is clearly wrong.

### Why disposable is affordable

| Candidate | Persistent per-op | Disposable per-op | Penalty  |
| --------- | ----------------- | ----------------- | -------- |
| manifold  | 3.19 ms           | 10.42 ms          | +7.2 ms  |
| geogram   | 5.20 ms           | 21.61 ms          | +16.4 ms |
| pmp       | 1.74 ms           | 8.21 ms           | +6.5 ms  |

Against operations measured at 100 ms – 49 s, a 6–17 ms setup cost is noise.

### Invariants the implementation must preserve

Each is backed by a Stage 3A-3B measurement, not by assumption:

1. **The authoritative resident model is never handed to a candidate.** The
   candidate gets a structured-clone copy. Verified: digests unchanged and the
   buffer undetached after termination in all three candidates.
2. **Cancellation is worker termination.** Verified: `terminate()` returns in
   under a millisecond, the page stays responsive, and a fresh worker
   re-initialises in 16–87 ms and completes a real operation.
3. **Results carry operation and revision identity.** A terminated or superseded
   worker must not be able to commit. Verified by the `(sessionId, opId)` guard
   and a replacement worker returning its own result.
4. **The kernel result is validated by CAD Fixer before commit**, in a context
   the candidate does not control. Verified: browser output is judged by Stage 2
   analysis in a separate Node process.
5. **Commit is transactional**, and a failed or cancelled repair leaves the
   resident revision untouched.
6. **Size is estimated before the operation starts.** A boolean must refuse
   rather than discover a 2.4 GiB heap requirement by aborting; a hole fill must
   refuse or chunk a long boundary loop rather than begin a 49-second
   uninterruptible call.

### The confidence classes stay separate

Conservative, assisted and reconstructive remain distinct actions with distinct
UI. Nothing may collapse them into one irreversible "fix model" button — the
R19/R21 result is the standing proof that a single global parameter cannot be
correct for every model.

---

## Stage 3B-1A — the conservative repair engine is IMPLEMENTED

**Kernel-free.** No Manifold, Geogram, PMP or WASM artifact enters the
application. These are CAD Fixer's own exact-topology operations, and the
production bundle scan confirms it.

### Implemented

| Operation                        | Semantics                                                   |
| -------------------------------- | ----------------------------------------------------------- |
| `remove-duplicate-faces`         | extra SAME-orientation copies; lowest source index retained |
| `remove-repeated-position-faces` | fewer than three distinct topological vertices              |
| `remove-zero-area-faces`         | three distinct but exactly collinear vertices               |
| `unify-winding`                  | RELATIVE orientation only; seed face keeps its winding      |

### Explicitly NOT implemented

Reversed-duplicate removal, tolerance welding, crack healing, boundary/hole
filling, non-manifold reconstruction, self-intersection repair, boolean
reconstruction, global inside/outside flipping, remeshing, simplification.
**There is no epsilon anywhere in this API.**

### The flow

```
M0 (authoritative, never written)
  -> repair/plan              decisions + memory estimate, no allocation
  -> repair/create-candidate  masks -> candidate -> INDEPENDENT validation
  -> preview                  plan, validation, counts, bounded samples
  -> repair/commit            guarded swap -> M1 (new revision, parent recorded)
  -> repair/discard           releases the candidate; M0 untouched
```

`model/analyze` is untouched and stays read-only. A repair verb hidden inside it
would make every diagnosis a potential mutation.

### Validation decides, not the algorithm

The candidate is re-analysed from scratch by Stage 2 and compared against the
source. Forbidden regressions are absolute — no trade against speed or against a
defect that did get fixed.

Two invariants are **predicted rather than forbidden**, because the obvious rule
is wrong:

- **Boundary edges.** Two coincident triangles pair each other's edges and look
  closed; deleting the redundant copy correctly reveals three boundary edges.
- **Surface area.** Stage 2 sums every face, so a duplicate contributes twice and
  removing it legitimately reduces the total — Stage 3A-1's R03 criterion said
  as much.

The prediction comes from the SOURCE analysis plus the removal mask; the actual
comes from independently re-analysing the rebuilt candidate. A compaction bug or
corrupted index makes the two disagree, which is what the comparison is for.

**Degenerate removal is held to the stricter rule** and is refused outright if it
would open a boundary or create a non-manifold edge. It must be topologically
inert; duplicate removal need not be.

### Self-intersection and printability

Every validation carries `selfIntersectionStatus: 'not-checked'`. There is no
`printable` flag and repair acceptance is not printability acceptance.

See `docs/adr/0010-repair-transactions-and-revisions.md` for the transaction,
revision and seed-rule decisions.

---

## Stage 3B-1B — the conservative repair WORKFLOW is IMPLEMENTED

Stage 3B-1A built the engine and the transaction. Stage 3B-1B exposes them to a
user, and adds the two things a user-facing repair needs that a runtime does not:
a **preview** they can inspect before committing, and an **undo** for after.

### The layers, and where authority lives

```
RepairPanel.tsx            renders decisions; dispatches; owns NO safety question
use-conservative-repair.ts binds the service to the store; owns lifecycle
repair-presentation.ts     decides every sentence; framework-free; tested without a DOM
repair-service.ts          transport; handle verification; cancellation; ceiling
geometry-client.ts         the only main-thread code that knows Worker exists
--- worker boundary ---
repair-handlers.ts         preflight, plan, candidate, commit, discard, undo
RepairCandidateStore       the commit guards
RepairHistoryStore         the undo guards and the inverse patches
ResidentModelStore         the atomic reference swap
```

**React is never the transaction authority.** `Apply` sends three identifiers —
a candidate handle, the revision the UI believes is current, and a plan hash —
and the worker re-checks every guard before it swaps anything: revision currency,
candidate state, validation acceptance, plan identity, single use. A bug in the
panel or the hook can waste work or show a wrong label; it cannot apply a repair
the runtime refused. That separation is asserted by test rather than described.

### Preview: two snapshots, one authority

The viewport holds the authoritative model's render snapshot and, while a
candidate exists, the candidate's. **Both are display data.** No handle is
swapped and no store is written when the user switches views — `setPreview` sets
a `visible` flag.

Three properties follow from that, and all three are the reason it was built this
way rather than by calling `setModel` with the candidate:

- **The camera cannot jump.** Before and After share the model group's transform,
  the orbit target, the zoom and the display offset. Nothing reframes. Comparing
  two views of a model is impossible if switching moves the camera.
- **The switch does not scale with mesh size.** Both meshes are already uploaded;
  measurements are in `docs/PERFORMANCE_BASELINE.md`.
- **Export cannot resolve the candidate.** `RepairCandidateHandle` is a distinct
  type from `ModelHandle`, so the compiler refuses to let a candidate reach an
  operation that takes a model — and the viewport never made it authoritative in
  the first place.

The preview is labelled **"Preview — not applied"** whenever the proposed result
is on screen. The label is text with a `role`, not a colour.

### Change overlays

Built from the engine's bounded change samples, which are **source face indices
for all four categories including flips** — so every overlay indexes the source
render snapshot the main thread already holds. Nothing asks the worker for
geometry again and nothing walks a candidate mesh on the UI thread.

One batched object per category. An `Object3D` per changed face would mean an
object, a draw call and a scene-graph node for every triangle a repair touches.

**Removed faces exist only in the source**, so their overlays are hidden when the
proposed result is shown, and the panel says why rather than leaving a dead
checkbox. **Flipped faces occupy the same coordinates in both views** — a flip
reorders corners and moves no vertex — so they stay visible, with a direction
marker whose sign differs between the views.

The direction marker is derived from the triangle's CORNER ORDER, never from the
file's stored normal. STL normals are advisory, frequently disagree with winding,
and are exactly what this repair refuses to treat as truth (ADR 0010). Both
markers are built up front so switching views costs no upload.

### Undo

One step, restored in the worker, committed as a new monotonic revision. The
inverse patch lives in `RepairHistoryStore` beside the models it describes, and
exactly one repair per model is reversible — a second repair supersedes the first
and releases its patch. The restored mesh passes `assertMeshStructure` before it
becomes authoritative: rule 11 applies to undo as much as to any other geometry
operation, and "the patch promised" is not a check.

The full reasoning, and why the revision does not go backwards, is
[ADR 0011](../adr/0011-repair-undo-revisions.md).

### The report cache

`repair/plan` and `repair/create-candidate` reuse the topology report the
application already computed, keyed by `(modelId, revision)`. Without it the same
unchanged mesh was analysed three times per repair. Safe because geometry at a
revision is immutable, and the revision is compared rather than assumed.

### Cancellation, honestly

The repair pipeline is one synchronous deterministic pass. A worker handler that
never returns to the event loop cannot be cancelled — the cancel arrives as a
message, and a polled flag never changes while the handler runs. So the candidate
handler is `async` and yields at two points: after analysis, and **before the
candidate is registered**.

That second yield is the load-bearing one. A cancel observed there means the
store never learns a candidate existed: no preview, nothing committable, nothing
resident. Yielding after registration would have created a candidate that only a
discard could clean up, and a cancel that leaks memory is not a cancel.

What it does NOT mean: the pass already running is not interrupted mid-array. The
work is discarded, not stopped. This is the same contract topology analysis has
had since Stage 2, and it is stated rather than implied because the difference is
observable on a very large model.

### The engines stay out of the application bundle

`geometry-runtime` **restates** the repair contract's constants rather than
re-exporting them from `@cadfixer/mesh-repair`. A value re-export would make the
engine — and `mesh-topology` behind it — a runtime dependency of everything that
imports the protocol, including the main-thread bundle. A few frozen strings keep
the boundary provable instead of trusting a bundler to shake it back out.

The duplication is guarded twice: by `Exactly<>` at compile time, and by a test
that compares the runtime VALUES key by key. A type made of string literals is
satisfied by a constant whose keys were renamed; the interface would then show
nothing useful for every refusal, forever, without failing a build.
