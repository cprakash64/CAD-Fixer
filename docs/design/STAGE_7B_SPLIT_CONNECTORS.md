# Stage 7B — Split + Connectors MVP

## Scope

Split edits one selected part with one local-coordinate plane. It produces two ordered parts and optionally adds round pin/socket connectors or one straight dovetail. Semantic recognition, multi-plane slicing, snap or threaded joints, unit conversion, printer profiles, and printability analysis remain outside V1.

## Eligibility and transaction

The source and every intermediate and final result must be finite, structurally valid, closed, edge-manifold, consistently oriented, and free from prohibited degenerates. Nothing is repaired or welded implicitly. A candidate document stays beside the authoritative document; Preview reads it and Apply publishes it with one `ResidentDocumentStore.replace`. Failure, cancellation, staleness, and child-worker failure leave the current revision untouched.

The source part is replaced in place by `Original name A` and `Original name B`, both with the source placement. Unaffected parts retain object and mesh sharing. Undo retains the exact previous document graph, restoring order, identity, transforms, names, metadata, indexing, and sharing.

## Plane, cutters, and tolerance

The plane has a Float64 local origin and unit normal. The interface initializes the effective offset at the selected bounds center and offers X/Y/Z presets, a bounds-derived range, and bounded rotation.

The pinned adapter has no separately qualified direct plane split, so two finite oriented boxes represent the half spaces. In-plane spans come from source vertex projections; normal depths end beyond the corresponding source extreme. A margin of ten percent of the largest span plus eight split tolerances closes floating-point boundaries. Infinity and arbitrary global extents are never used.

`splitTolerance` is `max(bounds diagonal × 1e-6, coordinate magnitude × 64 × Number.EPSILON)`. It is used for miss/tangent refusal, cap identification, and connector overlap. It never changes exact topology identity, welds vertices, or rewrites coordinates.

Both pieces are intersections of the source with one cutter. Empty, tangent, and near-empty results are refused. In None mode the relative volume error must not exceed `1e-4`.

## Cut surfaces and placement

Cap triangles are identified from the known plane: every vertex must be within four split tolerances. Triangle ordering is irrelevant. Boundary edges are recovered from cap-triangle incidence, and a bounded deterministic grid is tested against the actual cap triangles. The highest-clearance interior sample becomes the first placement; further pins are greedily chosen from valid interior samples with both boundary and pairwise spacing. This keeps centers out of concave notches and holes instead of trusting a polygon or bounding-box centroid. Missing or ambiguous caps refuse connectors with `CONNECTOR_SURFACE_UNAVAILABLE`.

Automatic placement is mandatory; manual placement is deferred. Each profile must fit within both spans plus radial clearance and an explicit connector edge margin. Multiple pins are distributed deterministically and refused when spacing overlaps. This is a geometric boundary rule, not a printable wall-thickness claim.

## Connectors and clearance

Round connectors use a fixed 32-segment cylinder. The female radius is `male radius + clearance`, so clearance is radial and applied once. One straight dovetail uses a trapezoidal prism; the female width and length each expand by twice the clearance. Its in-plane orientation is 0° or 90°. Either piece may be male. Male and female primitives extend from the split plane into the receiving side with a tolerance-scaled overlap at the interface, and generated primitive winding is normalized outward before any Boolean.

Connector dimensions require a document explicitly measured in millimetres. CAD Fixer performs no unit conversion. Printer fit varies; 0.20 mm is a starting point rather than a guarantee.

The sequence is split, validate both pieces, create primitives, union male, subtract female, validate both final pieces, build candidate, and preview. Heavy calls use the Stage 7A disposable nested worker and its 2,000,000 input-triangle, 256 MiB copy, and 768 MiB known-work limits. Sequential scratch is released between calls.

## Cancellation and retention

Update Preview is explicit, so slider movement does not spawn work. Changing any plane or connector control immediately invalidates the old candidate; the next Update Preview uses the new values. Split generations are issued by the shared Stage 7A `GeometryEditStore`, so a split and another geometry edit cannot both remain current. Replacement preview supersedes the active worker. Cancel terminates work, discards candidate and preview buffers, and exits Split. Document release reaches the controller through document/generation ownership. Every terminal path settles and terminates its child.

