# CAD Fixer Architecture

Status: Stage 0 (engineering foundation). This document describes the intended
architecture. Where a layer does not exist yet, its responsibilities are defined
so that later work has somewhere to go.

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
      │  │ Format interfaces      │      │ Geometry operations          │    │
      │  │ packages/file-formats  │      │ (not implemented)            │    │
      │  └───────────┬────────────┘      └──────────────┬───────────────┘    │
      │              │                                  │                    │
      │  ┌───────────▼──────────────────────────────────▼───────────────┐    │
      │  │ Canonical mesh + structural validation                       │    │
      │  │ packages/mesh-core                                           │    │
      │  └───────────────────────────┬──────────────────────────────────┘    │
      │                              │                                       │
      │  ┌───────────────────────────▼──────────────────────────────────┐    │
      │  │ WASM/native geometry kernels (not selected — Stage 0 adds none)│   │
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
| `apps/web/src/state`        | Workspace snapshot, status log, selection, future undo stack | React-specific APIs (it is framework-free)  |
| `apps/web/src/runtime`      | The only `Worker` construction site; transport adapter       | Protocol logic, geometry                    |
| `apps/web/src/workers`      | Worker entry point; wires handlers to the host               | Business logic beyond registration          |
| `packages/geometry-runtime` | Protocol, coordinator, worker host, cancellation, transfers  | DOM, React, Three.js, geometry algorithms   |
| `packages/mesh-core`        | Canonical mesh contract, structural validation               | File formats, rendering, algorithms         |
| `packages/file-formats`     | Format descriptors, filename screening, reader/writer seams  | Parsers (none exist yet), UI                |
| `packages/shared`           | Typed errors, units, ids, cancellation primitive             | Everything domain-specific                  |

Dependency direction is strictly one way:

```
shared ← mesh-core ← file-formats
shared ← geometry-runtime
all of the above ← apps/web
```

Nothing in `packages/` may import from `apps/`.

## 4. File ingestion

The path a file will take, and where it currently stops:

1. **Drop or picker** (`ImportDropZone`) — reads `name` and `size` only.
2. **Screening** (`file-formats/screening`) — filename extension and declared
   size. A usability filter, **not** a security boundary. Passing screening
   confers no trust.
3. **Read into a buffer** — _not implemented._ Will happen off the UI thread.
4. **Parse** (`file-formats` reader) — _not implemented._ Runs in a worker.
   Must treat bytes as hostile: validate declared counts against real buffer
   length, bound every allocation, dereference no unchecked offset.
5. **Validate** (`mesh-core/validation`) — structural invariants.
6. **Canonical mesh** — handed to the workspace.

Stage 0 stops after step 2 and says so in the interface.

## 5. Normalized mesh representation

`CanonicalMesh` is an indexed triangle mesh with optional normals, UVs, and
groups, plus metadata for unit, transform, and source format. Every reader
produces it and every writer consumes it, so conversion paths grow linearly with
format count rather than quadratically.

It is deliberately not a BREP/CAD kernel representation. See
[ADR 0004](adr/0004-canonical-mesh-model.md), including the unresolved Float32
vs Float64 question.

## 6. Geometry operations

None are implemented. When they are, each must:

1. run in a worker;
2. declare what it will modify before running;
3. report progress and honour cancellation;
4. leave the input mesh unmutated, so the previous state remains undoable;
5. validate its output with `assertMeshStructure` before the result is accepted.

Point 5 is the mechanism behind constraint 3. An operation that returns a mesh
which fails validation has failed, and must surface `GEOMETRY_VALIDATION_FAILED`
rather than hand the user a broken model.

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
- Its licence must be compatible with a proprietary commercial product. Several
  well-known geometry kernels are GPL or AGPL and are therefore not adoptable
  without an explicit decision.

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

## 12. What Stage 0 deliberately does not contain

No STL/OBJ/3MF parser, no repair, no booleans, no conversion, no connectors, no
splitting, no displacement, no hollowing, no drainage holes, no auth, no
billing, no database, no backend, no analytics, and no stub that pretends to be
any of them.
