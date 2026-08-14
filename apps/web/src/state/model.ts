import type { CanonicalMesh, MeshBounds } from '@cadfixer/mesh-core';
import type { Diagnostic } from '@cadfixer/shared';
import type { MeshValidationSummary } from '@cadfixer/geometry-runtime';

/**
 * A successfully imported model, as the workspace holds it.
 *
 * Everything here is either a reference to already-computed data or a plain
 * number computed in the worker. Nothing in this shape requires the main thread
 * to walk the mesh, which is what keeps the details panel from becoming a
 * source of jank on large models.
 */
export interface LoadedModel {
  readonly mesh: CanonicalMesh;
  /** Display-only normals derived from the geometry, never from the file. */
  readonly renderNormals: Float32Array;
  readonly source: ModelSource;
  readonly bounds: MeshBounds | undefined;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly validation: MeshValidationSummary;
  readonly warnings: readonly Diagnostic[];
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
  readonly importedAt: number;
}

/**
 * How the model's unit should be described to the user.
 *
 * STL has no standardised unit field, so an imported STL genuinely has no unit.
 * Saying "millimetres" would be a guess presented as a fact, and the whole point
 * of tracking this is that CAD Fixer does not invent information about a
 * model.
 */
export function describeUnit(mesh: CanonicalMesh): string {
  const unit = mesh.metadata.unit;
  if (unit !== undefined) return unit;
  return mesh.metadata.sourceFormat === 'stl' ? 'Unspecified by STL' : 'Unspecified';
}
