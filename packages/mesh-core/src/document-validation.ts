import { geometryValidationFailed, isLengthUnit, type ErrorDetails } from '@cadfixer/shared';
import { meshByteLength } from './mesh';
import {
  DEFAULT_DOCUMENT_LIMITS,
  documentTriangleCount,
  documentVertexCount,
  distinctMeshes,
  type DocumentLimits,
  type GeometryDocument,
} from './document';
import { MeshValidationSeverity, validateMeshStructure } from './validation';

/**
 * STRUCTURAL validation of a geometry document, run before it becomes
 * authoritative.
 *
 * WHAT THIS IS FOR. `validateMeshStructure` answers "is this mesh well
 * formed?". It cannot answer "do two parts claim the same id?", "is this
 * transform finite?", or "does this document fit in the memory a session is
 * allowed to hold?" — questions that only exist once geometry has structure
 * around it. A candidate document that fails any of them must not partially
 * replace the current one; it must not replace it at all.
 *
 * WHAT THIS IS NOT. Not mesh health. A part whose triangles are degenerate is a
 * VALID document describing a defective model, and refusing it would leave the
 * product unable to load the very files it exists to repair. The line is the
 * same one the 3MF research drew: structural validity is not printability.
 */

export const DocumentValidationCode = {
  NoParts: 'DOCUMENT_NO_PARTS',
  DuplicatePartId: 'DOCUMENT_DUPLICATE_PART_ID',
  EmptyPartId: 'DOCUMENT_EMPTY_PART_ID',
  InvalidTransform: 'DOCUMENT_INVALID_TRANSFORM',
  InvalidUnit: 'DOCUMENT_INVALID_UNIT',
  InvalidPartMesh: 'DOCUMENT_INVALID_PART_MESH',
  NameTooLong: 'DOCUMENT_NAME_TOO_LONG',
  MaterialRefTooLong: 'DOCUMENT_MATERIAL_REF_TOO_LONG',
  TooManyParts: 'DOCUMENT_TOO_MANY_PARTS',
  TooManyTriangles: 'DOCUMENT_TOO_MANY_TRIANGLES',
  TooManyVertices: 'DOCUMENT_TOO_MANY_VERTICES',
  TooManyBytes: 'DOCUMENT_TOO_MANY_BYTES',
} as const;

export type DocumentValidationCode =
  (typeof DocumentValidationCode)[keyof typeof DocumentValidationCode];

export interface DocumentValidationIssue {
  readonly code: DocumentValidationCode;
  readonly message: string;
  /** Counts, indices and identifiers only — never coordinates. */
  readonly details?: ErrorDetails;
}

export interface DocumentValidationReport {
  readonly valid: boolean;
  readonly issues: readonly DocumentValidationIssue[];
  readonly partCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  /**
   * Bytes of DISTINCT geometry.
   *
   * Counted once per mesh object, not once per part, because that is what the
   * document actually holds: a thousand placements of one component cost one
   * mesh. Counting per part would refuse documents that fit comfortably.
   */
  readonly geometryBytes: number;
}

export interface DocumentValidationOptions {
  readonly limits?: DocumentLimits;
  /**
   * Whether to run full structural validation on each part's mesh.
   *
   * Defaults to true. Disabled only where the caller has already validated
   * every mesh in this document and would otherwise walk every coordinate a
   * second time — the repair commit path, where the candidate mesh went through
   * `assertMeshStructure` moments earlier and the other parts are the SAME
   * OBJECTS that were validated when they were committed.
   */
  readonly validateMeshes?: boolean;
}

/**
 * A transform is 12 finite numbers. Nothing else is a placement.
 *
 * Takes `readonly number[]` rather than `PartTransform` ON PURPOSE. A document
 * reaching validation may have been built from a wire payload whose shape was
 * asserted rather than proved, and a check whose parameter type already
 * guarantees the answer is not a check.
 */
