import type { Diagnostic } from '@cadfixer/shared';
import type { GeometryDocument } from '@cadfixer/mesh-core';
import type { FormatReadContext } from './context';
import type { MeshFormatId } from './formats';

/**
 * WHAT A FORMAT READER PRODUCES, since Stage 4A-2B1: a whole document.
 *
 * Stage 1's `MeshReader` returned one `CanonicalMesh`, which was truthful while
 * STL was the only codec — an STL file describes exactly one triangle soup. OBJ
 * and 3MF do not: an OBJ `o` record and a 3MF `<build><item>` each declare a
 * separate thing, and a 3MF component may place the same geometry twice.
 *
 * Rather than have two reader contracts and two commit paths, every reader now
 * produces a `GeometryDocument`. STL's produces a one-part one. The worker's
 * import handler therefore has NO per-format branching after dispatch: it
 * validates the document and commits it, exactly as it did for STL, and the
 * question "how does a document become authoritative?" keeps one answer.
 */

/**
 * Source features a reader recognised and did not import.
 *
 * NOT A GENERAL CONVERSION REPORT — that is Stage 4A-2B2's job, and it has to
 * describe a transformation between two formats. This describes one direction
 * only: what was in the file, and what CAD Fixer did about it.
 *
 * The distinction that matters is between a feature that was DROPPED and one
 * that was never claimed. Silently discarding a texture is the dishonesty this
 * exists to prevent; listing "no textures" on a file that had none would be
 * noise.
 */
export const UnsupportedFeature = {
  /** 3MF texture resources. Never decoded, never fetched. */
  Textures: 'TEXTURES',
  /** 3MF colour and base-material resources beyond an opaque reference. */
  Materials: 'MATERIALS',
  /** An OBJ `mtllib` reference. Recorded as text; the file is never opened. */
  ExternalMaterialLibrary: 'EXTERNAL_MATERIAL_LIBRARY',
  /** A mesh resource the build never places. Parsed, then not shown. */
  UnreferencedObject: 'UNREFERENCED_OBJECT',
} as const;

export type UnsupportedFeature = (typeof UnsupportedFeature)[keyof typeof UnsupportedFeature];

export interface ImportCompatibility {
  /**
   * Features present in the source that this import did not carry across.
   *
   * Empty for an ordinary file, which is the point: a valid STL or a plain OBJ
   * must not be decorated with warnings about things it never contained.
   */
  readonly unsupported: readonly UnsupportedFeature[];
  /**
   * Opaque names the source used, for display only.
   *
   * NEVER RESOLVED. An `mtllib` is text; nothing opens it, fetches it, or asks
   * the user for it.
   */
  readonly externalReferences: readonly string[];
}

export const EMPTY_COMPATIBILITY: ImportCompatibility = Object.freeze({
  unsupported: Object.freeze([]),
  externalReferences: Object.freeze([]),
});

export interface DocumentReadResult {
  /**
   * The candidate. NOT yet authoritative: the caller validates it and commits
   * it, and a reader returning a document is not an import succeeding.
   */
  readonly document: GeometryDocument;
  /** As actually detected, never guessed from a name. e.g. `binary`, `text`. */
  readonly encoding: string;
  /** Non-fatal findings. An empty array means a clean import. */
  readonly warnings: readonly Diagnostic[];
  /** What the source contained that this import did not carry across. */
  readonly compatibility: ImportCompatibility;
}

export interface DocumentReader {
  readonly formatId: MeshFormatId;
  /**
   * Parses `bytes` into a candidate document.
   *
   * Implementations must treat `bytes` as hostile: validate every declared
   * count against the actual buffer before allocating, bound all allocations,
   * and poll `context.cancellation` inside every loop that can run long. The
   * caller validates the returned document — see `assertGeometryDocument`.
   */
  read(bytes: Uint8Array, context: FormatReadContext): Promise<DocumentReadResult>;
}
