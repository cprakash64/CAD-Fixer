import { unsupportedFile, type CancellationToken } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { describeFormat, type MeshFormatId } from './formats';

/**
 * The seam between file bytes and the canonical mesh.
 *
 * NO CODEC IS IMPLEMENTED IN STAGE 0. The registry below is intentionally
 * empty, so every lookup fails loudly rather than returning a stub that
 * pretends to work. These interfaces exist now so that when STL, OBJ, and 3MF
 * codecs are written they slot in behind a fixed contract, and so the worker
 * and UI layers can be built against something real.
 *
 * Implementations must run inside a worker: they touch whole-file buffers and
 * are the single most likely place for a hostile file to cause a stall.
 */

export interface FormatProgressReporter {
  /** `fraction` is 0..1. Implementations should throttle; the transport does not. */
  report(fraction: number, note?: string): void;
}

export interface FormatReadContext {
  readonly cancellation: CancellationToken;
  readonly progress: FormatProgressReporter;
}

export interface FormatWriteContext {
  readonly cancellation: CancellationToken;
  readonly progress: FormatProgressReporter;
}

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
  read(bytes: Uint8Array, context: FormatReadContext): Promise<CanonicalMesh>;
}

export interface MeshWriter {
  readonly formatId: MeshFormatId;
  /** Serialises a canonical mesh. Must not mutate the input mesh. */
  write(mesh: CanonicalMesh, context: FormatWriteContext): Promise<Uint8Array>;
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
