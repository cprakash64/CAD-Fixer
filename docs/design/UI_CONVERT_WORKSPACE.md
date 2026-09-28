# UI-03 — Convert workspace

UI-03 rebuilt Convert around the PrintPrep reference's Convert screen: a source
card, a grid of output cards, contextual format options, a sticky primary
action, an output-size card over the viewport and an export summary in the
inspector. It is built on the existing validated document export and changes
no writer, reader or policy.

## Capability matrix

What Pybrix can actually do, checked against the code rather than the
reference's cards.

| Format   | Import                        | Export (whole document)               | Multi-object               | Materials / colours / textures                                | Metadata         | Units                                                              | Axis | Binary / ASCII                                 | Tests                                         |
| -------- | ----------------------------- | ------------------------------------- | -------------------------- | ------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------ | ---- | ---------------------------------------------- | --------------------------------------------- |
| STL      | yes (binary, ASCII)           | yes — **binary only**, flattened      | parts merged into one mesh | none                                                          | none             | no field; coordinates unchanged                                    | no   | binary here; ASCII only via active-part export | writer, oracle, round-trip, e2e               |
| OBJ      | yes (triangles; no polygons)  | yes — `o` per part, placements baked  | yes                        | `usemtl` names only; **no MTL file**, no colours, no textures | names and groups | no field; coordinates unchanged                                    | no   | text                                           | writer, oracle, round-trip, e2e               |
| 3MF      | yes (core + production paths) | yes — parts, placements, sharing kept | yes                        | **none written** (no `pid`, no resources)                     | **none written** | stated; unknown unit must be asserted (label only, never rescaled) | no   | zip package                                    | writer, oracle, round-trip, differential, e2e |
| PLY      | no                            | no                                    | —                          | —                                                             | —                | —                                                                  | —    | —                                              | —                                             |
| AMF      | no                            | no                                    | —                          | —                                                             | —                | —                                                                  | —    | —                                              | —                                             |
| GLB/glTF | no                            | no                                    | —                          | —                                                             | —                | —                                                                  | —    | —                                              | —                                             |
| FBX      | no                            | no                                    | —                          | —                                                             | —                | —                                                                  | —    | —                                              | —                                             |

Batch-safe: nothing. Pybrix holds ONE document and `DocumentExportService`
runs one export at a time.

## Reference cards and features, reconciled

| Reference                        | UI-03                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| STL Binary                       | card, enabled                                                                                                                                    |
| STL ASCII                        | card, **disabled**, says ASCII is written one part at a time from Inspector › Model                                                              |
| OBJ + MTL                        | "OBJ · No MTL" — the writer emits no material file                                                                                               |
| 3MF Project                      | "3MF · Package" — a core model package, not a slicer project                                                                                     |
| PLY, AMF, GLB, FBX               | **no card** — no writer exists                                                                                                                   |
| Multi-select                     | single choice ("One per export")                                                                                                                 |
| Units mm/cm/inch/m               | only for 3MF of a unit-less model: six radios, none preselected, labels the file, never rescales; otherwise a stated fact                        |
| Coordinate system Z-up/Y-up      | absent — no axis conversion exists                                                                                                               |
| Include colours & materials      | absent — nothing is written                                                                                                                      |
| Keep separate / Merge objects    | a fact per format ("merged into one mesh", "placements kept"), not a switch                                                                      |
| 3MF metadata, embedded thumbnail | absent — the 3MF writer writes neither                                                                                                           |
| Repair before converting         | not offered; "Before converting" states the file is the model as it is now and links to Repair, and warns when an unapplied preview is on screen |
| Simplify before converting       | absent — no decimation engine                                                                                                                    |
| Batch queue, "Convert 4 files"   | absent — "Convert to 3MF" / "Export STL"                                                                                                         |
| Estimated output size            | "Output size": exact, measured, or "not known before writing"                                                                                    |
| Destination ~/Downloads          | "Browser downloads" — the browser chooses the folder                                                                                             |

## Architecture

- **One surface.** The modal dialog is removed. `useOpenConvertWorkspace`
  (`components/shell/open-convert.ts`) is the route for the top bar's Export,
  the inspector's Export / Convert, the workspace nav and its compact switcher; it selects the
  workspace and, below 900 px, opens the tool drawer (`showToolPanel`).
- **One session, started by being shown.** `ConvertWorkspace` calls
  `useDocumentConversion().start()` when it becomes the visible workspace for a
  model; the source format is preselected when it can be written. A new file
  ends the session (and its unit, and its measurements); a repair or undo does
  not.
- **Selected and focused are one thing.** With one format per export the
  selected card is the one whose options are shown; there is no second piece
  of state to drift.
- **Copy in one place.** Every sentence, label and card is in
  `state/conversion-presentation.ts`, and `convert-workspace-copy.test.ts` holds
  it to the forbidden-term list and to "no batch, no files, no folder".
- **Hidden, never unmounted**, for the same reason as the Repair panels.

## Output size

`state/output-size.ts` is pure and runs on every render for a few scalars:

- **Binary STL is exact**: `84 + 50 × triangles` from the leaf `stl-layout`
  module the writer's own preflight uses.
- **OBJ and 3MF are measured or unknown.** After a validated export the store
  records `{documentId, revision, target, unit, bytes}` (`MeasuredExport`,
  newest 12, cleared with the model). The size is shown only for that exact
  revision, target and effective unit — the unit is part of the key only for a
  unit-less document's 3MF, where it changes the bytes, matching the worker's
  own precedence. Nothing is serialised to estimate.
- The viewport card labels each figure "Exact", "Measured" or "Not known before
  writing", and a larger output is neutral rather than red.

## Export and download

Unchanged: `useDocumentConversion.convert` → `DocumentExportService` (a
disposable worker, one at a time) → authoritative snapshot → writer → full
parse-back validation → `downloadBytes`. File names come from
`deriveDocumentExportName`: the last extension is replaced (`part.stl` →
`part.3mf`, `a.part.stl` → `a.part.obj`), directory parts, controls, bidi and
reserved characters are removed.

## Responsive

Desktop keeps the reference's layout. Below 900 px the workspace is the tool
drawer (modal, focus-trapped) and every Export entry point opens it. Below
600 px the output-size card shrinks to the chosen output's row at the top-left,
and cards and unit radios get 40 px targets.

## Accessibility

Output cards and units are native radio groups with names ("Output format",
"Units") and full accessible names per card ("OBJ, text, without a material
file"); the invisible input covers its card, so pointer and keyboard reach the
same control. Selected state is a check mark as well as the accent border.
Unknown sizes and the ASCII card carry an accessible description. The disabled
action is described by its visible reason. Progress announces the writer's
phase politely; a failure is `role="alert"`.

## Known differences from the reference

Single format per export instead of multi-select; no batch queue; no PLY, AMF,
GLB or FBX; no axis, colour, merge, metadata or thumbnail controls; no Repair
or Simplify before converting; the Activity log stays below the action (the
shared shell's footer). Since UI-06 the export summary is the inspector's first
section, above the Model facts (see UI_SHELL.md, "Inspector order").
