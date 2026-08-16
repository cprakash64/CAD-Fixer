import { stage, type StageMemory } from './memory';

/**
 * GEOMETRIC METRICS — area, algebraic signed volume, Euler characteristic.
 *
 * All arithmetic is float64. JavaScript numbers are doubles, so this is the
 * default — but it is stated because the SOURCE coordinates may be float32, and
 * the distinction matters: values are widened once on read and every
 * accumulation happens in double precision. Nothing accumulates into a
 * Float32Array.
 *
 * COMPENSATED SUMMATION. Both area and volume sum millions of terms of wildly
 * differing magnitude. Naive accumulation loses the small ones entirely once
 * the running total grows: adding 1e-9 to 1e9 changes nothing. Neumaier's
 * variant of Kahan summation is used, which unlike plain Kahan is also correct
 * when an individual term is larger than the running sum — a real case here,
 * where one large facet can follow thousands of slivers.
 *
 * VOLUME AND THE ORIGIN. The naive signed volume sums tetrahedra formed with
 * the world origin. For a model sitting 500 mm from the origin with 0.1 mm
 * features, those tetrahedra are enormous compared with the volume they
 * describe, and the answer is the small difference of large numbers — the
 * classic catastrophic-cancellation setup. Each component is therefore measured
 * against its OWN reference point (the first vertex of its first face), which
 * makes the terms proportional to the part rather than to its distance from the
 * origin. Translating a model then changes the result only through float32
 * coordinate rounding, not through cancellation.
 *
 * WHAT SIGNED VOLUME IS NOT. It is an algebraic sum, not a measured physical
 * volume. It is only interpretable as enclosed volume when the component is
 * closed, edge- and vertex-manifold, and consistently wound — and even then,
 * self-intersections are NOT checked in Stage 2, so a surface can satisfy every
 * topological prerequisite and still enclose nothing coherent. The report
 * carries a status saying which of those conditions held rather than implying
 * the number means more than it does.
 */

/** Neumaier compensated accumulator. */
export class CompensatedSum {
  private total = 0;
  private compensation = 0;

  public add(value: number): void {
    const next = this.total + value;
    // Whichever operand is larger determines where the low-order bits are lost.
    this.compensation +=
      Math.abs(this.total) >= Math.abs(value)
        ? this.total - next + value
        : value - next + this.total;
    this.total = next;
  }

  public get value(): number {
    return this.total + this.compensation;
  }
}

/**
 * Neumaier accumulation into parallel typed arrays.
 *
 * The same compensation as `CompensatedSum`, but with the running total and its
 * correction held in arrays indexed by component, so per-component sums cost no
 * objects at all.
 */
function accumulate(
  totals: Float64Array,
  compensations: Float64Array,
  index: number,
  value: number,
): void {
  const current = totals[index] ?? 0;
  const next = current + value;
  compensations[index] =
    (compensations[index] ?? 0) +
    (Math.abs(current) >= Math.abs(value) ? current - next + value : value - next + current);
  totals[index] = next;
}

export interface AreaResult {
  readonly total: number;
  /** Area per component, indexed by component id. */
  readonly perComponent: Float64Array;
}

/**
 * Twice-area via the cross product, halved once at the end per component.
 *
 * Degenerate faces contribute exactly zero: their cross product is the zero
 * vector, so no special case is needed and none is applied.
 */
export function computeArea(
  faceVertices: Uint32Array,
  faceCount: number,
  positions: ArrayLike<number>,
  representative: Uint32Array,
  faceComponent: Uint32Array,
  componentCount: number,
  onBatch?: (processed: number) => void,
): AreaResult {
  // Parallel Float64Arrays rather than one CompensatedSum object per component.
  // A mesh of disconnected triangles has as many components as faces, so an
  // object apiece would be millions of allocations for a pathological input.
  const sums = new Float64Array(componentCount);
  const compensations = new Float64Array(componentCount);
  const totalSum = new CompensatedSum();

  const FACES_PER_BATCH = 65_536;

  for (let f = 0; f < faceCount; f += 1) {
    if (f % FACES_PER_BATCH === 0) onBatch?.(f);

    const base = f * 3;
    const a = faceVertices[base] ?? 0;
    const b = faceVertices[base + 1] ?? 0;
    const c = faceVertices[base + 2] ?? 0;

    const ax = read(positions, representative, a, 0);
    const ay = read(positions, representative, a, 1);
    const az = read(positions, representative, a, 2);
    const e1x = read(positions, representative, b, 0) - ax;
    const e1y = read(positions, representative, b, 1) - ay;
    const e1z = read(positions, representative, b, 2) - az;
    const e2x = read(positions, representative, c, 0) - ax;
    const e2y = read(positions, representative, c, 1) - ay;
    const e2z = read(positions, representative, c, 2) - az;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const area = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;

    totalSum.add(area);
    accumulate(sums, compensations, faceComponent[f] ?? 0, area);
  }

  onBatch?.(faceCount);

  const perComponent = new Float64Array(componentCount);
  for (let c = 0; c < componentCount; c += 1) {
    perComponent[c] = (sums[c] ?? 0) + (compensations[c] ?? 0);
  }

  return { total: totalSum.value, perComponent };
}

