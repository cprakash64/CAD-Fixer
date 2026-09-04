export {
  createIndexArray,
  createPositionArray,
  meshByteLength,
  meshTransferables,
  triangleCount,
  vertexCount,
} from './mesh';
export type {
  CanonicalMesh,
  IndexArray,
  MeshGroup,
  MeshMetadata,
  NormalArray,
  PositionArray,
  SourceFormatId,
  UvArray,
} from './mesh';

export {
  applyPartTransform,
  composePartTransforms,
  DEFAULT_DOCUMENT_LIMITS,
  distinctMeshes,
  documentTriangleCount,
  documentVertexCount,
  findPart,
  IDENTITY_PART_TRANSFORM,
  partId,
  partIndexOf,
  singlePartDocument,
  transformBounds,
  unionBounds,
  withPartMesh,
  withPartTransform,
} from './document';
export type {
  DocumentLimits,
  GeometryDocument,
  GeometryPart,
  PartId,
  PartTransform,
  SinglePartDocumentOptions,
} from './document';

export {
  assertGeometryDocument,
  DocumentValidationCode,
  isValidPartTransform,
  validateGeometryDocument,
} from './document-validation';
export type {
  DocumentValidationIssue,
  DocumentValidationOptions,
  DocumentValidationReport,
} from './document-validation';

export { computeBounds, computeVertexNormals, triangleNormal } from './analysis';
export type { MeshBounds, Vector3Tuple } from './analysis';

export {
  assertMeshStructure,
  MeshValidationCode,
  MeshValidationSeverity,
  validateMeshStructure,
} from './validation';
export type {
  MeshValidationIssue,
  MeshValidationOptions,
  MeshValidationReport,
} from './validation';
