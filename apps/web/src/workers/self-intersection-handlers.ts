import { triangleCount } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { recoverVertexIdentity } from '@cadfixer/mesh-topology';
import { SELF_INTERSECTION_MAX_FACES, narrowLimits } from '@cadfixer/mesh-self-intersection';
import type { OperationHandler } from '@cadfixer/geometry-runtime';
import { invalidState, isAppError } from '@cadfixer/shared';
import { residentModels } from './stl-handlers';

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

/**
 * Recovers TOPOLOGICAL vertices from the canonical soup.
 *
 * The canonical mesh stores a position per CORNER; the diagnostic reasons about
 * shared vertices, because distinguishing a legitimate shared edge from an
 * overlap is impossible when every corner is its own vertex. This uses Stage 2's
 * exact stored-coordinate identity — the same function the analyser uses — so
 * the diagnostic and the rest of CAD Fixer agree on what the model IS. No second
 * merging rule, no tolerance.
 *
 * It is also the precondition that makes the kernel's fixed-capacity symbolic
 * buffer safe: the overflow found during qualification required coincident
 * coordinates carrying distinct vertex ids, which this eliminates.
 */
function toTopologicalGeometry(mesh: CanonicalMesh): {
  positions: Float64Array;
  triangles: Uint32Array;
} {
  const identity = recoverVertexIdentity(mesh);

  // Float64 because the kernel's exact predicates work in double precision.
  // Each stored Float32 value is WIDENED exactly; no precision is invented.
  const positions = new Float64Array(identity.vertexCount * 3);
  for (let vertex = 0; vertex < identity.vertexCount; vertex += 1) {
    const corner = identity.vertexRepresentativeCorner[vertex] ?? 0;
    positions[vertex * 3] = mesh.positions[corner * 3] ?? 0;
    positions[vertex * 3 + 1] = mesh.positions[corner * 3 + 1] ?? 0;
    positions[vertex * 3 + 2] = mesh.positions[corner * 3 + 2] ?? 0;
  }

  const triangles = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i += 1) {
    triangles[i] = identity.cornerToVertex[mesh.indices[i] ?? 0] ?? 0;
  }

  return { positions, triangles };
}

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

    const resolved = residentModels.resolve(payload.handle);
    if (isAppError(resolved)) throw resolved;

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

    const { positions, triangles } = toTopologicalGeometry(resolved);

    // Transferred, and safe to transfer, because these are the COPY. The
    // authoritative arrays are not in this list and are not detached.
    payload.port.postMessage(
      {
        kind: 'geometry',
        operationId: payload.operationId,
        modelId: payload.handle.modelId,
        modelRevision: payload.handle.revision,
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
