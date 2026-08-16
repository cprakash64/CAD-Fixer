/**
 * Typed application error foundation.
 *
 * Every failure that crosses a layer boundary (worker <-> main thread, format
 * layer -> UI) must be expressed as an `AppError` so that callers can branch on
 * a stable `code` rather than parsing message strings.
 *
 * PRIVACY CONSTRAINT: error `message` and `details` must never contain raw
 * geometry, file contents, or full filesystem paths. See
 * docs/PRIVACY_ARCHITECTURE.md. Details are restricted to primitive values so
 * that a buffer or mesh cannot be attached by accident.
 */

/**
 * Stable, exhaustive set of failure categories.
 *
 * Declared as a const object rather than a TypeScript `enum` because the
 * compiler baseline enables `erasableSyntaxOnly`.
 */
export const AppErrorCode = {
  /** The input is a format CAD Fixer does not support. */
  UnsupportedFile: 'UNSUPPORTED_FILE',
  /** The input claims a supported format but could not be interpreted. */
  MalformedFile: 'MALFORMED_FILE',
  /** A declared budget (memory, element count, time) would be exceeded. */
  ResourceLimitExceeded: 'RESOURCE_LIMIT_EXCEEDED',
  /** A geometry operation produced output that failed validation. */
  GeometryValidationFailed: 'GEOMETRY_VALIDATION_FAILED',
  /** The caller cancelled the operation. Not a defect. */
  OperationCancelled: 'OPERATION_CANCELLED',
  /**
   * The named model is not available: released, replaced by a newer revision,
   * or lost because the geometry worker died.
   *
   * NOT an internal error. It is the expected outcome when an operation is
   * queued against a model the user has since replaced, and the interface has
   * to tell those two situations apart — "re-import your file" is useful advice,
   * "CAD Fixer has a bug" is not.
   */
  ModelUnavailable: 'MODEL_UNAVAILABLE',
  /** A defect in CAD Fixer itself. */
  Internal: 'INTERNAL_ERROR',
} as const;

export type AppErrorCode = (typeof AppErrorCode)[keyof typeof AppErrorCode];

/**
 * Values permitted in `AppError.details`. Deliberately narrow: this type is the
 * mechanism that prevents geometry buffers from being attached to an error and
 * then surfaced in a log or, later, a crash report.
 */
export type ErrorDetailValue = string | number | boolean | null;

export type ErrorDetails = Readonly<Record<string, ErrorDetailValue>>;

export interface AppErrorOptions {
  /** Structured, non-sensitive context for diagnostics and UI copy. */
  readonly details?: ErrorDetails;
  /** Underlying error, retained for developer-facing diagnostics only. */
  readonly cause?: unknown;
}

/** The wire form of an `AppError`, safe to pass through `postMessage`. */
export interface SerializedAppError {
  readonly name: 'AppError';
  readonly code: AppErrorCode;
  readonly message: string;
  /**
   * Optional on the wire even though `toSerializable` always emits it: the
   * receiving side may be handed a message from an older or foreign sender, and
   * a missing field should degrade to "no details" rather than crash.
   */
  readonly details?: ErrorDetails;
  /** Present only when the original error carried one. Never includes user data. */
  readonly causeMessage?: string;
}

export class AppError extends Error {
  public override readonly name = 'AppError';
  public readonly code: AppErrorCode;
  public readonly details: ErrorDetails;

  public constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details ?? {};
  }

  public toSerializable(): SerializedAppError {
    const causeMessage = extractCauseMessage(this.cause);
    return causeMessage === undefined
      ? { name: 'AppError', code: this.code, message: this.message, details: this.details }
      : {
          name: 'AppError',
          code: this.code,
          message: this.message,
          details: this.details,
          causeMessage,
        };
  }
}

function extractCauseMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return undefined;
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function isSerializedAppError(value: unknown): value is SerializedAppError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SerializedAppError>;
  return (
    candidate.name === 'AppError' &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string'
  );
}

/** Rebuilds an `AppError` on the receiving side of a `postMessage` boundary. */
export function deserializeAppError(serialized: SerializedAppError): AppError {
  return new AppError(serialized.code, serialized.message, {
    details: serialized.details ?? {},
    ...(serialized.causeMessage === undefined ? {} : { cause: serialized.causeMessage }),
  });
}

/**
 * Normalizes an unknown thrown value into an `AppError`.
 *
 * This is intentionally the ONLY place that converts arbitrary throws. It never
 * swallows the failure: unrecognised values become `INTERNAL_ERROR` and retain
 * the original as `cause`.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (isSerializedAppError(value)) return deserializeAppError(value);
  const message = value instanceof Error ? value.message : 'An unexpected internal error occurred.';
  return new AppError(AppErrorCode.Internal, message, { cause: value });
}

export function unsupportedFile(message: string, details?: ErrorDetails): AppError {
  return new AppError(AppErrorCode.UnsupportedFile, message, details ? { details } : {});
}

export function malformedFile(message: string, details?: ErrorDetails): AppError {
  return new AppError(AppErrorCode.MalformedFile, message, details ? { details } : {});
}

export function resourceLimitExceeded(message: string, details?: ErrorDetails): AppError {
  return new AppError(AppErrorCode.ResourceLimitExceeded, message, details ? { details } : {});
}

export function geometryValidationFailed(message: string, details?: ErrorDetails): AppError {
  return new AppError(AppErrorCode.GeometryValidationFailed, message, details ? { details } : {});
}

export function operationCancelled(message = 'Operation cancelled.'): AppError {
  return new AppError(AppErrorCode.OperationCancelled, message);
}

export function modelUnavailable(message: string, details?: ErrorDetails): AppError {
  return new AppError(AppErrorCode.ModelUnavailable, message, details ? { details } : {});
}

export function internalError(message: string, options?: AppErrorOptions): AppError {
  return new AppError(AppErrorCode.Internal, message, options ?? {});
}
