export {
  describeFormat,
  FILE_INPUT_ACCEPT,
  MeshFormatId,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_FORMATS,
} from './formats';
export type { MeshFormatDescriptor } from './formats';

export { IMPLEMENTED_FORMATS, isFormatImplemented } from './capabilities';

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
