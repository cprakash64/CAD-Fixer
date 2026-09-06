import type { LoopPoint } from './planarity';

/**
 * DETERMINISTIC EAR CLIPPING FOR A PROVEN-PLANAR SIMPLE LOOP.
 *
 * IN-HOUSE, and that is the point rather than an accident. Stage 4B-1A
 * qualified this against `pmp::fill_hole` and chose it: the kernel traps
 * uncatchably on a legal 512-vertex loop, loses append-only provenance, refines
 * a 128-vertex loop by +1,193 vertices, and times out at 2,000. This algorithm
 * CANNOT ADD A VERTEX, and an algorithm that cannot add a vertex cannot move one
 * either — so kernel-introduced points, refinement, fairing and
 * surrounding-vertex drift are absent BY CONSTRUCTION rather than by
 * measurement.
 *
 * IT IS NOT A FAN. A fan from one vertex is the obvious implementation and is
 * wrong for every concave polygon: it emits triangles covering area outside the
 * boundary — the same defect the OBJ reader refuses to commit when it declines
 * to fan a polygon. Every candidate ear here is rejected if it is reflex or if
 * any other remaining vertex lies inside it, which is what keeps the patch
 * inside the loop. `ear-clip.test.ts` pins that with a polygon a fan provably
 * leaves.
 *
 * IT ADDS NOTHING AND MOVES NOTHING. Output is `n - 2` triangles referencing
 * only the loop's own vertices, by position in the loop.
 *
 * ARITHMETIC IS Float64 over coordinates widened exactly from canonical
 * Float32. There is no epsilon anywhere in the predicates: an ear is convex iff
 * a signed area is strictly positive under the loop's own winding, and a point
 * is inside a triangle iff no barycentric sign disagrees. Where a zero appears
 * it is treated as the uncertain case and the ear is not taken, which is
 * refusal rather than a guess.
 */

export const EarClipRefusal = {
  /** Fewer than three vertices: no polygon exists. */
  TooFewVertices: 'TOO_FEW_VERTICES',
  /** The projected polygon encloses no area. */
  DegenerateProjection: 'DEGENERATE_PROJECTION',
  /**
   * No remaining vertex is a valid ear.
   *
   * Correct, and it means some planar loops are refused: a loop whose
   * PROJECTION self-intersects has no ear anywhere. Emitting something anyway
   * would be emitting overlapping triangles.
   */
  NoEarFound: 'NO_EAR_FOUND',
} as const;

export type EarClipRefusal = (typeof EarClipRefusal)[keyof typeof EarClipRefusal];

/** A patch triangle as three POSITIONS IN THE LOOP, not vertex ids. */
export type PatchTriangle = readonly [number, number, number];

export interface EarClipResult {
  /** Exactly `points.length - 2` triangles, or empty when refused. */
  readonly triangles: readonly PatchTriangle[];
  /** Always zero. Stated rather than implied, and asserted by test. */
  readonly addedVertices: number;
  /** The dropped axis: 0 = x, 1 = y, 2 = z. */
  readonly projectionAxis: number;
  /** Ear-search iterations performed. Bounded; reported so cost is visible. */
  readonly iterations: number;
  readonly refusal: EarClipRefusal | undefined;
}

/**
 * Chooses the projection plane by dropping the loop normal's DOMINANT axis.
 *
 * WHY THE DOMINANT ONE. Projecting along the direction the loop least occupies
 * gives the projection with the largest area, and therefore the one that cannot
 * collapse edge-on. Dropping a different axis could flatten the polygon to a
 * line and make every ear degenerate.
 *
 * THE TIE-BREAK IS EXPLICIT AND DOCUMENTED: when two magnitudes are exactly
 * equal, the LOWEST axis index wins — x before y before z. A tie means two
 * projections are equally good, so any rule is correct; what matters is that
 * the same loop always picks the same one, because a projection that varied
 * would make the patch vary.
 */
export function projectionAxisFor(normal: LoopPoint): number {
  const nx = Math.abs(normal[0]);
  const ny = Math.abs(normal[1]);
  const nz = Math.abs(normal[2]);
  if (nx >= ny && nx >= nz) return 0;
  if (ny >= nz) return 1;
  return 2;
}

/**
 * Projects a point onto the plane orthogonal to `axis`.
 *
 * The pairs are CYCLIC — (y,z), (z,x), (x,y) — so the projected winding agrees
 * with the loop's own orientation about that axis for every choice. Using
 * (x,y), (x,z), (y,z) instead would mirror one of the three cases and silently
 * invert "reflex" for it.
 */
export function projectPoint(point: LoopPoint, axis: number): readonly [number, number] {
  if (axis === 0) return [point[1], point[2]];
  if (axis === 1) return [point[2], point[0]];
  return [point[0], point[1]];
}

