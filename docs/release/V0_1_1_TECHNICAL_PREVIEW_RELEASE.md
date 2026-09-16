# CAD Fixer v0.1.1 — Technical Preview

**Public URL:** <https://fixcad.thelunai.com>

**Status:** Technical Preview, unchanged from v0.1.0. This is a narrow patch to
what CAD Fixer _says_ when it refuses a 3MF file. No geometry behaviour changes.

The v0.1.0 notes remain the description of the product, its supported
environment and its limitations:
[`V0_1_0_TECHNICAL_PREVIEW_RELEASE.md`](V0_1_0_TECHNICAL_PREVIEW_RELEASE.md).

## What changed

Both fixes are about truthfulness. In each case CAD Fixer was already doing the
right thing and describing it wrongly.

- **A valid 3MF that CAD Fixer cannot read is no longer called broken.** Some
  3MF packages — commonly multi-material slicer projects — keep their objects in
  several model parts and reference them across files using the 3MF production
  extension. CAD Fixer reads one model part, so those references resolved to
  nothing and the file was reported as containing _"a component that refers to
  an object which does not exist."_ That sent people looking for damage in a
  file that was not damaged. Such a package is now refused as an **unsupported
  feature**, saying the objects live in several model parts and suggesting a
  plain 3MF or an STL instead.

- **A genuinely dangling reference is still reported as a malformed file**, and
  now says where it is: which object holds the reference and which component it
  was, for example _"Object 17, component 2 refers to missing object 42."_

- **Resource-limit refusals now name the metric and the ceiling.** Six
  structurally different limits previously shared one vague sentence, and the
  measured amounts existed only internally. Each refusal now states what was
  measured and the limit it was measured against, in binary (IEC) units taken
  from the same constant that enforces the limit.

- **File size and expanded size are no longer conflated.** A 3MF is a compressed
  archive, so a small file can legitimately expand past a ceiling. That refusal
  now reads, for example, _"This archive is 41 MiB on disk but expands to
  620 MiB in total; CAD Fixer's total expansion limit is 512 MiB. The limit is
  on expanded data, not on the size of the file."_

## What did not change

- **No geometry algorithm changed** — repair, topology, hole filling and
  self-intersection are untouched.
- **No resource limit changed.** Every archive, entry, expansion, ratio, XML,
  object, part, component, triangle and vertex ceiling is exactly what it was.
- **No ZIP accounting changed**, including that entries CAD Fixer never opens
  are still counted against the archive's expansion ceilings.
- **No broader 3MF production extension support**, and **no multi-model-part
  import**. Such files are refused truthfully; they are not read.
- **No export, worker-architecture or privacy change.**

## Beta evidence behind this patch

Real Technical Preview feedback prompted this work, and it is worth being
precise about what it did and did not establish.

Two reports arrived: a 3MF refused with the missing-component message, and a 3MF
reported as too large although the file on disk was well under the ceiling the
tester expected.

**Neither tester's own file has been seen.** The first file's classification
remains individually unresolved — whether it is genuinely malformed or a valid
production-extension package is decided by the file and by nothing else. The
second remains unresolved too, because the exact original error sentence was
never captured, and that sentence is what identifies which ceiling fired.

What _was_ established is separate and did not depend on either file: both
messaging defects were reproduced independently, from first principles, and
corrected. The first was then reproduced again on a real producer-authored
package. So the defects are confirmed at product level while the two individual
reports remain open.

## Compatibility qualification

The one risk in this patch was that refusing a declared-but-unsupported 3MF
extension might reject real slicer files that v0.1.0 accepted. It was tested
rather than assumed.

- **Seven real 3MF packages authored by PrusaSlicer and OrcaSlicer** were run
  against both v0.1.0 and this release. Six import identically under each. The
  seventh — a production-extension package — is refused by **both**: v0.1.0
  called it malformed, v0.1.1 names the unsupported extension.
- **No compatibility regression was observed** in the tested corpus. There is no
  file that v0.1.0 imports and v0.1.1 refuses.
- **The 3MF writers of Bambu Studio, OrcaSlicer and PrusaSlicer were read**, and
  all three tie declaring the extension to actually splitting the model across
  files.

**Stated as a limitation:** no slicer was installed on the qualification
machine, so nothing was exported by driving an application. **Bambu Studio and
Cura files were not directly tested at all.** The full matrix, including what
would reopen the decision, is in
[`docs/beta/3MF_INTEROPERABILITY_RC.md`](../beta/3MF_INTEROPERABILITY_RC.md).

## Technical Preview positioning

The support envelope is unchanged from v0.1.0: qualified on Chromium-based
desktop browsers, 8 GiB minimum memory, one large workspace at a time, minimum
editor width 900 px, display scaling capped at 2×. Firefox, Safari and mobile
remain unqualified and unsupported. Cross-origin isolation is still required.

Your model still never leaves your browser.

## Feedback

If CAD Fixer refuses one of your files, **the exact refusal sentence is now the
most useful thing to send** — this release exists to make that sentence say
which limit or which feature was actually involved.
