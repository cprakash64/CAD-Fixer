# CAD Fixer

A local-first, browser-based tool for repairing and preparing 3D printing
meshes.

**Your models never leave your machine.** Files are read, processed, and
exported entirely in the browser using Web Workers, WebAssembly, and your own
CPU and GPU. There is no server-side geometry processing, no upload endpoint,
and no analytics.

> **Current status: Stage 0 — engineering foundation.**
> The application shell runs, but **no mesh processing is implemented yet.** See
> [What is and is not implemented](#what-is-and-is-not-implemented). Nothing in
> this repository fakes a working feature.

## Planned workflows

| Workflow | Purpose                                                 | Status          |
| -------- | ------------------------------------------------------- | --------------- |
| Repair   | Close holes, fix normals, resolve non-manifold geometry | Not implemented |
| Convert  | Translate between STL, OBJ, and 3MF                     | Not implemented |
| Split    | Cut oversized models into parts and add connectors      | Not implemented |
| Texture  | Apply surface displacement patterns                     | Not implemented |
| Hollow   | Hollow solid models and place drainage holes            | Not implemented |

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

- Application shell: header, workflow navigation, workspace, drag-and-drop
  intake area, status log.
- An empty 3D viewport (Three.js) with correct renderer lifecycle, resize
  handling, context-loss handling, and disposal. There is no model to display
  and no camera interaction yet.
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

- **No STL, OBJ, or 3MF parser or writer.** The format registry is empty, and a
  test enforces that so a stub cannot quietly make the app look functional.
- **No model import.** Dropping a `.stl` file screens the name and then tells
  you import is not implemented. It does not read the file.
- **No mesh repair, boolean operations, conversion, splitting, connectors,
  displacement, hollowing, or drainage holes.**
- **No geometry kernel.** No Manifold, Geogram, lib3mf, OpenVDB, CGAL, or
  OpenCascade — these need licence and WASM-portability evaluation first.
- **No topological validation.** Structural validation checks buffer and index
  integrity, not manifoldness or self-intersection.
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
