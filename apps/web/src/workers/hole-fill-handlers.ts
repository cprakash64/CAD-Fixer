import { createIndexArray, createPositionArray, triangleCount } from '@cadfixer/mesh-core';
import type { CanonicalMesh, PartId } from '@cadfixer/mesh-core';
import { extractBoundaryLoops } from '@cadfixer/mesh-topology';
import {
  HOLE_FILL_MAX_BOUNDARY_VERTICES,
  HOLE_FILL_MAX_PART_FACES,
  HoleFillCandidateStore,
  HoleFillStatus,
  type BoundaryLoopSummary,
  type HoleFillLimits,
  type HoleFillValidationSummary,
  type OperationHandler,
  type ProtocolPort,
} from '@cadfixer/geometry-runtime';
import { internalError, invalidState, isAppError, operationCancelled } from '@cadfixer/shared';
import { residentDocuments } from './stl-handlers';
import type { HoleFillWorkerReply } from './hole-fill-protocol';

/**
 * THE AUTHORITATIVE SIDE OF THE HOLE-FILL CHANNEL.
 *
 * These handlers run in the geometry worker that OWNS canonical model geometry
 * and must keep owning it. Between them they do three things and nothing else:
 * enumerate a part's boundary loops as targetable identities, hand a DISPOSABLE
 * COPY to the fill worker and take ownership of the candidate that comes back,
 * and release a candidate when it is no longer wanted.
 *
 * NO AUTHORITATIVE MUTATION HAPPENS HERE, AT ALL. Stage 4B-1B1 produces
 * candidates. The resident document is not replaced, its revision does not
 * move, no undo record is written, and no path in this file can do any of those
 * — regardless of whether the fill succeeded, was refused, was cancelled or
 * crashed the worker that ran it.
 *
 * WHY THE COPY IS BUILT RATHER THAN THE ORIGINAL TRANSFERRED. Transferring
 * detaches. If this worker transferred its canonical arrays it would be left
 * holding empty ones, and a terminated fill worker would take the model with
 * it. The copy is freshly allocated, then transferred, so the authoritative
 * buffers are untouched and survive whatever happens downstream.
 */

/** Boundary components a single listing may describe. */
const DEFAULT_LOOP_LIMIT = 256;

/**
 * The candidate store, owned by this worker.
 *
 * A module-level singleton exactly as `residentDocuments` is, and for the same
 * reason: there is one authoritative worker, it owns the geometry, and a store
 * created per call would lose a candidate the moment the call returned.
 */
export const holeFillCandidates = new HoleFillCandidateStore();

/**
 * Lists a part's boundary components as ORDERED, TARGETABLE loops.
 *
 * READ-ONLY. It recovers connectivity from exact stored coordinates and leaves
 * every canonical buffer byte-identical, exactly as `model/analyze` does.
 *
 * THIS IS THE ONLY SOURCE OF A `boundaryLoopId`. A fill names a loop by an
 * identity this worker produced from the geometry it holds — never by an index
 * the interface chose, and never by a boundary the caller described. That is
 * what makes "fill the loop I meant" checkable rather than hopeful.
 */
export const holeFillListLoopsHandler: OperationHandler<'holefill/list-loops'> = (
  payload,
  context,
) => {
  try {
    context.throwIfCancelled();

    const part = residentDocuments.resolvePart(payload.handle, payload.partId as PartId);
    if (isAppError(part)) throw part;

    const set = extractBoundaryLoops(part.mesh, {
      maxLoopVertices: HOLE_FILL_MAX_BOUNDARY_VERTICES,
      onBatch: () => {
        context.throwIfCancelled();
      },
    });

    /*
     * THE LIST IS CAPPED AND THE COUNT IS NOT. A mesh of loose triangles has
     * one boundary component per face, and the whole list crosses the worker
     * boundary — but a truncated list must never become a smaller number of
     * openings, which is the same rule the topology report's component summary
     * follows.
     */
    const limit = clampLimit(payload.limit);
    const loops: BoundaryLoopSummary[] = [];
    for (const loop of set.loops) {
      if (loops.length >= limit) break;
      loops.push({
        boundaryLoopId: loop.id,
        vertexCount: loop.vertexCount,
        edgeCount: loop.edgeCount,
        fillable: loop.refusal === undefined,
        ...(loop.refusal === undefined ? {} : { refusal: loop.refusal }),
      });
    }

    return Promise.resolve({
      value: {
        handle: payload.handle,
        partId: part.id,
        loopCount: set.loops.length,
        loops,
        truncated: set.loops.length > loops.length,
      },
    });
  } catch (cause) {
    return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
  }
};

function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_LOOP_LIMIT;
  }
  return Math.min(Math.floor(requested), DEFAULT_LOOP_LIMIT);
}

/**
 * Hands the fill worker a copy of one part and takes ownership of its verdict.
 *
 * STAYS PENDING UNTIL THE CHANNEL ANSWERS, unlike `model/send-for-diagnostic`.
 * A diagnostic produces only numbers, which the page can receive from the
 * diagnostic worker directly; a fill produces GEOMETRY, and geometry has to be
 * handed to an owner. So the reply comes back here, the candidate is registered
 * here, and the page receives a handle.
 *
 * CANCELLATION IS OBSERVED, NOT POLLED. The fill worker cannot be interrupted
 * mid-pass, so the controller terminates it and cancels this operation; the
 * race below settles on whichever happens first. A candidate arriving after a
 * cancellation is DISCARDED rather than registered.
 */
