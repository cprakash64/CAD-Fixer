# Stage 6D — 3MF production-extension support and large-entry resource architecture

**Design and measurement only. No product source behaviour changed, nothing
deployed, no tag touched.** Repository at `9e793dc`, tag `v0.1.1` unchanged at
`9e793dc68810b9f9df2f39684259612f75eb3a54`.

Two independent beta findings, deliberately kept apart because they have
different causes, different risks and different implementation shapes:

- **Track A** — BETA-001, the 3MF production extension and multi-model-part
  references.
- **Track B** — BETA-002, a 3MF model entry that expands past the 256 MiB
  per-entry ceiling.

They interact, and §12 of this document says how. They do not collapse into one
patch.

---

# Track A — the 3MF production extension

## A.1 What the specification actually requires

Read from the normative text at
`3MFConsortium/spec_production`, `3MF Production Extension.md`, and quoted
rather than paraphrased because the whole design turns on two sentences.

**Namespace.** `http://schemas.microsoft.com/3dmanufacturing/production/2015/06`.
The alternatives sub-extension is a SEPARATE namespace,
`http://schemas.microsoft.com/3dmanufacturing/production/alternatives/2021/04`.

**The declaration is mandatory when the feature is used.**

> "In order to avoid data loss while parsing, a 3MF package which uses
> referenced objects MUST enlist the production extension(s) as 'required
> extension', as defined in the core specification."

**…but the converse does not hold.**

> "The path attribute is optional, even for 3MF containers that claim support
> for the production extension."

So a declaration does not imply cross-part geometry. The Stage 6B-C1 truth
table's Case C — declared, unused — remains legal and remains unobserved in the
wild.

**One build section, in the root model part only.**

> "only the build section of the root model file contains valid build
> information. Other model streams SHOULD contain empty build sections. Every
> consumer MUST ignore the build section entries of all referenced child model
> files."

**`path` on a component is root-only.**

> "only a component element in the root model file MAY contain a path
> attribute. Non-root model file components MUST only reference objects in the
> same model file."

**And therefore the graph is one level deep, by construction.**

> "These two limitations ensure there is only a single level of 'depth' to
> multi-file model relationships within a package and explicitly prevents
> complex or circular object references."

**A non-root `path` is a required error, not a tolerated oddity.**

> "Any consumer of a 3MF package that contains path attributes in components in
> a non-root model file MUST generate an error for that package."

**Paths are absolute within the package.** `path` is "an absolute path to the
target model file inside the 3MF container" — i.e. `/3D/Objects/object_1.model`,
leading slash included. `ST_Path` imposes no further lexical restriction, so
every restriction CAD Fixer applies is its own and must be justified as such.

**Referenced objects carry their own resources.**

> "All of the resources associated with the referenced object (textures,
> materials, thumbnails, name, part number, etc.) MUST come from the referenced
> object file."

**Nested components inside a referenced object are ordinary components.**

> "A path attribute can reference an object in a target file that is made up of
> components. In this case, the same processing rules apply as with a local
> component object: the object transforms are relative to the item transform and
> consumers MUST not alter the relative transformations within the component
> objects."

**Units across model parts: the specification says nothing.** Each `<model>`
element independently carries the core `unit` attribute, defaulting to
millimetre. No normative text defines what a referenced part's differing unit
means. §A.7 decides CAD Fixer's answer and says why it is a refusal rather than
a conversion.

**OPC relationships.** All model parts MUST be reachable through `.rels`;
non-root parts MUST NOT appear in the root `.rels` and MUST appear in the
referencing model part's own `.rels`. Relationship type
`http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel`.

**UUIDs.** `p:UUID` is `use="required"` in the schema and every statement about
it is a PRODUCER obligation — "Producers MUST include…". Nothing conditions
consumer geometry on it.

### The one fact that makes this affordable

The extension eliminates cross-part cycles **in a conforming package**, by
construction, in the spec's own words. That does not mean CAD Fixer may assume
it: a non-conforming package is exactly the input a bounded reader exists for.
It means the cycle question has a cheap, total answer (§A.6) rather than
needing a general graph algorithm.

## A.2 What CAD Fixer does today, and where it assumes one model part

```
read3mf(bytes)
  readZipDirectory(bytes)            → every entry, no content read
  findModelEntry(entries)            → ①
  readZipEntry(bytes, modelEntry)    → the ONLY entry ever inflated
  context.decodeText(modelBytes)     → one whole XML string
  parseModelXml(xml)                 → ② ③ ④ ⑤ ⑥
  materialiseMeshes(model)           → ⑦
  expandBuild(model, limits)         → ⑧ ⑨
  → GeometryDocument
```

Every numbered site assumes exactly one model resource table.

| #   | Site                                                     | The assumption                                                                                                             |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ①   | `findModelEntry`                                         | Picks `3d/3dmodel.model`, else the first `*.model`. One entry, chosen once, never revisited.                               |
| ②   | `requiredextensions` check on `<model>`                  | Refuses the production namespace outright. This is the gate BETA-001 hits.                                                 |
| ③   | `crossPart` / `productionPathOf`                         | Detects a production `path` in order to REFUSE it. The detection is already correct; only the action is a refusal.         |
| ④   | `objects: Map<string, ObjectRecord>` keyed by `id` alone | Object identity is the bare `objectid`. Two model parts may each declare `id="1"` legally.                                 |
| ⑤   | `ThreeMfDuplicateObjectId`                               | Duplicate detection is package-wide because the map is. Correct within one part, wrong across parts.                       |
| ⑥   | post-scan component and build validation                 | Resolves every `objectid` against the single map. This is what produced BETA-001's original "object which does not exist". |
| ⑦   | `materialiseMeshes(model)`                               | Walks one `ParsedModel`'s objects.                                                                                         |
| ⑧   | `expandBuild(model, …)` and its `walk`                   | `model.objects.get(objectId)` — one table. Cycle set `path: ReadonlySet<string>` holds bare object ids.                    |
| ⑨   | budget accounting inside `expandBuild`                   | Triangle/vertex/part totals are per-`ParsedModel`, so they would restart per model part.                                   |

Two further blockers that are not on that list because they are not assumptions
so much as outright refusals of conformant input:

- **`parseModelXml` refuses a model with no build items** (`ThreeMfNoBuildItems`).
  A conformant non-root model part carries an EMPTY build section, so today's
  parser cannot read one at all. Discovered while building the Stage 6D
  multi-part benchmark, which had to give its non-root parts a build item to get
  past this.
- **`describeUnsafePath` rejects any path starting with `/` as an "absolute
  path".** That is the correct rule for a ZIP ENTRY NAME. It is the exact
  opposite of the rule for a production `path` ATTRIBUTE, where the leading
  slash is REQUIRED. The two must not share one function (§A.5).

## A.3 The target package graph

```
PackageModelGraph
  rootPath        : ModelPartKey                  the entry findModelEntry chose
  parts           : Map<ModelPartKey, ModelPart>  parsed at most once each
  budget          : InflationBudget               ONE, shared across every part

ModelPartKey      normalised package path, lower-cased for lookup,
                  carrying the ZIP entry's own spelling for reporting

ModelPart
  key             : ModelPartKey
  role            : 'root' | 'referenced'
  unit            : string | undefined            as DECLARED, never defaulted here
  objects         : Map<ObjectId, ObjectRecord>   part-local, ids may repeat across parts
  build           : BuildItem[]                   read only when role === 'root'
  unsupported     : Set<string>
```

Cross-part identity becomes the pair, everywhere:

```
ObjectKey = `${ModelPartKey}#${ObjectId}`
```

never the bare `objectId`. This is the same lesson as the document invariant
**THE PART IS PART OF THE IDENTITY**: two model parts of one package carry
identical object ids, so an id comparison cannot say which mesh a reference
describes. Duplicate-id detection (⑤) moves inside `ModelPart`; two parts each
declaring `id="1"` is legal and must not be refused.

`expandBuild`'s budget counters move up to the graph, so triangle, vertex and
part totals are package-wide and the "checked BEFORE the part is appended"
property is preserved unchanged.

## A.4 Lazy loading, and what "reachable" means

A model part is parsed **only when something reachable from the root build
names it**, and **at most once**:

```
parse root model part
  → for each build item:  path? → ensure that part is loaded
  → for each component in the root part: path? → ensure that part is loaded
  → expand, resolving every (partPath, objectId)
```

A `.model` entry that nothing references is never opened, never inflated and
never charged against the inflation budget. This matters twice: it is the
resource-safety property Track B depends on (§12), and it is the reason a
package's unread thumbnails and slicer blobs stay unread.

**One parse per part.** A package may place the same referenced object fifty
times; the part is parsed once and its `CanonicalMesh` shared by every
placement, exactly as repeated placements of one local object already share one
mesh today. The existing `materialiseMeshes` sharing property extends to the
graph without change.

## A.5 Path resolution

A production `path` is a PACKAGE path, not a filesystem path and not a ZIP entry
name. It gets its own function, `resolvePackagePath`, and the existing
`describeUnsafePath` is left alone.

Rules, in order, all applied before any entry is opened:

1. **Length** — the existing `maxPathLength` (512).
2. **No control characters**, by the same rule and for the same reason as
   `describeUnsafePath`: checked on characters the decoder preserved.
3. **Leading `/` REQUIRED.** The spec says absolute-within-container. A relative
   `path` is malformed, not resolved against anything — resolving it would be
   CAD Fixer inventing a base.
4. **No `\`**, no drive letter, no URL-like scheme. Same reasoning as the ZIP
   rule: `a\..\..\b` slips past a forward-slash-only check.
5. **No `..` segment, no `.` segment, no empty segment, no percent-encoded
   traversal.** Refused, never normalised away — normalising invites a second
   round of the same argument.
6. **Strip the leading `/`**, then match case-insensitively against ZIP entry
   names. `readZipDirectory` already refuses case-colliding entries, so exactly
   one entry can match and the platform cannot decide which.
7. **The target MUST be a real central-directory entry.** No entry, no
   resolution — a new refusal, `THREEMF_MODEL_PART_NOT_FOUND`, distinct from
   "object not found".
8. **The target MUST end in `.model`.** A `path` naming a thumbnail or a
   settings blob is malformed, and opening it would be reading an entry for a
   reason the package did not state.
9. **The resolved key is canonical**, so two spellings of one part resolve to
   one `ModelPart` and it is parsed once.

**No filesystem access, no network access, no relationship following.** The
resolved target is always an entry of the archive already in memory.

**`.rels` is NOT parsed to resolve geometry**, and this is a deliberate
departure from strict OPC conformance checking. The `path` attribute states the
target directly; requiring a matching relationship would add an XML parse per
part and refuse files whose producers get `.rels` subtly wrong, in exchange for
no security property — the path cannot escape the archive regardless. Recorded
here so that adding the check later is a decision rather than a discovery. The
existing invariant that **no 3MF relationship is ever resolved** is therefore
preserved rather than weakened.

## A.6 Cycles and depth

**Cycle detection is on `ObjectKey`, not `ObjectId`.** The path set carried
through `walk` holds `(modelPartPath, objectId)` pairs, so

```
A.model:1 → B.model:2 → A.model:1
```

is refused deterministically as `THREEMF_COMPONENT_CYCLE`, at the moment the
repeat is seen, in whatever order the walk reaches it. **Depth is not the cycle
detector and must not become one** — an explicit visited-path set is what makes
the refusal deterministic rather than a function of where the ceiling happens to
sit.

The specification says a conforming package cannot contain such a cycle. CAD
Fixer does not get to assume the input conforms; that sentence is why the case
is cheap to handle, not why it can be skipped.

**Depth stays 16, and a path transition does not reset it.** A cross-part
component consumes a level exactly as a local one does. Raising the ceiling to
accommodate the extension would be widening a bound to fit an input, which is
backwards; nothing about crossing a model-part boundary makes a deeper graph
cheaper to expand.

**A `path` on a component in a NON-ROOT part is refused**, as the specification
requires a consumer to do — `THREEMF_NON_ROOT_PATH`. This is one of the two
rules that make the graph single-level, so honouring it is also what makes the
depth argument above true.

## A.7 Transforms and units

### Transforms

Composition order is unchanged, because the specification says a cross-part
component behaves exactly as a local one:

```
part.transform = compose(item.transform,
                         component₁.transform,
                         …,
                         componentₙ.transform)
```

left-to-right, outermost first, via the existing `composePartTransforms`, in
Float64, never narrowed and never baked into positions. A build item with
`path` places the referenced object with the item's transform; a component with
`path` composes as any component does. The existing
`ExpandedBuild.expandedFromComponents` flag and the
`THREEMF_COMPONENT_HIERARCHY_FLATTENED` warning already describe the loss
correctly and need no change: a cross-part hierarchy is flattened for the same
reason a local one is.

**`GeometryDocument`'s transform model is untouched.** Nothing about the
production extension needs a new placement concept.

### Units — the decision the spec does not make

CAD Fixer holds **ONE unit authority: `GeometryDocument.unit`**, and it **never
rescales coordinates**. Those two invariants together force the answer:

- **All reachable model parts declare the same unit** (after applying the
  specification's millimetre default to each `<model>` independently, which is
  the format stating a value rather than CAD Fixer inventing one) → that is the
  document's unit.
- **Any two reachable parts disagree** → **refuse**,
  `THREEMF_INCONSISTENT_MODEL_PART_UNITS`. Not "root dominates", because that
  would silently reinterpret a part authored in inches as millimetres and change
  what every coordinate means while leaving the numbers identical. Not
  "rescale", because rescaling changes the stored values that exact topology,
  no-tolerance repair and exact self-intersection all depend on. The
  specification defines neither behaviour, so picking one would be CAD Fixer
  guessing at intent in the one place it has consistently refused to.

An unreachable part's unit is never read, because the part is never parsed.

## A.8 Production-extension feature inventory

| Feature                                                   | Class                     | Why                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p:path` on `<item>`                                      | **SUPPORTED**             | Geometry-bearing. The whole point of Track A.                                                                                                                                                                        |
| `p:path` on `<component>` in the ROOT part                | **SUPPORTED**             | Geometry-bearing.                                                                                                                                                                                                    |
| `p:path` on `<component>` in a NON-ROOT part              | **UNSUPPORTED_REQUIRED**  | The spec requires a consumer to error. Refuse.                                                                                                                                                                       |
| Multiple `.model` parts                                   | **SUPPORTED**             | Reachable ones are loaded lazily.                                                                                                                                                                                    |
| Empty `<build/>` in a non-root part                       | **SUPPORTED**             | Must parse. Today it is refused as `THREEMF_NO_BUILD_ITEMS`.                                                                                                                                                         |
| Non-empty build in a non-root part                        | **IGNORED_SAFE**          | The spec requires consumers to ignore it. Ignoring cannot change geometry — it can only add placements the package did not ask for.                                                                                  |
| `p:UUID` on build / item / object / component             | **IGNORED_SAFE_METADATA** | Traceability identifiers. Producer obligations, not consumer ones. No geometry, no transform. Not retained; export writes none.                                                                                      |
| `<alternative>` / `<alternatives>` (2021/04 namespace)    | **UNSUPPORTED_REQUIRED**  | **Substitutes geometry.** Choosing an alternative — or ignoring one — changes which mesh the user sees. `lowres` and `obfuscated` are by definition not the model. Refuse; never silently take the enclosing object. |
| `pa:modelresolution`                                      | **UNSUPPORTED_REQUIRED**  | Same reason; it is the attribute that decides which geometry is intended.                                                                                                                                            |
| Root `.rels` / per-part `.rels`                           | **IGNORED_SAFE_METADATA** | Not resolved, by §A.5. Recorded as not interpreted.                                                                                                                                                                  |
| Secure Content extension (encryption)                     | **UNSUPPORTED_REQUIRED**  | Already refused by the generic `requiredextensions` gate. Unchanged.                                                                                                                                                 |
| Textures, materials, property groups in a referenced part | **IGNORED_SAFE_METADATA** | Exactly as in the root part today: recorded by name, never resolved, never fetched.                                                                                                                                  |

**The rule applied throughout: if ignoring it could change geometry or
transforms, it is not ignorable.** That is why the alternatives sub-extension is
`UNSUPPORTED_REQUIRED` even though it lives under the same family name, and why
a non-root part's build section — which can only ADD placements the root did not
request — is safely ignorable.

## A.9 Track A decision — **A1**

**Implement reachable multi-model-part production support.**

- BETA-001 is confirmed at S2 against a real file: a standards-compliant class
  of package cannot be imported at all.
- The producers make it structural, not incidental. Bambu Studio, OrcaSlicer and
  PrusaSlicer each set the declaration only when they have actually moved meshes
  out of the root part (`3MF_INTEROPERABILITY_RC.md`), so this class grows with
  multi-material and multi-plate use rather than being a curiosity.
- The subset needed is small and bounded: `path` on items and root components,
  package-path resolution, per-part object tables, and lazy loading. The
  specification's own single-level guarantee removes the hard graph problems.
- The safety analysis found no blocker. Every new refusal has a specific code;
  every new input is an entry of an archive already in memory; the inflation
  budget, the part ceiling and the triangle and vertex totals all survive
  unchanged by being moved up one level.

Not A2. Keeping the refusal would mean a truthful message in front of a
capability gap that is now measured, reproduced and growing.

## A.10 Track A staging

Four substages, each independently verifiable, none of which changes user-facing
behaviour until 6D-A2 lands.

**6D-A1 — package graph and path resolution.** `ModelPartKey`,
`resolvePackagePath` with its own tests including every refusal in §A.5, the
`ModelPart` record, and `parseModelXml` gaining a `role` so a referenced part
with an empty build parses instead of being refused. Lazy loader with
parse-once caching, sharing the one `InflationBudget`. **No reader behaviour
change:** the production refusal still fires in `read3mf`, so nothing new
imports yet.

**6D-A2 — cross-part object, component and build resolution.** `ObjectKey`
everywhere; duplicate-id detection moves inside `ModelPart`; `expandBuild` walks
the graph with package-wide budget counters; the production refusals in
`read3mf` are replaced by resolution. **BETA-001's class of file imports at the
end of this substage.**

**6D-A3 — validation, cycles, transforms, units.** Cross-part cycle detection on
`ObjectKey`; depth unchanged across boundaries; `THREEMF_NON_ROOT_PATH`;
`THREEMF_MODEL_PART_NOT_FOUND`; `THREEMF_INCONSISTENT_MODEL_PART_UNITS`; the
alternatives namespace refused as `UNSUPPORTED_REQUIRED`; transform composition
proved against the spec's stated semantics; unsupported-feature reporting and
its copy.

**6D-A4 — interoperability qualification.** The `production_ext` fixture plus
synthetic packages covering every row of §A.8 and every refusal in §A.5–A.7; a
differential run against the existing corpus proving **zero compatibility
regressions**; browser-level qualification through the harness suite.

