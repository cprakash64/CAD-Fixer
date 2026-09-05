/**
 * CANDIDATE B — AN IN-HOUSE TRIANGULATOR FOR PROVEN-PLANAR SIMPLE LOOPS.
 *
 * RESEARCH ONLY. No dependency, no kernel, no WASM, MIT-irrelevant because it
 * is ours.
 *
 * WHY EVALUATE THIS AT ALL when a qualified kernel exists. Because the least
 * invasive operation that produces acceptable geometry is the right MVP, and
 * for the commonest real hole — a flat missing cap — the correct patch uses
 * ONLY the existing boundary vertices and adds nothing. An algorithm that
 * cannot add a vertex cannot move one either, so whole classes of failure
 * (kernel-introduced points, refinement, fairing, surrounding-vertex drift)
 * are absent by construction rather than by measurement.
 *
 * ITS SCOPE IS DELIBERATELY NARROW. It is only eligible for a loop this module
 * PROVES planar, under the policy below. A non-planar loop is refused here and
 * belongs to the kernel candidate.
 */

/* --------------------------------------------------------- planarity -- */

/**
 * THE PLANARITY POLICY, stated rather than assumed.
 *
 * The temptation is `1e-6`, and it is wrong for the same reason a welding
 * tolerance is wrong: it is an absolute distance applied to a model whose unit
 * is frequently unknown. A loop 2 mm across and a loop 2 m across would be
 * judged by the same absolute deviation, so the policy would be strict for one
 * and meaningless for the other.
 *
 * SO THE TEST IS RELATIVE, AND THE SCALE COMES FROM THE LOOP ITSELF:
 *
 *   1. Build a plane from the loop's centroid and its area-weighted normal
 *      (Newell's method). Newell is used rather than three chosen points
 *      because three points can be nearly collinear, and a plane fitted to
 *      nearly collinear points is numerically meaningless. Newell uses every
 *      vertex, so no single bad triple decides the answer.
 *   2. Take `scale` as the loop's largest bounding-box extent. This is a length
 *      the loop actually has, in whatever unit the model is in, so the ratio
 *      below is dimensionless and unit-independent — which matters because an
 *      STL states no unit at all.
 *   3. Planar iff `maxDeviation / scale <= RELATIVE_PLANARITY`.
 *
 * `RELATIVE_PLANARITY` is 1e-4: one part in ten thousand of the loop's own
 * size. It is an ALGORITHM ELIGIBILITY threshold, never a topology-identity
 * one — nothing here welds, merges or moves anything, and a loop that fails it
 * is not "not a hole", it is "not a hole this triangulator may attempt".
 *
 * The value is a starting point derived from Float32: a Float32 has about
 * seven significant decimal digits, so coordinates of a loop 10 units across
 * are quantised at roughly 1e-6 absolute, and 1e-4 relative leaves two orders
 * of magnitude of headroom above the representation's own noise. Measured
 * behaviour on HF06/HF07/HF23 is reported by the runner so the number can be
 * argued with rather than inherited.
 */
export const RELATIVE_PLANARITY = 1e-4;

/** Newell's area-weighted normal. Uses every vertex, so no triple decides it. */
export function newellNormal(points) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    nx += (current[1] - next[1]) * (current[2] + next[2]);
    ny += (current[2] - next[2]) * (current[0] + next[0]);
    nz += (current[0] - next[0]) * (current[1] + next[1]);
  }
  return [nx, ny, nz];
}

export function assessPlanarity(points) {
  const normal = newellNormal(points);
  const length = Math.hypot(...normal);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const centroid = [0, 0, 0];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
      centroid[axis] += point[axis] / points.length;
    }
  }
  const scale = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);

  /*
   * A ZERO NEWELL NORMAL MEANS NO PLANE EXISTS TO MEASURE AGAINST — an entirely
   * collinear loop, or one enclosing no area. It is not "perfectly planar"; it
   * is undefined, and reporting it as planar would send a zero-area loop into a
   * triangulator that has nothing to triangulate.
   */
  if (length === 0 || scale === 0) {
    return { planar: false, degenerate: true, deviation: 0, scale, relative: Infinity };
  }

  const unit = normal.map((value) => value / length);
  let deviation = 0;
  for (const point of points) {
    const offset =
      (point[0] - centroid[0]) * unit[0] +
      (point[1] - centroid[1]) * unit[1] +
      (point[2] - centroid[2]) * unit[2];
    deviation = Math.max(deviation, Math.abs(offset));
  }

  const relative = deviation / scale;
  return {
    planar: relative <= RELATIVE_PLANARITY,
    degenerate: false,
    deviation,
    scale,
    relative,
    normal: unit,
  };
}

