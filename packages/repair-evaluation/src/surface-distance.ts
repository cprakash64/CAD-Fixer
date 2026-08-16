import { computeBounds } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  buildTriangleBvh,
  flattenTriangles,
  nearestTriangleDistanceSquared,
  type TriangleBvh,
} from './bvh';

/**
 * SYMMETRIC SAMPLED SURFACE DISTANCE — evaluation only.
 *
 * RESEARCH ONLY. Never imported by `apps/**` or by any worker.
 *
 * WHAT THIS IS, PRECISELY. For each direction it draws a bounded, deterministic,
 * area-weighted set of sample points on one surface and measures each one's
 * exact distance to the nearest triangle of the other. It then reports the
 * distribution of those distances, in both directions.
 *
 * WHAT THIS IS NOT: the Hausdorff distance. Hausdorff is a supremum over the
 * whole surface; this is a maximum over a finite sample, and a sample can miss
 * a spike thinner than its own spacing. Calling it Hausdorff would turn a
 * bounded estimate into a guarantee we have not earned, so the name says
 * "sampled" and every reported maximum is a SAMPLED maximum. Under-reporting is
 * the failure mode: this metric can say a change is smaller than it is, and
 * never that a change exists when it does not.
 *
 * WHY SYMMETRY IS NOT OPTIONAL. One direction alone is blind in a way that
 * matters here. Sampling only A->B cannot see geometry that B ADDED — every
 * sample of A still sits on B's surface, so a protrusion grown by a repair
 * scores zero. Sampling only B->A cannot see geometry that B DELETED. A repair
 * kernel does both, so the evaluator must measure both. Test
 * `added-protrusion` and `removed-feature` pin exactly this.
 *
 * THE POLICY QUESTION IS SOMEWHERE ELSE. A non-zero distance means the geometry
 * changed, not that the kernel misbehaved: filling a hole is supposed to change
 * geometry. This module quantifies; `corpus.ts` acceptance criteria judge.
 */

