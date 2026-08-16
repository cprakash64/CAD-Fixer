# Geometry kernel candidate audit

Status: Stage 3A-1. **Engineering assessment, not legal advice.** No kernel is
installed, and nothing here is a final selection.

Research date: **2026-08-16**. Every claim below is sourced from the upstream
project's own repository, documentation, licence file, or release metadata.
Marketing pages, comparison blogs, and third-party tutorials were not used.
Where a capability could not be established from a primary source, it is
recorded as unverified rather than assumed.

**Roles, not a winner.** CAD Fixer does not need one universal kernel. The
plausible architecture is deterministic cleanup we own, plus a repair kernel,
plus a separate solid/boolean kernel, plus possibly a rebuild path. Candidates
are assessed per role.

---

## Manifold

|                          |                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream                 | https://github.com/elalish/manifold                                                                                                                                                                                                                                       |
| Version reviewed         | **v3.5.2**, released 2026-06-27 (npm `manifold-3d` **3.5.1**, published 2026-06-04)                                                                                                                                                                                       |
| Licence                  | **Apache-2.0**                                                                                                                                                                                                                                                            |
| Bundled licence concerns | Core is self-contained. The **npm package** declares runtime dependencies including `@gltf-transform/*`, `commander`, `fast-xml-parser`, `fflate`, `magic-string` — CLI/IO tooling, not the WASM core. A build must take the WASM artifact without dragging that tree in. |
| WebAssembly              | **First-class.** Official `bindings/wasm`, published to npm as `manifold-3d`.                                                                                                                                                                                             |
| Browser support          | Designed for it; ships `.wasm` plus TypeScript definitions.                                                                                                                                                                                                               |
| Threading                | Optional TBB parallelism (`MANIFOLD_PAR=ON`) in native builds. **The WASM build is serial**, per upstream README.                                                                                                                                                         |
| Precision                | Tracks an explicit `tolerance()` — "the approximate rounding error over all the transforms and operations". Not exact-predicate based.                                                                                                                                    |

**Input requirements — the decisive point.** Manifold requires manifold input.
Upstream states you "get an error status if the imported mesh isn't manifold",
and offers `Mesh.merge()` which "updates the mergeFromVert and mergeToVert
vectors in order to create a manifold solid" — a recovery path for _slightly_
off input, not general repair. Upstream is explicit that for general repair
users "may need one of the automated repair tools that exist mostly for 3D
printing".

**Capabilities**

- Repair: **no general repair.** `merge()` only, for near-manifold input.
- Self-intersection: no detector exposed in the WASM API. Booleans _reconstruct_
  and guarantee manifold output, which resolves intersections as a side effect
  of a union rather than as a repair operation.
- Booleans: **yes — this is its purpose**, with guaranteed-manifold output.
- Hole filling: no.
- Remeshing: not as a repair; there is SDF-based construction.
- Useful diagnostics: `status()`, `genus()`, `volume()`, `surfaceArea()`,
  `decompose()`, `windingNumber()`.

**Assessment.** Excellent for the **solid/boolean role** and directly useful for
the later Split workflow and for self-union as an intersection-resolution
strategy. It is **not** an arbitrary-mesh repair engine and must not be scored as
one. Its precondition is exactly what our worst fixtures violate, which makes
"can it even ingest R11/R12/R29?" a real experiment rather than a formality.

**Eligibility: ELIGIBLE FOR BAKEOFF** (solid/boolean role; ingestion-tolerance
probe).

---

## Geogram

|                          |                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream                 | https://github.com/BrunoLevy/geogram                                                                                                                             |
| Version reviewed         | **v1.10.0**, released 2026-05-27                                                                                                                                 |
| Licence (core)           | **BSD 3-Clause**, © Inria. No additional clauses.                                                                                                                |
| Bundled licence concerns | **Serious — see below.**                                                                                                                                         |
| WebAssembly              | Yes; upstream ships in-browser demos built with Emscripten.                                                                                                      |
| Threading                | Parallel algorithms available natively (notably parallel Delaunay); browser threading not established from primary sources.                                      |
| Precision                | **Exact predicates and exact-number arithmetic** are a foundational component; constrained Delaunay "supports intersecting constraints, in arbitrary precision". |

**Capabilities**

- Repair: surface reconstruction and mesh repair utilities.
- Self-intersection: **mesh intersection and boolean operations**, with v1.10.0
  release notes reporting intersection/boolean work "optimized to 4x faster" and
  "enhanced mesh intersection control options".
