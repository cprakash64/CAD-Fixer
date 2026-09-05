export {
  describeFormat,
  FILE_INPUT_ACCEPT,
  MeshFormatId,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_FORMATS,
} from './formats';
export type { MeshFormatDescriptor } from './formats';

export {
  IMPLEMENTED_FORMATS,
  isFormatImplemented,
  isFormatWritable,
  WRITABLE_FORMATS,
} from './capabilities';

export { EMPTY_COMPATIBILITY, UnsupportedFeature } from './document-reader';
export type { DocumentReader, DocumentReadResult, ImportCompatibility } from './document-reader';

export {
  IMPORT_REASON_KEY,
  ImportRefusal,
  importCancelled,
  importMalformed,
  importTooLarge,
  importUnsupported,
  internalRefusal,
  refusalOf,
} from './import-errors';

export { FormatEvidence, identifyFormat } from './identify';
export type { FormatIdentification } from './identify';

export { DEFAULT_OBJ_LIMITS } from './obj/limits';
export type { ObjLimits } from './obj/limits';
export { readObj } from './obj/obj-reader';
export { objReader } from './obj/codec';

export {
  createInflationBudget,
  DEFAULT_ZIP_LIMITS,
  describeUnsafePath,
  looksLikeZip,
  readZipDirectory,
  readZipEntry,
} from './threemf/zip';
export type { InflationBudget, ZipEntry, ZipLimits } from './threemf/zip';
export {
  DEFAULT_XML_LIMITS,
  decodeXmlText,
  describeUnsafeXml,
  readAttrs,
  scanXml,
} from './threemf/xml-scan';
export type { XmlLimits } from './threemf/xml-scan';
export {
  DEFAULT_3MF_LIMITS,
  parseModelXml,
  read3mf,
  THREE_MF_UNITS,
} from './threemf/threemf-reader';
export type { ThreeMfLimits } from './threemf/threemf-reader';
export { threeMfReader } from './threemf/codec';

export {
  DEFAULT_MAX_INTAKE_BYTES,
  extractExtension,
  FileRejectionReason,
  screenFile,
} from './screening';
export type {
  FileAccepted,
  FileRejected,
  FileScreeningInput,
  FileScreeningOptions,
  FileScreeningResult,
} from './screening';

export {
  checkAllocation,
  checkInputSize,
  DEFAULT_IMPORT_BUDGET,
  MAX_TYPED_ARRAY_LENGTH,
  planAllocation,
} from './budget';
export type { AllocationPlan, ImportBudget } from './budget';

export type {
  FormatProgressReporter,
  FormatReadContext,
  FormatWriteContext,
  MeshReadResult,
} from './context';

export {
  canRead,
  canWrite,
  clearRegistryForTesting,
  getReader,
  getWriter,
  registerReader,
  registerWriter,
  requireReader,
  requireWriter,
} from './registry';
export type { MeshReader, MeshWriter } from './registry';

export {
  binaryStlByteLength,
  detectStlEncoding,
  StlDetectionFailure,
  StlEncoding,
} from './stl/detect';
export type { StlDetection } from './stl/detect';
export { readStl } from './stl/stl-reader';
export { writeAsciiStl, writeBinaryStl } from './stl/stl-writer';
export { stlReader, stlWriter } from './stl/codec';
export { StlWarningCode } from './stl/warnings';

export { registerBuiltInFormats } from './register';

/* ------------------------------------------------------ document export -- */

export {
  DEFAULT_EXPORT_LIMITS,
  ExportObservation,
  ExportStatus,
  expectedObjRoundTrip,
  expectedStlRoundTrip,
  exportSnapshotOf,
  planThreeMfObjects,
  snapshotTransferables,
  snapshotTriangleCount,
} from './export/export-contract';
export type {
  ExportDocumentSnapshot,
  ExportLimits,
  ExportMeshResource,
  ExportMetadata,
  ExportPartSnapshot,
  ExportProgressReporter,
  ExportSnapshotOptions,
  FormatWriteDocumentContext,
  WrittenDocument,
} from './export/export-contract';

export {
  analyseConversion,
  CompatibilityDisposition,
  CompatibilityFeature,
  ConversionVerdict,
  EXPORT_FORMATS,
  ExportFormat,
  isExportFormat,
  sharedPlacementCount,
  strongerVerdict,
} from './export/compatibility';
export type {
  CompatibilityFact,
  ConversionCompatibilityReport,
  ConversionRequest,
  DocumentFeatureProfile,
} from './export/compatibility';

export {
  maxStlDocumentTriangles,
  stlDocumentByteLength,
  writeStlDocument,
} from './export/stl-document-writer';
export {
  binaryStlByteLength as stlContainerByteLength,
  MAX_BINARY_STL_TRIANGLES,
} from './export/stl-layout';
/*
 * NAME-SAFETY PREDICATES, from leaf modules that import nothing.
 *
 * The conversion policy runs on the MAIN THREAD and must be able to tell a user
 * that a name will be adjusted before they export. These are the SAME functions
 * the writers use — not a mirror — so the disclosure cannot disagree with what
 * the file ends up containing.
 */
export { normaliseObjName, objNameChangesOnWrite } from './export/obj-name';
export { xmlTextChangesOnWrite } from './threemf/xml-text';

export {
  EXPORT_REASON_KEY,
  ExportRefusal,
  exportBlocked,
  exportInternal,
  exportRefusalOf,
  exportTooLarge,
} from './export/export-errors';

export { writeFloat32Text, writeFloat64Text } from './export/numeric';
export { exportDocument } from './export/export-document';
export type { ExportDocumentOptions } from './export/export-document';
export { writeObjDocument } from './export/obj-writer';
export { write3mfDocument } from './export/threemf-writer';
export { buildZipArchive } from './export/zip-writer';
export type { ZipWriteEntry, ZipWriteOptions } from './export/zip-writer';
export {
  assertExportSnapshot,
  validate3mfRoundTrip,
  validateObjRoundTrip,
  validateStlRoundTrip,
} from './export/validate';
export { escapeXml } from './threemf/xml-scan';
