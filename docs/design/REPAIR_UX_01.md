# REPAIR-UX-01 — Repair workspace redesign and repair capability audit

Status: UX qualified. Advanced repair capability deferred to **REPAIR-CORE-02**.
Supersedes the layout (not the architecture) of `UI_REPAIR_WORKSPACE.md`.

## 1. The problem

A real user loaded a 94.8 MiB STL (1,988,877 triangles; 13 open boundaries —
6 simple, 7 branched; 155 non-manifold vertices; 39 components). Analysis ran,
Pybrix reported significant issues — and the Repair panel became several screen
heights of prose: operation descriptions, "what this does not do" lists, the
filling policy, topology counts, a component table, surface metrics. The only
primary control, "Preview repair", appeared only when a plan had applicable
work and sat below all of it. For that model no operation applied, so there was
no repair button at all. The screen read as "Pybrix can diagnose my model but
cannot repair it".

## 2. The default hierarchy

The workspace now answers three questions by default and nothing else:

| Question                | Where                                                                             |
| ----------------------- | --------------------------------------------------------------------------------- |
| What's wrong?           | **Health** line (`1 error · 2 warnings` ⓘ) and **Detected issues** (compact rows) |
| What can Pybrix repair? | each row's fixability line; **Repair options** (compact)                          |
| What should I click?    | the one primary action in the **sticky footer**                                   |

Order: Health → Detected issues → Repair options → Open boundaries (fill one
opening) → **Advanced diagnostics** (collapsed) → sticky footer.

Advanced diagnostics holds, unchanged, everything that used to be on screen:
source facts, the topology table, manifoldness, the boundary list, surface
metrics, the (bounded, 200-row) component table, the overlay toggles, the checks
not performed, the repair exclusions and the filling limits. Nothing was
deleted; it was moved behind one deliberate click.

Explanations live behind **ⓘ** buttons, each in three parts — _What it means_,
_What Pybrix can do_, _When it cannot_. An ⓘ is a disclosure, not a popover: a
real `<button>` with `aria-expanded`/`aria-controls`, opened by click or tap,
closed by Escape (from the button or inside the panel) or its Close button,
with focus returned to the button. The panel is an ordinary block directly
beneath the thing it explains, so it cannot leave the viewport at any width.

## 3. The primary action — one place, every state

`deriveRepairAction` (pure, `state/repair-workspace-presentation.ts`) is the
state machine; the footer renders it.

