import type { Diagnostic } from '@cadfixer/shared';
import type { MeshGroup } from '@cadfixer/mesh-core';

/** Stable codes for the non-fatal findings an STL import can report. */
export const StlWarningCode = {
  InvalidStoredNormals: 'STL_INVALID_STORED_NORMALS',
  ZeroStoredNormals: 'STL_ZERO_STORED_NORMALS',
  TrailingBytes: 'STL_TRAILING_BYTES',
  MissingEndSolid: 'STL_MISSING_ENDSOLID',
  MultipleSolids: 'STL_MULTIPLE_SOLIDS',
} as const;

export type StlWarningCode = (typeof StlWarningCode)[keyof typeof StlWarningCode];

/**
 * Parser output before it is wrapped as a `CanonicalMesh`.
 *
 * Kept separate so both encodings share one assembly path, and so the parsers
 * stay free of metadata concerns.
 */
export interface StlRawGeometry {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
  readonly warnings: readonly Diagnostic[];
  /** One entry per named `solid` in an ASCII file. Empty for binary STL. */
  readonly groups: readonly MeshGroup[];
}
