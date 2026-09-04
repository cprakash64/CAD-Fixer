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
  readonly formatId: string;
  /** `binary` or `ascii`, as detected from the file's structure. */
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