---

# Track B — the 297 MiB entry

## B.1 The current memory path

For a 3MF whose model entry expands to `E` bytes, these are live SIMULTANEOUSLY
at the points marked:

```
 the archive buffer            A            transferred into the worker, live throughout
   │
   ├─ readZipDirectory         —            reads the directory only; allocates nothing
   │
   ├─ readZipEntry
   │    chunks: Uint8Array[]   E            every inflated chunk, retained
   │    out = new Uint8Array   E            allocated, then filled FROM chunks
   │                          ↑ both live at once ⇒ 2 × E          ◀ measured 2.0–2.1 ×
   │
   ├─ decodeText(modelBytes)
   │    modelBytes             E            still referenced by read3mf's frame
   │    xml : string           E            one-byte V8 string, ON-HEAP
   │                          ↑ both live at once ⇒ 2 × E          ◀ measured 2.0–2.1 ×
   │
   ├─ parseModelXml(xml)
   │    xml                    E            live for the whole scan
   │    modelBytes             E            never released
   │    positions: number[]    8 B / coord  PACKED_DOUBLE, plus growth doubling
   │    triangles: number[]    8 B / index
   │    per-element garbage    —            one attribute Record + decoded strings PER ELEMENT
   │                          ↑ occupancy ⇒ 3.0–3.8 × E            ◀ measured
   │
   ├─ materialiseMeshes
   │    number[] scratch       retained     ParsedModel outlives this call
   │    Float32Array positions 12 B / vertex
   │    Uint32Array indices     4 B / index
   │
   └─ expandBuild → GeometryDocument
        then: assertMeshStructure, assertGeometryDocument,
              buildRenderSnapshot (positions copy + normals, 24 B / vertex)
```

Three duplications, and they are different kinds:

- **The inflate double-buffer is pure waste.** `chunks` is dead the instant
  `out` is filled, and `entry.uncompressedSize` — already checked against
  `maxEntryBytes` before anything is inflated — is exactly the size `out` needs.
- **Bytes-plus-string is structural for a whole-string parser.** `scanXml` takes
  a `string`. Removing this overlap means not having a whole string.
- **The `number[]` scratch is a representation choice**, retained until
  `read3mf` returns because `ParsedModel` outlives `materialiseMeshes`.

## B.2 Measurements

Apple M1, 8 GiB, macOS, node v22.22.2 darwin/arm64, `npm run bench:large-entry`.
**One size per process**, `--expose-gc`, and each stage's floor taken after a
forced collection, so a stage's number is its own cost rather than the
accumulated residue of the previous one.

The metric is **`heapUsed + arrayBuffers`** — what V8 says it is holding — not
RSS. RSS on macOS is lazily accounted in both directions and reported peaks
BELOW readings the loop body had already taken. RSS is recorded alongside as
corroboration only.

Fixture: a valid one-object 3MF whose model XML is generated to a chosen
uncompressed size, at a ~12:1 deflate ratio, which is the ratio a real model XML
achieves. **Nothing is written to disk and nothing is committed.**

### Per-stage cost, as a multiple of the entry

| Entry     | Archive  | Triangles | `readZipEntry`      | `decodeText`    | `parseModelXml`   |
| --------- | -------- | --------- | ------------------- | --------------- | ----------------- |
| 125.7 MiB | 10.5 MiB | 713,922   | 266 MiB — **2.12×** | 251 MiB — 1.99× | 477 MiB — 3.79×   |
| 250.0 MiB | 20.6 MiB | 1,405,419 | 503 MiB — **2.01×** | 499 MiB — 2.00× | 951 MiB — 3.81×   |
| 295.4 MiB | 24.3 MiB | 1,656,525 | 618 MiB — **2.09×** | 608 MiB — 2.06× | 874 MiB — 2.96×   |
| 377.1 MiB | 30.9 MiB | 2,108,130 | 759 MiB — **2.01×** | 754 MiB — 2.00× | 1,306 MiB — 3.46× |

### Stage durations

| Entry     | inflate | decode | parse    | whole `read3mf` |
| --------- | ------- | ------ | -------- | --------------- |
| 125.7 MiB | 286 ms  | 39 ms  | 1,705 ms | ~2.0 s          |
| 250.0 MiB | 927 ms  | 193 ms | 3,720 ms | ~4.1 s          |
| 295.4 MiB | 720 ms  | 253 ms | 4,468 ms | ~5.9 s          |
| 377.1 MiB | 931 ms  | 998 ms | 6,019 ms | ~8.0 s          |

### What each duplication is worth — same fixture, same floor, one variant per process, 295.4 MiB entry

| Variant                                              | Peak held | Multiple  | Time     |
| ---------------------------------------------------- | --------- | --------- | -------- |
| `readZipEntry` as it is today (chunk list + concat)  | 982 MiB   | **2.09×** | 1,381 ms |
| One buffer preallocated from the declared size       | 718 MiB   | **1.20×** | 502 ms   |
| Inflate + decode retaining nothing (streaming floor) | 423 MiB   | **0.20×** | 581 ms   |

Floor 364.0 MiB in all three. **Removing the inflate double-buffer saves
~0.9 × the entry — ≈ 264 MiB at 297 MiB — and is 2.75 × FASTER**, because the
final concatenating copy disappears.

### Reading the parse figure honestly

The 3.0–3.8× at `parseModelXml` is heap OCCUPANCY, not retention. Retained
scratch is only the `number[]` arrays: 65 MiB at 125.7 MiB, 129 MiB at 250 MiB,
152 MiB at 295.4 MiB, 193 MiB at 377.1 MiB. The rest is short-lived
per-element garbage — `readAttrs` builds one `Record<string, string>` per
element and `decodeXmlText` produces a string per attribute, and a 295 MiB model
has ~6.6 million elements. The scavenger reclaims it continuously; it raises
occupancy and it is not a leak. **A streaming design would pay the same
per-element cost**, so it is a separate optimisation from the ceiling question
and must not be counted as a benefit of streaming.

### The wall nobody chose

```
V8 MAX_STRING_LENGTH = 536,870,888 bytes = 512 MiB − 24 bytes
```

Measured on this machine: an all-ASCII buffer of 296 / 384 / 448 MiB decodes;
**512 MiB throws `Error: Cannot create a string longer than 0x1fffffe8
characters`** — an untyped engine error, not an `AppError`, with no
`ImportRefusal` code and no sentence a user could act on.

**A 512 MiB per-entry ceiling is therefore not implementable on a whole-string
parser at all.** Today's 256 MiB cap keeps CAD Fixer clear of this by a factor
of two — accidentally, since nothing in the code or in ADR 0013 mentions it.
Any cap above ~448 MiB is unsafe for the current architecture and any cap at or
above 512 MiB is broken by construction.

## B.3 The 8 GiB envelope

`docs/release/RESOURCE_POLICY.md` qualifies **8 GiB RAM, one active workspace,
one Chromium-based browser**. That envelope is not 8 GiB of headroom for one
worker:

- macOS and a browser's own processes take a substantial fixed share, and the
  policy's own Stage 5A evidence records a Chromium renderer being killed
  outright under concurrent load.
- **There is no reliable free-memory signal.** `navigator.deviceMemory` is
  coarsened in Chromium and absent in WebKit. Nothing can measure availability,
  which is exactly why the policy is a documented host expectation rather than a
  runtime tier.
- V8 with pointer compression caps the heap cage at 4 GiB per isolate
  regardless of RAM, and the XML string and `number[]` scratch are both
  ON-HEAP. Typed arrays are off-heap and bounded separately.
- The import is not the only live thing. The existing session ceilings say so:
  `maxImportPeakBytes` 1,536 MiB, `maxResidentBytes` 768 MiB,
  `maxRenderBytes` 768 MiB.

**Working budget adopted for this analysis: ≈ 1.5 GiB of modelled peak for the
importing worker**, which is `maxImportPeakBytes` and is already the number the
product enforces. It is a budget for what CAD Fixer chooses to allocate, not a
claim about what the machine has.

Against that budget the measurements read:

| Entry     | Today's import-stage peak | Headroom under 1,536 MiB |
| --------- | ------------------------- | ------------------------ |
| 250.0 MiB | ≈ 951 MiB                 | 585 MiB                  |
| 295.4 MiB | ≈ 874 MiB                 | 662 MiB                  |
| 377.1 MiB | ≈ 1,306 MiB               | 230 MiB                  |

And that is the intake alone. The canonical geometry, the render snapshot and
the outgoing document still have to fit beside it.

## B.4 Option A — raise the per-entry cap

