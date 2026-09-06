import { describe, expect, it } from 'vitest';
import {
  earClip,
  EarClipRefusal,
  projectedPolygonTwiceArea,
  projectedTwiceArea,
  projectionAxisFor,
  projectPoint,
} from './ear-clip';
import { assessPlanarity, newellNormal, RELATIVE_PLANARITY, type LoopPoint } from './planarity';

const lift = (outline: readonly (readonly [number, number])[], z = 0): readonly LoopPoint[] =>
  outline.map((point) => [point[0], point[1], z] as LoopPoint);

const CONVEX = lift([
  [0, 0],
  [2, 0],
  [2, 2],
  [0, 2],
]);

/**
 * THE L-SHAPE. Its reflex corner is at (1,1), and a fan from vertex 0 emits the
 * triangle (0,0)-(1,1)-(1,3), which covers area the polygon does not contain.
 */
const CONCAVE_L = lift([
  [0, 0],
  [3, 0],
  [3, 1],
  [1, 1],
  [1, 3],
  [0, 3],
]);

const COMB = lift([
  [0, 0],
  [6, 0],
  [6, 4],
  [5, 4],
  [5, 1],
  [4, 1],
  [4, 4],
  [3, 4],
  [3, 1],
  [2, 1],
  [2, 4],
  [1, 4],
  [1, 1],
  [0, 1],
]);

function unitNormal(points: readonly LoopPoint[]): LoopPoint {
  const normal = newellNormal(points);
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

describe('planarity policy', () => {
  it('accepts a flat loop with zero deviation', () => {
    const assessment = assessPlanarity(CONVEX);
    expect(assessment.planar).toBe(true);
    expect(assessment.degenerate).toBe(false);
    expect(assessment.relative).toBe(0);
  });

  it('is RELATIVE: the same shape at two scales gets the same verdict', () => {
    /*
     * The whole reason an absolute epsilon is wrong. A loop 2 mm across and a
     * loop 2 m across must be judged identically, because an STL states no unit
     * and CAD Fixer refuses to guess one.
     */
    const small = CONVEX.map((p) => [p[0] * 0.001, p[1] * 0.001, p[2] * 0.001] as LoopPoint);
    const large = CONVEX.map((p) => [p[0] * 1000, p[1] * 1000, p[2] * 1000] as LoopPoint);
    const warp = (points: readonly LoopPoint[], relative: number): readonly LoopPoint[] => {
      const extent = Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0]));
      return points.map((p, index) =>
        index === 0 ? ([p[0], p[1], p[2] + relative * extent] as LoopPoint) : p,
      );
    };

    expect(assessPlanarity(warp(small, 1e-5)).planar).toBe(true);
    expect(assessPlanarity(warp(large, 1e-5)).planar).toBe(true);
    expect(assessPlanarity(warp(small, 1e-2)).planar).toBe(false);
    expect(assessPlanarity(warp(large, 1e-2)).planar).toBe(false);
  });

  it('accepts exactly the loops whose MEASURED ratio is at or below 1e-4', () => {
    /*
     * ASSERTED AGAINST THE RATIO THE POLICY ACTUALLY MEASURES, not against the
     * lift that produced it. Lifting one vertex moves the centroid and tilts
     * the fitted plane, so the deviation is smaller than the lift — a test that
     * assumed otherwise would be pinning arithmetic nobody performs. The sweep
     * crosses the threshold, so the boundary really is exercised.
     */
    expect(RELATIVE_PLANARITY).toBe(1e-4);
    const at = (lift: number): readonly LoopPoint[] =>
      CONVEX.map((p, index) => (index === 0 ? ([p[0], p[1], lift] as LoopPoint) : p));

    let sawBelow = false;
    let sawAbove = false;
    for (let step = 0; step <= 40; step += 1) {
      const assessment = assessPlanarity(at(step * 1e-4));
      expect(assessment.planar).toBe(assessment.relative <= RELATIVE_PLANARITY);
      if (assessment.relative <= RELATIVE_PLANARITY) sawBelow = true;
      else sawAbove = true;
    }
    expect(sawBelow).toBe(true);
    expect(sawAbove).toBe(true);
  });

  it('reports a collinear loop as DEGENERATE, never as perfectly planar', () => {
    const collinear: readonly LoopPoint[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ];
    const assessment = assessPlanarity(collinear);
    expect(assessment.degenerate).toBe(true);
    expect(assessment.planar).toBe(false);
    expect(assessment.normal).toBeUndefined();
  });

  it('reports a zero-extent loop as degenerate', () => {
    const point: readonly LoopPoint[] = [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ];
    expect(assessPlanarity(point).degenerate).toBe(true);
  });
});

