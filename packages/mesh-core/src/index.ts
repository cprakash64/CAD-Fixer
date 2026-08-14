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
