import { internalError } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type {
  FormatReadContext,
  FormatWriteContext,
  MeshReadResult,
  MeshWriteResult,
} from '../context';
import { MeshFormatId } from '../formats';
import type { MeshReader, MeshWriter } from '../registry';
import { StlEncoding } from './detect';
import { readStl } from './stl-reader';
import { writeAsciiStl, writeBinaryStl } from './stl-writer';

/** The STL codec, in the shape the format registry expects. */

export const stlReader: MeshReader = {
  formatId: MeshFormatId.Stl,
  read(bytes: Uint8Array, context: FormatReadContext): Promise<MeshReadResult> {
    return readStl(bytes, context);
  },
};

export const stlWriter: MeshWriter = {
  formatId: MeshFormatId.Stl,
  // Binary first: it is the default because it is roughly a fifth of the size
  // and is what slicers expect.
  encodings: [StlEncoding.Binary, StlEncoding.Ascii],
  write(mesh: CanonicalMesh, context: FormatWriteContext): Promise<MeshWriteResult> {
    const encoding = context.encoding ?? StlEncoding.Binary;
    if (encoding === StlEncoding.Binary) return writeBinaryStl(mesh, context);
    if (encoding === StlEncoding.Ascii) return writeAsciiStl(mesh, context);
    throw internalError('Unknown STL encoding requested for export.', {
      details: { encoding },
    });
  },
};
