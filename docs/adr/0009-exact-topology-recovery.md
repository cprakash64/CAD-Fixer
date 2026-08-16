# 9. Topology is recovered from exact stored coordinates

- Status: Accepted
- Date: 2026-08-15

## Context

STL is triangle soup. Every facet carries three full vertex positions, so a cube
arrives as 36 independent corners rather than 8 shared vertices, and the
canonical indices are the sequence `0,1,2,3,…`. Those indices carry no
connectivity information whatsoever.

Every topological question a user cares about — is this closed, is it manifold,
how many separate pieces are there, is the winding consistent — is a question
about connectivity. So connectivity has to be **recovered**, and the only input
available is the coordinates themselves. The single decision that governs
everything else is: **when are two corners the same vertex?**

The tempting answer is a tolerance: treat corners within ε as one point. That is
what most repair tools do, and it is why they are repair tools. It is also
irreversible, scale-dependent, and unit-dependent — and STL states no unit, so
there is no principled ε to pick. A tolerance chosen for millimetres silently
destroys a model authored in metres.

## Decision

**Stage 2 recovers topology using exact stored-coordinate equality, and modifies
nothing.**

Two corners are the same topological vertex when their stored float values are
bit-identical, with one normalisation: **`-0` and `+0` are the same point.** IEEE
754 makes them numerically equal but bitwise distinct, and a file that writes one
in one facet and the other in the next is describing the same corner. Nothing
else is normalised.

### Semantics this fixes in place

- **No tolerance welding.** Coordinates that differ by one ULP are two distinct
  vertices, and the edge between the faces that use them is a boundary edge.
- **No canonical geometry mutation.** Analysis is read-only. Positions and
  indices are byte-identical afterwards; a regression test compares the buffers,
  not their lengths.
- **Face-connected components use shared EDGES.** Two faces are in the same
  component when a chain of shared edges joins them.
- **Vertex-only contact does not merge components.** Two cones meeting at a point
  are two surface patches that happen to touch. You cannot walk from one to the
  other across the surface, and a slicer cannot either.
- **Component-local vertex sets may overlap.** A shared point of contact belongs
  to both components' vertex sets, so per-component vertex counts do not sum to
  the global count. The global count stays deduplicated; forcing the sums to
  agree would require giving the vertex to one component and denying it to the
  other, which produces a wrong Euler characteristic for both.
- **Boundary cycles are boundary loops, never "holes".** A closed chain of
  boundary edges is a topological fact. Whether it is a defect or the intended
  open end of a tube is an interpretation topology cannot make.
- **Edge manifoldness and vertex manifoldness are separate properties**, reported
  separately. An edge is non-manifold when more than two faces share it. A vertex
  is non-manifold when its incident faces do not form one connected fan.
- **Bow-tie vertices are detected.** Two patches meeting at exactly one vertex
  have no unusual edge at all — every edge still has at most two faces — so an
  edge-only check reports the model as clean. Detection is by union-find over
  (vertex, face) incidences, unioned at both endpoints of every shared edge.
- **Winding consistency comes from face order.** Two faces sharing an edge are
  consistent only if they traverse it in opposite directions.
- **STL stored normals are not topology truth.** They are advisory, frequently
  wrong, and ignored entirely. Using them would let a bad normal invent or
  conceal a defect.
- **Signed volume is algebraic**, summed per component against a component-local
  reference point, with compensated summation. It is interpretable as an
  enclosed volume only when the component is closed, manifold, and consistently
  wound — and the report says which of those held.
- **Self-intersections are NOT checked.** No triangle/triangle intersection test
  exists.
- **Wall thickness is NOT checked.**
- **Topology passing does not prove printability.** The report's printability
  status is never `true`; the best it says is "not fully determined".

## Consequences

**Accepted, knowingly:**

- **Tiny coordinate discrepancies appear as boundary edges.** A model exported
  from a CAD system that rounded vertex positions inconsistently will report
  openings along seams that look closed on screen. This is not a false positive:
  the file genuinely says those triangles do not share a vertex, and any tool
  that welds them has made a decision the user did not see.
- Some users will find the first report alarming. The answer is better wording
  and, later, an explicit repair step — not a quieter analysis.

**Gained:**

- **Analysis is safe to run automatically**, on import, without asking. It cannot
  damage anything, because it changes nothing.
- **Exact topology is the pre-repair baseline.** Once welding exists, "what did
  the file actually say" and "what did we change" are both answerable, and the
  difference between them is reviewable.
- **Later repair can offer tolerance-based welding explicitly**, as an operation
  with a stated tolerance, a preview, and an undo — rather than as an invisible
  side effect of opening a file.

## Alternatives rejected

- **Weld with a default epsilon on import.** Rejected: it is irreversible, it has
  no principled value without a unit, and it makes the tool's first act a silent
  modification of the user's data.
- **Weld with a relative epsilon derived from the bounding box.** Rejected for
  the same reason plus a worse one: the threshold would change when the user
  moved the model, so the same geometry would report different topology depending
  on where it sat in space.
- **Report "watertight" as a single verdict.** Rejected: it conflates closed,
  manifold, consistently wound, and non-self-intersecting, three of which are
  checked and one of which is not.

## Related

- [ADR 0004](0004-canonical-mesh-model.md) — canonical mesh, Float32/Float64 open
- [ADR 0007](0007-stl-preservation-policy.md) — import preserves what the file says
- [ADR 0008](0008-worker-resident-geometry.md) — the worker owns the geometry
