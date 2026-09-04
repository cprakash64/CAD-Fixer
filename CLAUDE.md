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

**Current stage: Stage 4A-2A complete — the multi-part geometry document
foundation, on top of conservative deterministic repair.** The engine, the transaction and the user workflow are all
production. Implemented: structural STL encoding detection, hand-written binary
and ASCII STL parsers with resource budgets, worker-based parsing with progress
and working cancellation, a real Three.js viewport with camera controls, model
statistics, binary/ASCII STL export that round-trips through our own parser,
worker-resident authoritative geometry addressed by handle+revision, read-only
topology diagnostics with a Mesh Health panel and viewport overlays, and the
**conservative repair workflow**: an automatic plan with a per-operation
decision and reason, a validated candidate, a before/after preview that shares
one camera, bounded change overlays, transactional apply, and one step of undo.

Stage 4A-2A migrated the authoritative unit from **one mesh** to **one
`GeometryDocument` holding one or more parts**, with one monotonic document
revision, stable `PartId`s, per-part placements, document-level units, and
geometry structurally shared between parts. STL still describes one thing, so an
STL import produces a one-part document and the single-part workflow is
unchanged. See `docs/adr/0014-multi-part-geometry-document-foundation.md`.

NOT implemented, and not to be implemented unless a task explicitly asks:
tolerance welding, hole filling, booleans, remeshing, OBJ or 3MF codecs, format
conversion, splitting, connectors, texturing, hollowing, drainage holes,
wall-thickness analysis, inter-part overlap detection, redo, multi-step undo,
transform editing, and any repair that is not one of the four conservative
operations.

**CAD Fixer reads and writes STL and nothing else.** The document layer exists;
the OBJ and 3MF codecs that will fill it do not. No interface may suggest
otherwise.

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
packages/mesh-core/         canonical mesh + multi-part document + validation
packages/file-formats/      format descriptors, screening, budgets, STL codec
packages/mesh-topology/     read-only topology analysis (no mutation, no welding)
packages/mesh-repair/       conservative deterministic repair (kernel-free)
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
npm run test:e2e:timing # Timing/responsiveness proofs, SERIAL (see below)
npm run test:e2e:harness # Multi-part document proofs in Chromium, SERIAL (see below)
npm run verify       # format:check + lint + typecheck + test + build
npm run bench:stl      # STL parser benchmark (NOT in CI)
npm run bench:topology # small topology benchmark (NOT in CI)
npm run bench:pipeline # whole-pipeline benchmark, 1/10/50/100 MiB (NOT in CI)
npm run bench:document # document-wrapper cost + part-count scaling (NOT in CI)
npm run bench:repair-browser # repair workflow timings in a real browser (NOT in CI)
npm run check:node     # runtime version guard; also runs before test/build/verify
```

Before declaring work complete, run `npm run verify`. Run `npm run test:e2e` as
well when you have touched the shell, the worker, or the build.

**`npm run test:e2e:timing` is a SEPARATE command, and it is not optional.**
Timing and responsiveness proofs — cancellation ratios, main-thread gaps — live
in `playwright.timing.config.ts` and run single-worker. They are excluded from
`test:e2e` because a ratio between two measurements is only meaningful when both
see the same machine load: under four parallel workers the Stage 3B cancellation
ratio was measured anywhere from 0.640 to 1.17, and a ratio above 1.0 cannot be
a statement about cancellation at all. Run it whenever you touch cancellation,
the worker lifecycle, or anything that could move work onto the main thread.

**`npm run test:e2e:harness` is a THIRD suite, and it serves a different page.**
The shipped application can only import STL, so it can only ever hold one part —
which is why DF07, DF08, DF10 and multi-part responsiveness had no browser
evidence when Stage 4A-2A first landed. `playwright.harness.config.ts` serves
the end-to-end harness build instead: the same application, store, worker
handlers and viewport, with a synthetic multi-part document put in front of
them. Run it whenever you touch the document model, the viewport, part
selection, or anything a multi-part document reaches.

THE HARNESS MUST NEVER SHIP, and five boundary tests enforce that: no import
edge from `apps/web/src`, one application build input, no `createWorker` in the
production entry, no injection global or query parameter, and no harness
identifier in the built output. If a change would be easiest to make by adding a
route into authoritative geometry from the application, that change is wrong —
see `docs/adr/0014-multi-part-geometry-document-foundation.md#r1`.

