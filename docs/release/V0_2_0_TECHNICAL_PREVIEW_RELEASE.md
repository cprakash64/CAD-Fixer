# CAD Fixer v0.2.0 — Technical Preview

**Public URL:** <https://fixcad.thelunai.com>

**Status:** Technical Preview. This is a feature release: CAD Fixer can now open
the multi-part 3MF packages that current slicers write. Your model still never
leaves your browser.

The v0.1.0 notes still describe the product as a whole and its supported
environment: [`V0_1_0_TECHNICAL_PREVIEW_RELEASE.md`](V0_1_0_TECHNICAL_PREVIEW_RELEASE.md).
The exact support statement for this release is
[`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md).

## Added

- **Multi-part 3MF (3MF Production Extension).** Packages that keep their
  objects in several model parts and reference them with `path` — the shape
  Bambu Studio, OrcaSlicer and PrusaSlicer use for multi-object and
  multi-material projects — now import, with every part placed where the
  package puts it. Before this release they were refused.
- **Zip64 3MF packages.** Bambu Studio and OrcaSlicer write Zip64 archives even
  for small files; v0.1.1 refused every one of them as a damaged archive. They
  now import.
- **Broader producer interoperability.** Real packages from Bambu Studio,
  OrcaSlicer, PrusaSlicer and Cura were used to qualify this release (below).

## Improved

- **STL, OBJ and 3MF parsing.** ASCII STL with classic-Mac line endings now
  opens. OBJ face corners are read strictly, so a malformed corner is refused
  instead of being misread. A 3MF whose main model part is not named `.model`
  is found through the package's own relationship, as the format specifies.
- **OBJ export.** Exporting an STL whose solid has no name, or a model after
  filling an opening, to OBJ no longer fails.
- **Resource safety.** The import limit is measured from the geometry the model
  actually needs rather than estimated, and a multi-part 3MF is accounted for as
  one package, never part by part.
- **Import cancellation** stops multi-part imports promptly and keeps the model
  you already had open.
- **Damaged files.** A corrupted archive — a damaged compressed entry, a broken
  Zip64 record, a split archive — is now reported as damaged, in words, instead
  of as an internal error or a blank message.
- **Clearer messages.** Refusals name what was refused: the limit and the
  measured amount, the 3MF extension that is not supported, or the reference
  that does not resolve.
- **The header now reads "Technical Preview"** instead of an internal
  development label.

## How this release was qualified

- **2,130 real and reference files** run through the same import checks the
  application applies, including the 3MF Consortium's conformance suites.
- **277 producer-authored files** from Bambu Studio, OrcaSlicer, PrusaSlicer and
  Cura; every producer-authored 3MF in that set imports.
- **3,060 export and read-back checks**: every imported model exported to STL,
  OBJ and 3MF and read back again, with no failures or geometry mismatches.
- A deterministic set of damaged and hostile files, each required to be refused
  with a specific reason, never a crash.

This is evidence about the files tested, not a promise that every 3MF, OBJ or
STL will open. If a file is refused, the message says why.

## Known limitations

- **3MF model entries expanding beyond 256 MiB are not yet supported; streaming
  import is planned.** They are refused with a message naming the size and the
  limit.
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
