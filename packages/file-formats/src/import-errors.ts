import {
  internalError,
  malformedFile,
  operationCancelled,
  resourceLimitExceeded,
  unsupportedFile,
  type AppError,
  type ErrorDetails,
} from '@cadfixer/shared';

/**
 * THE PRECISE CAUSE OF AN IMPORT REFUSAL.
 *
 * `AppErrorCode` is deliberately coarse — four or five categories the interface
 * branches on to decide what to SAY. That is the right granularity for a
 * message and the wrong one for everything else: "malformed file" cannot tell a
 * zip bomb from an out-of-range triangle index, so a log cannot either, and
 * neither can a test. Collapsing every refusal into one code is how a parser
 * stops being debuggable.
 *
 * So the category stays on the error and the REASON travels in its details.
 * Every refusal below names exactly what the file did, and a test can assert on
 * it without depending on message wording.
 *
 * The names come from the Stage 4A research refusal sets, which are the ones the
 * hostile corpora were qualified against — see `experiments/format-io/`.
 */
export const ImportRefusal = {
  /* -------------------------------------------------------- identification -- */
  /** The bytes do not match any format CAD Fixer reads. */
  UnknownFormat: 'UNKNOWN_FORMAT',
  /** The name says one format and the content is unmistakably another. */
  ContentExtensionMismatch: 'CONTENT_EXTENSION_MISMATCH',

  /* ------------------------------------------------------------------- obj -- */
  /** A face with other than three corners. Never triangulated — see ADR 0013. */
  ObjPolygonUnsupported: 'OBJ_POLYGON_UNSUPPORTED',
  ObjTooFewFaceVertices: 'OBJ_TOO_FEW_FACE_VERTICES',
  ObjZeroIndex: 'OBJ_ZERO_INDEX',
  /**
   * A face corner that names a texture or a normal but no POSITION.
   *
   * Its own reason rather than `ObjZeroIndex`, which is what `Number('')` made
   * it look like: a file that omits the position index and a file that writes
   * `0` are two different mistakes and deserve two different sentences.
   */
  ObjMissingPositionIndex: 'OBJ_MISSING_POSITION_INDEX',
  ObjBadIndex: 'OBJ_BAD_INDEX',
  ObjNonFinite: 'OBJ_NON_FINITE_COORDINATE',
  ObjMalformedNumber: 'OBJ_MALFORMED_NUMBER',
  ObjLineTooLong: 'OBJ_LINE_TOO_LONG',
  ObjTooManyVertices: 'OBJ_TOO_MANY_VERTICES',
  ObjTooManyFaces: 'OBJ_TOO_MANY_FACES',
  ObjTooManyObjects: 'OBJ_TOO_MANY_OBJECTS',
  ObjTooManyGroups: 'OBJ_TOO_MANY_GROUPS',
  ObjNoGeometry: 'OBJ_NO_GEOMETRY',

  /* ------------------------------------------------------------------- zip -- */
  ZipNotAnArchive: 'ZIP_NOT_AN_ARCHIVE',
  ZipNoCentralDirectory: 'ZIP_NO_CENTRAL_DIRECTORY',
  ZipMalformed: 'ZIP_MALFORMED_ARCHIVE',
  ZipTooManyEntries: 'ZIP_TOO_MANY_ENTRIES',
  ZipEntryTooLarge: 'ZIP_ENTRY_TOO_LARGE',
  ZipArchiveTooLarge: 'ZIP_ARCHIVE_TOO_LARGE',
  ZipRatioExceeded: 'ZIP_COMPRESSION_RATIO_EXCEEDED',
  /**
   * The archive's entries, TOGETHER, expand past the total budget.
   *
   * Distinct from `ZipArchiveTooLarge`, which is about the size of the file on
   * disk. This one is about what comes out of it, and it is the only refusal
   * that no single entry can trigger on its own.
   */
  ZipTotalTooLarge: 'ZIP_TOTAL_UNCOMPRESSED_TOO_LARGE',
  ZipEncrypted: 'ZIP_ENCRYPTED_ENTRY',
  ZipUnsupportedMethod: 'ZIP_UNSUPPORTED_COMPRESSION_METHOD',
  ZipUnsafePath: 'ZIP_UNSAFE_PATH',
  ZipDuplicatePath: 'ZIP_DUPLICATE_PATH',

  /* ------------------------------------------------------------------- xml -- */
  XmlDoctypeRefused: 'XML_DOCTYPE_REFUSED',
  XmlEntityRefused: 'XML_ENTITY_REFUSED',
  XmlExternalIdRefused: 'XML_EXTERNAL_IDENTIFIER_REFUSED',
  XmlMalformed: 'XML_MALFORMED',
  XmlTooDeep: 'XML_TOO_DEEP',
  XmlTooManyElements: 'XML_TOO_MANY_ELEMENTS',
  XmlAttributeTooLong: 'XML_ATTRIBUTE_TOO_LONG',

  /* ------------------------------------------------------------------- 3mf -- */
  ThreeMfNoModelPart: 'THREEMF_NO_MODEL_PART',
  ThreeMfUnsupportedUnit: 'THREEMF_UNSUPPORTED_UNIT',
  ThreeMfDuplicateObjectId: 'THREEMF_DUPLICATE_OBJECT_ID',
  ThreeMfMissingObject: 'THREEMF_MISSING_OBJECT_REFERENCE',
  ThreeMfBadVertexIndex: 'THREEMF_TRIANGLE_INDEX_OUT_OF_RANGE',
  ThreeMfNonFinite: 'THREEMF_NON_FINITE_COORDINATE',
  ThreeMfBadTransform: 'THREEMF_MALFORMED_TRANSFORM',
  ThreeMfComponentCycle: 'THREEMF_COMPONENT_CYCLE',
  ThreeMfComponentTooDeep: 'THREEMF_COMPONENT_TOO_DEEP',
  ThreeMfTooManyObjects: 'THREEMF_TOO_MANY_OBJECTS',
  ThreeMfTooManyParts: 'THREEMF_TOO_MANY_PARTS',
  /**
   * The EXPANSION's totals, not one object's.
   *
   * A document counts triangles and vertices per part, so repeated placements
   * of one small object multiply them. These fire during the walk, before the
   * part that would cross the ceiling is built.
   */
  ThreeMfTooManyTriangles: 'THREEMF_TOO_MANY_TRIANGLES',
  ThreeMfTooManyVertices: 'THREEMF_TOO_MANY_VERTICES',
  ThreeMfNoBuildItems: 'THREEMF_NO_BUILD_ITEMS',
  ThreeMfMalformedStructure: 'THREEMF_MALFORMED_STRUCTURE',
  /**
   * A resource id that is not one.
   *
   * 3MF core types resource ids as positive integers. `pid="0"`, `pid="-3"`,
   * `pid="1.0"` and `pid="steel"` are not ids at all, and treating them as
   * opaque strings is how CAD Fixer came to WRITE `pid="steel-brushed"` into a
   * file of its own. The reader now refuses the shape rather than carrying it.
   */
  ThreeMfMalformedResourceId: 'THREEMF_MALFORMED_RESOURCE_ID',
  /**
   * A property reference that names no property resource.
   *
   * DISTINCT FROM AN UNSUPPORTED ONE, and the distinction is the whole point. A
   * `pid` resolving to a `<basematerials>` CAD Fixer does not interpret is a
   * VALID file whose materials are not imported — geometry loads and the loss is
   * reported. A `pid` resolving to nothing is a MALFORMED file, and silently
   * keeping the dangling string is what let a bad reference survive a round
   * trip.
   */
  ThreeMfDanglingPropertyReference: 'THREEMF_DANGLING_PROPERTY_REFERENCE',

  /* ---------------------------------------------------------------- shared -- */
  InputTooLarge: 'INPUT_TOO_LARGE',
  Cancelled: 'CANCELLED',
} as const;

