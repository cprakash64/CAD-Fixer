# 0013 — Multi-format geometry document architecture

Status: **Partially qualified.** Stage 4A-1 research. Nothing here is
implemented in production; Stage 4A-2 is expected to implement the scope in
§"Stage 4A-2 scope" below.

Date: 2026-09-03

## Context

CAD Fixer's authoritative geometry is one `CanonicalMesh` per workspace model,
owned by the geometry worker and addressed by `(modelId, revision)`. That model
has carried STL import/export, exact topology diagnostics, conservative repair,
undo, and bounded self-intersection diagnostics.

The next product goal — OBJ and 3MF support, and conversion between them —
introduces inputs that describe **more than one thing**. This ADR records what
the research established about whether the current model can carry that, and
what the format layer must guarantee.

## What the current model already gets right

The audit found less coupling than expected. `CanonicalMesh` already carries:

- `metadata.unit?: LengthUnit` — **`undefined` means unknown and is never
  defaulted to millimetres.** The unit honesty this stage was asked to design
  already exists.
- `metadata.transform: Matrix4Tuple` — held **beside** the positions, not baked
  into them, "so that an import does not have to bake a transform into vertex
  data, which would lose the original coordinates".
- `groups?: MeshGroup[]` with `indexOffset`/`indexCount`/`materialRef` — an
  existing, unused-by-STL submesh mechanism.
- optional `normals` and `uvs`.

The genuine constraint is **singularity**, in four places:
`ResidentModelStore.commit(mesh: CanonicalMesh)` / `resolve(): CanonicalMesh`,
the workspace's `model: LoadedModel | undefined`, one `RenderSnapshot` per
model, and 11 protocol operations keyed by a single `handle: ModelHandle`.

## Decision: Architecture B, minimally

A **geometry document** becomes authoritative, holding an ordered list of parts.
Architecture A (flatten everything into one buffer with group ranges) is
rejected: it destroys per-item transforms and object identity, which makes
3MF → 3MF re-export structurally lossy for a reason that is our choice rather
than the format's, and it gives future split-with-connectors nothing to attach
to.

**The document keeps ONE monotonic revision.** This is the load-bearing
decision. Every staleness guard in the product — the topology cache keyed by
`(modelId, revision)`, repair candidate binding, self-intersection report
identity, undo — depends on a revision that only moves forwards. Per-part
revisions would multiply that reasoning by the number of parts and buy nothing
the product needs: an edit to any part produces a new document revision, exactly
as an edit to the mesh produces one today.

The document contains **only** what OBJ, 3MF, conversion and future splitting
need: parts, per-part mesh, optional per-part transform, optional name, optional
material reference, and document-level units. No B-rep, no assembly semantics,
no cameras, no animation, no scene graph.

## Transforms: preserved, not baked

**Preserve.** Baking a 3MF item transform into Float32 vertex coordinates is
lossy in a way the product cannot later undo, and it would make two instances of
one component into two unrelated meshes — destroying exactly the structure a
re-export needs. The existing `metadata.transform` field already establishes
this direction.

Consequence to be honoured in 4A-2: diagnostics and repair operate in **part
local coordinates**. This is correct for self-intersection, which asks whether a
part's own faces cross, and it is why inter-part overlap is a different question
(below).

## Part semantics: not everything is a part

The formats do not agree, and mapping them onto one concept would invent
structure. The research position:

| Source construct                      | Becomes                                          | Why                                                                                                            |
| ------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 3MF `<build><item>`                   | a **part**                                       | It is the format's own statement of "a thing being manufactured".                                              |
| 3MF `<object>` referenced by one item | that item's mesh                                 | Resource, not placement.                                                                                       |
| 3MF `<component>` instance            | a **part** per instance, sharing source geometry | Two placements are two things in the world.                                                                    |
| OBJ `o`                               | a **part**                                       | The format's object record.                                                                                    |
| OBJ `g`                               | a **group inside a part**                        | Already representable as `MeshGroup`.                                                                          |
| Disconnected shell inside one mesh    | **not** a part                                   | A topological accident, not a declared object. Splitting it is a future Split feature, not an import decision. |

## Diagnostics: intra-part, and a separate future concept

Self-intersection is **per part, aggregated per document**. Two independently
valid parts that overlap in world space are **not** self-intersecting, and
labelling them so would be exactly the diagnostic dishonesty the product
forbids. That case needs its own name — _inter-part overlap_ — and its own
future stage. It is deliberately **not** implemented now, and the report must
not imply it was checked.

