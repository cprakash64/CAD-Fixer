# Resource Policy

Two different things get called "limits" and conflating them is how a product
ends up either refusing work it could do or attempting work it cannot finish.

- **Structural ceilings** are architectural. They are enforced in code, before the
  dangerous allocation, and they are frozen — Stage 5B may not raise them.
- **Release-qualified operating policy** is what has actually been measured to
  work on a supported host. It is smaller, and it is a statement about evidence.

Qualified in Stage 5B at commit `8a800b5e137602008eced0aef3fd9beee5bcfe9c`.
Import resource bounds re-derived and re-qualified in Stage 6D-R3.

## Structural ceilings (frozen)

All enforced **before** the allocation they protect against.

| Subsystem                        | Ceiling                                         | Enforced in                                    |
| -------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| Input bytes, any format          | 512 MiB                                         | `budget.ts`, `obj/limits.ts`, `threemf/zip.ts` |
| STL triangles                    | 20,000,000                                      | `checkAllocation`                              |
| Import geometry, any format      | **768 MiB** distinct canonical + render bytes   | `checkImportGeometry`                          |
| Unshared (STL) triangles         | **6,710,886 → a 320.00 MiB binary file**        | `checkAllocation`, before the first array      |
| OBJ line / objects / groups      | 65,536 each                                     | `obj/limits.ts`                                |
| OBJ vertices                     | 40,000,000                                      | `obj/limits.ts`                                |
| OBJ face vertices                | 3 — n-gons refused, never fanned                | `obj-reader.ts`                                |
| 3MF archive / entries            | 512 MiB / 4,096                                 | `zip.ts`                                       |
| 3MF model entry, expanded        | **384 MiB** (6E-A4; 256 MiB before)             | `size-limits.ts` → `zip.ts`                    |
| 3MF streaming route threshold    | **128 MiB** per model entry                     | `ingestion-route.ts`                           |
| 3MF expanded total               | 512 MiB, charged **per chunk during inflation** | `InflationBudget`                              |
| 3MF compression ratio            | 200:1                                           | `zip.ts`                                       |
| 3MF objects / component depth    | 65,536 / 16                                     | `threemf-reader.ts`                            |
| XML elements / depth             | 80,000,000 / 64                                 | `xml-scan.ts`                                  |
| Document parts                   | 4,096                                           | `document.ts`                                  |
| Document triangles / vertices    | 20,000,000 / 60,000,000                         | `document-validation.ts`                       |
| Document geometry bytes          | 768 MiB                                         | `document-validation.ts`                       |
| Topology workspace               | 1,024 MiB → **4,549,753 unshared faces**        | `requestAnalysisWorkspace`                     |
| Boundary-loop listing            | not run above **250,000 faces**                 | `holeFillListLoopsHandler`                     |
| Self-intersection automatic band | 25,000 faces                                    | `policy.ts`                                    |
| Self-intersection hard ceiling   | 250,000 faces                                   | `policy.ts`                                    |
| Conservative repair peak         | 1,024 MiB                                       | `requestRepairPeak`                            |
| Hole-fill boundary vertices      | 512                                             | `mesh-hole-fill/limits.ts`                     |
| Hole-fill part faces             | 250,000                                         | `mesh-hole-fill/limits.ts`                     |
| Export output / serialised       | 256 MiB / 512 MiB, 3MF XML also ≤ entry ceiling | `export-contract.ts`, incrementally            |
| Render device pixel ratio        | **2**                                           | `create-viewport.ts`                           |

**These are not all the same number, and that is correct.** Different operations
have different memory profiles, so a model can legitimately be importable,
renderable and exportable while being too large for the self-intersection check or
for a hole fill. Feature-level refusal is the honest answer; rejecting an
otherwise useful model is not.

## Stage 6D-A2: the package-wide accounting is now operational

Until Stage 6D-A2 a 3MF import read exactly one model part, so "package-wide"
and "per model part" were the same number and nothing could tell them apart. A
package now loads every model part its root build can reach, and the distinction
became real.

**Nothing moved. What changed is the SCOPE of what already existed.**

