import type { CanonicalMesh } from './mesh';
import { triangleCount, vertexCount } from './mesh';

/**
 * Cheap, purely geometric measurements over a canonical mesh.
 *
 * These are NOT topological diagnostics. Nothing here says whether a mesh is
 * watertight, manifold, or printable — that analysis arrives with the repair
 * workflow. These are the numbers a user needs to confirm the file they opened
 * is the model they expected.
 *
 * Everything is a plain function over typed arrays with no platform
 * dependencies, so it runs inside the worker and the main thread never has to
 * walk a multi-million-triangle mesh.
 */

export type Vector3Tuple = readonly [number, number, number];

export interface MeshBounds {
  readonly min: Vector3Tuple;
  readonly max: Vector3Tuple;
  /** max - min, per axis. */
  readonly size: Vector3Tuple;
  /** Midpoint of the box. Not a centre of mass. */
  readonly center: Vector3Tuple;
  /** Radius of a sphere about `center` enclosing every vertex. */
  readonly radius: number;
}

/**
 * Returns `undefined` for a mesh with no vertices, rather than inventing a
 * degenerate box at the origin.
 */
export function computeBounds(mesh: CanonicalMesh): MeshBounds | undefined {
  const positions = mesh.positions;
  if (positions.length < 3) return undefined;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  const limit = positions.length - (positions.length % 3);
  for (let offset = 0; offset < limit; offset += 3) {
    const x = positions[offset] ?? 0;
    const y = positions[offset + 1] ?? 0;
    const z = positions[offset + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return undefined;

  const center: Vector3Tuple = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];

  // Measured rather than derived from the box diagonal, which would overstate
  // the radius for anything that is not a filled cube.
  let radiusSquared = 0;
  for (let offset = 0; offset < limit; offset += 3) {
    const dx = (positions[offset] ?? 0) - center[0];
    const dy = (positions[offset + 1] ?? 0) - center[1];
    const dz = (positions[offset + 2] ?? 0) - center[2];
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared > radiusSquared) radiusSquared = distanceSquared;
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
    center,
    radius: Math.sqrt(radiusSquared),
  };
}

/**
 * Derives per-vertex normals from the geometry.
 *
 * DERIVED DATA, NOT CANONICAL DATA. The result is returned as its own buffer
 * and is never written back into the mesh. Two reasons: a format's stored
 * normals are frequently wrong and must not be treated as authoritative, and
 * shading is a presentation concern that must not alter what the user's file
 * said.
 *
 * Normals are accumulated per triangle and normalised per vertex, so geometry
 * whose vertices are shared between triangles shades smoothly while triangle
 * soup — which is what STL always is — shades flat. Degenerate triangles
 * contribute a zero-length cross product and are skipped, so no `NaN` can enter
 * the buffer.
 */
export function computeVertexNormals(mesh: CanonicalMesh): Float32Array {
  // Float32Array, concretely and deliberately — NOT `NormalArray`. This is a
  // RENDER buffer, and float32 is the vertex-attribute representation this
  // application has SELECTED for its WebGL/Three.js pipeline. (WebGL can accept
  // other attribute formats; it cannot accept float64, and Three.js's
  // `BufferAttribute` path is float32 here.)
  //
  // The point of naming the concrete type is to decouple render precision from
  // canonical precision: whatever ADR 0004 eventually decides for stored
  // geometry, and whatever precision a future geometry kernel works in, the
  // render snapshot stays float32 and converts at the boundary. Using the
  // canonical alias here would silently tie those two decisions together.
  const positions = mesh.positions;
  const indices = mesh.indices;
  const normals = new Float32Array(positions.length);
  const vertices = vertexCount(mesh);
  const triangles = triangleCount(mesh);

  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const base = triangle * 3;
    const a = indices[base] ?? 0;
    const b = indices[base + 1] ?? 0;
    const c = indices[base + 2] ?? 0;
    if (a >= vertices || b >= vertices || c >= vertices) continue;

    const ax = positions[a * 3] ?? 0;
    const ay = positions[a * 3 + 1] ?? 0;
    const az = positions[a * 3 + 2] ?? 0;
    const bx = positions[b * 3] ?? 0;
    const by = positions[b * 3 + 1] ?? 0;
    const bz = positions[b * 3 + 2] ?? 0;
    const cx = positions[c * 3] ?? 0;
    const cy = positions[c * 3 + 1] ?? 0;
    const cz = positions[c * 3 + 2] ?? 0;

    // Right-hand rule over the winding order, which is what actually carries
    // orientation in a triangle mesh.
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    if (nx === 0 && ny === 0 && nz === 0) continue;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) continue;

    for (const vertex of [a, b, c]) {
      normals[vertex * 3] = (normals[vertex * 3] ?? 0) + nx;
      normals[vertex * 3 + 1] = (normals[vertex * 3 + 1] ?? 0) + ny;
      normals[vertex * 3 + 2] = (normals[vertex * 3 + 2] ?? 0) + nz;
    }
  }

  for (let vertex = 0; vertex < vertices; vertex += 1) {
    const offset = vertex * 3;
    const x = normals[offset] ?? 0;
    const y = normals[offset + 1] ?? 0;
    const z = normals[offset + 2] ?? 0;
    const length = Math.sqrt(x * x + y * y + z * z);
    if (length > 0) {
      normals[offset] = x / length;
      normals[offset + 1] = y / length;
      normals[offset + 2] = z / length;
    } else {
      // A vertex touched only by degenerate triangles. Any unit vector is as
      // wrong as any other; an axis normal at least keeps the buffer finite.
      normals[offset] = 0;
      normals[offset + 1] = 0;
      normals[offset + 2] = 1;
    }
  }

  return normals;
}

/**
 * Unit normal of one triangle, or a zero vector when the triangle is
 * degenerate.
 *
 * Used by the STL writers, which must emit a facet normal per triangle and must
 * never emit `NaN`.
 */
export function triangleNormal(
  mesh: CanonicalMesh,
  triangleIndex: number,
  out: Float64Array,
): void {
  const indices = mesh.indices;
  const positions = mesh.positions;
  const base = triangleIndex * 3;
  const a = (indices[base] ?? 0) * 3;
  const b = (indices[base + 1] ?? 0) * 3;
  const c = (indices[base + 2] ?? 0) * 3;

  const ax = positions[a] ?? 0;
  const ay = positions[a + 1] ?? 0;
  const az = positions[a + 2] ?? 0;

  const e1x = (positions[b] ?? 0) - ax;
  const e1y = (positions[b + 1] ?? 0) - ay;
  const e1z = (positions[b + 2] ?? 0) - az;
  const e2x = (positions[c] ?? 0) - ax;
  const e2y = (positions[c + 1] ?? 0) - ay;
  const e2z = (positions[c + 2] ?? 0) - az;

  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);

  if (length > 0 && Number.isFinite(length)) {
    out[0] = nx / length;
    out[1] = ny / length;
    out[2] = nz / length;
    return;
  }

  // Documented policy: a degenerate triangle gets a zero normal, which is what
  // real STL files already contain in abundance, rather than NaN — which would
  // make the output unreadable by other tools.
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
}
