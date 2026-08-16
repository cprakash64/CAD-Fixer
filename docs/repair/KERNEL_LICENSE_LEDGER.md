# Kernel licence ledger

**This is an engineering ledger, not legal counsel.** It records what upstream
licence files say, what components a build would pull in, and what that implies
for a product intended to be proprietary. It deliberately does not use the words
"safe" or "legally approved", because this document cannot establish either.

Reviewed: **2026-08-16**. Every entry cites the file actually read.

Governing constraint: project rule 17 — no GPL/AGPL runtime code without
explicit approval; other copyleft carries obligations that must be evaluated
before adoption.

## Status categories

| Category                         | Meaning                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| **ELIGIBLE FOR BAKEOFF**         | Licence poses no identified obstacle to a proprietary product; may be compiled and benchmarked |
| **ELIGIBLE FOR BAKEOFF, GATED**  | Eligible only if a specific, verifiable build condition is met                                 |
| **REFERENCE ONLY**               | May inform design; no code enters the repository                                               |
| **COMMERCIAL DECISION REQUIRED** | Blocked pending a business decision outside engineering's authority                            |
| **REJECTED**                     | Not viable for this product                                                                    |

---

## Manifold

| Field                           | Finding                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream licence                | Apache-2.0 (`LICENSE`, repository root)                                                                                                                                                                                                                                                                          |
| Version reviewed                | v3.5.2 (2026-06-27); npm `manifold-3d` 3.5.1                                                                                                                                                                                                                                                                     |
| Transitive / bundled            | Core self-contained. The **npm package** declares runtime deps: `@gltf-transform/core`, `@gltf-transform/extensions`, `@gltf-transform/functions`, `@jridgewell/resolve-uri`, `@jridgewell/trace-mapping`, `@jscadui/3mf-export`, `commander`, `convert-source-map`, `fast-xml-parser`, `fflate`, `magic-string` |
| Required for our build          | The WASM artifact and its JS glue only                                                                                                                                                                                                                                                                           |
| Explicitly excluded             | The entire npm CLI/IO dependency tree. If we consume `manifold-3d` from npm we must confirm what a bundler actually pulls, and prefer vendoring the `.wasm` + minimal glue                                                                                                                                       |
| Commercial restrictions         | None identified                                                                                                                                                                                                                                                                                                  |
| Attribution obligations         | Apache-2.0 §4: retain notices, include NOTICE contents, mark modified files                                                                                                                                                                                                                                      |
| Source/distribution obligations | None beyond attribution                                                                                                                                                                                                                                                                                          |
| **Status**                      | **ELIGIBLE FOR BAKEOFF**                                                                                                                                                                                                                                                                                         |

---

## Geogram

| Field                           | Finding                                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream licence                | BSD 3-Clause, © Inria (`LICENSE`, repository root) — standard, no added clauses                                                                                                     |
| Version reviewed                | v1.10.0 (2026-05-27)                                                                                                                                                                |
| Transitive / bundled            | `src/lib/geogram/third_party/` contains: `HLBFGS`, `OpenNL`, `PoissonRecon`, `amgcl`, `libMeshb`, `lua`, `rply`, `stb`, `stb_image`, **`tetgen`**, **`triangle`**, `xatlas`, `zlib` |
| Required for our build          | To be determined in Stage 3A-2 — the intersection/boolean and repair paths only                                                                                                     |
| Explicitly excluded             | **`tetgen` and `triangle` must both be excluded**                                                                                                                                   |
| Commercial restrictions         | See the two entries below                                                                                                                                                           |
| Attribution obligations         | BSD 3-Clause notice retention; plus notices for every bundled component that remains                                                                                                |
| Source/distribution obligations | None from BSD 3-Clause itself                                                                                                                                                       |
| **Status**                      | **ELIGIBLE FOR BAKEOFF, GATED**                                                                                                                                                     |

### Gate condition

A Geogram build may only be considered for production if it can be shown that
the linked artifact contains neither `tetgen` nor `triangle`. Verification must
inspect the **produced artifact** — symbols in the `.wasm`, the object files
actually linked — not merely a CMake option, because an option that silently
does nothing would leave the obligation in place while appearing to satisfy it.

If the intersection or repair paths we need transitively require either
component, Geogram is **REJECTED** for production regardless of benchmark score.
It could still serve as a reference implementation for evaluating others.

### `tetgen` — bundled inside Geogram

> "license: GNU Affero General Public License:
> http://www.gnu.org/licenses/agpl-3.0.en.html
>
> Free for academic use, contact copyright owners at tetgen@wias-berlin.de for
> other uses"
> — verbatim, `src/lib/geogram/third_party/tetgen/README.txt`

