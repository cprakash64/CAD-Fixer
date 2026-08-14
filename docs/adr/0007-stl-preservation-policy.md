# 7. STL import preserves geometry rather than normalising it

- Status: Accepted
- Date: 2026-08-14

## Context

The STL parser is the first place user geometry enters CAD Fixer, and it faces a
decision that most STL loaders make silently.

STL is triangle soup. Every facet carries three full vertex positions, so a cube
exported as STL has 36 vertices rather than 8, and adjacent faces repeat their
shared corners as independent, bit-identical coordinates. Nearly every STL loader
in existence — including Three.js's `STLLoader` when asked, and most slicers —
responds by welding coincident vertices on import, and many go further: dropping
zero-area triangles, deduplicating repeated facets, reorienting winding to match
the stored facet normal, or assuming millimetres.

Each of those is defensible in a viewer. This is not a viewer. It is a repair
tool, and the defects those steps quietly erase are precisely the defects the
user came here to find.

There is also a narrower question. Every STL facet stores a normal vector, and
in real files those normals are frequently wrong: zero, denormalised, or
pointing opposite to the winding order. Something has to decide which of the two
disagreeing sources — stored normal or vertex winding — is authoritative.

## Decision

**The STL reader preserves what the file contains.** It performs no welding, no
deduplication, no degenerate-triangle removal, no reorientation, no hole filling,
no rescaling, and no unit assumption.

Specifically:

1. **Triangle identity is preserved.** Each facet becomes three distinct
   vertices with sequential indices (`0,1,2,3,…`). Triangle _n_ in the file is
   triangle _n_ in the mesh.
2. **Winding order is authoritative for orientation**; the stored facet normal
   is treated as advisory and is not retained as geometry. Where a stored normal
   is non-finite or zero, that is counted and surfaced as an import warning, not
   an error, and not a reason to alter the triangle.
3. **Rendering normals are derived from the geometry** and returned as a
   separate buffer. They are never written into the canonical mesh.
4. **Units are left unstated.** `metadata.unit` is omitted, and the interface
   displays "Unspecified by STL".
5. **No transform is applied.** File coordinates are model coordinates.
6. **Malformed data fails the import; merely problematic data is imported and
   reported.** A non-finite coordinate cannot describe a position, so the file is
   rejected. A degenerate or duplicated triangle is representable, so it is
   loaded and left for diagnostics.

## Alternatives considered

**Weld coincident vertices on import.** Rejected. It would cut memory by roughly
two-thirds for a typical closed mesh, which is a genuine benefit — the numbers in
`PERFORMANCE_BASELINE.md` are for the unwelded representation. But welding is a
repair operation with a tolerance parameter, and applying it invisibly at import
would: destroy the evidence of cracks and duplicated shells that the repair
workflow exists to detect; make "what does this file actually contain?"
unanswerable; and silently pick a tolerance on the user's behalf. Welding will be
offered later as an explicit, undoable operation with a stated tolerance.

**Trust the stored facet normal.** Rejected. Real files disagree with themselves
often enough that a normal cannot be treated as ground truth, and using an
invalid normal as geometry would corrupt the model. Winding order is intrinsic to
the triangle; the normal is redundant metadata that may or may not have been
maintained.

**Discard triangles with invalid stored normals.** Rejected — it deletes user
geometry over a metadata defect.

**Default the unit to millimetres.** Rejected, though it is what most of the
ecosystem does. STL has no unit field; millimetres is a convention, not a fact.
Displaying an invented unit as though the file stated it is exactly the kind of
quiet fabrication the data-integrity principle forbids. An explicit "unspecified"
is less convenient and more truthful.

**Store facet normals for later diagnostics.** Deferred. Comparing each stored
normal against the geometric normal would identify orientation defects, which is
genuinely useful — but it doubles position-buffer memory to retain data that is
mostly redundant, and the analysis belongs with topological diagnostics. Only
counts of unusable normals are kept for now.

## Consequences

**Good:**

- What is loaded is what the file contains, so diagnostics and repair have
  complete evidence to work from.
- Import is fast: no hashing, no spatial lookup, one linear pass.
- Round-tripping is exact — verified in tests for both encodings.
- Triangle indices are stable between file and mesh, so future diagnostics can
  report "triangle 41,203" and mean the facet at that position in the file.

**Costs, accepted knowingly:**

- **Memory.** Sequential indices are pure redundancy (`0,1,2,3,…`), costing
  24 MiB per 2 million triangles, and unwelded vertices cost roughly 3x what a
  welded mesh would. Measured in `PERFORMANCE_BASELINE.md`.
- The mesh presented to the user has ~3x the vertex count of the "same" model in
  a tool that welds on import, which may look wrong to someone comparing
  statistics across applications. The interface reports counts as they are.
- Flat shading is the natural result of unwelded geometry. For STL this is
  correct — STL genuinely has no smooth-shading information.

**This ADR does not settle:** vertex-buffer memory optimisation. A non-indexed
representation, or welding as an explicit user-invoked operation, remain open and
should be driven by measurement rather than by preference.
