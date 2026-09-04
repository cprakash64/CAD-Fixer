import { DEFAULT_DOCUMENT_LIMITS } from '@cadfixer/mesh-core';

/**
 * OBJ intake ceilings, promoted from the Stage 4A research limits.
 *
 * WHY EVERY ONE OF THESE EXISTS. An OBJ is text, and text costs nothing to
 * write: `f 1/1/1 …` repeated is a few bytes per face, and a line with no
 * newline in it is a single unbounded token. Without ceilings the file decides
 * how much memory the worker commits, which is exactly the decision a budget
 * exists to take away from untrusted input.
 *
 * The values are ADR 0013's, unchanged: 512 MiB of input, 65,536-character
 * lines, 40M vertices and 40M faces. The object, group and name caps come from
 * the research parser's `DEFAULT_OBJ_LIMITS`.
 */
export interface ObjLimits {
  /** Whole-file ceiling, checked before decoding. */
  readonly maxBytes: number;
  /**
   * Longest line, in characters.
   *
   * A file with no line breaks is one line, so this is also the bound on how
   * much text a single scan step can be asked to hold.
   */
  readonly maxLineLength: number;
  /**
   * Vertices in the FILE'S shared pool.
   *
   * Not the document's total, and deliberately not derived from it: each part
   * gets its own copy of the vertices it uses, so a pool shared between parts
   * expands rather than divides. The document's vertex ceiling is therefore
   * checked at the gate, where the parts actually exist.
   */
  readonly maxVertices: number;
  /**
   * Faces in the file, which is EXACTLY the document's triangle total.
   *
   * Every face belongs to exactly one part, so the two numbers are the same
   * number and the reader can enforce the document's ceiling directly instead
   * of building a model that the gate will refuse.
   */
  readonly maxFaces: number;
  readonly maxObjects: number;
  readonly maxGroups: number;
  /**
   * Names are display metadata from an untrusted file, and are truncated.
   *
   * TO THE DOCUMENT'S CAP, not to a larger one of the reader's own. This was
   * 1,024 while `DocumentLimits.maxNameLength` was 512, so a 600-character
   * object name survived the reader and was then refused by the document gate
   * — the whole model unimportable because of a string. Truncating above the
   * ceiling that will be enforced is not truncating.
   */
  readonly maxNameLength: number;
  /**
   * Corners per face. THREE, by policy rather than by convenience.
   *
   * A polygon is refused, never fanned: for the concave pentagon the research
   * measured, a naive fan produces a triangle of the opposite orientation —
   * geometry outside the polygon the file described. See ADR 0013.
   */
  readonly maxFaceVertices: number;
}

export const DEFAULT_OBJ_LIMITS: ObjLimits = Object.freeze({
  maxBytes: 512 * 1024 * 1024,
  maxLineLength: 65_536,
  maxVertices: 40_000_000,
  maxFaces: DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles,
  maxObjects: 65_536,
  maxGroups: 65_536,
  maxNameLength: DEFAULT_DOCUMENT_LIMITS.maxNameLength,
  maxFaceVertices: 3,
});
