# 8. The worker owns authoritative geometry

- Status: Accepted
- Date: 2026-08-15

## Context

Stage 1 parsed an STL in the worker and then **transferred the whole
`CanonicalMesh` to the main thread**, where React state held it. That was a
reasonable first shape — the viewport needs vertex data, and transferring is
free — but it put ownership in the wrong place, and the cost only becomes
visible once a second operation needs the geometry.

Export was the first. Because the main thread owned the mesh, exporting meant
structured-cloning it back into the worker: roughly **96 MiB of copying for a
two-million-triangle model**, on the main thread, every time the user pressed a
button. Measured expansion figures are in `PERFORMANCE_BASELINE.md`.

Topological diagnostics, repair, booleans, splitting and hollowing would each
have paid the same toll, several times per session. The pattern does not scale,
and the fix gets harder the more operations are built on top of it.

There is a second, quieter problem: with the mesh in React state, "who may
mutate this?" has no good answer. A component could in principle write to a
position buffer that the GPU is also reading.

## Decision

**Authoritative geometry lives in the geometry worker and never leaves it.**

- The worker holds a `ResidentModelStore` keyed by `ModelId`.
- The main thread receives a **`ModelHandle`** — `{ modelId, revision }` — and a
  **render snapshot**. It never receives a `CanonicalMesh`.
- Every geometry operation names a model by handle. **Request** payloads
  (main → worker) carry no typed arrays; a protocol-level test asserts this.

### What crosses in each direction

Worth stating exactly, because "no geometry crosses the boundary" is a tempting
shorthand and it is not true:

| Direction     | Carries                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| main → worker | Handles, revisions, configuration. For import only, the raw file bytes. Never a `CanonicalMesh`.         |
| worker → main | Render snapshots, encoded export bytes, and bounded diagnostic samples. All derived; none authoritative. |

Export bytes and topology samples are geometry, deliberately — an export that
returned no geometry would be useless, and a defect overlay needs coordinates to
draw. What never crosses is the **authoritative** canonical mesh. Diagnostic
samples are additionally bounded by a sample limit rather than by mesh size, so
the return payload does not scale with the model.

### Handles, revisions, and sessions

A handle is an identity plus a revision. `resolve` refuses a handle whose
revision does not match the store's, returning the typed error
`MODEL_UNAVAILABLE` — not `INTERNAL_ERROR`, because a replaced model is an
expected condition the interface must be able to explain rather than a defect.

Model ids are never reused within a store, so a long-queued operation cannot
match an unrelated later model. Across worker instances, ids restart from
`model-1`, so `GeometryClient` also carries a monotonic **session id**: a handle
minted by a dead worker can never be mistaken for one from its replacement.

### Render snapshot

The snapshot is a derived, read-only view: interleaved positions plus normals
computed from the geometry, drawn **non-indexed**. STL soup indices are
`0,1,2,3,…` and carry no information, so sending them would cost ~24 MiB per two
million triangles to tell the GPU what it already assumes.

Positions are **copied**, not transferred, because the worker keeps the original.
That copy is the honest price of worker-side ownership and is accounted for in
the memory model.

The distinction is load-bearing: the snapshot is regenerable at any time, whereas
the canonical mesh is the user's data. Only the latter is authoritative.

### Transactional replacement

Import parses, validates and prepares the candidate **before** touching the
store. The commit is the last statement in the handler. A parse failure, a
validation failure, a budget rejection or a cancellation therefore leaves the
previously resident model exactly as it was, with no rollback logic to get
wrong.

The old model is released only after the new one commits, and only by the
application, which knows which handle it replaced.

### Worker loss — policy A

If the worker dies, the authoritative geometry is gone. There is no persistence
and nothing is reconstructed from the render snapshot: **pixels are not
geometry**.

The application therefore **discards the model** and says the session was lost,
rather than leaving a picture on screen that no operation can act on. Export
would fail, diagnostics would fail, and the image would imply a working session
that does not exist. Showing nothing and explaining why is less misleading than
showing something inert.

### Why not `SharedArrayBuffer`

Cross-origin isolation is configured and `SharedArrayBuffer` is available, so
canonical geometry _could_ be shared rather than owned. It is not, for now:

- Shared mutable geometry across threads needs a synchronisation discipline this
  codebase has no reason to design yet, and gets no benefit from until an
  operation actually mutates in place.
- The render snapshot would still need its own GPU-uploadable copy.
- The saving is one copy of positions; the cost is a concurrency model.

Revisit when repair operations mutate large meshes in place and the copy is
measured to matter. Recorded so the option is not silently forgotten.

## Consequences

**Good:**

- Export sends a handle instead of ~96 MiB. Diagnostics, repair and booleans
  inherit that for free.
- Stale operations fail loudly instead of applying to different geometry.
- React state cannot hold, or accidentally mutate, a multi-hundred-megabyte mesh.
- Import is transactional by construction rather than by careful bookkeeping.

**Costs, accepted knowingly:**

- **Peak memory rises.** Worker holds positions + indices; the main thread holds
  a positions copy + normals. For a 100 MiB STL that is roughly 96 MiB resident
  plus 144 MiB of render buffers, against Stage 1's 168 MiB on one side. The
  trade buys back a 96 MiB clone on _every_ export and analysis.
- Worker death is now total loss of the loaded model. Stage 1's main-thread copy
  would have survived it — but only as pixels, since no operation could have run
  on it anyway.
- One more indirection: the UI cannot answer geometry questions locally, so
  anything it wants to display must be computed in the worker and sent. That is
  the intended direction, and it is why import already returns bounds and counts.

**This ADR does not settle:** Float32 vs Float64 canonical storage
([ADR 0004](0004-canonical-mesh-model.md) remains open), nor whether render
snapshots should ever be regenerated on demand rather than held for the model's
lifetime.