These proofs are also sensitive to WHOLE-MACHINE load, which no test
configuration can remove. On a busy host the same suite has taken 42 minutes
with spurious timeouts and seconds when quiet. A timing failure on a loaded
machine is not evidence of a regression — re-run it on a quiet one before
believing it.

## Document invariants (Stage 4A-2A)

- **ONE MONOTONIC REVISION PER DOCUMENT, never one per part.** It lives in
  `ResidentDocumentStore`, not as a field on `GeometryDocument` — a field would
  be a second authority that could disagree. A change to ANY part consumes the
  document's revision, so a result for part A is invalidated by an edit to part
  B. That over-invalidation is deliberate and was qualified: an over-invalidated
  result is recomputed, an under-invalidated one is applied to geometry it was
  not built from.
- **THE PART IS PART OF THE IDENTITY.** Two parts of one document carry
  IDENTICAL handles, so a handle comparison cannot say which mesh a result
  describes. Every guard that compares handles must compare `partId` too — the
  topology cache, the report echo, the repair candidate, `expectedPart` at
  commit, the undo record, the self-intersection report, and every workspace
  slice.
- **`expectedPart` is STATED by the caller, never read off the candidate.**
  Reading it off the candidate compares the candidate with itself and the guard
  becomes vacuous.
- **ONE UNIT AUTHORITY: `GeometryDocument.unit`.** A mesh has no unit field.
  `undefined` means unknown and is NEVER defaulted to millimetres.
- **ONE TRANSFORM AUTHORITY: `GeometryPart.transform`.** A mesh has no transform
  field, so a shared mesh cannot be placed two contradictory ways. Twelve Float64
  values, row-major 3×4. Never baked into Float32 positions.
- **Geometry is SHARED, not copied.** Two parts may hold the same
  `CanonicalMesh` object. `withPartMesh` carries untouched parts across by
  reference, `documentByteLength` counts each mesh once, the render snapshot
  builds buffers per DISTINCT mesh, and `SharedPartGeometry` reference-counts the
  GPU geometry so disposal cannot free a buffer another part is drawing from.
- **`activePartId` is workspace state, not geometry identity.** Changing it must
  NOT change the document revision. Switching parts clears the per-part
  diagnostic slices rather than carrying them across.
- **Automatic work follows the ACTIVE part only.** A hundred-part document must
  not launch a hundred topology passes or a hundred WASM kernels on import.
- **Every part-targeted request carries its `partId` explicitly.** The
  authoritative worker never infers a target from UI selection state.
- **Self-intersection is INTRA-PART.** Two independently valid parts that overlap
  in world space are not self-intersecting, and nothing checks whether they do.
  Never flatten a document for the diagnostic.
- **STL export writes ONE part and says what it left out.** STL holds one
  object. The panel states this before the click. Never flatten silently.
- **`assertGeometryDocument` is the second gate**, mirroring
  `assertMeshStructure`. Structural validity is NOT mesh health: a part with
  degenerate triangles is a valid document describing a defective model.
- **Selecting a part is NOT a model change.** `setActivePart` moves the overlay
  and preview frame; `setModel` rebuilds the scene. Routing selection through
  `setModel` disposed and re-uploaded every part's GPU geometry on a click — four
  uploads for a two-part document where two were correct, two thousand for a
  thousand placements. The harness suite asserts zero geometry work on a switch.
- **Local bounds belong to the MESH, not the part.** Compute them once per
  DISTINCT mesh and apply the placement to the box afterwards. Computing per part
  walked one shared buffer a thousand times — 356 ms at 1,000 placements.

## Repair invariants (Stage 3B-1)

