export { IDENTITY_MATRIX4, meshTransferables, triangleCount, vertexCount } from './mesh';
export type {
  CanonicalMesh,
  IndexArray,
  Matrix4Tuple,
  MeshGroup,
  MeshMetadata,
  NormalArray,
  PositionArray,
  SourceFormatId,
  UvArray,
} from './mesh';

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
