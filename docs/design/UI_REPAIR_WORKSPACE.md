# UI-02 — Repair workspace

UI-02 rebuilt the Repair workspace around the PrintPrep reference's first two
screens — a findings list with a health summary, an occurrence navigator, a
viewport issue HUD and an inspector selection — on top of CAD Fixer's existing
analysis, conservative repair and single-boundary fill. No geometry algorithm
changed.

## Decisions taken with the product owner

- **No Simplify / reduce section, and the workspace stays "Repair".** CAD Fixer
  has no decimation engine (`docs/repair/REPAIR_ARCHITECTURE.md` lists
  simplification as out of scope). Naming the workspace "Repair & Optimize"
  and promising a triangle-count reduction would be a false claim.
- **CAD Fixer's vocabulary, the reference's layout.** "Open boundaries", not
  holes; "Winding conflicts", not flipped normals; no "watertight", no "Fix
  all". The forbidden-term lists in `topology-presentation.ts` and
  `hole-fill-presentation.ts` are unchanged and a new test holds this module to
  both.

## Capability matrix

| Reference row         | CAD Fixer                                              | Occurrences                     |
| --------------------- | ------------------------------------------------------ | ------------------------------- |
| Open edges / holes    | **Open boundaries** — boundary components, exact       | openings inventory (≤ 256), rim |
| Non-manifold edges    | exact                                                  | sampled edges                   |
| Non-manifold vertices | exact                                                  | none — no locations are sampled |
| Flipped normals       | **Winding conflicts** — relative to neighbours only    | sampled edges                   |
| Self-intersections    | Geogram check, intra-part; "Not checked" until it runs | sampled face pairs              |
| Degenerate triangles  | repeated-position + zero-area faces                    | sampled faces                   |
| Duplicate faces       | exact + reversed                                       | none                            |
| Disconnected shells   | **Separate components**                                | none                            |
| Thin walls, gaps      | not computed — **no row**                              | —                               |

Auto repair is the existing conservative repair (four operations, previewed,
validated, applied, undoable). Close holes, stitch, remove self-intersections,
small-shell removal, union and "make watertight" do not exist and have no
controls.

## Architecture

- **One derivation.** `state/repair-issues.ts` turns the current topology
  report, self-intersection report and openings inventory into rows, severities,
  units, occurrence counts and the health summary. Every surface — the Mesh
  analysis list, the viewport HUD, the inspector, the status bar — reads it
  through `useIssueNavigation`.
- **One selection.** `WorkspaceState.issueSelection` holds an issue, an
  occurrence and the key (`document@revision/part`) of the analysis it was made
  in. A selection whose key no longer matches resolves to nothing, so any
  geometry change — repair, fill, undo, import, part switch — makes it stale
  without a reset path to forget. Open boundaries use `holeFill.selectedLoopId`
  as their occurrence, so the openings list and the navigator cannot disagree.
- **Locations on demand.** Only the selected occurrence is located: sampled edge
  endpoints through the detail's sample table, faces from the render snapshot,
  a boundary from its fetched rim. Nothing bulk enters React state.
- **Renderer-owned highlighting.** The selected category's existing overlay is
  forced visible; the active occurrence is a ring sprite drawn over the model;
  Zoom to issue is a `frameRequest` command the viewport consumes once
  (`frameRegion` keeps the viewing direction and moves the orbit target).
- **One controller per workflow.** The analysis, repair and hole-fill hooks each
  run once, in `state/workflow-controllers.tsx`. Previously the analysis hook
  was instantiated in two panels, each with its own once-per-revision guard, so
  both could start an analysis for the same import.

## Fix semantics

| Finding                                     | Action                                                  | Scope        |
| ------------------------------------------- | ------------------------------------------------------- | ------------ |
| Open boundary                               | Preview fill → Apply fill (existing validated workflow) | ONE boundary |
| Degenerate / duplicate / winding            | Preview repair (whole part) → Apply in Auto repair      | WHOLE PART   |
| Non-manifold, self-intersection, components | none — stated as such                                   | —            |

"Dismiss" clears the selection; the finding stays in the list.

## Known differences from the reference

No Simplify section, no thin-wall or gap rows, no floor grid (the viewport's
grid is hidden for a loaded model and a bed-plane needs model-base placement
the viewport does not compute), no History/Reset/Apply footer (conservative
repair already previews and applies in place; a second commit model would
conflict with it — the Activity log is the history), and the left toolbar keeps
its three real tools.
