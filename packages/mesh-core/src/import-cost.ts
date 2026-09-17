import { distinctMeshes, type GeometryDocument } from './document';
import { meshByteLength, triangleCount, type CanonicalMesh } from './mesh';

/**
 * THE GEOMETRY A DOCUMENT COSTS TO OPEN, counted once per DISTINCT mesh.
 *
 * WHY THIS EXISTS, AND WHAT IT REPLACES. Stage 6D-R3 retired
 * `estimateImportPeak`, which summed five quantities — current resident, current
 * render, the input buffer, and the candidate's resident and render bytes — and
 * called the total a session memory peak. Three separate defects made that
 * number unusable as a gate: it ran AFTER the transient peak it named, it
 * computed both geometry terms from the SUMMED triangle count while shared
 * placements store one mesh, and it counted the candidate's render bytes twice.
 * Its error was measured at 81x pessimistic on a placement-heavy document and
 * 2-6x optimistic on a geometry-dense one, changing SIGN with content shape.
 *
 * This measures something narrower and true instead: the bytes CAD Fixer will
 * hold for the geometry itself once the document is open — the canonical buffers
 * the reader produced, plus the render snapshot `buildDrawableTriangles` is
 * about to allocate from them. Nothing here is a prediction about the process.
 *
 * WHY IT LIVES BESIDE `buildDrawableTriangles`. The render term is that
 * function's own allocation, so the predicate and the allocation are one file
 * apart and cannot drift. A copy of `9 * 4 * 2` written in the budget module
 * would be a second answer to "how big is a render snapshot", and the first time
 * the snapshot gained a buffer the gate would quietly stop bounding it.
 *
 * WHY DISTINCT MESHES. `documentTriangleCount` sums per PART, so a thousand
 * placements of one component report a thousand times the triangles while
 * storing one mesh and building one render snapshot. Charging those placements
 * is what made the retired estimator refuse a nine-megabyte document.
 */

/**
 * Bytes `buildDrawableTriangles` allocates for one mesh.
 *
 * Positions and normals, three corners per face, three floats per corner, four
 * bytes per float: 72 bytes per triangle. The draw is NON-INDEXED, so this does
 * not shrink when the canonical mesh shares corners — an indexed mesh is cheaper
 * to STORE and exactly as expensive to DRAW.
 */
export function drawableTriangleBytes(mesh: CanonicalMesh): number {
  return triangleCount(mesh) * RENDER_BYTES_PER_TRIANGLE;
}

/**
 * Bytes one triangle contributes to a render snapshot.
 *
 * Exported for the format-specific pre-gates, which have to answer "how many
 * triangles fit" before a mesh exists to measure.
 */
export const RENDER_BYTES_PER_TRIANGLE = 9 * 4 * 2;

/**
 * Bytes a mesh with no shared corners contributes to `ImportGeometryCost`.
 *
 * Positions 3 x 3 x 4, indices 3 x 4, plus the render snapshot: 120 bytes per
 * triangle. This is EXACTLY what a binary STL costs, because the STL readers
 * preserve the file's triangle stream and never weld — see ADR 0007 — so a
 * reader can solve for a triangle ceiling from the file's length alone, before
 * it allocates anything. An indexed format costs LESS per triangle and cannot be
 * bounded this way, which is why the common gate below still runs for all three.
 */
export const UNSHARED_IMPORT_BYTES_PER_TRIANGLE = 3 * 3 * 4 + 3 * 4 + RENDER_BYTES_PER_TRIANGLE;

/** What a document will hold for geometry, with the terms kept separate. */
export interface ImportGeometryCost {
  /** Canonical positions, indices and any stored normals or UVs. */
  readonly canonicalBytes: number;
  /** The render snapshot that has not been built yet. */
  readonly renderSnapshotBytes: number;
  readonly totalBytes: number;
  /** Meshes actually stored. Placements of one mesh count once. */
  readonly distinctMeshCount: number;
  /** Triangles actually stored, which is what both terms scale on. */
  readonly distinctTriangleCount: number;
}

export function measureImportGeometry(document: GeometryDocument): ImportGeometryCost {
  let canonicalBytes = 0;
  let renderSnapshotBytes = 0;
  let distinctMeshCount = 0;
  let distinctTriangleCount = 0;

  for (const mesh of distinctMeshes(document)) {
    canonicalBytes += meshByteLength(mesh);
    renderSnapshotBytes += drawableTriangleBytes(mesh);
    distinctTriangleCount += triangleCount(mesh);
    distinctMeshCount += 1;
  }

  return {
    canonicalBytes,
    renderSnapshotBytes,
    totalBytes: canonicalBytes + renderSnapshotBytes,
    distinctMeshCount,
    distinctTriangleCount,
  };
}

/**
 * The ceiling, and the measurements it comes from.
 *
 * MEASURED IN CHROMIUM ON THE STATED MINIMUM HOST — macOS 27, Apple M1, 8 GiB —
 * against a production build, importing binary STL whose triangles MEET, which
 * is what a real print model looks like. Renderer `phys_footprint_peak` for the
 * complete user action: import, render, and the automatic work that follows.
 *
 *     cost 240 MiB (2.10M triangles)    1,055 MiB
 *     cost 480 MiB (4.20M triangles)    1,503 MiB
 *     cost 720 MiB (6.29M triangles)    1,890 MiB
 *
 * That is `638 + 1.74 x cost` MiB, linear across the range, so 768 MiB of cost
 * predicts about 1,975 MiB of renderer footprint.
 *
 * WHY 1,975 MiB IS THE TARGET AND NOT A ROUNDER, LARGER NUMBER. It is not a new
 * judgement. Stage 6D-B3 REJECTED a 3MF ceiling that measured 2,679-3,071 MiB on
 * this host, and Stage 6D-R1 QUALIFIED the multi-part worst case at
 * 1,923-1,994 MiB. The accepted/rejected line was therefore already drawn
 * between about 2.0 and 2.7 GiB by decisions that are in force; this ceiling
 * puts all three formats inside the band that was already qualified rather than
 * inventing a fresh envelope for STL.
 *
 * THE COINCIDENCE WITH THE RETIRED `maxRenderBytes` IS A COINCIDENCE. That
 * constant was also 768 MiB, was enforced by nothing, and bounded a different
 * quantity — the render snapshot alone. This number was solved from the
 * measurements above and would have been adopted whatever the dead constant
 * said.
 */
export const MAX_IMPORT_GEOMETRY_BYTES = 768 * 1024 * 1024;

/**
 * Triangles an UNSHARED-CORNER mesh may have before it exceeds the ceiling.
 *
 * DERIVED, never written down a second time. A reader that carried its own
 * number would drift from the gate the moment either moved, and the drift would
 * show up as a file that is fully parsed and then refused — all of the work and
 * none of the protection.
 */
export const MAX_UNSHARED_IMPORT_TRIANGLES = Math.floor(
  MAX_IMPORT_GEOMETRY_BYTES / UNSHARED_IMPORT_BYTES_PER_TRIANGLE,
);