/** Twice the signed area of triangle (o, a, b) in the projected plane. */
function cross2(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/**
 * Containment, INCLUSIVE of the boundary.
 *
 * A vertex lying exactly ON a candidate ear's edge is treated as inside, so the
 * ear is rejected. That is the conservative direction: clipping an ear whose
 * edge passes through another vertex produces a triangle touching the polygon
 * boundary in a place the polygon does not, and the remaining loop stops being
 * simple.
 */
function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const d1 = cross2(ax, ay, bx, by, px, py);
  const d2 = cross2(bx, by, cx, cy, px, py);
  const d3 = cross2(cx, cy, ax, ay, px, py);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/**
 * Triangulates a planar simple loop using ONLY its existing vertices.
 *
 * DETERMINISTIC: the scan always starts from the lowest remaining position and
 * takes the FIRST valid ear, so the same loop always yields the same triangles
 * in the same order, byte for byte.
 *
 * BOUNDED: the outer loop clips exactly one vertex per pass and refuses the
 * moment a pass finds no ear, so it performs at most `n - 3` passes and cannot
 * spin. The explicit guard below is a second, independent stop.
 *
 * `normal` must come from `assessPlanarity` on the SAME points. The caller has
 * already proven planarity; this function does not re-decide it, because two
 * places deciding eligibility is two places that can disagree.
 */
export function earClip(points: readonly LoopPoint[], normal: LoopPoint): EarClipResult {
  const axis = projectionAxisFor(normal);
  const empty = { triangles: [], addedVertices: 0, projectionAxis: axis, iterations: 0 } as const;

  if (points.length < 3) {
    return { ...empty, refusal: EarClipRefusal.TooFewVertices };
  }

  const flatX = new Float64Array(points.length);
  const flatY = new Float64Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    const [x, y] = projectPoint(points[index] ?? [0, 0, 0], axis);
    flatX[index] = x;
    flatY[index] = y;
  }

  /*
   * THE SIGN OF THE PROJECTED AREA decides the winding, so "reflex" is measured
   * against the loop's OWN orientation rather than an assumed counter-clockwise
   * one. A loop wound the other way is filled just as correctly, which is what
   * makes a globally reversed model fillable.
   */
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    twiceArea +=
      (flatX[index] ?? 0) * (flatY[next] ?? 0) - (flatX[next] ?? 0) * (flatY[index] ?? 0);
  }
  if (twiceArea === 0 || !Number.isFinite(twiceArea)) {
    return { ...empty, refusal: EarClipRefusal.DegenerateProjection };
  }
  const sign = twiceArea > 0 ? 1 : -1;

  const remaining: number[] = [];
  for (let index = 0; index < points.length; index += 1) remaining.push(index);

  const triangles: PatchTriangle[] = [];
  let iterations = 0;
  // One vertex leaves per pass, so `n` passes is already unreachable; the extra
  // margin exists so the guard is obviously not the thing doing the work.
  const guardLimit = points.length + 8;

  while (remaining.length > 3) {
    iterations += 1;
    if (iterations > guardLimit) {
      return { ...empty, iterations, refusal: EarClipRefusal.NoEarFound };
    }

    let clippedAt = -1;
    for (let position = 0; position < remaining.length && clippedAt === -1; position += 1) {
      const previous = remaining[(position - 1 + remaining.length) % remaining.length] ?? 0;
      const current = remaining[position] ?? 0;
      const next = remaining[(position + 1) % remaining.length] ?? 0;

      const ax = flatX[previous] ?? 0;
      const ay = flatY[previous] ?? 0;
      const bx = flatX[current] ?? 0;
      const by = flatY[current] ?? 0;
      const cx = flatX[next] ?? 0;
      const cy = flatY[next] ?? 0;

      // Convex under the loop's own winding, and not a zero-area sliver. A zero
      // is the uncertain case and is never taken.
      if (cross2(ax, ay, bx, by, cx, cy) * sign <= 0) continue;

      let contains = false;
      for (const other of remaining) {
        if (other === previous || other === current || other === next) continue;
        if (pointInTriangle(flatX[other] ?? 0, flatY[other] ?? 0, ax, ay, bx, by, cx, cy)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      triangles.push([previous, current, next]);
      clippedAt = position;
    }

    if (clippedAt === -1) {
      return { ...empty, iterations, refusal: EarClipRefusal.NoEarFound };
    }
    remaining.splice(clippedAt, 1);
  }

  triangles.push([remaining[0] ?? 0, remaining[1] ?? 0, remaining[2] ?? 0]);

  return {
    triangles,
    addedVertices: 0,
    projectionAxis: axis,
    iterations,
    refusal: undefined,
  };
}

/**
 * Twice the area of a projected triangle, for the analytic area check.
 *
 * Exported so the area oracle uses the SAME projection the triangulator used.
 * An oracle projecting differently would be comparing two different questions.
 */
export function projectedTwiceArea(a: LoopPoint, b: LoopPoint, c: LoopPoint, axis: number): number {
  const [ax, ay] = projectPoint(a, axis);
  const [bx, by] = projectPoint(b, axis);
  const [cx, cy] = projectPoint(c, axis);
  return cross2(ax, ay, bx, by, cx, cy);
}

/** Twice the signed area of the projected polygon, by the shoelace formula. */
export function projectedPolygonTwiceArea(points: readonly LoopPoint[], axis: number): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = projectPoint(points[index] ?? [0, 0, 0], axis);
    const [x2, y2] = projectPoint(points[(index + 1) % points.length] ?? [0, 0, 0], axis);
    total += x1 * y2 - x2 * y1;
  }
  return total;
}
