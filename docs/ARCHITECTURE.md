# CAD Fixer Architecture

Status: Stage 2 (STL import, viewing, export, and read-only topology
diagnostics). This document describes the
architecture as built, plus the intended shape of layers that do not exist yet.
Where a layer is not implemented, its responsibilities are defined so that later
work has somewhere to go, and it is labelled as such.

## 1. Governing constraints

Four constraints shape every decision below.

1. **Local-first.** Raw user geometry stays on the user's machine. There is no
   server-side geometry processing and no upload path.
2. **Off the UI thread.** Parsing, validation, repair, booleans, subdivision,
   displacement, hollowing, and export all run in workers. The interface stays
   responsive while they run.
3. **Validation defines success.** A geometry operation is not successful
   because it returned a mesh. It is successful once its output passes
   validation.
4. **No silent modification.** An operation that may materially change a user's
   model states what it will do, warns, supports cancellation where feasible,
   preserves an undoable prior state, and validates its result.

## 2. Layers

```
                          ┌──────────────────────────────┐
                          │  Browser UI (React)          │  apps/web/src/components
                          │  presentation only           │  apps/web/src/viewport
                          └──────────────┬───────────────┘
                                         │ reads snapshots, dispatches intents
                          ┌──────────────▼───────────────┐
                          │  Application/workspace state │  apps/web/src/state
                          │  framework-free store        │
                          └──────────────┬───────────────┘
                                         │ operation requests
                          ┌──────────────▼───────────────┐
                          │  Worker coordinator          │  packages/geometry-runtime
                          │  correlation, progress,      │  apps/web/src/runtime
                          │  cancellation, errors        │
                          └──────────────┬───────────────┘
                                         │ structured-clone protocol + transfers
      ┌──────────────────────────────────▼──────────────────────────────────┐
      │                        Geometry worker thread                        │
      │  ┌────────────────────────┐      ┌──────────────────────────────┐    │
      │  │ STL codec + seams      │      │ Read-only topology analysis  │    │
      │  │ packages/file-formats  │      │ packages/mesh-topology       │    │
      │  └───────────┬────────────┘      └──────────────┬───────────────┘    │
      │              │                                  │                    │
      │  ┌───────────▼──────────────────────────────────▼───────────────┐    │
      │  │ Canonical mesh + structural validation                       │    │
      │  │ packages/mesh-core                                           │    │
      │  └───────────────────────────┬──────────────────────────────────┘    │
      │                              │                                       │
      │  ┌───────────────────────────▼──────────────────────────────────┐    │
      │  │ WASM/native geometry kernels (none selected yet)              │    │
      │  └──────────────────────────────────────────────────────────────┘    │
      └──────────────────────────────────────────────────────────────────────┘
```

### The rule that matters most

**The React/UI layer must not own geometry algorithms.** Components render
state and dispatch intents. They do not parse files, transform meshes, or decide
what a valid mesh is. A component that needs a geometry result asks the
coordinator and waits.

This is enforced three ways: package boundaries, an ESLint `no-restricted-imports`
rule preventing `packages/**` from importing React or Three.js, and a Vitest
project that runs the geometry packages under Node with no DOM at all — a
browser dependency creeping in breaks the test run.

## 3. Module responsibilities

| Module                      | Owns                                                         | Must not                                    |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `apps/web/src/components`   | Presentation, layout, accessibility, user intent             | Geometry, parsing, validation rules         |
| `apps/web/src/viewport`     | Three.js scene, renderer lifecycle, GPU resource disposal    | Mesh semantics; it renders what it is given |
| `apps/web/src/state`        | Workspace snapshot, status log, selection, future undo stack | React APIs, except in `use-*.ts` bindings   |
| `apps/web/src/runtime`      | The only `Worker` construction site; transport adapter       | Protocol logic, geometry                    |
| `apps/web/src/workers`      | Worker entry point; wires handlers to the host               | Business logic beyond registration          |
| `packages/geometry-runtime` | Protocol, coordinator, worker host, cancellation, transfers  | DOM, React, Three.js, geometry algorithms   |
| `packages/mesh-core`        | Canonical mesh contract, structural validation               | File formats, rendering, algorithms         |
| `packages/mesh-topology`    | Read-only topology recovery, diagnostics, area/volume        | Mutating geometry, welding, UI, rendering   |
| `packages/file-formats`     | Format descriptors, screening, budgets, the STL codec        | UI, rendering, worker protocol              |
| `packages/shared`           | Typed errors, units, ids, cancellation primitive             | Everything domain-specific                  |