| Ceiling                     | Value      | Scope after A2                          |
| --------------------------- | ---------- | --------------------------------------- |
| per-entry expanded          | 256 MiB    | each `.model`, as before                |
| package expanded, per chunk | 512 MiB    | **one budget, every reachable entry**   |
| compression ratio           | 200:1      | unchanged                               |
| archive entries             | 4,096      | unchanged                               |
| document triangles          | 20,000,000 | **summed across reachable model parts** |
| document vertices           | 60,000,000 | **summed across reachable model parts** |
| document parts              | 4,096      | **placements from every model part**    |
| import geometry             | 768 MiB    | per DISTINCT mesh, wherever it was read |
| component depth             | 16         | **one budget, not reset at a boundary** |

Stage 6D-R1 recorded that the triangle and vertex counters reset per parsed
model, so a package of two parts each just inside the ceiling would have passed
while producing twice it. There is now one walk over the package and therefore
one of each total.

**`maxModelParts` still has no production value**, and that is Stage 6D-R1's
decision standing: the entry ceiling, the one package-wide inflation budget and
the document's part and triangle ceilings already bound a multi-part load.

### Measured in Chromium, on the 8 GiB minimum host

Production-extension packages, renderer `phys_footprint_peak` for the complete
user action:

| Package                            | Expanded each | Triangles | Renderer peak   | Whole browser |
| ---------------------------------- | ------------- | --------- | --------------- | ------------- |
| MP-S — 2 parts x 400,000 triangles | ~71 MiB       | 800,000   | 494 MiB         | 680 MiB       |
| MP-L — 2 parts x 1,200,000         | ~214 MiB      | 2,400,000 | 1,236–1,254 MiB | 1,552 MiB     |
| MP-N — 4 parts x 600,000           | ~107 MiB      | 2,400,000 | 1,024 MiB       | 1,322 MiB     |

**MP-L is two parts within a byte of the 256 MiB per-entry ceiling**, 428 MiB
against the 512 MiB package total. It peaks at 1,236–1,254 MiB — **below the
1,742–1,815 MiB Stage 6D-B3 measured for a SINGLE 248 MiB entry**, and far below
the 1,923–1,994 MiB Stage 6D-R1 measured for two such entries imported back to
back. The transient really is released between parts.

**MP-N carries the same 2,400,000 triangles as MP-L over twice as many parts and
peaks LOWER**, at 1,024 MiB. That is the lifetime property stated as a
measurement: the peak tracks the LARGEST model part's transient, not the sum of
them, so many smaller parts are strictly milder than few larger ones.

**Retention**: replacing an MP-L document with a 5 MiB STL added **14 MiB** to
the peak and landed. No monotonic growth attributable to stale model-part parser
state. The settled figure stays near 1 GiB, which is the allocator not returning
pages rather than anything the reader holds.

`npm run qualify:import-phases -- 3mf-package:2:1200000` reproduces it. The real
producer corpus is run with `CADFIXER_CORPUS=<dir> npm run qualify:threemf-corpus`,
which ships no fixtures — the repository stays dataless.

## Stage 6D-A3: Zip64, and where the root model part comes from

**No ceiling moved.** Two intake corrections, both found by running real
producer output against the reader.

**Zip64 directories are read.** Zip64 exists for archives past four gibibytes,
but a writer may emit its structures at any size — and **Bambu Studio and
OrcaSlicer do**, in calibration packages of 140 and 256 kilobytes where every
size and offset is the `0xFFFFFFFF` sentinel. CAD Fixer refused all of them as
corrupt archives. The Zip64 end-of-central-directory record and the tag-1 extra
field are now consulted when, and only when, a fixed field is its sentinel.

**Every ceiling is applied to the RESOLVED value**, which is the part that
matters here: checking the sentinel would refuse an ordinary entry as four
gibibytes, and skipping the check for Zip64 entries would leave a real one
unbounded. A sentinel promising a value the extra field does not carry is
malformed, never a silent fallback to `0xFFFFFFFF`. Sizes and offsets are read
as two 32-bit halves and refused above 2^53.

**The root model part comes from the package, not from directory order.** It is
the target of the OPC relationship `.../2013/01/3dmodel` in the root `.rels`,
then the conventional path, then a single `.model` entry — and **several model
parts with none of those is a refusal** rather than a guess. The relationship
Target is validated by the same resolver a production `path` uses.

