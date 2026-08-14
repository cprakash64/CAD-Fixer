import type { ErrorDetails } from './errors';

/**
 * A non-fatal finding produced by an operation that nevertheless succeeded.
 *
 * The distinction from `AppError` is deliberate: an `AppError` means the
 * operation did not produce a usable result, while a `Diagnostic` means it did,
 * but something about the input or output is worth telling the user.
 *
 * STL import uses these for things like "the file's stored facet normals are
 * unusable" — which is true of a great many real STL files and must not stop the
 * import, but must not be hidden either.
 *
 * PRIVACY: like `AppError`, `details` is restricted to primitives so geometry or
 * file contents cannot be attached.
 */
export interface Diagnostic {
  /** Stable machine-readable code. */
  readonly code: string;
  /** Human-readable and safe to display. Never contains file contents. */
  readonly message: string;
  readonly details?: ErrorDetails;
}

export function diagnostic(code: string, message: string, details?: ErrorDetails): Diagnostic {
  return details === undefined ? { code, message } : { code, message, details };
}