describe('deterministic projection', () => {
  it('drops the dominant normal axis', () => {
    expect(projectionAxisFor([1, 0, 0])).toBe(0);
    expect(projectionAxisFor([0, 1, 0])).toBe(1);
    expect(projectionAxisFor([0, 0, 1])).toBe(2);
    expect(projectionAxisFor([0.1, 0.2, 0.9])).toBe(2);
  });

  it('breaks an exact tie on the LOWEST axis index, every time', () => {
    // A tie means two projections are equally good, so any rule is correct —
    // what matters is that the same loop always picks the same one.
    expect(projectionAxisFor([1, 1, 0])).toBe(0);
    expect(projectionAxisFor([0, 1, 1])).toBe(1);
    expect(projectionAxisFor([1, 1, 1])).toBe(0);
    for (let repeat = 0; repeat < 32; repeat += 1) {
      expect(projectionAxisFor([1, 1, 1])).toBe(0);
    }
  });

  it('uses cyclic axis pairs so the projected winding never flips', () => {
    /*
     * (y,z), (z,x), (x,y). Using (x,y), (x,z), (y,z) instead would mirror the
     * middle case and silently invert "reflex" for every loop whose normal
     * points along Y.
     */
    expect(projectPoint([1, 2, 3], 0)).toEqual([2, 3]);
    expect(projectPoint([1, 2, 3], 1)).toEqual([3, 1]);
    expect(projectPoint([1, 2, 3], 2)).toEqual([1, 2]);
  });
});

