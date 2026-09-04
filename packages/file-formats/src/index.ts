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
  DEFAULT_ZIP_LIMITS,
  describeUnsafePath,
  looksLikeZip,
  readZipDirectory,
  readZipEntry,
} from './threemf/zip';
export type { ZipEntry, ZipLimits } from './threemf/zip';
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