| Candidate | Modelled intake peak (today's shape) | Compatibility gain           | ZIP-bomb exposure                          | Verdict                                                             |
| --------- | ------------------------------------ | ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| 256 MiB   | ≈ 951 MiB at 250 MiB                 | none                         | unchanged                                  | today                                                               |
| 384 MiB   | ≈ 1,306 MiB at 377 MiB               | covers the 297 MiB beta file | unchanged — the runtime budget still binds | **viable only after the double-buffer is removed**                  |
| 448 MiB   | ≈ 1.5 GiB, extrapolated              | marginal beyond 384          | unchanged                                  | no margin under the import ceiling; and 64 MiB from the string wall |
| 512 MiB   | **cannot decode**                    | —                            | —                                          | **impossible**: `MAX_STRING_LENGTH` is 24 bytes below 512 MiB       |

Raising the cap alone is the weakest option: at 384 MiB the intake peak reaches
1,306 MiB of a 1,536 MiB ceiling before any canonical geometry exists, and the
entire margin is being spent on a copy that has no reason to exist.

**Ratio and total ceilings are not touched by any candidate.** Raising
`maxEntryBytes` does not raise `maxTotalUncompressedBytes` (512 MiB),
`maxCompressionRatio` (200:1) or `maxArchiveBytes` (512 MiB), and the runtime
`InflationBudget` still refuses per chunk. A bomb gains nothing.

## B.5 Option B — streaming decompression and streaming XML

The ideal pipeline, and what it would take:

```
ZIP inflate stream → UTF-8 decoder stream → resumable token scanner → bounded geometry builders
```

**The floor is real and it is low: 0.20 × the entry**, measured, for inflate plus
incremental decode retaining nothing. Against today's 2.0–2.1× that is an order
of magnitude.

What it costs:

| Component                     | Compatible?                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZIP reader                    | **Already streaming.** `inflateRaw` yields chunks precisely so the budget can be enforced per chunk. `readZipEntry` would gain a streaming sibling; the whole-buffer form stays for small entries.                                                                                                                                                   |
| `TextDecoder`                 | **Already capable.** `decode(chunk, { stream: true })` handles split multi-byte sequences.                                                                                                                                                                                                                                                           |
| `scanXml`                     | **Rewrite.** It is `indexOf`-driven over one string with `at`, `depth` and a `while` loop. A resumable scanner must carry a partial-token tail across chunk boundaries — a tag, an attribute value, a CDATA section or a comment may straddle any boundary — and the tail itself needs a ceiling or it becomes an unbounded buffer with extra steps. |
| `describeUnsafeXml`           | **Must stay fail-closed, and it currently reads the WHOLE text** for `<!ENTITY`. A streaming version must scan the prolog before yielding any element AND keep watching for `<!ENTITY` across every chunk, with the straddle case handled. **A security check with a chunk-boundary bypass is worse than no check, because it is trusted.**          |
| Deferred reference validation | **Unaffected.** Property references, component targets and build targets are already resolved AFTER the scan, precisely so declaration order cannot refuse a valid file. That design is what makes streaming possible at all.                                                                                                                        |
| Object storage                | **Improves.** `number[]` becomes growable typed arrays sized from nothing, with the same per-object ceilings applied during growth.                                                                                                                                                                                                                  |
| Cancellation                  | **Improves, substantially** — see §B.8.                                                                                                                                                                                                                                                                                                              |
| Error positioning             | **Degrades.** A byte offset into a stream is less useful than an offset into a retained string, and no refusal may carry file content into its message.                                                                                                                                                                                              |
| Testability                   | **Degrades, and must be answered.** Every chunk-boundary case needs a fixture that forces a split at each interesting position. Without that, the boundary bugs are exactly the ones that reach users.                                                                                                                                               |

Not a rejection. It is the right long-term shape, and the specification itself
motivates the production extension by noting that a monolithic model file "could
be more that 500MB in size". But it is a rewrite of the scanner and its security
gate, and it is not what BETA-002 needs to be answered honestly.

## B.6 Option C — hybrid

Remove the measured duplication, then raise the ceiling into the margin that
frees, and fix cancellation while the path is open.

At 297 MiB, with the inflate double-buffer removed:

| Stage           | Today   | Hybrid      |
| --------------- | ------- | ----------- |
| `readZipEntry`  | 618 MiB | **355 MiB** |
| `decodeText`    | 608 MiB | 608 MiB     |
| `parseModelXml` | 874 MiB | ~720 MiB    |

The `parseModelXml` figure assumes the `number[]` scratch becomes typed arrays,
which removes the 152 MiB retained scratch and its growth doubling. Neither
change alters a single refusal, ceiling or validation.

## B.7 Unread entries — assessed separately, as required

**This is not what refused BETA-002.** That file hit `maxEntryBytes` on a
declared entry size. The unread-entry question stands on its own, and Stage 6D
does not decide it.

`readZipDirectory` charges **every declared entry** against
`maxTotalUncompressedBytes` and checks **every declared entry** against
`maxCompressionRatio`, including entries nothing will ever open. Today exactly
one entry is inflated.

| Metric                      | Whole-package model                                                               | Reachable-entry model                                                                    |
| --------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `maxTotalUncompressedBytes` | Refuses before any access. Cheap, total, and independent of what the reader does. | Refuses only what would actually be extracted. Fewer false positives on slicer projects. |
| `maxCompressionRatio`       | A single highly compressible thumbnail can refuse an otherwise fine package.      | A ratio that nothing will inflate is a fact about an entry, not a risk.                  |

**Proposed hybrid, for a later stage to decide:**

- **Keep a whole-package DECLARED ceiling**, but as its own metric —
  `declaredPackageExpandedBytes` — set generously, whose job is to refuse an
  archive that is absurd on its face before anything is read.
- **Move the binding total to reachable entries**, enforced by the runtime
  `InflationBudget`, which is already per-chunk and already does not trust the
  directory.
- **Apply the compression ratio at inflation time, per entry actually opened**,
  and drop the declared-ratio check as a REFUSAL while keeping it as an
  early-exit for entries the reader is about to open. A ratio on an unopened
  entry proves nothing about what CAD Fixer will do.

**Track A raises the stakes on getting this right**, because it makes more
entries reachable and makes "reachable" a computed property rather than the
constant one. That is an argument for deciding it deliberately, in its own
stage, not for folding it into Track B.

## B.8 ZIP-bomb threat model

| Threat                                   | What stops it now                                                                         | Under the hybrid                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Huge DECLARED uncompressed size          | `maxEntryBytes`, `maxTotalUncompressedBytes` at directory time                            | Unchanged. The entry cap moves; it does not disappear.                                                                           |
| **Forged / understated size**            | **`InflationBudget`, per chunk, before the chunk is retained.** The directory is a claim. | **Unchanged and now load-bearing for the preallocated buffer**: output beyond the declared size must be refused, not grown into. |
| Extreme ratio                            | Declared check at directory time + per-chunk check during inflation                       | Per-chunk check retained unconditionally.                                                                                        |
| Deflate output exceeding its declaration | Per-chunk entry and total checks                                                          | **A new, explicit refusal**: a preallocated buffer has a fixed size, and overrun is a hard stop.                                 |
| Many entries                             | `maxEntries` 4,096                                                                        | Unchanged.                                                                                                                       |
| **Unused malicious entry**               | Charged at directory time                                                                 | See §B.7 — undecided, and the reason it is undecided rather than relaxed.                                                        |
| **Reachable malicious entry**            | Per-chunk budget                                                                          | Unchanged. This is the case that matters and it is bounded at runtime.                                                           |
| Many reachable model parts (Track A)     | n/a today                                                                                 | One shared `InflationBudget` across the graph, plus lazy loading.                                                                |

**The non-negotiable, stated once:** any design that relaxes a directory-time
check **must keep a hard runtime inflation ceiling that does not trust the
archive.** `InflationBudget` is that ceiling; it is `readonly` on
`ZipReadOptions` specifically so a second call site cannot forget it, and
nothing in Track A or Track B may make it optional, per-entry-fresh, or
per-model-part.

**The preallocated buffer is a new trust surface and is treated as one.**
Allocating from `entry.uncompressedSize` means allocating from a number the
attacker wrote. It is safe only because that number is bounded by
`maxEntryBytes` BEFORE the allocation and because overrun and shortfall are both
refusals. Both are in the prototype that produced the 1.20× measurement.

## B.9 Cancellation

**The finding that changes the answer: `model/import` is not dispatched
interruptible.** `geometry-client.ts` sends `model/import` with
`{ onProgress, transfer: [bytes] }` and no `interruptible: true`, so no
`SharedArrayBuffer` control word is allocated for it. Repair planning, repair
candidates and the disposable-worker operations all have one; import does not.

The consequence is precise:

- The `throwIfCancelled` calls between stages in `read3mf`, and the
  `onElements` poll inside `parseModelXml`, **poll a flag that cannot change
  during a synchronous span**, because the cancel arrives as a message and the
  message cannot be read until the handler returns to the event loop.
- **Inflate IS cancellable** — `readZipEntry`'s `for await` returns to the event
  loop between chunks, so the cancel lands and `options.throwIfCancelled` fires.
  This is why MF-P22 passes today at 150,000 triangles.
- **Decode, parse, materialise and expand are NOT.** Measured uninterruptible
  tail: **≈ 3.9 s at 250 MiB and ≈ 4.7 s at 295 MiB**, growing linearly.
- **Import runs in the AUTHORITATIVE worker.** Termination is not available as a
  fallback the way it is for repair, export and hole fill — killing it would
  take the user's resident document with it.

So a user who presses Cancel after inflate completes waits out the whole tail,
and raising the entry cap lengthens it. **MF-P22 is not the test that catches
this**: it arms the cancel before the import starts, so it lands during inflate
and the ratio stays low however large the file gets. The ratio test would keep
passing while the experience got worse.

**Making `model/import` interruptible is cheap and is part of Track B's first
substage.** The poll sites already exist — `parseModelXml` calls `onElements`
every 65,536 elements, which at 295 MiB is roughly every 44 ms — and a shared
control word makes them mean something for the first time. The app is
cross-origin isolated, so `SharedArrayBuffer` is available.

Under Track A, the boundary **between model-part loads** is a natural additional
checkpoint and is an `await` already, since each part is inflated.

## B.10 A coherent resource-budget model

The current ceilings overlap in ways that make a refusal hard to explain.
Proposed vocabulary, one metric per question, each named in its own refusal:

| Metric                                      | Question it answers                             | Where enforced                 |
| ------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| `rawArchiveBytes`                           | Is the file itself too big to open?             | directory time                 |
| `declaredPackageExpandedBytes`              | Is the archive absurd on its face?              | directory time, generous       |
| `reachableExpandedBytes`                    | How much will CAD Fixer actually extract?       | **runtime**, `InflationBudget` |
| `singleEntryExpandedBytes`                  | Is one entry too big to hold?                   | directory time AND per chunk   |
| `compressionRatio`                          | Is an entry we are opening a bomb?              | per chunk, on opened entries   |
| `xmlElements`, `xmlDepth`                   | Is the markup pathological?                     | scan time                      |
| `modelParts`                                | _(new, Track A)_ How many parts may be reached? | graph expansion                |
| `objects`, `triangles`, `vertices`, `parts` | Is the geometry beyond the document?            | expansion, package-wide        |
| `estimatedGeometryBytes`                    | Will the canonical result fit?                  | document gate                  |
| `estimatedPeakMemory`                       | Will the whole transaction fit?                 | `checkImportPeak`              |

Rules: **each refusal names exactly one metric, its observed value and its
ceiling, in IEC units taken from the constant that enforces it** — which is what
Stage 6B-C1 established and what made BETA-002 classifiable. No two metrics may
answer the same question with different numbers.

## B.11 Security versus compatibility

| Strategy          | Compatibility               | Peak at 297 MiB          | ZIP-bomb resistance                                                     | Complexity | Evidence                                                |
| ----------------- | --------------------------- | ------------------------ | ----------------------------------------------------------------------- | ---------- | ------------------------------------------------------- |
| Keep 256 MiB (B4) | refuses the beta file       | n/a — refused            | strong                                                                  | none       | measured; no justification for the number               |
| Raise to 384 (B1) | covers the beta file        | ~1,306 MiB at 377 MiB    | strong — runtime budget unchanged                                       | low        | measured; leaves 230 MiB of a 1,536 MiB ceiling         |
| Raise to 512      | —                           | **cannot decode**        | —                                                                       | —          | **measured: impossible**                                |
| Streaming (B2)    | best; a later 500 MiB+ path | ~0.20 × floor + geometry | strong **if** the fail-closed XML gate survives chunking                | high       | floor measured; scanner and security gate are a rewrite |
| **Hybrid (B3)**   | covers the beta file        | **~720 MiB**             | strong, and the preallocation is bounded by a check that already exists | medium     | every component measured                                |

## B.12 Track B decision — **B3, hybrid**

**Remove the measured duplication first; raise the per-entry ceiling to 384 MiB
into the margin that frees; make import genuinely interruptible. Do not stream
yet, and do not go to 512 MiB ever on a whole-string parser.**

Why not B4: "256 MiB is today's constant" is not an architectural
justification, and §35 of this stage's brief correctly refuses to accept it as
one. The number predates any memory measurement of the path it protects.

Why not B1 alone: it spends the entire remaining margin under
`maxImportPeakBytes` on a concatenating copy that has no reason to exist. The
measurement says the copy costs 0.9 × the entry and buying the ceiling costs
less than removing it.

Why not B2 yet: the floor is genuinely an order of magnitude better and it is
the right destination, but it requires rewriting `scanXml` AND making
`describeUnsafeXml` fail-closed across chunk boundaries. A security gate that a
chunk boundary can slip past is worse than no gate because it is trusted. That
is a stage of its own, and it is not what BETA-002 needs.

Why 384 and not 448: 448 MiB leaves no margin under the import ceiling and sits
64 MiB from a hard engine wall whose failure mode is an untyped `RangeError`.
384 MiB covers the observed file with room, and the wall is documented so that
the next person to reach for 512 finds the measurement instead of the intuition.

## B.13 Track B staging

**6D-B1 — remove the duplication. No ceiling moves.** `readZipEntry` inflates
into one buffer sized from the declared entry size, refusing overrun and
shortfall explicitly; `number[]` scratch becomes growable typed arrays with the
existing per-object ceilings applied during growth. Every existing refusal,
ceiling and test unchanged. Re-run `bench:large-entry` and record the new
multiples. **This substage stands on its own even if nothing else lands.**

**6D-B2 — make import interruptible.** `interruptible: true` on `model/import`;
poll sites verified to fire; cancellation latency measured at 128 / 256 /
384 MiB; a timing test that measures the **uninterruptible tail** directly
rather than only the armed-before-start ratio MF-P22 measures.

**6D-B3 — raise `maxEntryBytes` to 384 MiB.** One constant, moved only after
6D-B1 and 6D-B2 are measured. `RESOURCE_POLICY.md` updated with the new number
AND with the `MAX_STRING_LENGTH` wall recorded as a structural bound. Tests at
the boundary: 384 MiB accepted, 385 MiB refused naming the metric.

**6D-B4 — the unread-entry decision**, on its own, with Track A's reachability
model in hand. Not folded into any of the above.

---

# §12 Track A meets Track B

Production-extension support makes CAD Fixer read MORE model entries. The
resource design can no longer assume one XML entry.

Measured: three model parts of 100 / 150 / 200 MiB, 447.1 MiB reachable in a
37.2 MiB archive, read sequentially with each part's canonical geometry retained
and its scratch released:

```
peak over fixture     408.6 MiB
surviving geometry    115.9 MiB across 3 meshes
peak ÷ largest part   2.07×
peak ÷ reachable sum  0.91×
```

**Sequential reading is bounded by the LARGEST part plus the accumulating
canonical geometry, not by the sum of the parts.** That is the property the
whole design rests on, and it holds only if each part's inflated bytes, decoded
string and scratch arrays are released before the next part is opened. It is a
consequence of §A.4's parse-once-then-materialise shape and must be asserted by
a test, not assumed.

Therefore, for `root.model 100 MiB + object1.model 150 MiB + object2.model
200 MiB`:

- **Per-entry budget** — `singleEntryExpandedBytes`, 384 MiB after 6D-B3.
  Applies to every model part independently. No part here reaches it.
- **Total reachable budget** — `reachableExpandedBytes`, enforced at runtime by
  **one** `InflationBudget` shared across the whole graph, never one per part.
  A per-part budget would be a per-part full allowance, which is how a package
  with twenty parts extracts twenty times the ceiling. 450 MiB of reachable
  model fits under today's 512 MiB; a package materially larger is refused
  naming that metric.
- **Parse and geometry lifetime** — one part in flight at a time. Its bytes,
  string and scratch die with it; only the `CanonicalMesh` survives, shared by
  every placement. The accumulating cost is canonical geometry alone, already
  bounded by `maxTotalGeometryBytes`, `maxTotalTriangles` and
  `maxTotalVertices`.
- **Cancellation** gains a free checkpoint at every part boundary, which is an
  `await` by construction.

**Ordering.** 6D-B1 should land before 6D-A2, because the double-buffer cost is
paid once per model part and Track A multiplies the number of parts. That is a
sequencing preference, not a dependency: neither track blocks the other.

---

# Stage 6D-B1 — implemented

**Landed. `readZipEntry` fills one preallocated destination. No ceiling moved.**
Base `b6c0b77b0177245f3e9c93b59b9cf3f3c3140e99`. The decision above is unchanged
by this section; what follows is what the implementation actually measured.

## What changed

`readZipEntry`'s DEFLATE path allocates one `Uint8Array` sized from the central
directory's declared uncompressed size and writes each chunk into it on arrival.
The chunk array and the concatenating copy are gone. The STORED path is
untouched — it was already zero-copy, returning a view into the archive, and
allocating a destination for it would have added the very copy this stage
removes.

Two typed refusals are new, and they are the price of using a number the archive
supplies:

- `ZIP_DECLARED_SIZE_OVERRUN` — the stream produced more than the entry
  declared. `MALFORMED_FILE`, not a resource limit: the sizes involved may be
  nowhere near a ceiling, and what is wrong is that the archive contradicts
  itself. The buffer is never grown and a second one is never allocated.
- `ZIP_DECLARED_SIZE_SHORTFALL` — the stream ended early. Returning
  `subarray(0, produced)` was the tempting wrong answer: it presents truncated
  data as a successful read, and a preallocated buffer's untouched tail is
  zeroes the entry never contained.

The declared size is proven `<= maxEntryBytes` **inside `readZipEntry`**, not
inherited from `readZipDirectory`, because a caller may read the directory under
different limits and an allocation must not depend on that having matched.

## Measured, before and after

Apple M1, 8 GiB, node v22.22.2, one size per process, `--expose-gc`, each
stage's floor taken after a forced collection. The `after readZipEntry` column
is the absolute `arrayBuffers` reading minus the fixture's, which is the
unconfounded number: it counts off-heap buffers only.

| Entry     | Inflate peak, before | after     | Retained after inflate, before → after | Inflate time, before → after |
| --------- | -------------------- | --------- | -------------------------------------- | ---------------------------- |
| 125.7 MiB | 2.12×                | **1.35×** | 264 MiB (2.10×) → **141 MiB (1.12×)**  | 286 ms → **223 ms**          |
| 250.0 MiB | 2.01×                | **1.22×** | 500 MiB (2.00×) → **292 MiB (1.17×)**  | 927 ms → **373 ms**          |
| 295.4 MiB | 2.09×                | **1.20×** | 615 MiB (2.08×) → **323 MiB (1.09×)**  | 720 ms → **590 ms**          |

The 295.4 MiB row is measured with a **benchmark-only injected ceiling**; the
production constant was not touched to obtain it.

The parse-stage peak moves too, and NOT CONSISTENTLY — worth stating rather than
quoting only the favourable rows: 477 → 358 MiB at 125.7 MiB and 951 → 820 MiB
at 250 MiB, but 874 → 1,015 MiB at 295.4 MiB. That stage is dominated by
short-lived per-element garbage — one attribute record and its decoded strings
per XML element — so its reading is heap OCCUPANCY at whatever moment the
collector happened to be in, and it varies by more than this change does.
**B1 makes no claim about the parse stage.** The inflate stage is what it
changed, and that number is stable across every size and every repeat.

Reducing the parse peak is a separate, measured opportunity: the retained
`number[]` scratch is 65–193 MiB across the ladder, and replacing it with
growable typed arrays is a candidate for its own substage.

**The production path now measures what the prototype promised.** Run
side by side on one fixture from one floor at 295.4 MiB, the shipped
`readZipEntry` measures 1.20× and the standalone preallocation prototype 1.19×.

**Time did not regress; it improved**, most at 250 MiB where the concatenating
copy was largest — 927 ms to 373 ms, about 2.5×.

## An integrity check the reader never had

This reader verifies no CRC. Before B1 a truncated entry returned short bytes
that looked like a successful read, and the damage surfaced much later as
malformed XML — telling the user their MODEL was broken when the ARCHIVE was.
The shortfall refusal is the first check that catches this, and it names the
right thing.

## What this strengthened in the bomb model

A directory that UNDERSTATES a size used to buy a full `maxEntryBytes` allowance
regardless of what it declared, because nothing compared the two. It is now
refused at the first chunk past its own declaration. The 3MF suite's lying-bomb
fixture — an 8 MiB entry declaring 1,024 bytes under a 64 KiB cap — is the
measure: the bound on what that archive can make CAD Fixer hold fell from
`maxEntryBytes` to the entry's own declaration, a factor of sixty-four there and
far more at production limits.

The runtime `InflationBudget` is unchanged and remains authoritative, charged
from bytes actually produced. It is now harder to REACH for a lying directory,
which is a strengthening rather than a relaxation, and it remains the ceiling
that does not trust the archive at all.

## What did not change

- **No resource constant moved.** `DEFAULT_ZIP_LIMITS` is byte-identical to
  `b6c0b77`: 512 MiB archive, 4,096 entries, **256 MiB per entry**, 512 MiB
  total, 200:1, 512-byte paths.
- 3MF semantics: baseline imports, the production-extension refusal, the
  dangling-reference refusal and every resource message are unchanged, verified
  in Node and in a browser.
- Cancellation opportunities inside the inflate loop are preserved exactly.

## Tests whose outcome legitimately changed

Three, each updated to assert the NEW behaviour precisely rather than loosened:

- **ZT04** reached the runtime accounting by declaring each 4 KiB entry as one
  byte. That lie is now caught at the first chunk, so the test uses honest
  metadata and a budget narrower than the directory's limits — which is the
  supported shape, and the one multi-model-part reading will need. Its
  proposition, three entries individually fine and collectively not, is intact.
- **ZT05** keeps its proposition — a lying directory is stopped at runtime — and
  asserts the earlier, more specific refusal, plus that not one byte was charged.
- **The 3MF lying-bomb fixture** now asserts `ZIP_DECLARED_SIZE_OVERRUN` and
  reads `declared` out of the refusal's own details, so it cannot pass while the
  bound silently reverts to `maxEntryBytes`.

## The gap B1 did not close

**`model/import` is still not interruptible**, so the uninterruptible tail
measured in §B.9 is exactly as it was: decode, parse, materialise and expand
still poll a flag that cannot change. B1 shortened the inflate stage; it did not
make the rest of the import stoppable. That is Stage 6D-B2 and it is unchanged
by this work.

**384 MiB is not approved.** B3 still requires B2 and browser-worker headroom
measurement after both.

# Stage 6D-B2 — implemented

**Landed. `model/import` is dispatched as an interruptible operation, and the
two long loops that had no cancellation site now have one. No ceiling moved.**
Base `3473b67521359aa5a203a9f77948fbc1c90e40e2`. The decisions above are
unchanged by this section; what follows is the defect, the fix and what was
measured.

## The defect, traced rather than inferred

`GeometryClient.importModel` dispatched `model/import` with
`{ onProgress, transfer: [bytes] }` and no `interruptible: true`. That single
omission propagates all the way down:

```
importModel                 no `interruptible`
  GeometryCoordinator.dispatch
    signal = options.interruptible === true && isSharedCancellationSupported()
           = undefined                                  ← no SharedArrayBuffer
    postMessage({ …, cancellation: undefined })         ← no control word sent
      GeometryWorkerHost.run(…, cancellationBuffer = undefined)
        cancellation = source.token                     ← MESSAGE-backed only
```

`source` is a plain `CancellationSource` flipped by the worker's `cancel`
message handler, and that handler runs on the worker's event loop. After
inflation, `read3mf` is one unbroken synchronous span — decode, the XML safety
scan, the element scan, materialisation, expansion — and the worker does not
return to its event loop once during it. The `cancel` message therefore sits
unread in the queue, `source.cancel()` is never called, and the flag every poll
along that span reads **cannot change**. `worker-host`'s post-handler
`if (cancellation.isCancelled)` check loses the same race: the result is posted
in the same macrotask, before the queued `cancel` is ever dequeued.

So the polls were not merely coarse. They were unreachable. Cancelling a 3MF
import after inflation did nothing whatsoever and the document was committed.

**MF-P22 could not have caught this**, and that is worth stating plainly: it
arms Cancel before the import starts, so the cancel lands during inflation —
which is an awaited chunk loop and was always interruptible — and its ratio
stayed comfortably under its threshold however large the file grew.

## The fix

- **`model/import` now dispatches `interruptible: true`.** One option, the
  existing Stage 3B machinery, no second cancellation framework. The coordinator
  allocates a fresh `SharedArrayBuffer` per operation, writes it with
  `Atomics.store` before posting the `cancel` message, releases it on the
  terminal message, and never reuses one — all already proven by
  `interruptible-dispatch.test.ts` for any interruptible operation, so
  `model/import` inherits per-operation freshness, stale-cancel isolation,
  idempotent double-cancel and signal release without new code.
- **`materialiseMeshes` and `expandBuild` gained poll sites.** They were the
  last two long loops in the reader with none at all. The copy loops are
  BLOCKED at 65,536 elements — the interval `scanXml` already uses — so the
  inner copy stays a tight loop with no per-element branch; `expandBuild` polls
  once per walk step, bounded by `maxParts` and `maxComponentDepth`.
- **The reader's phases are named** (`ThreeMfImportPhase`) and exported, and the
  progress block carries the raw phase as `data-phase`. `describeImportDetail`
  maps a note to a sentence for a person, which means the phase stops being
  observable the moment it is rendered — and MF-P24's whole proof is _which_
  phase was on screen when Cancel was clicked. Asserting that against display
  copy would make the proof drift the day the wording changed.

## Phase audit

Measured on the fixture ladder, 250 MiB entry, quiet machine.

| Phase                    | Duration  | Cancellation observable?                           |
| ------------------------ | --------- | -------------------------------------------------- |
| `readZipDirectory`       | ~1 ms     | after; nothing allocated during                    |
| `readZipEntry` (inflate) | ~430 ms   | **per chunk**, awaited — unchanged by B2           |
| `decodeText`             | ~90 ms    | before and after; **not during** — one sync call   |
| `describeUnsafeXml`      | ~90 ms    | **not during** — whole-text regex inside `scanXml` |
| `scanXml` / parse        | ~3,300 ms | **every 65,536 elements** — real since B2          |
| `materialiseMeshes`      | ~40 ms    | **every 65,536 elements** — new in B2              |
| `expandBuild`            | ~25 ms    | **per walk step** — new in B2                      |
| `assertMeshStructure`    | ~165 ms   | once per DISTINCT mesh                             |
| `assertGeometryDocument` | ~145 ms   | not during                                         |

## Post-cancel tail: before and after

`postCancelTailMs` is measured from the Cancel click to the terminal state
observed by the page — not from import start. Every reading below was taken with
the cancel provably landing at `ThreeMfImportPhase.Parsing`, i.e. after
inflation returned.

| Fixture                  | Before                                         | After      |
| ------------------------ | ---------------------------------------------- | ---------- |
| 600,000 triangles        | **1,632 ms — and the import committed anyway** | **64 ms**  |
| 745,000 (~128 MiB XML)   | **1,969 ms — committed anyway**                | **65 ms**  |
| 1,455,000 (~250 MiB XML) | **4,545 ms — committed anyway**                | **154 ms** |

The "before" column is the important one and it is worse than a slow tail: the
cancellation was not late, it was **ignored**. The status list read
`Loaded late-cancel.3mf: 1,455,000 triangles (3MF)` after a Cancel that had been
clicked four and a half seconds earlier.

Under heavy load (average 37) MF-P24 measured 142 ms at the default size, so the
figure degrades with the machine, as expected, and stays an order of magnitude
below the old behaviour.

## What is still synchronous, stated rather than hidden

A cancel arriving inside `decodeText` or `describeUnsafeXml` waits for that call
to finish. Measured at the 250 MiB entry ceiling that is **about 90 ms each, so
at most ~180 ms back to back** — bounded by one decode of one entry, and below
the tail already contributed by the validation gates. **B2 does not claim
streaming cancellation**, and turning the decode into a streaming one is Track
B-2's rewrite, not this stage's.

`assertMeshStructure` (~165 ms) and `assertGeometryDocument` (~145 ms) sit in
`mesh-core`, which has no cancellation concept. They were measured rather than
assumed and left alone: threading a token through the structural gates would not
move the worst case, which is already set by decode plus safety scan. They do
scale with triangle count, so at the STL input ceiling they would be larger —
recorded here as known debt rather than fixed speculatively.

## Tests

| Id       | Where                          | Proves                                                              |
| -------- | ------------------------------ | ------------------------------------------------------------------- |
| MF-P24   | `format-import.timing.spec.ts` | cancel at `Parsing` is honoured; nothing committed; worker reusable |
| MF-P25   | same                           | the page is cross-origin isolated, so the shared word really exists |
| MF-P26   | same                           | replacement-import race: A never commits, B does                    |
| B2-P1–P6 | `threemf-cancellation.test.ts` | each long loop consults the real token; phase vocabulary and order  |
| B2 guard | `production-boundary.test.ts`  | `model/import` still requests the signal, in the UNIT suite         |

**B2-P2 and B2-P3 discriminate.** They assert on `ThreeMfExpansionStats` rather
than on "was it cancelled", because `read3mf` calls `throwIfCancelled` after
expansion anyway — a test asserting only the outcome passes with both new polls
deleted. Verified by deleting them: B2-P2 fails `expected 1 to be +0` and B2-P3
fails with no cancellation at all.

**The boundary guard exists because MF-P24 and MF-P25 live in the TIMING
project**, which runs in neither `npm run verify` nor `npm run test:e2e`. A
change dropping `interruptible: true` would go green through both. Verified by
removing the flag: the guard fails.

## What did not change

- **No resource constant moved.** `maxEntryBytes` is still 256 MiB; every ZIP,
  XML and document ceiling is untouched.
- **B1's memory improvement is intact**: `readZipEntry` re-measured at **1.22×**
  the entry for a 250 MiB fixture, matching the B1 figure exactly.
- No Production Extension work. No topology, repair, hole-fill,
  self-intersection, export or viewport change.
- MF-P22 still passes, so early cancellation did not regress while late
  cancellation was fixed.

# Stage 6D-B3 — Chromium memory qualification, and the answer

**Decision: `384 MiB ENTRY LIMIT NOT APPROVED — KEEP 256 MiB`.** Base
`6de834d0cbc8ef76e5d1a1b3b929b5790975669d`. No production constant changed. The
evidence is good and it says no.

## Why Node was not enough, and what replaced it

B1 and B2 measured `heapUsed + arrayBuffers` under Node. That is the right
metric for a parser and the wrong evidence for a browser ceiling, so B3 measured
the real product path in real Chromium on the real minimum-envelope machine.

`performance.measureUserAgentSpecificMemory()` would have been the single best
signal — page and workers in one number, broken down by type. **It is NOT
AVAILABLE** in this Chromium, with cross-origin isolation satisfied and with
`--enable-experimental-web-platform-features`, `--enable-blink-features=ForceEagerMeasureMemory`
and `--enable-features=MeasureMemory` all tried. `performance.memory` is no
substitute: it is quantized for fingerprinting, main-thread only, and heap only
— it cannot see the ArrayBuffers where most of this workload lives.

Three signals were used instead:

- **Worker isolate**, CDP `Runtime.getHeapUsage` on the geometry worker's own
  target, reached through `Target.attachToTarget` on the browser session.
  `usedSize` + `backingStorageSize` is the direct Chromium analogue of the Node
  metric. Excludes everything outside that isolate.
- **Page isolate**, the same call on the page target. Where render snapshots
  land.
- **Renderer `phys_footprint` and `phys_footprint_peak`**, from macOS
  `footprint(1)`. A dedicated worker runs on its own thread inside the renderer
  process, so this covers page and worker together plus V8, Blink and
  compositor overhead. Excludes the GPU, browser and network processes.

**`phys_footprint_peak` is the number the decision rests on.** It is the
kernel's own high-water mark, so the peak does not have to be caught by a
sampler — and a sampler cannot catch it, because the interesting moments are
inside the worker's synchronous spans and every sample costs a subprocess spawn
that perturbs the machine being measured. One browser per run, so a peak never
carries across runs.

Retention figures force a collection in both isolates first
(`HeapProfiler.collectGarbage`). Without that, `usedSize` reports the decoded
XML string and the `number[]` scratch as though still live — V8 does not collect
a worker heap under no pressure — and every "retained" number would be fiction.

## Environment

macOS 27.0 (26A5421a), Apple M1, **8.00 GiB RAM** — the stated minimum envelope,
not a high-memory CI runner. arm64. Chromium 151.0.7922.34 (Playwright 1.62.1),
headless. Node v22.22.2. `crossOriginIsolated === true`, `SharedArrayBuffer`
available, `Atomics` available, `navigator.deviceMemory === 8`,
`jsHeapSizeLimit` 3,760,000,000 (≈3.5 GiB).

Fixtures generated in Node, written to a temporary directory outside Git, handed
to the browser through the real file chooser, removed on exit. Nothing committed.

## Measured

| Entry         | Renderer `phys_footprint_peak`        | Runs | Outcome  |
| ------------- | ------------------------------------- | ---- | -------- |
| 1.0 MiB       | 142 MiB                               | 1    | imported |
| 63.2 MiB      | 638 MiB                               | 1    | imported |
| 125.7 MiB     | 1,127 MiB                             | 1    | imported |
| **248.0 MiB** | **1,742 / 1,743 / 1,769 / 1,815 MiB** | 4    | imported |
| **293.7 MiB** | **2,067 / 2,098 / 2,099 MiB**         | 3    | imported |
| **376.1 MiB** | **2,679 / 2,710 / 3,071 MiB**         | 3    | imported |

Repeatability is tight where it matters: ±2% at 248 MiB, ±1% at 293.7 MiB. At
376.1 MiB it widens to **±7%, a 392 MiB spread between runs**.

Slope between the two largest in-ceiling points is about **5.6 MiB of renderer
footprint per MiB of entry**; across the whole ladder it is nearer 7. The
measured 376.1 MiB point lands where that predicts.

Every size imported successfully with the correct triangle count, no session
loss, and a small replacement model landing afterwards. **Nothing crashed.**
That is not the same as safe.

## The gate that fails

`maxImportPeakBytes` is **1,536 MiB** in `memory-budget.ts`. §19 requires the
measured peak to remain BELOW it with meaningful repeatable margin.

- At 376.1 MiB the measured peak is **2,679–3,071 MiB**, which is **1.7×–2.0×
  the budget**. There is no margin to size; the figure is on the wrong side of
  the line.
- The run-to-run spread alone (392 MiB) is larger than any headroom that could
  be claimed, which §19 names explicitly as a reason not to approve.
- A 3.07 GiB renderer on an 8 GiB machine leaves the rest of Chromium, the GPU
  and network processes, and the operating system to share what remains.

**The string wall is NOT the binding constraint.** Chromium's maximum string
length measured 536,870,888 bytes, identical to Node's; 384 MiB is 402,653,184
bytes and decodes fine, leaving **128 MiB of clearance**. Memory is what fails,
not `MAX_STRING_LENGTH`.

## The finding that outlives this decision

**The modelled import budget does not bound what actually happens in the browser
for 3MF, and it is out by roughly an order of magnitude.**

`estimateImportPeak` sums current resident, current render, the input buffer,
and the candidate's resident and render bytes. For the 376.1 MiB case that is
about **271 MiB**. The renderer actually peaked at **2,679–3,071 MiB**. The
model does not include the inflated entry, the decoded XML string, the
`number[]` scratch, the per-element parse garbage, or V8 and Blink overhead —
which together are almost all of it.

The consequence is not confined to 384 MiB: **at today's approved 256 MiB
ceiling, a 248 MiB entry already peaks the renderer at ~1.75 GiB, above the
1,536 MiB budget.** The ceiling that ships is itself less comfortable on an
8 GiB machine than the budget suggests. B3 is not authorised to lower it and
does not propose doing so — but the gap between the model and the measurement is
now recorded, and it should inform whatever comes next rather than being
rediscovered later.

## Cancellation at these sizes

B2 holds, and cleanly. Post-inflate cancellation with the phase proven at
`parsing model`:

| Entry     | postCancelTailMs | Committed? | Peak footprint |
| --------- | ---------------- | ---------- | -------------- |
| 293.7 MiB | **287 ms**       | no         | 1,001 MiB      |
| 376.1 MiB | **372 ms**       | no         | 1,263 MiB      |

Sub-second at both, nothing committed, worker alive, replacement landed.
Cancelling early also caps the peak at roughly half the completed-import figure,
which is the point of cancelling.

## Retention

No leak. After a completed 125.7 MiB import and a forced collection the worker
holds 159.6 MiB; after replacing it with a 1 MiB model the worker returns to
**2.6 MiB** and the page to 9.0 MiB, with renderer footprint falling from
1,098 MiB to 497 MiB. The same shape holds at 248 MiB. Sequential imports
stabilise rather than accumulating.

## What was not changed

- `maxEntryBytes` stays **256 MiB**. The refusal was re-verified against the
  restored build in a real browser: a 293.7 MiB entry is refused with
  `A file inside this archive expands to 294 MiB; CAD Fixer's per-entry
expansion limit is 256 MiB.`, and the renderer peaks at **125 MiB** because
  nothing is inflated.
- `maxArchiveBytes`, `maxTotalUncompressedBytes`, `maxCompressionRatio`,
  `maxEntries`, `maxImportPeakBytes` and every document ceiling: unchanged.
- B1's single-destination inflate and B2's interruptible import: unchanged and
  re-smoked (1.22×; 67 ms).

**320 or 352 MiB were not adopted as a consolation.** The brief forbids picking
an intermediate opportunistically without authorisation, and the measurements do
not single one out: the curve is smooth, so any intermediate value is a point on
the same line rather than a threshold the evidence identifies.

## What this means for BETA-002

The observed 297 MiB entry class needs about **2.1 GiB of renderer footprint**
to import as the reader is currently built. Raising a constant cannot make that
safe on the supported envelope; it would only move where the failure happens.

**The remaining route to BETA-002 is Option B — streaming import**, whose floor
was measured in the architecture stage at **0.20× the entry** for inflate plus
incremental decode retaining nothing, against the current whole-string path. A
streaming reader is the only design measured so far that could bring a 297 MiB
entry inside the envelope, and it is what the 3MF specification itself
anticipates when it motivates the production extension by noting a monolithic
model part "could be more that 500MB in size".

That is now a decision with evidence behind it rather than a preference.

## Reproduction

```bash
npm run build && npm run preview          # serve the production build
npm run qualify:chromium-memory -- --sizes 128,250
CADFIXER_QUALIFY_RUNS=3 npm run qualify:chromium-memory -- --sizes 250
CADFIXER_QUALIFY_MODE=cancel npm run qualify:chromium-memory -- --sizes 250
```

Sizes above 256 MiB require a **local qualification build** with
`maxEntryBytes` temporarily raised; that edit is never committed, and the
measurements above were taken with `main`'s constant restored and verified
byte-identical afterwards. The harness is macOS-specific for the footprint
signal (`footprint(1)`); the isolate signals work anywhere Chromium's CDP does.

# Stage 6D-A1 — package graph foundation

**Landed. Types, a resolver and a registry. NO NEW PRODUCT CAPABILITY.** Base
`6905f1138ddbb64e873818df2bddc9ebf0299753`. Every production-extension package
that was refused before A1 is refused after it, with the same code and the same
message.

## The single-part assumptions, enumerated

`read3mf` picks one entry and never revisits the choice, and from that point
`objectId` silently means "object in the one part that happens to be loaded".
The sites:

| Site                                  | The assumption                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `findModelEntry`                      | `3d/3dmodel.model`, else the first `*.model`. One entry, chosen once.                              |
| `ParsedModel.objects: Map<string, …>` | Keyed by bare `objectId`; the map IS the package's object space.                                   |
| `ThreeMfDuplicateObjectId`            | Duplicate detection is package-wide because the map is. Correct in one part, wrong across parts.   |
| post-scan component validation        | `objects.has(component.objectId)` against that one map.                                            |
| post-scan build validation            | `objects.has(item.objectId)`, same map.                                                            |
| `materialiseMeshes`                   | Walks one `ParsedModel`.                                                                           |
| `expandBuild` / `walk`                | `model.objects.get(objectId)`; the cycle set holds bare ids.                                       |
| `expandBuild` budget counters         | Triangle, vertex and part totals are per-`ParsedModel`, so they would restart per part.            |
| `ThreeMfNoBuildItems`                 | Refuses an empty build — right for the root, and it made a conformant referenced part unparseable. |

A1 addresses the last one and introduces the identity that makes the rest
fixable. It does not change any of them, because changing them without
cross-part resolution would produce half-support.

## What A1 adds

**`ModelPartKey`** — a branded canonical package identity. Not a filesystem
path, not a URL: the archive entry's own name reduced to one canonical spelling
so two references to one part share one parse. Branded for the same reason
`PartId` is: an unvalidated attacker-supplied string must not reach the lookup
that decides which bytes get parsed.

**`ObjectKey = (ModelPartKey, objectId)`** — because two model parts may each
declare `id="1"`, legally and by design. Resolving `B.model:1` against
`A.model`'s table would place a mesh that is valid, plausible and not what the
file said. The document invariant THE PART IS PART OF THE IDENTITY, one level
further out.

**`canonicalisePackagePath` / `resolvePackageModelPath`** — a resolver with its
own contract, deliberately NOT `describeUnsafePath`. The two grammars differ on
the most security-relevant character there is: an entry name must not begin with
`/` and a package reference must. Sharing a helper would mean a rule tightened
for one silently loosening the other. A test pins the disagreement, and a second
pins that it is narrow — every traversal and scheme rule is refused by both.

**`PackageModelGraph`** — the registry, generic over the parse result, enforcing
three rules by construction:

- **Parse once per canonical part**, including for concurrent callers. A package
  may place one referenced object fifty times; `ensurePart` is a get-or-parse
  and is the only way in.
- **Reachability decides what is read.** There is no `loadAll`, and a test
  asserts the absence of one. An unreferenced `.model` is never opened, never
  inflated, never charged.
- **One budget per package.** The graph HOLDS the archive's single
  `InflationBudget`. A per-part budget is a per-part FULL allowance, which is how
  twenty parts would extract twenty times the ceiling.

**`ModelPartRole`** — `Root` or `Referenced`, defaulting to `Root`. The
specification treats them differently: the root carries the package's only valid
build section, `path` on a component is root-only, and consumers must ignore a
referenced part's build entries. `parseModelXml` can now be told which it is
reading; root validation is byte-identical, and the empty-build refusal still
fires exactly where it did.

## What A1 deliberately does NOT decide

**`maxModelParts` has no production value.** The plumbing exists so A2 cannot
forget the ceiling; the number is A2's to justify with evidence. Stage 6D-B3
established that a resource value without measurement behind it is not a policy,
and inventing one here would be exactly that. A caller that passes nothing gets
no ceiling, and A1 has no production caller.

**Cross-part units are not reconciled.** `ModelPart` retains each part's
declared unit independently and nothing compares them. A3 must be able to see a
disagreement in order to refuse it; adopting the root's here would destroy the
evidence that one existed.

**Transforms are untouched.** `CrossPartObjectReference` carries source part,
target part, object id and the component's own Float64 3×4 transform. Nothing is
baked, composed or narrowed.

## THE DEBT A2 MUST CLEAR FIRST

**`estimateImportPeak` and `maxImportPeakBytes` MUST NOT be used as the safety
gate for multi-model-part loading.**

Stage 6D-B3 measured this directly in Chromium: for a 376 MiB entry the model
predicts about **271 MiB** and the renderer actually peaked at
**2,679–3,071 MiB** — out by roughly an order of magnitude, because it models
neither the inflated entry, the decoded XML string, the parser's scratch arrays,
nor V8 and Blink overhead. At the shipped 256 MiB ceiling a 248 MiB entry
already peaks around 1.75 GiB, above the 1,536 MiB budget.

A2 makes the importer read MORE parts. Gating that on a model already known to
under-predict by 10× would be building a safety argument on a number measured to
be wrong. **Stage 6D-R1 — reconcile 3MF import resource budgeting with measured
Chromium memory — is owed before A2 loads a second model part.** A1 changes
nothing about the existing model and draws nothing from it.

## Product behaviour at the end of A1

Unchanged, and asserted from this stage's own tests rather than only from the
existing suite:

- a component with `p:path` → `UNSUPPORTED_FILE` / `THREEMF_MULTI_MODEL_PART_UNSUPPORTED`
- a build item with `p:path` → the same
- `requiredextensions="p"`, Case C included → `UNSUPPORTED_FILE` / `THREEMF_UNSUPPORTED_EXTENSION`
- a same-part dangling component → `MALFORMED_FILE` / `THREEMF_MISSING_OBJECT_REFERENCE`, **never** routed through package-part lookup
- an archive holding a second, unreferenced `.model` → imports exactly as a single-part package

The production-extension fixtures in those tests contain a **real, resolvable**
second model part, so the refusal is meaningful: if the foundation ever became
reachable from production, that is the entry it would follow.

# Stage 6D-R1 — reconciling the import resource model

**Decision: `RESOURCE MODEL QUALIFIED FOR A2`.** Base
`a5a2cb4e5214e282f65a8aabcfb4953280d0945e`. **No product behaviour changed.**
The safety role moves from an estimator to the deterministic caps that already
exist, and the estimator's status is settled rather than left ambiguous.

## What the estimator actually is

`estimateImportPeak` sums five terms — current resident, current render, input
buffer, candidate resident, candidate render — and `checkImportPeak` compares
the total against `maxImportPeakBytes` (1,536 MiB). Two facts from the audit
matter more than the arithmetic:

**It runs AFTER the peak it names.** The only call site is
`commitImportedDocument`, which executes once `read3mf` has already returned a
parsed document. By then the archive has been inflated, the XML string built,
the parser scratch allocated and the canonical geometry materialised. It cannot
gate the transient peak because the transient peak has already happened; what it
actually guards is the render snapshot and the commit.

**For 3MF it is the ONLY budget, because the other one is never consulted.**
`ImportBudget` — `maxEstimatedPeakBytes`, `maxTriangles`, `maxVertices`,
`maxOutputBytes` — is used exclusively by the STL readers via `checkAllocation`
and `checkInputSize`. Neither the 3MF reader nor the OBJ reader references
`context.budget` at all.

### Domain coverage

| Memory domain                   | Modelled?                  | How                          |
| ------------------------------- | -------------------------- | ---------------------------- |
| A raw archive bytes             | **yes**                    | `inputBuffer`                |
| B inflated entry                | **no**                     | —                            |
| C decoded XML string            | **no**                     | —                            |
| D parser transient              | **no**                     | —                            |
| E geometry scratch (`number[]`) | **no**                     | —                            |
| F canonical geometry            | **yes**                    | `candidateResident`          |
| G render snapshot               | **yes** (twice, see below) | `candidateRender`            |
| H worker/V8/Blink baseline      | **no**                     | —                            |
| I renderer process footprint    | **no**                     | out of scope by construction |

B, C, D and E are the domains B1 measured as dominant, and they are precisely
the ones absent.

### A double-count, reported and not fixed

`currentRenderBytes` is documented as "bytes of render snapshot already held by
the main thread" and is passed `renderBytesFor(documentTriangles)` — the
CANDIDATE's triangle count, not the outgoing document's. The candidate's render
bytes are therefore counted twice.

The error is conservative: it inflates the estimate, so it can only refuse work,
never admit it. It is reported here rather than corrected because R1 is an
architecture stage and changing it would alter import eligibility.

## Measured error, and why recalibration cannot fix it

`npm run bench:resource-model`, Node, `heapUsed + arrayBuffers` with forced
collection between readings. Four fixture families, all inside current
production limits.

| Fixture            | entry     | measured peak | modelled | error           |
| ------------------ | --------- | ------------- | -------- | --------------- |
| F1 geometry-dense  | 63.9 MiB  | 315.4 MiB     | 97.0     | **3.25x under** |
| F1 geometry-dense  | 128.9 MiB | 411.3 MiB     | 193.9    | **2.12x under** |
| F1 geometry-dense  | 201.9 MiB | 616.7 MiB     | 303.0    | **2.04x under** |
| F2 text-heavy      | 64.5 MiB  | 157.0 MiB     | 26.2     | **5.99x under** |
| F2 text-heavy      | 128.5 MiB | 189.4 MiB     | 51.7     | **3.67x under** |
| F2 text-heavy      | 200.5 MiB | 290.5 MiB     | 80.3     | **3.62x under** |
| F3 object-heavy    | 43.1 MiB  | 88.8 MiB      | 68.6     | 1.30x under     |
| F3 object-heavy    | 135.0 MiB | 253.3 MiB     | 222.8    | 1.14x under     |
| F4 placement-heavy | 2.5 MiB   | 9.1 MiB       | 732.7    | **81x OVER**    |

**The error spans two orders of magnitude and changes SIGN with content shape.**
F4 is the case that settles it: one mesh placed 200 times costs 9 MiB and is
modelled at 733 MiB, because the model computes resident and render bytes from
the SUMMED triangle count while shared geometry is stored once. A file with
roughly 11 million summed triangles over shared placements would be refused
today while costing a few megabytes.

No scalar recalibration repairs an estimator that is 81x pessimistic on one
shape and 6x optimistic on another. The error is driven by which shape, not by
size.

## What does predict the peak

Across every family and size measured, **peak / entryExpandedBytes** ranges
**1.45x to 5.07x**. That quantity has the property the current model lacks:
`entryExpandedBytes` is the ZIP directory's declared uncompressed size, known
BEFORE anything is inflated and already bounded by `maxEntryBytes`.

The retained side needs no estimator at all — canonical geometry is already
bounded deterministically and incrementally by the per-object vertex and
triangle caps and by the document's total ceilings, checked before each part is
appended.

## Multi-part: the peak plateaus

The architectural claim was that A2's peak is the LARGEST part's transient plus
accumulated canonical geometry, not the sum of every part's XML. It had never
been measured. It holds.

**Node, five sequential ~128 MiB parts, each result retained:**

| Part | Peak          | Growth over part 1 |
| ---- | ------------- | ------------------ |
| 1    | 616.7 MiB     | —                  |
| 2    | 790.2 MiB     | +173.5             |
| 3    | 700.3 MiB     | +83.6              |
| 4    | 635.4 MiB     | +18.7              |
| 5    | **577.0 MiB** | **-39.7**          |

Accumulating transient would predict about +515 MiB of growth; canonical
geometry alone predicts about +179 MiB. Measured growth was **negative** —
later parts reuse space earlier ones released.

**Chromium, two same-size imports back to back** (the first document is still
resident while the second parses, which is A2's shape and is conservative
because the product also still holds the first render snapshot):

| Entry, twice  | Renderer `phys_footprint_peak`        |
| ------------- | ------------------------------------- |
| 63.2 MiB      | 649 MiB                               |
| 125.7 MiB     | 1,094 MiB                             |
| 197.5 MiB     | 1,616 MiB                             |
| **242.0 MiB** | **1,923 / 1,948 / 1,977 / 1,994 MiB** |

Against B3's **1,742–1,815 MiB for a single 248 MiB entry**, a second part of
the same size adds roughly **10%**, not 100%.

### How the lifetime gate was proven, and how it was not

Subtracting "held after the document is dropped" from "held while alive" turned
out **not** to resolve retention: at 128 MiB it attributed **0.0 MiB** to a
document that demonstrably held 44.8 MiB of canonical geometry, and reported
memory as held after the only reference was gone. `gc()` performs a major
collection but does not reliably compact or return pages, and any lifetime claim
built on those subtractions would be built on noise. That method is recorded as
rejected.

The plateau test is the one that survives: if inflated bytes, decoded strings or
scratch arrays stayed reachable, peak would climb by roughly one entry per part.
It does not climb at all.

## The resource contract for A2

Enforcement moves to caps that are deterministic, known before the allocation
they bound, and already implemented:

| Metric                                 | Value                              | Where enforced                          |
| -------------------------------------- | ---------------------------------- | --------------------------------------- |
| per-entry expanded                     | **256 MiB**                        | ZIP directory, and per chunk at runtime |
| package declared expanded              | **512 MiB**                        | ZIP directory                           |
| reachable expanded                     | 512 MiB, via ONE `InflationBudget` | per chunk at runtime                    |
| compression ratio                      | 200:1                              | declared and per chunk                  |
| entries                                | 4,096                              | ZIP directory                           |
| objects / triangles / vertices / parts | existing document ceilings         | expansion, **package-wide**             |
| model parts                            | no separate ceiling — see below    | —                                       |

Plus the lifetime rules A1 already encodes: one model part parsed at a time, one
package-wide budget, transient memory released before the next part opens, and
cancellation between parts as well as inside each parse.

**No new ceiling is required.** The 512 MiB package total already bounds the
worst case to two parts at the per-entry maximum, and that case measures
1,923–1,994 MiB — which is the number A2 must live with. Many smaller parts are
strictly milder: eight 64 MiB parts carry a smaller largest-transient and the
same total geometry.

**`maxModelParts` stays without a production value.** `maxEntries` (4,096) bounds
how many `.model` entries can exist, the 512 MiB reachable budget bounds how much
they can expand to, and the document's part and triangle ceilings bound what they
can produce. A separate count ceiling would add a fourth bound with no measured
case that the first three miss.

### Counters that must move to the graph in A2

`expandBuild` maintains `totalTriangles` and `totalVertices` per `ParsedModel`,
and `parts.length` is per expansion. All three would reset per model part, so
A2 must own them on `PackageModelGraph`. `maxTotalGeometryBytes` is charged per
DISTINCT mesh at the document gate and is already package-wide.

## Import-budget API decision: **D3 — retire as enforcement**

Process footprint is a **qualification** metric, not a runtime enforcement
metric. `estimateImportPeak` cannot become one: its inputs arrive after the peak,
its coverage omits the dominant domains, and its error changes sign with content
shape.

Retiring it from that role is a behaviour change and is therefore **not made in
R1**, which is an architecture stage. The direction is decided; the migration is
a separate, explicit step. Until then it remains in place, where its conservative
double-count means it can only over-refuse.

## The 256 MiB ceiling, reassessed

Unchanged, and not reopened. B3's single-entry measurement (1,742–1,815 MiB at
248 MiB) stands, and R1 adds that the multi-part worst case reaches
1,923–1,994 MiB — about 10% more. On the 8 GiB minimum host that is a renderer
approaching 2 GiB, which is materially below the 2.7–3.1 GiB that caused 384 MiB
to be rejected, and above the 1,536 MiB the old model claimed to allow.

