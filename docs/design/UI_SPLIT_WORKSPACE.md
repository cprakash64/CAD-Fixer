# UI-04 — Split & Connect workspace

UI-04 rebuilt Split & Connect around the PrintPrep reference's split screen on
top of the Stage 7B engine (`docs/design/STAGE_7B_SPLIT_CONNECTORS.md`). The
split pipeline, its validation, its resource limits and its transaction are
unchanged; the engine gained only REPORTED facts (cut-face area, outline count,
bounded outline, final piece volumes).

## Capability matrix

| Reference feature                                                             | Pybrix                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Planar cut                                                                    | **Yes** — Manifold Boolean in a disposable nested worker, validated closed/manifold pieces |
| Dovetail / zigzag cut, fit to bed                                             | No — not offered                                                                           |
| Plane XY / XZ / YZ                                                            | **Yes**                                                                                    |
| Custom normal, align to face, 3 points                                        | No — not offered                                                                           |
| Position slider + field                                                       | **Yes** — range = the active part's own extent on the axis                                 |
| Tilt X / Y / Z                                                                | **Partial** — ONE tilt, about the axis the Stage 7B plane rotates about, ±89°              |
| Multiple cuts / cut list / Add cut                                            | No — one plane per split; split a piece again for another cut                              |
| Cut caps                                                                      | **Yes** — produced by the Boolean; identified from the plane                               |
| Cross-section outline and area                                                | **Yes, after preview** — measured from Piece A's cap                                       |
| Preview → Apply → Undo                                                        | **Yes** — worker-resident candidate, one-transaction commit, exact-graph undo              |
| Part A / Part B colouring                                                     | **Yes** — presentation-only tints of the real piece ids                                    |
| Part picking and selection                                                    | **Yes** — existing raycast picking of real part ids                                        |
| Per-part bounds, triangles, volume                                            | **Yes** — descriptors; volumes from the engine's metrics                                   |
| Bed fit / printer profile                                                     | No — Pybrix has no printer profiles                                                        |
| Dowel pin (single)                                                            | **Round pin**, 1–4, automatic placement                                                    |
| Double dowel                                                                  | Partial — two round pins (count 2); no fixed anti-rotation pattern                         |
| Dovetail (sliding)                                                            | **Yes** — one straight dovetail, 0° / 90°                                                  |
| Snap-fit, threaded, puzzle key, taper, magnet pocket, screw hole, keyed prism | No — no geometry; no card                                                                  |
| Auto placement                                                                | **Yes** — mandatory, highest-clearance interior cap samples                                |
| Manual placement, pattern, margin                                             | No — not offered (margin is internal: max(8 tolerances, 0.35 r))                           |
| Clearance                                                                     | **Yes** — pin radial; dovetail per side                                                    |
| Export individual STLs                                                        | **Yes** — each piece through the existing one-part binary STL export                       |
| Export one 3MF                                                                | **Yes, via Convert** — the whole document (every part), with Convert's unit rule           |
| Auto orient, arrange on bed, emboss labels                                    | No — not offered                                                                           |

## Architecture

- **One controller.** `state/use-split-workflow.ts` runs once in
  `SplitControlsProvider`; the panel (`SplitWorkspace`), the viewport arrow and
  HUD (`ViewportPanel`, `SplitHud`) and the inspector (`SplitInspector`) read it.
- **One plane.** `splitPlaneFor(settings, bounds)` is the only construction;
  the store's `splitPlane` is published from it for the viewport. The arrow
  reports a signed distance along the normal and `offsetAfterNormalDrag`
  converts it (÷ the normal's axis component) into the same `offset` the slider
  writes.
- **Session-scoped work.** Phase, preview and error are tagged with the part
  while the workspace is shown. Changing part, document or workspace retires
  them by derivation, and the effect cleanup releases the worker candidate.
  Cancel additionally resets the plane and connector.

## Viewport

`viewport/create-split-gizmo.ts`: a translucent warm plane (opacity 0.18) with a
brighter border, a translation arrow drawn on top, and the engine's cut outline
as bright line segments. The arrow's capture-phase `pointerdown` takes only
presses that hit its (wider, invisible) target, stops them from reaching the
orbit controls and picking, captures the pointer and releases it on up/cancel.
No rotation rings: tilt is a single bounded angle and is edited numerically.
Pieces are tinted cool blue (A) and salmon (B), with a lifted variant for the
selected piece; the HUD, panel and inspector name them in words. A split
preview or apply keeps the camera (`setModel(..., { preserveView })`).

Diagnostics on the canvas: `data-edit-plane`, `data-edit-arrow` (projected base
and tip), `data-section-outline-edges`, `data-tinted-parts`.

## Performance

Dragging moves one number through React and redraws; no Boolean work runs until
Preview split. The outline is bounded at 65,536 edges.

## Known differences from the reference

No cut modes, custom planes, cut list, three-axis tilt or rotation rings; three
connector cards instead of eleven; no manual placement, pattern or margin; no
bed profile; export controls appear only once a split is applied; "One 3MF"
continues in Convert; the subtitle omits "printable". Since UI-06 the active
cut is the inspector's first section, above the Model facts (see UI_SHELL.md).
