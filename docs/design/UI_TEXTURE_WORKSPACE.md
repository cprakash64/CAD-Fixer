# UI-05 — Surface Texture workspace

UI-05 rebuilt Surface Texture around the PrintPrep reference on the Stage 7C
engine (`docs/design/STAGE_7C_SURFACE_TEXTURES.md`). The texture pipeline, its
limits, validation and transaction are unchanged; the worker gained only
REPORTED facts (selection area, part area) and a layout-only operation.

## Capability matrix

| Reference feature                                   | CAD Fixer                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Face picking                                        | **Yes** — viewport ray pick of the real part and face                                                                           |
| Connected-region selection                          | **Yes** — flat only: exact edge adjacency within 2°, ≤ 100,000 triangles                                                        |
| Angle flood, planar (other tolerance), brush, lasso | No                                                                                                                              |
| Select all, invert, grow, shrink                    | No — the engine grows its region from one seed face                                                                             |
| Clear                                               | **Yes**                                                                                                                         |
| Exclude bottom face                                 | No — no defined "bottom" (no bed concept)                                                                                       |
| Area, triangles, coverage                           | **Yes** — measured by the worker from the real faces                                                                            |
| Procedural patterns                                 | **Dots, Lines, Diamond** (knurling, carbon, leather, wood, hex, Voronoi, brick, diamond plate, fabric, scales, wave, stone: no) |
| Image heightmap, image processing                   | No                                                                                                                              |
| Mapping                                             | **Flat** in the selected face's own plane (cylindrical, spherical, triplanar, follow-surface: no)                               |
| Rotation                                            | **Yes** — Lines and Diamond, 0–180°                                                                                             |
| Scale                                               | **Feature size** (dot diameter / line width) and **spacing** (centre-to-centre pitch), mm                                       |
| Depth, direction                                    | **Yes** — height when Raised (union), depth when Engraved (difference)                                                          |
| Falloff, subdivision, simplify after applying       | No                                                                                                                              |
| Fast preview                                        | **Layout outlines** from the engine's layout step (not a shader)                                                                |
| Generate geometry                                   | **Yes** — validated Boolean candidate, then Apply                                                                               |
| Undo                                                | **Yes** — one step, exact prior mesh                                                                                            |

## Architecture

- `state/use-texture-workflow.ts` runs once (`TextureControlsProvider`); the
  panel (`TextureWorkspace`), viewport (picking, highlight, footprint),
  `TextureHud` and `TextureInspector` share it.
- The selection is the store's `textureSelection`, valid only for the loaded
  revision and active part. Work (phase, preview, error) is scoped to a
  session: that part at that revision while the workspace is shown.
- `texture/layout` (worker) → `describeTextureLayout` (engine) →
  `buildSurfaceTextureLayout`, the same function Apply runs first. Debounced
  200 ms; a newer request cancels an older one.
- Highlight: muted rose (`0xe8897c`, 50% opacity) over the grey model;
  footprint outlines on top. Both presentation-only.

## Limits and measurements

Engine ceilings are unchanged: 500 elements, 64,000 element triangles, a
100,000-triangle region, the Boolean's 2,000,000-triangle input. Refusals name
the metric and limit and suggest what to change. Measured in the product build
at 1440 × 900 (headless Chromium, software WebGL):

| scene                        | select                                       | layout         | generate       | apply        |
| ---------------------------- | -------------------------------------------- | -------------- | -------------- | ------------ |
| 10k tris (5,000-face top)    | 152 ms / 98                                  | 798 ms / 83    | 833 ms / 50    | 391 ms / 217 |
| 100k tris (49,928-face top)  | 417 ms / 150                                 | 2,345 ms / 133 | 2,911 ms / 218 | 630 ms / 502 |
| 500k tris (250,000-face top) | refused in 1.3 s (region > 100,000) — gap 33 |                |                |              |

(time / longest main-thread frame gap, ms)

## Known differences from the reference

One tool instead of five, no selection commands beyond Clear, three patterns
instead of twelve, no search or categories, no image tab, one flat projection,
no falloff, subdivision or simplify, flat surfaces only (the reference textures
a curved knot). Since UI-06 the surface selection is the inspector's first
section, above the Model facts (see UI_SHELL.md).