**`384 MiB ENTRY LIMIT NOT APPROVED` remains in force.** R1 finding that
`maxImportPeakBytes` was misnamed is not a reason to revisit it; that decision
rests on measured renderer footprint, which R1 did not change.

Whether 256 MiB should itself be reduced is a separate question with its own
evidence, and R1 neither answers nor prejudges it.

# Stage 6D-R2 — retiring the import-peak gate: BLOCKED

**Decision: `A2 BLOCKED — RENDER/RESOURCE GATE REPLACEMENT REQUIRED`.** Base
`fc7b7472a12043ca1859766e9c962644b504afd8`. **No product behaviour changed.** A
migration was implemented, qualified in Chromium, found unsafe, and reverted.
What is committed is the evidence and the tooling that produced it.

## What the gate actually is, reconfirmed

`checkImportPeak` has exactly one production call site,
`commitImportedDocument`, and that function is shared by **all three formats**
— STL, OBJ and 3MF all reach it through `modelImportHandler`. It runs after the
reader has returned: the archive is inflated, the XML decoded, the scratch built
and the canonical geometry materialised. It sits immediately before
`documentBounds`, `buildDocumentRenderSnapshot` and `residentDocuments.commit`.

| Term                   | Already allocated at the gate?   | What it measures                | Accurate?                                        |
| ---------------------- | -------------------------------- | ------------------------------- | ------------------------------------------------ |
| `inputBuffer`          | yes — the file buffer is live    | the file                        | yes, but nothing the gate can prevent            |
| `currentResidentBytes` | yes — earlier documents          | resident store                  | yes                                              |
| `candidateResident`    | **yes** — geometry already built | `48 x summed triangles`         | **no**: assumes soup, and sums shared placements |
| `candidateRender`      | no — built after the gate        | `72 x summed triangles`         | **no**: the snapshot is built per DISTINCT mesh  |
| `currentRenderBytes`   | —                                | should be the outgoing snapshot | **no — CONFIRMED DOUBLE-COUNT**                  |

