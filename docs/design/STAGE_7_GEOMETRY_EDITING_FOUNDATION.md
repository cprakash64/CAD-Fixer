# Stage 7A geometry editing foundation

## Scope and ownership

Split/connectors and surface texture need one edit path that preserves the resident document until an inspected candidate is applied. The canonical `GeometryDocument` remains in the geometry worker. The page receives part descriptors, a candidate handle, scalar validation results, and disposable render snapshots. `geometry/edit` does not expose the canonical mesh to the page. Split and Texture controls remain unimplemented.

Existing repair and hole fill keep their current transaction flows. Their successful commits, and undo, release any generic edit candidate for the same document. Generic edit commits release repair and hole-fill candidates. The common authority remains `ResidentDocumentStore.replace`, whose exact revision check is the atomic swap.

## Existing call graph

`GeometryClient` sends import/repair/hole-fill requests through `OperationCoordinator` to `geometry.worker`. The worker owns `ResidentDocumentStore`, `RepairCandidateStore`, `HoleFillCandidateStore`, and `RepairHistoryStore`. Repair and hole fill validate and construct all fallible render and reply data, call `ResidentDocumentStore.replace`, then record a one-step inverse. `WorkspaceStore` installs only replies whose parent revision matches its current model. `geometry.worker` releases resident documents and candidate/history state on model release. The generic edit path uses the same ownership, render builder, replacement, and history store.

## Selection, picking, and frames

The workspace has one active part ID. Viewport picking raycasts disposable render meshes and returns stable part ID, triangle index, world point, and world normal. Click selection uses that part ID; import/document replacement resets selection through the workspace store. It does not require canonical geometry on the page.

`SurfaceRegion` stores a seed triangle and bounded connected triangle IDs. Growth follows exact stored-coordinate edge identity, with an explicit normal-angle limit, triangle budget, and cancellation token. The Float64 local frame has origin, right-handed U/V axes, and a normal. Frame transforms respect the 3MF row-vector part transform. Planarity reports maximum point-to-plane and angular deviation and distinguishes planar, near-planar, and non-planar. A disposable plane overlay can visualize, move along its normal, and rotate the edit plane; no unfinished control is shown in the production UI.

An `EditPlane` has origin and normal. Classification takes an explicit distance tolerance. This operation-local tolerance is separate from topology identity: topology and region adjacency use exact stored coordinates and no hidden welding.

## Candidate lifecycle

`GeometryEditStore.begin` captures document ID, revision, part ID, operation name, and generation. Starting B invalidates A before either result resolves. `resolve` validates the resulting part mesh, checks the same generation and revision again, and retains at most one candidate per document. The page gets an opaque candidate ID and accounting. Preview builds a disposable render snapshot while the authoritative document remains untouched. Cancel deletes the candidate. Apply checks source document, revision and part, repeats the shared validation gate, builds render and all fallible reply fields, then swaps authority. Failure before the swap leaves the document unchanged. The existing one-step `RepairHistoryStore` records the previous part mesh; undo restores it with no redo. A test-only worker translation proves preview, apply, cancel, stale refusal, and undo without shipping a production edit command.

Editing happens in part-local coordinates and keeps the part transform. `withPartMesh` replaces only the chosen part; another placement that shared the original mesh retains that original object. Part name, unit, document metadata, and other parts remain. Exports use the current 3MF/STL/OBJ writers; the test edit round-trips all three.

## Validation and resources

The common post-edit gate checks canonical storage, finite coordinates and indices, per-candidate triangle/vertex/byte ceilings, projected render bytes, estimated peak bytes, bounded topology workspace, topology degeneracy, and document-wide limits before accepting a candidate. It runs topology analysis with cancellation polling. A feature can impose stronger invariants. Error messages for deterministic limits include metric, observed value, and limit. The estimate counts resident source, candidate, expanded render, and validation workspace; it is an admission estimate rather than measured RSS. Candidate and preview lifetimes are explicit. The latest preview replaces earlier preview state in the viewport.

The Stage 3B `SharedCancellationSource` and `CancellationToken` remain the edit operation cancellation mechanism. Region traversal and topology validation poll the shared word. Manifold cannot poll it while inside its synchronous WASM call, which originally blocked Stage 7A qualification. `BooleanOperationController` now starts one disposable module worker per call. The authoritative geometry worker awaits it asynchronously, remains able to receive cancellation, and terminates the child. Cancellation, supersession, document release, success, refusal, and crashes all settle the promise and terminate the worker. A canonical cancellation stays `OPERATION_CANCELLED`; an independent child crash becomes `INTERNAL_ERROR`.

The parent copies each input's Float32 positions and Uint32 indices into operation-owned arrays and transfers those copies. Canonical resident buffers are never detached and geometry never passes through the page. Admission accounts for the exact canonical copies, worst-case exact-coordinate Float64 reindexing, and the corresponding WASM input copies. Those known buffers are capped at 768 MiB, input copies at 256 MiB, and total input triangles at two million. Manifold's internal scratch is opaque and is not mislabeled as process memory; the Boolean triangle ceiling is the conservative bound for it. Output remains subject to the five-million-triangle, canonical, render, topology, and document gates.

## Boolean seam

The repository had an experimental, pinned Manifold WASM artifact from upstream commit `11235e6b8ebea2dbed8aec4285685aafd3d95667` under Apache-2.0. Stage 7A copies that artifact and license into the worker source and exposes one CAD Fixer adapter for union, difference, and intersection. The adapter requires finite, structurally valid, closed, edge- and vertex-manifold, consistently oriented inputs without degenerate or duplicate faces. It does not repair arbitrary triangle soup. Exact stored-coordinate indexing converts STL-style soup to the indexed input required by Manifold. The result passes the same resource/storage gate plus topology eligibility. Input size and output counts are bounded. The child reports internal `WORKER_READY`, `WASM_READY`, `MANIFOLD_ENTER`, and `MANIFOLD_RETURN` phases. These are qualification instrumentation, not telemetry. Chromium qualification cancelled three calls after `MANIFOLD_ENTER` and before return with 3–4 ms tails, after which a fresh worker completed successfully. Generated worker and WASM assets are bundled and loaded from the application origin. Direct Manifold calls belong only in this backend.

The durable invariant is: **a non-cooperative synchronous geometry kernel executes in a disposable, terminable worker.** A persistent pool is not used because termination must abandon all in-flight WASM state.

## Picking qualification

Picking is qualified for overlapping and repeated parts, both face orientations, transformed parts, a camera rotated around multiple axes, near and far camera/FOV states, and points immediately to each side of a shared edge. World hit points and transformed normals are asserted. An exact shared-edge hit follows the raycaster's stable first-face order; no screen-space snapping is introduced.

## Future consumers

Stage 7B can use active-part picking, editable plane, disposable cancellable Boolean execution, worker candidate lifecycle, validation, and undo to build two capped pieces and connector solids. It still needs the actual cut/cap/connectors operation and a representation for replacing one part with two. Stage 7C can use surface selection, local frame, planarity, the candidate lifecycle, and the Boolean seam for emboss/deboss; it still needs procedural pattern generation and feature UI. Later text/logo, threads, snap fits, and drainage holes may use these primitives without expanding this foundation into a generic CAD kernel.
