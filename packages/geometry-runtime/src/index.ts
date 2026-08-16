export { isClientBoundMessage, isHostBoundMessage, PROTOCOL_CHANNEL } from './protocol';
export type {
  CancelMessage,
  ClientBoundMessage,
  ErrorMessage,
  HostBoundMessage,
  OperationMap,
  OperationName,
  OperationPayload,
  OperationResult,
  ProgressMessage,
  ProtocolMessage,
  RequestMessage,
  ResultMessage,
  MeshValidationSummary,
  ModelAnalyzePayload,
  ModelAnalyzeResult,
  ModelExportPayload,
  ModelImportResult,
  ModelReleasePayload,
  ModelReleaseResult,
  RenderSnapshot,
  SelfTestPayload,
  SelfTestResult,
  StlExportResult,
  StlImportPayload,
  TransferHandle,
} from './protocol';

/**
 * Re-exported so the application layer can name what `model/analyze` returns
 * without depending on `mesh-topology` directly. The application consumes the
 * report; it must never reach for the engine that produced it.
 */
export type {
  BoundaryComponentSummary,
  ComponentSummary,
  TopologyDetail,
  TopologyReport,
} from '@cadfixer/mesh-topology';
export { BoundaryKind, PrintabilityStatus, SelfIntersectionStatus, VolumeStatus } from './topology';

export {
  checkExportPeak,
  checkImportPeak,
  checkResident,
  DEFAULT_SESSION_MEMORY_BUDGET,
  estimateExportPeak,
  estimateImportPeak,
  renderBytesFor,
  requestAnalysisWorkspace,
  residentBytesFor,
} from './memory-budget';
export type { MemoryEstimate, SessionMemoryBudget } from './memory-budget';

export { meshByteLength, ResidentModelStore } from './resident-models';
export type { ModelHandle, ModelId, ResidentModelStats } from './resident-models';

export type { MessageEndpoint } from './endpoint';

export { GeometryCoordinator } from './coordinator';
export type {
  DiagnosticSink,
  DispatchOptions,
  GeometryCoordinatorOptions,
  OperationHandle,
  ProgressUpdate,
} from './coordinator';

export { GeometryWorkerHost } from './worker-host';
export type { HandlerOutcome, OperationContext, OperationHandler } from './worker-host';

export { createSelfTestHandler } from './self-test';
export type { SelfTestHandlerOptions } from './self-test';

export { createLinkedEndpoints } from './linked-endpoints';

export { toTransferables } from './transferables';