**`currentRenderBytes` is CONFIRMED WRONG-DOCUMENT ACCOUNTING.** Its contract
says "bytes of render snapshot already held by the main thread"; the call site
passes `renderBytesFor(documentTriangleCount(document))`, where `document` is the
candidate. The candidate's render bytes are therefore counted twice.

**The render snapshot is exactly 72 bytes per triangle of each DISTINCT mesh.**
`buildDocumentRenderSnapshot` builds one snapshot per distinct `CanonicalMesh`
and `buildDrawableTriangles` allocates `triangles * 9` floats of positions and
the same of normals. Shared placements share the buffers.

**`maxRenderBytes` (768 MiB) is enforced by nothing.** `checkResident` has no
production call site.

## The migration that was tried

`checkImportPeak` was replaced with `checkRenderSnapshot`: 72 bytes per triangle
of each distinct mesh, compared against the existing `maxRenderBytes` before the
snapshot is built. It measured the right allocation, fixed the shared-placement
false refusal — 4,000 placements of one 2,100-triangle mesh, 8.4 million summed
triangles, imported with one canonical mesh — and passed every unit test.

**It was unsafe, and the reason is STL, not 3MF.**

The retired formula is also the only thing capping binary STL below the 512 MiB
input cap. Solved against its own arithmetic:

| Gate                                      | Largest binary STL admitted                                  |
| ----------------------------------------- | ------------------------------------------------------------ |
| `checkImportPeak`, as shipped             | **317.4 MiB** (6,655,424 triangles)                          |
| the same with only the double-count fixed | 451.8 MiB (9,474,192 triangles)                              |
| `checkRenderSnapshot` at 768 MiB          | **512 MiB input cap** — a 10.7M-triangle snapshot is 737 MiB |

## Chromium, 8 GiB minimum host

`npm run qualify:stl-footprint`. Renderer `phys_footprint_peak` for the whole
session: import, the automatic analysis the application starts afterwards, the
render upload and a small replacement import. **It is not the import alone, and
this stage did not separate the two.**

With the gate removed:

| Binary STL | Triangles | Quiet (load 5–9) | Loaded (load 25–62) |
| ---------- | --------- | ---------------- | ------------------- |
| 100 MiB    | 2.10M     | **2,733 MiB**    | 2,721 MiB           |
| 200 MiB    | 4.19M     | —                | 4,075 MiB           |
| 300 MiB    | 6.29M     | **4,925 MiB**    | 4,914 MiB           |
| 340 MiB    | 7.13M     | —                | 5,572 MiB           |
| 460 MiB    | 9.65M     | —                | 6,223 MiB           |
| 511 MiB    | 10.72M    | **6,245 MiB**    | 6,441 MiB           |

Every import completed, every replacement landed, no session was lost. **A
6.2 GiB renderer on an 8 GiB machine is not safe**, and it is far above the
2.7–3.1 GiB that caused 384 MiB to be rejected in B3. Load does not explain it:
quiet and loaded runs agree within 3%.

With the gate restored, the same build refuses 340 MiB and 511 MiB (renderer
peaks 738–1,075 MiB) and imports 300 MiB (peak 5,001 MiB).

The brief's own stop condition applied — the existing deterministic caps do not
stop this growth — so the migration was reverted.

## A pre-existing finding this stage cannot resolve

**Binary STL that v0.1.1 already accepts reaches about 5 GiB of renderer
footprint.** A 300 MiB file measured 4,925 MiB quiet and 5,001 MiB on the
restored build; a 100 MiB file measured 2,733 MiB. That is well above the ~2 GiB
envelope R1 qualified for 3MF. STL packs a triangle into 50 bytes where 3MF XML
spends about 178, so the same input ceiling produces several times the geometry.

What this number includes has not been separated: the automatic topology
analysis runs after import and has its own 1,024 MiB workspace ceiling. Whether
this belongs to import eligibility, to analysis admission, or to the stated
8 GiB host claim is a decision this stage is not in a position to take. It is
recorded so it is not rediscovered.

## Other findings

**The refusal text is misleading.** The gate's refusal reads _"This would use
more memory than CAD Fixer allows for one session."_ It names no metric and no
numbers, and it presents a modelled allocation estimate as memory. It is left
unchanged here because the gate itself is due for replacement, and rewording it
now would be churn against a message that should not survive that replacement.

**The shared-placement false refusal remains.** A document placing one mesh
thousands of times can still be refused while costing a few megabytes. It is
fixable only together with a gate that also bounds STL, so it waits for one.

## Corrections to Stage 6D-R1

- **R1's `npm run verify` did not pass.** It stopped at lint on
  `no-useless-assignment` in `scripts/resource-model.bench-suite.ts`. The tests
  and build were run separately and passed, and the filtered output hid the lint
  failure. The cause is fixed in this stage: the lifetime measurement now drops
  its reference by returning from a helper, not by assigning `undefined`.
- **The retention subtraction R1 rejected is sound.** With the reference
  genuinely out of scope it attributes **exactly 1.00x canonical geometry** to a
  document, at 128.9 MiB and at 250.7 MiB. R1's zero reading came from the
  measurement code keeping the result reachable, not from the method. This
  confirms R1's lifetime conclusion directly, alongside the plateau test.

## What R3 must deliver before A2

A replacement for `checkImportPeak` that bounds the quantity that actually
drives renderer footprint across all three formats — geometry that becomes
canonical and renderable — derived from Chromium measurements, enforced before
the allocation, and naming its metric and numbers. It has to hold STL where the
shipped gate holds it today, or explicitly justify moving that line. It should
separate import from automatic analysis in the measurement, so the ~5 GiB STL
figure can be attributed.

# Stage 6D-R3 — the deterministic import gate

**Decision: `DETERMINISTIC IMPORT GATE QUALIFIED`.** Base
`8022c1881652e0b2f384c23b0425d275304478b5`. **Product behaviour changed**, in
three ways, all of them listed below and all of them qualified in Chromium on
the stated minimum host.

R2 left two facts that looked irreconcilable: the import-peak estimator is not a
truthful memory model, and removing it would admit binary STL up to 512 MiB at
6.2 GiB of renderer footprint. R3 measured the phases separately and the
apparent contradiction dissolved — **most of what R2 measured was not the
import at all.**

## The finding that reorganised the stage

R2 measured one number per session and could not attribute it. This stage reads
the renderer's `phys_footprint_peak` — which is MONOTONIC over a process's life
— at DOM transitions the application already exposes, so differencing the
checkpoints attributes each phase's incremental high-water mark directly.

The first ladder said the automatic topology analysis was not the problem:

| Binary STL, loose triangles | Triangles | import phase | analysis Δ | session peak | automatic analysis |
| --------------------------- | --------- | ------------ | ---------- | ------------ | ------------------ |
| 60 MiB                      | 1.26M     | 1,376 MiB    | +221       | 1,597 MiB    | report produced    |
| 100 MiB                     | 2.10M     | 1,859 MiB    | +791       | 2,650 MiB    | report produced    |
| 150 MiB                     | 3.15M     | 3,420 MiB    | **+0**     | 3,420 MiB    | report produced    |
| 200 MiB                     | 4.19M     | 3,926 MiB    | +310       | 4,236 MiB    | report produced    |
| 250 MiB                     | 5.24M     | 3,977 MiB    | +180       | 4,157 MiB    | **refused**        |
| 300 MiB                     | 6.29M     | 4,919 MiB    | **+0**     | 4,919 MiB    | **refused**        |

**At 250 MiB and above the analysis never runs** — `estimateTopologyWorkspaceBytes`
exceeds the 1,024 MiB workspace ceiling above 4,549,753 soup triangles, which is
a 216.9 MiB binary STL — and the peak is 4 GiB anyway. R2's 4,925 MiB at 300 MiB
is reproduced here at 4,919 MiB, and none of it is diagnostics.

Nor was it the parser. The two sizes today's gate refuses go through the whole
read and stop before the render snapshot:

| Refused at the gate | Our own buffers         | Measured  | Ratio    |
| ------------------- | ----------------------- | --------- | -------- |
| 340 MiB, 7.13M      | 340 + 245 + 82 = 667    | 738 MiB   | **1.11** |
| 511 MiB, 10.72M     | 511 + 368 + 123 = 1,002 | 1,074 MiB | **1.07** |

Parsing costs what it allocates, to within a tenth. So the entire expansion sat
between "the reader returned" and "the model is on screen".

## What was actually in there: an ungated automatic walk

