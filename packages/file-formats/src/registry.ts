import { unsupportedFile } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type {
  FormatReadContext,
  FormatWriteContext,
  MeshReadResult,
  MeshWriteResult,
} from './context';
import { describeFormat, type MeshFormatId } from './formats';

/**
 * The seam between file bytes and the canonical mesh.
 *
 * STL is implemented as of Stage 1 and registers itself (see `./stl`). OBJ and
 * 3MF are not, and every lookup for them fails loudly rather than returning a
 * stub that pretends to work — a test enforces that.
 *
 * Implementations must run inside a worker: they touch whole-file buffers and
 * are the single most likely place for a hostile file to cause a stall.
 */

export interface MeshReader {
  readonly formatId: MeshFormatId;
  /**
   * Parses `bytes` into a canonical mesh.
   *
   * Implementations must treat `bytes` as hostile: validate every declared
   * count against the actual buffer length before allocating, bound all
   * allocations, and poll `context.cancellation`. The caller is responsible for
   * validating the returned mesh — see `assertMeshStructure`.
   */
  read(bytes: Uint8Array, context: FormatReadContext): Promise<MeshReadResult>;
}

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
