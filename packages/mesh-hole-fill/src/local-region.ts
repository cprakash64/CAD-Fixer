import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { exactStoredCoordinateIdentity, tableCapacityFor } from '@cadfixer/mesh-topology';
import type { AdmittedLoop } from './admission';

/**
 * THE LOCAL REGION OF A SET OF PATCHES — REPAIR-CORE-02.
 *
 * WHY THIS IS COMPLETE, NOT A HEURISTIC. A patch triangle can intersect, touch
 * or overlap an existing triangle only if their axis-aligned boxes overlap. A
 * patch lies inside its loop's box, because every patch vertex is a loop
 * vertex. So every existing face that could take part in an invalid pair with
 * ANY patch triangle of a loop has a box overlapping that loop's box — and
 * collecting exactly those faces loses no pair the whole-part check would have
 * tested. The overlap is INCLUSIVE, as the existing broadphase's is, so a face
 * that merely touches the box is kept.
 *
 * WHAT CROSSES TO THE DISPOSABLE WORKER. Only this region: its distinct points,
 * welded by EXACT stored coordinates (ADR 0009, `-0` normalised) and widened
 * exactly to Float64, its triangles, and the patches appended after them. The
 * narrowphase reasons about shared vertices through those ids, so welding here
 * must be — and is — the same rule the whole-part geometry uses. A part's
 * other triangles never leave the authoritative worker.
 *
 * BOUNDED. The region is capped at `maxFaces`; a loop whose surroundings exceed
 * what is left of that budget is excluded (and reported), never checked
 * partially.
 */

export interface LocalPatchProblem {
  /** Distinct points of the region, Float64, xyz. */
  readonly positions: Float64Array;
  /** Region faces first, then every admitted patch, three local ids per face. */
  readonly triangles: Uint32Array;
  /** Faces `[0, sourceFaceCount)` are existing geometry; the rest are patches. */
  readonly sourceFaceCount: number;
  /** For each included loop, `[patchStart, patchEnd)` in local face numbering. */
  readonly loopRanges: Uint32Array;
  /** Ids of the loops included, aligned with `loopRanges`. */
  readonly loopIds: readonly string[];
  /** Ids of loops excluded because their region did not fit the budget. */
  readonly excluded: readonly string[];
}

export interface LocalRegionOptions {
  readonly maxFaces: number;
  poll?(processed: number): void;
}

const POLL_INTERVAL = 32_768;

export function buildLocalPatchProblem(
  mesh: CanonicalMesh,
  loops: readonly AdmittedLoop[],
  options: LocalRegionOptions,
): LocalPatchProblem {
  const { positions, indices } = mesh;
  const faceCount = Math.floor(indices.length / 3);

  // Union box of every loop, as a cheap first rejection for the whole part.
  const unionMin = [Infinity, Infinity, Infinity];
  const unionMax = [-Infinity, -Infinity, -Infinity];
  for (const loop of loops) {
    for (let axis = 0; axis < 3; axis += 1) {
      unionMin[axis] = Math.min(unionMin[axis] ?? Infinity, loop.min[axis] ?? Infinity);
      unionMax[axis] = Math.max(unionMax[axis] ?? -Infinity, loop.max[axis] ?? -Infinity);
    }
  }

  // Faces per loop, collected in one pass over the part.
  const perLoop: number[][] = loops.map(() => []);
  const faceMin = [0, 0, 0];
  const faceMax = [0, 0, 0];
  for (let face = 0; face < faceCount; face += 1) {
    if (face % POLL_INTERVAL === 0) options.poll?.(face);
    faceBounds(positions, indices, face, faceMin, faceMax);
    if (!overlaps(faceMin, faceMax, unionMin, unionMax)) continue;
    for (const [index, loop] of loops.entries()) {
      if (overlaps(faceMin, faceMax, loop.min, loop.max)) perLoop[index]?.push(face);
    }
  }
  options.poll?.(faceCount);

  // Admit loops in order while their regions fit the budget. A face shared by
  // two loops' regions is counted once in the output but charged to both —
  // the conservative direction.
  const included: number[] = [];
  const excluded: string[] = [];
  let charged = 0;
  for (const [index, faces] of perLoop.entries()) {
    const loop = loops[index];
    if (loop === undefined) continue;
    if (charged + faces.length > options.maxFaces) {
      excluded.push(loop.id);
      continue;
    }
    charged += faces.length;
    included.push(index);
  }

  const regionFaces = new Set<number>();
  for (const index of included) for (const face of perLoop[index] ?? []) regionFaces.add(face);
  const orderedFaces = [...regionFaces].sort((a, b) => a - b);

  let patchFaces = 0;
  for (const index of included) patchFaces += loops[index]?.patchFaceCount ?? 0;
  const welder = new LocalWelder(positions, (orderedFaces.length + patchFaces + 1) * 3);

  const triangles = new Uint32Array((orderedFaces.length + patchFaces) * 3);
  let write = 0;
  for (const face of orderedFaces) {
    for (let corner = 0; corner < 3; corner += 1) {
      triangles[write] = welder.idOf(indices[face * 3 + corner] ?? 0);
      write += 1;
    }
  }

  const loopRanges = new Uint32Array(included.length * 2);
  const loopIds: string[] = [];
  let faceCursor = orderedFaces.length;
  for (const [slot, index] of included.entries()) {
    const loop = loops[index];
    if (loop === undefined) continue;
    loopRanges[slot * 2] = faceCursor;
    for (const corner of loop.patch) {
      triangles[write] = welder.idOf(corner);
      write += 1;
    }
    faceCursor += loop.patchFaceCount;
    loopRanges[slot * 2 + 1] = faceCursor;
    loopIds.push(loop.id);
  }

  return {
    positions: welder.positions(),
    triangles,
    sourceFaceCount: orderedFaces.length,
    loopRanges,
    loopIds,
    excluded,
  };
}

