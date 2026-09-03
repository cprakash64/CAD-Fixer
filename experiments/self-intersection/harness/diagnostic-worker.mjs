/**
 * Stage 3C-1A DISPOSABLE diagnostic worker. RESEARCH ONLY.
 *
 * WHY DISPOSABLE. The Geogram narrowphase is a long SYNCHRONOUS C++ call. It
 * does not poll a JavaScript flag, and pretending otherwise would be the exact
 * dishonesty Stage 3B-1C removed from repair cancellation. So this worker is
 * built to be THROWN AWAY: cancellation is `Worker.terminate()` from the main
 * thread, which stops the thread wherever it is. The authoritative geometry
 * worker is a different worker and is never touched.
 *
 * It receives geometry either directly on a MessageChannel port from the
 * producer worker, or on its own message channel.
 */
import createSiModule from '../artifacts/si-wasm.js';

let modulePromise;
const moduleReady = () => (modulePromise ??= createSiModule());

async function runDiagnostic(payload, reply) {
  const M = await moduleReady();
  const { positions, triangles, limits = {} } = payload;
  const { maxCandidatePairs = 40000000, maxTestedPairs = 20000000, maxSamples = 4096 } = limits;

  const vertexCount = positions.length / 3;
  const faceCount = triangles.length / 3;

  const posPtr = M._malloc(vertexCount * 3 * 8);
  const triPtr = M._malloc(faceCount * 3 * 4);
  M.HEAPF64.set(positions, posPtr / 8);
  M.HEAPU32.set(triangles, triPtr / 4);

  const started = performance.now();
  const status = M._cf_si_run(
    posPtr,
    vertexCount,
    triPtr,
    faceCount,
    maxCandidatePairs,
    maxTestedPairs,
    maxSamples,
  );
  const elapsedMs = performance.now() - started;

  const report = {
    status,
    statusName: ['CHECKED', 'PARTIAL', 'RESOURCE_LIMIT', 'INTERNAL_FAILURE'][status],
    candidatePairCount: M._cf_si_candidate_pairs(),
    testedPairCount: M._cf_si_tested_pairs(),
    intersectingPairCount: M._cf_si_intersecting_pairs(),
    affectedFaceCount: M._cf_si_affected_faces(),
    properCrossing: M._cf_si_proper_crossing(),
    coplanarOverlap: M._cf_si_coplanar_overlap(),
    duplicateTopologyDefect: M._cf_si_duplicate(),
    legitimateShared: M._cf_si_legitimate(),
    skippedDegenerateFaceCount: M._cf_si_skipped_faces(),
    samplePairCount: M._cf_si_sample_pairs(),
    samplesTruncated: M._cf_si_samples_truncated() === 1,
    aabbMs: M._cf_si_aabb_ms(),
    scanMs: M._cf_si_scan_ms(),
    elapsedMs,
    heapBytes: M.HEAPU32.buffer.byteLength,
  };

  M._free(posPtr);
  M._free(triPtr);
  reply({ kind: 'result', report });
}

self.addEventListener('message', (event) => {
  const data = event.data;

  // OPTION B WIRING: the main thread hands this worker one end of a channel it
  // shares with the geometry producer. Geometry then travels producer -> here
  // WITHOUT passing through the page.
  if (data?.kind === 'port') {
    const port = data.port;
    port.onmessage = (e) => {
      if (e.data?.kind === 'geometry') {
        void runDiagnostic(e.data, (msg) => {
          self.postMessage(msg);
        });
      }
    };
    port.start?.();
    self.postMessage({ kind: 'port-ready' });
    return;
  }

  if (data?.kind === 'geometry') {
    void runDiagnostic(data, (msg) => {
      self.postMessage(msg);
    });
    return;
  }

  if (data?.kind === 'ping') self.postMessage({ kind: 'pong' });
});
