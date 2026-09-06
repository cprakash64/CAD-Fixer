export {
  analyseTopology,
  assertAnalysable,
  DEFAULT_SAMPLE_LIMIT,
  estimateDetailBytes,
  estimateTopologyWorkspaceBytes,
} from './analyze';
export type { TopologyAnalysisOptions, TopologyProgress } from './analyze';

export { peakOf, stage } from './memory';
export type { StageMemory } from './memory';

export {
  buildTopologicalGeometry,
  exactStoredCoordinateIdentity,
  estimateVertexIdentityBytes,
  recoverVertexIdentity,
  tableCapacityFor,
} from './identity';
export type { CoordinateIdentity, TopologicalGeometry, VertexIdentityResult } from './identity';

export { buildDirectedEdges, groupEdges } from './edges';
export type { DirectedEdges, EdgeGroups } from './edges';

export {
  analyseEdges,
  analyseVertexManifoldness,
  buildVertexIncidence,
  EdgeClass,
} from './manifold';
export type { EdgeAnalysis, VertexIncidence, VertexManifoldAnalysis } from './manifold';

export { analyseBoundary, analyseComponents, BoundaryKind } from './components';
export type { BoundaryAnalysis, BoundaryComponent, ComponentAnalysis } from './components';

export { analyseDegeneracy, analyseDuplicates } from './faces';
export type { DegeneracyAnalysis, DuplicateAnalysis } from './faces';

export {
  CompensatedSum,
  computeArea,
  computeSignedVolume,
  eulerCharacteristic,
  VolumeStatus,
} from './metrics';

export { PrintabilityStatus, SelfIntersectionStatus, TOPOLOGY_REPORT_VERSION } from './report';
export type {
  BoundaryComponentSummary,
  ComponentSummary,
  TopologyDetail,
  TopologyReport,
  TopologyResult,
} from './report';

export {
  BoundaryLoopRefusal,
  boundaryLoopIdentity,
  estimateBoundaryLoopBytes,
  extractBoundaryLoops,
  findBoundaryLoop,
} from './boundary-loops';
export type {
  BoundaryLoop,
  BoundaryLoopId,
  BoundaryLoopOptions,
  BoundaryLoopSet,
} from './boundary-loops';