export type ImportRefusal = (typeof ImportRefusal)[keyof typeof ImportRefusal];

/** Detail key every import refusal carries. Tests assert on this, not on prose. */
export const IMPORT_REASON_KEY = 'reason';

function withReason(reason: ImportRefusal, details: ErrorDetails | undefined): ErrorDetails {
  return { ...details, [IMPORT_REASON_KEY]: reason };
}

/**
 * The file is not something CAD Fixer reads at all.
 *
 * Distinct from malformed: an unknown format is a file we never claimed to
 * open, and telling a user their perfectly good STEP file is "corrupt" would be
 * both wrong and unhelpful.
 */
export function importUnsupported(
  reason: ImportRefusal,
  message: string,
  details?: ErrorDetails,
): AppError {
  return unsupportedFile(message, withReason(reason, details));
}

/** The file claims a format CAD Fixer reads, and does not conform to it. */
export function importMalformed(
  reason: ImportRefusal,
  message: string,
  details?: ErrorDetails,
): AppError {
  return malformedFile(message, withReason(reason, details));
}

/**
 * The file is well formed and larger than CAD Fixer will admit.
 *
 * A SEPARATE CATEGORY because the advice differs: a limit refusal will refuse
 * identically next time, so offering a retry would be offering a button that
 * cannot help.
 */
export function importTooLarge(
  reason: ImportRefusal,
  message: string,
  details?: ErrorDetails,
): AppError {
  return resourceLimitExceeded(message, withReason(reason, details));
}

/**
 * CAD Fixer is wired wrong, and the file is not at fault.
 *
 * Kept distinct so a dispatch mistake — a 3MF reader invoked without the
 * decompressor it needs, say — never reaches the user as "your file is
 * corrupt". That would send them looking for a problem in their model that is
 * not there.
 */
export function internalRefusal(message: string, details?: ErrorDetails): AppError {
  return internalError(message, details ? { details } : {});
}

/** Cancellation is not a failure and must never be rendered as one. */
export function importCancelled(): AppError {
  return operationCancelled('Import was cancelled.');
}

/** Reads the typed cause off an error's details, for tests and logs. */
export function refusalOf(error: { readonly details: ErrorDetails }): string | undefined {
  const value = error.details[IMPORT_REASON_KEY];
  return typeof value === 'string' ? value : undefined;
}