| State            | Primary (footer)              | Beside it                                                  |
| ---------------- | ----------------------------- | ---------------------------------------------------------- |
| No model         | Repair model — disabled       | —                                                          |
| Unavailable      | Repair model — disabled       | "Repair is unavailable in this browser context." ⓘ         |
| A: not analysed  | **Analyze model**             | "Pybrix checks the mesh before it can repair it."          |
| Analyzing        | Analyzing… — disabled         | progress + **Cancel**                                      |
| Planning         | Repair model — disabled       | "Working out what Pybrix can repair…"                      |
| Plan failed      | Repair model — disabled       | the error + **Try again** when retryable                   |
| B: ready         | **Repair model**              | "N repairable issue types of M detected. …"                |
| E: nothing safe  | Repair model — disabled       | "No safe automatic repairs are available…" ⓘ               |
| E: nothing found | Repair model — disabled       | "No repairable problems found."                            |
| Building         | Preparing preview… — disabled | progress + **Cancel**                                      |
| C: preview       | **Apply repairs**             | **Cancel preview**; "Preview ready — nothing has changed…" |
| Applying         | Applying… — disabled          | progress                                                   |
| D: applied       | (next state's action)         | "Repairs applied"; result card with **Undo repair**        |

Precedence: commit in flight > candidate in flight > preview > analysis in
flight > missing/stale report > plan failure > plan state. A stale report can
never enable Repair model, however ready the stored plan looks.

**Repair model does not commit.** It is the existing `previewRepair`: build a
candidate in the worker, validate it by re-analysis, and show it. Apply is the
existing `repair/commit`, whose guards are all worker-side. Cancel preview is
`discardPreview`; Undo is `repair/undo`, which restores the retained mesh
object. No transaction changed.

**It is not "fix all".** It runs every _selected_ operation the plan found
_applicable_. The supporting line counts issue types honestly — "1 repairable
issue type of 5 detected. 4 types will need other attention." — and open
boundaries are never counted as something it repairs, because they are filled
one at a time in their own section.

## 4. Fixability

`deriveIssueStatus` gives each row one line, read from the CURRENT plan's
decisions, never from the count alone:

| Row                                             | Status                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any, count 0                                    | No issue                                                                                                                                                                                                                        |
| any, not run                                    | Not checked (self-intersections: "Not checked — model exceeds automatic check size")                                                                                                                                            |
| Open boundaries                                 | "N simple loops · M complex"; above the fill ceiling: "Automatic filling isn't available at this part size"; simple loops present: "Simple loops can be filled one at a time below"; complex only: "Not automatically fillable" |
| Non-manifold edges/vertices, self-intersections | Not automatically repairable                                                                                                                                                                                                    |
| Winding / degenerate                            | Repair available · Partly repairable · Repair available — option not selected · Blocked by the model's topology · Not automatically repairable                                                                                  |
| Duplicate faces                                 | as above; reversed copies only: "Reversed copies are kept — they may be intentional"                                                                                                                                            |
| Separate components                             | "Review recommended — may be intentional" (never an error to repair)                                                                                                                                                            |
| plan not ready                                  | Checking…                                                                                                                                                                                                                       |

"Complex" is `openBoundaryChainCount + branchedBoundaryCount` from the topology
report; "simple" is `simpleBoundaryLoopCount`. Nothing claims a simple loop is
fillable: planarity is the engine's decision.

## 5. Severity and the summary arithmetic

Unchanged rules (`repair-issues.ts`), now stated behind the Health ⓘ:
**the summary counts issue TYPES, not occurrences.** Errors are non-manifold
edges, non-manifold vertices and self-intersections; warnings are open
boundaries, winding conflicts, degenerate and duplicate faces, and more than one
component. The reported model's "1 error · 2 warnings" is three categories —
non-manifold vertices; open boundaries and components — not 207 events.

## 6. Wording changes

- "Structurally valid" → **"File structure valid"** (Health line, inspector);
  its ⓘ says it does not mean the mesh is manifold or ready for a slicer.
- The self-intersection size refusal → "Not checked — model exceeds automatic
  check size".
- The 3-sentence fill-ceiling refusal → one line, "Automatic filling isn't
  available for this part at its current size." with the numbers behind ⓘ.
- Applied result: a headline decided by the outcome (see REPAIR-UX-04 below),
  a **Fixed** list from the committed counts and a **Still needs attention**
  list from the NEW revision's analysis ("Checking the repaired mesh…" until
  it exists), then "Selected topological issues were repaired and
  revalidated." and the unchecked qualifier.
- `REPAIR_WORKSPACE_FORBIDDEN_TERMS` extends the older lists with
  `fix all`, `all issues fixed` and `perfect`; a test checks every string the
  module can produce, and a component test checks the rendered workspace.

## 7. Capability audit — non-manifold vertices

**Proposed operation:** duplicate a non-manifold vertex once per disconnected
fan, at the exact same stored coordinate, and reassign each fan's triangles.

**Finding: it cannot be made to work under the current identity policy, and so
it was not implemented.**

1. ADR 0009 identifies a topological vertex by its EXACT STORED COORDINATE,
   never by its index — required, because STL is soup and carries no indices.
   Two vertex records at one point are one topological vertex.
2. `packages/mesh-topology/src/vertex-split-audit.test.ts` proves it: a bow-tie
   whose apex is split into two records at the same coordinate still reports
   `nonManifoldVertexCount === 1` and the same `topologicalVertexCount`; the
   three-fan case likewise.
3. The repair pipeline accepts a candidate only if re-analysis shows the target
   gone (`TargetDefectNotRemoved` otherwise). The operation would be refused on
   every input — a button that always fails.