Dependency direction is strictly one way:

```
shared ← mesh-core ← file-formats
shared ← mesh-core ← mesh-topology ← geometry-runtime
all of the above ← apps/web
```

Nothing in `packages/` may import from `apps/`.

One nuance on `apps/web/src/state`: the store itself is framework-free and
tested without React, but the `use-*.ts` files in that directory are React
bindings and do import hooks. `use-model-import.ts` currently also holds real
sequencing rules — supersede-an-in-flight-import, and "a failed import must not
disturb the loaded model" — which means those rules can only be exercised
through React today. That is a known wrinkle, recorded rather than hidden; the
rules themselves are covered end to end.

`geometry-runtime` gained its `mesh-core` dependency in Stage 1: the operation
map is a compile-time contract, and geometry operations genuinely speak
`CanonicalMesh`. Stage 2 added a **type-only** `mesh-topology` dependency for
the same reason — `model/analyze` returns a `TopologyReport`, and describing it
as `unknown` would put an unchecked contract on a module boundary that two
threads have to agree about. Type-only, so no topology code enters the
main-thread bundle. It deliberately does **not** depend on `file-formats` —
codecs stay behind the worker's operation handlers, so the protocol never knows
which formats exist.

## 4. File ingestion

The production import path, as implemented for STL:

1. **Drop or picker** (`ImportDropZone`) — reads `name` and `size` only. The
   component never touches file contents.
2. **Screening** (`file-formats/screening`) — filename extension and declared
   size. A usability filter, **not** a security boundary. Passing screening
   confers no trust.
3. **Read into a buffer** (`runtime/import-service`) — the ONLY place in the
   application that calls `File.arrayBuffer()`. Centralised so the number of
   live copies of a 500 MB model is answerable by reading one file.
4. **Transfer to the worker** — the buffer is moved, not copied. The main
   thread's view is detached the moment `dispatch` returns.
5. **Detect** (`file-formats/stl/detect`) — structural, never from the
   extension, the MIME type, or a leading `solid`. See
   [ADR 0007](adr/0007-stl-preservation-policy.md).
6. **Parse** (`file-formats/stl`) — in the worker. Treats bytes as hostile:
   declared counts checked against real buffer length, every allocation
   preflighted against `ImportBudget`, no unchecked offset dereferenced,
   non-finite coordinates rejected.
7. **Validate** (`mesh-core/validation`) — structural invariants. **This is the
   gate**: the import succeeds only if `assertMeshStructure` passes.
8. **Derive display data** — bounds and render normals, computed in the worker
   so the main thread never walks the mesh.
9. **Wrap as a document** — the mesh becomes a one-part `GeometryDocument` at
   the identity placement, with whatever unit the source stated (for STL: none).
10. **Validate the document** (`mesh-core/document-validation`) — the second
    gate: unique part ids, finite placements, a recognised unit, and the
    document-wide resource ceilings. Meshes are not re-walked; step 7 already
    cleared them.
11. **Commit as resident** — the document is committed to the worker's
    `ResidentDocumentStore` and STAYS THERE. Only a `DocumentHandle`, scalar
    part descriptors and render snapshots cross back to the main thread.

### Geometry ownership

**The worker owns authoritative geometry. The main thread owns pixels.**

|             | Holds                                                                                 | Why                                           |
| ----------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| Worker      | `GeometryDocument` — parts, each a `CanonicalMesh` plus a placement                   | Every operation that reads geometry runs here |
| Main thread | `DocumentHandle`, part descriptors (ids, names, transforms, counts), render snapshots | The GPU needs vertex data; nothing else does  |