- **ONE GEOMETRY KERNEL IN PRODUCTION, CONFINED TO ONE WORKER.** As of Stage
  3C-1B, Geogram v1.10.0 ships as the WebAssembly kernel behind the read-only
  self-intersection diagnostic, imported by
  `apps/web/src/workers/self-intersection.worker.ts` and by nothing else. The
  boundary scan asserts exactly that. Manifold and PMP remain research artifacts
  under `experiments/`; nothing in `apps/**` or `packages/**` may import them.
  Repair itself is still kernel-free.
- **No tolerance in the conservative repair API.** No epsilon, weld distance,
  merge tolerance or proximity threshold. Stage 3A proved no global tolerance
  can be correct — the value that heals R19's crack destroys R21's intentional
  gap. Tolerance belongs to a later assisted stage, explicit and user-chosen.
- **Reversed duplicates are never removed.** They may encode a zero-thickness
  feature. Reported, never deleted.
- **Boundary loops are never filled.** A loop is not a hole; open tubes, vases
  and shells are valid user intent.
- **Winding unification is RELATIVE.** The lowest-indexed surviving face in each
  component keeps its orientation. Never choose a global sign from signed
  volume, world axes, the bounding box or a stored STL normal — see ADR 0010.
- **The authoritative document is never written.** Repair produces a candidate
  for ONE part; `repair/commit` builds a successor document with `withPartMesh`
  and swaps a reference after every guard passes. Every other part is carried
  across BY REFERENCE and stays byte- and reference-identical. A candidate handle
  is a distinct type from `ModelHandle` so it cannot be exported by mistake.
- **The algorithm never decides its own success.** The candidate is re-analysed
  by Stage 2 and judged against the source.
- **`selfIntersectionStatus` is always `not-checked`**, and there is no
  `printable` flag. Repair acceptance is not printability acceptance.
- **React is never the transaction authority.** Apply sends three identifiers and
  the worker re-checks every guard. Never move a guard into a component or a
  hook, and never add a code path that commits without going through
  `repair/commit`.
- **A preview never swaps authority.** The viewport holds two render snapshots
  and toggles `visible`. Switching Before/After must not call `setModel`, must
  not reframe, and must not change any handle.
- **Undo produces a NEW, higher revision.** Revisions only ever move forwards,
  because every staleness guard depends on it. Never reactivate a retained prior
  revision. See `docs/adr/0011-repair-undo-revisions.md`.
- **Exactly one repair per model is undoable, and redo does not exist.** Undoing
  retains no forward patch, so redo is not derivable from what is kept — building
  it would be a new memory commitment, not a symmetry fix.
- **Repair copy lives in `apps/web/src/state/repair-presentation.ts`, all of it.**
  A reason string written inline in a component is a bug: two screens drift, and
  a new `RepairReason` reaches one of them and not the other. The switches there
  are exhaustive with no `default` on purpose.
- **`geometry-runtime` RESTATES the repair constants; it does not re-export
  them.** A value re-export from `@cadfixer/mesh-repair` makes the engine a
  runtime dependency of the main-thread bundle. `packages/geometry-runtime/src/repair.ts`
  mirrors them and two tests keep the mirror honest — one at compile time, one on
  the runtime values.

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
- **The topology report is CACHED per (documentId, revision, partId).** Analysis runs
  automatically on import, the repair plan is derived from a report, and the
  candidate needs one too — without `TopologyReportCache` the same unchanged mesh
  was analysed three times per repair, and the end-to-end suite started timing
  out because of it. Safe only because geometry at a revision is immutable.
- **A repair peak is not an analysis workspace.** `maxRepairPeakBytes` is its own
  budget field: the authoritative mesh and the candidate coexist by design, so
  the peak is both meshes plus connectivity plus the validation workspace.
- **`RepairPlanPayload.memoryBudgetBytes` may only NARROW the ceiling.**
  `requestRepairPeak` enforces that on the worker side; a message can make CAD
  Fixer more cautious and never less. The `?repairMemoryCeilingMiB=N` URL option
  drives it and is surfaced in the panel whenever active.