| Ceiling                     | Value   | Scope                                               |
| --------------------------- | ------- | --------------------------------------------------- |
| per-entry expanded          | 256 MiB | unchanged, now also for Zip64 entries               |
| package expanded, per chunk | 512 MiB | unchanged; the root `.rels` is charged too          |
| compression ratio           | 200:1   | unchanged, checked on the declaration first         |
| archive entries             | 4,096   | unchanged, taken from the Zip64 record when present |

**Multi-part memory is unchanged.** MP-S measured 506 MiB against A2's 494 MiB
and MP-L 1,271 MiB against A2's 1,236–1,254 MiB — run-to-run spread on both. The
only new allocation is the root `.rels`, a few hundred bytes charged to the
package's own inflation budget.

Reproduce the producer corpus with
`CADFIXER_CORPUS=<dir> npm run qualify:threemf-corpus`, which ships no fixtures.

## Stage 6D-R3: the import-peak gate is gone, and so is an unbounded walk

**`estimateImportPeak`, `checkImportPeak` and `maxImportPeakBytes` are deleted.**
So are `checkResident`, `maxRenderBytes`, `residentBytesFor` and
`renderBytesFor`. What replaces them is narrower and true.

### The gate

```text
importGeometryBytes(document)
  = Σ over DISTINCT meshes ( canonical bytes + 72 × triangles )
  ≤ 768 MiB
```

Canonical buffers plus the render snapshot that is about to be built from them,
**counted once per distinct mesh**. Enforced in `commitImportedDocument`,
immediately before `buildDocumentRenderSnapshot`, for all three formats. Binary
STL additionally gets a pre-parse ceiling **derived** from the same constant —
6,710,886 triangles, a 320.00 MiB file — because STL never welds, so its cost is
fixed by the declared count before any array exists.

### The finding that mattered more than the gate

**`holefill/list-loops` runs automatically after every import and had no
resource preflight at all.** Its cost scales with boundary COMPONENTS, of which
a mesh of loose triangles has one per face. Two 100 MiB binary STL files with
identical triangle counts, differing only in whether their triangles meet,
measured **2,650 MiB** and **1,055 MiB** of renderer footprint.

The walk is now skipped above `HOLE_FILL_MAX_PART_FACES` (250,000) — the ceiling
above which no opening could be filled anyway — and the interface says the
openings were **not looked for**, never that there are none.

### Measured on the minimum host, before and after

macOS 27, Apple M1, **8 GiB**, production build, binary STL of loose triangles.
Renderer `phys_footprint_peak` for the whole user action.

| Binary STL | Triangles | Before    | After         |
| ---------- | --------- | --------- | ------------- |
| 100 MiB    | 2.10M     | 2,650 MiB | **850 MiB**   |
| 200 MiB    | 4.19M     | 4,236 MiB | **1,593 MiB** |
| 300 MiB    | 6.29M     | 4,919 MiB | **1,116 MiB** |

The target was **about 2 GiB**, and it is not a new judgement: Stage 6D-B3
rejected 2,679–3,071 MiB on this host and Stage 6D-R1 qualified 1,923–1,994 MiB,
so the line was already drawn between roughly 2.0 and 2.7 GiB.

### What changed for users

- **Newly accepted:** documents that place one mesh many times. A 0.1 MiB 3MF
  placing one 4,800-triangle object 4,096 times was refused by the old gate at a
  measured 77 MiB of footprint. Also indexed OBJ and 3MF above the old line, and
  binary STL between 317.36 and 320.00 MiB.
- **Newly refused:** a document whose DISTINCT geometry exceeds 768 MiB where
  the old arithmetic happened to admit it — reachable for an OBJ or 3MF carrying
  more than about 6.7M unshared triangles in a small archive.
- **Changed for every large model:** a part above 250,000 triangles no longer
  lists its open boundaries. None of them could have been filled.

### Refusals now name the metric, the value and the limit

> Opening this model would need 1,000 MiB of geometry and render buffers; CAD
> Fixer's limit is 768 MiB.

