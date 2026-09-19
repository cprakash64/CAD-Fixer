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
  /**
   * An entry produced MORE bytes than its central directory declared.
   *
   * STAGE 6D-B1. Inflation now fills one destination sized from the declared
   * uncompressed size, so a stream that keeps producing past that size has
   * contradicted the archive's own metadata. One of the two is wrong and there
   * is no way to tell which, so neither is trusted.
   *
   * SEPARATE FROM `ZipEntryTooLarge`, which says the archive asked for more
   * than CAD Fixer will extract. This one says the archive disagrees with
   * ITSELF, and the sizes involved may be far below every ceiling.
   */
  ZipDeclaredSizeOverrun: 'ZIP_DECLARED_SIZE_OVERRUN',
  /**
   * An entry's stream ended BEFORE its declared uncompressed size.
   *
   * STAGE 6D-B1. Truncated or corrupt entry data. Previously this returned
   * short bytes that looked like a successful read, and the damage surfaced
   * much later as malformed XML — which told the user their model was broken
   * when the archive was.
   */
  ZipDeclaredSizeShortfall: 'ZIP_DECLARED_SIZE_SHORTFALL',
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
  /**
   * STAGE 6E-A1, STREAMING ONLY. One tag — the text between `<` and the first
   * `>` — longer than the streaming scanner will hold while it waits for the
   * `>`. The whole-string scanner has no such bound because the whole string is
   * already in memory; a streaming scanner that did not bound it would retain
   * an unterminated tag until end of input, which is the whole-entry
   * materialisation streaming exists to avoid. Not produced by any shipped path.
   */
  XmlTagTooLong: 'XML_TAG_TOO_LONG',

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
  /**
   * THE FILE IS VALID AND CAD FIXER CANNOT READ IT — a distinct fact from
   * either of its neighbours.
   *
   * A `<component>` carrying a production-extension `path` names an object in
   * ANOTHER model part of the package. CAD Fixer opens exactly one model part,
   * so that object is genuinely absent from the table it resolves against, and
   * the reference check could not tell the difference: a perfectly good file
   * exported by a consumer slicer was reported to its owner as containing a
   * reference to an object that does not exist.
   *
   * `UNSUPPORTED_FILE`, never `MALFORMED_FILE`. Telling someone their working
   * file is broken sends them to look for damage that is not there, and the
   * fault is ours.
   */
  /**
   * A production-extension `path` that is not a well-formed package reference.
   *
   * STAGE 6D-A1. Distinct from `ThreeMfModelPartNotFound`: this says the
   * REFERENCE is wrong — traversal, a drive letter, a URL scheme, a control
   * character, no leading slash. `details.reasonDetail` names which rule.
   */
  ThreeMfMalformedModelPartPath: 'THREEMF_MALFORMED_MODEL_PART_PATH',
  /**
   * A well-formed package reference naming an entry the archive does not hold.
   *
   * STAGE 6D-A1, and deliberately NOT folded into the malformed case. One is a
   * hostile or corrupt reference, the other an incomplete package; a user can
   * act on the second and not the first.
   */
  ThreeMfModelPartNotFound: 'THREEMF_MODEL_PART_NOT_FOUND',
  /**
   * A geometry reference naming a package part that is not a model.
   *
   * UNSUPPORTED rather than malformed: referencing a thumbnail or a texture is
   * legal in the package, and what CAD Fixer cannot do is read one as geometry.
   */
  ThreeMfModelPartNotAModel: 'THREEMF_MODEL_PART_NOT_A_MODEL',
  /*
   * `THREEMF_MULTI_MODEL_PART_UNSUPPORTED` WAS REMOVED IN STAGE 6D-A2, and the
   * removal is the point rather than tidying.
   *
   * It named one sentence — "this 3MF stores referenced objects in several model
   * parts, using an extension CAD Fixer does not support yet" — and that
   * sentence stopped being true the moment reachable cross-part geometry
   * imported. A code with no producer is drift at best; kept here it would
   * invite reuse for some specific construct, and the over-broad sentence would
   * come back with it, telling a user to re-export a file that would now open.
   *
   * What replaced it is three refusals that each name a construct:
   * `ThreeMfNonRootModelPartPath`, `ThreeMfMissingModelPartObject` and
   * `ThreeMfInconsistentModelPartUnits`.
   */
  /**
   * A `path` on a reference inside a part that is not the package root.
   *
   * STAGE 6D-A2. The production extension permits a path-bearing reference only
   * in the root model part; a referenced part may not chain further. MALFORMED
   * rather than unsupported, because this is the package violating a structural
   * rule of the extension it declares — not CAD Fixer declining a feature.
   *
   * REFUSED RATHER THAN FOLLOWED, and refused rather than ignored. Following it
   * would import geometry the specification says no consumer should reach;
   * ignoring it would silently drop a placement the file asked for.
   */
  ThreeMfNonRootModelPartPath: 'THREEMF_NON_ROOT_MODEL_PART_PATH',
  /**
   * A cross-part reference naming an object the target model part does not
   * declare.
   *
   * STAGE 6D-A2, and DELIBERATELY DISTINCT FROM `ThreeMfMissingObject`. A
   * same-part dangling component is a broken object graph inside one file; this
   * is a package whose parts disagree about what one of them contains. The two
   * send a user to look in different places, so they are not one code.
   *
   * THERE IS NO FALLBACK TO THE REFERRING PART'S TABLE. Resolving `B.model:1`
   * against `A.model` when B has no object 1 would import the wrong geometry
   * and call it success.
   */
  ThreeMfMissingModelPartObject: 'THREEMF_MISSING_MODEL_PART_OBJECT',
  /**
   * Reachable model parts of one package declare different units.
   *
   * STAGE 6D-A2. UNSUPPORTED, not malformed: nothing in the package is
   * self-contradictory, and a producer may legitimately write it. Honouring it
   * would mean rescaling one part's coordinates into another's unit, and CAD
   * Fixer never rescales stored geometry — a document holds ONE unit authority
   * and the numbers under it are the file's own.
   *
   * An ABSENT `unit` is compared as millimetre, because the specification
   * defaults the attribute. Parts that are never reached are never compared.
   */
  ThreeMfInconsistentModelPartUnits: 'THREEMF_INCONSISTENT_MODEL_PART_UNITS',
  /**
   * A package that would need more model parts LOADED than the limit allows.
   *
   * STAGE 6D-A2 wires the Stage 6D-A1 plumbing to a refusal, and deliberately
   * configures NO production ceiling: Stage 6D-R1 established that the archive
   * entry count, the one package-wide inflation budget and the document's part
   * and triangle ceilings already bound a multi-part load, and that a fourth
   * bound with no measurement behind it is not a policy. The code exists so a
   * ceiling can be introduced with evidence without also having to invent its
   * refusal.
   */
  ThreeMfTooManyModelParts: 'THREEMF_TOO_MANY_MODEL_PARTS',
  /**
   * Several `.model` entries and nothing that says which one is the root.
   *
   * STAGE 6D-A3. 3MF core identifies the root model part by the OPC
   * relationship of type `.../2013/01/3dmodel` in the package's root `.rels`,
   * and the production extension adds that non-root model files MUST NOT be
   * referenced from it — so that relationship is unambiguous by construction.
   *
   * WHEN IT IS ABSENT AND THE CONVENTIONAL PATH IS NOT THERE EITHER, a package
   * with several model parts has no root that CAD Fixer can identify. It used
   * to take the first `.model` the ZIP directory happened to list, which in a
   * production-extension package can be a CHILD part — and since Stage 6D-A2
   * that means walking the wrong part's build and importing geometry the
   * package never asked for. Refusing is the honest answer; guessing is the one
   * outcome that cannot be defended.
   */
  ThreeMfAmbiguousRootModelPart: 'THREEMF_AMBIGUOUS_ROOT_MODEL_PART',
  /**
   * The package uses the production ALTERNATIVES extension.
   *
   * STAGE 6D-A3. `http://schemas.microsoft.com/3dmanufacturing/production/alternatives/2021/04`
   * lets an object carry alternative representations — `fullres`, `lowres` and
   * `obfuscated`, the last being "a modified version hiding sensitive zones".
   * Which representation IS the object therefore depends on a selection the
   * consumer makes.
   *
   * REFUSED RATHER THAN IGNORED, and the tension is deliberate: 3MF core says a
   * consumer "MUST ignore all XML nodes and attributes from namespaces it does
   * not explicitly support", which read alone would have CAD Fixer import the
   * base object and report success. It could then hand a user an obfuscated or
   * low-resolution representation as their model, which is exactly the class of
   * claim this product does not make. A package using alternatives is required
   * by the production specification to declare the extension, in which case the
   * unknown-required rule refuses it first; this catches the producer that did
   * not.
   */
  ThreeMfModelResolutionUnsupported: 'THREEMF_MODEL_RESOLUTION_UNSUPPORTED',
  /**
   * The package DECLARES that it requires an extension CAD Fixer does not
   * implement.
   *
   * Refused rather than read as baseline 3MF: `requiredextensions` is the
   * format's own way of saying the file cannot be understood without those
   * semantics, and importing the parts we happen to recognise would be exactly
   * the incomplete geometry reported as success that this product exists not to
   * produce.
   */
  ThreeMfUnsupportedExtension: 'THREEMF_UNSUPPORTED_EXTENSION',
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
