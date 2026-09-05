import {
  invalidState,
  resourceLimitExceeded,
  type AppError,
  type ErrorDetails,
} from '@cadfixer/shared';
import { internalRefusal } from '../import-errors';

/**
 * WHY EXPORT HAS ITS OWN TAXONOMY.
 *
 * An import refusal is a statement about the user's FILE. An export refusal is
 * a statement about the user's DOCUMENT, or about CAD Fixer. Reusing
 * `ImportRefusal` would let "your file is malformed" be shown to someone who
 * supplied no file, which is the sort of misattribution the import taxonomy was
 * itself built to avoid.
 */
export const ExportRefusal = {
  /* --------------------------------------------------------- the request -- */
  UnsupportedTarget: 'EXPORT_UNSUPPORTED_TARGET',
  MalformedSnapshot: 'EXPORT_MALFORMED_SNAPSHOT',
  MissingMeshResource: 'EXPORT_MISSING_MESH_RESOURCE',
  DuplicatePartId: 'EXPORT_DUPLICATE_PART_ID',
  NonFiniteTransform: 'EXPORT_NON_FINITE_TRANSFORM',
  NoParts: 'EXPORT_NO_PARTS',

  /* ------------------------------------------------------------ the unit -- */
  /**
   * 3MF states a unit for everything it contains, and the document states none.
   *
   * NOT defaulted to millimetres. A 3MF that omits the attribute is claiming
   * millimetres, because the specification says an absent attribute means that
   * — but a document derived from an STL or an OBJ has no such assertion behind
   * it, and writing one would be CAD Fixer inventing a physical fact about the
   * user's model. The block is lifted by the user choosing a unit, which is
   * Stage 4A-2B3's work.
   */
  UnitRequired: 'EXPORT_UNIT_REQUIRED',

  /* -------------------------------------------------------- the resources -- */
  OutputTooLarge: 'EXPORT_OUTPUT_TOO_LARGE',
  SerialisedTooLarge: 'EXPORT_SERIALISED_TOO_LARGE',

  /* ------------------------------------------------------- the validation -- */
  /** The bytes did not read back as the document they were written from. */
  ValidationFailed: 'EXPORT_VALIDATION_FAILED',
  /** The written bytes could not be read back at all. */
  ValidationUnreadable: 'EXPORT_VALIDATION_UNREADABLE',
} as const;

export type ExportRefusal = (typeof ExportRefusal)[keyof typeof ExportRefusal];

/** Detail key every export refusal carries. Tests assert on this, not on prose. */
export const EXPORT_REASON_KEY = 'exportReason';

function withReason(reason: ExportRefusal, details: ErrorDetails | undefined): ErrorDetails {
  return { ...details, [EXPORT_REASON_KEY]: reason };
}

/**
 * The document, as it stands, cannot be written to this target.
 *
 * `InvalidState` rather than a file error: nothing is malformed and nothing is
 * too large — the document is simply not in a state this format can express,
 * and the fix is a decision rather than a different file.
 */
export function exportBlocked(
  reason: ExportRefusal,
  message: string,
  details?: ErrorDetails,
): AppError {
  return invalidState(message, withReason(reason, details));
}

/** The export would exceed a production ceiling. Refused before it is built. */
export function exportTooLarge(
  reason: ExportRefusal,
  message: string,
  details?: ErrorDetails,
): AppError {
  return resourceLimitExceeded(message, withReason(reason, details));
}

/**
 * CAD Fixer wrote bytes it cannot read back, or was asked for something
 * impossible by its own code.
 *
 * A validation failure is OURS, never the user's. Telling someone their model
 * is at fault because our writer and our reader disagree would be a lie with
 * their name on it.
 */
export function exportInternal(
  reason: ExportRefusal,
  message: string,
  details?: ErrorDetails,
): AppError {
  return internalRefusal(message, withReason(reason, details));
}

export function exportRefusalOf(error: { readonly details: ErrorDetails }): string | undefined {
  const value = error.details[EXPORT_REASON_KEY];
  return typeof value === 'string' ? value : undefined;
}
