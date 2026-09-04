import { unsupportedFile } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { FormatWriteContext, MeshWriteResult } from './context';
import type { DocumentReader } from './document-reader';
import { describeFormat, type MeshFormatId } from './formats';

/**
 * The seam between file bytes and the canonical mesh.
 *
 * STL, OBJ and 3MF all register readers as of Stage 4A-2B1. Only STL registers
 * a WRITER: export for the other two is Stage 4A-2B2, and a lookup for them
 * fails loudly rather than returning a stub that pretends to work — a test
 * enforces that.
 *
 * Implementations must run inside a worker: they touch whole-file buffers and
 * are the single most likely place for a hostile file to cause a stall.
 */

/**
 * Readers produce DOCUMENTS, not meshes, since Stage 4A-2B1.
 *
 * The contract lives in `document-reader.ts`; this alias keeps the registry's
 * vocabulary in one place. See that file for why every format — STL included —
 * converges on one shape.
 */
export type MeshReader = DocumentReader;

export interface MeshWriter {
  readonly formatId: MeshFormatId;
  /**
   * Encodings this writer can produce, e.g. `binary` and `ascii` for STL. The
   * first is the default.
   */
  readonly encodings: readonly string[];
  /** Serialises a canonical mesh. Must not mutate the input mesh. */
  write(mesh: CanonicalMesh, context: FormatWriteContext): Promise<MeshWriteResult>;
}

const readers = new Map<MeshFormatId, MeshReader>();
const writers = new Map<MeshFormatId, MeshWriter>();

export function registerReader(reader: MeshReader): void {
  readers.set(reader.formatId, reader);
}

export function registerWriter(writer: MeshWriter): void {
  writers.set(writer.formatId, writer);
}

export function getReader(formatId: MeshFormatId): MeshReader | undefined {
  return readers.get(formatId);
}

export function getWriter(formatId: MeshFormatId): MeshWriter | undefined {
  return writers.get(formatId);
}

/** True only once a codec has actually been registered for the format. */
export function canRead(formatId: MeshFormatId): boolean {
  return readers.has(formatId);
}

export function canWrite(formatId: MeshFormatId): boolean {
  return writers.has(formatId);
}

export function requireReader(formatId: MeshFormatId): MeshReader {
  const reader = readers.get(formatId);
  if (reader === undefined) {
    throw unsupportedFile(`Reading ${describeFormat(formatId).label} files is not implemented.`, {
      formatId,
    });
  }
  return reader;
}

export function requireWriter(formatId: MeshFormatId): MeshWriter {
  const writer = writers.get(formatId);
  if (writer === undefined) {
    throw unsupportedFile(`Writing ${describeFormat(formatId).label} files is not implemented.`, {
      formatId,
    });
  }
  return writer;
}

/** Test-only: restores registry state so tests cannot leak registrations. */
export function clearRegistryForTesting(): void {
  readers.clear();
  writers.clear();
}
