# UI-01 — Application shell

Stage UI-01 replaced the three-column panel layout with an editor shell modelled
on the PrintPrep reference design, without changing what any workflow does.

## Structure

```
TopBar (48)      brand · workspace dropdown · Open · Export · workspace tabs · Help · Settings
ToolPanel (300)  WorkspaceHeader · the current workspace's panels · Activity log
Viewport (flex)  canvas · left navigation toolbar · view cube + home · top HUD · bottom actions
Inspector (280)  Model · Selection · Runtime; collapses to a 36 px rail
StatusBar (30)   job / Ready · privacy statement · triangles · vertices · unit · topology · release
```

Components: `TopBar`, `WorkflowNav` (tabs), `WorkspaceSwitcher` (dropdown),
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

| Width     | Tool panel  | Inspector            | Top bar                      |
| --------- | ----------- | -------------------- | ---------------------------- |
| ≥ 1440    | docked 300  | docked 280, rail     | dropdown + tabs + labels     |
| 1200–1439 | docked 280  | docked 250, rail     | tabs, icon-only file actions |
| 900–1199  | docked 280  | overlay drawer 300   | dropdown, inspector toggle   |
| 600–899   | drawer      | drawer (one at once) | dropdown, both toggles       |
| < 600     | drawer 88 % | drawer 88 %          | compact; 40 px touch targets |

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

## Known gaps

- The workspace-specific panels keep their existing markup; only their styling
  changed. Matching the reference's per-workspace layouts is later UI work.
