# UI-01 — Application shell

Stage UI-01 replaced the three-column panel layout with an editor shell modelled
on the PrintPrep reference design, without changing what any workflow does.

## Structure

```
TopBar (48)      [brand · Open · Export] · centred workspace nav · [Help · Settings]
ToolPanel (300)  WorkspaceHeader · the current workspace's panels · Activity log
Viewport (flex)  canvas · left navigation toolbar · view cube + home · top HUD · bottom actions
Inspector (280)  Selection (context) · Model · Export · Runtime; collapses to a 36 px rail
StatusBar (30)   job / Ready · privacy statement · triangles · vertices · unit · topology · release
```

Components: `TopBar`, `WorkflowNav` (the workspace nav), `WorkspaceSwitcher`
(its compact replacement below 1024 px), `WorkspaceEmptyState`,
`ToolPanel`, `Inspector`, `StatusBar`, `FileIntake`, `ImportDropZone`, and the
primitives in `components/shell/`. Tokens are in `styles/tokens.css`; shell
rules in `styles/shell.css`; the pre-existing panel rules stay in `app.css`,
whose legacy variable names now alias the tokens.

## Rules this stage kept

- **Panels are hidden, never unmounted.** The Repair, Openings and Mesh Health
  panels own hooks that start automatic analysis, track worker operations and
  release candidates on unmount. Switching workspace, collapsing a section or
  closing a drawer uses `hidden`/CSS visibility and ends nothing.
- **Every control is an existing command.** Open is the one file intake; Export
  opens the whole-document Export / Convert dialog; Compare calls the same store
  action as the repair panel's Before/After toggle. The reference's Save, Recent
  files, Undo/Redo, account menu, transform tools, display modes and
  orthographic toggle are absent because CAD Fixer has no command behind them.
  The projection is shown as a label ("Perspective"), not a switch.
- **Three new viewport calls, all camera-only:** `viewFrom(direction)`,
  `zoomToFit()` and `setNavigationMode('orbit' | 'pan')`. None touches geometry.
  The view cube is driven by `onOrientationChange`, which writes a CSS transform
  directly and never enters React state, so orbiting renders nothing in React.
- **Third-party assets ship with their notices.** The fonts (OFL-1.1) and the
  Lucide icon paths (ISC and MIT) carry their licences beside them in the
  source tree and in the build's `third-party-notices.txt`; see
  `THIRD_PARTY_NOTICES.md`.
- **No invented facts.** The status bar's unit is the document's own statement
  (`describeUnit`) and is not a switch; the topology entry reads "Topology
  checked", never a clean verdict, with the unchecked qualifier as its tooltip,
  and only for a report matching the loaded revision and active part.
- **Workspace names promise no more than the workflow does.** "Repair", not the
  reference's "Repair & Optimize" — nothing reduces a triangle count.

## Responsive tiers

| Width     | Tool panel  | Inspector            | Top bar                               |
| --------- | ----------- | -------------------- | ------------------------------------- |
| ≥ 1440    | docked 300  | docked 280, rail     | centred nav, file actions with labels |
| 1280–1439 | docked 280  | docked 250, rail     | centred nav, icon-only file actions   |
| 1200–1279 | docked 280  | docked 250, rail     | centred nav, tighter tab spacing      |
| 1024–1199 | docked 280  | overlay drawer 300   | centred nav, inspector toggle         |
| 900–1023  | docked 280  | overlay drawer 300   | compact switcher, inspector toggle    |
| 600–899   | drawer      | drawer (one at once) | compact switcher, both toggles        |
| < 600     | drawer 88 % | drawer 88 %          | compact; 40 px touch targets          |

The shell container is `overflow: clip`, never `hidden`: below 1200 px the
inspector drawer waits off-canvas, and a `hidden` container is still a scroll
container that any scroll-into-view could shift sideways (UI-06, I-01).

CSS decides the presentation; React records only whether a drawer is open.
Docked panels resize the viewport through the renderer's `ResizeObserver`;
drawers overlay it and do not.

### Drawers are modal; docked panels are not

