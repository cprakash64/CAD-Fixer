import { describeFormat, MeshFormatId } from '@cadfixer/file-formats';
import type { MeshBounds } from '@cadfixer/mesh-core';
import type { Diagnostic } from '@cadfixer/shared';
import type {
  DocumentRenderSnapshot,
  MeshValidationSummary,
  DocumentHandle,
  PartDescriptor,
} from '@cadfixer/geometry-runtime';

/**
 * A successfully imported model, as the workspace holds it.
 *
 * WHAT IS DELIBERATELY ABSENT: the `CanonicalMesh`. The authoritative geometry
 * lives in the worker and is named here only by `handle`. React state holding a
 * multi-hundred-megabyte mesh would make every operation that needs it — export,
 * diagnostics, and later repair and booleans — pay to send it back across the
 * boundary, which is exactly what Stage 1 did.
 *
 * What remains is a handle, render snapshots the GPU needs anyway, part
 * descriptors that are only strings and numbers, and plain counts computed in
 * the worker. Nothing here requires the main thread to walk a mesh.
 */
export interface LoadedModel {
  /** Names the authoritative DOCUMENT, which lives in the worker. */
  readonly handle: DocumentHandle;
  /**
   * Scalar metadata for each part, in document order.
   *
   * Identifiers, names, placements and counts — never geometry. A hundred-part
   * document costs the page a few kilobytes here.
   */
  readonly parts: readonly PartDescriptor[];
  /** Display-only buffers, one entry per part. Derived data, not the user's geometry. */
  readonly render: DocumentRenderSnapshot;
  readonly source: ModelSource;
  /** World-space extent of every part after its placement. */
  readonly bounds: MeshBounds | undefined;
  /** Summed across every part. */
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly validation: MeshValidationSummary;
  readonly warnings: readonly Diagnostic[];
  /** Bytes of authoritative geometry the worker holds for this model. */
  readonly residentBytes: number;
  /** Monotonic, so the viewport can tell one load from the next. */
  readonly revision: number;
}

export interface ModelSource {
  readonly fileName: string;
  /** Size of the file on disk, in bytes. */
  readonly fileBytes: number;
  /**
   * The format the WORKER identified from the bytes.
   *
   * A `MeshFormatId` value in every case the worker can produce, but typed as
   * `string` because it crosses the worker boundary: a value the main thread
   * does not recognise must be displayable rather than unrepresentable.
   */
  readonly formatId: string;
  /** How the file was physically encoded, as detected from its structure. */
  readonly encoding: string;
  /** The unit the source stated, or `undefined` when it stated none. */
  readonly unit: string | undefined;
  readonly importedAt: number;
}

/**
 * How the model's unit should be described to the user.
 *
 * STL has no standardised unit field, so an imported STL genuinely has no unit.
 * Saying "millimetres" would be a guess presented as a fact, and the whole point
 * of tracking this is that CAD Fixer does not invent information about a model.
 */
export function describeUnit(source: ModelSource): string {
  if (source.unit !== undefined) return source.unit;
  return source.formatId === 'stl' ? 'Unspecified by STL' : 'Unspecified';
}

/**
 * The format's own name, as identified from the file's bytes.
 *
 * NEVER the extension. A `.stl` holding an OBJ is reported as what it is, and
 * an identifier this build does not know is shown verbatim rather than
 * flattened into a familiar-looking label.
 */
export function describeSourceFormat(source: ModelSource): string {
  for (const id of Object.values(MeshFormatId)) {
    if (id === source.formatId) return describeFormat(id).label;
  }
  return source.formatId;
}

/**
 * How the file was encoded, in terms that mean something to a reader.
 *
 * STL is the only format with two encodings a user can meaningfully be told
 * apart, and those two words are the reader's own. The others are stated
 * plainly instead of echoing an internal tag: showing `3mf` under a heading
 * that already says 3MF tells nobody anything.
 */
export function describeEncoding(source: ModelSource): string {
  switch (source.encoding) {
    case MeshFormatId.ThreeMf:
      return 'Compressed package';
    case 'text':
      return 'Text';
    default:
      return source.encoding;
  }
}

/**
 * The one-line summary an import announces when it succeeds.
 *
 * Decided here so the status line cannot drift from the Model panel. It used to
 * read `(binary STL)` unconditionally, which was true while STL was the only
 * readable format and became a false statement about every OBJ and 3MF the
 * moment they could be imported.
 *
 * The encoding is named only for STL: binary and ASCII are two genuinely
 * different files a user may care to tell apart, whereas "text OBJ" and
 * "compressed package 3MF" add a word and no information.
 */
export function describeImport(
  source: ModelSource,
  triangleCount: number,
  partCount: number,
): string {
  const parts = partCount > 1 ? `${partCount.toLocaleString()} parts, ` : '';
  const encoding = source.formatId === MeshFormatId.Stl ? `${source.encoding} ` : '';
  return `${parts}${triangleCount.toLocaleString()} triangles (${encoding}${describeSourceFormat(source)}).`;
}