## Repair: one part at a time, one document transaction

Conservative repair keeps operating on a single part's mesh, with the part named
explicitly. Apply commits a new **document** revision. Undo restores the previous
document revision. This preserves the Stage 3B transaction shape exactly and
avoids per-part undo histories, which would multiply the state the transaction
authority has to reason about for no current product benefit.

## Conversion loss must be stated, never assumed

Conversion is not symmetric and rarely lossless. A future
`ConversionCompatibilityReport` classifies each conversion **before** it runs:

- `LOSSLESS_FOR_SUPPORTED_FEATURES` — everything CAD Fixer models survives
- `LOSSY_METADATA` — names, materials, colours or units are discarded
- `LOSSY_STRUCTURE` — multiple parts collapse, or instances are duplicated
- `UNSUPPORTED_INPUT_FEATURE` — the source contains something we will not
  import (a texture, an n-gon)
- `BLOCKED` — the conversion cannot be attempted

3MF → STL is `LOSSY_STRUCTURE` **and** `LOSSY_METADATA`: STL has no units, no
names, and one implicit part. STL → 3MF is the mirror problem: 3MF _requires_ a
unit attribute, so writing one **adds a claim the source never made**. The
report must say so rather than silently writing `millimeter`.

## Units

| Format | Unit in file              | CAD Fixer                                        |
| ------ | ------------------------- | ------------------------------------------------ |
| STL    | none                      | `unit: undefined` — unknown, surfaced as unknown |
| OBJ    | none standardised         | `unit: undefined`                                |
| 3MF    | required `unit` attribute | preserved as stated                              |

**Canonical coordinates are not rescaled on import.** Rescaling would change the
stored values that exact topology, no-tolerance repair and exact
self-intersection all depend on. The unit travels as metadata beside the
coordinates. Exporting an unknown-unit model to 3MF must surface the invented
unit as `LOSSY_METADATA`/added-claim rather than choosing silently.

## Numeric serialisation: nine significant digits, measured

Text formats write decimal. If the writer emits too few digits, the value that
returns is a **different float**, and every exactness guarantee is silently
void. Measured over 200,019 finite Float32 values (17 hand-picked boundaries
plus 200,000 uniform random _bit patterns_, which is how subnormals and exponent
extremes get covered):

| Strategy             | Exact round-trips | Failures                   |
| -------------------- | ----------------- | -------------------------- |
| `toFixed(6)`         | 98,584            | **101,435**                |
| `toPrecision(7)`     | 64,779            | 135,240                    |
| `toPrecision(8)`     | 196,998           | 3,021                      |
| **`toPrecision(9)`** | **200,018**       | **1**                      |
| `String(v)`          | 200,018           | 1 (19.9 chars avg vs 14.0) |

The single failure in both passing strategies is **negative zero**, which
serialises as `"0"` and returns `+0`. The writer emits `-0` explicitly.

`toFixed(6)` — the obvious choice — fails **50.7%** of Float32 values. This is
recorded because it is the mistake this ADR most exists to prevent.

## OBJ scope: triangles only

`f` records with more than three corners are **refused**, not triangulated.

Demonstrated rather than asserted: for the concave pentagon fixture (F07), the
true area by shoelace is 10.00, while a naive fan produces triangles with signs
`+ − +` — one of the opposite orientation, i.e. **geometry outside the polygon**.
Fanning would invent faces the file never described, which is the same class of
error as silent repair on import.

Supported records: `v`, `vn`, `vt`, `f` (all four corner spellings: `v`,
`v/vt`, `v//vn`, `v/vt/vn`), `o`, `g`, `usemtl`, `mtllib` (recorded, not
resolved), comments and blank lines. Negative (relative) indices are resolved
against the vertices seen so far. Zero indices, out-of-range indices, non-finite
coordinates and over-long lines are refused with a reason.

Matrix result: **11/11 fixtures behaved as analytically expected.**

## Materials, colours, textures, MTL

**Names and material references are preserved as opaque strings. Nothing is
resolved.** `mtllib` is recorded but the `.mtl` is not read, no texture is
loaded, and no path is dereferenced. A standalone OBJ therefore cannot cause any
file or network access. Textures are `UNSUPPORTED_INPUT_FEATURE` in the loss
report rather than silently dropped.

This also settles multi-file import UX: **single-file picker only** for 4A-2.
Nothing else is needed while no auxiliary file is read.

