/// <reference lib="webworker" />

import {
  SelfIntersectionStatus,
  type SelfIntersectionReport,
} from '@cadfixer/mesh-self-intersection';
import createSelfIntersectionKernel from '@cadfixer/self-intersection-kernel';
import type {
  DiagnosticGeometryMessage,
  DiagnosticPortMessage,
  DiagnosticWorkerOutbound,
} from './self-intersection-protocol';
import { describeMalformedGeometry } from './self-intersection-validation';

/**
 * THE DISPOSABLE SELF-INTERSECTION WORKER.
 *
 * WHY IT IS DISPOSABLE, and why that is not laziness. Geogram's narrowphase is
 * a long SYNCHRONOUS C++ call that does not poll a JavaScript flag, so the
 * cooperative shared-memory cancellation Stage 3B-1C built for repair CANNOT
 * reach inside it. Rather than ship a Cancel button that quietly does nothing,
 * this worker is built to be thrown away: cancellation is `terminate()` from the
 * controller, which stops the thread wherever it happens to be.
 *
 * WHAT IT NEVER TOUCHES. The authoritative geometry worker is a different
 * worker and is never terminated. This one receives a DISPOSABLE COPY of the
 * geometry directly from that worker over a MessageChannel, so the page never
 * holds coordinates and killing this thread can take nothing authoritative with
 * it.
 *
 * THE KERNEL IS LOADED HERE AND ONLY HERE. A user who never runs the diagnostic
 * never pays for the ~1.2 MB of WebAssembly, because this module is the only
 * thing that imports it and this worker is only constructed on demand.
 */

const SCHEMA_VERSION = 1;

/** Provenance, so a report can always be traced to the kernel that produced it. */
const ENGINE = Object.freeze({
  name: 'geogram',
  version: 'v1.10.0',
  commit: 'c8529bb00838186938ab31d96008a59b6a892dee',
});

const STATUS_BY_CODE: Readonly<Record<number, SelfIntersectionStatus>> = Object.freeze({
  0: SelfIntersectionStatus.Checked,
  1: SelfIntersectionStatus.Partial,
  2: SelfIntersectionStatus.ResourceLimit,
  3: SelfIntersectionStatus.InternalFailure,
});

interface KernelModule {
  _cf_si_run(
    positions: number,
    vertexCount: number,
    triangles: number,
    faceCount: number,
    maxCandidatePairs: number,
    maxTestedPairs: number,
    maxSamples: number,
  ): number;
  _cf_si_failed(): number;
  _cf_si_candidate_pairs(): number;
  _cf_si_tested_pairs(): number;
  _cf_si_intersecting_pairs(): number;
  _cf_si_affected_faces(): number;
  _cf_si_proper_crossing(): number;
  _cf_si_coplanar_overlap(): number;
  _cf_si_point_touch(): number;
  _cf_si_edge_touch(): number;
  _cf_si_adjacent_beyond(): number;
  _cf_si_duplicate(): number;
  _cf_si_legitimate(): number;
  _cf_si_skipped_faces(): number;
  _cf_si_skipped_pairs(): number;
  _cf_si_unclassified_pairs(): number;
  _cf_si_sample_pairs(): number;
  _cf_si_samples_truncated(): number;
  _cf_si_samples(): number;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  readonly HEAPF64: Float64Array;
  readonly HEAPU32: Uint32Array;
}

let kernelPromise: Promise<KernelModule> | undefined;
const kernel = async (): Promise<KernelModule> => {
  kernelPromise ??= createSelfIntersectionKernel() as Promise<KernelModule>;
  return kernelPromise;
};

const post = (message: DiagnosticWorkerOutbound): void => {
  self.postMessage(message);
};

