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
- **Exactly ONE geometry kernel, and only inside one worker.** As of Stage
  3C-1B, Geogram v1.10.0 ships — compiled to WebAssembly and imported by the
  disposable self-intersection diagnostic worker, and by nothing else. Manifold,
  lib3mf, OpenVDB, CGAL and OpenCascade remain deliberately absent. See
  "Geogram, as shipped" below; the rest are evaluated separately, with licensing
  as a first-class criterion.
- **No third-party STL parser.** The STL codec in `packages/file-formats` is our
  own. Parsing is the trusted boundary for hostile input; we do not delegate it,
  and specifically do not use Three.js's `STLLoader`, which is a rendering
  convenience rather than a validating parser.

## Geogram, as shipped

**This section describes code that is distributed to users**, unlike the
research artifacts under `experiments/`.

|                |                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Version        | v1.10.0                                                                                                                  |
| Commit         | `c8529bb00838186938ab31d96008a59b6a892dee`                                                                               |
| Toolchain      | emsdk 4.0.16                                                                                                             |
| Where          | `packages/self-intersection-kernel/artifacts/self-intersection.wasm`                                                     |
| Reachable from | `apps/web/src/workers/self-intersection.worker.ts` and `apps/web/src/workers/hole-fill-narrowphase.ts`, and nothing else |
| Licence        | **BSD-3-Clause** (core)                                                                                                  |

**Why this is licence-clean.** Geogram's distribution bundles TetGen (AGPL-3.0)
and Triangle (non-free), neither of which may enter a proprietary product.
`GEOGRAM_WITH_TETGEN=OFF` and `GEOGRAM_WITH_TRIANGLE=OFF` exclude both at
configure time, and `packages/self-intersection-kernel/build.sh` runs the
build-input audit **and** scans the emitted artifact, refusing to produce one if
either check fails. The shipped `.wasm` contains zero `tetgenmesh`, `tetgenio`
or `triangulateio` symbols.

**Attribution obligation.** BSD-3-Clause requires the copyright notice and
licence text to accompany binary distributions. Geogram's notice travels with
the pinned source under `experiments/repair-kernels/geogram/upstream/`; a
user-facing acknowledgement must accompany any public deployment of the built
application. **This is an open obligation for whoever first deploys publicly —
it is not discharged by this file.**

zlib is also linked (Geogram satisfies `<zlib.h>` from its own bundled copy) and
carries the permissive zlib licence's attribution requirement.

**Stage 4B-1B1 added a second entry point to the SAME artifact, not a second
kernel.** `cf_hf_begin` / `cf_hf_classify` / `cf_hf_end` classify a
caller-supplied list of face pairs and attribute each finding to patch/source or
patch/patch, reusing Geogram's exact `triangles_intersections` and CAD Fixer's
own frozen classifier unchanged. Nothing new is linked, no build option changed,
and `si_core.h` and `si_bvh.h` stay byte-identical to the research copies. The
build was verified REPRODUCIBLE first: rebuilding the unchanged source produced
byte-identical output (`self-intersection.js` SHA-256
`5829ce696e614eb295d2af8da5abfa7e52e6499dafa4060aed76c52d3813936d`,
`self-intersection.wasm` SHA-256
`8f6b3fa78be55078780615ed2118d4446422030734d413d9e3b9ea4be582482f`), so the
artifact that ships now differs from the qualified one only by the code that was
deliberately added.

**PMP does not ship, and Stage 4B-1B1 is where that was decided rather than
assumed.** ADR 0018 qualified `pmp::fill_hole` and rejected it: it traps
uncatchably inside the module on a legal 512-vertex loop, loses append-only
provenance, refines a 128-vertex loop by +1,193 vertices, and times out at
2,000. CAD Fixer's own ear clipping is the production triangulator, and a
boundary test scans for PMP imports and artifacts in every shipped package.

## Geometry kernel licensing

**Geogram is the only kernel that ships** (see above). No OTHER geometry kernel
is installed, and none may be added without an explicit decision. This section
records what the licences actually say, because an earlier draft of this
document flattened them into "GPL/AGPL, therefore unusable", which is not
accurate for either CGAL or OCCT.

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

