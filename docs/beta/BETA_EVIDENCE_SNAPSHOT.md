# Beta evidence snapshot

Sanitized record of concrete failures reported against the v0.1.0 Technical
Preview, classified under `BETA_TRIAGE.md`.

**Sanitization rules for this file.** No tester identity, no contact details, no
file paths, and no proprietary model contents. A filename appears only when it
is already public and carries diagnostic meaning; otherwise the entry uses a
generic name. Nothing here is a commitment to fix.

**Diagnosis stage: 6B-D1.** Repository at `3263c30`, tag `v0.1.0` unchanged at
`2800cec482d57fabafc74678785e2dd37eb4b9db`. No production behaviour was changed
while producing that record.

**Correction stage: 6B-C1.** The diagnosis reproductions were promoted into
permanent regression coverage at
`packages/file-formats/src/threemf/refusal-semantics.test.ts` (3MF-C1 – 3MF-C5,
3MF-R1 – 3MF-R7). Both product findings below are now CONFIRMED and corrected;
neither tester's own file has been seen, and neither tester-specific status has
moved. **The tag is unchanged and nothing has been redeployed.**

**Qualification stage: 6D-B3.** The per-entry ceiling was measured in real
Chromium on the 8 GiB minimum-envelope machine and **384 MiB was NOT approved**;
`maxEntryBytes` remains 256 MiB. BETA-002's status below is updated accordingly.
No constant changed, nothing deployed, tag untouched.

**Retest stage: 6D.** Repository at `9e793dc`, tag `v0.1.1` unchanged at
`9e793dc68810b9f9df2f39684259612f75eb3a54`. Both findings were retested by their
original reporters against the deployed v0.1.1 Technical Preview, and both now
produce a diagnostic specific enough to classify. **Both classifications below
move from provisional to CONFIRMED.** Stage 6D is architecture and measurement
only: no ceiling moved, no reader changed, nothing was deployed, and no tag was
touched. The resulting design is recorded in
`docs/design/STAGE_6D_3MF_PRODUCTION_AND_LARGE_ENTRY_ARCHITECTURE.md`.

---

## BETA-001 — 3MF component reference resolves to no object

| Field          | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| Category       | `IMPORT_FAILURE`                                            |
| Root cluster   | `3MF_COMPONENT_REFERENCE`                                   |
| Severity       | **S2** — a standards-valid class of file cannot be imported |
| Reproducible   | yes, on a real producer-authored package and synthetically  |
| Frequency      | 1 tester                                                    |
| Workaround     | re-export the model as STL, or as a single-part 3MF         |
| Roadmap area   | 3MF import interoperability                                 |
| Classification | **SUPPORTED STRUCTURAL CLASS — TESTER RETEST REQUIRED**     |

### What the user saw

A `.3mf` produced by a consumer slicer for a multi-material (AMS) print was
refused at import with:

> `<file>.3mf: This 3MF file contains a component that refers to an object which does not exist.`

Screenshot evidence confirms the refusal occurred during 3MF import. The
filename is retained in the original report only; the generic form is used here.

### Where it comes from

`packages/file-formats/src/threemf/threemf-reader.ts`, in `parseModelXml`'s
post-scan structural validation. Every declared `<object>` is walked and every
`<component objectid>` must be present in the same model part's resource table.
The refusal is `ThreeMfMissingObject` / `MALFORMED_FILE`, it aborts the whole
import, and no document is produced.

### Two causes produce this identical message

1. **A genuinely malformed file** — a component names an id nothing declares.
   Refusing is correct: CAD Fixer cannot construct the intended geometry without
   inventing it, and silently dropping the component would be a truncated import
   reported as a success.

2. **A valid file using the 3MF production extension.** That extension lets a
   `<component>` name an object in a DIFFERENT model part, carrying `p:path`
   beside `objectid`. CAD Fixer opens exactly one model part (`findModelEntry`)
   and reads no `p:path` attribute, so the id is resolved against the root
   part's table — where it genuinely is not. `requiredextensions` is not
   inspected either, so the file is reported as malformed rather than as using
   an extension CAD Fixer does not implement.

Cause 2 is reproduced in the diagnosis suite and produces the reported message
verbatim from a package that is valid 3MF. It is also the cause most consistent
with the reported provenance: multi-material slicer projects commonly use this
extension. **It is a hypothesis about the tester's file, not a finding about
it.**