/* -------------------------------------------------------- ear clipping -- */

function cross2(ox, oy, ax, ay, bx, by) {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = cross2(ax, ay, bx, by, px, py);
  const d2 = cross2(bx, by, cx, cy, px, py);
  const d3 = cross2(cx, cy, ax, ay, px, py);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

export const EarClipRefusal = {
  NotPlanar: 'NOT_PLANAR',
  DegenerateLoop: 'DEGENERATE_LOOP',
  NoEarFound: 'NO_EAR_FOUND',
  TooFewVertices: 'TOO_FEW_VERTICES',
};

/**
 * Triangulates a planar simple loop using ONLY its existing vertices.
 *
 * PROJECTED TO 2D ALONG THE LOOP'S OWN NORMAL, using the dominant axis to pick
 * the projection so the projected polygon can never be edge-on and degenerate.
 *
 * EAR CLIPPING WITH A CONTAINMENT TEST, not a fan. A fan from one vertex is the
 * obvious implementation and is wrong for every concave polygon: it emits
 * triangles covering area outside the boundary, which is the same defect the
 * OBJ reader refuses to commit when it declines to fan a polygon. Each
 * candidate ear here is rejected if it is reflex or if any other vertex lies
 * inside it, which is what keeps the patch inside the loop.
 *
 * DETERMINISTIC: the scan always starts from the lowest remaining index and
 * takes the first valid ear, so the same loop always yields the same triangles
 * in the same order.
 */
export function earClip(points) {
  if (points.length < 3) return { refusal: EarClipRefusal.TooFewVertices };

  const planarity = assessPlanarity(points);
  if (planarity.degenerate) return { refusal: EarClipRefusal.DegenerateLoop, planarity };
  if (!planarity.planar) return { refusal: EarClipRefusal.NotPlanar, planarity };

  // Project along the dominant normal axis: the projection with the largest
  // area, and therefore the one that cannot collapse.
  const [nx, ny, nz] = planarity.normal.map(Math.abs);
  const axis = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
  const project = (point) =>
    axis === 0 ? [point[1], point[2]] : axis === 1 ? [point[2], point[0]] : [point[0], point[1]];

  const flat = points.map(project);

  // Signed area decides the winding of the projection, so "reflex" is measured
  // against the loop's own orientation rather than an assumed one.
  let twiceArea = 0;
  for (let index = 0; index < flat.length; index += 1) {
    const [x1, y1] = flat[index];
    const [x2, y2] = flat[(index + 1) % flat.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  if (twiceArea === 0) return { refusal: EarClipRefusal.DegenerateLoop, planarity };
  const sign = twiceArea > 0 ? 1 : -1;

  const remaining = points.map((_point, index) => index);
  const triangles = [];
  let guard = 0;
  const guardLimit = points.length * points.length + 16;

  while (remaining.length > 3) {
    guard += 1;
    if (guard > guardLimit) return { refusal: EarClipRefusal.NoEarFound, planarity };

    let clipped = false;
    for (let position = 0; position < remaining.length; position += 1) {
      const previous = remaining[(position - 1 + remaining.length) % remaining.length];
      const current = remaining[position];
      const next = remaining[(position + 1) % remaining.length];

      const [ax, ay] = flat[previous];
      const [bx, by] = flat[current];
      const [cx, cy] = flat[next];

      // Convex under the loop's own winding, and not a zero-area sliver.
      const area = cross2(ax, ay, bx, by, cx, cy) * sign;
      if (area <= 0) continue;

      let contains = false;
      for (const other of remaining) {
        if (other === previous || other === current || other === next) continue;
        const [px, py] = flat[other];
        if (pointInTriangle(px, py, ax, ay, bx, by, cx, cy)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      triangles.push([previous, current, next]);
      remaining.splice(position, 1);
      clipped = true;
      break;
    }

    if (!clipped) return { refusal: EarClipRefusal.NoEarFound, planarity };
  }

  triangles.push([remaining[0], remaining[1], remaining[2]]);
  return { triangles, planarity, addedVertices: 0 };
}
