# CAD Fixer v0.3.0 — Technical Preview

**Public URL:** <https://fixcad.thelunai.com>

**Status:** Technical Preview. This is a feature release: CAD Fixer can now open
large 3MF files that previously hit a size limit, by reading them a piece at a
time instead of all at once. Your model still never leaves your browser.

The v0.1.0 notes still describe the product as a whole and its supported
environment: [`V0_1_0_TECHNICAL_PREVIEW_RELEASE.md`](V0_1_0_TECHNICAL_PREVIEW_RELEASE.md).
The exact support statement for this release is
[`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md).

## Added

- **Large 3MF files now open.** The limit on a single model part inside a 3MF
  has risen from **256 MiB to 320 MiB** of expanded data. Files that v0.2.0
  refused with a size message — including the class a beta tester reported —
  import in this release.
- **Streaming 3MF reading.** A large model part is now read in pieces and never
  held in memory whole. CAD Fixer chooses this automatically for the parts that
  need it; there is nothing to turn on and nothing to choose.
- **Large 3MF export.** Exporting a large model back to 3MF now works. In
  v0.2.0, exporting a model above a certain size could fail at the final
  checking step with an internal error, after all the work had been done.

## Improved

- **Much lower memory use on large 3MF files.** A large model part used to be
  held twice over while it was read — once compressed, once as text, and at
  double the size again if it carried any non-Latin characters. It is no longer
  held whole at all. A 3MF that is mostly metadata rather than geometry now
  costs a fraction of what it did.
- **Memory is released when you open the next file.** Two cases where part of a
  3MF stayed in memory after the import had finished are fixed, so opening a
  large model and then a small one no longer leaves the large one behind.
- **Decompression is bounded as it runs.** Archive contents are checked against
  their limits while they are being expanded rather than afterwards.
- **Cancelling a large import** stops promptly, commits nothing, and leaves the
  model you already had open.
- **Clearer size messages.** A file refused just over a limit used to report the
  same rounded number for both its size and the limit — "expands to 320 MiB;
  the limit is 320 MiB". The two are now always distinguishable.

## Still true from v0.2.0

- **Multi-part 3MF (Production Extension)** packages from Bambu Studio,
  OrcaSlicer and PrusaSlicer import with every part placed where the package
  puts it.
- **Zip64 archives** — which those slicers write even for small files — import.
- **Producer interoperability** with Bambu Studio, OrcaSlicer, PrusaSlicer and
  Cura output.

## How this release was qualified

- **2,474 real and reference 3MF files**, including the 3MF Consortium's
  conformance suites and slicer repositories, read three ways — whole, streamed,
  and by the automatic choice the product makes — with **identical results for
  every file**, and **no change in outcome** against the previous release.
- **Memory measured through the whole application** on the supported 8 GiB
  machine, at the new limit and above it, on the densest file shapes the format
  allows.
- **Large export checked end to end**: a large model imported, exported to 3MF,
  and read back with its geometry compared.
- A deterministic set of damaged and hostile files, each required to be refused
  with a specific reason, never a crash.

This is evidence about the files tested, not a promise that every 3MF, OBJ or
STL will open. If a file is refused, the message says why.

## Known limitations

- **3MF model entries larger than 320 MiB remain outside the current Technical
  Preview limit.** They are refused with a message naming the size and the
  limit.
- **A whole 3MF package may expand to at most 512 MiB**, so a package cannot
  hold two model parts that are each at the 320 MiB limit.
- Archive contents that expand more than 200 times are refused.
- 3MF extensions other than the Production Extension's multi-part references
  are refused by name: production alternatives, Secure Content, slices, beam
  lattices, booleans, displacement, and required materials.
- OBJ faces with more than three corners are refused rather than split.
- Colours, materials, textures and slicer project settings are not imported or
  preserved. Slicer "modifier" volumes appear as ordinary parts.
- No unit conversion, no CRC verification of archive contents.
- Repair is conservative, hole filling is one flat opening at a time,
  self-intersection is reported but not corrected, and undo is one step.
- Qualified on Chromium-based desktop browsers with at least 8 GiB of memory.
  Firefox, Safari and mobile are not qualified.

## Feedback

If CAD Fixer refuses one of your files, the exact refusal sentence is the most
useful thing to send. You do not need to send the model.
