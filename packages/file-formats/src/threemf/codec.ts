import type { FormatReadContext } from '../context';
import type { DocumentReadResult, DocumentReader } from '../document-reader';
import { MeshFormatId } from '../formats';
import { read3mf } from './threemf-reader';

/** The 3MF codec, in the shape the format registry expects. Read-only for now. */
export const threeMfReader: DocumentReader = {
  formatId: MeshFormatId.ThreeMf,
  read(bytes: Uint8Array, context: FormatReadContext): Promise<DocumentReadResult> {
    return read3mf(bytes, context);
  },
};