4. The reported model is an STL. STL export writes coordinates, not indices, so
   even a split that survived in memory would be re-joined by every consumer.

Making it meaningful needs one of two ARCHITECTURAL changes, which is why it is
REPAIR-CORE-02 and not a repair operation:

- **Index-aware identity for indexed formats** (OBJ/3MF), with a second,
  explicitly-labelled diagnostic mode. It helps only files exported to 3MF/OBJ,
  never STL, and needs an ADR amending 0009 plus a slicer-interop study (which
  consumers honour indices rather than re-welding).
- **Moving a coordinate** (separating fans by an offset). That changes surface
  geometry, is a tolerance decision, and is out of scope for conservative repair
  by definition.

The UI states the truth: "Not automatically repairable", with an ⓘ explaining
why, and non-manifold vertices continue to block winding repair in the affected
piece exactly as before.

## 8. Capability audit — open boundaries on large parts

The 250,000-face ceiling (`HOLE_FILL_MAX_PART_FACES`, ADR 0018) is not a
guess, and simply raising it to 2,000,000 is unsafe. What scales with the PART,
not the opening, today:

| Cost                                         | Where                         | Evidence                                                                                                                                               |
| -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Openings inventory walk                      | `holefill/list-loops`         | 692–1,011 B/face on loose-triangle shapes (Stage 6D-R3); ≈ 1.4–2.0 GB at 2 M faces; NOT RUN above the ceiling, so no `BoundaryLoopId` exists to select |
| Copy of the whole part to the fill worker    | `holefill/send-for-fill`      | positions + indices of the part (≈ 96 MB soup at 2 M faces)                                                                                            |
| Boundary re-extraction, source AND candidate | `engine.ts` lines 134 and 265 | 1,085 ms of 1,286 ms at 249,000 faces — ≈ 8–9 s each at 2 M, linear                                                                                    |
| Whole-source BVH                             | `engine.ts` line 547          | O(n log n) build over every source face                                                                                                                |
| Self-intersection coupling                   | ADR 0018 §2                   | a part too large to check is a part a patch cannot honestly be validated inside                                                                        |

**A loop-local design is plausible** and is the REPAIR-CORE-02 proposal:

1. A bounded, streaming boundary listing whose memory is capped per boundary
   component, so an inventory exists at any part size (or a listing restricted
   to simple loops under the vertex ceiling).
2. Loop-local postconditions: appending a patch changes only edges and vertices
   incident to the rim, so the non-manifold identity sets and boundary deltas
   can be computed over the rim's one-ring rather than the whole part — with a
   proof, and a differential test against the whole-part validator on every
   in-policy fixture.
