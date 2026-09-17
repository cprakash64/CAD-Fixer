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