describe('ear clipping', () => {
  for (const [name, polygon] of [
    ['convex', CONVEX],
    ['concave L', CONCAVE_L],
    ['deep concave comb', COMB],
  ] as const) {
    it(`adds no vertex and emits exactly n - 2 triangles: ${name}`, () => {
      const result = earClip(polygon, unitNormal(polygon));
      expect(result.refusal).toBeUndefined();
      expect(result.addedVertices).toBe(0);
      expect(result.triangles).toHaveLength(polygon.length - 2);
    });

    it(`covers exactly the polygon's own area: ${name}`, () => {
      /*
       * THE ANALYTIC AREA CHECK, and the thing that proves this is not a fan.
       * Summed triangle area equal to the shoelace area means the triangles
       * tile the polygon; a fan over a concave polygon covers area outside it,
       * so its sum is larger.
       */
      const result = earClip(polygon, unitNormal(polygon));
      const axis = result.projectionAxis;
      const polygonArea = Math.abs(projectedPolygonTwiceArea(polygon, axis)) / 2;
      let patchArea = 0;
      for (const [a, b, c] of result.triangles) {
        patchArea +=
          Math.abs(
            projectedTwiceArea(
              polygon[a] ?? [0, 0, 0],
              polygon[b] ?? [0, 0, 0],
              polygon[c] ?? [0, 0, 0],
              axis,
            ),
          ) / 2;
      }
      expect(Math.abs(patchArea - polygonArea) / polygonArea).toBeLessThan(5e-8);
    });

    it(`uses every vertex and only the polygon's own vertices: ${name}`, () => {
      const result = earClip(polygon, unitNormal(polygon));
      const used = new Set<number>();
      for (const triangle of result.triangles) {
        for (const slot of triangle) {
          expect(slot).toBeGreaterThanOrEqual(0);
          expect(slot).toBeLessThan(polygon.length);
          used.add(slot);
        }
      }
      expect(used.size).toBe(polygon.length);
    });

    it(`is byte-for-byte deterministic across 100 runs: ${name}`, () => {
      const first = JSON.stringify(earClip(polygon, unitNormal(polygon)).triangles);
      for (let run = 0; run < 100; run += 1) {
        expect(JSON.stringify(earClip(polygon, unitNormal(polygon)).triangles)).toBe(first);
      }
    });
  }

  it('NEVER FANS: no emitted triangle leaves the comb, and a fan provably would', () => {
    /*
     * THE FAN REGRESSION GUARD, on a polygon that is star-shaped from NO vertex.
     *
     * The L is a bad witness and was one here for a while: it happens to be
     * star-shaped from its origin corner, so a fan from vertex 0 covers it
     * correctly and the guard proved nothing. The comb does not have that
     * property. A fan from vertex 0 emits (0,0)-(4,1)-(4,4), whose centroid
     * (8/3, 5/3) sits in the GAP between two teeth — outside the polygon
     * entirely — which is asserted below so this test is known to be testing
     * something.
     */
    const inside = (x: number, y: number): boolean => {
      if (x < 0 || x > 6 || y < 0 || y > 4) return false;
      if (y <= 1) return true;
      return (x >= 1 && x <= 2) || (x >= 3 && x <= 4) || (x >= 5 && x <= 6);
    };

    const result = earClip(COMB, unitNormal(COMB));
    expect(result.refusal).toBeUndefined();
    for (const [a, b, c] of result.triangles) {
      const pa = COMB[a] ?? [0, 0, 0];
      const pb = COMB[b] ?? [0, 0, 0];
      const pc = COMB[c] ?? [0, 0, 0];
      const cx = (pa[0] + pb[0] + pc[0]) / 3;
      const cy = (pa[1] + pb[1] + pc[1]) / 3;
      expect(
        inside(cx, cy),
        `triangle centroid (${String(cx)}, ${String(cy)}) left the polygon`,
      ).toBe(true);
    }

    // The fan a naive implementation would emit really does leave the polygon.
    expect(inside(8 / 3, 5 / 3)).toBe(false);
  });

  it('emits triangles all wound the same way as the polygon', () => {
    const result = earClip(CONCAVE_L, unitNormal(CONCAVE_L));
    const axis = result.projectionAxis;
    const polygonSign = Math.sign(projectedPolygonTwiceArea(CONCAVE_L, axis));
    for (const [a, b, c] of result.triangles) {
      const signed = projectedTwiceArea(
        CONCAVE_L[a] ?? [0, 0, 0],
        CONCAVE_L[b] ?? [0, 0, 0],
        CONCAVE_L[c] ?? [0, 0, 0],
        axis,
      );
      expect(Math.sign(signed)).toBe(polygonSign);
    }
  });

  it('fills a CLOCKWISE polygon just as correctly as a counter-clockwise one', () => {
    // "Reflex" is measured against the loop's OWN winding, which is what makes a
    // globally reversed model fillable.
    const reversed = [...CONCAVE_L].reverse();
    const result = earClip(reversed, unitNormal(reversed));
    expect(result.refusal).toBeUndefined();
    expect(result.triangles).toHaveLength(reversed.length - 2);
  });

  it('refuses fewer than three vertices', () => {
    expect(earClip(CONVEX.slice(0, 2), [0, 0, 1]).refusal).toBe(EarClipRefusal.TooFewVertices);
  });

  it('refuses a projection with no area', () => {
    const collinear: readonly LoopPoint[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ];
    expect(earClip(collinear, [0, 0, 1]).refusal).toBe(EarClipRefusal.DegenerateProjection);
  });

  it('refuses rather than emitting anything when no ear exists', () => {
    /*
     * A self-intersecting PROJECTION has no valid ear anywhere. Refusing is
     * correct and is why some planar loops are declined: emitting overlapping
     * triangles to avoid a refusal would be exactly the wrong trade.
     */
    // The {7/3} star polygon: seven vertices connected every third step. Its
    // projection crosses itself everywhere, and no candidate ear is free of
    // another vertex.
    const star: LoopPoint[] = [];
    for (let step = 0; step < 7; step += 1) {
      const angle = (2 * Math.PI * ((step * 3) % 7)) / 7;
      star.push([Math.cos(angle), Math.sin(angle), 0]);
    }
    const result = earClip(star, [0, 0, 1]);
    expect(result.refusal).toBe(EarClipRefusal.NoEarFound);
    expect(result.triangles).toHaveLength(0);
  });

  it('rejects an ear whose edge passes exactly through another vertex', () => {
    /*
     * Containment is INCLUSIVE of the boundary. A vertex lying on a candidate
     * ear's edge is treated as inside, so the ear is not taken — the
     * conservative direction, because clipping it would leave a polygon that is
     * no longer simple.
     */
    const withCollinearPoint: readonly LoopPoint[] = [
      [0, 0, 0],
      [2, 0, 0],
      [4, 0, 0],
      [4, 2, 0],
      [0, 2, 0],
    ];
    const result = earClip(withCollinearPoint, unitNormal(withCollinearPoint));
    expect(result.refusal).toBeUndefined();
    expect(result.triangles).toHaveLength(3);
    const axis = result.projectionAxis;
    const polygonArea = Math.abs(projectedPolygonTwiceArea(withCollinearPoint, axis)) / 2;
    let patchArea = 0;
    for (const [a, b, c] of result.triangles) {
      patchArea +=
        Math.abs(
          projectedTwiceArea(
            withCollinearPoint[a] ?? [0, 0, 0],
            withCollinearPoint[b] ?? [0, 0, 0],
            withCollinearPoint[c] ?? [0, 0, 0],
            axis,
          ),
        ) / 2;
    }
    expect(Math.abs(patchArea - polygonArea) / polygonArea).toBeLessThan(5e-8);
  });
});
