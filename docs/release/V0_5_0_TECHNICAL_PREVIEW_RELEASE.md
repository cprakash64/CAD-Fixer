# Pybrix v0.5.0 Technical Preview

Pybrix v0.5.0 is the first release under the product's new name. The product
previously called CAD Fixer is now **Pybrix**; the underlying privacy model is
unchanged — model processing stays local to your browser.

It also rolls up everything that reached the public preview after the v0.4.0
tag but was never released under a version of its own: the redesigned editor,
a production-hardening pass, and simplified workspace navigation. No geometry
capability was added.

## New identity

- A new Pybrix visual identity: the Pybrix mark and name in the header, a
  Pybrix favicon and touch icon, and a Pybrix page title and description.
- Help now includes an About section with the Pybrix logo, the release status
  and version, a one-line summary, the local-processing statement and a link to
  the third-party notices.
- An accessible Pybrix interaction palette sampled from the new artwork. Primary
  buttons now carry white text at 6.1 : 1 contrast (the previous colour
  measured 2.7 : 1, below the WCAG AA threshold), and the keyboard focus ring
  now reaches 3.3 : 1 against every surface (previously 2.0 : 1). Warning, error
  and success colours are unchanged.
- Exported files are stamped with the new name where they were stamped before:
  binary STL headers read `Pybrix binary STL`, ASCII STL solids are named
  `pybrix`, and OBJ files begin `# Written by Pybrix`. File names still come
  from your model.

## Also new since v0.4.0

- **Redesigned editor.** A workspace shell with a top bar, a tool panel for the
  current workspace, a 3D viewport with a view cube and navigation tools, an
  inspector, and a status bar; it adapts from wide desktops down to phones.
  Repair, Convert, Split & Connect and Surface Texture each have their own
  workspace.
- **One workspace selector.** A single centred workspace navigation on desktop
  (a compact switcher on narrower screens). Every available workspace can be
  opened before a model is loaded; it explains what it needs, and its actions
  stay disabled until a model is open. Hollow is shown as coming soon.
- **Production hardening.** Security headers and a content security policy on
  every response; the licences of all shipped third-party software and fonts in
  `third-party-notices.txt`, linked from Help; a prompt before leaving the page
  with applied but unexported changes; clearer messages when WebGL is
  unavailable or lost.
- **Stricter import.** OBJ coordinates and 3MF coordinates and triangle
  indices must now be ordinary decimal numbers; a file that writes, for
  example, `0x10` is refused with a reason instead of being read as 16.

## Existing capabilities

- **Import:** binary and ASCII STL, OBJ (triangles), and core 3MF, including
  the 3MF Production Extension's referenced model parts, Zip64 packages, and
  large 3MF model entries read by streaming within the existing limits.
- **Repair:** conservative, previewed and undoable repair — exact duplicate and
  degenerate triangles removed, relative face winding unified — plus filling
  one planar opening at a time, and a read-only self-intersection check.
- **Convert:** STL, OBJ and 3MF export of the whole document, with a report of
  what the chosen format keeps, and every file read back and checked before it
  is saved.
- **Split & Connect:** one flat cut per split, normal to X, Y or Z with one
  bounded tilt; no connector, round pin/socket connectors, or a dovetail;
  preview, apply and one-step undo.
- **Surface Texture:** Dots, Lines and Diamond patterns on one flat region,
  embossed or engraved; preview, apply and one-step undo.

## Privacy

Models are processed locally in your browser. Nothing you open is uploaded;
the page requests only its own files.

## Known limitations

- This remains a Technical Preview, qualified on desktop Chromium-based
  browsers with at least 8 GiB of memory.
- Use one active large workspace at a time.
- A 3MF model entry may expand to at most 320 MiB; the expanded package ceiling
  is 512 MiB.
- Split requires an eligible closed manifold solid and operates on one part and
  one plane at a time. Connector dimensions require a document explicitly
  measured in millimetres.
- Texture supports flat surfaces only, one part and one connected region at a
  time, and requires a document explicitly measured in millimetres.
- Hollow is not implemented.
- Printer fit and printability are not guaranteed. Check clearances and
  dimensions for your printer and material.
- Undo is one step; Redo is not available.
- OBJ polygons are not triangulated. Unsupported required 3MF extensions remain
  unsupported, and 3MF colours, materials and textures are neither imported
  nor written.
- Pybrix does not claim universal CAD or slicer compatibility.
- The public address is still <https://fixcad.thelunai.com>.