- Booleans: yes, including CSG.
- Hole filling: reconstruction-oriented rather than a documented local hole-fill.
- Exact predicates: yes — the strongest of the shortlist on robustness.

**The bundled-dependency trap.** `src/lib/geogram/third_party/` contains, as of
this review: `HLBFGS`, `OpenNL`, `PoissonRecon`, `amgcl`, `libMeshb`, `lua`,
`rply`, `stb`, `stb_image`, `tetgen`, `triangle`, `xatlas`, `zlib`. Two of these
are disqualifying if they enter a proprietary build:

- **`triangle`** (Shewchuk). Verified verbatim from the bundled `README`:
  > "Distribution of this code as part of a commercial system is permissible
  > ONLY BY DIRECT ARRANGEMENT WITH THE AUTHOR."
- **`tetgen`**. Verified verbatim from the bundled `README.txt`:
  > "license: GNU Affero General Public License … Free for academic use, contact
  > copyright owners at tetgen@wias-berlin.de for other uses"

AGPL is prohibited outright by project rule 17. Triangle's terms require a direct
commercial arrangement.

Upstream also warns that GitHub's auto-generated archives omit submodules, so a
build must start from the full source archive — which makes it _more_ likely, not
less, that a careless integration pulls everything in.

**Consequence.** Geogram is eligible **only** if a build can be produced that
demonstrably excludes `tetgen` and `triangle`, verified by inspecting the linked
artifact rather than by trusting a CMake flag. Establishing that is a Stage 3A-2
task, and it is a **hard gate**: if the repair/intersection code paths we want
transitively require either component, Geogram is rejected for production use
regardless of how well it scores.

**Eligibility: ELIGIBLE FOR BAKEOFF, GATED** on a verified exclusion build.

---

## PMP Library

|                          |                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Upstream                 | https://github.com/pmp-library/pmp-library                                                |
| Version reviewed         | `main`, reviewed 2026-08-16                                                               |
| Licence                  | **MIT**                                                                                   |
| Bundled licence concerns | None identified for the algorithm core.                                                   |
| WebAssembly              | Yes — upstream advertises "seamless cross-compilation to JavaScript" with a working demo. |
| Threading                | Not established from primary sources.                                                     |
| Precision                | Double-precision floating point; no exact predicates.                                     |

**Input requirements — decisive.** `pmp::SurfaceMesh` documentation states
verbatim:

> "This class only supports 2-manifold surface meshes with boundary."

`add_face` throws `TopologyException` on a topological error. This means PMP
**cannot ingest** several of our corpus fixtures at all — R11 (non-manifold
edge), R12 (bow-tie vertex), and R29 (catastrophic soup) violate its
precondition by construction.

**Capabilities**

- Repair: not a general repair library.
- Self-intersection: none found in primary sources.
- Booleans: none.
- Hole filling: a hole-filling algorithm exists in the library; not documented in
  the README reviewed, so treated as **unverified pending Stage 3A-2**.
- Remeshing / decimation / subdivision / smoothing: yes, documented.

**Assessment.** PMP is a clean, permissive, browser-capable **local surface
operations** library, not a front-line repair engine. Its natural role is a
**hole-fill and remesh baseline applied after** topology has been made manifold
by something else. Its manifold precondition is a genuine architectural
constraint, not a detail: it forces an ordering on the pipeline.

**Eligibility: ELIGIBLE FOR BAKEOFF** (local hole-fill / remesh role, post-cleanup).

---

## MeshLib

|                  |                                                              |
| ---------------- | ------------------------------------------------------------ |
| Upstream         | https://github.com/MeshInspector/MeshLib                     |
| Version reviewed | `master` LICENSE, reviewed 2026-08-16                        |
| Licence          | **Non-Commercial & Education License Agreement**             |
| WebAssembly      | Advertised by the project; not evaluated further, see below. |

Verified verbatim from the licence:

> "User a terminable, non-exclusive, and non-transferable license to use the
> Software, solely for non-commercial, evaluation or educational purposes."

and users may not "sell, rent, sublicense, display, modify, or otherwise
transfer the Software to any third party."

**Assessment.** CAD Fixer is intended to become a commercial product. This
licence does not permit that use. MeshLib is therefore **not integrated and not
benchmarked**; further capability research was deliberately not performed,
because capability is irrelevant until the licensing question is answered by a
person with authority to answer it.

What would need to change: a commercial licence agreement with MeshInspector,
which is a **business decision, not an engineering one**.

**Eligibility: COMMERCIAL DECISION REQUIRED.**

---

## CGAL Polygon Mesh Processing