function faceBounds(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  face: number,
  min: number[],
  max: number[],
): void {
  for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Infinity;
    max[axis] = -Infinity;
  }
  for (let corner = 0; corner < 3; corner += 1) {
    const base = (indices[face * 3 + corner] ?? 0) * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[base + axis] ?? 0;
      if (value < (min[axis] ?? 0)) min[axis] = value;
      if (value > (max[axis] ?? 0)) max[axis] = value;
    }
  }
}

function overlaps(
  aMin: ArrayLike<number>,
  aMax: ArrayLike<number>,
  bMin: ArrayLike<number>,
  bMax: ArrayLike<number>,
): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if ((aMax[axis] ?? 0) < (bMin[axis] ?? 0) || (bMax[axis] ?? 0) < (aMin[axis] ?? 0))
      return false;
  }
  return true;
}

/** Exact-coordinate welding of the region's corners into local ids. */
class LocalWelder {
  private readonly table: Int32Array;
  private readonly mask: number;
  private readonly corners: number[] = [];
  private readonly source: ArrayLike<number>;

  public constructor(source: ArrayLike<number>, expected: number) {
    this.source = source;
    const capacity = tableCapacityFor(Math.max(1, expected));
    this.mask = capacity - 1;
    this.table = new Int32Array(capacity).fill(-1);
  }

  private coordinate(corner: number, axis: number): number {
    const value = this.source[corner * 3 + axis] ?? 0;
    return value === 0 ? 0 : value;
  }

  public idOf(corner: number): number {
    const x = this.coordinate(corner, 0);
    const y = this.coordinate(corner, 1);
    const z = this.coordinate(corner, 2);
    let slot = exactStoredCoordinateIdentity.hash(x, y, z) & this.mask;
    for (;;) {
      const existing = this.table[slot] ?? -1;
      if (existing === -1) {
        const id = this.corners.length;
        this.table[slot] = id;
        this.corners.push(corner);
        return id;
      }
      const other = this.corners[existing] ?? 0;
      if (
        this.coordinate(other, 0) === x &&
        this.coordinate(other, 1) === y &&
        this.coordinate(other, 2) === z
      ) {
        return existing;
      }
      slot = (slot + 1) & this.mask;
    }
  }

  public positions(): Float64Array {
    const out = new Float64Array(this.corners.length * 3);
    for (const [id, corner] of this.corners.entries()) {
      out[id * 3] = this.coordinate(corner, 0);
      out[id * 3 + 1] = this.coordinate(corner, 1);
      out[id * 3 + 2] = this.coordinate(corner, 2);
    }
    return out;
  }
}