A panel is a drawer only below its breakpoint (`useMediaQuery`), and only an
OPEN drawer at that width is modal: `role="dialog"` with `aria-modal`, focus
moved to its first visible control, Tab and Shift+Tab wrapped inside it
(`shell/focus-trap.ts`, the Export dialog's approach plus a visibility filter
for hidden sections), and everything else `inert`. Esc, the scrim or its Close
button closes it and returns focus to the toggle that opened it. A drawer's
`visibility` switches instantly on open — a transitioning `visibility` still
reads as hidden in its first frame, and the browser will not focus into it.

## Rendering cost in headless benchmarks

Headless Chromium renders WebGL on the CPU (SwiftShader), and the main thread
waits on the compositor `Commit` for it, so frame cost follows the canvas's
pixel area. The shell made the canvas the dominant region, and the 7C texture
benchmark (250 ms longest frame gap) moved with it — without any change in
application work:

| Build   | Canvas (harness page, 1280×720) | Longest frame gap, 3 runs |
| ------- | ------------------------------- | ------------------------- |
| 8c94d10 | 1008×149 (150k px)              | 50, 133, 233 ms — pass    |
| 8c94d10 | 1008×~478, forced (481k px)     | 285, 285, 582 ms — fail   |
| UI-01   | 750×642 (481k px)               | 383, 467, 800 ms — fail   |

The same effect lengthened every harness test that renders a large model: a
250k-face fixture load took 8.5 s at the old 1008×149 canvas, ~27 s at
1008×397 in EITHER build (UI-01 pinned to that size: 23–31 s), and 52–56 s at
the shell's 750×642 — with identical frame and draw counts in both builds. The
harness page (never shipped) therefore renders at a fixed 640×240
(`apps/web/e2e-harness/harness-canvas.css`), and the 7C benchmark pins and
asserts that size itself at DPR 1 (~154k px, the
area its limit was qualified at) and asserts that size, so a layout change can
no longer move it. The full-size editor is covered by a separate freeze guard
in `e2e/ui-shell.spec.ts`. At the pinned size the two builds are
indistinguishable; the measurements are in the UI-01-R2 report.

## Final rules (UI-06)

The UI-06 audit made these the shared rules for every workspace. Each is held
by `e2e/ui-consistency.spec.ts` (invariants) or `e2e/ui-polish.spec.ts` (the
defect that prompted it).

### Inspector order

**Selection → Model → Export → Runtime**, in every workspace. Selection is the
workspace's context (the selected finding, the export summary, the active cut,
the surface selection) and leads because it is what changes as the user works.
Model is the compact file card and facts. Export holds "Export / Convert…" and
the active-part STL export, and is hidden — never unmounted — while no model is
loaded. Nothing scrolls the inspector programmatically.

### Controls

