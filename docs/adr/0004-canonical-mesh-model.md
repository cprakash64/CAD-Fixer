# 0004 — Canonical mesh model

- Status: Accepted (requirements and boundary); **key details deliberately open**
- Date: 2026-08-14

## Context

CAD Fixer will read STL, OBJ, and 3MF, and will run repair, conversion,
splitting, texturing, and hollowing. Without a single internal representation,
every workflow would need per-format handling and conversion paths would grow
quadratically with format count.

The representation has to be decided early enough that codecs and operations can
be built against it — but not so completely that we lock in numeric choices we
have not yet measured.

## Decision

**A canonical, indexed triangle mesh in typed arrays, defined in
`packages/mesh-core`.** Every reader produces it; every writer consumes it;
every geometry operation takes and returns it.

```ts
interface CanonicalMesh {
  readonly positions: PositionArray; // XYZ triplets
  readonly indices: IndexArray; // Uint32, triangle vertex indices
  readonly normals?: NormalArray; // optional, matches positions length
  readonly uvs?: UvArray; // optional, 2 per vertex
  readonly groups?: readonly MeshGroup[];
  readonly metadata: MeshMetadata; // unit, transform, source format
}
```

Requirements this satisfies:

- **Positions and triangle indices** — the irreducible core.
- **Optional normals and UVs** — absent in much STL input; optional rather than
  synthesised, because inventing normals is a silent modification.
- **Groups** — OBJ groups and 3MF objects map here, so export can round-trip
  them instead of flattening the user's model.
- **Unit metadata** — `LengthUnit`, or `undefined` when the source did not say.
  STL and OBJ generally do not. **`undefined` must not be defaulted to
  millimetres silently**; an unknown unit is surfaced to the user.
- **Transform metadata** — a 4×4 column-major matrix kept separate from vertex
  data, so an import need not bake a transform into coordinates and lose the
  originals.
- **Source-format metadata** — for round-trip decisions and diagnostics.

Counts are **derived** (`vertexCount()`, `triangleCount()`) rather than stored,
so they cannot drift out of sync with the buffers.

### Scope boundary

This is a triangle mesh, **not** a BREP/CAD kernel representation. No NURBS, no
solid modelling history, no parametric features, no assembly tree. All five
target workflows operate on printable triangle meshes, and STL, OBJ, and 3MF all
reduce to this. Supporting STEP or IGES later would need a genuinely different
model, and that is a separate decision.

### Validation is part of the contract

`validateMeshStructure` checks the invariants that make an instance well formed:
buffer lengths, index bounds, finite coordinates, attribute-length agreement,
group bounds, degenerate triangles. `assertMeshStructure` is the gate operations
must pass their output through. See
[ADR 0005](0005-validation-after-geometry-operations.md).

Structural validation is explicitly _not_ topological validation. Manifoldness,
boundary edges, self-intersection, winding consistency, and shell separation
belong to the repair workflow and will live in their own module.

## Open questions — deliberately not decided

**Float32 vs Float64 for positions.** _This is the significant unresolved
decision and it is not being locked in now._

- Float32 halves memory, matches GPU upload formats directly, and is what most
  mesh formats and viewers use.
- Float64 preserves precision on large models translated far from the origin.
  This is a genuine hazard for repair and boolean work, where coincident-vertex
  welding depends on absolute tolerances: a model 10 m from the origin loses
  roughly millimetre-scale resolution in Float32.

Deciding this correctly requires benchmarking against real user files —
measuring memory, and measuring how often the precision loss actually produces
bad welds. Guessing now risks either wasting memory on every model or corrupting
a minority of them.

### Stage 1 update (2026-08-14) — still open, but now with evidence

Measurements are in [PERFORMANCE_BASELINE.md](../PERFORMANCE_BASELINE.md).
Summary of what changed:

- **The memory cost is now measured, not estimated.** Float64 positions add 75%
  to canonical mesh size (96 MiB → 168 MiB for a 100 MiB STL), plus a conversion
  pass and a transient extra copy on every GPU upload, since GPUs take Float32.
- **The benefit for STL import specifically is zero.** Binary STL stores Float32,
  so widening the canonical type stores identical values in twice the space. The
  only implemented workflow cannot motivate the change.
- **The argument for Float64 is entirely about unimplemented operations** —
  welding tolerances, booleans, offsetting — so the evidence that would justify
  the cost cannot be gathered yet.

**Decision: Float32 stays, and this question stays OPEN.** It is the reversible
choice, and `PositionArray` still isolates it to one line.

The benchmark that would close it: implement coincident-vertex welding with an
absolute tolerance, run it on models translated 10 mm / 1 m / 100 m from the
origin at feature sizes from 10 µm to 1 mm, and measure how often Float32 and
Float64 disagree about vertex identity. Divergence at realistic magnitudes
justifies the memory; no divergence closes this in favour of Float32.

**Mitigation:** the code declares `type PositionArray = Float32Array` as a
single alias with `Float32Array` as the provisional value. Call sites use the
alias, never the concrete type, so the decision changes in one place. A likely
outcome is a hybrid — Float64 during operations, Float32 for GPU upload — which
this shape also permits.

Other questions left open on purpose:

- **Per-vertex colour.** 3MF supports it; not modelled until the conversion
  workflow needs it.
- **Material representation.** `MeshGroup.materialRef` is an opaque string; the
  real material model is deferred.
- **Multiple disconnected shells.** Currently one buffer set with optional
  groups. Splitting may want first-class shells; that decision belongs with the
  split workflow.
- **Half-edge or other adjacency structures.** Repair and booleans will want
  adjacency. It should be a derived, cached structure alongside the canonical
  mesh, not baked into it — but the design is deferred until an algorithm
  demands it.

## Alternatives considered

**Use Three.js `BufferGeometry` as the canonical type.** Tempting — it is
already there and the viewport speaks it. Rejected: it would make a rendering
library the foundation of the domain model, drag Three.js into every geometry
package and worker, and tie our data model to a pre-1.0 library's release
cadence.

**A face-vertex list without shared indices (triangle soup).** What STL is
natively. Rejected as canonical: it triples position memory and discards vertex
sharing that repair and subdivision need. Reading STL will require welding into
indexed form.

**A half-edge structure as canonical.** Excellent for topology work, and repair
will want it. Rejected as the canonical form: it is far more expensive to build
and store, is awkward to hand to a GPU, and cannot represent the non-manifold
input that CAD Fixer exists to accept. Better derived on demand.

**Deferring the mesh model until parsers are written.** Rejected: the codec and
operation interfaces both need something concrete to be written against.

## Consequences

**Positive**

- Conversion paths grow linearly with format count.
- Typed arrays are compact and transfer cheaply across the worker boundary.
- Optional attributes let us represent what a source actually contained, rather
  than fabricating data.
- Unit and transform metadata make silent geometry changes visible.

**Negative**

- Not expressive enough for CAD/BREP formats; adding STEP would need a second
  model.
- Adjacency must be recomputed by algorithms that need it.
- The Float32/Float64 question remains open, so some memory and precision
  characteristics are not yet settled.
- Optional attributes mean every consumer must handle their absence.
