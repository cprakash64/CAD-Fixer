import createSelfIntersectionKernel from '@cadfixer/self-intersection-kernel';
import type {
  NarrowphaseBatchResult,
  NarrowphaseGeometry,
  NarrowphaseSamples,
  PatchNarrowphase,
} from '@cadfixer/mesh-hole-fill';

/**
 * THE PRODUCTION NARROWPHASE FOR HOLE FILLING: the qualified Geogram kernel.
 *
 * WHY NOT A LOCAL IMPLEMENTATION. Stage 4B-1A validated its patches with a
 * separating-axis checker written for the research harness. That checker exists
 * to be a SECOND opinion and is deliberately weaker than the production
 * predicate: it has no exact predicates, and it excludes any pair sharing a
 * welded vertex, so it cannot see an overlap that goes BEYOND a legitimately
 * shared edge. Shipping it as the only safety predicate would be replacing a
 * qualified exact classifier with an approximation — precisely what §32 of the
 * stage brief forbids.
 *
 * WHAT IS REUSED, AND HOW MUCH. Everything that decides the answer:
 *
 *   - `GEO::triangles_intersections`, the exact symbolic narrowphase, called
 *     through the INDEXED overload so Geogram reasons about the vertices two
 *     faces genuinely share rather than rediscovering coincidence from
 *     coordinates;
 *   - `classify_pair`, the frozen Stage 3C taxonomy, so a legitimate shared
 *     edge, a coplanar area overlap, an overlap beyond a shared edge and a
 *     non-adjacent touch mean here EXACTLY what they mean in the diagnostic;
 *   - `is_degenerate_face` and `shared_vertex_count`, so adjacency comes from
 *     Stage 2's exact stored-coordinate identity and nothing else;
 *   - the duplicate guard and the capacity guard, so a fixed-buffer overflow
 *     degrades to one unclassified pair and a PARTIAL verdict instead of
 *     killing this worker.
 *
 * `si_core.h` and `si_bvh.h` are UNTOUCHED and stay byte-identical to
 * `experiments/self-intersection/`, which `kernel-integrity.test.ts` asserts.
 * What Stage 4B-1B1 added to `binding.cpp` is an entry point that classifies a
 * caller-supplied LIST of pairs and attributes each finding to patch/source or
 * patch/patch — a different question, answered by the same predicates.
 * `cf_si_run` is not modified and does not observe any of this state.
 *
 * THE KERNEL IS LOADED HERE AND IN THE DIAGNOSTIC WORKER, AND NOWHERE ELSE. A
 * user who never fills a hole and never runs a check never downloads the ~1.2 MB
 * of WebAssembly, and the production boundary scan asserts the confinement.
 */

/** Status codes returned by the kernel, mirroring `SiStatus`. */
const KERNEL_CHECKED = 0;
const KERNEL_PARTIAL = 1;

interface HoleFillKernelModule {
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
  _cf_hf_unclassified_pairs(): number;
  _cf_hf_invalid_patch_source(): number;
  _cf_hf_invalid_patch_patch(): number;
  _cf_hf_sample_pairs(): number;
  _cf_hf_samples_truncated(): number;
  _cf_hf_samples(): number;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  readonly HEAPF64: Float64Array;
  readonly HEAPU32: Uint32Array;
}

/**
 * How the kernel module is obtained.
 *
 * INJECTABLE so the same narrowphase can be exercised under Node with the
 * binary supplied directly. The Emscripten glue is built for `web,worker` and
 * fetches its `.wasm` relative to `import.meta.url`, which no test runner can
 * satisfy — passing `wasmBinary` skips the fetch entirely. It is a CONSTRUCTION
 * seam, not a behaviour switch: the module that loads is the same artifact
 * either way, and nothing in the product can select another.
 */
export type HoleFillKernelLoader = () => Promise<HoleFillKernelModule>;

// No assertion: the kernel's own declarations already carry the `cf_hf_*`
// surface, so the module satisfies this narrower interface structurally. The
// narrow interface is kept because it states exactly what this file uses.
const defaultLoader: HoleFillKernelLoader = async () => createSelfIntersectionKernel();

let cached: Promise<HoleFillKernelModule> | undefined;

/**
 * Loads the kernel once per worker.
 *
 * The module is heavy to instantiate and completely stateless between
 * operations — `cf_hf_begin` resets everything it owns — so one instance per
 * worker is correct. The worker itself is disposable, so the cache dies with it.
 */
export async function loadHoleFillKernel(
  loader: HoleFillKernelLoader = defaultLoader,
): Promise<HoleFillKernelModule> {
  cached ??= loader();
  return cached;
}

/** Test-only: forgets the cached module so a fresh loader can be injected. */
export function resetHoleFillKernelForTesting(): void {
  cached = undefined;
}

