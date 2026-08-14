# Dependencies

Every dependency must justify its presence. This file records what we use, why,
and the licence risk.

**Licence policy.** CAD Fixer is intended to become a proprietary commercial
application. Runtime dependencies must therefore carry licences compatible with
that intent — permissive ones (MIT, Apache-2.0, BSD, ISC) need no further
analysis. **No GPL or AGPL code may be copied into the project, and no GPL/AGPL
runtime dependency may be added without explicit written approval from the
product owner.** Copyleft licences that are not outright GPL/AGPL (notably LGPL,
and LGPL with linking exceptions) are not automatically disqualifying, but they
carry obligations that must be evaluated for our specific distribution model
before adoption. See [Geometry kernel licensing](#geometry-kernel-licensing).

Versions below are the ranges declared in `package.json`, verified against the
npm registry on 2026-08-14. Licences were read from published package metadata.

## Runtime dependencies

| Package     | Version  | Purpose                | Source                                                           | Licence | Why this one                                                                                           | Risks                                                                                                                                                                                                                                                                             |
| ----------- | -------- | ---------------------- | ---------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react`     | ^19.2.8  | UI rendering           | [github.com/facebook/react](https://github.com/facebook/react)   | MIT     | Mandated stack. `useSyncExternalStore` gives us a framework-free state layer with a supported binding. | Large ecosystem surface; we use the core only.                                                                                                                                                                                                                                    |
| `react-dom` | ^19.2.8  | DOM renderer for React | same as above                                                    | MIT     | Required companion to `react`.                                                                         | None beyond React itself.                                                                                                                                                                                                                                                         |
| `three`     | ^0.185.1 | WebGL viewport         | [github.com/mrdoob/three.js](https://github.com/mrdoob/three.js) | MIT     | Mandated stack; the practical choice for browser 3D. Actively maintained.                              | **Ships no TypeScript types** — `@types/three` is required and versioned separately. Unstable minor-version API (`0.x`); upgrades need review. Dominates bundle size (see Known Issues in the README). Confined to `apps/web/src/viewport`; the mesh model does not depend on it. |

That is the entire runtime dependency list. Notably absent:

- **No state management library.** The workspace store is ~90 lines over
  `useSyncExternalStore`. A dependency would not earn its place at this size.
- **No UI component library.** The shell is plain semantic HTML and CSS.
- **No router.** The application is a single workspace view.
- **No HTTP client.** By design — CAD Fixer makes no network requests.
- **No geometry kernel.** Manifold, Geogram, lib3mf, OpenVDB, CGAL, and
  OpenCascade are all deliberately absent. They are evaluated separately, with
  licensing as a first-class criterion — see below.
- **No third-party STL parser.** The STL codec in `packages/file-formats` is our
  own. Parsing is the trusted boundary for hostile input; we do not delegate it,
  and specifically do not use Three.js's `STLLoader`, which is a rendering
  convenience rather than a validating parser.

## Geometry kernel licensing

No geometry kernel is installed, and none may be added without an explicit
decision. This section records what the licences actually say, because an
earlier draft of this document flattened them into "GPL/AGPL, therefore
unusable", which is not accurate for either CGAL or OCCT.

**This is an engineering summary of upstream licence text, not legal advice.**
Anything adopted needs review by someone qualified, against our actual
distribution model.

### CGAL — licensing is per package

CGAL is not under a single licence. Upstream states that some parts are
available under the LGPL and other parts under the GPL, and the per-package
licence is listed in CGAL's Package Overview.

- The **kernel and support libraries** are LGPL, deliberately chosen as the less
  constraining licence so others can build on top.
- **Advanced algorithms and data structures** are typically GPL, to protect
  their commercial value.
- Using a **GPL-covered CGAL package** in proprietary distributed software
  requires GPL compliance — which for a proprietary product generally means
  obtaining a commercial licence instead. GeometryFactory sells commercial CGAL
  licences precisely for the case where the open-source terms do not work.
- Using only **LGPL-covered CGAL packages** is a materially different analysis
  from the GPL case and must be evaluated on its own terms.

Practical consequence: "can we use CGAL?" is not answerable in general. It is
answerable only for the specific packages an algorithm needs.

Source: <https://www.cgal.org/license.html> (checked 2026-08-14).

### OCCT — LGPL 2.1 with an additional exception

Open CASCADE Technology is distributed under **LGPL 2.1 plus an additional
exception** (`OCCT_LGPL_EXCEPTION.txt` in the distribution). The exception
covers, among other things, distributing object code incorporating material from
OCCT header files under terms of your choice given prominent notice, and
combining or linking a "work that uses the Library" and distributing that work
under terms of your choice — provided those terms permit modification for the
customer's own use and reverse engineering for debugging such modifications.

That is not the same as "unusable in a proprietary product". It does carry
obligations that must be evaluated for our distribution model, and the
reverse-engineering-for-debugging condition in particular deserves attention.
Open Cascade also offers commercial arrangements if the open-source obligations
turn out to be undesirable.

Note for this project specifically: LGPL's relinking/modification expectations
were written for native dynamic linking. How they apply to a **statically linked
WebAssembly bundle shipped to a browser** is a question that must be answered
before adoption, not after.

Sources: <https://github.com/Open-Cascade-SAS/OCCT>,
<https://occt3d.com/open-cascade-technology/index.html> (checked 2026-08-14).

### Others not yet evaluated

Manifold, Geogram, lib3mf, and OpenVDB have not been assessed. Each needs the
same treatment — current upstream licence text, read against our distribution
model — before it can be considered.

## Development dependencies

| Package                            | Version            | Purpose                    | Licence    | Why this one                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Risks                                                                                       |
| ---------------------------------- | ------------------ | -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `typescript`                       | ~6.0.3             | Type system                | Apache-2.0 | **Pinned to the 6.x line deliberately.** TypeScript 7.0 is the Go-native port and does not yet expose a stable programmatic compiler API, so typescript-eslint cannot use it (`typescript-eslint` declares `typescript: >=4.8.4 <6.1.0`; TS 7 support is [open issue #12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518)). Choosing TS 7 today means losing type-aware linting. See [ADR 0006](adr/0006-typescript-version-line.md). | We are one major version behind current. Revisit when typescript-eslint ships TS 7 support. |
| `vite`                             | ^8.2.1             | Dev server and bundler     | MIT        | Mandated stack. First-class module-worker and WASM support; `server.headers`/`preview.headers` let us reproduce cross-origin isolation locally.                                                                                                                                                                                                                                                                                                               | Fast major-version cadence.                                                                 |
| `@vitejs/plugin-react`             | ^6.0.5             | React fast refresh and JSX | MIT        | Official React plugin for Vite. Its Babel peers are optional and unused.                                                                                                                                                                                                                                                                                                                                                                                      | Tied to Vite majors.                                                                        |
| `vitest`                           | ^4.1.10            | Unit and component tests   | MIT        | Mandated stack. Shares Vite's transform pipeline, so tests and build agree. `projects` separates the DOM-free packages from the jsdom app.                                                                                                                                                                                                                                                                                                                    | None material.                                                                              |
| `@playwright/test`                 | ^1.62.1            | End-to-end tests           | Apache-2.0 | Mandated stack. The only way to verify real WebGL, real module workers, real buffer transfer, and the isolation headers.                                                                                                                                                                                                                                                                                                                                      | Downloads a browser binary; CI needs `playwright install`.                                  |
| `eslint`                           | ^10.8.1            | Linting                    | MIT        | Mandated stack.                                                                                                                                                                                                                                                                                                                                                                                                                                               | Flat config only; legacy plugin shapes are rejected (see `eslint.config.js`).               |
| `typescript-eslint`                | ^8.67.0            | TypeScript lint rules      | MIT        | Type-aware rules catch real defects (floating promises, unsafe `any` flow) that syntax-only linting cannot.                                                                                                                                                                                                                                                                                                                                                   | Constrains our TypeScript version — see above.                                              |
| `eslint-plugin-react-hooks`        | ^7.1.1             | Hook correctness rules     | MIT        | Catches effect and dependency mistakes. Its flat config lives at `configs.flat[...]`.                                                                                                                                                                                                                                                                                                                                                                         | Version 7 adds stricter compiler-era rules.                                                 |
| `eslint-config-prettier`           | ^10.1.8            | Disables formatting rules  | MIT        | Prevents lint and formatter from fighting.                                                                                                                                                                                                                                                                                                                                                                                                                    | None.                                                                                       |
| `@eslint/js`                       | ^10.0.1            | Base JS rules              | MIT        | Baseline correctness rules.                                                                                                                                                                                                                                                                                                                                                                                                                                   | None.                                                                                       |
| `globals`                          | ^17.11.0           | Environment global lists   | MIT        | Declares browser vs Node globals per file group.                                                                                                                                                                                                                                                                                                                                                                                                              | None.                                                                                       |
| `prettier`                         | ^3.9.6             | Formatting                 | MIT        | Mandated stack. Removes formatting from review.                                                                                                                                                                                                                                                                                                                                                                                                               | None.                                                                                       |
| `jsdom`                            | ^30.0.1            | DOM for component tests    | MIT        | Needed by the `web` Vitest project.                                                                                                                                                                                                                                                                                                                                                                                                                           | No WebGL and no `Worker`; both are stubbed and the gap is covered by Playwright.            |
| `@testing-library/react`           | ^16.3.2            | Component testing          | MIT        | Encourages testing behaviour through the accessibility tree rather than implementation.                                                                                                                                                                                                                                                                                                                                                                       | None.                                                                                       |
| `@testing-library/jest-dom`        | ^7.0.1             | DOM assertions             | MIT        | Readable assertions such as `toBeDisabled`.                                                                                                                                                                                                                                                                                                                                                                                                                   | None.                                                                                       |
| `@types/node`                      | ^26.2.0            | Node types for tooling     | MIT        | Types for config files and Playwright specs.                                                                                                                                                                                                                                                                                                                                                                                                                  | Scoped to the root tsconfig; not visible to app or package code.                            |
| `@types/react`, `@types/react-dom` | ^19.2.18 / ^19.2.4 | React types                | MIT        | React ships no types.                                                                                                                                                                                                                                                                                                                                                                                                                                         | None.                                                                                       |
| `@types/three`                     | ^0.185.4           | Three.js types             | MIT        | `three` ships no types.                                                                                                                                                                                                                                                                                                                                                                                                                                       | Versioned separately from `three`; the two can drift.                                       |

## Verification performed

For each package above we confirmed the current published version, the official
repository, that it is actively maintained (all had releases within the past
year; most within weeks), and the declared licence. `npm audit` reports **0
vulnerabilities**.

No GPL or AGPL dependency is present in the tree, at runtime or in development.

## Adding a dependency

1. Establish that the need is real now, not speculative.
2. Check maintenance status and the official source.
3. Record the licence and confirm it permits proprietary commercial use.
4. For anything significant, write an ADR.
5. Add a row here.
6. For a **runtime** dependency, also confirm it does not break cross-origin
   isolation — anything loading a cross-origin resource without CORP will.