/** Nearest-rank percentiles, deterministic for a given sorted sample. */
function percentile(sortedAscending: readonly number[], fraction: number): number {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  const rank = Math.ceil(fraction * n);
  const index = Math.min(n - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? 0;
}

export interface SurfaceDistanceOptions {
  /**
   * Samples per direction. BOUNDED, never proportional to area: a metric whose
   * cost grew with the model would be unusable on exactly the large models
   * where preservation matters most.
   */
  readonly samplesPerDirection?: number;
  /** Shifts the low-discrepancy sequence. Recorded in the result. */
  readonly seed?: number;
}

export const DEFAULT_SURFACE_DISTANCE_OPTIONS = {
  samplesPerDirection: 20000,
  seed: 1,
} as const;

export interface DirectionalSurfaceDistance {
  readonly sampleCount: number;
  readonly meanDistance: number;
  readonly rmsDistance: number;
  /** Maximum over the SAMPLE, not over the surface. */
  readonly maxSampledDistance: number;
  readonly p95Distance: number;
  readonly p99Distance: number;
}

export interface SymmetricSampledSurfaceDistanceResult {
  readonly aToB: DirectionalSurfaceDistance;
  readonly bToA: DirectionalSurfaceDistance;
  /** Pooled over both directions' samples. */
  readonly combinedRmsDistance: number;
  readonly combinedMaxSampledDistance: number;
  readonly combinedP95Distance: number;
  readonly combinedP99Distance: number;
  /**
   * Reference scale: the bounding-box diagonal of mesh A.
   *
   * `undefined` when A has no extent — a single point or an empty mesh. Never
   * substituted with 1, because a normalised number computed against an
   * invented scale is worse than an absent one.
   */
  readonly referenceBoundingBoxDiagonal: number | undefined;
  readonly normalisedCombinedRmsDistance: number | undefined;
  readonly normalisedCombinedMaxSampledDistance: number | undefined;
  readonly configuration: {
    readonly samplesPerDirection: number;
    readonly seed: number;
    readonly percentileMethod: 'nearest-rank';
    readonly samplingMode: 'area-weighted-stratified' | 'uniform-per-triangle-zero-area';
  };
  /**
   * True when a mesh had no usable area and sampling fell back to a uniform
   * per-triangle scheme. Surfaced so a reader never mistakes a degenerate
   * fixture's numbers for area-weighted ones.
   */
  readonly degenerateAreaFallback: boolean;
}

/**
 * Radical inverse in a given base — the Halton sequence's building block.
 *
 * A HASH-FREE DETERMINISTIC SEQUENCE, chosen over `Math.random` (not
 * reproducible) and over a seeded LCG (reproducible but clumpy at these sample
 * counts). Halton stratifies the unit square evenly, so a bounded sample covers
 * a triangle rather than clustering.
 */
function radicalInverse(index: number, base: number): number {
  let result = 0;
  let denominator = 1;
  let n = index;
  while (n > 0) {
    denominator *= base;
    result += (n % base) / denominator;
    n = Math.floor(n / base);
  }
  return result;
}

interface SampleSet {
  readonly points: Float64Array;
  readonly count: number;
  readonly degenerate: boolean;
}

/**
 * Draws `count` points on a mesh's surface, area-weighted and deterministic.
 *
 * STRATIFIED BY CUMULATIVE AREA rather than sampled by rejection: target
 * positions (k + 0.5)/N of the total area are walked in order, so a triangle
 * holding 40% of the surface receives ~40% of the samples and a sliver receives
 * approximately none. That is the property the spec calls area-aware, and it is
 * why a subdivided-but-identical surface scores the same as its original: the
 * samples follow area, not triangle count.
 */
function sampleSurface(corners: Float64Array, count: number, seed: number): SampleSet {
  const triangles = Math.floor(corners.length / 9);
  const points = new Float64Array(count * 3);
  if (triangles === 0 || count === 0) {
    return { points: new Float64Array(0), count: 0, degenerate: false };
  }

  const cumulative = new Float64Array(triangles);
  let total = 0;
  for (let t = 0; t < triangles; t += 1) {
    const ax = corners[t * 9] ?? 0;
    const ay = corners[t * 9 + 1] ?? 0;
    const az = corners[t * 9 + 2] ?? 0;
    const bx = corners[t * 9 + 3] ?? 0;
    const by = corners[t * 9 + 4] ?? 0;
    const bz = corners[t * 9 + 5] ?? 0;
    const cx = corners[t * 9 + 6] ?? 0;
    const cy = corners[t * 9 + 7] ?? 0;
    const cz = corners[t * 9 + 8] ?? 0;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    total += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    cumulative[t] = total;
  }

  // A mesh of only zero-area faces has no area to weight by. R05 and R06 both
  // contain such faces, and a candidate can emit a mesh made entirely of them.
  // Spreading samples evenly across triangles is the honest fallback, and the
  // result records that it happened.
  const degenerate = !(total > 0);

  for (let k = 0; k < count; k += 1) {
    let triangle: number;
    if (degenerate) {
      triangle = Math.min(triangles - 1, Math.floor((k * triangles) / count));
    } else {
      const target = ((k + 0.5) / count) * total;
      // Binary search over the cumulative areas: linear scanning here would
      // make sampling O(N x triangles) and quietly reintroduce the cost the
      // BVH exists to remove.
      let low = 0;
      let high = triangles - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((cumulative[middle] ?? 0) < target) low = middle + 1;
        else high = middle;
      }
      triangle = low;
    }

    const index = k + 1 + seed;
    const u1 = radicalInverse(index, 2);
    const u2 = radicalInverse(index, 3);
    // Square-root warp: the uniform map onto a triangle. Using u1,u2 directly
    // as barycentric weights would bias samples toward one corner.
    const su = Math.sqrt(u1);
    const w0 = 1 - su;
    const w1 = su * (1 - u2);
    const w2 = su * u2;

    const base = triangle * 9;
    points[k * 3] =
      w0 * (corners[base] ?? 0) + w1 * (corners[base + 3] ?? 0) + w2 * (corners[base + 6] ?? 0);
    points[k * 3 + 1] =
      w0 * (corners[base + 1] ?? 0) + w1 * (corners[base + 4] ?? 0) + w2 * (corners[base + 7] ?? 0);
    points[k * 3 + 2] =
      w0 * (corners[base + 2] ?? 0) + w1 * (corners[base + 5] ?? 0) + w2 * (corners[base + 8] ?? 0);
  }

  return { points, count, degenerate };
}