export const VolumeStatus = {
  /** Closed, manifold, consistently wound: the number is a plausible volume. */
  ClosedManifold: 'closed-manifold',
  /** The component has boundary edges, so it encloses nothing. */
  OpenSurface: 'open-surface',
  /** Non-manifold or inconsistently wound: the sum is not interpretable. */
  NotInterpretable: 'not-interpretable',
} as const;

export type VolumeStatus = (typeof VolumeStatus)[keyof typeof VolumeStatus];

export interface VolumeResult {
  /** Algebraic signed volume per component. */
  readonly perComponent: Float64Array;
  /** Sum over components. Algebraic, not physical. */
  readonly totalSigned: number;
}

/**
 * Algebraic signed volume, one component-local reference point per component.
 *
 * Sum over faces of the signed tetrahedron (reference, a, b, c), which is
 * `dot(a - r, cross(b - r, c - r)) / 6`.
 */
export function computeSignedVolume(
  faceVertices: Uint32Array,
  faceCount: number,
  positions: ArrayLike<number>,
  representative: Uint32Array,
  faceComponent: Uint32Array,
  componentCount: number,
  onBatch?: (processed: number) => void,
): VolumeResult {
  // Reference point per component: the first vertex of its lowest-indexed face.
  const referenceSet = new Uint8Array(componentCount);
  const reference = new Float64Array(componentCount * 3);

  for (let f = 0; f < faceCount; f += 1) {
    const component = faceComponent[f] ?? 0;
    if (referenceSet[component] === 1) continue;
    const vertex = faceVertices[f * 3] ?? 0;
    reference[component * 3] = read(positions, representative, vertex, 0);
    reference[component * 3 + 1] = read(positions, representative, vertex, 1);
    reference[component * 3 + 2] = read(positions, representative, vertex, 2);
    referenceSet[component] = 1;
  }

  const sums = new Float64Array(componentCount);
  const compensations = new Float64Array(componentCount);

  const FACES_PER_BATCH = 65_536;

  for (let f = 0; f < faceCount; f += 1) {
    if (f % FACES_PER_BATCH === 0) onBatch?.(f);

    const component = faceComponent[f] ?? 0;
    const rx = reference[component * 3] ?? 0;
    const ry = reference[component * 3 + 1] ?? 0;
    const rz = reference[component * 3 + 2] ?? 0;

    const base = f * 3;
    const a = faceVertices[base] ?? 0;
    const b = faceVertices[base + 1] ?? 0;
    const c = faceVertices[base + 2] ?? 0;

    const ax = read(positions, representative, a, 0) - rx;
    const ay = read(positions, representative, a, 1) - ry;
    const az = read(positions, representative, a, 2) - rz;
    const bx = read(positions, representative, b, 0) - rx;
    const by = read(positions, representative, b, 1) - ry;
    const bz = read(positions, representative, b, 2) - rz;
    const cx = read(positions, representative, c, 0) - rx;
    const cy = read(positions, representative, c, 1) - ry;
    const cz = read(positions, representative, c, 2) - rz;

    const crossX = by * cz - bz * cy;
    const crossY = bz * cx - bx * cz;
    const crossZ = bx * cy - by * cx;

    accumulate(sums, compensations, component, (ax * crossX + ay * crossY + az * crossZ) / 6);
  }

  onBatch?.(faceCount);

  const perComponent = new Float64Array(componentCount);
  const total = new CompensatedSum();
  for (let c = 0; c < componentCount; c += 1) {
    const value = (sums[c] ?? 0) + (compensations[c] ?? 0);
    perComponent[c] = value;
    total.add(value);
  }

  return { perComponent, totalSigned: total.value };
}

function read(
  positions: ArrayLike<number>,
  representative: Uint32Array,
  vertex: number,
  axis: number,
): number {
  return positions[(representative[vertex] ?? 0) * 3 + axis] ?? 0;
}

/**
 * Euler characteristic, χ = V − E + F, from RECOVERED topology.
 *
 * Reported for every component because it is always computable from the counts.
 * Genus is deliberately NOT derived: `g = (2 − χ) / 2` is only meaningful for a
 * connected, closed, orientable, edge- and vertex-manifold surface, and
 * applying it to anything else produces a confident-looking fraction that means
 * nothing. Stage 2 reports χ and the prerequisites, and leaves genus alone.
 */
export function eulerCharacteristic(
  vertexCount: number,
  edgeCount: number,
  faceCount: number,
): number {
  return vertexCount - edgeCount + faceCount;
}

/**
 * Memory profile of the area and volume passes.
 *
 * Everything here is indexed by COMPONENT, and in the worst case — a soup of
 * disconnected triangles — there is one component per face. The estimate is
 * written against `componentCount` so a caller can pass the worst case rather
 * than hope it never happens.
 *
 * Area: sums + compensations + the per-component result (three Float64Arrays).
 * Volume: a set flag, three reference coordinates, sums, compensations, and the
 * per-component result. The per-component results are read while the report is
 * assembled, so they are retained; the accumulators are not.
 */
export function estimateMetricBytes(componentCount: number): StageMemory {
  const retained = componentCount * 8 * 2;
  const transient = componentCount * 8 * 2 + componentCount * (1 + 24 + 8 + 8);
  return stage(retained, transient);
}
