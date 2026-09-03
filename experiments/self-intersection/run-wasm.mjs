/** Stage 3C-1A — WASM harness. RESEARCH ONLY. */
import createSiModule from './artifacts/si-wasm.js';

let modulePromise;
export async function getModule() {
  modulePromise ??= createSiModule();
  return modulePromise;
}

export async function runFixtureWasm(fixture, limits = {}) {
  const M = await getModule();
  const { maxCandidatePairs = 40000000, maxTestedPairs = 20000000, maxSamples = 4096 } = limits;

  const vertexCount = fixture.positions.length / 3;
  const faceCount = fixture.triangles.length / 3;

  const posBytes = vertexCount * 3 * 8;
  const triBytes = faceCount * 3 * 4;
  const posPtr = M._malloc(posBytes);
  const triPtr = M._malloc(triBytes);
  M.HEAPF64.set(Float64Array.from(fixture.positions), posPtr / 8);
  M.HEAPU32.set(Uint32Array.from(fixture.triangles), triPtr / 4);

  const t0 = performance.now();
  const status = M._cf_si_run(
    posPtr,
    vertexCount,
    triPtr,
    faceCount,
    maxCandidatePairs,
    maxTestedPairs,
    maxSamples,
  );
  const wallMs = performance.now() - t0;

  const sampleCount = M._cf_si_sample_pairs();
  const samplesPtr = M._cf_si_samples();
  const samples =
    sampleCount > 0
      ? Array.from(M.HEAPU32.subarray(samplesPtr / 4, samplesPtr / 4 + sampleCount * 3))
      : [];

  const out = {
    status,
    statusName: ['CHECKED', 'PARTIAL', 'RESOURCE_LIMIT', 'INTERNAL_FAILURE'][status],
    candidatePairCount: M._cf_si_candidate_pairs(),
    testedPairCount: M._cf_si_tested_pairs(),
    intersectingPairCount: M._cf_si_intersecting_pairs(),
    affectedFaceCount: M._cf_si_affected_faces(),
    properCrossing: M._cf_si_proper_crossing(),
    coplanarOverlap: M._cf_si_coplanar_overlap(),
    nonAdjacentPointTouch: M._cf_si_point_touch(),
    nonAdjacentEdgeTouch: M._cf_si_edge_touch(),
    adjacentOverlapBeyondShared: M._cf_si_adjacent_beyond(),
    duplicateTopologyDefect: M._cf_si_duplicate(),
    legitimateShared: M._cf_si_legitimate(),
    skippedDegenerateFaceCount: M._cf_si_skipped_faces(),
    skippedPairCount: M._cf_si_skipped_pairs(),
    samplePairCount: sampleCount,
    samplesTruncated: M._cf_si_samples_truncated() === 1,
    samples,
    aabbMs: M._cf_si_aabb_ms(),
    scanMs: M._cf_si_scan_ms(),
    wallMs,
    failed: M._cf_si_failed(),
  };

  M._free(posPtr);
  M._free(triPtr);
  return out;
}
