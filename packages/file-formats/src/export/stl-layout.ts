/**
 * THE BINARY STL CONTAINER, AS ARITHMETIC. A LEAF MODULE WITH NO IMPORTS.
 *
 * WHY IT IS SEPARATE FROM THE WRITER. The conversion policy has to answer "will
 * this fit?" before anything is written, and it runs on the MAIN THREAD. When
 * it reached into `stl-document-writer.ts` for the same numbers, the bundler
 * followed that module's own imports and pulled `stl/detect.ts` — with its
 * ASCII-STL keyword tables, built at module scope and therefore not
 * tree-shakeable — into the application bundle. Kilobytes of parser tables
 * shipped to every user so a dialog could multiply by fifty.
 *
 * Nothing here imports anything, so nothing can arrive with it. The writer and
 * the policy share ONE definition of the container's shape, and the policy pays
 * for exactly that.
 */

export const BINARY_HEADER_BYTES = 80;
export const BINARY_COUNT_BYTES = 4;
/** Header plus the little-endian triangle count. */
export const BINARY_PREFIX_BYTES = BINARY_HEADER_BYTES + BINARY_COUNT_BYTES;
/** Normal, three corners, and the attribute byte count. Fixed width. */
export const BINARY_FACET_BYTES = 50;

/**
 * THE MOST TRIANGLES A BINARY STL CAN DECLARE.
 *
 * The count is a little-endian `uint32`, so the format itself stops here. This
 * is almost never the binding limit — an output ceiling bites first at any
 * plausible size — but it is a real one, and a count that silently wrapped
 * would produce a file whose header disagreed with its body.
 */
export const MAX_BINARY_STL_TRIANGLES = 0xffff_ffff;

/**
 * The EXACT byte length a triangle count produces.
 *
 * Binary STL is fixed width, which is what makes an STL preflight an answer
 * rather than an estimate: a conversion this rejects genuinely cannot be
 * produced, and one it accepts cannot later overflow the ceiling.
 */
export function binaryStlByteLength(triangleCount: number): number {
  return BINARY_PREFIX_BYTES + triangleCount * BINARY_FACET_BYTES;
}

/** The largest triangle count that fits in `maxOutputBytes`. Derived, not chosen. */
export function maxStlDocumentTriangles(maxOutputBytes: number): number {
  const byBytes = Math.floor((maxOutputBytes - BINARY_PREFIX_BYTES) / BINARY_FACET_BYTES);
  return Math.max(0, Math.min(byBytes, MAX_BINARY_STL_TRIANGLES));
}
