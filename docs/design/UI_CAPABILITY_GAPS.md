# UI capability gaps

What the PrintPrep reference design shows that Pybrix does not, and why the
interface omits it. **This is not a roadmap and promises nothing.** It exists
so that an intentional omission is not mistaken for a UI bug: every row is
absent because the capability underneath does not exist, and the interface
never offers a control with no command behind it.

Columns: the reference capability · what Pybrix has today · what the
interface does instead · what would have to exist first.

## Repair

| Reference                                           | Current state                                                       | UI behaviour                                                              | Needed                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| "Repair & Optimize", triangle reduction             | No simplifier                                                       | Workspace is named "Repair"                                               | A production mesh simplifier with error metrics and validation                                       |
| Fix all                                             | Four conservative operations; hole filling is one opening at a time | Per-operation checkboxes and a previewed whole-part repair; no batch fill | A decision that batch changes can be made safely (openings may be intended)                          |
| Automatic hole closing with smooth / curvature fill | Planar ear-clipping fill of one selected loop                       | Openings list; non-planar rims refused with the reason                    | A validated non-planar fill (curvature-aware patching)                                               |
| Thin walls, gaps between shells                     | Not measured                                                        | Absent from the findings; "wall thickness is not checked" is stated       | Wall-thickness and proximity analysis                                                                |
| Watertight / printable verdict                      | Exact-coordinate topology only                                      | Never shown; the unchecked qualifier travels with every verdict           | Self-intersection plus wall-thickness plus orientation checks — and even then, no printability claim |
| Volume, surface area, shell count in Model facts    | Not in the Model facts                                              | Size, bounds and counts only                                              | Validated volume/area on possibly open meshes, with stated caveats                                   |
| Tolerance welding                                   | None, by policy                                                     | Stated in "What this does not do"                                         | A user-chosen, previewed tolerance workflow                                                          |

## Convert

| Reference                                                    | Current state                      | UI behaviour                                     | Needed                                                                   |
| ------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| PLY, AMF, GLB, FBX                                           | STL, OBJ, 3MF writers only         | No card                                          | A real writer each (GLB: a material pipeline) plus parse-back validation |
| Batch / multi-select conversion                              | One document, one export at a time | Single-choice radio group                        | Multiple open documents and an export queue                              |
| Axis / unit conversion, merge, colours, thumbnails, metadata | No writer does any of it           | No control                                       | Writers that do it, and honest unit semantics                            |
| ASCII STL of the whole document                              | Written per part                   | Card shown disabled, pointing to the part export | A whole-document ASCII writer                                            |

## Split & Connect

| Reference                                             | Current state                                          | UI behaviour                              | Needed                                            |
| ----------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------- |
| Cut list, custom / three-point / align-to-face planes | One flat XY/XZ/YZ plane with one bounded tilt          | Axis segmented control, position and tilt | Arbitrary plane definition and picking            |
| More connector types, manual placement, patterns      | None / round pins / one dovetail, placed automatically | Three cards; "placed automatically"       | Connector engine support and a placement workflow |
| Connectors on unitless models                         | Millimetre documents only                              | Connectors explained as unavailable       | A stated unit (Pybrix converts none)              |
| Bed fit, orientation                                  | No printer model                                       | Absent                                    | Printer profiles and a chosen print orientation   |

## Surface Texture

| Reference                                               | Current state                        | UI behaviour                             | Needed                                                     |
| ------------------------------------------------------- | ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------- |
| Curved / follow-surface mapping                         | Flat region, projection in its plane | "Flat, in the selected face's own plane" | Curved-surface parameterisation and displacement           |
| Brush, lasso, angle, grow / shrink / invert, select all | One flat connected region per click  | One "Flat region" tool and Clear         | An efficient arbitrary face-selection system               |
| Texture library, search, categories                     | Dots, Lines, Diamond                 | Three pattern cards                      | Each pattern as a validated procedural generator           |
| Image heightmaps                                        | None                                 | No upload tab                            | Image decoding (locally) and a heightmap displacement path |
| Simplify after applying                                 | No simplifier                        | Absent                                   | See Repair: a mesh simplifier                              |

## Viewport

| Reference                                           | Current state                            | UI behaviour                                 | Needed                                                        |
| --------------------------------------------------- | ---------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| Print-bed floor and grid                            | Omitted intentionally (see UI_SHELL.md)  | No floor or grid under a model               | A defined world / print orientation and honest unit semantics |
| Ten viewport tools, measure, section, display modes | Orbit, pan, zoom-to-fit, view cube, home | Three tools                                  | Each tool's underlying function (measurement, sectioning)     |
| Orthographic toggle                                 | One perspective camera                   | "Perspective" shown as a label, not a switch | An orthographic camera path                                   |
| Bottom transform toolbar                            | No transform editing                     | Only Repair's Compare bar                    | Transform editing as a document operation with undo           |

## General

| Reference           | Current state                    | UI behaviour                              | Needed                                             |
| ------------------- | -------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| Save, recent files  | Local, stateless session         | Open and Export only                      | A local persistence model                          |
| Undo / redo history | One undoable change per document | Undo lives in each workflow's panel       | A multi-step history with bounded retained memory  |
| mm / inch switch    | No unit conversion               | The status bar states the document's unit | A unit-conversion policy (Pybrix rescales nothing) |
| Account menu        | No accounts                      | Absent                                    | Out of scope for the product today                 |