**`holefill/list-loops` runs automatically after every import**, on the active
part, at any size, and it was the only automatic post-import operation with **no
resource preflight of any kind**. `extractBoundaryLoops` keeps a map entry, a
member list and a summary object carrying an identity STRING for every boundary
COMPONENT — and a mesh of loose triangles has one component per FACE.

Two 100 MiB binary STL files with the SAME triangle count, differing only in
whether their triangles meet:

| 100 MiB binary STL, 2.10M triangles | Boundary components | Session peak  |
| ----------------------------------- | ------------------- | ------------- |
| loose triangles                     | 2,097,150           | **2,650 MiB** |
| welded grid                         | 1                   | **1,055 MiB** |

`npm run bench:boundary-listing` attributes it in Node, on the same shapes:

| Shape           | Faces     | Components | Listing holds | Per face |
| --------------- | --------- | ---------- | ------------- | -------- |
| loose triangles | 200,000   | 200,000    | 192.9 MiB     | 1,011 B  |
| loose triangles | 500,000   | 500,000    | 408.8 MiB     | 857 B    |
| loose triangles | 1,000,000 | 1,000,000  | 659.8 MiB     | 692 B    |
| welded grid     | 200,344   | 1          | 22.9 MiB      | 120 B    |
| welded grid     | 1,001,112 | 1          | 0.0 MiB       | 0 B      |

A third shape separates the two variables: 100,000 welded patches of 24
triangles — 2.4M triangles, 100,000 components — peaked at 1,183 MiB, about
700 bytes per COMPONENT above the welded line. The cost tracks components, not
triangles.

**This is why no gate on geometry could ever have bounded what R2 measured.**
Two files of identical size, format, triangle count and canonical byte count
differ by 2.5x in renderer footprint, and the difference is a JavaScript object
graph whose size is a fact about topology that nothing can know before walking
it.

## The walk is now capped by a ceiling that already existed

`HOLE_FILL_MAX_PART_FACES` is 250,000. Above it **no opening can be filled**,
whichever one is chosen — so the inventory the walk produces is a list every row
of which is unusable. The handler now checks the part's triangle count and does
not start the walk, which bounds the allocation at about 250 MiB.

This is an existing ceiling applied EARLIER, not a new number. What is new is
the answer the interface gives: `inventoried: false`, a distinct
`HoleFillInventoryState.NotInventoried`, and a sentence that says CAD Fixer did
not look. **`loopCount: 0` with `state: Ready` would have told the user their
model has no open boundaries on the strength of a check that never ran**, which
is the class of claim this product's interface rules exist to prevent.

## The gate: geometry a document costs to open

`measureImportGeometry(document)` sums, **once per DISTINCT mesh**, the
canonical buffers the reader produced and the render snapshot
`buildDrawableTriangles` is about to allocate from them. It lives in
`mesh-core/import-cost.ts`, beside the function whose allocation it measures, so
the predicate and the allocation cannot drift.

```text
importGeometryBytes(document)
  = Σ over DISTINCT meshes ( meshByteLength(mesh) + 72 × triangleCount(mesh) )
  ≤ MAX_IMPORT_GEOMETRY_BYTES = 768 MiB
```

Both terms are facts about the document in hand. Neither is a prediction about
the process, and the refusal says so: _"Opening this model would need 1,000 MiB
of geometry and render buffers; CAD Fixer's limit is 768 MiB."_

### Why 768 MiB

Measured on the stated minimum host — macOS 27, Apple M1, 8 GiB, against a
production build — on binary STL whose triangles MEET, which is what a real
print model looks like:

| Gate term | Triangles | Renderer peak |
| --------- | --------- | ------------- |
| 240 MiB   | 2.10M     | 1,055 MiB     |
| 480 MiB   | 4.20M     | 1,503 MiB     |
| 720 MiB   | 6.29M     | 1,890 MiB     |

That is `638 + 1.74 × cost` MiB, linear across the range, so 768 MiB predicts
about **1,975 MiB**.

**That target is not a new judgement.** Stage 6D-B3 REJECTED a 3MF ceiling
measuring 2,679–3,071 MiB on this host; Stage 6D-R1 QUALIFIED the multi-part
worst case at 1,923–1,994 MiB. The accepted/rejected line had already been drawn
between about 2.0 and 2.7 GiB by decisions in force. This ceiling puts all three
formats inside the band that was already qualified rather than inventing a fresh
envelope for STL.

**THOSE THREE MEASUREMENTS WERE TAKEN BEFORE THE LISTING WAS CAPPED, and the
ceiling is therefore conservative by a term that no longer exists.** They
include a boundary walk over the whole part — for a welded mesh that is one
component, so the object graph is trivial, but the walk's own typed arrays are
roughly 150 bytes per face regardless of shape. The shipped build skips it above
250,000 faces, so every point measures below the line that selected the number.
That is recorded rather than re-fitted: a ceiling derived from a curve the
product has since moved BELOW is safe in the direction a ceiling should be
safe, and re-solving it against the improvement would spend the margin the
improvement bought.

**The coincidence with the retired `maxRenderBytes` is a coincidence.** That
constant was also 768 MiB, was enforced by nothing, and bounded a different
quantity. This number was solved from the table above and would have been
adopted whatever the dead constant said.

### It holds across formats and representations

The line was fitted on STL alone. Evaluated against an indexed OBJ — a different
format, a different canonical representation, half as many vertices as triangles:

| Fixture                              | Gate term | Predicted | **Measured** |
| ------------------------------------ | --------- | --------- | ------------ |
| OBJ, 2.00M triangles, 1.00M vertices | 173 MiB   | 939 MiB   | **928 MiB**  |

1.2% out, across a format boundary. That is the evidence that the metric is the
right one: it is not an STL curve wearing a general name.

### Where it runs, and what it cannot bound

`commitImportedDocument`, immediately before `buildDocumentRenderSnapshot` —
one call site, shared by all three formats, and it is the LAST THING before the
allocation it prevents.

The canonical buffers ARE already allocated when it runs, and **no gate can be
earlier for an indexed format**: an OBJ's or a 3MF's triangle count is a fact
about its CONTENTS, not its length. Those buffers are bounded independently, by
each reader's own limits and by the document gate.

**Binary STL is the one exception and it gets its own pre-gate.** STL never
welds, so both terms are fixed by the declared triangle count — four bytes at
offset 80. `DEFAULT_IMPORT_BUDGET.maxUnsharedImportTriangles` is **DERIVED**
from `MAX_IMPORT_GEOMETRY_BYTES`, never written down twice, and refuses before
the first array exists. At 120 bytes per unshared triangle it is **6,710,886
triangles**, which is a **320.00 MiB** binary file exactly.

**It does not bound the parse transient**, and does not pretend to: the inflated
3MF entry, the decoded XML string and the reader's scratch arrays are bounded by
B1's and B3's entry ceilings, which this stage did not reopen.

## The current document is deliberately not a term

Measured, not assumed. Replacing a large model with another large model does not
stack: the outgoing document's buffers are released as the successor commits,
and the second import's peak is its own. Adding the outgoing document would make
the gate refuse a file because of what the user happened to open before it —
which is exactly what the retired estimator did, and with the wrong document's
triangle count at that.

There is therefore no parameter through which resident state could enter
`checkImportGeometry`, and a test asserts the same candidate reaches the same
verdict twice over.

## What the estimator got wrong, restated against the replacement

| Defect                                                             | Replacement                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Ran after the transient peak it named                              | Names no peak. Bounds retained geometry, before the render snapshot |
| Charged summed triangles, so placements multiplied shared geometry | Counted once per DISTINCT mesh                                      |
| `currentRenderBytes` received the CANDIDATE's count                | No current-document term at all                                     |
| Assumed soup, so an indexed mesh was over-charged                  | `meshByteLength` reads the actual buffers                           |
| Refusal named no metric and no numbers                             | Names the metric, the value and the limit                           |

## Product behaviour change

**Newly accepted.** Documents that place one mesh many times. A 0.1 MiB 3MF
placing one 4,800-triangle object 4,096 times — 19.66M summed triangles, ONE
stored mesh — was refused by the old gate and measured a 77 MiB renderer
footprint doing it. It now imports. Also: indexed OBJ and 3MF above the old
line, which charged them as though they stored no shared corners; and binary STL
between 317.36 MiB and 320.00 MiB.

**Newly refused.** A document whose DISTINCT geometry exceeds 768 MiB where the
old arithmetic happened to admit it — reachable for a 3MF or OBJ carrying more
than about 6.7M unshared triangles in a small archive with nothing resident. The
binary STL line is essentially where it was: 317.36 MiB before, 320.00 MiB now.

**Changed for every large model.** A part above 250,000 triangles no longer
shows an inventory of its open boundaries. It shows a sentence saying CAD Fixer
did not look for them, and why. No opening on such a part could be filled before
this change either.

## Qualification of the shipped gate

Same harness, same host, production build, after the change:

| Binary STL, loose triangles    | Triangles | Gate term | Before    | **After**            | Whole browser |
| ------------------------------ | --------- | --------- | --------- | -------------------- | ------------- |
| 100 MiB                        | 2.10M     | 240 MiB   | 2,650 MiB | **850 MiB**          | 1,128 MiB     |
| 200 MiB                        | 4.19M     | 480 MiB   | 4,236 MiB | **1,593 MiB**        | 2,014 MiB     |
| 300 MiB                        | 6.29M     | 720 MiB   | 4,919 MiB | **1,116 MiB**        | 1,681 MiB     |
| 320.00 MiB — the exact ceiling | 6,710,884 | 768 MiB   | refused   | **1,182 MiB**        | 1,775 MiB     |
| 321 MiB — one file past it     | 6,731,856 | —         | refused   | **383 MiB, refused** | 465 MiB       |

Import time at 100 MiB fell from 28.5 s to 10.0 s as well: the walk was spending
seconds building an object graph to be thrown away.

**THE WORST POINT IS NOT THE LARGEST FILE.** 200 MiB peaks higher than 320 MiB
because the automatic topology analysis still runs below 4,549,753 unshared
triangles and is refused above it. The maximum over the whole admissible range
sits just under that boundary, at roughly 1.7 GiB — inside the qualified band,
and the reason the band was chosen rather than the largest file's number.

**A REFUSAL IS NOW CHEAP, WHICH IT WAS NOT.** The 321 MiB file peaks at 383 MiB
— the input buffer and nothing else — because the STL pre-gate refuses before
the first array. Under the old gate a refused 340 MiB file had already been
fully parsed and peaked at 738 MiB.

## What R3 did NOT do

- **It did not reopen the 256 MiB 3MF entry ceiling.** B3's decision stands.
- **It did not change the topology workspace ceiling.** 1,024 MiB, refusing
  above 4,549,753 soup triangles, exactly as before. The measurements show it is
  not the dominant term, so there was nothing to justify moving.
- **It did not change what automatic analysis runs.** Topology still runs
  automatically for the active part, and self-intersection still only below
  25,000 faces — which is why the diagnostic never appears in any figure above.
- **It did not touch A1, BETA-001 or BETA-002.**

# Stage 6D-A2 — reachable multi-model-part 3MF import

**Decision: `MULTI-MODEL-PART 3MF IMPORT QUALIFIED`.** Base
`9b851a28add7860e44acf427b81fd49c83d8dce5`. **Product behaviour changed**: a 3MF
package that keeps its objects in several model parts now imports, where v0.1.1
refused it. No resource ceiling moved.

This is the first stage in which the A1 foundation is reachable from production,
and it is the stage in which the risk profile of the 3MF reader changes
completely. Until now the whole production extension was one refusal and the only
way to be wrong was to be wrong about the category. Every reference is now a
decision about **which bytes become the user's model**, and the ways to be wrong
are silent: an id resolved against the wrong part's table, a reference the
specification forbids followed anyway, a failing part skipped and the rest
imported, each part granted the package's budget again.

## What imports now

A package whose root model part references objects in other model parts, through
the production extension's `path`, on either a `<build><item>` or a
`<component>`. The referenced parts may use core geometry semantics freely,
including their own same-part components, and their transforms compose with the
referring ones in the specification's order.

The real producer-authored `production_ext.3mf` carried in PrusaSlicer's own
repository is exactly this shape — an empty root `<resources/>`,
`requiredextensions="p"`, one build item naming `/3D/Objects/sub.model` with a
transform, and a child whose object 2 is a component wrapping the mesh object 1.
**It imports, with its transform applied.** v0.1.0 called it malformed; v0.1.1
called the extension unsupported.

## The required-extension transition

`requiredextensions="p"` no longer refuses. This is one line, and it is the whole
compatibility boundary.

It is not a weakening. The rule — the file says it cannot be understood without
these semantics, so refuse rather than import the half we recognise — is
unchanged for every extension CAD Fixer does not implement, and a production
construct outside the supported subset is still refused where it is used. What
changed is that the extension IS implemented for the part of it that decides
which geometry a package contains, which is the only part that can change what a
reader should show.

Stage 6B-C1 refused a declared-required package whose geometry was all in the
root, reasoning that the extension carries more than paths. That reasoning was
right while none of it was implemented. The test that pinned it now pins the
accepting behaviour, so the next change to it is equally deliberate.

## Reachability

**The root's build is the only build.** A referenced part's build section is
parsed into its record and never walked, because the specification requires
consumers to ignore it — and walking one would invent placements the package
never asked for. A child's build describes how that part looks ON ITS OWN.

**Reachability decides what is opened.** A `.model` entry nothing references is
never inflated, never parsed and never charged. A test proves it by putting a
MALFORMED spare part in an otherwise valid package: if reachability were not the
rule the package would be refused rather than imported.

## The walk

`expandBuild` became `expandPackageBuild`, and everything the single-part walk
guaranteed still holds — now package-wide.

| Quantity       | Before               | After                             |
| -------------- | -------------------- | --------------------------------- |
| object table   | one part's           | the part each reference NAMES     |
| cycle path     | bare object id       | `(ModelPartKey, objectId)`        |
| depth budget   | per expansion        | one, not reset at a part boundary |
| triangle total | **per parsed model** | one per package                   |
| vertex total   | **per parsed model** | one per package                   |
| part count     | per expansion        | one per package                   |
| inflation      | one entry            | one budget, every reachable entry |

The first two rows of bold are Stage 6D-R1's recorded finding: those counters
reset per `ParsedModel`, so a package of two parts each just inside the ceiling
would have passed while producing twice it. There is now one walk over the
package and therefore one of each total.

**`(ModelPartKey, objectId)` is the identity, and both halves matter.** Object
ids are unique within a model part, not within a package, so `id="1"` in two
parts is ordinary 3MF. A bare-id lookup produces a document of the right SHAPE
with the wrong geometry in it, and a bare-id cycle path refuses a perfectly
ordinary package as a loop. Both directions are tested with marker meshes, so a
mix-up is visible rather than plausible.

**`maxTotalTriangles` and `maxTotalVertices` became named `ThreeMfLimits` fields**,
defaulting to the document's and asserted equal to them. Not a new ceiling: it is
what makes the package-wide property provable at four triangles instead of
twenty million.

## Lifetime: one model part at a time

```text
open entry -> inflate -> decode -> parse -> materialise -> RELEASE -> next
```

The entry buffer and the decoded XML string are locals of the part loader, so
both become collectible when it returns. `materialiseMeshes` now **clears the
parser's Float64 scratch** once the canonical buffers exist — `number[]` at eight
bytes an element is larger than the typed arrays built from it, and with one
model part that merely inflated the peak while with a package of them it would
accumulate, because every loaded part stays reachable from the graph until the
import ends.

The walk is **strictly sequential**, and a boundary test forbids `Promise.all`.
Two reasons: the document's part order must be the file's traversal order rather
than the order loads settled, and concurrent branches would have several model
parts open at once.

## Refusals, each naming a construct

`THREEMF_MULTI_MODEL_PART_UNSUPPORTED` **was removed.** It named one sentence —
"this 3MF stores referenced objects in several model parts, using an extension
CAD Fixer does not support yet" — and that sentence stopped being true. A code
with no producer would invite reuse, and the over-broad sentence would come back
with it, telling a user to re-export a file that now opens.

| Situation                                     | Code                                    | Class       |
| --------------------------------------------- | --------------------------------------- | ----------- |
| `path` malformed — traversal, URL, drive, NUL | `THREEMF_MALFORMED_MODEL_PART_PATH`     | MALFORMED   |
| `path` names an entry not in the archive      | `THREEMF_MODEL_PART_NOT_FOUND`          | MALFORMED   |
| `path` names something that is not a model    | `THREEMF_MODEL_PART_NOT_A_MODEL`        | UNSUPPORTED |
| target part does not declare the object       | `THREEMF_MISSING_MODEL_PART_OBJECT`     | MALFORMED   |
| **same-part** reference dangling              | `THREEMF_MISSING_OBJECT_REFERENCE`      | MALFORMED   |
| a non-root part chains further                | `THREEMF_NON_ROOT_MODEL_PART_PATH`      | MALFORMED   |
| reachable parts declare different units       | `THREEMF_INCONSISTENT_MODEL_PART_UNITS` | UNSUPPORTED |
| any other extension declared required         | `THREEMF_UNSUPPORTED_EXTENSION`         | UNSUPPORTED |

**The cross-part and same-part missing-object codes are deliberately different.**
One is a broken object graph inside one file; the other is a package whose parts
disagree. They send a user to different places.

**There is no fallback in either direction.** A cross-part reference is never
retried against the referring part's table, and a local one never reaches the
package resolver. A test makes the first trap concrete: the root declares an
object with the same id the cross-part reference asks for, so a fallback would
find it and import the wrong geometry as a success.

**Units are UNSUPPORTED, not malformed.** Nothing in such a package is
self-contradictory and a producer may legitimately write it. Honouring it would
mean rescaling one part's coordinates into another's unit, and CAD Fixer never
rescales stored geometry. An absent `unit` compares as millimetre, because the
specification defaults the attribute; unreachable parts are never compared.

## Transactional

A multi-part import succeeds only if everything reachable succeeds. `read3mf`
returns a document or throws, and nothing becomes authoritative until
`commitImportedDocument` accepts one — so partial success is not a state this
layer can represent. What the tests add is that the refusal happens **after** one
or more children have been inflated, parsed and materialised, which is when "no
partial geometry" is a claim worth making.

Cancellation carries **one token for the whole package**, checked before a child
is opened, after its inflate, during its parse and after its materialisation. A
token scoped to a part would stop a thing the user cannot see rather than the
thing they asked for.

## Measured, in Chromium, on the 8 GiB minimum host

Production-extension packages, renderer `phys_footprint_peak` for the complete
user action. `npm run qualify:import-phases -- 3mf-package:<parts>:<triangles>`.

