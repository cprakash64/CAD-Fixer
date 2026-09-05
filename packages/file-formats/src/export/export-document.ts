import { isAppError } from '@cadfixer/shared';
import type { FormatReadContext } from '../context';
import { MeshFormatId } from '../formats';
import { readObj } from '../obj/obj-reader';
import { read3mf } from '../threemf/threemf-reader';
import {
  expectedObjRoundTrip,
  type ExportDocumentSnapshot,
  type FormatWriteDocumentContext,
  type WrittenDocument,
} from './export-contract';
import { ExportRefusal, exportBlocked, exportInternal } from './export-errors';
import { writeObjDocument } from './obj-writer';
import { write3mfDocument } from './threemf-writer';
import { assertExportSnapshot, validate3mfRoundTrip, validateObjRoundTrip } from './validate';

/**
 * THE ONE EXPORT TRANSACTION, mirroring `commitImportedDocument` on the way in.
 *
 * Serialise, read the bytes back with the PRODUCTION reader, compare against
 * what the target is expected to preserve, and only then return an artifact.
 * A format-specific success path would be a second definition of "exported",
 * and the two would eventually disagree about what validation means.
 */

export interface ExportDocumentOptions {
  readonly snapshot: ExportDocumentSnapshot;
  readonly target: MeshFormatId;
  readonly write: FormatWriteDocumentContext;
  /** Used ONLY to read the bytes we just wrote. Never touches a user file. */
  readonly read: FormatReadContext;
}

function isWritableTarget(target: MeshFormatId): boolean {
  return target === MeshFormatId.Obj || target === MeshFormatId.ThreeMf;
}

export async function exportDocument(options: ExportDocumentOptions): Promise<WrittenDocument> {
  const { snapshot, target, write, read } = options;

  if (!isWritableTarget(target)) {
    /*
     * STL IS NOT WRITTEN THROUGH HERE, and that is deliberate rather than an
     * omission. STL export writes ONE part and states what it left out; it is a
     * different operation with a different contract, and folding it in would
     * mean either flattening a document silently or teaching this path a
     * special case that is not about documents at all.
     */
    throw exportBlocked(ExportRefusal.UnsupportedTarget, 'CAD Fixer cannot write that format.', {
      target,
    });
  }

  assertExportSnapshot(snapshot);

  const written =
    target === MeshFormatId.Obj
      ? await writeObjDocument(snapshot, write)
      : await write3mfDocument(snapshot, write);

  write.progress.report(0.85, 'validating');

  /*
   * READ BACK WITH THE PRODUCTION READER, under production limits.
   *
   * Using a lenient reader here would prove that a lenient reader accepts our
   * output. What has to be true is that the reader a USER'S import goes through
   * accepts it — including every resource ceiling, because a file we cannot
   * re-open is a file we should not have written.
   */
  let parsed;
  try {
    parsed =
      target === MeshFormatId.Obj
        ? await readObj(written.bytes, read)
        : await read3mf(written.bytes, read);
  } catch (cause) {
    if (isAppError(cause) && cause.code === 'OPERATION_CANCELLED') throw cause;
    throw exportInternal(
      ExportRefusal.ValidationUnreadable,
      'CAD Fixer wrote a file it could not read back, so the export was refused.',
      { cause: isAppError(cause) ? cause.code : 'unknown' },
    );
  }

  if (target === MeshFormatId.Obj) {
    validateObjRoundTrip(expectedObjRoundTrip(snapshot), parsed.document);
  } else {
    validate3mfRoundTrip(snapshot, parsed.document);
  }

  write.progress.report(1, 'complete');
  return written;
}
