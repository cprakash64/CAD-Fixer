# Format support matrix and known limitations

Internal reference for the next Technical Preview release candidate. Written in
Stage 6D-A4 from **measured behaviour** — the production import pipeline run over
2,130 real and reference files and a deterministic mutation campaign — not from intent. Every "yes" below is
bounded by the resource policy in [RESOURCE_POLICY.md](RESOURCE_POLICY.md); every
"no" is a typed refusal that names what was not supported, never a partial
import. Evidence: `docs/design/STAGE_6D_3MF_PRODUCTION_AND_LARGE_ENTRY_ARCHITECTURE.md`,
section _Stage 6D-A4_.

## Import

| Format / feature                                         | Supported | Notes                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary STL                                               | yes       | Up to 6,710,886 triangles (the deterministic R3 gate, 320 MiB file). Attribute bytes ignored. Zero-triangle, truncated and count/payload-disagreeing files are refused by name.                                                                                                             |
| ASCII STL                                                | yes       | LF, CRLF and **CR-only** line endings (CR-only since A4), scientific notation, case-insensitive keywords, several solids (kept as groups). Non-finite values, text after end tags and missing tokens are refused as malformed: parsing is not repair.                                       |
| OBJ triangle geometry                                    | yes       | `v`/`f` with positive and negative indices, `o` → parts, `g`/`usemtl` → groups, comments, smoothing records, CRLF, scientific notation. `vt`/`vn` read and discarded.                                                                                                                       |
| OBJ quads and n-gons                                     | **no**    | Refused (`OBJ_POLYGON_UNSUPPORTED`) rather than fanned, which would invent area for concave faces. The most frequent OBJ refusal in the corpus.                                                                                                                                             |
| OBJ materials (`mtllib`)                                 | no        | Named in the import report; the file is never opened.                                                                                                                                                                                                                                       |
| Core 3MF geometry                                        | yes       | Meshes, build items, components, transforms, repeated placements (shared, not copied), all six units. Root found by OPC relationship, conventional path, or a single model part — and since A4 the relationship target need not end in `.model`.                                            |
| 3MF materials, colours, textures, thumbnails             | no        | Ignored safely and reported; geometry imports.                                                                                                                                                                                                                                              |
| 3MF Production Extension — referenced model parts        | yes       | `p:path` on root build items and root components; any number of reachable child parts; per-part object ids; package-wide budgets; unit agreement required.                                                                                                                                  |
| Slicer project metadata (Bambu/Orca/Prusa configs)       | ignored   | Not interpreted. Bambu `modifier_part` volumes are ordinary mesh objects in core 3MF, so they import and appear as parts.                                                                                                                                                                   |
| 3MF Production `p:UUID`, child `<build>`, child `.rels`  | ignored   | Normatively ignorable or producer-side; not validated (A3 decision).                                                                                                                                                                                                                        |
| Zip64 3MF packages                                       | yes       | Any size, as Bambu Studio and OrcaSlicer write them. Every ceiling applies to the resolved 64-bit value; values above 2^53, split archives and corrupt Zip64 records are refused.                                                                                                           |
| 3MF Production Alternatives (model resolution)           | **no**    | `THREEMF_MODEL_RESOLUTION_UNSUPPORTED`. Truthful unsupported.                                                                                                                                                                                                                               |
| 3MF Secure Content                                       | **no**    | Refused as a required extension CAD Fixer does not implement.                                                                                                                                                                                                                               |
| Any other required 3MF extension                         | **no**    | Materials-required, slice, beam lattice, booleans, displacement, volumetric, triangle sets: `THREEMF_UNSUPPORTED_EXTENSION`. Optional (not required) extension content is ignored per core's must-ignore rule; since A4 a foreign-namespace element can no longer be read as core geometry. |
| A 3MF entry that expands beyond 256 MiB                  | **no**    | `ZIP_ENTRY_TOO_LARGE`, naming the size and the limit. BETA-002's class. Streaming import required.                                                                                                                                                                                          |
| A 3MF package expanding beyond 512 MiB, or ratio > 200:1 | no        | Resource refusals naming the metric, value and limit.                                                                                                                                                                                                                                       |

## Export

| Target | Supported | Notes                                                                                                                                          |
| ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| STL    | yes       | Whole document flattened; placements baked; no units, names or parts.                                                                          |
| OBJ    | yes       | Placements baked; names and groups kept; no units. Since A4 every group boundary survives, including unnamed groups and hole-fill patch faces. |
| 3MF    | yes       | Placements, sharing, names and unit kept. A document with no unit needs an export-time unit assertion. No production structure is written.     |

Every export is read back by the production reader and compared with its source
before it is offered; there is no way to skip that.

## Known limitations of the Technical Preview

- **Conservative repair only** — exact duplicates, safely removable degenerate
  triangles, and relative winding. No welding, no tolerance, no remeshing.
- **Bounded planar hole fill** — one selected flat opening at a time, up to 512
  rim points on a part of up to 250,000 triangles. No batch fill, no curved rims.
- **Self-intersection is a diagnostic, not a correction.**
- **Topology is exact-coordinate.** Nothing is merged by proximity.
- **One step of undo, no redo.**
- **No unit conversion.** A unit labels numbers; nothing is ever rescaled.
- **No streaming import yet.** A 3MF entry above 256 MiB is refused (BETA-002).
- **3MF extensions other than the production model-part subset are refused**,
  and colours, materials and textures are not imported or written.
- **OBJ polygons are refused**, not triangulated.
- **No 3MF CRC verification.** A damaged compressed stream is refused; a bit
  flip that still decompresses and still parses is not detected. The XML and
  mesh gates bound what such a file can do, but not what it means.
- **Chromium-based desktop browsers** on an 8 GiB machine are the qualified
  envelope; see [BROWSER_SUPPORT.md](BROWSER_SUPPORT.md).
