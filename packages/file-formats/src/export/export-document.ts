import { isAppError } from '@cadfixer/shared';
import type { FormatReadContext } from '../context';
import { MeshFormatId } from '../formats';
import { readObj } from '../obj/obj-reader';
import { singlePartDocument } from '@cadfixer/mesh-core';
import { readStl } from '../stl/stl-reader';
import { read3mf } from '../threemf/threemf-reader';
import {
  expectedObjRoundTrip,
  expectedStlRoundTrip,
  type ExportDocumentSnapshot,
  type FormatWriteDocumentContext,
  type WrittenDocument,
} from './export-contract';
import { ExportRefusal, exportInternal } from './export-errors';
import { writeObjDocument } from './obj-writer';
import { writeStlDocument } from './stl-document-writer';
import { write3mfDocument } from './threemf-writer';
import {
  assertExportSnapshot,
  validate3mfRoundTrip,
  validateObjRoundTrip,
  validateStlRoundTrip,
} from './validate';

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

export async function exportDocument(options: ExportDocumentOptions): Promise<WrittenDocument> {
  const { snapshot, target, write, read } = options;

  /*
   * THERE IS NO UNSUPPORTED-TARGET BRANCH HERE ANY MORE, and its absence is the
   * point rather than an omission.
   *
   * `MeshFormatId` has exactly three members and, as of Stage 4A-2B3, all three
   * have a document writer — so a guard against a fourth would be code the type
   * system proves unreachable, which is worse than no guard: it reads as a live
   * check and can never fire.
   *
   * The check that DOES matter is at the boundary a string arrives through. The
   * export worker maps an untrusted `target` string onto this enum and refuses
   * anything it does not recognise with `EXPORT_UNSUPPORTED_TARGET`, which is
   * where an unknown target can actually come from.
   */
  assertExportSnapshot(snapshot);

  /*
   * STL GOES THROUGH HERE TOO, as of Stage 4A-2B3, and that is a change of
   * MEANING rather than a convenience.
   *
   * Until this stage STL export was `model/export`: one PART, chosen by the
   * user, with a warning naming what was left out. That operation still exists
   * and still means that. What this path writes is the WHOLE DOCUMENT flattened
   * into one triangle stream — a different question with a different answer,
   * and one that has to be validated the same way OBJ and 3MF are, because a
   * flattening bug is exactly the kind that produces a plausible file full of
   * geometry in the wrong place.
   */
  const written =
    target === MeshFormatId.Obj
      ? await writeObjDocument(snapshot, write)
      : target === MeshFormatId.Stl
        ? await writeStlDocument(snapshot, write)
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
        : target === MeshFormatId.Stl
          ? /*
             * WRAPPED THE WAY THE STL CODEC WRAPS IT. `readStl` returns a mesh
             * rather than a document because an STL genuinely is one; going
             * through `singlePartDocument` means the validator compares against
             * the same one-part shape a real import of this file would produce,
             * rather than against a shape only validation ever builds.
             */
            { document: singlePartDocument((await readStl(written.bytes, read)).mesh) }
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
  } else if (target === MeshFormatId.Stl) {
    validateStlRoundTrip(expectedStlRoundTrip(snapshot), parsed.document);
  } else {
    validate3mfRoundTrip(snapshot, parsed.document);
  }

  write.progress.report(1, 'complete');
  return written;
}
