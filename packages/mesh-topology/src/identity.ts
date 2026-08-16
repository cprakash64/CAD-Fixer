import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { stage, type StageMemory } from './memory';

/**
 * EXACT STORED-COORDINATE VERTEX IDENTITY.
 *
 * STL enters the system as triangle soup: every facet carries three full vertex
 * positions, so a cube has 36 corners rather than 8 and the canonical indices
 * are the sequence 0,1,2,3,… Those indices carry no connectivity information.
 * Topology therefore has to be RECOVERED, and the only question that matters is
 * which corners denote the same point.
 *
 * THE POLICY — `exact-stored-coordinate`:
 *
 *   1. Coordinates compare exactly as stored. Two corners are the same
 *      topological vertex if and only if all three components are equal.
 *   2. `+0` and `-0` denote the same coordinate and are normalised together.
 *      They are distinct bit patterns but the same point.
 *   3. No epsilon. No tolerance. No "close enough".
 *   4. No unit assumption may influence identity — STL states no unit, so any
 *      distance threshold would be a guess about scale.
 *   5. Two distinct representable values remain distinct, however close. Points
 *      one ULP apart are two vertices, and the report says so.
 *   6. Non-finite coordinates are rejected during parsing and structural
 *      validation. Analysis re-checks rather than trusting that, because a
 *      NaN here would silently corrupt every downstream count.
 *
 * WHY NOT TOLERANCE WELDING. Merging near-coincident vertices changes the
 * recovered topology: a model with a hairline crack becomes "closed", and the
 * defect the user came to find disappears from the report. Welding is a repair
 * decision with a tolerance the user must choose, and it belongs to the repair
 * stage. Stage 2 reports the factual state of the stored coordinates.
 *
 * PRECISION INDEPENDENCE. Nothing here assumes the canonical storage is
 * Float32. Coordinates are read as JavaScript numbers — that is, as float64 —
 * and hashed from the float64 bit pattern. A value loaded from a Float32Array
 * is exactly representable as a double, so equality and hashing agree for
 * either storage width. ADR 0004 can change `PositionArray` without touching
 * this file; only `CoordinateIdentity` below would need revisiting, and only if
 * a future storage type were not losslessly readable as a double.
 */

/**
 * The one place that knows how a coordinate becomes a hash and an equality.
 *
 * Isolated behind an interface so that a future canonical precision change is a
 * change to one implementation rather than a hunt through the engine for
 * `Float32Array` checks and bit-twiddling.
 */
export interface CoordinateIdentity {
  /** Stable name recorded in the report, so a result states its own rules. */
  readonly mode: string;
  /** Collapses `-0` to `+0`. Any other value is returned unchanged. */
  normalize(value: number): number;
  /** 32-bit hash of a normalised triple. Equal triples MUST hash equally. */
  hash(x: number, y: number, z: number): number;
}

const bitsBuffer = new ArrayBuffer(8);
const bitsFloat = new Float64Array(bitsBuffer);
const bitsWords = new Uint32Array(bitsBuffer);