- **Primary action**: `.primary-action` (or legacy `.action--primary`), accent
  fill, 36 px (40 px below 600), 8 px radius, 600 weight. One per workspace
  step: the thing the step exists to do. A button that NAVIGATES to that step
  (the inspector's "Export / Convert…") is secondary.
- **Secondary action**: `.secondary-action` and legacy `.action` are one
  control — raised fill, 1 px control border, 8 px radius, 600 weight,
  `--shell-control-h` (32, 40 below 600), 70 % opacity when disabled. A
  footer secondary matches its primary's 36 px; a compact inline one is 30 px.
- **Card selector**: `.format-card` is the one card family for Convert formats,
  Split connectors and Texture patterns — a real radio inside, 8 px radius,
  1 px border, accent border + soft fill + check mark when selected (never
  colour alone), the shared ring on keyboard focus. Width follows content.
- **Number field**: every numeric input is `shell/number-field.tsx`. The field
  commits any finite value; the owning hook clamps (Split) or reports a
  settings problem that blocks the action (Texture).
- **Focus**: one ring, `--focus-ring`, on every interactive element.
- **Pop-ups** (workspace, Help, Settings) are DISCLOSURES: `aria-expanded`, and
  `aria-controls` only while open — no `aria-haspopup`, because nothing they
  reveal is a `role="menu"`. Esc closes and returns focus to the trigger.

### Viewport overlays

- **HUD band**: one centred column between the navigation toolbar and the view
  cube (`--hud-inset-start/end`: 140 px docked, 116 px below 900, 12 px below
  600, where it moves to the bottom edge). It spans the band rather than
  sitting at `left: 50%`, which halved its width.
- **Preview language**: a generated preview shows ONE status pill naming the
  operation — `Repair / Fill / Split / Texture preview — not applied`. HUDs
  describe what is selected or measured and never repeat it. Texture's HUD
  names the three states: layout outlines only (nothing built), generated
  texture geometry (a preview), or the model.
- **No floor, no grid under a model.** The viewport world is Y-up; printable
  files are conventionally Z-up, and CAD Fixer has not chosen a print
  orientation, so a floor would assert a resting face. A scaled grid would
  imply a unit and scale many documents do not state. The empty-state grid
  stays because there is no model to misstate.

### Density and height

Dense but readable: 13 px UI text, 11–12 px metadata, section titles on one
line (their meta truncates). Below 760 px of height the activity log caps at
96 px and scrolls, so each workspace's primary action stays reachable at
1024 × 600.

### Visual regression

Pixel snapshots are deliberately not used: the viewport is software-rendered
WebGL whose anti-aliasing is not CAD Fixer's. Invariants are asserted as
computed style and layout instead — shell geometry per tier, the control
families above, inspector order, HUD placement, and phone drawer fit and
target sizes. Content-dependent dimensions are not compared.

### Terminology

Part (a document part) vs Piece (one side of a split preview); face (a
triangle) vs surface / region (a selection of faces); Preview (nothing
changed) vs Apply (the transaction); Export writes a file, Convert is the
workspace that chooses its format; Repair, never Fix, for the conservative
operations; triangles, never tris; Units (the document's statement).

Capabilities the reference shows and CAD Fixer does not have are listed in
`UI_CAPABILITY_GAPS.md`.

## UI-07A — one workspace selector

- **ONE SELECTOR ON SCREEN AT ANY WIDTH.** The top-left dropdown listed the same
  five workspaces as the tabs beside it at every desktop width. From 1024 px up
  the centred `WorkflowNav` is the only selector; below it `WorkspaceSwitcher`
  replaces it, because the nav no longer fits beside the file and drawer
  controls. CSS shows exactly one of the two.
- **THE NAV IS CENTRED ON THE BAR, NOT ON THE LEFTOVER SPACE.** The top bar is a
  `1fr auto 1fr` grid: the outer tracks are equal, so the nav sits on the bar's
  centre whatever the two side groups weigh. `1fr` keeps its `auto` minimum, so
  a side that outgrows its half pushes the nav sideways rather than overlapping
  it. The end-to-end suite asserts centring within 2 px at 1280–1920 and no
  zone collisions at every tier.
- **NAVIGATION AVAILABILITY IS NOT OPERATION AVAILABILITY.** Every implemented
  workspace can be entered with no model open. `isWorkspaceAvailable` reads
  `WORKFLOWS[].implemented` and nothing else; the old "Open a model first" state
  is gone from navigation. Inside, `WorkspaceEmptyState` — one component, one
  sentence per workspace from `WORKSPACE_PRESENTATION` — says what the workspace
  does and offers Open through the one file intake. Every command that needs a
  model keeps its own guard; entering a workspace creates no document, part or
  revision.
- **A WORKSPACE THAT DOES NOT EXIST IS VISIBLE, FOCUSABLE AND INERT.** Hollow is
  `aria-disabled`, not `disabled`, so keyboard focus reaches it and shows the
  same "Hollow — coming soon" tooltip a pointer gets on hover. A visible "Soon"
  badge says it in text, so the state is not carried by colour. Both switchers
  enter a workspace through `useEnterWorkspace`, which refuses an unimplemented
  one before the store is touched.
- **The nav is a `<nav>` of buttons with `aria-current="page"`**, not a tablist:
  the workspaces are not panels of one widget, and a tablist would promise
  arrow-key roving plain navigation does not need.