| Package                            | Expanded each | Triangles | Renderer peak   | Whole browser |
| ---------------------------------- | ------------- | --------- | --------------- | ------------- |
| MP-S — 2 parts x 400,000 triangles | ~71 MiB       | 800,000   | 494 MiB         | 680 MiB       |
| MP-L — 2 parts x 1,200,000         | ~214 MiB      | 2,400,000 | 1,236–1,254 MiB | 1,552 MiB     |
| MP-N — 4 parts x 600,000           | ~107 MiB      | 2,400,000 | 1,024 MiB       | 1,322 MiB     |

**MP-L is two parts within a byte of the 256 MiB per-entry ceiling**, 428 MiB
against the 512 MiB package total — the worst case the existing budgets permit.
It peaks BELOW the 1,742–1,815 MiB Stage 6D-B3 measured for a single 248 MiB
entry, and well below the 1,923–1,994 MiB Stage 6D-R1 measured for two such
entries imported one after the other.

**MP-N is the lifetime claim stated as a measurement.** It carries the SAME
2,400,000 triangles as MP-L over twice as many parts and peaks LOWER. The peak
tracks the largest model part's transient rather than the sum, which is what
"one model part at a time, scratch released before the next opens" has to mean
if it means anything.

Replacing an MP-L document with a 5 MiB STL added **14 MiB** to the peak and
landed, with no session loss — no monotonic growth attributable to stale
model-part parser state.

## The real producer corpus

`CADFIXER_CORPUS=<dir> npm run qualify:threemf-corpus`, which ships no fixtures:
the repository stays dataless and the files are the ones carried in the
producers' own public repositories, exactly as the v0.1.1 RC qualification used
them.

| File                         | Provenance                       | A2 result                                        |
| ---------------------------- | -------------------------------- | ------------------------------------------------ |
| `production_ext.3mf`         | **real, PrusaSlicer repository** | **imports**, 1 part, transform `50 50 0` applied |
| `prusa_fdm_roundtrip1.3mf`   | real, PrusaSlicer-2.9.6          | imports, 2 parts — unchanged                     |
| `prusa_fdm_roundtrip2.3mf`   | real, PrusaSlicer-2.9.6          | imports, 2 parts — unchanged                     |
| `prusa_sla_roundtrip1.3mf`   | real, PrusaSlicer-2.9.2          | imports, 1 part — unchanged                      |
| `prusa_sla_roundtrip2.3mf`   | real, PrusaSlicer-2.9.2          | imports, 1 part — unchanged                      |
| `prusa_wipe_tower.3mf`       | real, PrusaSlicer-2.9.0          | imports, 1 part — unchanged                      |
| `prusa_seam_test_object.3mf` | real, PrusaSlicer repository     | imports, 225,154 triangles                       |
| `buechse.3mf`                | real, PrusaSlicer repository     | imports, 1 part — unchanged                      |

**Compatibility regressions: 0.** Every file that imported under v0.1.1 imports
under A2 with the same part count.

`production_ext.3mf` is the one that changed, and it is the BETA-001 failure
class on a genuine producer-authored package rather than on a constructed one.
Its structure is precisely the supported subset: an empty root `<resources/>`,
`requiredextensions="p"`, one build item naming `/3D/Objects/sub.model` with a
transform, and a child whose object 2 wraps the mesh object 1 in a same-part
component. v0.1.0 called it malformed. v0.1.1 called the extension unsupported.
A2 imports it.

**No slicer was driven to produce any of these.** They are real packages
authored by the producers and carried in their repositories, not fresh exports
from installed applications, and none is claimed to be a Bambu Studio export.

## What A2 still does not do

- **No `p:UUID` interpretation.** It is identity metadata that cannot affect
  geometry, transform, placement, unit or which representation is selected, so it
  is ignored — the only production metadata that is.
- **No production alternatives or model-resolution switching**, no Secure
  Content, no encrypted parts, no printer settings, no slicer project metadata.
  Every one of them is still refused on declaration by the unchanged
  unknown-extension rule.
- **No streaming XML**, no change to the 256 MiB per-entry ceiling, no change to
  any Stage 6D-R3 gate.
- **`maxModelParts` still has no production value**, which is Stage 6D-R1's
  decision standing rather than an omission: the archive's entry ceiling, the one
  package-wide inflation budget and the document's part and triangle ceilings
  already bound a multi-part load. The refusal is wired so a ceiling can be
  introduced with evidence without also having to invent its error.

# Stage 6D-A3 — hardening the Production Extension against the normative text

**Decision: `PRODUCTION EXTENSION SEMANTICS HARDENED — READY FOR A4`.** Base
`6324c6d5510516065f85170992dd4f85cbbce0c2`. **Product behaviour changed in three
ways**, all of them corrections, all listed below. No resource ceiling moved.

Stage 6D-A2 made a production-extension package import. A3 is the stage that
checks the semantics are the SPECIFICATION'S rather than the ones that happened
to make A2's fixtures pass — and the stage in which a real producer corpus was
allowed to contradict the implementation.

## The normative matrix

Every rule below was read from the primary specifications during this stage
rather than recalled from A1 or A2.

| Construct                 | Normative requirement                                                                                                | CAD Fixer                                                              | Test           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------- |
| `p:path` on `<item>`      | root build only; "objectid becomes a reference to the object within the referenced model"                            | followed; object resolved in the target part                           | A3-NS, A2-X01  |
| `p:path` on `<component>` | **"ONLY valid in the root model file"**; non-root use — consumer **"MUST generate an error"**                        | `THREEMF_NON_ROOT_MODEL_PART_PATH`, before local fallback              | A3-NR          |
| non-root `<build>`        | **"Every consumer MUST ignore the build section entries of all referenced child model files"**                       | ignored, and **not validated**                                         | A3-CB1–CB4     |
| referenced resources      | **"MUST come from the referenced object file"**                                                                      | per-part object and property tables, no upward lookup                  | A3-ID, A3-PROP |
| root model part           | the target of the OPC relationship `.../2013/01/3dmodel` in the root `.rels`                                         | **now read from `.rels`** — see the defect below                       | A3-ROOT        |
| non-root in root `.rels`  | **"MUST not be referenced from the root .rels file"**                                                                | relied on: whatever it names is the root                               | A3-ROOT        |
| `requiredextensions`      | "space-delimited list of namespace **prefixes**"; consumer "MUST NOT process this model-file if they do not support" | resolved through the prefix map; production accepted, all else refused | A3-RX          |
| unknown namespaces        | **"Consumers MUST ignore all XML nodes and attributes from namespaces it does not explicitely support"**             | declared-but-unrequired extensions are ignored                         | A3-RX          |
| `unit`                    | micron, millimeter, centimeter, inch, foot, meter; default millimeter                                                | exactly those six, case-sensitive; absent = millimetre                 | A3-U           |
| resource `id`             | `xs:positiveInteger`, max exclusive 2^31                                                                             | lexical check, 1..2,147,483,647                                        | A3-IDV         |
| `transform`               | "row-major affine", twelve values, implicit `(0,0,0,1)` column                                                       | composed in row-vector order; tokens checked lexically                 | A3-TX, A3-TXV  |
| `p:UUID`                  | producer requirement; **no consumer validation mandated**                                                            | ignored, including when malformed                                      | A3-UUID        |
| alternatives (2021/04)    | a separate extension; `fullres` / `lowres` / `obfuscated` select the representation                                  | refused specifically                                                   | A3-ALT         |

## The supported subset, exactly

**SUPPORTED** — imports, with no warning about the extension:

- `p:path` on a root `<build><item>`, and on a `<component>` in the root model
  part
- any number of referenced `.model` parts, each parsed once however often named
- same-part `<components>` inside a referenced part, to the shared depth budget
- repeated references to one model part, sharing one canonical mesh
- `transform` on items and components, composed across the part boundary
- object ids scoped per model part, including the same id in several parts
- a referenced part with an empty, absent or ignorable `<build>`
- reachable parts that agree on a unit, or omit it and mean millimetre
- `p:UUID` anywhere, in any form

**UNSUPPORTED, REFUSED BY NAME** — a valid construct CAD Fixer does not
implement:

| Construct                                          | Code                                    |
| -------------------------------------------------- | --------------------------------------- |
| production alternatives / model resolution         | `THREEMF_MODEL_RESOLUTION_UNSUPPORTED`  |
| any other extension declared required              | `THREEMF_UNSUPPORTED_EXTENSION`         |
| reachable parts declaring different units          | `THREEMF_INCONSISTENT_MODEL_PART_UNITS` |
| a `path` naming something that is not a model part | `THREEMF_MODEL_PART_NOT_A_MODEL`        |

**MALFORMED, REFUSED BY NAME** — the package contradicts the specification:

| Construct                                       | Code                                |
| ----------------------------------------------- | ----------------------------------- |
| a `path` outside the root model part            | `THREEMF_NON_ROOT_MODEL_PART_PATH`  |
| a `path` that is not a well-formed package path | `THREEMF_MALFORMED_MODEL_PART_PATH` |
| a `path` naming an entry the archive lacks      | `THREEMF_MODEL_PART_NOT_FOUND`      |
| an object the target part does not declare      | `THREEMF_MISSING_MODEL_PART_OBJECT` |
| several model parts and no identifiable root    | `THREEMF_AMBIGUOUS_ROOT_MODEL_PART` |

**IGNORED AS SAFE METADATA** — proven unable to change geometry, transform,
placement, unit or which representation is selected:

- `p:UUID` on `<model>`, `<build>`, `<item>`, `<object>` and `<component>`
- a referenced part's own `<build>` entries
- a referenced part's own relationships
- `[Content_Types].xml` declarations
- elements and attributes from any namespace CAD Fixer does not implement, per
  3MF core's must-ignore rule — except the alternatives namespace, above

## Three corrections

### 1. The root model part was found by guessing

`findModelEntry` preferred `3D/3dmodel.model` and otherwise took **the first
`.model` entry the ZIP directory happened to list**. The specification identifies
the root by the OPC relationship, and the production extension adds that non-root
model files must NOT appear in the root `.rels` — so the relationship is
unambiguous and the directory order means nothing.

In a single-part package the old behaviour was harmless. **After A2 it is not**:
in a production package the first `.model` can be a CHILD, and the reader walks
the root's build — so it would expand a part the specification says to ignore, or
find no build and report a file that builds nothing. Either way it answers from
the wrong part, silently.

`resolveRootModelEntry` now tries, in order: the root `.rels` model relationship;
the conventional path; a single `.model` entry. **Several model parts with none
of those is a refusal**, `THREEMF_AMBIGUOUS_ROOT_MODEL_PART`, not a guess. A
`.rels` Target goes through `canonicalisePackagePath` — the same validation a
production `path` gets — so relationships cannot become a weaker route into the
archive, and a broken or unsafe one falls back rather than refusing a package
that plainly has a root.

### 2. Zip64 packages were refused as corrupt — and mainstream slicers write them

**This is the finding the producer corpus existed to produce.** Zip64 exists for
archives past four gibibytes, so a 512 MiB ceiling looks like it makes the whole
thing irrelevant. It does not: a writer may emit the Zip64 structures at ANY
size, and **Bambu Studio and OrcaSlicer do**. Their calibration packages are 140
and 256 kilobytes, and in both every size and offset in the central directory is
the `0xFFFFFFFF` sentinel with the real values in a Zip64 extended-information
extra field.

CAD Fixer refused all of them with _"This archive's directory is truncated"_ —
telling users their working slicer output was damaged.

`readZipDirectory` now consults the Zip64 end-of-central-directory record when,
and only when, a fixed field is its sentinel, and resolves each entry's size and
offset from the tag-1 extra field per field rather than as a block. **Every
ceiling is applied to the RESOLVED value**: checking the sentinel would refuse an
ordinary entry as four gibibytes, and skipping the check for Zip64 entries would
leave a real one unbounded. A sentinel promising a value the extra field does not
carry is malformed, never a fallback to `0xFFFFFFFF`.

64-bit fields are read as two 32-bit halves and refused above 2^53, so no offset
this reader follows can have been rounded.

### 3. A transform token was coerced rather than read

`Number('0x10')` is sixteen and `Number('Infinity')` is infinity, and neither is
an `xs:double`. Transform tokens are now checked against the lexical form first —
the same reasoning that made `pid` a lexical check. `1e400` is a valid spelling
that overflows, so the finiteness check stays.

## What is refused, and why it is not "the extension"

`THREEMF_MODEL_RESOLUTION_UNSUPPORTED` is new. The production **alternatives**
extension — `.../production/alternatives/2021/04`, a different URI — lets an
object carry `fullres`, `lowres` and `obfuscated` representations, so which
geometry IS the object depends on a selection.

**The tension with core is real and is recorded rather than glossed.** Core says a
consumer "MUST ignore all XML nodes and attributes from namespaces it does not
explicitely support", which read alone would have CAD Fixer import the base object
and report success — possibly handing a user an obscured representation as their
model. A package using alternatives is required by the production specification to
declare the extension, in which case the unknown-required rule refuses it first;
this catches the producer that did not. It is a narrow, namespace-scoped
exception, not an "unknown namespace is an error" policy, and a declared but
unused extension still imports.

## What is deliberately NOT validated

- **`[Content_Types].xml`.** A model part's content type is packaging metadata.
  What decides whether CAD Fixer reads an entry as geometry is that a production
  `path` names it, that the path ends in `.model`, and that the bytes parse as a
  model through a fail-closed scanner. Requiring a content type adds no
  protection — a non-model entry still fails to parse — and would refuse packages
  whose declarations differ only in form.
- **A referenced part's own `.rels`.** OPC conformance requires referenced model
  files to be listed in the referencing part's relationships, but the `path`
  attribute names the target directly and that is what the geometry
  interpretation rests on. Validating it would refuse packages mainstream readers
  open, for metadata that changes no geometry.
- **A referenced part's `<build>`.** Normatively ignorable, so validating it would
  be a false refusal bought with no safety.
- **`p:UUID`, in any form.** The specification puts UUIDs on producers and
  mandates no consumer validation. A malformed one imports.
- **A package that uses `p:path` without declaring the extension required.** The
  production specification says a producer MUST declare it. Refusing a file for a
  producer-side MUST that changes no interpretation would cost interoperability
  and buy nothing.

## Producer corpus — sixteen real files, all importing

Fetched into scratch and deleted; nothing is committed.
`CADFIXER_CORPUS=<dir> npm run qualify:threemf-corpus`.

| File                  | Producer          | Parts | Triangles | Result                       |
| --------------------- | ----------------- | ----- | --------- | ---------------------------- |
| `production_ext`      | PrusaSlicer repo  | 1     | 12        | imports, transform `50 50 0` |
| `fdm_roundtrip1`, `2` | PrusaSlicer 2.9.6 | 2     | 72        | imports                      |
| `sla_roundtrip1`, `2` | PrusaSlicer 2.9.2 | 1     | 24        | imports                      |
| `wipe_tower`          | PrusaSlicer 2.9.0 | 1     | 36        | imports                      |
| `seam_test_object`    | PrusaSlicer repo  | 1     | 225,154   | imports                      |
| `Büchse` (×3 repos)   | shared fixture    | 1     | 12        | imports                      |
| `flowrate-test-pass1` | **Bambu Studio**  | 9     | 6,920     | **Zip64 — was refused**      |
| `auto_pa_line_dual`   | Bambu Studio      | 16    | 192       | imports, 2 distinct meshes   |
| `pa_pattern`          | Bambu / Orca      | 1     | 12        | imports                      |
| `Orca-LinearFlow`     | **OrcaSlicer**    | 11    | 15,160    | **Zip64 — was refused**      |
| `OrcaBadge`           | OrcaSlicer        | 39    | 72,586    | imports                      |
| `OrcaSliced`          | OrcaSlicer        | 30    | 256,568   | imports                      |

**16 of 16 import. Two of them could not before this stage.** No slicer was
driven to produce any of these; they are real packages carried in the producers'
own public repositories.

## Memory: unchanged from A2

Same harness, same 8 GiB host, renderer `phys_footprint_peak`.

| Package                            | A2              | **A3**        |
| ---------------------------------- | --------------- | ------------- |
| MP-S — 2 parts x 400,000 triangles | 494 MiB         | **506 MiB**   |
| MP-L — 2 parts x 1,200,000         | 1,236–1,254 MiB | **1,271 MiB** |

Within run-to-run spread on both. A3 added a `.rels` read — a few hundred bytes
charged to the package's own budget — and changed nothing else about what an
import allocates.

## The support statement this stage earns

> **CAD Fixer supports core 3MF geometry and the geometry-reference subset of the
> 3MF Production Extension: `path` references from a root build item or root
> component to reachable model parts, with their transforms and part-scoped
> object identities. Other Production Extension semantics, and every other 3MF
> extension, are refused by name. Resource limits apply package-wide.**

Every clause is bounded by something measured or refused, and nothing broader is
claimed: not "supports the Production Extension", not "supports multi-material",
not "supports Bambu Studio files". The corpus shows sixteen real producer
packages importing; it does not show that every package those producers can emit
will.

## Product behaviour change

- **Newly accepted:** every Zip64 3MF — which is every Bambu Studio and
  OrcaSlicer package of this kind; and a production package whose root model part
  sits at an unconventional path with a correct `.rels`.
- **Newly refused:** a package using the production ALTERNATIVES extension
  without declaring it required; an archive with several `.model` parts, no root
  relationship and no conventional path; a transform token that is not an
  `xs:double`.
- **Unchanged:** every ceiling, every cancellation guarantee, core 3MF, STL and
  OBJ.

# Stage 6D-A4 — interoperability qualification and the release-candidate gate

**Decision: `INTEROPERABILITY QUALIFIED — READY FOR RELEASE CANDIDATE`.** Base
`a204af82c6ea0c58294c95192bc3b237073ec556`. No resource ceiling moved, no
geometry algorithm changed, nothing deployed and nothing tagged.

The question was not "do files import". It was whether every valid file inside
the claimed surface imports correctly, whether valid files outside it refuse
specifically, and whether malformed ones fail typed and transactionally. The
evidence below answered it — and on the way it found seven defects, all
corrected in this stage, three of them in the claimed support surface.

## The corpus

Fetched from upstream repositories into scratch storage by sparse, shallow
checkout at pinned commits, run through the production pipeline, and deleted.
**Nothing is committed.** `npm run qualify:interop-corpus` is the harness: the
worker's own sequence — `identifyFormat` from the bytes, `requireReader`,
`assertMeshStructure` per distinct mesh, `assertGeometryDocument`, the R3
geometry gate and the render expansion — and, with `CADFIXER_EXPORT=1`, an export
of every imported document to STL, OBJ and 3MF through `exportDocument`, each read
back once more independently and compared by triangle count and tight world
bounds.

