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

---

## BETA-001 — 3MF component reference resolves to no object

| Field          | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| Category       | `IMPORT_FAILURE`                                            |
| Root cluster   | `3MF_COMPONENT_REFERENCE`                                   |
| Severity       | S3 provisional — see "Why provisional" below                |
| Reproducible   | yes, synthetically; the tester's own file has not been seen |
| Frequency      | 1 tester                                                    |
| Workaround     | re-export the model as STL, or as a single-part 3MF         |
| Roadmap area   | 3MF import interoperability                                 |
| Classification | **LIKELY VALID REFUSAL — ACTUAL FILE REQUIRED**             |

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

### Why provisional

If the tester's file is malformed, this is `KNOWN_LIMITATION / IMPORT
INTEROPERABILITY` at S3 and the refusal stands. If it is a valid
production-extension package, this is an interoperability gap at S2 — a class of
standards-compliant file that cannot be imported at all, and that is reported to
the user as a broken file rather than as an unsupported feature. The two are
distinguished by the file, and by nothing else available here.

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

### Information still needed

- The actual `.3mf`, or a sanitized structural dump of it, **only if the tester
  is authorized to share it**. Never required; never uploaded anywhere.
- Failing that: does `3D/3dmodel.model` contain `p:path` attributes, and does
  the archive contain more than one `.model` entry? Either answer settles it.
- Whether the file opens in the slicer that produced it, and in which tool.

---

## BETA-002 — 3MF refused as too large below the expected raw size

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| Category       | `RESOURCE_LIMIT` + `UI_CONFUSION`            |
| Severity       | S3 provisional                               |
| Reproducible   | not yet — exact wording and file unavailable |
| Frequency      | 1 tester                                     |
| Workaround     | unknown until the metric that fired is known |
| Roadmap area   | resource-limit disclosure                    |
| Classification | **INSUFFICIENT INFORMATION**                 |

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

### Information still needed

- **The exact wording.** It identifies the ceiling uniquely; every one of the
  candidate messages is distinct.
- The archive's entry listing — names and declared uncompressed sizes. This is
  structural metadata, not geometry, and is enough on its own.
- Whether the same file imports after being re-exported as a plain 3MF.