> This part has 6,291,454 triangles, which needs 1.4 GiB of working memory; CAD
> Fixer's limit for this is 1 GiB.

The second replaced _"This would use more memory than CAD Fixer allows for one
session"_, which R2 recorded as misleading and R3 measured being shown to a user
whose model had simply grown past the topology ceiling.

Reproduce with `npm run qualify:import-phases -- stl:100,stl:200,stl:300`
against `npm run preview`, and `npm run bench:boundary-listing`.

## Stage 6D-R1: what the import budget is, and what actually enforces safety

**`maxImportPeakBytes` is not a measurement of process memory and must not be
read as one.** `estimateImportPeak` sums five quantities CAD Fixer chooses to
allocate — current resident geometry, current render buffers, the input file
buffer, and the candidate's resident and render bytes — and compares the total
against 1,536 MiB.

Two audit findings bound what it can mean:

- **It runs after the peak it names.** Its only call site is
  `commitImportedDocument`, which executes once the reader has returned. The
  archive is already inflated, the XML string built, the parser scratch
  allocated and the geometry materialised. It guards the render snapshot and the
  commit, not the transient peak.
- **3MF and OBJ never consult `ImportBudget` at all.** `maxEstimatedPeakBytes`,
  `maxTriangles`, `maxVertices` and `maxOutputBytes` are used only by the STL
  readers.

Measured against four fixture shapes inside current limits, its error spans two
orders of magnitude **and changes sign**: it under-predicts geometry-dense
content by 2.0–3.3x and text-heavy content by 3.6–6.0x, and **over-predicts
placement-heavy content by 81x** — one mesh placed 200 times costs 9 MiB and is
modelled at 733 MiB, because resident and render bytes are computed from the
summed triangle count while shared geometry is stored once. No single correction
factor repairs an estimator wrong in both directions.

A separate defect is recorded and deliberately not fixed: `currentRenderBytes`
is documented as the snapshot _already held_ and receives the _candidate's_
triangle count, so those bytes are counted twice. The error is conservative —
it can only over-refuse — and correcting it would change import eligibility,
which an architecture stage must not do quietly.

**Decision: process footprint is a qualification metric, not a runtime
enforcement metric.** Safety rests on the deterministic caps that are known
before the allocation they bound and are already implemented: 256 MiB per entry,
512 MiB declared package expansion, one runtime `InflationBudget` per archive
charged per chunk, 200:1 compression ratio, 4,096 entries, and the document's
object, triangle, vertex and part ceilings. `estimateImportPeak` is retired from
the enforcement role; the code migration is a separate step and no behaviour
changed in R1.

### Multi-model-part budgeting

Sequential model parts do **not** cost the sum of their entries. Five sequential
128 MiB parts measured a peak of 616.7 MiB at part one and **577.0 MiB at part
five** — transient memory is released between parts and later parts reuse the
space. In Chromium, two 242 MiB imports back to back peak at
**1,923–1,994 MiB** against 1,742–1,815 MiB for a single 248 MiB entry: a second
part adds about 10%, not 100%.

**No new ceiling is needed.** The existing 512 MiB package total already bounds
the worst case to two parts at the per-entry maximum, which is the case measured
above. Many smaller parts are strictly milder — eight 64 MiB parts peak at
649 MiB. `maxModelParts` therefore has no production value: `maxEntries`, the
reachable expansion budget and the document's part ceiling already bound it.

Reproduce with `npm run bench:resource-model` and
`CADFIXER_QUALIFY_MODE=sequence npm run qualify:chromium-memory`.

## Stage 6D-B3: the 3MF per-entry ceiling, measured in Chromium

**`maxEntryBytes` stays at 256 MiB.** A proposal to raise it to 384 MiB — to
cover a 297 MiB entry a beta tester reported — was measured and rejected.

Measured on the stated minimum host (macOS 27, Apple M1, **8 GiB**, Chromium
151, cross-origin isolated), using the renderer process's macOS
`phys_footprint_peak` plus CDP heap and ArrayBuffer readings from the geometry
worker's own isolate. `performance.measureUserAgentSpecificMemory()` is not
available in this Chromium and `performance.memory` is quantized, main-thread
only and heap only, so neither could carry the decision.

