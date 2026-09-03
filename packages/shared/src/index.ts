export {
  AppError,
  AppErrorCode,
  deserializeAppError,
  geometryValidationFailed,
  internalError,
  isAppError,
  isSerializedAppError,
  malformedFile,
  invalidState,
  modelUnavailable,
  operationCancelled,
  resourceLimitExceeded,
  toAppError,
  unsupportedFile,
} from './errors';
export type { AppErrorOptions, ErrorDetails, ErrorDetailValue, SerializedAppError } from './errors';

export { diagnostic } from './diagnostics';
export type { Diagnostic } from './diagnostics';

export {
  adoptSharedCancellation,
  CANCEL_SIGNAL_INDEX,
  CancellationSource,
  CancelState,
  combineCancellation,
  isSharedCancellationSupported,
  SHARED_CANCELLATION_BYTES,
  SharedCancellationSource,
  throwIfCancelled,
  uncancellable,
} from './cancellation';
export type { CancellationToken } from './cancellation';

export { createOperationId, resetOperationIdSequenceForTesting } from './ids';
export type { OperationId } from './ids';

export { isLengthUnit, LengthUnit, millimetresPerUnit, unitConversionFactor } from './units';

export { assertNever } from './assert';