|                  |                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upstream         | https://github.com/CGAL/cgal                                                                                                                           |
| Version reviewed | `master` package licence declaration, reviewed 2026-08-16                                                                                              |
| Licence          | Package declares **GPL v3-or-later** (dual-listed with MIT/X11 for parts)                                                                              |
| Wider CGAL       | Kernel and support libraries LGPL; "most geometric algorithms and data structures are under the GPL, but there are some exceptions in both directions" |
| Commercial       | Commercial licences available from GeometryFactory                                                                                                     |

**Assessment.** GPL is prohibited for this product's runtime by project rule 17,
and a commercial licence is a business decision. CGAL is therefore used here as a
**reference candidate only**: its Polygon Mesh Processing package is the most
complete published taxonomy of mesh repair operations, and its documented
guarantees are a useful benchmark for what "robust" ought to mean — in
particular for self-intersection handling, where it distinguishes detection,
enumeration, and removal as separate capabilities.

**No CGAL code enters this repository.**

**Eligibility: REFERENCE ONLY.**

---

## Optional candidate considered and not pursued

The brief permits documenting one further candidate if it would materially change
the decision. None was added. The shortlist already covers the three distinct
roles that matter (solid/boolean, robust intersection with exact predicates,
local surface operations) with permissive licences, and adding a fourth
implementation to compile would cost Stage 3A-2 time without changing which
roles are filled. If Geogram fails its exclusion gate, the honest response is to
re-open this section for an exact-predicate replacement rather than to have
pre-emptively surveyed twenty libraries.

---

## Cross-cutting findings

### Cancellation

**This is the least documented area across every candidate**, and it is a
first-class product requirement — CAD Fixer already guarantees cancellable
operations.

The structural problem is the same everywhere: a long synchronous WASM call
cannot observe a `postMessage` cancellation, because the message cannot be
delivered until the call returns. A polled flag that nothing can set is not
cancellation.

None of the shortlisted candidates was found to document a cooperative
cancellation callback in its WASM binding. Stage 3A-2 must establish, per
candidate:

- whether any progress or interrupt callback exists;
- whether the operation can be split into resumable chunks;
- otherwise, whether it can run in a **disposable secondary worker** that is
  terminated on cancel.

The disposable-worker approach is the fallback that always works, and its costs
are real and must be measured: the mesh must be copied into that worker, the
worker's WASM heap is lost on termination, and the resident-model architecture
must not be disturbed. **Do not change the production worker architecture in
Stage 3A-2 before those numbers exist.**

### WASM memory

Common to all: JS `ArrayBuffer` ownership does **not** mean zero-copy into a C++
WASM heap. Expect input copy in, internal representation, and output copy back —
potentially three simultaneous copies of a large mesh, on top of the resident
mesh and the render snapshot the application already holds.

Stage 3A-2 must measure, per candidate: input copy cost, peak WASM heap, output
copy cost, heap growth behaviour and whether it ever shrinks, the 32-bit 4 GiB
linear-memory ceiling and whether WASM64 is offered, SIMD, threads, and whether
disposal actually returns memory.

Our existing memory model must learn to distinguish **canonical JS memory** from
**candidate WASM heap memory**; today it models only the former.

### Precision, and ADR 0004

The candidates differ sharply: Geogram is built on exact predicates and exact
arithmetic; Manifold tracks an accumulated floating-point tolerance; PMP is plain
double precision.

**This does not close [ADR 0004](../adr/0004-canonical-mesh-model.md)**, and
Stage 3A-1 must not pretend otherwise. What it does is identify the experiments
that would finally produce evidence, listed in
[REPAIR_ARCHITECTURE.md](REPAIR_ARCHITECTURE.md#precision-stress-suite).

### Self-intersection

Following CGAL's distinction, these are separate capabilities and must not be
conflated:

| Capability                     | Manifold                     | Geogram                      | PMP       |
| ------------------------------ | ---------------------------- | ---------------------------- | --------- |
| Detection (yes/no)             | Not exposed                  | Yes (intersection machinery) | Not found |
| Intersecting-pair enumeration  | Not exposed                  | Likely — verify in 3A-2      | Not found |
| Robust intersection predicates | Tolerance-based              | **Yes, exact**               | No        |
| Intersection resolution        | Via boolean reconstruction   | Yes                          | No        |
| Boolean reconstruction         | **Yes, guaranteed manifold** | Yes                          | No        |

A kernel that only _detects_ is still valuable: detection alone closes Stage 2's
largest diagnostic gap and is the precondition for any printability claim.
