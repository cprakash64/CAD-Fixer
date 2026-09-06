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

  /**
   * PATCH-ATTRIBUTED PAIR CLASSIFICATION — Stage 4B-1B1.
   *
   * A second, narrower question against the SAME exact predicates: not "does
   * this mesh self-intersect" but "does any face this operation manufactured
   * take part in an invalid intersection". The caller's broadphase chooses the
   * pairs — it can query with a patch box, which the kernel's own all-pairs
   * tree cannot — and these entry points classify exactly those, attributing
   * every finding to patch/source or patch/patch.
   *
   * Geometry is uploaded ONCE by `begin` and pairs arrive in BATCHES, so no
   * caller ever has to materialise the full candidate product in memory.
   */
  _cf_hf_begin(
    positions: number,
    vertexCount: number,
    triangles: number,
    faceCount: number,
    patchFaceStart: number,
  ): number;
  _cf_hf_classify(pairs: number, pairCount: number, maxSamples: number): number;
  _cf_hf_end(): void;
  _cf_hf_failed(): number;
  _cf_hf_status(): number;
  _cf_hf_tested_pairs(): number;
  _cf_hf_skipped_pairs(): number;
  _cf_hf_ignored_pairs(): number;
  _cf_hf_unclassified_pairs(): number;
  _cf_hf_invalid_patch_source(): number;
  _cf_hf_invalid_patch_patch(): number;
  _cf_hf_proper_crossing(): number;
  _cf_hf_coplanar_overlap(): number;
  _cf_hf_point_touch(): number;
  _cf_hf_edge_touch(): number;
  _cf_hf_adjacent_beyond(): number;
  _cf_hf_duplicate(): number;
  _cf_hf_legitimate(): number;
  _cf_hf_sample_pairs(): number;
  _cf_hf_samples_truncated(): number;
  _cf_hf_samples(): number;

  _malloc(bytes: number): number;
  _free(pointer: number): void;
  readonly HEAPF64: Float64Array;
  readonly HEAPU32: Uint32Array;
}

declare function createSelfIntersectionKernel(
  moduleArg?: Record<string, unknown>,
): Promise<SelfIntersectionKernelModule>;

export default createSelfIntersectionKernel;
