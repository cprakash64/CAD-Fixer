import type { FormatReadContext } from '../context';
import type { DocumentReadResult, DocumentReader } from '../document-reader';
import { MeshFormatId } from '../formats';
import { read3mf, type ThreeMfReadOptions } from './threemf-reader';

/**
 * A 3MF codec in the shape the format registry expects, reading with fixed
 * options — Stage 6E-A2.
 *
 * The registry holds `threeMfReader`, built with NO options: buffered
 * ingestion under the production limits. A reader built with others exists
 * only where a test or qualification harness constructs one and hands it to
 * `createModelImportHandler` explicitly; the shipped worker never does, and a
 * boundary test asserts that.
 */
export function createThreeMfReader(options: ThreeMfReadOptions): DocumentReader {
  const fixed: ThreeMfReadOptions = Object.freeze({ ...options });
  return {
    formatId: MeshFormatId.ThreeMf,
    read(bytes: Uint8Array, context: FormatReadContext): Promise<DocumentReadResult> {
      return read3mf(bytes, context, fixed);
    },
  };
}

/** The 3MF codec the product registers: buffered, production limits. */
export const threeMfReader: DocumentReader = createThreeMfReader({});