3. A spatially-bounded intersection query (BVH over faces whose boxes intersect
   the patch's box, built from a bounded scan) instead of a whole-source tree.
4. Transfer of the rim neighbourhood only, not the part.
5. New resource budgets measured on the 2 M-face shape in Chromium, and the
   self-intersection coupling in ADR 0018 §2 re-argued for a patch-local check.

None of that is safe to rush; the existing ceiling stays. The interface now
states it in one line with the numbers behind an ⓘ.

## 9. Separate components and self-intersections

Components are "Review recommended — may be intentional", never repaired by
welding or deleting. Self-intersections above 250,000 faces show "Not checked —
model exceeds automatic check size" and a count of "—", never zero; below it the
row carries its own Check now / Cancel control.

## 10. Tests

- `repair-workspace-presentation.test.ts` — the state machine (every state and
  its precedence, stale report), fixability for every row, scope arithmetic,
  applied/remaining lists, vocabulary.
- `RepairWorkspace.test.tsx` — CTA visible and disabled with no model, with
  nothing safe, and with nothing found; enabled with applicable work; preview →
  Apply/Cancel; stale plan disables the action; isolation fail-closed; applied
  result, remaining-from-new-analysis, undo disabled; progressive disclosure
  (collapsed advanced diagnostics, hidden explanations, ⓘ keyboard behaviour);
  the 1,988,877-triangle synthetic shape; forbidden terms across the rendered
  workspace.
- `vertex-split-audit.test.ts` — the audit evidence in §7.
- `e2e/repair-ux.spec.ts` — the CTA path in a real browser on a synthetic
  large, defective model, above the self-intersection and fill ceilings, at
  several viewport sizes.

## REPAIR-UX-04 — a repair outcome is not the model's health

**The durable rule: a successful Repair operation and a healthy model are
distinct states. Post-repair UI must report both what changed and what
remains.**

v0.6.0 headed every applied repair "Conservative repair applied", in a green
card. On a real 1,988,877-triangle model the repair filled 2 of 13 open
boundaries and left 11 open boundaries, 155 non-manifold vertices and 39
separate components, so the green card sat beside a Health line still reading
"1 error · 2 warnings" and a disabled Repair button saying only that no safe
repairs were available. The engine was right on every count. The interface read
as a repair that claimed to have fixed the model and had not.

### The state model

`deriveRepairOutcome` (`state/repair-workspace-presentation.ts`) is pure and is
derived on every render from two authoritative facts: what the committed
candidate changed, and how many issue TYPES the analysis of the repaired
revision still detects.

| Outcome     | When                                             | Headline                 |
| ----------- | ------------------------------------------------ | ------------------------ |
| `checking`  | changed something; new analysis not reported yet | Repair applied           |
| `complete`  | changed something; no error or warning detected  | Repair completed         |
| `partial`   | changed something; any error or warning detected | Partial repair completed |
| `no-change` | changed nothing                                  | No changes were made     |

- **Not derived from how much changed.** "The repair added triangles" is not the
  test for partial; what remains is.
- **"No supported repair remains" is not "no detected issue remains".** With
  every supported repair exhausted and 155 non-manifold vertices still detected
  the outcome is `partial`; only its supporting sentence changes, to "Pybrix
  fixed everything it can currently repair safely on this model."
- **`complete` still carries the unchecked qualifier.** Self-intersections and
  wall thickness are not passed by not being checked.

### What the screen shows

- **The card is the operation.** Neutral frame for a partial repair, green only
  for a complete one; never red, because the operation succeeded. **Fixed** has
  a check per change. **Still needs attention** has one line per category — its
  own severity icon, its own count, and the same fixability sentence its row
  under Detected issues shows ("Not automatically fillable", "Not automatically
  repairable", "Review recommended — may be intentional").
- **Categories are never summed.** No "205 issues remain". The Activity entry
  that read "Topology analysis found 692 issues" added boundary edges to
  vertices to triangles; it now reads "Mesh analysis: 1 error · 2 warnings.",
  Health's own wording.
- **Health is authoritative.** Same counts, same tone; after a repair that left
  issues it reads "1 error · 2 warnings remaining". The status bar keeps the
  plain counts.
- **The disabled action explains itself.** After a partial repair with nothing
  further available: "Everything Pybrix can safely repair automatically has
  been fixed.", and behind ⓘ what is still detected, per category, and why
  repairing again would change nothing.
- **One announcement.** The card is a labelled group, not a live region. The
  action region announces one sentence when the outcome is known: "Partial
  repair completed. 2 openings filled. Some detected issues remain."
- **Activity** says what changed and points at Health; it cannot say what
  remains, because the repaired revision has not been analysed when it is
  written.

### Reset

Every "after the repair" wording is derived from the applied repair being the
CURRENT document, revision and part. Undo, a replacement model, another edit or
a switch of part moves one of the three and takes the card, the "remaining"
suffix, the exhausted reason and the announcement with it. Nothing remembers
that a repair once ran.

### Also corrected

The second line of the disabled reason was clipped by 4 px in v0.6.0: a hidden
announcement paragraph inside the action region's status slot kept that slot in
the layout and cost one 8 px gap. The announcement is now its own out-of-flow
region, and `e2e/repair-outcome.spec.ts` asserts the reason is drawn in full.