async function runDiagnostic(message: DiagnosticGeometryMessage): Promise<void> {
  const malformed = describeMalformedGeometry(message);
  if (malformed !== undefined) {
    post({ kind: 'failed', operationId: message.operationId, reason: malformed });
    return;
  }

  const module = await kernel();
  const { positions, triangles, limits } = message;
  const vertexCount = positions.length / 3;
  const faceCount = triangles.length / 3;

  post({ kind: 'started', operationId: message.operationId, faceCount });

  const positionsPointer = module._malloc(positions.byteLength);
  const trianglesPointer = module._malloc(triangles.byteLength);
  try {
    module.HEAPF64.set(positions, positionsPointer / Float64Array.BYTES_PER_ELEMENT);
    module.HEAPU32.set(triangles, trianglesPointer / Uint32Array.BYTES_PER_ELEMENT);

    const statusCode = module._cf_si_run(
      positionsPointer,
      vertexCount,
      trianglesPointer,
      faceCount,
      limits.maxCandidatePairs,
      limits.maxTestedPairs,
      limits.maxSamples,
    );

    const samplePairCount = module._cf_si_sample_pairs();
    const samplesPointer = module._cf_si_samples();
    // Copied out of the heap deliberately: a view into WASM memory would dangle
    // the moment the heap grows or this worker is terminated.
    const samples =
      samplePairCount > 0
        ? Uint32Array.from(
            module.HEAPU32.subarray(
              samplesPointer / Uint32Array.BYTES_PER_ELEMENT,
              samplesPointer / Uint32Array.BYTES_PER_ELEMENT + samplePairCount * 3,
            ),
          )
        : new Uint32Array(0);

    const report: SelfIntersectionReport = {
      schemaVersion: SCHEMA_VERSION,
      status:
        module._cf_si_failed() === 1
          ? SelfIntersectionStatus.InternalFailure
          : (STATUS_BY_CODE[statusCode] ?? SelfIntersectionStatus.InternalFailure),
      documentId: message.documentId,
      documentRevision: message.documentRevision,
      partId: message.partId,
      faceCount,
      intersectingPairCount: module._cf_si_intersecting_pairs(),
      affectedFaceCount: module._cf_si_affected_faces(),
      categories: {
        properCrossing: module._cf_si_proper_crossing(),
        coplanarOverlap: module._cf_si_coplanar_overlap(),
        nonAdjacentPointTouch: module._cf_si_point_touch(),
        nonAdjacentEdgeTouch: module._cf_si_edge_touch(),
        adjacentOverlapBeyondShared: module._cf_si_adjacent_beyond(),
        duplicateTopologyDefect: module._cf_si_duplicate(),
        legitimateShared: module._cf_si_legitimate(),
      },
      skippedDegenerateFaceCount: module._cf_si_skipped_faces(),
      skippedPairCount: module._cf_si_skipped_pairs(),
      unclassifiedPairCount: module._cf_si_unclassified_pairs(),
      candidatePairCount: module._cf_si_candidate_pairs(),
      testedPairCount: module._cf_si_tested_pairs(),
      samples,
      samplePairCount,
      samplesTruncated: module._cf_si_samples_truncated() === 1,
      engine: ENGINE,
    };

    post({ kind: 'report', operationId: message.operationId, report });
  } finally {
    module._free(positionsPointer);
    module._free(trianglesPointer);
  }
}

self.addEventListener('message', (event: MessageEvent<DiagnosticPortMessage>) => {
  const data = event.data;

  // One inbound message kind today. Destructured rather than compared so the
  // check does not become a tautology the linter is right to object to.
  {
    // OPTION B WIRING. Geometry arrives from the AUTHORITATIVE worker over this
    // channel, never through the page.
    const port = data.port;
    port.onmessage = (geometry: MessageEvent<DiagnosticGeometryMessage>): void => {
      void runDiagnostic(geometry.data).catch((cause: unknown) => {
        post({
          kind: 'failed',
          operationId: geometry.data.operationId,
          reason: cause instanceof Error ? cause.message : 'self-intersection kernel failed',
        });
      });
    };
    port.start();
    post({ kind: 'ready' });
  }
});

export {};
