/**
 * THE PLANARITY POLICY, promoted unchanged from the Stage 4B-1A qualification.
 *
 * The temptation is an absolute `1e-6`, and it is wrong for exactly the reason
 * a welding tolerance is wrong: it is a distance applied to a model whose unit
 * is frequently unknown. A loop 2 mm across and a loop 2 m across would be
 * judged by the same absolute deviation, so the policy would be strict for one
 * and meaningless for the other. STL states no unit at all.
 *
 * SO THE TEST IS RELATIVE, AND THE SCALE COMES FROM THE LOOP ITSELF:
 *
 *   1. A plane from the loop's centroid and its area-weighted NEWELL normal.
 *      Newell is used rather than three chosen points because three points can
 *      be nearly collinear, and a plane fitted to nearly collinear points is
 *      numerically meaningless. Newell uses every vertex, so no single bad
 *      triple decides the answer.
 *   2. `scale` is the loop's largest bounding-box extent — a length the loop
 *      actually has, in whatever unit the model is in — so the ratio is
 *      dimensionless and unit-independent.
 *   3. Planar iff `maxDeviation / scale <= RELATIVE_PLANARITY`.
 *
 * `RELATIVE_PLANARITY` IS AN ALGORITHM-ELIGIBILITY THRESHOLD AND NOTHING ELSE.
 * It is emphatically NOT a topology-identity tolerance, not a welding distance,
 * not a merge threshold, and not a proximity test. Nothing anywhere in this
 * package welds, merges, snaps or moves a coordinate; vertex identity remains
 * exact stored-coordinate identity with no epsilon, exactly as ADR 0009
 * requires. A loop that fails this test is not "not a hole" — it is "not a hole
 * THIS TRIANGULATOR MAY ATTEMPT", and it is refused rather than approximated.
 *
 * THE VALUE. 1e-4, one part in ten thousand of the loop's own size. A Float32
 * carries about seven significant decimal digits, so a loop ten units across is
 * quantised at roughly 1e-6 absolute and 1e-4 relative leaves two orders of
 * magnitude above the representation's own noise. The measured separation on
 * the research corpus is wide: accepted loops sat at 0 to 2.5e-5, refused ones
 * at 1.5e-1.
 *
 * ARITHMETIC IS Float64 OVER WIDENED Float32 COORDINATES. Every stored value is
 * widened exactly; no precision is invented, and the final candidate is still
 * judged in the canonical Float32 representation elsewhere.
 */
export const RELATIVE_PLANARITY = 1e-4;

/** A loop vertex in Float64 working precision. */
export type LoopPoint = readonly [number, number, number];

export interface PlanarityAssessment {
  /** True only when a plane exists AND every vertex is within the ratio. */
  readonly planar: boolean;
  /**
   * True when NO plane exists to measure against.
   *
   * A zero Newell normal means an entirely collinear loop, or one enclosing no
   * area. It is not "perfectly planar": reporting it that way would send a
   * zero-area loop into a triangulator with nothing to triangulate.
   */
  readonly degenerate: boolean;
  /** Largest absolute distance from the fitted plane, in model units. */
  readonly deviation: number;
  /** The loop's largest bounding-box extent. Zero when the loop has no extent. */
  readonly scale: number;
  /** `deviation / scale`. `Infinity` when no plane exists. */
  readonly relative: number;
  /** Unit normal of the fitted plane. Undefined when degenerate. */
  readonly normal: LoopPoint | undefined;
  /** Centroid of the loop vertices. Undefined when degenerate. */
  readonly centroid: LoopPoint | undefined;
}

/**
 * Newell's area-weighted normal. Uses every vertex, so no triple decides it.
 *
 * Deliberately NOT normalised here: the caller needs the raw length to tell a
 * zero normal from a small one, and normalising first would hide it.
 */
export function newellNormal(points: readonly LoopPoint[]): LoopPoint {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index] ?? [0, 0, 0];
    const next = points[(index + 1) % points.length] ?? [0, 0, 0];
    nx += (current[1] - next[1]) * (current[2] + next[2]);
    ny += (current[2] - next[2]) * (current[0] + next[0]);
    nz += (current[0] - next[0]) * (current[1] + next[1]);
  }
  return [nx, ny, nz];
}

export function assessPlanarity(points: readonly LoopPoint[]): PlanarityAssessment {
  const normal = newellNormal(points);
  const length = Math.hypot(normal[0], normal[1], normal[2]);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;

  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    minZ = Math.min(minZ, point[2]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
    maxZ = Math.max(maxZ, point[2]);
    sumX += point[0];
    sumY += point[1];
    sumZ += point[2];
  }

  const count = points.length;
  const scale = count === 0 ? 0 : Math.max(maxX - minX, maxY - minY, maxZ - minZ);

  if (count === 0 || length === 0 || scale === 0 || !Number.isFinite(length)) {
    return {
      planar: false,
      degenerate: true,
      deviation: 0,
      scale: Number.isFinite(scale) ? scale : 0,
      relative: Infinity,
      normal: undefined,
      centroid: undefined,
    };
  }

  const centroid: LoopPoint = [sumX / count, sumY / count, sumZ / count];
  const unit: LoopPoint = [normal[0] / length, normal[1] / length, normal[2] / length];

  let deviation = 0;
  for (const point of points) {
    const offset =
      (point[0] - centroid[0]) * unit[0] +
      (point[1] - centroid[1]) * unit[1] +
      (point[2] - centroid[2]) * unit[2];
    deviation = Math.max(deviation, Math.abs(offset));
  }

  const relative = deviation / scale;
  if (!Number.isFinite(relative)) {
    // A non-finite ratio has no meaning to compare against a threshold, and
    // choosing a plane anyway would be inventing one.
    return {
      planar: false,
      degenerate: true,
      deviation,
      scale,
      relative: Infinity,
      normal: undefined,
      centroid: undefined,
    };
  }

  return {
    planar: relative <= RELATIVE_PLANARITY,
    degenerate: false,
    deviation,
    scale,
    relative,
    normal: unit,
    centroid,
  };
}