| 3MF entry (expanded)        | Renderer peak footprint |
| --------------------------- | ----------------------- |
| 248 MiB — today's ceiling   | 1,742–1,815 MiB         |
| 294 MiB                     | 2,067–2,099 MiB         |
| 376 MiB — a 384 MiB ceiling | 2,679–3,071 MiB         |

At 376 MiB the renderer peaks at **1.7×–2.0× the 1,536 MiB import budget**, and
the run-to-run spread (392 MiB) is larger than any margin that could be claimed.
Every size imported without crashing; not crashing once is not the same as safe.

**Two things this measurement establishes beyond the rejected proposal:**

- **The modelled import budget does not bound real browser memory for 3MF.**
  `estimateImportPeak` predicts ~271 MiB for the 376 MiB case against a measured
  2.7–3.1 GiB, because it models neither the inflated entry, the decoded XML
  string, the parser's scratch arrays, nor V8 and Blink overhead. The two
  numbers answer different questions and only one of them is what the machine
  experiences.
- **At the shipped 256 MiB ceiling a 248 MiB entry already peaks around
  1.75 GiB**, above that same budget. The ceiling that ships is less comfortable
  on an 8 GiB host than the budget suggests. It was not lowered — that would
  need its own evidence and its own decision — but it is no longer an unexamined
  number.

**The V8 string wall is not the binding constraint here.** Chromium's maximum
string length measured 536,870,888 bytes, identical to Node's, so 384 MiB
(402,653,184 bytes) clears it by 128 MiB. 448 MiB also decodes; 512 MiB cannot
exist as a string at all. Memory is what fails first, well before any of that.

Reproduce with `npm run qualify:chromium-memory`. Sizes above the ceiling need a
local qualification build; that edit is never committed.

## Stage 6E-A4: the 3MF per-entry ceiling, raised to 320 MiB

**`maxEntryBytes` is 320 MiB — 335,544,320 bytes — and this SUPERSEDES the Stage
6D-B3 decision above.** That decision was correct for the reader it measured.
6D-B3 rejected 384 MiB because a 376 MiB entry peaked at **2,679–3,071 MiB** of
renderer footprint. Every one of those megabytes was the BUFFERED path: the
entry inflated whole, decoded whole into a JavaScript string, and at two bytes a
character whenever any character exceeded U+00FF. Since 6E-A3 every model entry
at or above 128 MiB is streamed and never held whole, and the same file now
costs about half as much.

Measured on the stated minimum host (macOS 27, Apple M1, **8 GiB**, Chromium
151, cross-origin isolated), `phys_footprint_peak` at phase boundaries, one
fresh browser per run, through the real file chooser against a production build.

### The entry is no longer what bounds the peak

| Shape, at ~480 MiB of model XML | Renderer peak         | Whole browser         |
| ------------------------------- | --------------------- | --------------------- |
| Text-heavy — **4 triangles**    | 452 / 458 / 461       | 546 / 553 / 555       |
| Dense unshared — 2,635,162 tri  | 1,362 / 1,414 / 1,612 | 1,678 / 1,730 / 1,928 |

A 480 MiB entry describing four triangles costs 458 MiB and varies by ±3 MiB
across runs. **The ceiling is therefore a statement about GEOMETRY, and the two
are not proportional.**

### What the worst case actually is

3MF shares vertices, so an INDEXED grid carries a triangle every ~70 bytes —
about twice what unshared soup manages. The 3MF Consortium's own large positive
cases are exactly that shape, which is why the first synthetic ladder, built
from unshared soup at ~185 bytes a triangle, **understated the worst case by
roughly 650 MiB**. Maximally dense indexed content, three fresh browsers each:

| Model entry    | Triangles     | Renderer min/med/max      | Whole browser min/med/max |
| -------------- | ------------- | ------------------------- | ------------------------- |
| 240.28 MiB     | 3,623,432     | 1,098 / 1,138 / 1,157     | 1,483 / 1,522 / 1,541     |
| 271.27 MiB     | 4,078,368     | 1,100 / 1,103 / 1,104     | 1,516 / 1,518 / 1,520     |
| 286.66 MiB     | 4,304,178     | 1,132 / 1,132 / 1,135     | 1,564 / 1,564 / 1,567     |
| **302.05 MiB** | **4,530,050** | **1,173 / 1,176 / 1,194** | **1,620 / 1,624 / 1,641** |
| **321.20 MiB** | **4,811,202** | **1,339 / 1,564 / 1,591** | **1,806 / 2,030 / 2,056** |
| 336.60 MiB     | 5,037,138     | 1,553 / 1,554 / 1,595     | 2,035 / 2,036 / 2,077     |
| 363.94 MiB     | 5,438,402     | 1,706 / 1,990 / 1,998     | 2,215 / 2,503 / 2,506     |

**There is a cliff between 336.60 MiB and 363.94 MiB**, and the 384 MiB this
stage first proposed is past it: renderer 1,998 MiB and whole-browser 2,506 MiB,
back in the region 6D-B3 rejected. The proposal was withdrawn on this evidence.

A real file confirms it. The 3MF Consortium's `P_XXX_0909_04.3mf` —
362.84 MiB, 4,262,028 triangles, one of the official positive cases A4 set out
to support — peaks at **1,451 / 1,525 / 1,543 MiB** renderer and
**1,878 / 1,951 / 1,970 MiB** whole-browser. It imports correctly; it is simply
larger than this ceiling should admit.

### The largest file this ceiling admits

Measured directly, five fresh browsers, on an indexed grid of **319.52 MiB
carrying 4,786,418 triangles** — the densest shape a file at this ceiling can
be:

| Metric                         | min   | median | max       |
| ------------------------------ | ----- | ------ | --------- |
| Renderer `phys_footprint_peak` | 1,513 | 1,552  | **1,619** |
| Whole browser                  | 1,977 | 2,017  | **2,083** |
| Geometry worker heap after GC  | —     | —      | 83 MiB    |

Run-to-run spread is 3.4% on the renderer and 2.7% on the whole browser, while
the host's one-minute load average swung between 8 and 82 — the measurement is
dominated by what the code allocates, not by what else the machine was doing.
The automatic topology analysis produces a report at this size; nothing is
refused or degraded.

**BETA-002's own class is well inside it.** An indexed 297.15 MiB entry carrying
4,458,098 triangles reads 1,162 / 1,171 / 1,184 MiB renderer and
1,603 / 1,613 / 1,625 whole-browser, and replacing it with a two-triangle STL
leaves 3 MiB of geometry-worker heap.

### Why 320 MiB

- **It is measured at the ceiling, not interpolated to it.** The largest
  admissible file reads 1,513–1,619 MiB of renderer footprint — inside the band
  every previous accept/reject decision in this document was made on, with about
  300 MiB to spare, and roughly 650 MiB below the 2.7 GiB that 6D-B3 rejected.
- **The whole-browser figure is 2,083 MiB, and that is stated rather than
  buried.** It is about a quarter of the 8 GiB support machine, and about
  500 MiB more than the shipped 256 MiB ceiling's own worst case. It is the
  price of supporting the BETA-002 class at all; a ceiling low enough to avoid
  it would not clear 297 MiB by a usable margin.
- **It is 44 MiB of declared size below the first size measured unsafe**, and
  17 MiB below the largest measured safe.
- **It clears BETA-002 by 23 MiB**, which is thin and deliberate: the tester
  class is ~297 MiB, and the next credible step up crosses the cliff. A wider
  margin would mean accepting 2.0–2.5 GiB.
- **It is 64 MiB above the shipped 256 MiB ceiling**, whose own worst case —
  240.28 MiB of indexed content — measures 1,157 MiB renderer here.

### A multi-part package is cheaper than one large entry

Two 252 MiB parts carrying 2,833,988 triangles peak at 1,433–1,535 MiB
whole-browser; a single 492 MiB entry carrying 2,744,961 — fewer — peaks at
1,925–2,214. One model part is open at a time, so the transient tracks the
LARGEST SINGLE PART rather than the package total. That is why the per-entry
ceiling is the right thing to bound and why **the 512 MiB package total did not
move**: it is no longer the binding number, and raising it would widen the claim
on the machine for no measured benefit. A package still cannot hold two
maximum-sized parts, because 2 × 320 MiB exceeds it.