## Preview, diagnostics, Undo, and export

Preview replaces only disposable viewport buffers and reports Piece A/B triangle counts, connector kind, and volume error. Apply installs the candidate, selects Piece A, and clears revision-bound diagnostics for normal rescheduling.

Whole-document STL/OBJ/3MF conversion remains on the existing export service. Piece A and B export through the existing selected-part binary STL operation, including its established transform policy. No writer is duplicated.

## Known V1 limitations

- One selected closed manifold part and one plane.
- Manual geometric split, without semantic AI.
- None, one to four round pins, or one dovetail.
- Automatic connector placement only.
- No snap, thread, lead-in, custom connector, or printer profile.
- No fit or printability guarantee.
- Millimetre-declared documents only for connectors.
- Existing Boolean and candidate resource ceilings apply.

## Qualification evidence

Permanent Node/WASM tests cover centered split, miss/tangent refusal, volume conservation, cap recovery, pin/socket, dovetail, male-side flips, geometric clearance effects, and oversized connector refusal. Chromium harness flows cover nested workers, Preview, Apply, exact Undo, Piece A/B STL downloads, both connector kinds, Cancel, and seven shared parts becoming eight before exact restoration. The repository-wide import/export, privacy, Boolean cancellation, responsiveness, and retention suites pass.

Dedicated Chromium tests cancel five real heavy Split previews after `MANIFOLD_ENTER`; the final full-harness cancellation tail was 93/112/115 ms min/median/max, every child count returned to zero, created equalled terminated, the document stayed unchanged, and a fresh preview succeeded after every trial. A pin Boolean was also cancelled after its own confirmed Manifold entry. Separate tests prove monotonic-generation supersession, replacement import during a heavy Split, repeated preview/invalidate/cancel retention, and zero off-origin requests through pin/dovetail preview, Apply, and Piece A/B export.

The deterministic benchmark runs three iterations per row on the production Manifold adapter. Times below are min/median/max in milliseconds; “other” includes eligibility, cap recovery, placement, and topology validation:

| source            | connector |        Boolean |          total |          other |
| ----------------- | --------: | -------------: | -------------: | -------------: |
| 10,224 triangles  |      None |       41/42/63 |      93/94/208 |      52/53/146 |
| 10,224 triangles  |       Pin |       63/64/68 |    134/136/146 |       71/72/78 |
| 10,224 triangles  |  Dovetail |       61/62/66 |    132/134/140 |       70/71/74 |
| 99,904 triangles  |      None |    405/406/419 |    822/826/937 |    417/420/518 |
| 99,904 triangles  |       Pin |    616/617/626 | 1214/1216/1232 |    598/600/607 |
| 99,904 triangles  |  Dovetail |    613/624/704 | 1226/1233/1302 |    599/603/620 |
| 499,000 triangles |      None | 2211/2262/2330 | 4329/4369/4657 | 2066/2158/2327 |
| 499,000 triangles |       Pin | 3363/3418/3424 | 6377/6379/6402 | 2953/2961/3039 |

The 500k dovetail row is intentionally omitted: the qualified matrix requires it only when comfortably inside the envelope. Final full-harness Update Preview measurements were 262 ms with a 49 ms longest frame gap at 10k, 1,391/33 ms at 100k, and 5,282/250 ms at 500k.

A torus split supplies a real outer and inner cap loop. Pin and dovetail centers are proven inside annular material; an oversized profile refuses. A two-shell source supplies disconnected loops. The MVP searches all triangulated cap regions and greedily chooses the highest-clearance deterministic candidates; repeated runs choose byte-equal centers, and connectors never bridge empty space. Four pins, explicit safe/unsafe inset, dovetail near-edge refusal, oblique/near-end/vertex/edge/thin planes, cylinder, torus, concave prism, and disconnected shells all have permanent focused coverage.