## 3MF container: bounded, dependency-free

`DecompressionStream('deflate-raw')` is a platform primitive in Node and every
target browser. **No ZIP dependency is recommended.** A ~200-line reader gets
the properties a general library does not offer: the byte budget is enforced
_while inflating_ rather than after, and hostile paths are refused before any
content is produced.

Proposed caps: archive 512 MiB, entries 4,096, per-entry 256 MiB, total
uncompressed 512 MiB, compression ratio 200:1, path length 512.

Results — **18/18 hostile archives refused, valid archive accepted**, identical
in Node and Chromium:

truncated archive, no EOCD, 64 MiB zero bomb, a header _lying_ about its
uncompressed size, `../../etc/passwd`, `3D/../../escape`, absolute path,
drive-letter path, backslash traversal, percent-encoded traversal, `https://`
and `file://` entry names, encrypted entry, unsupported compression method,
case-colliding duplicate paths, NUL in path, entry count above cap.

Independent oracle: the same 65,362-byte bomb inflates to 67,108,864 bytes
(**1027:1**) under a naive reader. The bounded reader refuses it twice — on the
declaration and again mid-inflation.

## 3MF XML: refuse the DTD, do not rely on the parser

Proven in Chromium: `DOMParser` does not expand an external entity into the
document. But **that is a property of today's engines, not a contract we
control**, so the policy is defence in depth — a document declaring `<!DOCTYPE`,
`<!ENTITY`, or an external `SYSTEM`/`PUBLIC` identifier is **refused before
being parsed for meaning**. A file that never reaches entity expansion cannot
depend on whether entity expansion is safe. Billion-laughs is refused by the
same rule, before expansion. Malformed XML surfaces as a parse error rather than
being accepted.

Resource resolution is **archive-local only**. Proven: parsing hostile input
that _names_ `http://evil.test/x.dtd`, a remote namespace, and a remote `mtllib`
produced **zero off-origin requests**.

## Worker architecture

**Disposable format worker → direct transfer to the geometry worker**, mirroring
the qualified self-intersection architecture (ADR 0012): the page coordinates
ports but never reads coordinates, a parser crash is contained, and cancellation
is `Worker.terminate()` on a worker that owns nothing authoritative.

Where parsing is our own loop-based code — OBJ, and the ZIP/XML walk — the
Stage 3B cooperative `SharedArrayBuffer` token _is_ usable and preferable,
because it interrupts without discarding the worker. `DecompressionStream` is
asynchronous and abortable via `reader.cancel()`.

Import transactionality is unchanged: parse → validate → candidate document →
commit. A failed import leaves the previous authoritative document intact.

## Performance

OBJ parse, measured in Chromium on the research parser:

| Faces   | Bytes    | Parse  | Throughput |
| ------- | -------- | ------ | ---------- |
| 20,000  | 1.0 MiB  | 28 ms  | 35.3 MiB/s |
| 100,000 | 5.6 MiB  | 131 ms | 40.5 MiB/s |
| 200,000 | 11.4 MiB | 205 ms | 53.0 MiB/s |

Text parsing is roughly an order of magnitude slower per byte than binary STL,
which is expected and not alarming at these sizes.

## Unresolved — why this is PARTIALLY qualified

1. **3MF geometry construction is not implemented.** Container security and XML
   policy are qualified; turning `<mesh>`/`<build>` into parts, and writing 3MF
   back out, is not. Round-trip and 3MF numeric serialisation therefore remain
   unproven.
2. **No 10/50 MiB 3MF performance evidence**, for the same reason.
3. **The document layer is a design, not a prototype.** The revision argument is
   drawn from the existing code's structure rather than from a running
   multi-part implementation.
4. **Conversion pipeline and export validation are designed, not exercised.**

## Stage 4A-2 scope, recommended

- OBJ import/export, **triangles only**, n-gons refused with a reason
- 3MF import/export limited to mesh geometry, build items, item transforms and
  the unit attribute
- multi-part document with a single monotonic revision
- names and material references preserved as opaque strings; no MTL resolution,
  no textures
- conversion through the canonical document as the only intermediate — no
  N×M direct converters
- truthful `ConversionCompatibilityReport` on every conversion
- export validation by parse-back for all three formats
- single-file picker

Deferred: MTL, textures, colours, n-gon triangulation, inter-part overlap
detection, split/connectors.

## What this does not change

No printability claim. Units, wall thickness, manufacturability and slicer
behaviour remain outside what any of this establishes.
