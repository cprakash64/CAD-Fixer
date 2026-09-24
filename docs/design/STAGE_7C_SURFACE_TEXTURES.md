# Stage 7C — Surface Texture Patterns

Status: unreleased, `main` only. This does not change the `v0.3.0` release.

## Scope

Texture edits one selected placement and one connected flat surface region. The public MVP patterns are Dots, Lines, and Diamond; each can be Raised (embossed) or Engraved. The result is canonical triangle geometry, not a material, shader, image, UV map, or render-only displacement.

The MVP intentionally excludes curved conformal mapping, arbitrary UV unwrapping, images, text, logos, noise, knurling, multi-part application, printability analysis, and full wall-thickness analysis.

## Selection and local frame

The existing viewport ray pick supplies a stable part ID and source render-triangle index plus the world hit point and normal. Because render triangles retain canonical face order, the authoritative geometry worker uses that index as the seed. No canonical geometry crosses to the page.

`selectEditSurface` grows exact-edge adjacency from the seed using a two-degree normal bound and a 100,000-triangle region ceiling. It creates the existing right-handed Float64 calculation frame (`origin`, `tangentU`, `tangentV`, `normal`). Part transforms remain placement data; all edits are generated in part-local coordinates.

Only `PLANAR` regions are admitted in this MVP. `NEAR_PLANAR` and `NON_PLANAR` regions receive: “This texture tool currently supports flat surfaces. Choose a flatter surface.” This avoids flattening or deceptively projecting onto curved geometry.

## Boundary, holes, and containment

Selected triangles are projected into the qualified local frame. Boundary edges are recovered from selected-face incidence. Point membership is tested against the actual projected triangles, so concave empty space and holes are not treated as material.

Every footprint is conservatively sampled, not merely its centre. Dots sample their circumference. Line and Diamond bars sample both long edges, their centreline, and bounded stations along their length. Every sample must be inside a selected triangle and at least the texture edge margin from every outer or inner boundary. Edge features are omitted rather than clipped.

“Texture edge margin” is only a surface-boundary policy. It is not printable wall thickness.

## Pattern layout

All patterns produce the common `TexturePatternInstance` representation: local centre, orientation, width, length, and profile kind. Layout anchors derive from selected-frame coordinate bounds and configured centre-to-centre spacing, so identical inputs produce identical ordered instances.

- Dots are 24-sided shallow cylinders.
- Lines are parallel rectangular bars. Triangle/scanline intersections produce deterministic, fully contained spans; concavities and holes split or omit spans rather than bridging empty space.
- Diamond is two crossing line families at rotation plus and minus 45 degrees. The combined closed multi-component operand is submitted in one Boolean operation.

Rotation is bounded to 0–180 degrees. Dots ignore rotation. All dimensions must be finite and positive. Spacing means centre-to-centre pitch and must be at least the dot diameter or line width.

## Emboss and engrave

Raised features extend along the selected outward face normal by the requested height. Their operand begins a small distance inside the source so the union is not tangent. Engraved cutters extend inward by the requested depth and a small distance outward so the difference crosses the surface.

The interface overlap is `max(part diagonal × 1e-6, height/depth × 1e-4)`. It is local to the Boolean interface and is never used for topology identity or vertex welding. Requested height/depth excludes that overlap.

## Boolean and resources

Source meshes must already be finite, closed, manifold, consistently oriented, and free of prohibited degeneracy. Texture does not silently repair them.

Accepted primitives are assembled into one closed, possibly disconnected operand. The existing validated Boolean adapter performs one union or difference through the existing disposable child worker. The authoritative worker remains responsive and termination cancels in-Manifold work.

Existing Boolean ceilings remain unchanged: 2,000,000 input triangles, 256 MiB input-copy bytes, and 768 MiB known operation bytes. Texture additionally admits at most 500 elements and 64,000 estimated primitive triangles. These conservative MVP limits bound layout, operand construction, preview cost, and Manifold input; errors report observed metric and limit.

## Candidate lifecycle

The existing `GeometryEditStore` owns the candidate. Changing surface or settings cancels active work, discards the previous candidate, and increments the shared generation. Update Preview is explicit; controls never run Manifold on every input event. Stale results, document replacement, and superseded generations cannot become current.

Apply validates and renders before atomically replacing only the selected part mesh. Placement, name, metadata, sibling ordering, and unrelated parts remain unchanged. Editing a shared mesh placement materializes a private mesh for that placement only. One-step Undo restores the exact prior mesh reference and therefore restores sharing.

Cancel terminates active work, releases the worker-resident candidate and render preview, clears the surface selection, and leaves the document unchanged.

## Units and export

Dimension editing is enabled only when the imported document explicitly declares millimetres, matching the conservative Stage 7B policy. The interface does not label unknown native units as millimetres.

After Apply, the edited canonical geometry flows through the existing whole-document STL, OBJ, and 3MF exporters. There is no texture-specific exporter or render-only texture state.

## Known MVP limitations

- One selected placement and one connected surface region at a time.
- Flat (`PLANAR`) surfaces only; near-planar and curved surfaces are refused.
- Dots, Lines, and Diamond only; Raised and Engraved only.
- Fully contained elements only; no clipped edge elements.
- Explicit-millimetre documents only for dimension editing.
- Printer tolerances and complete local wall thickness are not analysed.
- Resource ceilings apply.

## Qualification evidence

Permanent `7C-*` tests cover planar growth, deterministic spacing and rotation, concave and hole containment, non-planar refusal, density admission, closed operand construction, all six pattern/mode Boolean combinations, and emboss/engrave volume direction. Browser, export/readback, cancellation-tail, performance, retention, privacy, and full regression evidence is recorded by the Stage 7C qualification run before the feature is declared release-ready.
