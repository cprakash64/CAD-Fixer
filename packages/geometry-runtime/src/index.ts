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
  RepairCandidatePayload,
  RepairCandidateResult,
  RepairCommitPayload,
  RepairCommitResult,
  RepairDiscardPayload,
  RepairDiscardResult,
  RepairPlanOperationResult,
  RepairPlanPayload,
  RepairUndoPayload,
  RepairUndoResult,
  SelfTestPayload,
  SelfTestResult,
  StlExportResult,
  StlImportPayload,
  TransferHandle,
} from './protocol';

/**
 * Repair contract values, RESTATED rather than re-exported from the engine, so
 * the main-thread bundle never gains a runtime edge to `@cadfixer/mesh-repair`.
 * See `repair.ts` for why, and for the compile-time check that keeps them equal.
 */
export {
  BoundsComparison,
  RepairAcceptance,
  RepairDecision,
  RepairOperation,
  RepairReason,
  RepairRegression,
  REPAIR_PIPELINE_ORDER,
  VolumeComparison,
} from './repair';

/**
 * The repair result SHAPES. Type-only, so the application can name a plan, a
 * validation or a change count without importing the engine that produced it.
 */
export type {
  ConservativeRepairPlan,
  RepairChangeCounts,
  RepairChangeSamples,
  RepairDefectDeltas,
  RepairMemoryEstimate,
  RepairOperationDecision,
  RepairValidation,
} from '@cadfixer/mesh-repair';

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
  requestRepairPeak,
  residentBytesFor,
} from './memory-budget';
export type { MemoryEstimate, SessionMemoryBudget } from './memory-budget';

/**
 * Re-exported so the application can name a bounding box without importing the
 * mesh package. `MeshBounds` is a plain record of numbers — no geometry code
 * travels with a type-only export.
 */
export type { MeshBounds } from '@cadfixer/mesh-core';

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

export { CandidateState, RepairCandidateStore } from './repair-candidates';
export type {
  CandidateStats,
  CommitRequest,
  RepairCandidateHandle,
  RepairCandidateId,
} from './repair-candidates';

export { TopologyReportCache } from './topology-cache';

export { RepairHistoryStore } from './repair-history';
export type {
  RepairHistoryEntry,
  RepairHistoryStats,
  RepairUndoPreparation,
} from './repair-history';