/** Murmur3-style 32-bit finaliser. Cheap, and mixes high bits down. */
function mix32(value: number): number {
  let h = value | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The default identity: exact float64 comparison with signed-zero normalisation.
 *
 * Hashing goes through the float64 bit pattern rather than arithmetic, because
 * arithmetic hashing of floats collides badly on structured data — and CAD
 * meshes are nothing but structured data (lattices, repeated offsets, axis
 * planes). Equal doubles always have identical bit patterns once `-0` is
 * normalised, so equal points always hash equally.
 */
export const exactStoredCoordinateIdentity: CoordinateIdentity = {
  mode: 'exact-stored-coordinate',

  normalize(value: number): number {
    // `value === 0` is true for both zeros; adding 0 turns -0 into +0 and
    // leaves every other value untouched.
    return value === 0 ? 0 : value;
  },

  hash(x: number, y: number, z: number): number {
    let h = 0x9e3779b9;
    // Unrolled deliberately: this runs once per corner, three times, on meshes
    // with millions of corners.
    bitsFloat[0] = x;
    h = mix32(h ^ (bitsWords[0] ?? 0));
    h = mix32(h ^ (bitsWords[1] ?? 0));
    bitsFloat[0] = y;
    h = mix32(h ^ (bitsWords[0] ?? 0));
    h = mix32(h ^ (bitsWords[1] ?? 0));
    bitsFloat[0] = z;
    h = mix32(h ^ (bitsWords[0] ?? 0));
    h = mix32(h ^ (bitsWords[1] ?? 0));
    return h >>> 0;
  },
};

export interface VertexIdentityResult {
  /** For each source corner, the topological vertex it denotes. Length = corners. */
  readonly cornerToVertex: Uint32Array;
  /** For each topological vertex, a corner whose coordinates define it. */
  readonly vertexRepresentativeCorner: Uint32Array;
  readonly vertexCount: number;
  readonly cornerCount: number;
  readonly mode: string;
}

export interface VertexIdentityOptions {
  readonly identity?: CoordinateIdentity;
  /** Polled between batches so a long canonicalisation can be cancelled. */
  onBatch?(cornersProcessed: number): void;
}

/** Corners handled between cancellation/progress checks. */
const CORNERS_PER_BATCH = 65_536;

/**
 * Recovers topological vertex identity for every corner.
 *
 * ALGORITHM — open-addressed hash table in typed arrays, linear probing.
 *
 * For each corner in source order: hash its normalised coordinates, probe the
 * table, and compare candidates by EXACT coordinate equality. A hash match is
 * never sufficient on its own — collisions are resolved by reading both points
 * back and comparing all three components — so identity is exact regardless of
 * hash quality.
 *
 * Vertex ids are assigned in order of first appearance while scanning corners
 * 0..N-1. That makes the numbering deterministic and independent of hash
 * iteration order, which is what lets the public report be deterministic
 * without sorting anything.
 *
 * COMPLEXITY — O(N) expected time for N corners, with the table kept below 70%
 * load so probe chains stay short. No pairwise comparison exists anywhere.
 *
 * MEMORY — three typed arrays and no per-corner objects:
 *   cornerToVertex              4N bytes
 *   vertexRepresentativeCorner  4N bytes (worst case: every corner distinct)
 *   probe table                 4 * capacity, capacity ≈ 2N rounded to a power of two
 * roughly 16N bytes total, and nothing is allocated per corner.
 *
 * Deliberately NOT stored: the coordinates themselves. Candidates are compared
 * by reading `positions` through the representative corner, which costs one
 * indirection and saves 24 bytes per vertex.
 */
export function recoverVertexIdentity(
  mesh: CanonicalMesh,
  options: VertexIdentityOptions = {},
): VertexIdentityResult {
  const identity = options.identity ?? exactStoredCoordinateIdentity;
  const positions = mesh.positions;
  const cornerCount = Math.floor(positions.length / 3);

  const cornerToVertex = new Uint32Array(cornerCount);
  const vertexRepresentativeCorner = new Uint32Array(cornerCount);

  const capacity = tableCapacityFor(cornerCount);
  const mask = capacity - 1;
  // -1 marks an empty slot; Int32Array so the sentinel is representable.
  const table = new Int32Array(capacity).fill(-1);

  let vertexCount = 0;

  for (let corner = 0; corner < cornerCount; corner += 1) {
    if (corner % CORNERS_PER_BATCH === 0) options.onBatch?.(corner);

    const base = corner * 3;
    const x = identity.normalize(positions[base] ?? 0);
    const y = identity.normalize(positions[base + 1] ?? 0);
    const z = identity.normalize(positions[base + 2] ?? 0);

    let slot = identity.hash(x, y, z) & mask;

    for (;;) {
      const existing = table[slot] ?? -1;
      if (existing === -1) {
        // First time this point has been seen. Its id is the next in first-
        // appearance order, which is what makes numbering deterministic.
        cornerToVertex[corner] = vertexCount;
        vertexRepresentativeCorner[vertexCount] = corner;
        table[slot] = vertexCount;
        vertexCount += 1;
        break;
      }

      // A hash match proves nothing. Compare the actual coordinates.
      const repBase = (vertexRepresentativeCorner[existing] ?? 0) * 3;
      if (
        identity.normalize(positions[repBase] ?? 0) === x &&
        identity.normalize(positions[repBase + 1] ?? 0) === y &&
        identity.normalize(positions[repBase + 2] ?? 0) === z
      ) {
        cornerToVertex[corner] = existing;
        break;
      }

      slot = (slot + 1) & mask;
    }
  }

  options.onBatch?.(cornerCount);

  return {
    cornerToVertex,
    // Trimmed to the vertices actually found, so downstream sizing is exact.
    vertexRepresentativeCorner: vertexRepresentativeCorner.subarray(0, vertexCount),
    vertexCount,
    cornerCount,
    mode: identity.mode,
  };
}

/**
 * Power-of-two capacity holding `count` entries below ~70% load.
 *
 * A power of two lets the probe use a mask instead of a modulo, which matters
 * at millions of corners.
 */
export function tableCapacityFor(count: number): number {
  if (count <= 0) return 1;
  const target = Math.ceil(count / 0.7);
  let capacity = 1;
  while (capacity < target) capacity *= 2;
  return capacity;
}

/** Bytes `recoverVertexIdentity` will allocate. Used by the memory preflight. */
export function estimateVertexIdentityBytes(cornerCount: number): StageMemory {
  // Retained: cornerToVertex, plus vertexRepresentativeCorner — allocated at
  // full corner length and only subarray-trimmed on return, so the whole buffer
  // survives however few distinct vertices were found.
  const retained = cornerCount * 4 + cornerCount * 4;
  // Released with the function: the open-addressed probe table.
  const transient = tableCapacityFor(cornerCount) * 4;
  return stage(retained, transient);
}