### Stage 6D retest — no longer provisional

The tester re-ran the same file against the deployed v0.1.1 and reported the
message verbatim:

> `This 3MF requires the 3MF production extension, which stores referenced objects in several model parts. CAD Fixer does not support that extension yet. Try exporting a plain 3MF, or an STL, from the tool that made it.`

That sentence is emitted from exactly one place —
`parseModelXml`'s `requiredextensions` check, when a declared prefix resolves to
`http://schemas.microsoft.com/3dmanufacturing/production/2015/06` — so the
file's shape is now known rather than hypothesised: **it declares the production
extension as required.** The 6B-C1 correction did its job; what remains is the
gap the correction was honest about.

Combined with the source-code evidence in `3MF_INTEROPERABILITY_RC.md` — Bambu
Studio, OrcaSlicer and PrusaSlicer all couple the declaration to actually moving
the meshes out of the root model part — this is **Case B** of that document's
truth table, not Case C. The geometry is in other model parts, and no amount of
loosening the declaration check would import it.

**Classification: `CONFIRMED PRODUCTION-EXTENSION LIMITATION`.** Severity rises
to S2: this is a class of standards-compliant file that cannot be imported at
all. The refusal remains correct and truthful; it is the capability that is
missing.

**What this does NOT reopen.** The Stage 6B-C1 decision to honour
`requiredextensions` strictly stands. This file uses the extension, so Case C
— declared but unused — is still unobserved in the wild.

### Stage 6D-A2 — the capability landed

**CAD Fixer now imports reachable multi-model-part 3MF.** A root build item or
component carrying a production-extension `path` is followed to the model part
it names, the object is resolved in THAT part's table, and transforms compose
across the boundary. `requiredextensions="p"` no longer refuses, because the
extension is now implemented for the part of it that decides which geometry a
package contains.

**Measured on a real producer-authored package.** `production_ext.3mf`, carried
in PrusaSlicer's own repository, is exactly the reported structural class: an
empty root `<resources/>`, `requiredextensions="p"`, one build item naming
`/3D/Objects/sub.model` with a transform, and a child whose object 2 wraps the
mesh object 1 in a same-part component.

| Version | Outcome                                                        |
| ------- | -------------------------------------------------------------- |
| v0.1.0  | `MALFORMED_FILE` — "builds an object which does not exist"     |
| v0.1.1  | `UNSUPPORTED_FILE` — names the extension, truthfully           |
| **A2**  | **imports**, 1 part, 12 triangles, transform `50 50 0` applied |

Across the rest of the producer corpus there are **zero compatibility
regressions**: every file that imported under v0.1.1 imports now, with the same
part count.

**Classification: `SUPPORTED STRUCTURAL CLASS — TESTER RETEST REQUIRED`.**

**THE TESTER'S OWN FILE HAS NOT BEEN RETESTED, and this entry does not claim it
works.** What is established is that the structural class their file belongs to
— known from the v0.1.1 message they reported verbatim, which is emitted from
exactly one place — is now supported, and that a genuine producer package of
that class imports correctly. Their file may also use production constructs A2
does not implement; those are refused by name rather than as "the extension is
unsupported". Only their retest closes this.

**What is still refused, and named specifically:** a `path` on a reference
outside the root model part, a `path` naming an entry the archive does not hold,
a cross-part reference the target part does not declare, reachable parts that
declare different units, and any OTHER extension declared required.

### Stage 6D-A3 — a second blocker on the same file family

**A2 was probably not sufficient on its own, and that is worth saying plainly.**

The reported file is a multi-material **AMS** print. AMS is Bambu Lab's
Automatic Material System, so the producer was almost certainly Bambu Studio or
OrcaSlicer. Stage 6D-A3's producer corpus found that **both of those write Zip64
3MF packages at any size** — their calibration packages are 140 and 256
kilobytes and every size and offset in the central directory is the
`0xFFFFFFFF` sentinel.

CAD Fixer refused every such archive with _"This archive's directory is
truncated"_, **before** the production-extension support A2 added could be
reached. So a Bambu or Orca production package had two independent reasons not
to import, and A2 removed only one of them.

