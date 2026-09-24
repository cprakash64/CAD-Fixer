# CAD Fixer v0.4.0 Technical Preview

CAD Fixer v0.4.0 adds two local, transactional mesh-editing workflows while
retaining the import, repair, hole-fill, and conversion capabilities of the
previous Technical Preview.

## New — Split

- Manual single-plane splitting with X, Y, Z, or custom plane orientation.
- Splitting without a connector.
- Complementary round pin/socket connectors.
- Complementary dovetail connectors.
- Configurable connector clearance for explicit-millimetre documents.
- Preview, Apply, Cancel, and one-step Undo.
- Individual STL export for Piece A and Piece B.

## New — Surface Texture

- Planar connected-surface selection with a visible pre-preview highlight.
- Dots, Lines, and Diamond patterns.
- Emboss and Engrave modes.
- Configurable feature size, centre-to-centre spacing, height or depth, and
  rotation.
- Preview, Apply, Cancel, and one-step Undo.
- Texture is real mesh geometry and is retained by STL, OBJ, and 3MF exports.

## Editing Architecture

- Model processing remains local in the browser.
- Heavy editing operations can be cancelled.
- Proposed changes are validated before they replace the open document.

## Existing Capabilities

- Binary and ASCII STL, OBJ, and core 3MF import.
- Conservative mesh repair and bounded planar hole fill.
- STL, OBJ, and 3MF conversion and export with read-back validation.
- 3MF Production Extension referenced model parts and Zip64 packages.
- Streaming large-3MF model entries through the qualified limits.

## Known Limitations

- This remains a Technical Preview, qualified on desktop Chromium-based
  browsers in an environment with at least 8 GiB of memory.
- Use one active large workspace at a time.
- A 3MF model entry may expand to at most 320 MiB; the expanded package ceiling
  is 512 MiB.
- Split requires an eligible closed manifold solid and operates on one part and
  one plane at a time.
- Split connectors are currently None, Pin, and Dovetail. Connector dimensions
  require a document explicitly measured in millimetres.
- Texture supports planar surfaces only, one part and one connected region at a
  time. Patterns are Dots, Lines, and Diamond.
- Texture dimensions require a document explicitly measured in millimetres.
  Curved conformal texture mapping is not supported.
- Printer fit and printability are not guaranteed. Clearances and dimensions
  must be checked for the intended printer and material.
- Undo is one step; Redo is not available.
- OBJ polygons are not triangulated. Unsupported required 3MF extensions remain
  unsupported, and 3MF colours, materials, and textures are not imported or
  written.
- CAD Fixer does not claim universal CAD or slicer compatibility.
