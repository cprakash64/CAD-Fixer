import { BufferAttribute, BufferGeometry, Matrix4, Sphere, Vector3 } from 'three';

/**
 * PLACEMENT AND GPU GEOMETRY SHARING FOR MULTI-PART DOCUMENTS.
 *
 * Extracted from `create-viewport` because both halves are decidable without a
 * renderer, and both are places a mistake is invisible until it is expensive:
 * a wrong matrix convention puts a part somewhere it is not, and a wrong
 * reference count either leaks GPU buffers or frees one another part is still
 * drawing from. Neither needs a WebGL context to be wrong, so neither should
 * need one to be tested.
 */

/**
 * A part's row-major 3x4 placement as a Three.js matrix.
 *
 * `Matrix4.set` takes ROW-MAJOR arguments — despite Three.js storing column-
 * major internally — so the twelve values map across directly with the
 * translation column filled from the last three, and the implicit `0 0 0 1`
 * bottom row supplied here rather than being carried in the data.
 */
export function partMatrix(transform: readonly number[]): Matrix4 {
  const matrix = new Matrix4();
  matrix.set(
    transform[0] ?? 1,
    transform[1] ?? 0,
    transform[2] ?? 0,
    transform[9] ?? 0,
    transform[3] ?? 0,
    transform[4] ?? 1,
    transform[5] ?? 0,
    transform[10] ?? 0,
    transform[6] ?? 0,
    transform[7] ?? 0,
    transform[8] ?? 1,
    transform[11] ?? 0,
    0,
    0,
    0,
    1,
  );
  return matrix;
}

interface GeometryEntry {
  readonly geometry: BufferGeometry;
  refCount: number;
}

/**
 * GPU geometry, built once per render buffer and shared by every part that uses
 * it.
 *
 * KEYED BY POSITION ARRAY IDENTITY, which is exactly what the worker arranged:
 * parts sharing an authoritative mesh receive the same `Float32Array`, and
 * structured clone preserves that identity across `postMessage`. Sharing here is
 * therefore a consequence of sharing there, not a separate guess about which
 * buffers happen to be equal.
 *
 * REFERENCE COUNTED, because disposal is the dangerous half. Disposing when the
 * first of a thousand placements goes away would leave nine hundred and ninety
 * nine meshes drawing from a released buffer.
 */
export class SharedPartGeometry {
  private readonly entries = new Map<Float32Array, GeometryEntry>();
  private created = 0;
  private disposed = 0;

  public acquire(
    positions: Float32Array,
    normals: Float32Array,
    center: readonly [number, number, number],
    radius: number,
  ): BufferGeometry {
    const existing = this.entries.get(positions);
    if (existing !== undefined) {
      existing.refCount += 1;
      return existing.geometry;
    }
    const geometry = buildPartGeometry(positions, normals, center, radius);
    this.entries.set(positions, { geometry, refCount: 1 });
    this.created += 1;
    return geometry;
  }

  /** Releases one reference, disposing the geometry only at zero. */
  public release(positions: Float32Array): void {
    const entry = this.entries.get(positions);
    if (entry === undefined) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    entry.geometry.dispose();
    this.disposed += 1;
    this.entries.delete(positions);
  }

  /** Releases every entry. Used when the whole document is replaced. */
  public releaseAll(): void {
    for (const entry of this.entries.values()) {
      entry.geometry.dispose();
      this.disposed += 1;
    }
    this.entries.clear();
  }

  /** Distinct GPU geometries currently held. For leak assertions. */
  public get size(): number {
    return this.entries.size;
  }

  /** References outstanding for one buffer, or 0. For leak assertions. */
  public referencesTo(positions: Float32Array): number {
    return this.entries.get(positions)?.refCount ?? 0;
  }

  /**
   * Cumulative uploads and disposals, for leak and double-dispose assertions.
   *
   * TWO COUNTERS, NOT A LOG. `size` alone cannot distinguish "released once" from
   * "released twice and re-created", and a document loaded and unloaded ten times
   * leaves `size` at zero either way — so a leak or a double dispose would be
   * invisible to any test that only reads the live map. These are monotonic,
   * read-only from outside, and cost two integers; nothing in the rendering path
   * branches on them.
   */
  public get lifecycle(): { readonly created: number; readonly disposed: number } {
    return { created: this.created, disposed: this.disposed };
  }
}

/** Builds GPU geometry from a render snapshot's buffers. */
export function buildPartGeometry(
  positions: Float32Array,
  normals: Float32Array,
  center: readonly [number, number, number],
  radius: number,
): BufferGeometry {
  const geometry = new BufferGeometry();
  // The render snapshot's buffers are REFERENCED, not copied again: they were
  // transferred here from the worker and belong to the main thread now.
  // Three.js uploads them and does not write to them.
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));

  // ASSIGNED, NOT COMPUTED — do not delete this.
  //
  // Three.js computes a bounding sphere lazily during frustum culling
  // (Frustum.intersectsObject -> `if (geometry.boundingSphere === null)
  // geometry.computeBoundingSphere()`). That makes two full passes over the
  // position buffer ON THE UI THREAD, on the first frame after a model
  // loads — 6.3 million vertices walked twice for a 100 MiB model, which is
  // exactly the whole-mesh main-thread work this project forbids.
  //
  // The worker already measured this sphere, so it is handed over instead. The
  // radius is in PART-LOCAL coordinates and the centre is the part's own
  // centre, because both the display offset and the part placement live on
  // object transforms rather than in the vertex data.
  geometry.boundingSphere = new Sphere(
    new Vector3(center[0], center[1], center[2]),
    radius > 0 ? radius : 1,
  );

  return geometry;
}