| Package                            | Version            | Purpose                    | Licence           | Why this one                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Risks                                                                                                                                     |
| ---------------------------------- | ------------------ | -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`                       | ~6.0.3             | Type system                | Apache-2.0        | **Pinned to the 6.x line deliberately.** TypeScript 7.0 is the Go-native port and does not yet expose a stable programmatic compiler API, so typescript-eslint cannot use it (`typescript-eslint` declares `typescript: >=4.8.4 <6.1.0`; TS 7 support is [open issue #12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518)). Choosing TS 7 today means losing type-aware linting. See [ADR 0006](adr/0006-typescript-version-line.md). | We are one major version behind current. Revisit when typescript-eslint ships TS 7 support.                                               |
| `vite`                             | ^8.2.1             | Dev server and bundler     | MIT               | Mandated stack. First-class module-worker and WASM support; `server.headers`/`preview.headers` let us reproduce cross-origin isolation locally.                                                                                                                                                                                                                                                                                                               | Fast major-version cadence.                                                                                                               |
| `@vitejs/plugin-react`             | ^6.0.5             | React fast refresh and JSX | MIT               | Official React plugin for Vite. Its Babel peers are optional and unused.                                                                                                                                                                                                                                                                                                                                                                                      | Tied to Vite majors.                                                                                                                      |
| `vitest`                           | ^4.1.10            | Unit and component tests   | MIT               | Mandated stack. Shares Vite's transform pipeline, so tests and build agree. `projects` separates the DOM-free packages from the jsdom app.                                                                                                                                                                                                                                                                                                                    | None material.                                                                                                                            |
| `@playwright/test`                 | ^1.62.1            | End-to-end tests           | Apache-2.0        | Mandated stack. The only way to verify real WebGL, real module workers, real buffer transfer, and the isolation headers.                                                                                                                                                                                                                                                                                                                                      | Downloads a browser binary; CI needs `playwright install`.                                                                                |
| `eslint`                           | ^10.8.1            | Linting                    | MIT               | Mandated stack.                                                                                                                                                                                                                                                                                                                                                                                                                                               | Flat config only; legacy plugin shapes are rejected (see `eslint.config.js`).                                                             |
| `typescript-eslint`                | ^8.67.0            | TypeScript lint rules      | MIT               | Type-aware rules catch real defects (floating promises, unsafe `any` flow) that syntax-only linting cannot.                                                                                                                                                                                                                                                                                                                                                   | Constrains our TypeScript version — see above.                                                                                            |
| `eslint-plugin-react-hooks`        | ^7.1.1             | Hook correctness rules     | MIT               | Catches effect and dependency mistakes. Its flat config lives at `configs.flat[...]`.                                                                                                                                                                                                                                                                                                                                                                         | Version 7 adds stricter compiler-era rules.                                                                                               |
| `eslint-config-prettier`           | ^10.1.8            | Disables formatting rules  | MIT               | Prevents lint and formatter from fighting.                                                                                                                                                                                                                                                                                                                                                                                                                    | None.                                                                                                                                     |
| `@eslint/js`                       | ^10.0.1            | Base JS rules              | MIT               | Baseline correctness rules.                                                                                                                                                                                                                                                                                                                                                                                                                                   | None.                                                                                                                                     |
| `globals`                          | ^17.11.0           | Environment global lists   | MIT               | Declares browser vs Node globals per file group.                                                                                                                                                                                                                                                                                                                                                                                                              | None.                                                                                                                                     |
| `prettier`                         | ^3.9.6             | Formatting                 | MIT               | Mandated stack. Removes formatting from review.                                                                                                                                                                                                                                                                                                                                                                                                               | None.                                                                                                                                     |
| `jsdom`                            | ^30.0.1            | DOM for component tests    | MIT               | Needed by the `web` Vitest project.                                                                                                                                                                                                                                                                                                                                                                                                                           | No WebGL and no `Worker`; both are stubbed and the gap is covered by Playwright.                                                          |
| `@testing-library/react`           | ^16.3.2            | Component testing          | MIT               | Encourages testing behaviour through the accessibility tree rather than implementation.                                                                                                                                                                                                                                                                                                                                                                       | None.                                                                                                                                     |
| `@testing-library/jest-dom`        | ^7.0.1             | DOM assertions             | MIT               | Readable assertions such as `toBeDisabled`.                                                                                                                                                                                                                                                                                                                                                                                                                   | None.                                                                                                                                     |
| `@types/node`                      | ^26.2.0            | Node types for tooling     | MIT               | Types for config files and Playwright specs.                                                                                                                                                                                                                                                                                                                                                                                                                  | Scoped to the root tsconfig; not visible to app or package code.                                                                          |
| `@types/react`, `@types/react-dom` | ^19.2.18 / ^19.2.4 | React types                | MIT               | React ships no types.                                                                                                                                                                                                                                                                                                                                                                                                                                         | None.                                                                                                                                     |
| `@types/three`                     | ^0.185.4           | Three.js types             | MIT               | `three` ships no types.                                                                                                                                                                                                                                                                                                                                                                                                                                       | Versioned separately from `three`; the two can drift.                                                                                     |
| `wrangler`                         | 4.131.1 (exact)    | Cloudflare deployment CLI  | MIT OR Apache-2.0 | **Deployment tooling only — see the section below.** The supported way to upload CAD Fixer's static assets to Cloudflare Workers Static Assets and to separate version upload from production deployment. Pinned EXACTLY, not with a caret: a release pipeline whose tool floats is not a reproducible release pipeline.                                                                                                                                      | Large transitive tree (`workerd`, `esbuild`, `miniflare`), none of which reaches a browser. Fast release cadence; the pin is the control. |

## Deployment tooling is not a runtime dependency

`wrangler` is the only provider tool in this repository, and the distinction
matters enough to state rather than imply:

- **It ships no byte to a browser.** No `apps/**` or `packages/**` source file
  imports it, it is absent from every bundle, and removing it would not change a
  single hash in `apps/web/dist`.
- **It is not a Cloudflare runtime SDK.** No `@cloudflare/workers-types`, no KV,
  D1, R2 or Durable Object client, and no Worker framework is installed, because
  CAD Fixer runs no Cloudflare Worker code at all — see
  [Stage 5C-1A](release/STAGE_5C1A_HOST_SELECTION.md) and
  [Stage 5C-1B1](release/STAGE_5C1B1_CLOUDFLARE_PREVIEW.md).
- **Licence: MIT OR Apache-2.0.** Permissive, dual-licensed, and compatible with
  a proprietary commercial product. No copyleft obligation, at the top level or
  in its tree.
- **Node requirement `>=22.0.0`**, satisfied by the repository's pinned 22.22.2.
- **Telemetry is disabled.** Wrangler collects anonymous usage telemetry by
  default. It concerns CLI usage rather than user geometry, so it is not a
  privacy breach of the product's guarantee — but a repository that bans network
  APIs repo-wide should not quietly run a phoning-home build tool either, so it
  is turned off (`wrangler telemetry disable`, overridable per project with
  `WRANGLER_SEND_METRICS=false`).

If a future task proposes a Cloudflare _runtime_ package, that is a different
decision with a different risk profile, and it must be argued separately — the
static-only architecture is what keeps the `_headers` isolation contract
load-bearing.

## Verification performed

For each package above we confirmed the current published version, the official
repository, that it is actively maintained (all had releases within the past
year; most within weeks), and the declared licence.

**No GPL, AGPL or SSPL dependency is present in the tree, at runtime or in
development.** A whole-tree licence scan is the evidence, not an assumption.

### One LGPL package, in deployment tooling only (Stage 5C-1B1)

That scan does find one copyleft package, and it is recorded rather than
rounded away:

```
wrangler → miniflare → sharp → @img/sharp-libvips-darwin-arm64  (LGPL-3.0-or-later)
```

`CLAUDE.md` rule 17 says LGPL "is not automatically disqualifying but carries
obligations that must be evaluated first", so it was evaluated:

- **It is not in the product.** `apps/web/dist` is 8 files — HTML, JS, CSS and
  the Geogram WASM. None of libvips is in any of them, and removing `wrangler`
  would not change one hash.
- **We do not distribute it.** LGPL obligations attach on distribution of the
  library. This is a native binary npm installs locally for each developer; CAD
  Fixer redistributes nothing.
- **It arrives through `miniflare`**, Wrangler's LOCAL dev simulator, which the
  deployment path (`wrangler deploy`, `wrangler versions upload`) does not use.

**Conclusion: no LGPL obligation attaches to the CAD Fixer product.** If the
shipped application ever gained a dependency under any copyleft licence, that
would be a different decision requiring explicit approval.

### Known advisories

`npm audit` currently reports **2 moderate advisories, both in `vitest` /
`@vitest/mocker` 4.1.10**. They are test-runner advisories that **predate the
Wrangler addition and are unrelated to it**: the lockfile pinned `vitest@4.1.10`
before and after, and `wrangler` does not depend on `vitest`. They affect no
shipped code. Tracked for a routine test-tooling upgrade rather than fixed under
a deployment task, because an unrelated major-version bump inside a release
qualification is how a release qualification stops proving anything.

## Adding a dependency

1. Establish that the need is real now, not speculative.
2. Check maintenance status and the official source.
3. Record the licence and confirm it permits proprietary commercial use.
4. For anything significant, write an ADR.
5. Add a row here.
6. For a **runtime** dependency, also confirm it does not break cross-origin
   isolation — anything loading a cross-origin resource without CORP will.
