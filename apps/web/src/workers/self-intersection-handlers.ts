import { triangleCount } from '@cadfixer/mesh-core';
import type { PartId } from '@cadfixer/mesh-core';
import { buildTopologicalGeometry } from '@cadfixer/mesh-topology';
import { SELF_INTERSECTION_MAX_FACES, narrowLimits } from '@cadfixer/mesh-self-intersection';
import type { OperationHandler } from '@cadfixer/geometry-runtime';
import { invalidState, isAppError } from '@cadfixer/shared';
import { residentDocuments } from './stl-handlers';

/**
 * THE PRODUCER SIDE OF THE DIAGNOSTIC CHANNEL.
 *
 * This handler runs in the AUTHORITATIVE geometry worker — the one that owns
 * canonical model geometry and must keep owning it. Its whole job is to hand a
 * DISPOSABLE COPY to the diagnostic worker without the page ever seeing a
 * coordinate, and without putting its own buffers at risk.
 *
 * WHY THE COPY IS BUILT RATHER THAN THE ORIGINAL TRANSFERRED. Transferring
 * detaches. If this worker transferred its canonical arrays it would be left
 * holding empty ones, and a terminated diagnostic worker would take the model
 * with it. The copy is freshly allocated, then transferred, so the authoritative
 * buffers are untouched and survive whatever happens downstream.
 */

/*
 * TOPOLOGICAL VERTICES COME FROM `@cadfixer/mesh-topology`, not from a local
 * copy.
 *
 * The canonical mesh stores a position per CORNER; the diagnostic reasons about
 * SHARED vertices, because distinguishing a legitimate shared edge from an
 * overlap is impossible when every corner is its own vertex.
 * `buildTopologicalGeometry` applies Stage 2's exact stored-coordinate identity
 * — the same function the analyser uses — so the diagnostic and the rest of CAD
 * Fixer agree on what the model IS. No second merging rule, no tolerance.
 *
 * IT IS ALSO THE PRECONDITION THAT MAKES THE KERNEL'S FIXED-CAPACITY SYMBOLIC
 * BUFFER SAFE: the overflow found during qualification required coincident
 * coordinates carrying distinct vertex ids, which welding eliminates.
 *
 * SHARED WITH THE HOLE-FILL ENGINE ON PURPOSE. Both hand pairs to the same
 * exact predicates, and a second welding scheme would let the two callers
 * disagree about which faces are adjacent — which is precisely the input those
 * predicates use to tell a legitimate neighbour from a defect.
 */

export const modelSendForDiagnosticHandler: OperationHandler<'model/send-for-diagnostic'> = (
  payload,
  context,
) => {
  /*
   * REJECTS RATHER THAN THROWS.
   *
   * The handler signature promises a `Promise`, and a function that sometimes
   * throws synchronously and sometimes rejects makes every caller write two
   * error paths. The worker host happens to catch both, but a caller reaching
   * this directly — a test, or a future in-process host — would not.
   */
  try {
    // Nothing here is long enough to need interrupting: the copy is one pass and
    // the expensive work happens in the diagnostic worker, which is cancelled by
    // being terminated.
    context.throwIfCancelled();

    /*
     * PER PART, and only ever per part.
     *
     * Self-intersection asks whether ONE part's own faces cross. Flattening a
     * document into one soup first would report two independently valid parts
     * that happen to overlap in world space as self-intersecting — a claim
     * about the model that nothing checked and that is not even true. Inter-part
     * overlap is a different question with a different name and no
     * implementation; see docs/adr/0013.
     */
    const part = residentDocuments.resolvePart(payload.handle, payload.partId as PartId);
    if (isAppError(part)) throw part;
    const resolved = part.mesh;

    const faceCount = triangleCount(resolved);

    /*
     * THE CEILING IS RE-CHECKED HERE, not only in the controller.
     *
     * The controller refuses above-ceiling models before creating anything,
     * which is what actually protects the user. This second check exists because
     * the copy below is the expensive, allocating step: a request that reached
     * this far with an oversized model would allocate hundreds of megabytes
     * before anything downstream could object.
     */
    if (faceCount > SELF_INTERSECTION_MAX_FACES) {
      throw invalidState(
        `This model has ${faceCount.toLocaleString()} triangles. The self-intersection check is not run above ${SELF_INTERSECTION_MAX_FACES.toLocaleString()}.`,
        { faceCount, ceiling: SELF_INTERSECTION_MAX_FACES },
      );
    }

    const { positions, triangles } = buildTopologicalGeometry(resolved);

    // Transferred, and safe to transfer, because these are the COPY. The
    // authoritative arrays are not in this list and are not detached.
    payload.port.postMessage(
      {
        kind: 'geometry',
        operationId: payload.operationId,
        documentId: payload.handle.documentId,
        documentRevision: payload.handle.revision,
        partId: part.id,
        positions,
        triangles,
        limits: narrowLimits(payload.limits),
      },
      [positions.buffer, triangles.buffer],
    );

    return Promise.resolve({
      value: { faceCount, vertexCount: positions.length / 3 },
    });
  } catch (cause) {
    return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
  }
};
