# CAD Fixer

A local-first, browser-based tool for repairing and preparing 3D printing
meshes.

**Your models never leave your machine.** Files are read, processed, and
exported entirely in the browser using Web Workers, WebAssembly, and your own
CPU and GPU. There is no server-side geometry processing, no upload endpoint,
and no analytics.

> **Current status: Stage 2 — STL import, viewing, export, and topology
> diagnostics.**
> You can open a binary or ASCII STL file, inspect it in a real 3D viewport,
> read a full topology report about it, highlight its defects in 3D, and export
> it again — entirely on your own machine. **None of the five workflows is
> implemented yet**: diagnostics tell you what is wrong, and nothing repairs it.
> See [What is and is not implemented](#what-is-and-is-not-implemented). Nothing
> in this repository fakes a working feature.

## Planned workflows

| Workflow | Purpose                                                 | Status                        |
| -------- | ------------------------------------------------------- | ----------------------------- |
| Repair   | Close holes, fix normals, resolve non-manifold geometry | Diagnosis only; no repair yet |
| Convert  | Translate between STL, OBJ, and 3MF                     | Not implemented               |
| Split    | Cut oversized models into parts and add connectors      | Not implemented               |
| Texture  | Apply surface displacement patterns                     | Not implemented               |
| Hollow   | Hollow solid models and place drainage holes            | Not implemented               |

Target formats: **STL, OBJ, 3MF**.

## Getting started

Requires **Node.js 22.12 or later**.

```bash
npm install
```

```bash
npm run dev
```

Then open the URL Vite prints (http://localhost:5173 by default). The dev server
sends cross-origin isolation headers, matching what production must send.

## Commands

| Command                | What it does                                        |
| ---------------------- | --------------------------------------------------- |
| `npm install`          | Install dependencies from the lockfile              |
| `npm run dev`          | Start the development server                        |
| `npm run build`        | Production build into `apps/web/dist/`              |
| `npm run preview`      | Serve the production build on http://localhost:4173 |
| `npm run lint`         | ESLint across the repository                        |
| `npm run format:check` | Verify formatting (`npm run format` to fix)         |
| `npm run typecheck`    | TypeScript across every project                     |
| `npm test`             | Vitest unit and component tests                     |
| `npm run test:e2e`     | Playwright end-to-end tests                         |
| `npm run verify`       | format:check + lint + typecheck + test + build      |

End-to-end tests need a browser binary once:

```bash
npx playwright install chromium
```

`npm run test:e2e` builds the app and serves it itself — no server needs to be
running first.

## What is and is not implemented

### Implemented

- **STL import**, binary and ASCII, parsed in a Web Worker. The encoding is
  detected structurally, never from the file extension or a leading `solid` —
  binary STL files routinely contain `solid` in their header, and getting that
  wrong is the classic STL bug.
- **A hand-written STL parser** that treats every file as hostile: declared
  facet counts are checked against the real buffer length, every allocation is
  preflighted against a typed budget, and non-finite coordinates are rejected
  rather than silently replaced. Three.js's `STLLoader` is deliberately not used
  as the parsing boundary.
- **Import progress and working cancellation**, including on multi-million-
  triangle files.
- **A real 3D viewport**: your model, with orbit/pan/zoom, fit-view, lighting,
  high-DPI handling, and correct GPU resource disposal when a model is replaced.
- **Model statistics** — triangle and vertex counts, file size, encoding,
  bounding box and radius, and unit status.
- **Topology diagnostics**, run automatically after import, in the worker:
  recovered vertices and edges, connected components, boundary edges and their
  loop/chain/branched structure, non-manifold edges, non-manifold vertices
  (including bow-tie points that edge-only checks miss), winding conflicts,
  duplicate and degenerate faces, Euler characteristic, surface area, and
  algebraic signed volume. Connectivity is recovered from **exact stored
  coordinates** — no tolerance welding, and the mesh is never modified. See
  [ADR 0009](docs/adr/0009-exact-topology-recovery.md).
- **A Mesh Health panel** reporting all of the above with per-component detail,
  and **viewport overlays** highlighting boundary edges, non-manifold edges,
  winding conflicts, and degenerate triangles.
- **Analysis progress and cancellation**, with a report that can never be
  attached to a model it does not describe.
- **STL export**, binary and ASCII, written locally with no network involvement
  and no gating. Both writers round-trip exactly through our own parser, which
  is asserted in tests.
- Filename screening at the UI boundary — extension and declared size. **This is
  a usability filter, not a security control, and it reads no file contents.**
- The canonical mesh contract (`packages/mesh-core`) and structural mesh
  validation.
- A typed worker protocol with request correlation, progress reporting,
  cooperative cancellation, structured errors, and buffer transfer
  (`packages/geometry-runtime`), plus a working geometry worker.
- A runtime self-test that transfers a buffer to the worker and back and
  verifies it against a checksum computed before the transfer. This is a
  diagnostic, not a geometry feature.
- A typed application error foundation.
- Strict TypeScript, type-aware linting, formatting, unit tests, end-to-end
  tests, and CI.

### Not implemented

- **No OBJ or 3MF parser or writer.** Only STL is implemented. Dropping an
  `.obj` or `.3mf` file says so plainly instead of starting an import that
  cannot finish, and a test asserts the declared capabilities match the codecs
  that actually register.
- **No format conversion.** STL in, STL out is re-export, not conversion, and
  the Convert workflow stays disabled until a second format exists.
- **No mesh repair, boolean operations, splitting, connectors, displacement,
  hollowing, or drainage holes.** Import deliberately does not weld vertices,
  drop degenerate triangles, deduplicate facets, reorient winding, or rescale
  anything — see
  [ADR 0007](docs/adr/0007-stl-preservation-policy.md). Parsing is not repair.
- **No geometry kernel.** No Manifold, Geogram, lib3mf, OpenVDB, CGAL, or
  OpenCascade — these need licence and WASM-portability evaluation first. The
  licence question is per-kernel (and for CGAL, per package); see
  [Geometry kernel licensing](docs/DEPENDENCIES.md#geometry-kernel-licensing).
- **No self-intersection detection.** No triangle/triangle intersection test
  exists. A model with zero topological defects can still pass through itself,
  and the interface says so on every report rather than in a footnote.
- **No wall-thickness analysis**, and therefore **no printability verdict**. The
  report's printability status is never "printable"; the most it says is "not
  yet determined".
- **No tolerance welding.** Two corners one float apart are two vertices, and
  the edge between them is reported as a boundary. That is what the file says.
  A future repair step will offer welding explicitly, with a stated tolerance
  and an undo — not as an invisible side effect of opening a file.
- **No mesh repair of any kind.** Diagnostics identify defects; nothing fixes
  them.
- **No units for STL.** STL files carry no unit, so CAD Fixer reports
  "Unspecified by STL" rather than assuming millimetres.
- **No accounts, authentication, payments, pricing, or download gating.** Usage
  is completely open.
- **No analytics or telemetry of any kind.**
- **No persistence.** Nothing is saved between sessions.

## Architecture at a glance

```
apps/web/                   React shell, Three.js viewport, worker transport
packages/shared/            typed errors, units, ids, cancellation
packages/mesh-core/         canonical mesh + structural validation
packages/file-formats/      format descriptors, screening, codec seams
packages/geometry-runtime/  worker protocol, coordinator, worker host
```

Two rules shape the layout:

1. **The UI layer does not own geometry algorithms.** React components render
   state and dispatch intents; they never parse or transform meshes.
2. **Heavy geometry work never runs on the UI thread.**

Both are enforced by tooling: `packages/**` cannot import React or Three.js
(ESLint), and the geometry packages are tested under Node with no DOM at all, so
a browser dependency breaks the test run.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers, boundaries, module
  responsibilities
- [docs/PRIVACY_ARCHITECTURE.md](docs/PRIVACY_ARCHITECTURE.md) — network policy
  and how it is enforced
- [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) — every dependency, its purpose
  and licence
- [docs/DEPLOYMENT_REQUIREMENTS.md](docs/DEPLOYMENT_REQUIREMENTS.md) — required
  hosting headers
- [docs/adr/](docs/adr/) — architecture decision records
- [CLAUDE.md](CLAUDE.md) — working rules for this repository

## Known issues

- The main JavaScript bundle is ~724 kB raw (~195 kB gzipped), dominated by
  Three.js. Acceptable for a professional tool; worth code-splitting if first
  load becomes a concern.
- The viewport has no camera controls yet. It is a shell.
- Component tests run in jsdom, which has no WebGL and no `Worker`; both are
  stubbed. Real rendering and worker behaviour are covered by the Playwright
  suite instead.
- The Float32 vs Float64 choice for vertex positions is deliberately unresolved
  pending benchmarks — see
  [ADR 0004](docs/adr/0004-canonical-mesh-model.md).

## Licence

Not yet determined. This project is intended to become a proprietary commercial
application, and dependency licences are vetted on that basis.