/**
 * Wraps a loaded kernel as the engine's `PatchNarrowphase`.
 *
 * ALLOCATION HAPPENS IN `begin` AND IS RELEASED IN `end`, including when a
 * batch threw: the engine calls `end` from a `finally`, so a failed run cannot
 * leave the kernel holding a copy of the candidate.
 */
export function createKernelNarrowphase(module: HoleFillKernelModule): PatchNarrowphase {
  let positionsPointer = 0;
  let trianglesPointer = 0;
  let pairsPointer = 0;
  let pairsCapacity = 0;
  let maxSamples = 0;
  let active = false;

  const release = (): void => {
    if (positionsPointer !== 0) module._free(positionsPointer);
    if (trianglesPointer !== 0) module._free(trianglesPointer);
    if (pairsPointer !== 0) module._free(pairsPointer);
    positionsPointer = 0;
    trianglesPointer = 0;
    pairsPointer = 0;
    pairsCapacity = 0;
  };

  return {
    begin(geometry: NarrowphaseGeometry): void {
      release();
      maxSamples = geometry.maxSamples;

      positionsPointer = module._malloc(geometry.positions.byteLength);
      trianglesPointer = module._malloc(geometry.triangles.byteLength);
      module.HEAPF64.set(geometry.positions, positionsPointer / Float64Array.BYTES_PER_ELEMENT);
      module.HEAPU32.set(geometry.triangles, trianglesPointer / Uint32Array.BYTES_PER_ELEMENT);

      const status = module._cf_hf_begin(
        positionsPointer,
        geometry.positions.length / 3,
        trianglesPointer,
        geometry.triangles.length / 3,
        geometry.patchFaceStart,
      );
      active = status === KERNEL_CHECKED && module._cf_hf_failed() === 0;
    },

    classify(pairs: Uint32Array, pairCount: number): NarrowphaseBatchResult {
      const empty: NarrowphaseBatchResult = {
        complete: false,
        testedPairs: 0,
        skippedPairs: 0,
        unclassifiedPairs: pairCount,
        invalidPatchSourcePairs: 0,
        invalidPatchPatchPairs: 0,
      };
      if (!active) return empty;

      /*
       * ONE REUSED HEAP BUFFER, grown only when a larger batch arrives. The
       * engine hands the same fixed 8,192-pair array every time, so this
       * allocates once for a whole operation however many candidates the
       * broadphase produced.
       */
      const needed = pairCount * 2;
      if (needed > pairsCapacity) {
        if (pairsPointer !== 0) module._free(pairsPointer);
        pairsPointer = module._malloc(needed * Uint32Array.BYTES_PER_ELEMENT);
        pairsCapacity = needed;
      }
      module.HEAPU32.set(pairs.subarray(0, needed), pairsPointer / Uint32Array.BYTES_PER_ELEMENT);

      const before = {
        tested: module._cf_hf_tested_pairs(),
        skipped: module._cf_hf_skipped_pairs(),
        unclassified: module._cf_hf_unclassified_pairs(),
        patchSource: module._cf_hf_invalid_patch_source(),
        patchPatch: module._cf_hf_invalid_patch_patch(),
      };

      const status = module._cf_hf_classify(pairsPointer, pairCount, maxSamples);
      if (module._cf_hf_failed() === 1) {
        active = false;
        return empty;
      }

      return {
        // PARTIAL means at least one pair could not be examined, and a pair
        // that could not be examined must never be absorbed into a clean
        // verdict. The engine treats an incomplete batch as a failure.
        complete: status === KERNEL_CHECKED,
        testedPairs: module._cf_hf_tested_pairs() - before.tested,
        skippedPairs: module._cf_hf_skipped_pairs() - before.skipped,
        unclassifiedPairs: module._cf_hf_unclassified_pairs() - before.unclassified,
        invalidPatchSourcePairs: module._cf_hf_invalid_patch_source() - before.patchSource,
        invalidPatchPatchPairs: module._cf_hf_invalid_patch_patch() - before.patchPatch,
      };
    },

    samples(): NarrowphaseSamples {
      if (!active) return { samples: new Uint32Array(0), truncated: false };
      const count = module._cf_hf_sample_pairs();
      const pointer = module._cf_hf_samples();
      // COPIED OUT of the heap deliberately: a view into WASM memory would
      // dangle the moment the heap grows or this worker is terminated.
      const samples =
        count > 0
          ? Uint32Array.from(
              module.HEAPU32.subarray(
                pointer / Uint32Array.BYTES_PER_ELEMENT,
                pointer / Uint32Array.BYTES_PER_ELEMENT + count * 3,
              ),
            )
          : new Uint32Array(0);
      return { samples, truncated: module._cf_hf_samples_truncated() === 1 };
    },

    end(): void {
      if (active) module._cf_hf_end();
      active = false;
      release();
    },
  };
}

/** Exposed so a test can assert the PARTIAL code has not moved. */
export const HOLE_FILL_KERNEL_STATUS = Object.freeze({
  checked: KERNEL_CHECKED,
  partial: KERNEL_PARTIAL,
});
