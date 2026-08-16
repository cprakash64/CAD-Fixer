import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, IDENTITY_MATRIX4 } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  bruteForceNearestDistanceSquared,
  buildTriangleBvh,
  flattenTriangles,
  nearestTriangleDistanceSquared,
  pointTriangleDistanceSquared,
} from './bvh';
import { CORPUS } from './corpus';
import { box, soup, tetrahedron, translate, type Point, type Triangle } from './geometry';
import { symmetricSampledSurfaceDistance } from './surface-distance';

/**
 * Tests for the evaluation-only preservation metric.
 *
 * THE METRIC IS ITSELF EVIDENCE, so it needs the same scepticism as a
 * candidate: a preservation number that silently read zero would let a kernel
 * that destroyed a model pass the bakeoff. Every case below is either a
 * geometry change the metric MUST see, or an encoding change it must NOT see.
 */

/** Smaller than any real geometric change in these fixtures, larger than fp noise. */
const NEAR_ZERO = 1e-9;

/** Enough samples to hit a feature, few enough to keep the suite quick. */
const FAST = { samplesPerDirection: 2000, seed: 1 } as const;

function meshOf(triangles: readonly Triangle[]): CanonicalMesh {
  return soup(triangles);
}

describe('point-to-triangle distance', () => {
  const ax = 0;
  const ay = 0;
  const az = 0;
  const bx = 1;
  const by = 0;
  const bz = 0;
  const cx = 0;
  const cy = 1;
  const cz = 0;

  const distance = (px: number, py: number, pz: number): number =>
    Math.sqrt(pointTriangleDistanceSquared(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz));

  it('measures the perpendicular for a point over the face interior', () => {
    expect(distance(0.25, 0.25, 3)).toBeCloseTo(3, 12);
  });

  it('measures to the nearest vertex outside a corner region', () => {
    // Beyond corner A, along the negative diagonal.
    expect(distance(-1, -1, 0)).toBeCloseTo(Math.SQRT2, 12);
  });

  it('measures to the nearest edge outside an edge region', () => {
    // Outside the hypotenuse; nearest point is its midpoint.
    expect(distance(1, 1, 0)).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('returns zero for a point exactly on a vertex', () => {
    expect(distance(0, 0, 0)).toBe(0);
    expect(distance(1, 0, 0)).toBe(0);
  });

  it('handles a zero-area target by falling back to its edges', () => {
    // A degenerate "triangle" that is really the segment (0,0,0)-(2,0,0).
    // The nearest point to (1,4,0) is (1,0,0), so the distance is 4 — not NaN,
    // which is what an unguarded barycentric solve produces here.
    const value = Math.sqrt(pointTriangleDistanceSquared(1, 4, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0));
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeCloseTo(4, 12);
  });

  it('handles a fully collapsed target', () => {
    const value = Math.sqrt(pointTriangleDistanceSquared(0, 3, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1));
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeCloseTo(Math.sqrt(1 + 4 + 1), 12);
  });
});

describe('BVH against the brute-force oracle', () => {
  /**
   * THE ANTI-FABRICATION CHECK. If the hierarchy ever prunes a branch that
   * held the true nearest triangle, preservation numbers would come out too
   * small and every candidate would look more conservative than it is. The
   * accelerated and unaccelerated paths must agree exactly — they minimise the
   * same function over the same set, so anything but equality is a bug.
   */
  it('agrees exactly on a non-trivial mesh over a dense query grid', () => {
    const catastrophic = CORPUS.find((fixture) => fixture.id === 'R29');
    expect(catastrophic).toBeDefined();
    if (catastrophic === undefined) return;

    const corners = flattenTriangles(catastrophic.build());
    const bvh = buildTriangleBvh(corners);
    expect(bvh.triangleCount).toBe(200);

    let compared = 0;
    for (let x = -4; x <= 14; x += 3) {
      for (let y = -4; y <= 14; y += 3) {
        for (let z = -4; z <= 14; z += 3) {
          const accelerated = nearestTriangleDistanceSquared(bvh, x, y, z);
          const exhaustive = bruteForceNearestDistanceSquared(corners, x, y, z);
          expect(accelerated).toBe(exhaustive);
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(200);
  });

  it('agrees on every corpus fixture at its own bounding-box corners', () => {
    for (const fixture of CORPUS) {
      const corners = flattenTriangles(fixture.build());
      if (corners.length === 0) continue;
      const bvh = buildTriangleBvh(corners);
      for (const [x, y, z] of [
        [0, 0, 0],
        [5, 5, 5],
        [-13, 7, 2],
        [1e3, 1e3, 1e3],
      ] as const) {
        expect(nearestTriangleDistanceSquared(bvh, x, y, z)).toBe(
          bruteForceNearestDistanceSquared(corners, x, y, z),
        );
      }
    }
  });

  it('reports Infinity rather than zero for an empty target', () => {
    const bvh = buildTriangleBvh(new Float64Array(0));
    expect(nearestTriangleDistanceSquared(bvh, 0, 0, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  /**
   * REGRESSION: node capacity.
   *
   * The first version sized the node array as 2*ceil(N/LEAF_SIZE), which
   * assumed leaves are full. Median splitting produces leaves of 2 or 3, so a
   * 200-triangle mesh overflowed. Typed arrays swallow out-of-range writes, and
   * the overflowed nodes read back as an internal node pointing at the root —
   * so `nearestTriangleDistanceSquared` looped forever instead of failing.
   *
   * Asserted across a range of sizes because the bug only appears once the tree
   * is deep enough, which is exactly why the small fixtures missed it.
   */
  it('builds within its node capacity and terminates for many mesh sizes', () => {
    for (const triangleCount of [1, 2, 4, 5, 7, 16, 63, 200, 501]) {
      const corners = new Float64Array(triangleCount * 9);
      for (let t = 0; t < triangleCount; t += 1) {
        // A deterministic spread, so the tree actually branches.
        const base = t * 9;
        const x = (t * 37) % 101;
        const y = (t * 53) % 97;
        const z = (t * 71) % 89;
        corners[base] = x;
        corners[base + 1] = y;
        corners[base + 2] = z;
        corners[base + 3] = x + 1;
        corners[base + 4] = y;
        corners[base + 5] = z;
        corners[base + 6] = x;
        corners[base + 7] = y + 1;
        corners[base + 8] = z;
      }

      const bvh = buildTriangleBvh(corners);
      expect(bvh.nodeCount, `nodeCount for ${String(triangleCount)}`).toBeLessThanOrEqual(
        triangleCount + 2,
      );
      // Every triangle still reachable: a truncated tree would lose some.
      expect(new Set(bvh.order).size).toBe(triangleCount);
      // Terminates AND agrees with the oracle.
      expect(nearestTriangleDistanceSquared(bvh, 50, 50, 50)).toBe(
        bruteForceNearestDistanceSquared(corners, 50, 50, 50),
      );
    }
  });

  it('builds identical structure for identical input', () => {
    const corners = flattenTriangles(meshOf(box([0, 0, 0], [10, 10, 10])));
    const first = buildTriangleBvh(corners);
    const second = buildTriangleBvh(corners);
    expect([...second.order]).toEqual([...first.order]);
    expect([...second.bounds]).toEqual([...first.bounds]);
    expect(second.nodeCount).toBe(first.nodeCount);
  });
});

describe('symmetric sampled surface distance', () => {
  it('reports zero for a mesh compared with itself', () => {
    const mesh = meshOf(box([0, 0, 0], [10, 10, 10]));
    const result = symmetricSampledSurfaceDistance(mesh, mesh, FAST);
    expect(result.aToB.maxSampledDistance).toBeLessThan(NEAR_ZERO);
    expect(result.bToA.maxSampledDistance).toBeLessThan(NEAR_ZERO);
    expect(result.combinedRmsDistance).toBeLessThan(NEAR_ZERO);
    expect(result.combinedP95Distance).toBeLessThan(NEAR_ZERO);
    expect(result.combinedP99Distance).toBeLessThan(NEAR_ZERO);
  });

  it('is unchanged by face reordering', () => {
    const faces = box([0, 0, 0], [10, 10, 10]);
    const reordered = [...faces].reverse();
    const result = symmetricSampledSurfaceDistance(meshOf(faces), meshOf(reordered), FAST);
    expect(result.combinedMaxSampledDistance).toBeLessThan(NEAR_ZERO);
  });

  it('is unchanged by vertex renumbering', () => {
    // Same two triangles, same positions, different index order and different
    // position-array layout. An implementation keyed on vertex identity rather
    // than on geometry would move here.
    const positions = createPositionArray(18);
    positions.set([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0, 0, 10, 0, 10, 0, 0]);
    const straight = createIndexArray(6);
    straight.set([0, 1, 2, 3, 4, 5]);
    const shuffled = createIndexArray(6);
    shuffled.set([2, 0, 1, 5, 3, 4]);

    const a: CanonicalMesh = {
      positions,
      indices: straight,
      metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
    };
    const b: CanonicalMesh = {
      positions,
      indices: shuffled,
      metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
    };

    const result = symmetricSampledSurfaceDistance(a, b, FAST);
    expect(result.combinedMaxSampledDistance).toBeLessThan(NEAR_ZERO);
  });

  it('reports zero for a subdivision that preserves the surface exactly', () => {
    const original: Triangle = [
      [0, 0, 0],
      [8, 0, 0],
      [0, 8, 0],
    ];
    const [p0, p1, p2] = original;
    const mid = (one: Point, two: Point): Point => [
      (one[0] + two[0]) / 2,
      (one[1] + two[1]) / 2,
      (one[2] + two[2]) / 2,
    ];
    const m01 = mid(p0, p1);
    const m12 = mid(p1, p2);
    const m20 = mid(p2, p0);
    const subdivided: Triangle[] = [
      [p0, m01, m20],
      [m01, p1, m12],
      [m20, m12, p2],
      [m01, m12, m20],
    ];

    const result = symmetricSampledSurfaceDistance(meshOf([original]), meshOf(subdivided), FAST);
    // Triangle count quadrupled; the surface did not move.
    expect(result.combinedMaxSampledDistance).toBeLessThan(NEAR_ZERO);
  });

  it('measures a known translation exactly', () => {
    // Two parallel copies of one triangle. Every point of A is exactly `shift`
    // from the nearest point of B, because B lies wholly in the offset plane.
    const shift = 0.5;
    const face: Triangle = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ];
    const moved: Triangle = [
      [0, 0, shift],
      [10, 0, shift],
      [0, 10, shift],
    ];
    const result = symmetricSampledSurfaceDistance(meshOf([face]), meshOf([moved]), FAST);
    expect(result.aToB.rmsDistance).toBeCloseTo(shift, 9);
    expect(result.aToB.maxSampledDistance).toBeCloseTo(shift, 9);
    expect(result.bToA.rmsDistance).toBeCloseTo(shift, 9);
    expect(result.combinedRmsDistance).toBeCloseTo(shift, 9);
  });

  it('detects a single displaced vertex', () => {
    const faces = box([0, 0, 0], [10, 10, 10]);
    const moved = faces.map(
      (triangle) =>
        triangle.map((point) =>
          point[0] === 10 && point[1] === 10 && point[2] === 10 ? [12, 12, 12] : point,
        ) as unknown as Triangle,
    );
    const result = symmetricSampledSurfaceDistance(meshOf(faces), meshOf(moved), FAST);
    expect(result.combinedMaxSampledDistance).toBeGreaterThan(0.1);
  });

  /**
   * THE PAIR THAT JUSTIFIES SYMMETRY.
   *
   * Same two meshes, swapped. A one-directional metric scores one of these as
   * zero and would report a destroyed or invented feature as perfect
   * preservation.
   */
  const plain: Triangle[] = [
    [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ],
  ];
  const withFeature: Triangle[] = [
    ...plain,
    [
      [0, 0, 10],
      [10, 0, 10],
      [0, 10, 10],
    ],
  ];

  it('detects removed geometry in the forward direction', () => {
    const result = symmetricSampledSurfaceDistance(meshOf(withFeature), meshOf(plain), FAST);
    expect(result.aToB.maxSampledDistance).toBeGreaterThan(9);
    expect(result.bToA.maxSampledDistance).toBeLessThan(NEAR_ZERO);
  });

  it('detects added geometry in the reverse direction', () => {
    const result = symmetricSampledSurfaceDistance(meshOf(plain), meshOf(withFeature), FAST);
    expect(result.aToB.maxSampledDistance).toBeLessThan(NEAR_ZERO);
    expect(result.bToA.maxSampledDistance).toBeGreaterThan(9);
  });

  it('stays stable for the same local change far from the origin', () => {
    const shift = 0.5;
    const near: Triangle[] = [
      [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
      ],
    ];
    const nearMoved = translate(near, [0, 0, shift]);
    const far = translate(near, [1e6, -1e6, 1e6]);
    const farMoved = translate(nearMoved, [1e6, -1e6, 1e6]);

    const atOrigin = symmetricSampledSurfaceDistance(meshOf(near), meshOf(nearMoved), FAST);
    const farAway = symmetricSampledSurfaceDistance(meshOf(far), meshOf(farMoved), FAST);

    // Float64 holds 1e6 + 0.5 comfortably; a Float32 evaluator would not, and
    // this assertion is what would catch that regression.
    expect(farAway.combinedRmsDistance).toBeCloseTo(atOrigin.combinedRmsDistance, 6);
    expect(farAway.combinedRmsDistance).toBeCloseTo(shift, 6);
  });

  it('produces identical results across repeated runs', () => {
    const a = meshOf(tetrahedron(10));
    const b = meshOf(translate(tetrahedron(10), [0.25, 0, 0]));
    const first = symmetricSampledSurfaceDistance(a, b, FAST);
    const second = symmetricSampledSurfaceDistance(a, b, FAST);
    expect(second).toEqual(first);
  });

  it('changes its samples when the seed changes, and records the seed', () => {
    const a = meshOf(tetrahedron(10));
    const b = meshOf(translate(tetrahedron(10), [0.25, 0, 0]));
    const one = symmetricSampledSurfaceDistance(a, b, { ...FAST, seed: 1 });
    const two = symmetricSampledSurfaceDistance(a, b, { ...FAST, seed: 7 });
    expect(one.configuration.seed).toBe(1);
    expect(two.configuration.seed).toBe(7);
    // Different samples, same surfaces: the statistic must stay close while the
    // exact value moves, which is what proves the seed is really in use.
    expect(two.combinedRmsDistance).not.toBe(one.combinedRmsDistance);
    expect(two.combinedRmsDistance).toBeCloseTo(one.combinedRmsDistance, 2);
  });

  it('normalises against the reference bounding-box diagonal', () => {
    const shift = 0.5;
    const a = meshOf(box([0, 0, 0], [10, 10, 10]));
    const b = meshOf(translate(box([0, 0, 0], [10, 10, 10]), [0, 0, shift]));
    const result = symmetricSampledSurfaceDistance(a, b, FAST);
    const diagonal = Math.sqrt(300);
    expect(result.referenceBoundingBoxDiagonal).toBeCloseTo(diagonal, 9);
    expect(result.normalisedCombinedRmsDistance).toBeCloseTo(
      result.combinedRmsDistance / diagonal,
      12,
    );
  });

  it('omits normalisation rather than dividing by a zero diagonal', () => {
    const degenerate = meshOf([
      [
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
    ]);
    const result = symmetricSampledSurfaceDistance(degenerate, degenerate, FAST);
    expect(result.referenceBoundingBoxDiagonal).toBeUndefined();
    expect(result.normalisedCombinedRmsDistance).toBeUndefined();
    expect(result.normalisedCombinedMaxSampledDistance).toBeUndefined();
    // And it must not silently pretend the sampling was area-weighted.
    expect(result.degenerateAreaFallback).toBe(true);
    expect(result.configuration.samplingMode).toBe('uniform-per-triangle-zero-area');
  });

  it('weights samples by area, not by triangle count', () => {
    /*
     * One large triangle plus one tiny triangle far away. If sampling were
     * per-triangle rather than per-area, half the samples would land on the
     * speck and the mean distance to a target covering only the large triangle
     * would be enormous. Area weighting keeps the speck's influence
     * proportional to the area it actually occupies.
     */
    const large: Triangle = [
      [0, 0, 0],
      [100, 0, 0],
      [0, 100, 0],
    ];
    const speck: Triangle = [
      [0, 0, 50],
      [0.01, 0, 50],
      [0, 0.01, 50],
    ];
    const result = symmetricSampledSurfaceDistance(meshOf([large, speck]), meshOf([large]), FAST);
    expect(result.configuration.samplingMode).toBe('area-weighted-stratified');
    // The speck is ~5e-9 of the total area, so essentially no sample lands on
    // it; the 95th percentile must be unaffected by it.
    expect(result.aToB.p95Distance).toBeLessThan(NEAR_ZERO);
  });

  it('reports the configured sample count in both directions', () => {
    const mesh = meshOf(tetrahedron(10));
    const result = symmetricSampledSurfaceDistance(mesh, mesh, { samplesPerDirection: 512 });
    expect(result.aToB.sampleCount).toBe(512);
    expect(result.bToA.sampleCount).toBe(512);
    expect(result.configuration.samplesPerDirection).toBe(512);
  });

  it('orders percentiles below the sampled maximum', () => {
    const a = meshOf(box([0, 0, 0], [10, 10, 10]));
    const b = meshOf(tetrahedron(10));
    const result = symmetricSampledSurfaceDistance(a, b, FAST);
    expect(result.combinedP95Distance).toBeLessThanOrEqual(result.combinedP99Distance);
    expect(result.combinedP99Distance).toBeLessThanOrEqual(result.combinedMaxSampledDistance);
    expect(result.aToB.meanDistance).toBeLessThanOrEqual(result.aToB.maxSampledDistance);
  });
});
