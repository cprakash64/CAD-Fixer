import { geometryValidationFailed, type ErrorDetails } from '@cadfixer/shared';
import { triangleCount, vertexCount, type CanonicalMesh } from './mesh';

/**
 * STRUCTURAL mesh validation.
 *
 * This module enforces the invariants that make a `CanonicalMesh` well formed:
 * buffer lengths, index bounds, finite coordinates, group bounds. It is the
 * mechanism behind the project rule that a geometry operation is successful
 * only once its output passes validation.
 *
 * SCOPE BOUNDARY — this is not printability analysis. Manifoldness, boundary
 * edges, self-intersection, face orientation/winding consistency, shell
 * separation, and volume sanity are TOPOLOGICAL concerns and are deliberately
 * not implemented here. They arrive with the repair workflow and will live in
 * their own module so that the cheap structural gate stays cheap.
 *
 * KNOWN GAP — `DEGENERATE_TRIANGLE` detects only INDEX-level degeneracy: a
 * triangle that references the same vertex index twice. It does not detect
 * POSITIONAL degeneracy, where three distinct indices point at coincident or
 * collinear coordinates and the triangle has zero area. That distinction
 * matters more than it sounds: STL triangle soup numbers every corner uniquely,
 * so a zero-area triangle in an STL file is currently invisible to this check.
 * Finding it needs a per-triangle cross product, which is a geometric test
 * rather than a structural one, and belongs with the topological diagnostics.
 *
 * COST — validation is O(vertices + triangles) and scans every coordinate. On a
 * large mesh this is real work and must run inside a worker, never on the UI
 * thread.
 */

export const MeshValidationSeverity = {
  /** The mesh violates a structural invariant and must not be used. */
  Error: 'error',
  /** The mesh is usable but suspicious; surface to the user, do not block. */
  Warning: 'warning',
} as const;

export type MeshValidationSeverity =
  (typeof MeshValidationSeverity)[keyof typeof MeshValidationSeverity];

export const MeshValidationCode = {
  PositionsNotTriplets: 'POSITIONS_NOT_TRIPLETS',
  IndicesNotTriplets: 'INDICES_NOT_TRIPLETS',
  EmptyMesh: 'EMPTY_MESH',
  NoTriangles: 'NO_TRIANGLES',
  IndexOutOfRange: 'INDEX_OUT_OF_RANGE',
  NonFinitePosition: 'NON_FINITE_POSITION',
  NormalLengthMismatch: 'NORMAL_LENGTH_MISMATCH',
  UvLengthMismatch: 'UV_LENGTH_MISMATCH',
  GroupRangeInvalid: 'GROUP_RANGE_INVALID',
  DegenerateTriangle: 'DEGENERATE_TRIANGLE',
} as const;

export type MeshValidationCode = (typeof MeshValidationCode)[keyof typeof MeshValidationCode];

export interface MeshValidationIssue {
  readonly code: MeshValidationCode;
  readonly severity: MeshValidationSeverity;
  /** Human-readable and safe to display. Never contains coordinate data. */
  readonly message: string;
  /** Counts and indices only — never raw geometry. */
  readonly details?: ErrorDetails;
}

export interface MeshValidationReport {
  /** True when no issue has `Error` severity. */
  readonly valid: boolean;
  readonly issues: readonly MeshValidationIssue[];
  /** True when the issue list was capped, so the UI can say "and more". */
  readonly truncated: boolean;
  readonly vertexCount: number;
  readonly triangleCount: number;
}

export interface MeshValidationOptions {
  /**
   * Upper bound on collected issues. A pathological file can produce one issue
   * per triangle, so the report itself is a memory-exhaustion vector; capping it
   * keeps validation bounded regardless of input.
   */
  readonly maxIssues?: number;
}

const DEFAULT_MAX_ISSUES = 64;

