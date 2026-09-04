# 0014 — The multi-part geometry document, in production

Status: **Accepted and implemented.** Stage 4A-2A.

Date: 2026-09-04

Supersedes nothing. Implements the document layer that ADR 0013 designed and
that Stage 4A-1/R1 qualified under `experiments/format-io/`.

## What changed

The authoritative unit of geometry is no longer one `CanonicalMesh`. It is a
`GeometryDocument`: an ordered list of parts, each with a stable id, a mesh, a
placement, and optionally a name and a material reference.

```
DocumentHandle (documentId, revision)
        ↓
GeometryDocument
        ↓
Part A ── CanonicalMesh X
Part B ── CanonicalMesh Y
Part C ── CanonicalMesh Y      ← the SAME object, not a copy
```

**No format changed.** STL is still the only codec, and an STL still describes
one thing — so an STL import now produces a one-part document at the identity
transform with an unknown unit, and every existing workflow behaves as it did.
This stage is the migration, not the feature.

## The load-bearing decisions

### One revision per document

`ResidentDocumentStore` owns the revision, and there is exactly one per
document. Not one per part.

This was qualified in ADR 0013 and it is what every staleness guard in the
product already depended on. The cost is real and was accepted with its eyes
open: **editing part A invalidates an in-flight result for part B**, because
both are addressed by the same revision. That is the safe direction to err in.
An over-invalidated result is recomputed; an under-invalidated one is applied to
geometry it was not built from.

The revision lives in the STORE, deliberately not as a field on
`GeometryDocument`. A `revision` on the document object would be a second
authority that could disagree with the store's, and "one monotonic revision"
would then be a comment rather than a fact.

### The part is part of the identity

Two parts of one document carry **identical handles**. A handle comparison
therefore cannot answer "is this result about the thing I am showing?", and
every guard that previously compared handles now compares the part as well:

| Guard                                 | Now binds                               |
| ------------------------------------- | --------------------------------------- |
| `TopologyReportCache`                 | documentId + revision + partId          |
| `TopologyReport.partId`               | echoed and verified by the consumer     |
| `RepairCandidateHandle.partId`        | bound at creation, re-checked at commit |
| `CommitRequest.expectedPart`          | stated by the caller, not derived       |
| `RepairHistoryEntry.partId`           | undo restores the part it repaired      |
| `SelfIntersectionReport.partId`       | published against one part              |
| `AnalysisSnapshot` / `RepairSnapshot` | discard a result for a different part   |

`expectedPart` is stated by the caller rather than read off the candidate on
purpose: reading it off the candidate would compare the candidate with itself
and the guard would be vacuous.

### One unit authority, one transform authority

`MeshMetadata` lost both `unit` and `transform`.

- **Unit** is a property of the DOCUMENT. A 3MF file states one unit for
  everything it contains, and two parts of one document cannot honestly
  disagree. It travels on `MeshReadResult.unit` and lands on
  `GeometryDocument.unit`. `undefined` means unknown and is never defaulted.
- **Transform** is a property of the PART PLACEMENT — `PartTransform`, twelve
  Float64 values in row-major 3×4. A mesh has no transform of its own, so a
  shared mesh cannot be placed two contradictory ways at once.

`Matrix4Tuple` and `IDENTITY_MATRIX4` were removed rather than deprecated. Two
names for one concept is the drift this stage exists to prevent.

### Structural sharing, end to end

Two parts may hold the **same `CanonicalMesh` object**. This is not an accident
to defend against — it is how repeated 3MF component placements are represented.

It survives every stage:

- `withPartMesh` carries untouched parts across **by reference**.
- `documentByteLength` counts each mesh **once**, not once per part.
- The render snapshot builds buffers **per distinct mesh**; structured clone
  preserves object identity across `postMessage`, so two parts arrive on the
  main thread still sharing one `Float32Array`.
- `SharedPartGeometry` gives them **one `BufferGeometry` and two object
  transforms**, reference counted so disposal cannot free a buffer another part
  is drawing from.

Measured: a 1,000-placement document holds **1.0 MiB** of geometry where naive
per-part copying would hold **952.5 MiB**, and uploads **2** GPU buffers rather
than 2,000.

### Active part is workspace state

`WorkspaceState.activePartId` names the part every part-targeted action
addresses. Changing it **does not change the document revision**: selecting a
part inspects the same authoritative geometry from a different angle, and
burning a revision for a UI action would invalidate every in-flight result for
nothing.

Switching parts clears the analysis, self-intersection and repair slices rather
than carrying them across. Part A's boundary-edge count beside part B would be a
number next to geometry nothing examined.

Automatic work follows the ACTIVE part only. A hundred-part document must not
launch a hundred topology passes or a hundred WASM kernels because a file was
opened.

## Naming: `DocumentHandle`, not `ModelHandle`

`ModelHandle` was renamed to `DocumentHandle` (and `ModelId` to `DocumentId`,
`ResidentModelStore` to `ResidentDocumentStore`) across 132 call sites.

The alternative — keeping the name and documenting that it now means a document
— was rejected because the ambiguity it creates is exactly the ambiguity this
stage introduces: with parts in the model, a reader has to ask whether a
"model handle" addresses the document or a part. A handle whose name does not
say what it addresses is drift waiting to happen, and the rename is
compiler-verified.

The **protocol operation names did not change** (`model/import`, `model/export`,
`model/analyze`, `model/release`, `model/send-for-diagnostic`). They describe
what the USER does — import a model, export a model — and that is unchanged.
`LoadedModel` in application state keeps its name for the same reason.

## Operation scope, frozen