### Nothing else moved

200:1 ratio, 512 MiB archive and package totals, 4,096 entries, the document's
triangle, vertex, part and geometry-byte gates, the topology workspace and the
boundary-inventory policy are all unchanged.

**The export side moved with it.** The 3MF writer's model XML is now bounded by
`min(maxSerialisedBytes, MAX_THREEMF_MODEL_ENTRY_BYTES)` rather than by
`maxSerialisedBytes` alone, and parse-back validation routes like an import. See
the Stage 6E-A4 section of the streaming design document for the defect that
made this necessary.

**Reproduce:** `npm run build --workspace @cadfixer/web`, `npm run preview
--workspace @cadfixer/web`, then
`npm run qualify:import-phases -- file:<triangles>:<path>.3mf --worker-heap`.

## The host question, answered

**Can an 8 GiB machine be a supported MVP host? YES**, for one active workspace,
with the feature-level limits above.

The evidence is specifically about _what kind of pressure_ matters. A 900,000-
triangle STL import:

| Condition                                                     | Result                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| **Four parallel Playwright browsers**, 65 MiB free, load > 30 | Fails; once the Chromium renderer was killed outright        |
| **One browser, one tab** (`--workers=1`)                      | **3 / 3 passed**, free RAM rising to 1.4 GiB during the runs |

So the failures Stage 5A recorded were **test-runner concurrency**, not normal
single-user behaviour — four simultaneous heavyweight browser jobs on an 8 GiB
machine is a CI condition, not a product condition. That distinction is the whole
finding, and it is why no ceiling was lowered on the strength of it.

### Selected model: **C — documented minimum host requirements**

Not A (a single fixed conservative ceiling) and not B (capability tiers), for a
reason that is about what browsers will tell us rather than about preference:

- **There is no reliable free-memory signal.** `navigator.deviceMemory` reported
  `8` in Chromium — deliberately coarsened — and is **not exposed at all** in
  WebKit. Nothing in a browser can measure available RAM.
- **A tiered policy needs a trustworthy signal to select a tier.** Without one,
  tiers would be a guess wearing a number.
- **Lowering the structural ceilings would need cross-machine evidence** that
  Stage 5B does not have, and guessing them downward would refuse work that
  demonstrably succeeds.

So: keep the enforced ceilings, state the host expectation plainly, and let the
existing pre-allocation refusals do their job.

### Minimum host expectation

- A desktop or laptop with **8 GiB RAM or more**
- A Chromium-based browser (see `BROWSER_SUPPORT.md`)
- **One active CAD Fixer workspace at a time** for large models. Independent tabs
  are fully isolated — separate workers, documents, revisions and histories — but
  two large models in two tabs double every buffer, and that was not qualified.

## Release-qualified reference workloads

| Workload                           | Status                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| STL, 900,000 triangles             | Qualified, one tab. Import, render, topology, export                |
| Indexed OBJ, 160,801 V / 320,001 F | Qualified through repair, including the candidate representation    |
| 3MF, 1,000 shared placements       | Qualified: one canonical mesh, one GPU geometry, 240 bytes resident |
| Viewport 3840 × 2160 at ratio 2    | Qualified, ≈33.2 M pixels                                           |

## What a user sees at a limit

Refusals name the model and the operation, never the internals. The rule is that
copy must not claim knowledge the product does not have:

- **Allowed:** "This model exceeds CAD Fixer's limit for this check."
- **Not allowed:** "Your computer does not have enough memory." A browser cannot
  know that, so saying it would be a guess presented as a fact.

An operation refused on resource grounds leaves the document loaded, viewable and
**exportable**. A self-intersection refusal never prevents an export.

## Known boundary

A browser tab killed by the operating system under genuine memory exhaustion
cannot be caught by the application — no in-page code runs after the renderer
dies. Every ceiling above exists to make that outcome unreachable through normal
use, and the enforcement is pre-allocation so a refusal arrives before the
allocation that would cause it. But it is a boundary, not a guarantee, and it is
recorded here rather than glossed.