AGPL-3.0. Prohibited by project rule 17 without explicit approval, and
particularly hazardous for a browser-delivered product, where AGPL's network
clause is exactly the scenario it was written for. **Must be excluded.**

### `triangle` — bundled inside Geogram

> "Distribution of this code as part of a commercial system is permissible ONLY
> BY DIRECT ARRANGEMENT WITH THE AUTHOR."
> — verbatim, `src/lib/geogram/third_party/triangle/README`

Not an OSI-style licence at all. Private, research, and institutional use is
free; commercial distribution requires a direct arrangement with Jonathan
Shewchuk. **Must be excluded**, or a licensing decision taken first.

### Other bundled components

Not individually audited in Stage 3A-1, because the two blockers above decide
the gate. If Geogram passes the exclusion gate, **each remaining bundled
component that survives into the artifact must be audited and attributed before
production use** — `lua`, `zlib`, `stb`, `rply`, `amgcl`, `xatlas`,
`PoissonRecon`, `HLBFGS`, `OpenNL`, `libMeshb`. Recorded here so this is not
forgotten.

---

## PMP Library

| Field                           | Finding                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Upstream licence                | MIT (`LICENSE.txt`, repository root)                                                                                |
| Version reviewed                | `main`, 2026-08-16                                                                                                  |
| Transitive / bundled            | Not enumerated in the README reviewed; visualisation layer likely pulls GL/GLFW-family dependencies                 |
| Required for our build          | Algorithm core only — **not** the visualisation layer                                                               |
| Explicitly excluded             | The rendering/visualisation components; we have a viewport                                                          |
| Commercial restrictions         | None                                                                                                                |
| Attribution obligations         | MIT notice retention. Authors additionally _request_ citation for research use — a request, not a licence condition |
| Source/distribution obligations | None                                                                                                                |
| **Status**                      | **ELIGIBLE FOR BAKEOFF**                                                                                            |

Stage 3A-2 must confirm the dependency set of an algorithms-only Emscripten
build, since only the visualisation path was expected to carry heavier
dependencies and that expectation is currently unverified.

---

## MeshLib

| Field                           | Finding                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upstream licence                | "Non-Commercial & Education License Agreement" (`LICENSE`, repository root)                                                                                                                                        |
| Version reviewed                | `master`, 2026-08-16                                                                                                                                                                                               |
| Transitive / bundled            | Not investigated — see below                                                                                                                                                                                       |
| Commercial restrictions         | **Fundamental.** Licence grants use "solely for non-commercial, evaluation or educational purposes"; user may not "sell, rent, sublicense, display, modify, or otherwise transfer the Software to any third party" |
| Attribution obligations         | Not investigated                                                                                                                                                                                                   |
| Source/distribution obligations | Not investigated                                                                                                                                                                                                   |
| **Status**                      | **COMMERCIAL DECISION REQUIRED**                                                                                                                                                                                   |

CAD Fixer is intended to become a commercial product, so this licence does not
permit the use we would make of it. Deeper research was deliberately not
performed: capability is irrelevant while the permission question is open, and
producing a capability case for something we cannot use would invite the
decision to be made on the wrong grounds.

Unblocking requires a commercial agreement with MeshInspector. That is a
business decision, not an engineering one.

---

## CGAL (Polygon Mesh Processing)

| Field                   | Finding                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upstream licence        | Package declares **GPL v3-or-later** (dual-listed with MIT/X11 for parts)                                                                                                      |
| Wider project           | Kernel and support libraries LGPL; "most geometric algorithms and data structures are under the GPL, but there are some exceptions in both directions" (cgal.org/license.html) |
| Version reviewed        | `master`, 2026-08-16                                                                                                                                                           |
| Transitive / bundled    | Boost and others; not investigated                                                                                                                                             |
| Commercial restrictions | GPL obligations; commercial licences sold by GeometryFactory                                                                                                                   |
| **Status**              | **REFERENCE ONLY**                                                                                                                                                             |

Used for its documented repair taxonomy and its separation of self-intersection
detection, enumeration, and removal into distinct capabilities. **No CGAL code
enters this repository.**

---

## Summary

| Candidate | Licence                                               | Status                          |
| --------- | ----------------------------------------------------- | ------------------------------- |
| Manifold  | Apache-2.0                                            | ELIGIBLE FOR BAKEOFF            |
| Geogram   | BSD 3-Clause core; AGPL + non-free bundled components | ELIGIBLE FOR BAKEOFF, **GATED** |
| PMP       | MIT                                                   | ELIGIBLE FOR BAKEOFF            |
| MeshLib   | Non-Commercial & Education                            | COMMERCIAL DECISION REQUIRED    |
| CGAL PMP  | GPL v3-or-later                                       | REFERENCE ONLY                  |

**No kernel dependency has been added to this repository.** `package.json` is
unchanged with respect to runtime dependencies.
