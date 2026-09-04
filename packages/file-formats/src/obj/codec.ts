import type { FormatReadContext } from '../context';
import type { DocumentReadResult, DocumentReader } from '../document-reader';
import { MeshFormatId } from '../formats';
import { readObj } from './obj-reader';

/** The OBJ codec, in the shape the format registry expects. Read-only for now. */
export const objReader: DocumentReader = {
  formatId: MeshFormatId.Obj,
  read(bytes: Uint8Array, context: FormatReadContext): Promise<DocumentReadResult> {
    return readObj(bytes, context);
  },
};