Stage 1 did the opposite: it transferred the canonical mesh to the main thread,
so export had to structured-clone roughly 96 MiB back into the worker for a
two-million-triangle model, and diagnostics, repair and booleans would each have
paid the same toll. See
[ADR 0008](adr/0008-worker-resident-geometry.md).

A handle carries an id AND a revision. Operations name the revision they expect,
so an operation queued against a model that has since been replaced fails loudly
instead of silently applying to different geometry.

**Since Stage 4A-2A the authoritative unit is a DOCUMENT holding one or more
parts, with ONE monotonic revision for the whole document.** An STL still
describes one thing, so an STL import produces a one-part document and every
existing workflow behaves as it did. What changed is that operations which read
or write one mesh — analysis, self-intersection, repair, export — now name a
`partId` explicitly as well as the handle, because two parts of one document
carry identical handles and a handle alone can no longer say which mesh a result
is about. Two parts may share one `CanonicalMesh` object; that sharing survives
commit, undo, the render snapshot and the GPU upload. See
[ADR 0014](adr/0014-multi-part-geometry-document-foundation.md).

Import is **transactional**: the candidate is parsed, validated and prepared
before anything is committed, so a parse failure, a validation failure, a budget
rejection or a cancellation leaves the previously resident model exactly as it
was.

Only STL is implemented. OBJ and 3MF have descriptors but no codec; the
interface says so rather than starting an import that cannot finish. Capability
is declared in `file-formats/capabilities` rather than read from the registry,
because the registry is populated inside the worker and is legitimately empty on
the main thread — a test asserts the declaration matches what actually registers.

### Cancellation requires yielding

A worker handler that runs one long synchronous loop can never be cancelled. The
cancel arrives as a message, and that message cannot be read until the handler
returns to the event loop, so a cancellation flag polled inside the loop can
never change. Codecs therefore `await context.yieldToEventLoop()` between
batches. The worker supplies a `MessageChannel`-based yield, which is not
subject to the ~4 ms clamp browsers apply to nested `setTimeout`.

This was a real defect found by an end-to-end test, not a theoretical concern.

## 5. Normalized mesh representation

`CanonicalMesh` is an indexed triangle mesh with optional normals, UVs, and
groups, plus metadata naming the source format. Every reader produces it and
every writer consumes it, so conversion paths grow linearly with format count
rather than quadratically.

**A mesh carries neither a unit nor a transform.** Both were removed in Stage
4A-2A so each has exactly one authority: unit belongs to the DOCUMENT — a file
states one unit for everything it contains, and two parts cannot honestly
disagree — and placement belongs to the PART, so a shared mesh cannot be placed
two contradictory ways at once. `undefined` unit means unknown and is never
defaulted to millimetres.

It is deliberately not a BREP/CAD kernel representation. See
[ADR 0004](adr/0004-canonical-mesh-model.md), including the unresolved Float32
vs Float64 question.

## 6. Geometry operations

Every geometry operation must:

1. run in a worker;
2. declare what it will modify before running;
3. report progress and honour cancellation;
4. leave the input mesh unmutated, so the previous state remains undoable;
5. validate its output with `assertMeshStructure` before the result is accepted.

Point 5 is the mechanism behind constraint 3. An operation that returns a mesh
which fails validation has failed, and must surface `GEOMETRY_VALIDATION_FAILED`
rather than hand the user a broken model.

**Conservative repair is the first operation to implement all five**, and it is
the reference for the ones that follow. Point 4 in particular is not a
suggestion there: the authoritative mesh is never written at all. A candidate is
built separately, validated independently, and `repair/commit` swaps one
reference. See section 6b.

## 6b. Conservative repair

The first workflow that CHANGES a user's model, and therefore the first place
where every rule above has to hold at once.

