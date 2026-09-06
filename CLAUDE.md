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

**Current stage: Stage 4B-1B1 complete — a PRODUCTION VALIDATED PLANAR
HOLE-FILL ENGINE with no user-facing workflow, on top of the user-facing format
conversion workflow, the validated export engine, production STL/OBJ/3MF import,
the multi-part geometry document foundation and conservative deterministic
repair.** The engine, the transaction and the user workflow are all
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

Stage 4A-2B1 added production IMPORT for OBJ and 3MF. All three formats go
through one path: `identifyFormat` decides from the BYTES, `requireReader`
returns that format's reader, every reader produces a `GeometryDocument`, and
`commitImportedDocument` is the one transaction that installs it. See
`docs/adr/0015-production-obj-and-3mf-import.md`.

NOT implemented, and not to be implemented unless a task explicitly asks:
tolerance welding, NON-PLANAR hole filling, batch or "fill all" hole filling, a
user-facing hole-fill workflow of any kind, booleans, remeshing, UNIT CONVERSION of any
kind, OBJ polygons, MTL resolution, 3MF textures or materials, exported normals
or texture coordinates, exported 3MF group or property resources, reconstruction
of an imported 3MF's component hierarchy, splitting, connectors, texturing,
hollowing, drainage holes, wall-thickness analysis, inter-part overlap
detection, redo, multi-step undo, transform editing, a persistent "set model
units" document edit, and any repair that is not one of the four conservative
operations.

Stage 4A-2B2 added a validated OBJ and 3MF export ENGINE: `exportDocument`
serialises a document snapshot, reads the bytes back with the PRODUCTION reader,
and returns an artifact only if the two agree. See
`docs/adr/0016-validated-document-export.md`.

Stage 4A-2B3 made all three formats writable and put a workflow in front of the
engine: a whole-document STL writer, a deterministic conversion compatibility
report, and an export-local unit assertion for 3MF. See
`docs/adr/0017-format-conversion-workflow.md`.

Stage 4B-1B1 added a validated planar hole-fill ENGINE and NO workflow.
`packages/mesh-hole-fill` fills ONE selected boundary loop, proven simple,
manifold and planar, with in-house deterministic ear clipping that adds no
vertex; the candidate is validated independently, including a PATCH-ATTRIBUTED
intersection check against the qualified Geogram narrowphase. **There is no Fill
Hole control and a boundary test asserts there is none** — selection, patch
preview, Apply and Undo are Stage 4B-1B2. See
`docs/adr/0018-hole-filling-qualification.md`, its production addendum and its
Stage 4B-1B1-R1 closure addendum.

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
packages/file-formats/      format descriptors, screening, budgets, identification,
                            STL codec, OBJ + 3MF readers, bounded ZIP and XML,
                            validated STL + OBJ + 3MF document writers, and the
                            conversion compatibility policy (src/export/)
packages/mesh-topology/     read-only topology analysis (no mutation, no welding)
packages/mesh-repair/       conservative deterministic repair (kernel-free)
packages/mesh-hole-fill/    planar hole-fill engine: ordered-loop eligibility,
                            relative planarity, deterministic ear clipping, a
                            bounded patch-query broadphase, and independent
                            validation (kernel-free; narrowphase injected)
