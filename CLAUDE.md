# CAD Fixer — Project Rules

Read this before changing anything. These rules exist to prevent architectural
drift across sessions.

## What this is

**CAD Fixer is production software, not a prototype.** It is a local-first,
browser-based tool for repairing and preparing 3D printing meshes, intended to
become a commercial product. Code quality, correctness, and privacy guarantees
matter more than moving fast.

Five workflows are planned: **Repair, Convert, Split, Texture, Hollow**. Target
formats: **STL, OBJ, 3MF**.

**Current stage: Stage 2 complete — resident geometry runtime and topology
diagnostics.**
Implemented: structural STL encoding detection, hand-written binary and ASCII
STL parsers with resource budgets, worker-based parsing with progress and
working cancellation, a real Three.js viewport with camera controls, model
statistics, binary/ASCII STL export that round-trips through our own parser,
worker-resident authoritative geometry addressed by handle+revision, and
read-only topology diagnostics with a Mesh Health panel and viewport overlays.

NOT implemented, and not to be implemented unless a task explicitly asks: mesh
repair, tolerance welding, hole filling, booleans, remeshing, OBJ or 3MF codecs,
format conversion, splitting, connectors, texturing, hollowing, drainage holes,
self-intersection detection, and wall-thickness analysis.

**Topology diagnoses; it never repairs.** Connectivity is recovered from exact
stored coordinates with no tolerance, and analysis leaves the canonical buffers
byte-identical. See `docs/adr/0009-exact-topology-recovery.md`.

**Parsing is not repair.** Import preserves exactly what the file contains — no
welding, no dropping degenerate or duplicate triangles, no reorientation, no
rescaling, no invented units. See `docs/adr/0007-stl-preservation-policy.md`.

## Non-negotiable rules

1. **Production software, not a prototype.** No throwaway code, no "we'll fix it
   later" shortcuts in committed work.
2. **Raw user geometry stays local by default.** Never add code that transmits a
   user's model, or anything derived from it, anywhere.
3. **No backend geometry processing.** No server-side geometry, no file upload
   endpoint. The application is a static site.
4. **Never do expensive geometry work on the UI thread.** Parsing, validation,
   repair, booleans, subdivision, displacement, hollowing, and export run in
   workers. If it touches a whole mesh, it belongs off-thread.
5. **Do not invent third-party APIs.** If you are not certain a function,
   option, or export exists, verify it.
6. **Verify unfamiliar or current APIs against primary documentation** — official
   docs, the package's own type definitions, or the registry — before relying on
   them. Package APIs and versions change.
7. **Prefer explicit types.** Especially at module boundaries and in exported
   signatures.
8. **Avoid `any`.** If it is genuinely unavoidable, document why in a comment at
   the site. A narrow, explained `as` assertion is preferable to `any`.
9. **Never suppress a TypeScript, compiler, or linter failure to make CI pass.**
   No `@ts-ignore`, no `eslint-disable`, no weakening `tsconfig` strictness. Fix
   the cause. If a rule is genuinely wrong for the codebase, change it
   deliberately in the config with a comment explaining why.
10. **Never silently catch errors.** No empty `catch`. Every caught error is
    either handled meaningfully, converted with `toAppError`, or rethrown.
11. **Geometry results require post-operation validation.** Returning a mesh is
    not success. Pass output through `assertMeshStructure` before accepting it —
    including output from a WASM kernel that reports success.
12. **Do not silently modify user geometry.** An operation that may materially
    change a model must state what it will change, expose warnings, support
    cancellation where feasible, preserve an undoable previous state, and
    validate its result.
13. **Add a test for every bug fix**, reproducing the bug.
14. **Do not weaken a test to make it pass.** If a test fails because behaviour
    legitimately changed, update it to assert the _new_ behaviour precisely —
    never by loosening an assertion or deleting a case.
15. **Keep dependencies minimal.** Every runtime dependency needs a reason to
    exist now, not a speculative one.