| Operation                   | Scope                                             |
| --------------------------- | ------------------------------------------------- |
| `runtime/self-test`         | neither; carries no geometry                      |
| `model/import`              | **document-level** — produces a whole document    |
| `model/release`             | **document-level**                                |
| `model/export`              | **part-targeted**                                 |
| `model/analyze`             | **part-targeted**                                 |
| `model/send-for-diagnostic` | **part-targeted**                                 |
| `repair/plan`               | **part-targeted**                                 |
| `repair/create-candidate`   | **part-targeted**                                 |
| `repair/commit`             | **part-targeted**; commits a DOCUMENT revision    |
| `repair/discard`            | candidate-scoped (the candidate names its part)   |
| `repair/undo`               | **document-level** transaction restoring one part |

Every part-targeted request carries its `partId` **explicitly**. The
authoritative worker never infers a target from UI selection state: a request is
executable from its payload alone, or it is refused.

## STL export of a multi-part document

STL holds one object and has no way to say otherwise. Exporting a three-part
document therefore either flattens it — losing the structure the document exists
to preserve — or writes one part.

**It writes one part, names it explicitly, and returns a warning listing what
was left out.** The panel states this before the click, not after it. Whole-
document export waits for Stage 4A-2B's conversion report, which can describe
the loss properly rather than through a note attached to one file.

## Self-intersection stays intra-part

Two independently valid parts that overlap in world space are **not**
self-intersecting, and nothing in CAD Fixer checks whether they do. The
diagnostic copies ONE part's mesh, and the report names the part it describes.
Inter-part overlap is a separate concept with a separate name and no
implementation.

## Resource bounds

`DEFAULT_DOCUMENT_LIMITS` bounds what may become authoritative. A 3MF archive
can legally describe thousands of build items and component expansion multiplies
them, so an unbounded document would let a file decide how much memory the
worker holds.

| Limit                   | Value      | Where it comes from                                     |
| ----------------------- | ---------- | ------------------------------------------------------- |
| `maxParts`              | 4,096      | the ZIP entry cap qualified in ADR 0013                 |
| `maxTotalTriangles`     | 20,000,000 | `DEFAULT_IMPORT_BUDGET`, applied document-wide          |
| `maxTotalVertices`      | 60,000,000 | the same                                                |
| `maxTotalGeometryBytes` | 768 MiB    | the session's `maxResidentBytes`                        |
| `maxNameLength`         | 512        | the 512-byte path cap; names arrive from the same files |
| `maxMaterialRefLength`  | 512        | the same                                                |

These are **MVP values derived from current evidence**, not values frozen by the
Stage 4A research. They are stated here so they can be argued with.

`assertGeometryDocument` is the gate, mirroring `assertMeshStructure`: producing
a document is not success, passing this is. It checks unique part ids, finite
placements, a recognised unit, well-formed meshes and the ceilings above. A
candidate that fails does not partially replace the current document; it does
not replace it at all.

**Structural validity is not mesh health.** A part whose triangles are
degenerate is a valid document describing a defective model, and refusing it
would leave the product unable to load the very files it exists to repair.

## Performance

Single-part, Node, one process, bare mesh versus the same mesh in a one-part
document:

| Size   | Triangles | validate (bare → doc) | bounds         | render         | wrap   | commit |
| ------ | --------- | --------------------- | -------------- | -------------- | ------ | ------ |
| 1 MiB  | 20,808    | 6.3 → 0.2 ms          | 3.7 → 0.6 ms   | 5.0 → 0.7 ms   | 0.0 ms | 0.0 ms |
| 10 MiB | 208,658   | 23.4 → 0.0 ms         | 4.4 → 4.6 ms   | 7.9 → 7.4 ms   | 0.0 ms | 0.0 ms |
| 50 MiB | 1,048,352 | 96.7 → 0.0 ms         | 24.2 → 25.2 ms | 40.0 → 37.4 ms | 0.0 ms | 0.1 ms |

The document validation figure is near zero because meshes are **not re-walked**:
`assertMeshStructure` cleared the mesh moments earlier on the import path, and
walking every coordinate twice is a cost a large model cannot absorb.

Multi-part, one shared mesh placed N times:

| Parts | build  | validate | commit | render snapshot    | bounds | geometry bytes | naive per-part |
| ----- | ------ | -------- | ------ | ------------------ | ------ | -------------- | -------------- |
| 1     | 0.1 ms | 0.2 ms   | 0.0 ms | 5.1 ms (2 buffers) | 7.1 ms | 1.0 MiB        | 1.0 MiB        |
| 10    | 0.0 ms | 0.0 ms   | 0.0 ms | 0.7 ms (2 buffers) | 0.5 ms | 1.0 MiB        | 9.5 MiB        |
| 100   | 0.0 ms | 0.2 ms   | 0.0 ms | 0.6 ms (2 buffers) | 0.7 ms | 1.0 MiB        | 95.3 MiB       |
| 1,000 | 0.2 ms | 0.9 ms   | 0.0 ms | 0.5 ms (2 buffers) | 4.2 ms | 1.0 MiB        | 952.5 MiB      |

Part-count overhead is metadata, not geometry.

**One regression was found by this benchmark and fixed.** `documentBounds` and
`describeParts` originally called `computeBounds` per PART, which walked one
shared mesh a thousand times to produce one answer — 356 ms at 1,000 placements.
Local bounds belong to the MESH; the placement is applied to the box afterwards.
Memoising per distinct mesh took it to 4.2 ms.

Run with `npm run bench:document`. Not part of CI.

## What this does NOT add

No OBJ parser, no 3MF parser, no writers for either, no ZIP or XML path, no
unit-selection dialogue, no conversion report, no format-conversion UI. Those
are Stage 4A-2B. **CAD Fixer still reads and writes STL and nothing else**, and
no interface claims otherwise.

No inter-part overlap detection. No redo. No multi-step undo. No transform
editing, splitting or connectors. No printability claim of any kind.
