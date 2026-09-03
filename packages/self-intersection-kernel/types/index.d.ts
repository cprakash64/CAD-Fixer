/**
 * Types for the Emscripten-generated kernel module.
 *
 * Hand-written because the glue is machine-generated JavaScript with no types
 * of its own. The exported surface is deliberately narrow: a factory returning
 * the flat C ABI declared in `src/binding.cpp`. Everything the diagnostic needs
 * is a number, a pointer or a typed-array view — no geometry is ever returned,
 * because a DIAGNOSTIC has no business handing back a mesh.
 */
export interface SelfIntersectionKernelModule {
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
  _cf_si_aabb_ms(): number;
  _cf_si_scan_ms(): number;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  readonly HEAPF64: Float64Array;
  readonly HEAPU32: Uint32Array;
}

declare function createSelfIntersectionKernel(
  moduleArg?: Record<string, unknown>,
): Promise<SelfIntersectionKernelModule>;

export default createSelfIntersectionKernel;
