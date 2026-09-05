import {
  exportSnapshotOf,
  snapshotTransferables,
  snapshotTriangleCount,
} from '@cadfixer/file-formats';
import type { OperationHandler } from '@cadfixer/geometry-runtime';
import { isAppError } from '@cadfixer/shared';
import { residentDocuments } from './stl-handlers';
import type { ExportSnapshotMessage } from './export-protocol';

/**
 * THE PRODUCER SIDE OF THE EXPORT CHANNEL.
 *
 * This runs in the AUTHORITATIVE geometry worker — the one that owns the
 * document and must keep owning it. Its whole job is to hand a DISPOSABLE
 * SNAPSHOT to the export worker without the page ever seeing a coordinate, and
 * without putting its own buffers at risk.
 *
 * WHY THE SNAPSHOT IS BUILT RATHER THAN THE ORIGINAL TRANSFERRED. Transferring
 * detaches. If this worker transferred its canonical arrays it would be left
 * holding empty ones, and a terminated export worker would take the user's
 * model with it. The snapshot is freshly allocated, then transferred, so the
 * authoritative buffers are untouched and survive whatever happens downstream.
 *
 * ONE COPY PER DISTINCT MESH. A document with a thousand placements of one mesh
 * holds one mesh; its snapshot holds one geometry payload and a thousand
 * twelve-number placements. Copying per placement would make the snapshot a
 * thousand times larger than the document it describes.
 */
export const documentSendForExportHandler: OperationHandler<'document/send-for-export'> = (
  payload,
  context,
) => {
  /*
   * REJECTS RATHER THAN THROWS, matching `model/send-for-diagnostic`: a
   * function that sometimes throws synchronously and sometimes rejects makes
   * every caller write two error paths.
   */
  try {
    context.throwIfCancelled();

    /*
     * RESOLVING THE HANDLE IS ALSO THE STALENESS CHECK. An export queued
     * against a document that has since been replaced fails here rather than
     * quietly serialising geometry the user is no longer looking at.
     */
    const document = residentDocuments.resolve(payload.handle);
    if (isAppError(document)) throw document;

    /*
     * THE UNIT ASSERTION IS APPLIED HERE, WHERE THE DOCUMENT IS.
     *
     * `exportSnapshotOf` uses it ONLY when the document itself states no unit,
     * so a page working from an out-of-date mirror cannot relabel a model that
     * already knows what it is. The authoritative document is not written: this
     * builds a disposable snapshot and the store is never touched, so the
     * revision does not move and no undo entry is created. Exporting is a read.
     */
    const snapshot = exportSnapshotOf(
      document,
      payload.handle.documentId,
      payload.handle.revision,
      {
        ...(payload.unitAssertion === undefined ? {} : { unitAssertion: payload.unitAssertion }),
      },
    );

    const message: ExportSnapshotMessage = {
      kind: 'snapshot',
      operationId: payload.operationId,
      target: payload.target,
      snapshot,
    };

    // Transferred, and safe to transfer, because these are the COPY. The
    // authoritative arrays are not in this list and are not detached.
    payload.port.postMessage(message, snapshotTransferables(snapshot));

    return Promise.resolve({
      value: {
        partCount: snapshot.parts.length,
        meshResourceCount: snapshot.meshes.length,
        triangleCount: snapshotTriangleCount(snapshot),
        revision: payload.handle.revision,
      },
    });
  } catch (cause) {
    return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
  }
};