function measureDirection(
  samples: SampleSet,
  target: TriangleBvh,
): { summary: DirectionalSurfaceDistance; distances: number[] } {
  const distances: number[] = [];
  let sumSquares = 0;
  let sum = 0;
  let max = 0;

  for (let k = 0; k < samples.count; k += 1) {
    const squared = nearestTriangleDistanceSquared(
      target,
      samples.points[k * 3] ?? 0,
      samples.points[k * 3 + 1] ?? 0,
      samples.points[k * 3 + 2] ?? 0,
    );
    // An empty target yields Infinity. Kept as Infinity rather than clamped:
    // "we compared against nothing" must not read as "the surfaces coincide".
    const distance =
      squared === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.sqrt(squared);
    distances.push(distance);
    sum += distance;
    sumSquares += distance * distance;
    if (distance > max) max = distance;
  }

  const sorted = [...distances].sort((left, right) => left - right);
  return {
    summary: {
      sampleCount: samples.count,
      meanDistance: samples.count === 0 ? 0 : sum / samples.count,
      rmsDistance: samples.count === 0 ? 0 : Math.sqrt(sumSquares / samples.count),
      maxSampledDistance: max,
      p95Distance: percentile(sorted, 0.95),
      p99Distance: percentile(sorted, 0.99),
    },
    distances,
  };
}

/**
 * Measures how far two surfaces are from each other, in both directions.
 *
 * `a` is the reference: its bounding box provides the normalisation scale, so
 * for a repair comparison pass the INPUT as `a` and the output as `b`.
 */
export function symmetricSampledSurfaceDistance(
  a: CanonicalMesh,
  b: CanonicalMesh,
  options: SurfaceDistanceOptions = {},
): SymmetricSampledSurfaceDistanceResult {
  const samplesPerDirection =
    options.samplesPerDirection ?? DEFAULT_SURFACE_DISTANCE_OPTIONS.samplesPerDirection;
  const seed = options.seed ?? DEFAULT_SURFACE_DISTANCE_OPTIONS.seed;

  const cornersA = flattenTriangles(a);
  const cornersB = flattenTriangles(b);
  const bvhA = buildTriangleBvh(cornersA);
  const bvhB = buildTriangleBvh(cornersB);

  const samplesA = sampleSurface(cornersA, samplesPerDirection, seed);
  const samplesB = sampleSurface(cornersB, samplesPerDirection, seed);

  const forward = measureDirection(samplesA, bvhB);
  const backward = measureDirection(samplesB, bvhA);

  const pooled = [...forward.distances, ...backward.distances].sort((left, right) => left - right);
  let pooledSquares = 0;
  for (const distance of pooled) pooledSquares += distance * distance;
  const combinedRms = pooled.length === 0 ? 0 : Math.sqrt(pooledSquares / pooled.length);
  const combinedMax = Math.max(
    forward.summary.maxSampledDistance,
    backward.summary.maxSampledDistance,
  );

  const bounds = computeBounds(a);
  const diagonal =
    bounds === undefined
      ? undefined
      : Math.sqrt(
          bounds.size[0] * bounds.size[0] +
            bounds.size[1] * bounds.size[1] +
            bounds.size[2] * bounds.size[2],
        );
  // A zero diagonal is a real case (R27 is tiny; a single point has none) and
  // dividing by it would emit Infinity or NaN dressed up as a measurement.
  const usableDiagonal = diagonal !== undefined && diagonal > 0 ? diagonal : undefined;

  return {
    aToB: forward.summary,
    bToA: backward.summary,
    combinedRmsDistance: combinedRms,
    combinedMaxSampledDistance: combinedMax,
    combinedP95Distance: percentile(pooled, 0.95),
    combinedP99Distance: percentile(pooled, 0.99),
    referenceBoundingBoxDiagonal: usableDiagonal,
    normalisedCombinedRmsDistance:
      usableDiagonal === undefined ? undefined : combinedRms / usableDiagonal,
    normalisedCombinedMaxSampledDistance:
      usableDiagonal === undefined ? undefined : combinedMax / usableDiagonal,
    configuration: {
      samplesPerDirection,
      seed,
      percentileMethod: 'nearest-rank',
      samplingMode:
        samplesA.degenerate || samplesB.degenerate
          ? 'uniform-per-triangle-zero-area'
          : 'area-weighted-stratified',
    },
    degenerateAreaFallback: samplesA.degenerate || samplesB.degenerate,
  };
}