16. **Check licences before adding a significant dependency**, and record it in
    `docs/DEPENDENCIES.md`.
17. **No GPL/AGPL runtime code without explicit approval.** This product is
    intended to be proprietary. Copyleft that is not GPL/AGPL (LGPL, LGPL with a
    linking exception) is not automatically disqualifying but carries obligations
    that must be evaluated first. Geometry kernel licensing is per-kernel and,
    for CGAL, **per package** — read
    `docs/DEPENDENCIES.md#geometry-kernel-licensing` rather than assuming.
18. **Preserve the UI/geometry separation.** React components do not own
    geometry algorithms. `packages/**` must not import React or Three.js, and
    must never import from `apps/**`.
19. **Run the relevant checks before declaring work complete** (see below). Do
    not report that checks passed unless you actually ran them.
20. **Report assumptions and unresolved risks** rather than hiding them.

## Repository layout

```
apps/web/                   React application shell
  src/components/           presentation only
  src/state/                framework-free workspace store
  src/runtime/              the ONLY place a Worker is constructed
  src/viewport/             Three.js scene lifecycle
  src/workers/              worker entry point (own tsconfig: WebWorker lib)
packages/shared/            typed errors, units, ids, cancellation
packages/mesh-core/         canonical mesh + structural validation
packages/file-formats/      format descriptors, screening, budgets, STL codec
packages/mesh-topology/     read-only topology analysis (no mutation, no welding)
packages/geometry-runtime/  worker protocol, coordinator, worker host
docs/                       architecture, dependencies, privacy, deployment
docs/adr/                   architecture decision records
e2e/                        Playwright specs
```

Dependency direction is one-way:
`shared ← mesh-core ← file-formats`, `shared ← mesh-core ← mesh-topology`,
`shared ← mesh-core ← mesh-topology ← geometry-runtime`, all ← `apps/web`.
`geometry-runtime` gained a `mesh-core` dependency in Stage 1 because geometry
operations speak `CanonicalMesh`, and a **type-only** `mesh-topology` dependency
in Stage 2 because `model/analyze` returns a topology report and an untyped
result at that boundary would let the worker and its consumer drift apart. It
must NOT depend on `file-formats`, so codecs stay behind the worker's operation
handlers.

## Commands

```bash
npm install          # install from the lockfile
npm run dev          # dev server (cross-origin isolated)
npm run build        # production build
npm run preview      # serve the production build on :4173
npm run lint         # ESLint
npm run format:check # Prettier check
npm run typecheck    # TypeScript, all projects
npm test             # Vitest unit and component tests
npm run test:e2e     # Playwright end-to-end (needs `npx playwright install chromium`)
npm run verify       # format:check + lint + typecheck + test + build
npm run bench:stl      # STL parser benchmark (NOT in CI)
npm run bench:topology # small topology benchmark (NOT in CI)
npm run bench:pipeline # whole-pipeline benchmark, 1/10/50/100 MiB (NOT in CI)
npm run check:node     # runtime version guard; also runs before test/build/verify
```

Before declaring work complete, run `npm run verify`. Run `npm run test:e2e` as
well when you have touched the shell, the worker, or the build.

## Things that will trip you up

- **TypeScript is pinned to `~6.0.3` on purpose.** TS 7 exists but
  typescript-eslint does not support it yet, so upgrading loses type-aware
  linting. See `docs/adr/0006-typescript-version-line.md`. Do not bump it.
- **`erasableSyntaxOnly` is on**: no `enum`, no `namespace`, no constructor
  parameter properties. Use `as const` objects with a matching type alias.
- **`noUncheckedIndexedAccess` is on**: indexing a typed array yields
  `number | undefined`. Prefer iterating (`for (const v of arr)`), which yields
  `number` and is faster.
- **`exactOptionalPropertyTypes` is on**: you cannot assign `undefined` to an
  optional property. Build objects conditionally
  (`...(x === undefined ? {} : { x })`).
