/**
 * The canonical in-memory mesh representation.
 *
 * Scope: an indexed triangle soup with optional per-vertex attributes. This is
 * deliberately NOT a BREP/CAD kernel representation. CAD Fixer's workflows
 * (repair, convert, split, texture, hollow) all operate on printable triangle
 * meshes, and STL/OBJ/3MF all reduce to this.
 *
 * Every format reader must produce this shape and every writer must consume it,
 * so that the number of conversion paths stays linear in the number of formats
 * rather than quadratic.
 */

/**
 * Scalar array type used for vertex positions.
 *
 * UNRESOLVED: Float32 vs Float64. Float32 halves memory and matches GPU upload
 * formats, but loses precision on large models translated far from the origin —
 * a real hazard for repair and boolean work, where coincident-vertex welding
 * depends on absolute tolerances. This alias exists so the decision can be
 * changed in one place after benchmarking against real files. Do not inline
 * `Float32Array` at call sites — allocate through `createPositionArray`.
 * See docs/adr/0004-canonical-mesh-model.md.
 */
export type PositionArray = Float32Array;

/** Triangle indices. Uint32 supports meshes beyond the 65 535-vertex Uint16 limit. */
export type IndexArray = Uint32Array;

/**
 * Allocates a canonical position buffer.
 *
 * A FACTORY, not a bare `new Float32Array`, because a type alias cannot be
 * constructed. Without this, every codec would name the concrete type at its
 * allocation site and `PositionArray` would isolate nothing — which is exactly
 * what had happened: the alias claimed the Float32/Float64 decision changed in
 * one place while four call sites hard-coded `Float32Array`.
 *
 * Every producer of canonical geometry must allocate through here.
 */
export function createPositionArray(length: number): PositionArray {
  return new Float32Array(length);
}

/** Allocates a canonical index buffer. See `createPositionArray`. */
export function createIndexArray(length: number): IndexArray {
  return new Uint32Array(length);
}

/** Per-vertex normals, same length and ordering as positions. */
export type NormalArray = Float32Array;

/** Per-vertex UV coordinates, two components per vertex. */
export type UvArray = Float32Array;

/** Identifier of the format a mesh was read from. Mirrors `@cadfixer/file-formats`. */
export type SourceFormatId = string;

/**
 * A contiguous run of triangles sharing a material or object assignment.
 *
 * OBJ groups and 3MF objects both map here. Preserved on import so that export
 * can round-trip them rather than silently flattening the user's model.
 */
export interface MeshGroup {
  readonly name: string;
  /** Offset into `indices`, in indices (not triangles). Must be a multiple of 3. */
  readonly indexOffset: number;
  /** Length in indices (not triangles). Must be a multiple of 3. */
  readonly indexCount: number;
  /** Opaque material reference resolved by the format layer, when the source had one. */
  readonly materialRef?: string;
}

export interface MeshMetadata {
  /** Format the mesh was read from, or `undefined` if constructed in-app. */
  readonly sourceFormat?: SourceFormatId;
}

export interface CanonicalMesh {
  /** Interleaved XYZ triplets. Length is `vertexCount * 3`. */
  readonly positions: PositionArray;
  /** Triangle vertex indices. Length is `triangleCount * 3`. */
  readonly indices: IndexArray;
  readonly normals?: NormalArray;
  readonly uvs?: UvArray;
  readonly groups?: readonly MeshGroup[];
  readonly metadata: MeshMetadata;
}

/**
 * Counts are derived rather than stored, so they cannot drift out of sync with
 * the underlying buffers.
 */
export function vertexCount(mesh: CanonicalMesh): number {
  return Math.floor(mesh.positions.length / 3);
}

export function triangleCount(mesh: CanonicalMesh): number {
  return Math.floor(mesh.indices.length / 3);
}

/**
 * Bytes of geometry a mesh occupies.
 *
 * DEFINED HERE, not in the runtime that used to own it, because two callers now
 * need the same answer: the resident store budgets what it holds, and document
 * validation budgets what it is about to admit. Two independent byte sums would
 * be a drift bug waiting for the day one of them learns about a new attribute.
 */
export function meshByteLength(mesh: CanonicalMesh): number {
  let bytes = mesh.positions.byteLength + mesh.indices.byteLength;
  if (mesh.normals) bytes += mesh.normals.byteLength;
  if (mesh.uvs) bytes += mesh.uvs.byteLength;
  return bytes;
}

/**
 * The buffers a mesh owns, for use as a `postMessage` transfer list.
 *
 * Transferring detaches these buffers in the sending realm. See
 * docs/ARCHITECTURE.md for the ownership rules.
 */
export function meshTransferables(mesh: CanonicalMesh): ArrayBufferLike[] {
  const buffers: ArrayBufferLike[] = [mesh.positions.buffer, mesh.indices.buffer];
  if (mesh.normals) buffers.push(mesh.normals.buffer);
  if (mesh.uvs) buffers.push(mesh.uvs.buffer);
  // De-duplicate: attributes may be views over one shared buffer, and passing
  // the same buffer twice in a transfer list throws a DataCloneError.
  return [...new Set(buffers)];
}