**Five operations, not one.** `repair/plan`, `repair/create-candidate`,
`repair/commit`, `repair/discard`, `repair/undo`. Planning must be observable
without allocating anything; applying must be a separate, explicitly confirmed
act; undoing must be its own transaction rather than a view the UI can fake. A
single `repair/apply` would make preview impossible and would make an accidental
resend destructive.

**`model/analyze` is untouched.** Analysis stays read-only. A repair verb hidden
inside it would make every diagnosis a potential mutation.

**The transaction lives in the worker.** The application sends identifiers; the
worker re-checks revision currency, candidate state, validation acceptance, plan
identity and single use before it swaps anything. React can waste work or show a
wrong label; it cannot apply a repair the runtime refused.

**Preview does not swap authority.** The viewport holds two render snapshots and
toggles visibility between them, sharing one display transform and one camera. No
handle changes, so a preview cannot be exported, cannot be analysed, and cannot
survive the model being replaced.

**Undo is a forward transaction.** It restores geometry in the worker from an
inverse patch and commits it as a NEW, higher revision — revision numbers only
ever move forwards, because every staleness guard in the runtime depends on that.
See [ADR 0011](adr/0011-repair-undo-revisions.md).

Details, including why the repair contract's constants are RESTATED in
`geometry-runtime` rather than re-exported, are in
[docs/repair/REPAIR_ARCHITECTURE.md](repair/REPAIR_ARCHITECTURE.md).

## 6a. Topology diagnostics

Analysis follows the same shape as import and export, and for the same reason:
presentation components must not sequence worker operations.

```
MeshHealthPanel  (presentation only — renders a report)
      |
useTopologyAnalysis  (React binding: starts, cancels, routes to the store)
      |
runtime/analysis-service  (framework-free: dispatch, phase translation,
      |                    handle verification, cancel-after-result guard)
      |
GeometryClient.analyzeModel
      |
model/analyze  ->  worker  ->  ResidentDocumentStore.resolvePart  ->  mesh-topology
```

**Analysis starts automatically after a successful import**, because topology
defects are the reason a user opens this tool and a button between them and the
answer serves nobody. It is nonetheless _decoupled_ from import: analysis that is
refused for want of memory, cancelled, or failed leaves the imported model fully
loaded, renderable, and exportable. Diagnostics are additional information about
a model, not a precondition for having one.

### A report can only ever be shown beside the geometry it describes

Three independent gates, because this is the failure that would look completely
plausible on screen:

1. **The service** compares the handle AND THE PART the worker echoes against
   what it requested, and refuses a mismatch.
2. **The store** refuses a report whose token is superseded, _or_ whose handle
   does not match the currently loaded model, _or_ whose part is not the active
   one — any check alone would leave a path open.
3. **The viewport** compares the revision and the active part again before
   installing overlays, so the layer that would actually draw the wrong lines
   verifies rather than trusts its callers.

The part is not redundant with the handle. Two parts of one document live at the
same revision, so a report for part A and a report for part B carry **identical
handles** — only the part distinguishes them, and without it a report that
finished after the user switched parts would install itself against geometry
nobody analysed.

Importing a new model clears the previous report and detail outright rather than
flagging them stale: a report kept "just in case" is a report some later code
path can render.

### Exact counts, bounded samples

The report carries **exact** counts for every category and **bounded** samples for
visualisation. A mesh with two million boundary edges reports two million and
ships at most `sampleLimit` of them, with a flag saying so — and the interface
says "showing N of M" rather than implying the sample is the whole.

The DOM has its own separate ceilings on rendered component and boundary rows, so
a hostile model cannot turn an exact count into a million React children.

## 7. Web Workers

The protocol lives in `packages/geometry-runtime`:

- **Correlation** — every message carries an `OperationId`.
- **Progress** — `progress` messages with a 0..1 fraction and optional note.
- **Cancellation** — a `cancel` message; handlers poll a `CancellationToken`.
  Cancellation is cooperative, so a handler that never polls cannot be stopped.
- **Errors** — `SerializedAppError`, reconstructed into a typed `AppError` on
  the receiving side.
- **Termination guarantee** — the host emits exactly one terminal message per
  operation, including when a handler throws.