- **Cancelling a repair discards, it does not interrupt.** The pipeline is one
  synchronous pass; the handler yields BEFORE registering the candidate, so a
  cancel leaves nothing resident. Yielding after registration would leak a
  candidate that only a discard could clean up.
- **Change samples are SOURCE face indices for all four categories, including
  flips.** Overlays therefore index the source render snapshot the main thread
  already holds. Removed faces are hidden in the After view; flipped faces are
  not, because a flip moves no vertex.
- **Boundary edges and surface area are PREDICTED, not forbidden, after
  duplicate removal.** Two coincident triangles pair each other's edges and look
  closed, and Stage 2 sums every face — so removing the redundant copy correctly
  reveals boundary edges and correctly reduces the summed area. "Must not
  increase" rejects a correct repair. Degenerate removal IS held to the strict
  rule and is refused if it would open a boundary.
- **Winding is solved on the POST-REMOVAL topology.** Solving on the source and
  adjusting for pending removals made repair non-idempotent: a duplicate's
  non-manifold vertices blocked a repair the same pipeline had already made
  safe. Removals are materialised first, then connectivity is rebuilt.
- **The worker owns authoritative geometry.** The main thread holds a
  `DocumentHandle`, scalar part descriptors and render snapshots — never a
  `CanonicalMesh` and never a `GeometryDocument`. Operations name a document by
  handle + revision, and a part by `partId`; a stale revision or an unknown part
  must fail rather than apply to whatever replaced it. See
  `docs/adr/0008-worker-resident-geometry.md` and
  `docs/adr/0014-multi-part-geometry-document-foundation.md`.
- **`ModelHandle` no longer exists.** It is `DocumentHandle` (`documentId` +
  `revision`), and the store is `ResidentDocumentStore`. The PROTOCOL operation
  names did not change — `model/import`, `model/export`, `model/analyze`,
  `model/release`, `model/send-for-diagnostic` describe what the user does, and
  that is unchanged. `LoadedModel` in application state keeps its name for the
  same reason.
- **`Matrix4Tuple` and `IDENTITY_MATRIX4` were removed**, not deprecated. Use
  `PartTransform` / `IDENTITY_PART_TRANSFORM`. Two names for one concept is drift.
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
- **Never claim a repair did more than it did.** The repair panel's wording is
  decided in one file and asserted by test: no string it can emit may say
  printable, watertight, fully repaired, all errors fixed, ready to print, fix
  everything, make printable, or hole — and none may claim a repaired model faces
  outward, because winding is unified RELATIVE to neighbours only. The most that
  may be said after a committed repair is `Conservative repair applied` plus
  `Selected topological issues were repaired and revalidated`, always followed by
  the same unchecked qualifier.
- **A refusal is not an error, and a preview is not an application.** Refused and
  blocked operations are rendered as decisions with reasons in their own visual
  register; a candidate on screen is labelled `Preview — not applied` until it is
  committed.
- **An expected delta is not a regression.** Once a candidate is ACCEPTED every
  remaining difference was predicted before the rebuild and confirmed after it —
  including a boundary-edge count that rose because a duplicate that was hiding
  an opening has been removed. Never label one of those an error.
- **Never register a stub codec.** STL is real; OBJ and 3MF must keep failing
  loudly. Two tests hold this line: `registry.test.ts` asserts unimplemented
  formats throw rather than returning a placeholder, and `capabilities.test.ts`
  asserts the capability list the UI reads matches exactly what actually
  registers — so the interface cannot advertise a format that does not work.

## Out of scope right now

Authentication, accounts, subscriptions, payments, pricing, download gating,
ads, analytics, databases, backends. Leave clean seams; do not build them.

Also out of scope until a task asks: redo, a multi-step undo history,
inter-part overlap detection, an assembly tree editor, transform editing, and any
repair operation outside the four conservative ones.

Do not install Manifold, Geogram, lib3mf, OpenVDB, CGAL, OpenCascade, or any
other geometry kernel without an explicit decision — licensing and WASM
portability must be evaluated first.
