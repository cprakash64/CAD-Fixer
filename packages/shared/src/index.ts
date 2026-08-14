export {
  AppError,
  AppErrorCode,
  deserializeAppError,
  geometryValidationFailed,
  internalError,
  isAppError,
  isSerializedAppError,
  malformedFile,
  operationCancelled,
  resourceLimitExceeded,
  toAppError,
  unsupportedFile,
} from './errors';
export type { AppErrorOptions, ErrorDetails, ErrorDetailValue, SerializedAppError } from './errors';

export { CancellationSource, uncancellable } from './cancellation';
export type { CancellationToken } from './cancellation';

export { createOperationId, resetOperationIdSequenceForTesting } from './ids';
export type { OperationId } from './ids';

export { isLengthUnit, LengthUnit, millimetresPerUnit, unitConversionFactor } from './units';

export { assertNever } from './assert';