export function isValidPartTransform(transform: readonly number[]): boolean {
  if (transform.length !== 12) return false;
  for (const value of transform) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

export function validateGeometryDocument(
  document: GeometryDocument,
  options: DocumentValidationOptions = {},
): DocumentValidationReport {
  const limits = options.limits ?? DEFAULT_DOCUMENT_LIMITS;
  const validateMeshes = options.validateMeshes ?? true;
  const issues: DocumentValidationIssue[] = [];

  const partCount = document.parts.length;

  if (partCount === 0) {
    issues.push({
      code: DocumentValidationCode.NoParts,
      message: 'This document contains no parts.',
    });
  }

  if (partCount > limits.maxParts) {
    issues.push({
      code: DocumentValidationCode.TooManyParts,
      message: 'This document declares more parts than CAD Fixer will hold.',
      details: { partCount, limit: limits.maxParts },
    });
  }

  if (document.unit !== undefined && !isLengthUnit(document.unit)) {
    issues.push({
      code: DocumentValidationCode.InvalidUnit,
      message: 'This document states a unit CAD Fixer does not recognise.',
      details: { unit: String(document.unit) },
    });
  }

  const seen = new Set<string>();
  for (let index = 0; index < document.parts.length; index += 1) {
    const part = document.parts[index];
    if (part === undefined) continue;

    if (part.id.length === 0) {
      issues.push({
        code: DocumentValidationCode.EmptyPartId,
        message: 'A part in this document has no identifier.',
        details: { partIndex: index },
      });
    } else if (seen.has(part.id)) {
      issues.push({
        code: DocumentValidationCode.DuplicatePartId,
        message: 'Two parts in this document claim the same identifier.',
        details: { partIndex: index, partId: part.id },
      });
    } else {
      seen.add(part.id);
    }

    if (!isValidPartTransform(part.transform)) {
      issues.push({
        code: DocumentValidationCode.InvalidTransform,
        message: 'A part in this document has an unusable placement transform.',
        details: { partIndex: index, partId: part.id, values: part.transform.length },
      });
    }

    if (part.name !== undefined && part.name.length > limits.maxNameLength) {
      issues.push({
        code: DocumentValidationCode.NameTooLong,
        message: 'A part name in this document is longer than CAD Fixer will keep.',
        details: { partIndex: index, length: part.name.length, limit: limits.maxNameLength },
      });
    }

    if (part.materialRef !== undefined && part.materialRef.length > limits.maxMaterialRefLength) {
      issues.push({
        code: DocumentValidationCode.MaterialRefTooLong,
        message: 'A material reference in this document is longer than CAD Fixer will keep.',
        details: {
          partIndex: index,
          length: part.materialRef.length,
          limit: limits.maxMaterialRefLength,
        },
      });
    }
  }

  if (validateMeshes) {
    // Per DISTINCT mesh: validating a shared mesh once per placement would make
    // a 1,000-placement document 1,000 times more expensive to admit than the
    // one it actually is.
    let meshIndex = 0;
    for (const mesh of distinctMeshes(document)) {
      const report = validateMeshStructure(mesh);
      if (!report.valid) {
        issues.push({
          code: DocumentValidationCode.InvalidPartMesh,
          message: 'A part in this document does not contain a well-formed mesh.',
          details: {
            meshIndex,
            codes: report.issues
              .filter((issue) => issue.severity === MeshValidationSeverity.Error)
              .map((issue) => issue.code)
              .join(','),
          },
        });
      }
      meshIndex += 1;
    }
  }

  const triangles = documentTriangleCount(document);
  const vertices = documentVertexCount(document);
  let geometryBytes = 0;
  for (const mesh of distinctMeshes(document)) geometryBytes += meshByteLength(mesh);

  if (triangles > limits.maxTotalTriangles) {
    issues.push({
      code: DocumentValidationCode.TooManyTriangles,
      message: 'This document contains more triangles than CAD Fixer will hold.',
      details: { triangleCount: triangles, limit: limits.maxTotalTriangles },
    });
  }
  if (vertices > limits.maxTotalVertices) {
    issues.push({
      code: DocumentValidationCode.TooManyVertices,
      message: 'This document contains more vertices than CAD Fixer will hold.',
      details: { vertexCount: vertices, limit: limits.maxTotalVertices },
    });
  }
  if (geometryBytes > limits.maxTotalGeometryBytes) {
    issues.push({
      code: DocumentValidationCode.TooManyBytes,
      message: 'This document contains more geometry than CAD Fixer will hold in one session.',
      details: { geometryBytes, limit: limits.maxTotalGeometryBytes },
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    partCount,
    triangleCount: triangles,
    vertexCount: vertices,
    geometryBytes,
  };
}

/**
 * The GATE. Throws unless the document may become authoritative.
 *
 * Mirrors `assertMeshStructure`: producing a document is not success, passing
 * this is.
 */
export function assertGeometryDocument(
  document: GeometryDocument,
  operation: string,
  options: DocumentValidationOptions = {},
): void {
  const report = validateGeometryDocument(document, options);
  if (report.valid) return;

  const codes = [...new Set(report.issues.map((issue) => issue.code))];
  throw geometryValidationFailed(`${operation} produced a document CAD Fixer cannot accept.`, {
    operation,
    partCount: report.partCount,
    triangleCount: report.triangleCount,
    issueCount: report.issues.length,
    codes: codes.join(','),
  });
}