- **Worker code has its own tsconfig** at `apps/web/src/workers/tsconfig.json`
  (WebWorker lib). The app tsconfig excludes that directory, because DOM and
  WebWorker globals conflict.
- **Network APIs are lint errors.** `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource`, and `navigator.sendBeacon` are banned repo-wide. This is
  deliberate — see `docs/PRIVACY_ARCHITECTURE.md`. Do not work around it.
- **`eslint-plugin-react-hooks` flat config lives at `configs.flat[...]`**; the
  top-level `configs[...]` entries are the legacy shape and ESLint 10 rejects
  them.
- **Transferred buffers are detached.** After transferring a buffer to a worker,
  the sender's view is unusable. Use the buffer from the result.
- **A synchronous worker handler cannot be cancelled.** The cancel arrives as a
  message and cannot be read until the handler returns to the event loop, so a
  polled flag never changes. Long loops must `await context.yieldToEventLoop()`
  between batches. Use the `MessageChannel` yield, not `setTimeout` (clamped to
  ~4 ms when nested).
- **Format capability on the main thread comes from
  `file-formats/capabilities`, not the registry.** Codecs register inside the
  worker, so the main-thread registry is empty by design. A test keeps the
  declaration and the registry in agreement.
- **`ByteScanner.isAtEnd()` is a method, not a getter, because it mutates.**
  Getters that skip whitespace confuse both readers and TypeScript's narrowing.
- **The worker owns authoritative geometry.** The main thread holds a
  `ModelHandle` plus a render snapshot, never a `CanonicalMesh`. Operations name
  a model by handle + revision; a stale revision must fail rather than apply to
  whatever replaced it. See `docs/adr/0008-worker-resident-geometry.md`.
- **Allocate canonical arrays through `createPositionArray` / `createIndexArray`.**
  A bare `new Float32Array` at a call site defeats the whole point of the
  `PositionArray` alias, which exists so the open Float32/Float64 decision
  changes in one place.
- **Render buffers are concretely `Float32Array`, not the canonical alias.**
  Float32 is the selected WebGL/Three.js vertex-attribute representation. Naming
  it concretely keeps render precision decoupled from canonical precision, so
  whatever ADR 0004 decides for stored geometry — and whatever a future geometry
  kernel computes in — the snapshot converts at the boundary instead of tracking
  it.

## Honesty rules for the interface

- **Never fake functionality.** If something is not implemented, the interface
  says so plainly.
- **Never report success for work that did not happen.** Screening a filename is
  not importing a model.
- **Never turn diagnostic uncertainty into interface certainty.** No UI path may
  say _printable_, _watertight_, _valid mesh_, _error free_, or _hole_. Stage 2
  checks exact-coordinate topology and nothing else; self-intersections and wall
  thickness are unchecked, and every report says so beside its verdict. The
  banned terms are listed in `apps/web/src/state/topology-presentation.ts` and a
  test asserts none of them can be emitted.
- **Edge manifoldness and vertex manifoldness are separate**, and the interface
  reports them separately. Collapsing them into one "manifold" flag hides the
  bow-tie case, which is precisely the case naive tools miss.
- **Never register a stub codec.** STL is real; OBJ and 3MF must keep failing
  loudly. Two tests hold this line: `registry.test.ts` asserts unimplemented
  formats throw rather than returning a placeholder, and `capabilities.test.ts`
  asserts the capability list the UI reads matches exactly what actually
  registers — so the interface cannot advertise a format that does not work.

## Out of scope right now

Authentication, accounts, subscriptions, payments, pricing, download gating,
ads, analytics, databases, backends. Leave clean seams; do not build them.

Do not install Manifold, Geogram, lib3mf, OpenVDB, CGAL, OpenCascade, or any
other geometry kernel without an explicit decision — licensing and WASM
portability must be evaluated first.