packages/geometry-runtime/  worker protocol, coordinator, worker host
docs/                       architecture, dependencies, privacy, deployment
docs/adr/                   architecture decision records
e2e/                        Playwright specs
```

Dependency direction is one-way:
`shared ← mesh-core ← file-formats`, `shared ← mesh-core ← mesh-topology`,
`shared ← mesh-core ← mesh-topology ← geometry-runtime`,
`shared ← mesh-core ← mesh-topology ← mesh-hole-fill`, all ← `apps/web`.
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
npm run bench:formats  # OBJ + 3MF import at 1/10/50 MiB (NOT in CI)
npm run bench:export   # OBJ + 3MF export, sizes and placement counts (NOT in CI)
npm run bench:repair-browser # repair workflow timings in a real browser (NOT in CI)
npm run bench:hole-fill # hole-fill phase timings and broadphase reduction (NOT in CI)
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
selection, or anything a multi-part document reaches. Since Stage 4A-2B2 it is
also the ONLY caller of the document export engine, so run it whenever you touch
a writer, the export worker or the export controller.

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

## Import invariants (Stage 4A-2B1)

- **THE BYTES DECIDE THE FORMAT, never the extension.** `identifyFormat` sniffs
  at most 4 KiB plus the file length. The name is used only to disambiguate an
  ambiguous sniff and to REPORT a mismatch: a `.stl` holding an OBJ is refused
  as `ContentExtensionMismatch`, not parsed as either.
- **ONE COMMIT PATH.** Every reader returns a `GeometryDocument` and every
  import goes through `commitImportedDocument`. A format-specific commit is a
  second transaction that can disagree with the first.
- **`assertMeshStructure` runs per DISTINCT mesh, not per part.** A thousand
  placements of one object share one `CanonicalMesh`; validating per part
  validates the same buffer a thousand times.
- **OBJ REFUSES A POLYGON, it never fans one.** A naive fan of the research
  corpus's concave pentagon produced a triangle of the opposite orientation,
  covering area outside the polygon the file described. `o` becomes a part; `g`
  is recorded as group membership and does NOT create one.
- **`mtllib` IS NEVER OPENED**, and no 3MF texture, material, schema or
  relationship is ever resolved. They are recorded as unsupported features and
  reported by name. Following a path chosen by an untrusted file is a read the
  user did not ask for.
- **ZIP budgets are enforced DURING inflation, chunk by chunk, and ACROSS
  ENTRIES.** The directory's declared uncompressed size is a claim by the
  attacker; checking it and then inflating anyway proves nothing. `inflateRaw`
  yields chunks for exactly this reason — a `Promise<Uint8Array>` would mean the
  allocation had already happened. One `InflationBudget` is created per import
  and passed to every entry, and each chunk is checked against the PROSPECTIVE
  total BEFORE it is retained; stored entries are charged too. The budget is a
  REQUIRED field on `ZipReadOptions`, because an optional one is not enforced
  the first time someone adds a second `readZipEntry` call.
- **THE READER'S PART CEILING IS THE DOCUMENT'S.** `DEFAULT_3MF_LIMITS.maxParts`
  reads `DEFAULT_DOCUMENT_LIMITS.maxParts`, and `DEFAULT_OBJ_LIMITS.maxFaces` /
  `maxNameLength` read the document's ceilings too. A reader limit above the
  document's means a file is fully expanded and then refused — all of the work
  and none of the protection. Tests assert they stay equal.
- **The expansion budget is checked BEFORE the part is appended**, so the walk
  stops rather than building the part that crosses and unwinding. Triangle and
  vertex totals are carried through the walk for the same reason: a document
  counts them PER PART, so repeated placements of one shared mesh multiply them.
  `maxTotalGeometryBytes` is deliberately left to the document gate — it is
  charged per DISTINCT mesh, so no expansion can reach it early.
- **Names are truncated to the DOCUMENT'S cap, not to a larger one.** Truncating
  at 1,024 while the gate refuses above 512 is not truncating: it made a model
  with a 600-character object name unimportable for a display string.
- **XML IS FAIL-CLOSED BEFORE IT IS PARSED.** `describeUnsafeXml` refuses any
  DOCTYPE, ENTITY, SYSTEM or PUBLIC identifier before a single element is read,
  and the scanner is ours — never `DOMParser`. The refusal must not depend on a
  parser being configured correctly.
- **A 3MF without `unit` means MILLIMETRE.** The specification defaults the
  attribute, so an absent one is a stated unit, not an unknown one
  (`THREE_MF_DEFAULT_UNIT`). This is not "inventing a unit": the value comes
  from the format's definition. STL is the opposite case — no unit field exists,
  so an STL states nothing and the interface says `Unspecified by STL`.
  Coordinates are never rescaled either way.
- **The platform primitives are INJECTED, not imported.** `file-formats`
  compiles with `lib: ES2023` and no DOM or Node types, so `TextDecoder` and
  `DecompressionStream` arrive as `decodeText` and `inflateRaw` on
  `FormatReadContext`. A codec that reached for them directly would stop being
  runnable under plain Node, and the differential suite against the research
  readers would stop being possible.
- **Every refusal carries an `ImportRefusal` code** in `AppError.details.reason`.
  Tests assert the CODE, never the sentence, so wording can change without
  weakening what a test proves.
- **Names and parser text from a file are UNTRUSTED.** Object names, group
  names, material references and file names render as text. No
  `dangerouslySetInnerHTML`, and no error message may carry archive, XML or OBJ
  content into markup.

## Export invariants (Stage 4A-2B2)

- **VALIDATION IS MANDATORY AND HAS NO SWITCH.** Every successful OBJ or 3MF
  export has been read back by the PRODUCTION reader, under production limits,
  and compared with what it was written from. A serialiser returning bytes is not
  proof of a valid artifact. Never add "skip validation for faster export".
- **THE PAGE NEVER HOLDS GEOMETRY; IT DOES HOLD THE ARTIFACT.** The snapshot
  travels worker to worker over a `MessageChannel`; the finished FILE comes back
  to the page, because that is what the user asked to save and it cannot be
  edited back into the model.
- **THE SNAPSHOT IS A COPY, ONE PER DISTINCT MESH.** Transferring the
  authoritative arrays would detach them and let a terminated export worker take
  the user's model with it. A thousand placements copy one mesh, not a thousand.
- **CANCELLATION IS TERMINATION.** `CompressionStream` polls no flag of ours, so
  a cooperative token alone would be a lie for part of the work. The export
  worker is disposable and Cancel kills it. One export at a time.
- **A STALE ARTIFACT IS DISCARDED, NEVER DOWNLOADED.** The snapshot carries the
  revision it was built from, and the controller re-checks it against the handle
  the caller asked for. Bytes from a revision the user has moved off describe
  geometry they are no longer looking at.
- **OUTPUT CEILINGS ARE DERIVED AND ENFORCED INCREMENTALLY.**
  `maxSerialisedBytes` (512 MiB) is the reader's own intake ceiling — an export
  our reader would refuse could never be validated. `maxOutputBytes` (256 MiB) is
  half of it, because the artifact, the snapshot and the parsed-back document are
  live at once. Both are checked BEFORE a chunk is retained.
- **OBJ BAKES TRANSFORMS; 3MF PRESERVES THEM.** Baking is Float64
  `applyPartTransform`, then `Math.fround`, then nine significant digits — the
  same single narrowing the reader performs. Never `toFixed(6)`: it fails 50.7%
  of Float32 values. Negative zero is written explicitly, and `isIdentity` uses
  `Object.is` for the same reason.
- **A 3MF NEEDS A UNIT AND CAD FIXER WILL NOT INVENT ONE.** Unknown unit is
  `BLOCKED_UNIT_REQUIRED`, never `millimeter`. The reader's millimetre default is
  the SPECIFICATION saying what an absent attribute means; an STL-derived
  document has asserted nothing. Coordinates are never rescaled to hide a lost
  unit either.
- **3MF GROUPS OBJECTS BY (MESH, NAME)** — the metadata the `<object>` element
  actually carries. Parts that agree share one object; parts that disagree get
  their own, and the split is recorded. A differing MATERIAL REFERENCE does not
  split anything, because none is written. The imported component hierarchy is
  NOT reconstructed.
- **ARCHIVE PATHS ARE A FIXED LIST THE WRITER DECIDES.** No entry path is derived
  from a document name, a part name or a material reference. Untrusted strings
  are XML DATA: escaped with all five predefined entities, control characters
  dropped because XML cannot carry them.
- **THE WRITER'S OUTPUT MUST SATISFY THE READER'S SECURITY CONTRACT.** No
  DOCTYPE, no entities, no external identifiers, no remote references — a file
  our own reader would refuse is a file the user cannot open.
- **OBSERVATIONS ARE MACHINE-READABLE FACTS, NOT SENTENCES.** `ExportObservation`
  records what a writer did; Stage 4A-2B3 decides the wording. Two copies of that
  copy would drift.
- **INDEPENDENT ORACLES SIT BESIDE PARSE-BACK.** Our reader agreeing with our
  writer proves only that they agree. `obj-oracle.ts` and `threemf-oracle.ts` are
  test-only structural checkers that share no code with production, and a
  boundary test keeps them out of it.

## 3MF property-reference invariants (Stage 4A-2B3-R1)

- **NO `pid` IS EVER EMITTED, FOR ANY TARGET, FROM ANY DOCUMENT.** 3MF core
  types `object@pid` as an `ST_ResourceID` naming a property-group resource that
  must EXIST. CAD Fixer writes no property resources, so a `pid` it wrote would
  be dangling by construction — and for a `materialRef` that did not originate
  as a number it was not even a lexical id: `pid="steel-brushed"` was real
  output. Never emit `pindex` either.
- **NEVER FABRICATE A PROPERTY RESOURCE TO MAKE A REFERENCE RESOLVE.** A
  `materialRef` is an opaque import-level string, not a material definition; a
  `<basematerials>` invented for it would state a colour and a name the user
  never gave. Dropping it and SAYING SO is the honest MVP answer. Building a real
  material system is a separate, explicit decision.
- **A PART MATERIAL REFERENCE IS A LOSS IN ALL THREE TARGETS**, and the report
  says so before the export. Nothing may report it as preserved.
- **THE READER DISTINGUISHES UNSUPPORTED FROM DANGLING.** `pid` naming a
  `<basematerials>` CAD Fixer does not interpret is a VALID file: geometry
  imports and the loss is reported. `pid` naming nothing is
  `THREEMF_DANGLING_PROPERTY_REFERENCE`; a `pid` that is not a positive integer
  is `THREEMF_MALFORMED_RESOURCE_ID`. Validate LEXICALLY — `Number` accepts
  `7`, `0x7`, `1e3` and `+7`, none of which is a resource id.
- **REFERENCES RESOLVE AFTER THE SCAN, not inline.** A resource may legitimately
  be declared after the reference to it, and refusing on element order would
  reject valid files.
- **THE INDEPENDENT ORACLE VALIDATES THE ID SPACE**, and a mutated fixture proves
  it rejects. This defect passed ZIP, CRC and XML checks and passed parse-back,
  because writer and reader shared the blind spot — the oracle is the only layer
  that could have caught it, and it was not looking. When a defect gets through,
  ask which oracle should have seen it.
- **PARSE-BACK ASSERTS THE REFERENCE'S ABSENCE.** It used to assert its presence,
  which is how a malformed file passed validation.

## Name-sanitization invariants (Stage 4A-2B3-R1)

- **A NAME THAT CANNOT BE WRITTEN EXACTLY IS DISCLOSED BEFORE THE EXPORT**, as a
  COUNT. `NAME_CHARACTERS` carries a number and nothing else: a fact holding a
  name would put untrusted text one render away from markup and create a second
  place display copy lived. The profile holds no names either.
- **THE PREDICATES ARE THE WRITERS' OWN** — `objNameChangesOnWrite` and
  `xmlTextChangesOnWrite`, from leaf modules that import nothing. Not a mirror:
  the disclosure cannot disagree with the file.
- **STL IS EXCLUDED.** It drops every name and already says so; a warning that
  some would have been adjusted describes a change to something not written.
- **DO NOT WARN ABOUT PERFECTLY REPRESENTABLE UNICODE.** Accents, CJK, emoji and
  RTL scripts survive both writers intact. Warning about them is the noise that
  teaches people to stop reading the panel.

## Conversion workflow invariants (Stage 4A-2B3)

- **THE REPORT DESCRIBES THE DOCUMENT, NEVER THE TARGET'S NAME.** "OBJ loses
  units" is a fact about OBJ; whether THIS conversion loses one depends on
  whether this document has one. Never warn about a feature the current document
  does not contain — a panel that warns about everything is a panel nobody
  reads.
- **`analyseConversion` IS PURE AND IS THE ONLY JUDGE.** Scalars in, facts out.
  Everything the workflow shows, enables and disables comes from it; nothing
  recomputes any part of it independently. Policy correctness is established in
  `compatibility.test.ts`, not end to end.
- **THE REPORT IS DERIVED ON EVERY RENDER, NEVER STORED.** That is the whole
  stale-dialog answer: there is no saved report, so none can authorise an export
  at a revision it was not built from. Never add a `report` field to the store.
- **VERDICT PRECEDENCE IS FROZEN**: `BLOCKED > UNSUPPORTED_INPUT_FEATURE >
LOSSY_STRUCTURE > LOSSY_METADATA > LOSSLESS_FOR_SUPPORTED_FEATURES`. A
  SOURCE-IMPORT WARNING NEVER TOUCHES THE VERDICT — a texture that was never
  imported is not something this conversion is doing.
- **`UNSUPPORTED_INPUT_FEATURE` IS FOR PER-VERTEX ATTRIBUTES THE DOCUMENT
  ACTUALLY CARRIES.** Do not put import warnings there.
- **SOURCE IMPORT WARNINGS LIVE ON `ModelSource` FOR THE LIFE OF THE MODEL.**
  They are file metadata, not geometry identity: no handle or revision compares
  them, a repair does not change them, and the next import replaces them
  wholesale. Shown in their own section, and they do not move when the target
  changes.
- **NO UNIT DEFAULT, ANYWHERE.** `document.unit === undefined` + 3MF is
  `BLOCKED`. Six choices, nothing preselected, an empty `<select>` value and a
  disabled placeholder option — a select with no explicit value reports its
  first option, which would be CAD Fixer asserting microns for the user.
- **A UNIT ASSERTION IS EXPORT-LOCAL AND NEVER RESCALES.** It rides on the
  disposable snapshot; the authoritative document keeps `unit: undefined` and
  its revision does not move. `exportSnapshotOf` applies it ONLY when the
  document states none, and the AUTHORITATIVE WORKER decides that — not the
  page, which holds a mirror. The 3MF writer stays fail-closed regardless.
- **EXPORTING IS A READ.** No revision, no undo entry, no change to geometry,
  transforms, part order, sharing or unit — for every target.
- **WHOLE DOCUMENT MEANS WHOLE DOCUMENT.** Every target in this workflow writes
  every part. `activePartId` must not reach it. The active-part STL export is a
  DIFFERENT operation (`model/export`) and both are labelled with which they
  are; never let two controls both read "Export STL".
- **STL FLATTENS INTO THE OUTPUT BUFFER AND NOWHERE ELSE.** There is no
  flattened `CanonicalMesh`, authoritative or otherwise, and exporting twice
  from one snapshot must produce identical bytes.
- **STL FACET NORMALS COME FROM THE TRANSFORMED TRIANGLE.** A reflection
  reverses orientation, so a copied normal points into the solid. A degenerate
  triangle gets a ZERO normal — never an invented direction, never `NaN`.
- **THE STL PREFLIGHT IS EXACT**: `84 + n * 50`, checked before the single
  allocation, ceiling `min(floor((maxOutputBytes - 84) / 50), 2^32 - 1)`. OBJ
  keeps a genuine LOWER bound; 3MF gets no preflight, because its size depends
  on compression and a made-up bound would lie in one direction or the other.
- **CONVERSION COPY LIVES IN `apps/web/src/state/conversion-presentation.ts`,
  all of it.** The switch is exhaustive with no `default` on purpose. Banned by
  test: `scale preserved`, `units converted`, `lossless conversion`, `nothing is