| Source                                  | Commit         |     Files | Class                         |
| --------------------------------------- | -------------- | --------: | ----------------------------- |
| 3MFConsortium/test_suites (suites 1–11) | `f483d3beee06` |     1,402 | REFERENCE TEST                |
| 3MFConsortium/3mf-samples               | `665e20dc4d77` |        80 | REFERENCE TEST                |
| 3MFConsortium/lib3mf `Tests/TestFiles`  | `bfb5df00057f` |        99 | REFERENCE TEST                |
| prusa3d/PrusaSlicer                     | `6f510128d7c2` |        36 | 6 REAL, 30 REFERENCE          |
| bambulab/BambuStudio                    | `77b9dd94d1e3` |        49 | 21 REAL, 28 REFERENCE         |
| SoftFever/OrcaSlicer                    | `db91d4b63046` |        38 | 10 REAL, 28 REFERENCE         |
| Ultimaker/Cura `resources/meshes`       | `72521b78f085` |       240 | REAL                          |
| Ultimaker/CuraEngine                    | `27c70acfac15` |         3 | REFERENCE TEST                |
| assimp/assimp `test/models`             | `c693cb0d68ce` |        39 | REFERENCE TEST                |
| tinyobjloader/tinyobjloader             | `45636bdcef1a` |        55 | REFERENCE TEST                |
| WoLpH/numpy-stl                         | `b0ae1249a7d1` |        17 | REFERENCE TEST                |
| admesh/admesh                           | `e1b296b575ba` |        72 | REFERENCE TEST                |
| **Total**                               |                | **2,130** | **277 REAL, 1,853 REFERENCE** |

**REAL PRODUCER-AUTHORED** means a file a real tool wrote and a project ships as
a product resource, or a test fixture whose own metadata names the application
that wrote it. Every one is listed, with its source, commit, path, size, hash,
Zip form, extensions, producer metadata, expected and actual outcome, in
[`docs/beta/A4_REAL_PRODUCER_CORPUS.tsv`](../beta/A4_REAL_PRODUCER_CORPUS.tsv).
**SYNTHETIC** fixtures are generated in-repo and are never counted as producer
output: the 99-case mutation campaign, 37 ZIP/Zip64 unit cases, and the browser
fixtures in `e2e/format-fixtures.ts`.

**Final run: 2,130 files, 0 crashes, 1,020 imports, 3,060 exports with
parse-back — 0 export failures, 0 geometry mismatches.**

## Results by format

**STL** — 235 files (115 real). All import except PrusaSlicer's
`20mmbox-nonstandard.stl` (×3 repositories), which carries
`facet normal +inf -inf weirdvalue` and text after `endfacet`; PrusaSlicer's own
test calls it nonstandard, and refusing it as malformed is the preservation
policy. **One defect**: `20mmbox-CR.stl` — classic-Mac CR-only line endings —
was refused as unrecognisable. Fixed.

**OBJ** — 195 files (49 real). Every triangle-face file imports. 47 are refused
as polygons (`OBJ_POLYGON_UNSUPPORTED` — 11 of them Cura's printer-platform
meshes); the rest of the refusals are genuinely malformed (NaN coordinates,
zero, forward and out-of-range indices, point- and line-only files, a UTF-16
file). **One defect**, found by the mutation campaign rather than the corpus: a
face corner was coerced with `Number`, so `f 1/x 2 3`, `0x2`, `1e0` and `1.0`
all imported. Fixed.

**Core 3MF** — every real producer 3MF imports: 113 of 113 (6 PrusaSlicer, 5
Bambu Studio, 10 OrcaSlicer, 92 Cura). The 3MF Consortium's core positive suite:
**132 of 133 import**, and the one that does not is `P_XXX_0909_04`, a single
363 MiB model entry refused by `ZIP_ENTRY_TOO_LARGE` — BETA-002's class. Before
this stage **four** core positives (`0101_02`, `0102_01`, `0102_02`, `0325_01`)
were refused as "not a 3MF file": their root model parts are named
`/3D/3dmodel`, `/3D/3dmodel.moodel` and `/3D/3dmodel.part`. Fixed. 3mf-samples
`MUSTPASS`: 13 of 13.

**Production Extension** — the consortium's production positive suite: **162 of
163 import** (the same 363 MiB entry is the exception); every
`prod_alt` positive and negative is refused by name. Every real
production-extension package imports: 7 in the Bambu Studio and OrcaSlicer
repositories (`auto_pa_line_dual/single`, `pa_pattern`, `OrcaBadge`), up to 39
parts, with placements checked against producer metadata and against three
export targets.

**Zip64** — 25 Zip64 packages in the corpus, 17 of which import. The other 8
are refused for what they contain — seven require Secure Content, beam-lattice
or volumetric extensions, and one lib3mf slice fixture has no build items — and
never for their Zip form. Every real Zip64 producer package imports: 2 Bambu
Studio, 4 OrcaSlicer, 1 Cura.

## Differential geometry

Triangle counts, part counts and bounds were compared against independent
references, not against CAD Fixer's own opinion:

- **Producer metadata.** Bambu Studio and OrcaSlicer write a
  `Metadata/model_settings.config` listing every part, and per-part
  `mesh_stat face_count` where they record it. For every package that carries
  it, CAD Fixer's part count equals the producer's (16/16, 8/8, 1/1, 39/39,
  30/30, in both repositories), and its triangle total equals the sum of the
  producer's per-part face counts (192/192, 96/96). **Half the parts in the two
  `auto_pa_line` packages are Bambu `modifier_part` volumes** — settings regions,
  not printed geometry. Core 3MF represents them as ordinary mesh objects and
  says nothing about their role, so CAD Fixer imports and shows them as parts.
  That is faithful to the 3MF and a real usability gap for Bambu projects; it is
  recorded as S3 and would need vendor metadata interpretation to close.
- **Three exporters as a differential.** Every imported document was written as
  STL, OBJ and 3MF, read back, and compared by triangle total and per-vertex
  baked world bounds — 3,060 comparisons, 0 mismatches. A first pass reported
  26; the harness had compared a transformed bounding BOX with baked geometry's
  tight bounds for rotated parts. The export engine's own exact per-coordinate
  check had passed every one.
- **PrusaSlicer's own test expectations**: `20mmbox-*` import as 20 × 20 × 20
  boxes of 12 triangles, and `production_ext.3mf` places its object at
  `50 50 0`, as in A3.

## The negative cases CAD Fixer imports, and why each is right or tolerable

The conformance suite's negatives are written for a **printer** — "printer should
generate error". Of 552 negatives run, 84 import. Each was classified from the
test specification (`3MF_Test_Specification_v2_4_1`), and **none produces
geometry the file does not describe**:

| Category                                                                                                                                         | Cases                                           | Why CAD Fixer imports                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Defective meshes (negative volume, inward normals, < 4 triangles, non-manifold, duplicate vertex refs, outside build area, negative determinant) | 0411, 0416, 0418, 0421, 0426, 0427              | A repair tool exists to open these. Imported exactly; Mesh Health diagnoses them.                                    |
| OPC packaging (dotted segments, bad or duplicate relationships, external thumbnail, CMYK thumbnail, non-ASCII part name)                         | 0202–0208, 0402 01/02/04, 0403, 0405–0407, 0419 | A3's decision: a broken relationship falls back to a root the package plainly has; nothing external is ever fetched. |
| Content types                                                                                                                                    | 0204–0207, 0404, 2802_02                        | Not a geometry gate (A3).                                                                                            |
| Metadata, `xml:space`, non-root `.rels` ids                                                                                                      | 0409, 0410, 0413_01                             | Not interpreted.                                                                                                     |
| Production UUIDs, dot-leading part name                                                                                                          | 0802, 0415_01                                   | Producer-side requirements; not validated (A3).                                                                      |
| Materials on a component object                                                                                                                  | 0424                                            | Materials are not interpreted.                                                                                       |
| 0420_01                                                                                                                                          | 1                                               | This copy of the file contains no DTD; its suite-1/2/4 twins do and are refused.                                     |

`0402_03` — a start part pointing at a thumbnail — **now refuses**, because the
relationship is honoured whatever the part is called and a PNG is not a model.
`N_DPX_3314_01` **now refuses** — see correction 4. 3mf-samples `MUSTFAIL`: 7 refused, 31 imported — 18 materials-extension data
errors and one duplicated core `basematerials` (materials are not interpreted),
5 OPC relationship checks, 3 schema, `xml:space` and whitespace checks, 2
metadata checks, and 2 object-`type` checks. CAD Fixer does not interpret an
object's `type`, so a build item naming a `type="other"` object imports its
geometry; that is S3, and the geometry itself is exactly what the file holds.

## Valid-but-unsupported matrix

| Semantic                                                               | Where observed                    | Outcome                                                                  |
| ---------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| Production alternatives (model resolution)                             | suite 5 `prod_alt`, 30 files      | `THREEMF_MODEL_RESOLUTION_UNSUPPORTED` or unsupported-extension, by name |
| Secure Content                                                         | suite 8, lib3mf, 70 files         | `THREEMF_UNSUPPORTED_EXTENSION`                                          |
| Materials declared required                                            | suite 6, 359 files                | `THREEMF_UNSUPPORTED_EXTENSION`                                          |
| Slice, beam lattice, booleans, displacement, volumetric, triangle sets | suites 1, 4, 7, 9, 10, 11, lib3mf | `THREEMF_UNSUPPORTED_EXTENSION`                                          |
| Unknown required extension, unresolvable required prefix               | mutation campaign, lib3mf         | `THREEMF_UNSUPPORTED_EXTENSION`                                          |

Every one is `UNSUPPORTED_FILE`, none is called malformed, and none commits any
geometry. Optional (not required) extension content is ignored: suite 6's eight
materials-optional positives import their geometry.

## Alternatives policy review: `KEEP REFUSAL`

Every one of the 21 official `prod_alt` positives declares the alternatives
namespace **required**, so core's unknown-required rule refuses them before A3's
namespace-scoped exception is reached. No official case uses alternatives
without declaring them, so no evidence shows the refusal contradicting required
consumer behaviour, and the reason for it — `fullres` versus `lowres` versus
`obfuscated` decides which geometry is the object — is unchanged.

## Seven corrections

1. **A root model part not named `.model` was refused as "not a 3MF file"** (S2).
   The OPC relationship's TYPE makes a part the root; the relationship is now
   read first, and its target goes through `canonicalisePackagePartName` — every
   shape rule, no suffix. A production `path` keeps the suffix rule, and
   `canonicalisePackagePath` is that function plus the suffix.
2. **OBJ export was refused for every ASCII STL with an unnamed `solid`, and for
   every hole-filled grouped mesh** (S2). The OBJ writer emitted a record only
   for a non-empty name or a material change, so an empty-named group — and the
   faces after a group — had no boundary on the way back in, and parse-back
   refused the export. Found through numpy-stl's `Moon_Chinese.stl` and assimp's
   `empty_mat.obj`. The writer now emits a run start wherever OBJ needs one, and
   `expectedObjRoundTrip` states the one thing OBJ cannot say: once a run has
   started, faces in no group come back in an empty-named group.
3. **A damaged deflate stream escaped as an untyped `TypeError`** (S2 — the
   fuzz-lite invariant forbids INTERNAL for bad data). The user saw the file name
   followed by an EMPTY message. Found by the mutation campaign. `readZipEntry`
   now converts only what the decompressor's `next()` throws. **The first
   version of this fix was itself a memory regression** — see _Memory_ below —
   and the memory gate is what caught it.
4. **Foreign-namespace elements were read as core geometry** (S3). `d:vertex`
   and `d:triangle` inside a displacement mesh became the object's mesh;
   `N_DPX_3314_01` imported 36 triangles from objects with no core mesh. A
   prefixed element now needs a prefix bound to the core namespace; unprefixed
   elements keep their meaning, because lib3mf's v0.9.3 fixtures use the
   pre-release default namespace.
5. **ZIP directory hardening** (S3). A Zip64 locator leading to a corrupt record
   fell back to sentinel values and was reported as 65,535 entries; split
   archives were followed; offsets and compressed sizes outside the archive were
   carried into arithmetic; a deflated entry declaring output from zero
   compressed bytes skipped the ratio check and was allocated at its declared
   size; stored entries with contradictory sizes were accepted; an EOCD
   signature inside a comment shadowed the real record.
6. **OBJ face corners are checked lexically** (S3), as 3MF transform tokens are.
7. **An ASCII STL line ends at LF or CR** (S3).

Correction 5 also changed two TEST fixtures, deliberately: the browser and
worker "archive over the total budget" fixtures declared 2 MiB of compressed data
per entry inside a few-hundred-byte file. They now carry real incompressible
bytes, so the ceiling they exist to prove is the only one they can reach.

## Mutation campaign

`packages/file-formats/src/mutation-campaign.test.ts`: 99 deterministic cases
over six valid seeds — entry deletion and renaming, path traversal, encoding and
URL forms, object-id and namespace mutation, required-extension mutation,
transform tokens, units, DOCTYPE injection, truncation at five points, deflate
corruption in Zip32 and Zip64 form, directory, EOCD and Zip64 corruption,
encryption and method flags, declared-size overrun, shortfall and bombs, and
STL/OBJ truncation, counts, tokens and corners. **Every outcome is a correct
import or a typed MALFORMED / UNSUPPORTED / RESOURCE / CANCELLED refusal; none is
a crash or INTERNAL.** Before this stage two failed that invariant and six OBJ
corners imported.

## Browser proofs

`e2e/interop-recovery.spec.ts`:

- **Recovery**, for malformed STL, malformed OBJ, malformed 3MF, unsupported 3MF,
  a resource refusal, a corrupt Zip64 record and a corrupt deflate stream: the
  open model stays on screen, the message is specific and never internal, and
  the next file — a production 3MF — imports.
- **Supersession** of a six-part, 360,000-triangle production package by an STL
  chosen mid-import: the STL lands and the package never overwrites it.
- **Cancellation** of the same package mid-child: the open model is kept and the
  worker imports again.
- **Locality**: STL, OBJ, core, production and Zip64 3MF imported and each
  exported to all three formats — zero requests off the application origin.

`e2e/format-import.timing.spec.ts` MF-P27: a 180,000-triangle, six-part Zip64
production package keeps the UI thread under a third of the import window and
under one second absolutely. Measured longest main-thread gaps on the final
production build, two runs each: 1 M-triangle binary STL 19 ms, 150 k core 3MF
18–19 ms, 180 k six-part Zip64 production 3MF 17–18 ms, 150 k OBJ 17 ms.

**Two load-sensitive proofs failed once and are recorded, not hidden.** In one
full `test:e2e` run under host load (1-minute load average ~13), the large-STL
responsiveness check timed out at 30 s; it passed 3/3 in isolation and in the
next full run (186 passed). In one `test:e2e:harness` run under the same load,
§44's 1,000-placement main-thread gap measured 1,991 ms against a 775 ms ceiling;
it measured 224–312 ms in three isolated runs and 247 ms in the next full run
(77 passed). Neither path is touched by this stage.

## Memory

Renderer `phys_footprint_peak`, production build, the 8 GiB minimum host,
`npm run qualify:import-phases`. A4 and A3 builds were served side by side and
run **interleaved**, because on this host A3 alone ranged 1,241–1,730 MiB for
MP-L across runs — the host's memory state moves the number more than most code
changes do.

| Case                                         | A3 (interleaved)                              | **A4 final**              |
| -------------------------------------------- | --------------------------------------------- | ------------------------- |
| MP-L — 2 parts x 1,200,000 triangles         | 1,241 / 1,259 / 1,269 / 1,280 / 1,281 / 1,294 | **1,199 / 1,220 / 1,261** |
| MP-S — 2 parts x 400,000                     | 506 (A3 record)                               | **511**                   |
| 320 MiB binary STL, the exact R3 ceiling     | 1,182 (R3 record)                             | **1,182**                 |
| Bambu `flowrate-test-pass1` (Zip64, 9 parts) | —                                             | **112**                   |
| Orca `OrcaBadge` (production, 39 parts)      | —                                             | **125**                   |

No session loss and no crash in any run.

**THE GATE CAUGHT A REGRESSION THIS STAGE INTRODUCED.** The first version of
correction 3 wrapped the decompressor in an `async function*` that converted its
failures and re-yielded each chunk. MP-L then peaked at **1,564–1,706 MiB over
nine runs**, never once reaching A3's range. A third build — identical except for
a direct `next()` loop — measured 1,221 / 1,242 / 1,291 MiB against A3's 1,241 /
1,294 / 1,269 in the same round-robin. The extra hop per chunk let the
decompressor run ahead of the consumer, so inflated chunks queued beside the
preallocated entry buffer. The shipped loop is the direct one, and a boundary
test keeps async generators out of `zip.ts`.

## Resource policy — unchanged, and checked

`maxEntryBytes` 256 MiB, `maxTotalUncompressedBytes` 512 MiB,
`maxCompressionRatio` 200:1, `MAX_IMPORT_GEOMETRY_BYTES` 768 MiB and the STL
pre-gate of 6,710,886 triangles are byte-identical to A3. The deleted import-peak
APIs remain absent (boundary test). One `InflationBudget` still spans every
model part.

## What A4 did NOT do

No streaming import, no ceiling change, no alternatives, no Secure Content, no
material or texture import, no OBJ polygon triangulation, no CRC verification,
no deployment, no tag.

## Release version recommendation: `v0.2.0`

Since v0.1.1 the product gained a capability — production-extension multi-part
3MF import — and Zip64 intake, a changed import resource gate, and a corrected
OBJ export. That is a feature release of the Technical Preview, not a patch.

# Acceptance targets

## BETA-001

The original class of file must:

- import the complete intended geometry, with every reachable model part
  resolved;
- place every part at the transform the package specifies, composed in the
  spec's order, in Float64, never baked into positions;
- carry one document unit, taken from the parts' agreement, and refuse rather
  than reconcile a disagreement;
- pass `assertMeshStructure` per distinct mesh and `assertGeometryDocument`
  before anything becomes resident;
- refuse truthfully and specifically for every semantic CAD Fixer does not
  implement — non-root `path`, alternatives, a missing model part, a missing
  object, a cycle, mixed units — each with its own `ImportRefusal` code;
- **never silently omit a referenced object.** A reference that cannot be
  resolved refuses the import. There is no partial success.

## BETA-002

Either:

- a valid ~297 MiB model entry imports, within a modelled peak that fits the
  8 GiB envelope, with cancellation that responds in bounded time and with
  ZIP-bomb defences unweakened — which is what B3 is chosen to deliver; **or**
- it is refused by a ceiling whose value is justified by measurement recorded in
  this document, in a message naming the metric, the observed value and the
  limit.

**Retaining 256 MiB because it is today's constant satisfies neither.**