export const holeFillSendForFillHandler: OperationHandler<'holefill/send-for-fill'> = async (
  payload,
  context,
) => {
  context.throwIfCancelled();

  const part = residentDocuments.resolvePart(payload.handle, payload.partId as PartId);
  if (isAppError(part)) throw part;

  const faceCount = triangleCount(part.mesh);

  /*
   * THE CEILING IS RE-CHECKED HERE, not only in the controller and not only in
   * the engine. The copy below is the expensive, allocating step: a request
   * that reached this far with an oversized part would allocate tens of
   * megabytes before anything downstream could object.
   */
  if (faceCount > HOLE_FILL_MAX_PART_FACES) {
    throw invalidState(
      `This part has ${faceCount.toLocaleString()} triangles. Hole filling is not run above ${HOLE_FILL_MAX_PART_FACES.toLocaleString()}.`,
      { faceCount, ceiling: HOLE_FILL_MAX_PART_FACES },
    );
  }

  const copy = copyMesh(part.mesh);

  const reply = await exchange(payload.port, context.cancellation, () => {
    payload.port.postMessage(
      {
        kind: 'fill',
        operationId: payload.operationId,
        documentId: payload.handle.documentId,
        documentRevision: payload.handle.revision,
        partId: part.id,
        boundaryLoopId: payload.boundaryLoopId,
        positions: copy.positions,
        indices: copy.indices,
        limits: narrowedLimits(payload.limits),
      },
      [copy.positions.buffer, copy.indices.buffer],
    );
  });

  if (reply.kind === 'failed') {
    throw internalError('The hole-fill worker failed.', { details: { reason: reply.reason } });
  }

  const summary: HoleFillValidationSummary = reply.summary;

  if (reply.positions === undefined || reply.indices === undefined) {
    return {
      value: {
        status: reply.status,
        summary,
        intersectionSamples: reply.intersectionSamples,
        samplesTruncated: reply.samplesTruncated,
      },
      transfer: [reply.intersectionSamples.buffer],
    };
  }

  /*
   * THE STALENESS GUARD, applied to the CANDIDATE rather than to the request.
   *
   * The fill ran while this worker was free to serve other operations, so the
   * document may have moved on. A candidate built from a revision the user has
   * left describes geometry they are no longer looking at, and registering it
   * would let a later stage apply it to a mesh it was never derived from. It is
   * dropped, and the status says why.
   */
  const current = residentDocuments.revisionOf(payload.handle.documentId);
  if (current !== payload.handle.revision) {
    return {
      value: {
        status: HoleFillStatus.StaleRevision,
        summary,
        intersectionSamples: reply.intersectionSamples,
        samplesTruncated: reply.samplesTruncated,
      },
      transfer: [reply.intersectionSamples.buffer],
    };
  }

  const candidateMesh: CanonicalMesh = {
    positions: reply.positions,
    indices: reply.indices,
    metadata: part.mesh.metadata,
  };
  const candidate = holeFillCandidates.create(
    payload.handle,
    part.id,
    payload.boundaryLoopId,
    candidateMesh,
  );

  return {
    value: {
      status: reply.status,
      summary,
      candidate,
      intersectionSamples: reply.intersectionSamples,
      samplesTruncated: reply.samplesTruncated,
    },
    transfer: [reply.intersectionSamples.buffer],
  };
};

/** Releases a candidate's geometry. Idempotent; discarding twice is not a fault. */
export const holeFillDiscardHandler: OperationHandler<'holefill/discard'> = (payload) => {
  const released = holeFillCandidates.discard(payload.candidate);
  return Promise.resolve({ value: { released } });
};

/* ------------------------------------------------------------ internals -- */

/**
 * A fresh copy of the part's canonical buffers.
 *
 * CANONICAL Float32, not widened doubles. The fill engine judges its candidate
 * on the representation that would become authoritative, and its byte-level
 * source-preservation check compares against exactly these bytes — widening
 * here would mean validating something the model never is.
 */
function copyMesh(mesh: CanonicalMesh): { positions: Float32Array; indices: Uint32Array } {
  const positions = createPositionArray(mesh.positions.length);
  positions.set(mesh.positions);
  const indices = createIndexArray(mesh.indices.length);
  indices.set(mesh.indices);
  return { positions, indices };
}

/** A message may only make the engine MORE cautious, never less. */
function narrowedLimits(
  requested: Partial<HoleFillLimits> | undefined,
): Partial<HoleFillLimits> | undefined {
  // The engine clamps every field against its own ceilings, so passing the
  // request through unchanged cannot widen anything. Stated here so a reader
  // looking for the guard finds where it is rather than assuming there is none.
  return requested;
}

/**
 * Posts a request over the channel and waits for exactly one reply.
 *
 * SETTLES ON CANCELLATION TOO. A fill worker terminated mid-pass never answers,
 * and a promise that can never settle is a retained closure and an operation
 * the page waits on forever.
 */
async function exchange(
  port: ProtocolPort,
  cancellation: { readonly isCancelled: boolean; onCancelled(listener: () => void): () => void },
  send: () => void,
): Promise<HoleFillWorkerReply> {
  const channel = port as unknown as MessagePort;
  return new Promise<HoleFillWorkerReply>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      settled = true;
      channel.onmessage = null;
      unsubscribe();
    };

    const unsubscribe = cancellation.onCancelled(() => {
      if (settled) return;
      finish();
      reject(operationCancelled());
    });

    channel.onmessage = (event: MessageEvent<HoleFillWorkerReply>): void => {
      if (settled) return;
      finish();
      resolve(event.data);
    };

    channel.start();
    send();
  });
}
