import { internalError } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { singlePartDocument } from '@cadfixer/mesh-core';
import type { FormatReadContext, FormatWriteContext, MeshWriteResult } from '../context';
import { EMPTY_COMPATIBILITY, type DocumentReadResult } from '../document-reader';
import { MeshFormatId } from '../formats';
import type { MeshReader, MeshWriter } from '../registry';
import { StlEncoding } from './detect';
import { readStl } from './stl-reader';
import { writeAsciiStl, writeBinaryStl } from './stl-writer';

/** The STL codec, in the shape the format registry expects. */

/**
 * The STL codec, in the shape the format registry expects.
 *
 * ONE FILE, ONE DOCUMENT, ONE PART. An STL describes exactly one triangle soup:
 * no object records, no placement, no unit. Wrapping happens HERE rather than
 * in the worker so that every format arrives at the import transaction in the
 * same shape and the handler has no per-format branching left in it.
 *
 * Nothing about the geometry changes by being wrapped: the mesh the reader
 * produced is the same object the document holds.
 */
export const stlReader: MeshReader = {
  formatId: MeshFormatId.Stl,
  async read(bytes: Uint8Array, context: FormatReadContext): Promise<DocumentReadResult> {
    const parsed = await readStl(bytes, context);
    return {
      document: singlePartDocument(parsed.mesh, {
        // Absent, not defaulted: STL states no unit and millimetres would be a
        // guess presented as a fact.
        ...(parsed.unit === undefined ? {} : { unit: parsed.unit }),
      }),
      encoding: parsed.encoding,
      warnings: parsed.warnings,
      // An STL cannot express a texture, a material or an unplaced object, so
      // there is nothing it could have lost.
      compatibility: EMPTY_COMPATIBILITY,
    };
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