lost`, `printable`, `watertight`, and the rest. **"The numbers are unchanged"
  and "the scale is preserved" are not the same statement** — the approved
  sentence says both halves.
- **SEVERITY IS PROPORTIONATE.** Only a blocker gets the strongest register.
  Every section states its meaning in words, so nothing depends on colour.
- **THE SERIALISERS STAY OFF THE MAIN THREAD.** No main-thread file may import a
  writer or reader by name, and the two constants the page needs live in leaf
  modules that import nothing — `export/stl-layout.ts` and `threemf/units.ts`.
  This was got wrong once: the policy imported `84 + n * 50` from the STL writer
  and arrived carrying `stl/detect.ts`'s module-scope keyword tables. Two
  boundary tests hold the line.
- **THE EXPORT WORKER IS BUILT ONLY WHEN AN EXPORT STARTS.** Opening the dialog,
  choosing a target and picking a unit must construct nothing.
- **`ExportRefusal.UnsupportedTarget` LIVES AT `resolveExportTarget`**, which is
  where an untrusted target STRING arrives. It was removed from `exportDocument`
  because every `MeshFormatId` is now writable and the guard had become
  type-dead. The lookup uses `hasOwnProperty`, so `constructor` and `__proto__`
  are not formats.

## Hole-fill invariants (Stage 4B-1B1)

- **THE ENGINE SHIPS; THE WORKFLOW DOES NOT.** There is no Fill Hole button, no
  boundary picker, no patch preview and no Apply, and a boundary test asserts
  those strings are absent from `components/` and `state/`. They are Stage
  4B-1B2. Do not add one "while we are here".
- **STAGE 4B-1B1 PRODUCES CANDIDATES ONLY.** The resident document is never
  replaced, its revision never moves and no undo record is written — for
  success, refusal, cancellation, or a crash of the worker that ran it. There is
  no commit path, and adding one is a stage rather than a patch.
- **ONE SELECTED LOOP PER OPERATION, NAMED BY AN IDENTITY THE WORKER PRODUCED.**
  `holefill/list-loops` is the only source of a `boundaryLoopId`. Never an
  index, never a position in a UI list, never a boundary the caller describes.
- **THE LOOP ID IS STRUCTURALLY UNIQUE, NOT PROBABILISTICALLY.**
  `bl-<minVertex>-<count>-<hash64>`: boundary components are vertex-disjoint, so
  no two components of one part can share a smallest welded vertex id. The
  research 32-bit coordinate hash was audited and rejected — at 20,165 loops it
  collides ~4.6% of the time, and a collision means filling the wrong hole. **The
  identity is computed from the WALK, never from the verdict**: hashing only
  eligible loops made one boundary hash two ways depending on whether the caller
  passed a vertex ceiling.
- **NO TOLERANCE ANYWHERE, EXCEPT ONE ALGORITHM-ELIGIBILITY RATIO.**
  `RELATIVE_PLANARITY = 1e-4` is max deviation over the loop's OWN largest
  extent — dimensionless, so it means the same thing at any scale and for a
  unitless STL. It is NOT a welding distance, a merge tolerance or a proximity
  test, and nothing in the package welds, merges, snaps or moves a coordinate.
- **A ZERO NEWELL NORMAL IS DEGENERATE, NOT PLANAR.** A collinear loop has no
  plane; calling it perfectly planar would send a zero-area loop into a
  triangulator with nothing to triangulate.
- **EAR CLIPPING, NEVER A FAN.** A fan covers area outside every concave polygon
  — the same defect the OBJ reader refuses to commit. Zero added vertices, zero
  moved vertices, exactly `n - 2` triangles, deterministic ear choice from the
  lowest remaining index. The regression guard is a COMB, not an L: the L
  happens to be star-shaped from its origin corner, so a fan covers it correctly
  and the guard proved nothing.
- **PROVENANCE IS FROZEN AND APPEND-ONLY.** Faces `[0, sourceFaceCount)` are the
  user's; the rest is the patch. Candidate positions are the source's bytes and
  the candidate's index prefix is the source's index bytes, compared as BYTES —
  a numeric comparison would call `NaN` unequal to itself and `-0` equal to `+0`.
- **THE PRESERVATION GATE THAT COUNTS IS THE AUTHORITATIVE ONE.** Inside the
  fill worker the candidate SHARES the source's position buffer, so the engine's
  own comparison proves the two variables alias — not that nothing was
  rewritten. The load-bearing check runs in the authoritative worker, comparing
  the returned candidate against its OWN resident part immediately before
  registration; those two crossed a thread boundary and are genuinely
  independent. A mismatch is `INTERNAL_FAILURE`, never a refusal and never a
  success. Do not move it, and do not add a second registration path — there is
  exactly one, and a boundary test asserts it.
- **NEW NON-MANIFOLD TOPOLOGY IS DETECTED BY IDENTITY, NEVER BY KIND OR COUNT.**
  A source with defect X and a candidate with `{X, Y}` have identical defect
  KINDS, so the kind comparison this replaced accepted a manufactured
  non-manifold edge. Defects are collected as welded edge pairs and welded vertex
  ids and compared as sets; the rule is `candidateDefects ⊆ sourceDefects`, so
  removing one is never a regression and introducing one always is.
  `newNonManifoldDefectCount` must be zero. **The narrowphase cannot see this**:
  a patch landing on an edge a closed shell already owns is a legitimate shared
  edge to every intersection test and a new non-manifold edge to topology.
- **TRIANGULATION SUCCESS IS NEVER ENGINE SUCCESS.** Structural validity,
  topology postconditions, patch winding against the source's own directed
  edges, patch connectivity, Euler as corroboration, and patch-attributed
  intersection all run afterwards, on the final canonical Float32
  representation.
- **EULER IS CORROBORATION AND MAY NEVER OVERRIDE A FAILED VALIDATOR.** HP23 has
  exactly the right χ and drives its patch through an internal wall.
- **SELF-INTERSECTION IS PATCH-ATTRIBUTED, NEVER AGGREGATE.** Only
  (patch × source) and (patch × patch) pairs are generated, so a pre-existing
  crossing cannot be blamed on the fill and an unchanged total is never read as
  proof. A pair the narrowphase could not classify FAILS the candidate.
- **THE NARROWPHASE IS THE QUALIFIED GEOGRAM KERNEL, NOT THE RESEARCH SAT
  CHECKER.** The research checker is a SECOND OPINION in tests only; it is
  strictly weaker — no exact predicates, and it skips any pair sharing a welded
  vertex, so it cannot see an overlap beyond a legitimately shared edge.
  `si_core.h` and `si_bvh.h` stay byte-identical to the research copies; Stage
  4B-1B1 added `cf_hf_*` to `binding.cpp` and changed `cf_si_run` not at all.
- **THE BROADPHASE IS A PORT OF `si_bvh.h`, AND THE REASON IS WRITTEN DOWN.**
  The C++ tree is unreachable from TypeScript and exposes only an all-pairs
  query, so it cannot answer "which source faces might this patch triangle hit".
  The port keeps median split, leaf size 8, INCLUSIVE overlap and the face-index
  tie-break, and is validated against a brute-force oracle — a broadphase that
  misses a pair turns a defect into a clean bill of health.
- **CANDIDATE PAIRS STREAM; THEY ARE NEVER ACCUMULATED.** A reused 8,192-pair
  buffer, plus ceilings on node visits, AABB tests, candidates and narrowphase
  pairs. The research `O(patchFaces × sourceFaces)` list exhausted a 1.7 GB heap
  and is forbidden.
- **CANCELLATION IS TERMINATION.** The fill is one synchronous pass containing
  long exact C++ calls that poll no JavaScript flag, so a cooperative token
  would be a lie. Cancel kills the disposable worker AND cancels the
  authoritative operation, which is otherwise awaiting a channel the dead worker
  will never answer.
- **A CANDIDATE FROM A REVISION THE USER HAS LEFT IS DISCARDED**, not registered:
  the authoritative worker re-checks the revision when the reply arrives and
  reports `STALE_REVISION`.
- **THE CEILINGS ARE 512 BOUNDARY VERTICES AND 250,000 FACES, BOTH MEASURED.**
  `npm run bench:hole-fill` is the evidence, and the patch ceiling is DERIVED
  (`n - 2`) rather than a second number that could disagree with the first.
- **HOLE FILLING IS INTRA-PART.** Part-local coordinates, `PartTransform`
  untouched and never baked in, no unit assumption, and inter-part collision not
  checked at all — exactly as self-intersection is not.
- **`Filled` IS NOT `Repaired`.** A validated candidate means ONE named opening
  was closed and validated against the part it came from. Not watertight, not
  printable, not free of other openings, not free of pre-existing crossings.

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
- **Never register a stub codec.** All three READERS are real. The `MeshWriter`
  registry still holds only STL, because it is the single-MESH contract the
  active-part export uses — `requireWriter('obj')` and `requireWriter('3mf')`
  must keep failing loudly rather than returning a placeholder. DOCUMENT writing
  is a different contract (`exportDocument`) and covers all three. Two tests
  hold this line: `registry.test.ts` asserts an unimplemented direction throws,
  and `capabilities.test.ts` asserts the capability list the UI reads matches
  exactly what actually registers.

## Out of scope right now

Authentication, accounts, subscriptions, payments, pricing, download gating,
ads, analytics, databases, backends. Leave clean seams; do not build them.

Also out of scope until a task asks: redo, a multi-step undo history,
inter-part overlap detection, an assembly tree editor, transform editing, any
repair operation outside the four conservative ones, and every part of hole
filling beyond the Stage 4B-1B1 engine — selection, preview, Apply, Undo,
non-planar loops, batch filling and PMP.

Do not install Manifold, Geogram, lib3mf, OpenVDB, CGAL, OpenCascade, or any
other geometry kernel without an explicit decision — licensing and WASM
portability must be evaluated first.