The coordinator is written against a `MessageEndpoint` interface rather than
`Worker`, which keeps it DOM-free and testable, and leaves room for a worker
pool or `SharedWorker` later without protocol changes.

### Transferable ownership

Buffers listed in a transfer are **moved**, not copied. Once transferred they
are detached in the sending realm and reading them throws.

- The sender must drop its reference immediately after dispatch.
- A handler that returns a buffer it received must return it in its own
  transfer list, or the caller gets nothing back.
- `meshTransferables()` de-duplicates buffers, because attribute arrays may be
  views over one buffer and a duplicate entry throws `DataCloneError`.
- `SharedArrayBuffer` must never appear in a transfer list. `toTransferables`
  rejects it explicitly.

## 8. WebAssembly boundary

No WASM module is present, and Stage 0 adds no geometry kernel.

When one arrives it sits **below** `mesh-core`, behind an interface that speaks
canonical mesh buffers. The UI, the state layer, and the coordinator must not
know which kernel is in use. Requirements already established for it:

- It loads inside the worker, never on the main thread.
- Its memory budget is explicit, and exceeding it raises
  `RESOURCE_LIMIT_EXCEEDED` rather than crashing the tab.
- Its output passes `mesh-core` validation before being accepted, regardless of
  what the kernel reports about itself.
- If it uses pthreads, it needs `SharedArrayBuffer`, which needs cross-origin
  isolation — see [DEPLOYMENT_REQUIREMENTS.md](DEPLOYMENT_REQUIREMENTS.md).
- Its licence must be compatible with a proprietary commercial product, and the
  analysis is per-kernel rather than a blanket rule. Licences in this space range
  from permissive through LGPL-with-exception to GPL, and CGAL's varies **per
  package** within one library. See
  [Geometry kernel licensing](DEPENDENCIES.md#geometry-kernel-licensing) for what
  upstream actually says about CGAL and OCCT.

## 9. Serialization and export

Writers implement `MeshWriter` and run in a worker. Export produces a `Blob`
saved through the browser's own download or File System Access path. No export
path may transmit data.

## 10. Persistence

Nothing is persisted in Stage 0. When persistence arrives it will be local
(IndexedDB or Origin Private File System), and it will be explicit: session
recovery is a feature the user can see and clear, not an invisible cache of
their models.

## 11. Telemetry

None exists, and none is permitted to carry geometry, filenames, or file
contents. See [PRIVACY_ARCHITECTURE.md](PRIVACY_ARCHITECTURE.md). ESLint bans
the browser's network APIs outright, so adding telemetry is a deliberate,
reviewable act rather than an accident.

## 12. What is deliberately not implemented

STL is implemented, read and written. Nothing else is:

No OBJ or 3MF codec, no format conversion, no welding, no booleans, no
connectors, no splitting, no displacement, no hollowing, no drainage holes, no
self-intersection detection, no wall-thickness analysis, no auth, no billing, no
database, no backend, no analytics, no persistence — and no stub that pretends to
be any of them.

Repair is implemented only in its **conservative** form: exact duplicate removal,
safe degenerate removal, and relative winding unification. It does not weld,
does not close openings, does not rewrite non-manifold topology, and does not
decide which side of a surface is outside. Everything it cannot decide from the
stored coordinates alone is refused with a stated reason rather than guessed. See
[docs/repair/REPAIR_POLICY.md](repair/REPAIR_POLICY.md).

Two distinctions the interface is careful about, because both are easy to
overstate:

- **STL in, STL out is re-export, not conversion.** The Convert workflow stays
  disabled until a second codec exists.
- **Structurally valid is not printable.** Validation checks buffer and index
  integrity. It says nothing about whether a model is watertight, manifold, or
  manufacturable.
- **An accepted repair is not a printable model.** Repair acceptance means the
  requested defects improved and nothing else regressed, judged by CAD Fixer's
  own re-analysis. Self-intersections and wall thickness remain unchecked, and
  every repair verdict says so beside itself.