A3 reads Zip64 directories. Both blockers are now gone for this file family, and
all sixteen files in the producer corpus — PrusaSlicer, Bambu Studio and
OrcaSlicer — import.

**This still does not say the tester's file works.** It says two defects that
would each have blocked it are fixed, and that real packages from the producer
family it came from now import correctly. Their file may use further constructs
CAD Fixer refuses by name. Only their retest closes this.

**Status unchanged: `SUPPORTED STRUCTURAL CLASS — TESTER RETEST REQUIRED`.**

### What Stage 6B-C1 changed

The product finding is **confirmed**: a standards-valid production-extension
package received a `MALFORMED_FILE` refusal telling its owner the file contained
a reference to an object that does not exist. That is CAD Fixer describing its
own gap as the user's damage, and it is a truthfulness defect regardless of what
the tester's particular file turns out to be.

The reader now detects the extension structurally — a `path` attribute whose
namespace resolves to the production extension, or a `requiredextensions`
declaration naming an extension CAD Fixer does not implement — and refuses with
`UNSUPPORTED_FILE`, saying the objects live in several model parts and
suggesting a plain 3MF or an STL. The check is ordered ahead of the
missing-object check, and a test proves a file tripping both is classified
unsupported.

**A genuinely dangling reference is still refused as malformed**, now naming the
missing object, the object holding the reference and which component it was.
Nothing was relaxed: no component is dropped, no partial import is produced, and
multi-model-part geometry is still not read.

### The one thing this narrowed, stated plainly

A package that declares `requiredextensions` naming the production extension is
now refused **even if all of its geometry sits in the root model part** and CAD
Fixer could have read it. That is the conservative reading the format asks for —
the file says it cannot be understood without semantics we do not implement —
but it is a real reduction in what imports, and it is pinned by its own test.

If beta evidence shows that slicers routinely declare the extension without
using it, this is the decision to revisit, as a product decision rather than a
quiet loosening.

### Stage 6D-B3 — the policy question is now answered, and the answer is no

The architectural question this record left open — whether 256 MiB is the right
ceiling — was settled by measurement rather than argument. Chromium 151 on the
8 GiB minimum-envelope machine, three signals, repeated runs:

| Entry                               | Renderer peak footprint | Runs |
| ----------------------------------- | ----------------------- | ---- |
| 248.0 MiB (today's ceiling)         | 1,742–1,815 MiB         | 4    |
| 293.7 MiB (**this report's class**) | 2,067–2,099 MiB         | 3    |
| 376.1 MiB (a 384 MiB ceiling)       | 2,679–3,071 MiB         | 3    |

**`384 MiB ENTRY LIMIT NOT APPROVED — KEEP 256 MiB.`** At 376 MiB the renderer
peaks at 1.7×–2.0× the 1,536 MiB import budget, and the run-to-run spread alone
(392 MiB) exceeds any margin that could be claimed. The V8 string wall is not
what fails — 384 MiB clears it by 128 MiB — memory is.

**The file class in this report needs about 2.1 GiB of renderer footprint** to
import as the reader is currently built. Raising a constant cannot make that
safe on the supported envelope; it would only move where the failure happens.
The remaining route is **streaming import**, whose measured floor is 0.20× the
entry against the current whole-string path.

**PRODUCT-LEVEL STATUS: the 297 MiB entry class remains outside the supported
envelope, and the refusal stands as correct.** It is now a refusal backed by
measured evidence rather than by an inherited constant, which is what this
record asked for.

**TESTER-SPECIFIC STATUS: awaiting retest.** The tester's own file has still
never been seen. Nothing here is a claim about whether their particular package
imports — only about the entry class it reported.

### Stage 6D-A4 — interoperability qualified; the release is what is missing

A4 ran the production import pipeline over the 3MF Consortium's conformance
suites, lib3mf's and the 3MF Consortium's samples, and every 3MF, STL and OBJ
carried in the PrusaSlicer, Bambu Studio, OrcaSlicer and Cura repositories. All
15 Bambu Studio and OrcaSlicer 3MF packages import — the 6 Zip64 ones and the 7
production-extension ones among them — with part counts and per-part face counts
equal to the producers' own `model_settings.config`, and each exports to STL, OBJ
and 3MF with parse-back. A4's ZIP hardening runs on every one of those Zip64
directories and they still import; its 3MF semantic corrections concern a root
model part not named `.model` and foreign-namespace elements, neither of which
Bambu or Orca write. One caution for the retest: Bambu `modifier_part` volumes are
ordinary mesh objects in core 3MF, so they appear as parts in CAD Fixer.

| Level       | Status                                                           |
| ----------- | ---------------------------------------------------------------- |
| **Product** | **`SUPPORTED STRUCTURAL CLASS`**                                 |
| **Tester**  | **`AWAITING RETEST`** — A2, A3 and A4 are not deployed until the |
|             | next release, so the tester cannot yet have run the fix.         |

**Do not mark BETA-001 resolved** until the tester's own file has been opened in
the deployed release. The retest instruction to send, verbatim, once the next
release is live:

> A new CAD Fixer Technical Preview is live. Please open the same 3MF file that
> showed "a component that refers to an object which does not exist" — you do
> not need to change or re-export it. If it opens, please tell us how many parts
> the Model panel lists and whether the model looks complete and correctly
> placed. If it is refused, please copy the whole message exactly, including the
> file name, and tell us which slicer and version saved the file. Please do not
> send the file itself unless you are authorised to share it; the message and
> the slicer version are enough for us to classify it.

A refusal after retest is still informative: every construct CAD Fixer does not
implement is refused with its own sentence, so the message alone identifies
which one the file uses.

### Information still needed

Nothing further is needed to classify or to design. The remaining questions are
qualification questions, answerable from structural metadata alone and only if
the tester is authorized to share it — never required, never uploaded anywhere:

- The archive's entry listing: how many `.model` parts, and their declared
  uncompressed sizes. This sizes the Track B budget for Track A packages.
- Whether any non-root model part declares a `unit` differing from the root's.
- Whether the package uses the production **alternatives** namespace
  (`.../production/alternatives/2021/04`), which substitutes geometry and is
  therefore not ignorable.

---

## BETA-002 — 3MF refused as too large below the expected raw size

| Field          | Value                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| Category       | `RESOURCE_LIMIT`                                                            |
| Severity       | S3 — a correct refusal whose ceiling is owed justification                  |
| Reproducible   | yes — the metric and both numbers are now known                             |
| Frequency      | 1 tester                                                                    |
| Workaround     | re-export at lower mesh density, or as STL                                  |
| Roadmap area   | large-entry resource architecture                                           |
| Classification | **CONFIRMED PER-ENTRY EXPANSION LIMIT — CEILING QUALIFIED, RAISE REJECTED** |

### What the user saw

An import of a `.3mf` was refused with a message the tester understood as the
file being too large. The tester reports the file on disk was under 50 MB. The
exact wording was not captured.

### What the code says

There is **no 50 MB ceiling anywhere on the 3MF path.** The intake screen is
512 MiB, the archive ceiling is 512 MiB, the per-entry ceiling is 256 MiB and
the expansion ceiling is 512 MiB. No raw-file check can fire below 50 MB, so a
raw-size cap regression is ruled out by inspection and by test.

Every ceiling that can refuse a 3MF is tabulated in the Stage 6B-D1 report. Two
of them can fire on a file that is small on disk:

- **`maxTotalUncompressedBytes` (512 MiB)** — measured on EXPANDED bytes. A
  12:1 model XML means a ~43 MB archive reaches it legitimately.
- **`maxCompressionRatio` (200:1)** — measured per entry.

### The finding that reconciles a small file with a size refusal

`readZipDirectory` charges **every declared entry** against the expansion and
ratio ceilings, including entries the 3MF reader never opens. CAD Fixer inflates
exactly one entry — the model part. Thumbnails, metadata blobs and additional
model parts are counted and never read.

The diagnosis suite proves this: an archive under 64 KiB on disk, whose model is
valid and tiny, is refused because of one highly compressible entry that nothing
in the import path would ever have extracted. Changing that entry's compression
— nothing else — makes the same archive import cleanly.

Whether an unread entry SHOULD be charged is a real question with an argument on
each side, and this record does not decide it. What is recorded is that it is
charged, that it can refuse a small file, and that the message names neither the
metric nor the numbers.

### Message quality, independent of which ceiling fired

Five structurally different ceilings all surface as `RESOURCE_LIMIT_EXCEEDED`.
The reason code and the observed and permitted amounts are carried in
`AppError.details` and appear in no sentence the user reads. A user told only
that an archive "expands to more data in total than CAD Fixer will extract"
cannot learn that the limit is about expanded bytes rather than file size, nor
what the numbers were — which is exactly the confusion this report is.

### What Stage 6B-C1 changed

The product finding is **confirmed**: synthetic tests prove a small compressed
archive can correctly reach an expansion ceiling while the message names neither
the metric nor the numbers. Every resource refusal on the 3MF path now states
what was measured and the ceiling it was measured against, in IEC units taken
from the same constant that enforces it. The total-expansion refusal states the
size on disk and the expanded total in one sentence, and says explicitly that
the limit is on expanded data — which is precisely the distinction this report
turned on.

**No ceiling moved.** The archive, entry, total, ratio, XML, object, part,
component, triangle and vertex limits are all exactly what they were.

**Unread-entry accounting is unchanged and remains an open question.** That an
entry CAD Fixer never opens is still charged against the expansion and ratio
ceilings has a genuine security argument behind it and a genuine
false-positive risk, and it is recorded here as an architectural decision owed
rather than patched in a messaging stage.

### Stage 6D retest — the metric is now known

The tester re-ran the file against the deployed v0.1.1, whose 6B-C1 messaging
change names the metric and both numbers. The reported message, verbatim:

> `A file inside this archive expands to 297 MiB; CAD Fixer's per-entry expansion limit is 256 MiB.`

That sentence is emitted from exactly one place —
`readZipDirectory`'s `maxEntryBytes` check against the central directory's
DECLARED uncompressed size — so the finding is now specific:

- The ceiling that fired is **`maxEntryBytes` = 256 MiB**, per entry.
- It is **not** `maxTotalUncompressedBytes`, **not** `maxCompressionRatio`, and
  **not** the unread-entry accounting described above. The unread-entry question
  raised by the 6B-D1 investigation is real and still open, but it is **not what
  happened to this file**, and Stage 6D deliberately assesses the two
  separately.
- **The raw `.3mf` being under 50 MB is irrelevant to this refusal.** The
  archive is compressed; one entry inside it declares 297 MiB expanded. A ~12:1
  model XML — the ratio measured across the Stage 6D fixture ladder — puts a
  ~25 MiB archive over a 256 MiB per-entry ceiling with room to spare. This is
  not a raw-file-size defect and must not be recorded as one.

**The refusal is correct under the current ceiling, and the message is now
truthful and specific.** What is NOT established is that 256 MiB is the right
ceiling. It was inherited from ADR 0013 and has never been justified by a
memory measurement.

**Classification: `CONFIRMED PER-ENTRY EXPANSION LIMIT — ARCHITECTURAL POLICY
QUESTION`.**

Stage 6D measured the memory path this ceiling protects, at 128 / 256 / 297 /
384 MiB, and found that the dominant cost is not the entry but the SHAPE of the
code that reads it: `readZipEntry` holds the inflated chunk list and the
concatenated output simultaneously, costing **2.0–2.1× the entry** where 1.0×
would do. The full analysis, the measurements and the chosen architecture are in
`docs/design/STAGE_6D_3MF_PRODUCTION_AND_LARGE_ENTRY_ARCHITECTURE.md`. **No
ceiling was moved in Stage 6D.**

### Stage 6D-A4 — unchanged, and not claimed fixed

**Status: `STREAMING IMPORT REQUIRED`.** A4 did not change the 256 MiB per-entry
ceiling, the 512 MiB package ceiling or the 200:1 ratio cap, and the
~297 MiB-entry class this report describes is still refused — by
`ZIP_ENTRY_TOO_LARGE`, in a sentence naming the entry's expanded size and the
limit. Nothing in the next release fixes it, and nothing may say so. Streaming
import is the next major engineering track after the release candidate.

### Information still needed

Nothing further is needed to classify. For qualification, and only if the tester
is authorized to share it — structural metadata only, never geometry, never
uploaded anywhere:

- The archive's entry listing: names and declared uncompressed sizes. It would
  confirm that the 297 MiB entry is the model part rather than a slicer blob
  that CAD Fixer never opens — which would make this the unread-entry question
  after all, and change the answer.
- Whether the same file imports after being re-exported at lower mesh density.