export function validateMeshStructure(
  mesh: CanonicalMesh,
  options: MeshValidationOptions = {},
): MeshValidationReport {
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const issues: MeshValidationIssue[] = [];
  let truncated = false;

  const report = (
    code: MeshValidationCode,
    severity: MeshValidationSeverity,
    message: string,
    details?: ErrorDetails,
  ): void => {
    if (issues.length >= maxIssues) {
      truncated = true;
      return;
    }
    issues.push(
      details === undefined ? { code, severity, message } : { code, severity, message, details },
    );
  };

  const vertices = vertexCount(mesh);
  const triangles = triangleCount(mesh);

  if (mesh.positions.length % 3 !== 0) {
    report(
      MeshValidationCode.PositionsNotTriplets,
      MeshValidationSeverity.Error,
      'Position buffer length is not a multiple of 3.',
      { length: mesh.positions.length },
    );
  }

  if (mesh.indices.length % 3 !== 0) {
    report(
      MeshValidationCode.IndicesNotTriplets,
      MeshValidationSeverity.Error,
      'Index buffer length is not a multiple of 3.',
      { length: mesh.indices.length },
    );
  }

  if (vertices === 0) {
    report(
      MeshValidationCode.EmptyMesh,
      MeshValidationSeverity.Error,
      'Mesh contains no vertices.',
    );
  }

  if (triangles === 0) {
    report(
      MeshValidationCode.NoTriangles,
      MeshValidationSeverity.Error,
      'Mesh contains no triangles.',
    );
  }

  // Iterating (rather than indexing) yields `number` directly and avoids
  // per-element bounds-check overhead on large buffers.
  let nonFinitePositions = 0;
  for (const value of mesh.positions) {
    if (!Number.isFinite(value)) nonFinitePositions += 1;
  }
  if (nonFinitePositions > 0) {
    report(
      MeshValidationCode.NonFinitePosition,
      MeshValidationSeverity.Error,
      'Mesh contains NaN or infinite coordinate values.',
      { count: nonFinitePositions },
    );
  }

  let outOfRange = 0;
  let degenerate = 0;
  let cornerA = 0;
  let cornerB = 0;
  let corner = 0;
  for (const index of mesh.indices) {
    if (index >= vertices) outOfRange += 1;

    if (corner === 0) {
      cornerA = index;
    } else if (corner === 1) {
      cornerB = index;
    } else if (index === cornerA || index === cornerB || cornerA === cornerB) {
      degenerate += 1;
    }
    corner = corner === 2 ? 0 : corner + 1;
  }

  if (outOfRange > 0) {
    report(
      MeshValidationCode.IndexOutOfRange,
      MeshValidationSeverity.Error,
      'Mesh references vertex indices outside the position buffer.',
      { count: outOfRange, vertexCount: vertices },
    );
  }

  if (degenerate > 0) {
    // A degenerate triangle is malformed but recoverable, and is exactly the
    // kind of defect the future repair workflow exists to fix. Reporting it as
    // an error here would make repair inputs unloadable.
    report(
      MeshValidationCode.DegenerateTriangle,
      MeshValidationSeverity.Warning,
      'Mesh contains triangles with repeated vertex indices.',
      { count: degenerate },
    );
  }

  if (mesh.normals !== undefined && mesh.normals.length !== mesh.positions.length) {
    report(
      MeshValidationCode.NormalLengthMismatch,
      MeshValidationSeverity.Error,
      'Normal buffer length does not match the position buffer.',
      { normalLength: mesh.normals.length, positionLength: mesh.positions.length },
    );
  }

  if (mesh.uvs !== undefined && mesh.uvs.length !== vertices * 2) {
    report(
      MeshValidationCode.UvLengthMismatch,
      MeshValidationSeverity.Error,
      'UV buffer length does not match the vertex count.',
      { uvLength: mesh.uvs.length, expected: vertices * 2 },
    );
  }

  let groupIndex = 0;
  for (const group of mesh.groups ?? []) {
    const invalid =
      group.indexOffset < 0 ||
      group.indexCount < 0 ||
      group.indexOffset % 3 !== 0 ||
      group.indexCount % 3 !== 0 ||
      group.indexOffset + group.indexCount > mesh.indices.length;
    if (invalid) {
      // Reported by INDEX, never by name. A group name comes verbatim from the
      // file — an ASCII STL `solid` line routinely holds a filesystem path or a
      // project name — and `details` is the field that would be transmitted if
      // telemetry were ever introduced. The index locates the group just as
      // well without quoting the user's data.
      report(
        MeshValidationCode.GroupRangeInvalid,
        MeshValidationSeverity.Error,
        `Group ${String(groupIndex)} describes a range outside the index buffer.`,
        {
          groupIndex,
          indexOffset: group.indexOffset,
          indexCount: group.indexCount,
          indexBufferLength: mesh.indices.length,
        },
      );
    }
    groupIndex += 1;
  }

  return {
    valid: !issues.some((issue) => issue.severity === MeshValidationSeverity.Error),
    issues,
    truncated,
    vertexCount: vertices,
    triangleCount: triangles,
  };
}

/**
 * Validation gate for geometry operation output.
 *
 * Call this on the RESULT of every geometry operation. Returning a mesh is not
 * success; passing validation is. Throws `GEOMETRY_VALIDATION_FAILED` on any
 * error-severity issue.
 */
export function assertMeshStructure(
  mesh: CanonicalMesh,
  context: string,
  options?: MeshValidationOptions,
): MeshValidationReport {
  const report = validateMeshStructure(mesh, options);
  if (!report.valid) {
    const failed = report.issues.filter((issue) => issue.severity === MeshValidationSeverity.Error);
    throw geometryValidationFailed(`${context} produced a structurally invalid mesh.`, {
      context,
      errorCount: failed.length,
      codes: failed.map((issue) => issue.code).join(','),
    });
  }
  return report;
}
