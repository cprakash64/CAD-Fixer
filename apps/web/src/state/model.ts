import type { MeshBounds } from '@cadfixer/mesh-core';
import type { Diagnostic } from '@cadfixer/shared';
import type {
  MeshValidationSummary,
  ModelHandle,
  RenderSnapshot,
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
 * What remains is a handle, a render snapshot the GPU needs anyway, and plain
 * numbers computed in the worker. Nothing here requires the main thread to walk
 * a mesh.
 */
export interface LoadedModel {
  /** Names the authoritative geometry, which lives in the worker. */
  readonly handle: ModelHandle;
  /** Display-only buffers. Derived data, not the user's geometry. */
  readonly render: RenderSnapshot;
  readonly source: ModelSource;
  readonly bounds: MeshBounds | undefined;
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
