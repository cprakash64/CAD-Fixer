/// <reference lib="webworker" />

import { runHoleFill, HoleFillStatus } from '@cadfixer/mesh-hole-fill';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { createKernelNarrowphase, loadHoleFillKernel } from './hole-fill-narrowphase';
import type {
  HoleFillGeometryMessage,
  HoleFillPortMessage,
  HoleFillWorkerOutbound,
  HoleFillWorkerReply,
} from './hole-fill-protocol';

/**
 * THE DISPOSABLE HOLE-FILL WORKER.
 *
 * WHY IT IS DISPOSABLE, and why that is not laziness. The fill runs as ONE
 * synchronous pass — loop resolution, triangulation, topology, broadphase, and
 * a long sequence of exact C++ narrowphase calls that poll no JavaScript flag.
 * A cooperative token could not be read until the pass returned, so a Cancel
 * button backed by one would quietly do nothing. Cancellation here is
 * `terminate()` from the controller, which stops the thread wherever it is.
 *
 * WHAT IT NEVER TOUCHES. The authoritative geometry worker is a different
 * worker and is never terminated. This one receives a DISPOSABLE COPY over a
 * MessageChannel and sends a candidate back the same way, so killing this
 * thread can take nothing authoritative with it — a refusal, a crash and a
 * cancellation all leave the user's model exactly as it was.
 *
 * THE KERNEL IS LOADED HERE AND ONLY HERE, for this operation. A user who never
 * fills a hole never pays for the WebAssembly, because this module is
 * constructed on demand.
 */

const post = (message: HoleFillWorkerOutbound): void => {
  self.postMessage(message);
};

/** Rebuilds the canonical mesh from the copy. No welding, no reordering. */
function meshFrom(message: HoleFillGeometryMessage): CanonicalMesh {
  return {
    positions: message.positions,
    indices: message.indices,
    // Honest: the copy carries geometry and nothing else. A source format the
    // fill did not read is not something to claim.
    metadata: {},
  };
}

async function runFill(port: MessagePort, message: HoleFillGeometryMessage): Promise<void> {
  const faceCount = Math.floor(message.indices.length / 3);
  post({ kind: 'started', operationId: message.operationId, faceCount });

  const module = await loadHoleFillKernel();
  const narrowphase = createKernelNarrowphase(module);

  const result = runHoleFill({
    source: meshFrom(message),
    request: {
      operationId: message.operationId,
      documentId: message.documentId,
      revision: message.documentRevision,
      partId: message.partId,
      boundaryLoopId: message.boundaryLoopId,
    },
    narrowphase,
    ...(message.limits === undefined ? {} : { limits: message.limits }),
    now: () => performance.now(),
  });

  const candidate = result.candidate;
  if (candidate === undefined || result.outcome.status !== HoleFillStatus.ValidCandidate) {
    const reply: HoleFillWorkerReply = {
      kind: 'result',
      operationId: message.operationId,
      status: result.outcome.status,
      summary: result.outcome.summary,
      intersectionSamples: result.outcome.intersectionSamples,
      samplesTruncated: result.outcome.samplesTruncated,
    };
    port.postMessage(reply, [result.outcome.intersectionSamples.buffer]);
    return;
  }

  /*
   * THE CANDIDATE'S POSITION BUFFER IS THE ONE THAT ARRIVED, shared by
   * reference because the triangulator adds no vertex and moves none. It is
   * copied here before transfer for one reason: the source mesh and the
   * candidate hold the SAME buffer, and transferring it once would detach it
   * from both. A fresh copy keeps the transfer list honest.
   */
  const positions = new Float32Array(candidate.positions);
  const indices = new Uint32Array(candidate.indices);
  const reply: HoleFillWorkerReply = {
    kind: 'result',
    operationId: message.operationId,
    status: result.outcome.status,
    summary: result.outcome.summary,
    intersectionSamples: result.outcome.intersectionSamples,
    samplesTruncated: result.outcome.samplesTruncated,
    positions,
    indices,
  };
  port.postMessage(reply, [
    positions.buffer,
    indices.buffer,
    result.outcome.intersectionSamples.buffer,
  ]);
}

self.addEventListener('message', (event: MessageEvent<HoleFillPortMessage>) => {
  const port = event.data.port;
  port.onmessage = (geometry: MessageEvent<HoleFillGeometryMessage>): void => {
    void runFill(port, geometry.data).catch((cause: unknown) => {
      /*
       * A FAILURE IS STILL AN ANSWER. The authoritative worker is awaiting this
       * channel; staying silent would leave its operation pending forever and
       * the panel saying "filling…" with nothing running.
       */
      const failure: HoleFillWorkerReply = {
        kind: 'failed',
        operationId: geometry.data.operationId,
        reason: cause instanceof Error ? cause.message : 'the hole-fill engine failed',
      };
      port.postMessage(failure);
    });
  };
  port.start();
  post({ kind: 'ready' });
});

export {};
