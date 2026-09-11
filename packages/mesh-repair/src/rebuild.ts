import { createIndexArray, createPositionArray, vertexCount } from '@cadfixer/mesh-core';
import type { CanonicalMesh, MeshGroup } from '@cadfixer/mesh-core';

/**
 * Builds the candidate mesh from a removal mask and a flip mask.
 *
 * WHAT THIS FUNCTION IS ALLOWED TO DECIDE: nothing. The removal mask and the
 * flip mask arrive already decided, by the plan and by the winding solver. This
 * is the step that MATERIALISES that decision, and Stage 4B-1D changed how — and
 * only how.
 *
 * REPRESENTATION IS PRESERVED — Stage 4B-1D. The candidate keeps the source's
 * indexed structure: the surviving faces' original index triplets, in source
 * face order, over the source's own vertices. Until Stage 4B-1D this wrote three
 * INDEPENDENT vertices per surviving face and an identity index buffer, because
 * the canonical representation was assumed to be STL soup. For an STL that was
 * what the source already was, so nothing was lost and every STL test passed.
 * For an OBJ or a 3MF — genuinely indexed, routinely with an order of magnitude
 * more faces than vertices — removing ONE duplicate face rewrote the whole
 * model: a 1,681-vertex grid came back with 9,600 vertices describing exactly
 * the same surface, and the index structure the file carried was gone.
 *
 * POLICY B — COMPACT ONLY WHAT NOTHING REFERENCES. A vertex every surviving face
 * has stopped using is dropped, and the survivors are renumbered in ASCENDING
 * ORIGINAL INDEX order. The alternative — keeping the whole source vertex table
 * — was rejected because it would have CHANGED OBSERVABLE REPAIR SEMANTICS:
 * `computeBounds` walks every position slot, so a bounding box would no longer
 * shrink when the faces around an extreme corner are removed, and the reported
 * topological vertex count would keep counting points no triangle touches. Both
 * are things today's rebuild gets right, and Stage 4B-1D is not allowed to
 * change them. When nothing is orphaned — the overwhelmingly common case — the
 * remap is the identity and the position buffer is a straight copy of the
 * source's bytes.
 *
 * NOTHING IS WELDED, EVER. Two vertices with identical coordinates and different
 * indices stay two vertices. Merging them would be tolerance welding decided by
 * no user and qualified by nobody, and it would change the surviving topology
 * this function exists to carry across unchanged.
 *
 * POSITIONS ARE COPIED VERBATIM, Float32 slot to Float32 slot, with no
 * arithmetic and no narrowing round trip. A flip reorders a face's three
 * CORNERS; it never touches a coordinate. That is what lets `validate.ts` assert
 * that no coordinate moved, byte for byte, rather than "moved less than some
 * epsilon".
 *
 * PERFORMANCE CONTRACT, because this runs on multi-million-triangle models:
 *   - survivors and retained vertices are counted first, so every output buffer
 *     is allocated exactly once at the right size;
 *   - no `push` per coordinate, no object per face, no `Set` per vertex — the
 *     reference marks and the remap are typed arrays over source vertex ids;
 *   - four linear passes plus one to rebuild groups, each polled for
 *     cancellation on the same batch cadence.
 */

export interface RebuiltCandidate {
  readonly mesh: CanonicalMesh;
  /**
   * Source face index for each candidate face. Length = candidate face count.
   *
   * A typed array, not a map of objects: at two million faces an object per
   * entry would cost hundreds of megabytes to answer a question one
   * `Uint32Array` answers.
   */
  readonly candidateToSourceFace: Uint32Array;
  /** Source indices of removed faces, ascending. Reported as change samples. */
  readonly removedSourceFaces: Uint32Array;
  /** Source indices of flipped faces, ascending. */
  readonly flippedSourceFaces: Uint32Array;
}

export interface RebuildProgress {
  /** Polled between batches so a long compaction stays cancellable. */
  readonly onBatch?: (processed: number) => void;
  readonly batchSize?: number;
}

const DEFAULT_BATCH = 65_536;

export function rebuildCandidate(
  mesh: CanonicalMesh,
  faceCount: number,
  removeMask: Uint8Array | undefined,
  flipMask: Uint8Array | undefined,
  progress: RebuildProgress = {},
): RebuiltCandidate {
  const batchSize = progress.batchSize ?? DEFAULT_BATCH;
  const sourceVertexCount = vertexCount(mesh);

  // The counting pass. It allocates nothing and looks trivial, but it is a full
  // sweep of the model before the copy below has written a byte — long enough on
  // a large mesh to be worth interrupting.
  let survivorCount = 0;
  let removedCount = 0;
  for (let face = 0; face < faceCount; face += 1) {
    if (face % batchSize === 0) progress.onBatch?.(0);
    if (removeMask?.[face] === 1) removedCount += 1;
    else survivorCount += 1;
  }

  /*
   * WHICH SOURCE VERTICES THE SURVIVORS STILL USE.
   *
   * One byte per SOURCE vertex, not per corner: a mesh with a thousand vertices
   * and a hundred thousand faces pays a kilobyte here, and the alternative — a
   * `Set` of ids — would allocate an object per distinct vertex on exactly the
   * meshes this stage exists to keep small.
   */
  const referenced = new Uint8Array(sourceVertexCount);
  for (let face = 0; face < faceCount; face += 1) {
    if (face % batchSize === 0) progress.onBatch?.(face);
    if (removeMask?.[face] === 1) continue;
    const base = face * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = mesh.indices[base + corner] ?? 0;
      if (vertex < sourceVertexCount) referenced[vertex] = 1;
    }
  }

  /*
   * OLD INDEX → NEW INDEX, IN ASCENDING ORIGINAL ORDER.
   *
   * Ascending source order rather than first-use order, and the choice is not
   * cosmetic: it makes the numbering a function of WHICH vertices survived and
   * nothing else, so it cannot change because faces were visited in a different
   * sequence. First-use order would be equally deterministic and would make the
   * result depend on face traversal, which is a coupling with no benefit.
   *
   * Sentinel-free: an unreferenced entry is simply never read, because only a
   * surviving face's corners are looked up and those are referenced by
   * definition.
   */
  const remap = new Uint32Array(sourceVertexCount);
  let keptVertexCount = 0;
  for (let vertex = 0; vertex < sourceVertexCount; vertex += 1) {
    // Reported as 0, like the counting pass above: this walks VERTICES, and the
    // caller's progress scale is faces. A cancellation poll is the point; a
    // number that pretended faces had been processed would be a lie about it.
    if (vertex % batchSize === 0) progress.onBatch?.(0);
    if (referenced[vertex] !== 1) continue;
    remap[vertex] = keptVertexCount;
    keptVertexCount += 1;
  }

  /*
   * THE POSITION BUFFER. When every source vertex is still referenced — the
   * common case, because most repairs remove a face whose corners other faces
   * also use — the remap is the identity and this is one `slice`: the source's
   * bytes, unchanged and uninspected.
   */
  let positions: ReturnType<typeof createPositionArray>;
  if (keptVertexCount === sourceVertexCount) {
    positions = mesh.positions.slice(0, sourceVertexCount * 3);
  } else {
    positions = createPositionArray(keptVertexCount * 3);
    for (let vertex = 0; vertex < sourceVertexCount; vertex += 1) {
      if (vertex % batchSize === 0) progress.onBatch?.(0);
      if (referenced[vertex] !== 1) continue;
      const to = (remap[vertex] ?? 0) * 3;
      const from = vertex * 3;
      // Float32 slot to Float32 slot. The value read is exactly representable as
      // a double and stores back unchanged, negative zero included — no
      // arithmetic, no `Math.fround`, no narrowing round trip.
      positions[to] = mesh.positions[from] ?? 0;
      positions[to + 1] = mesh.positions[from + 1] ?? 0;
      positions[to + 2] = mesh.positions[from + 2] ?? 0;
    }
  }

  const indices = createIndexArray(survivorCount * 3);
  const candidateToSourceFace = new Uint32Array(survivorCount);
  const removedSourceFaces = new Uint32Array(removedCount);
  const flipped: number[] = [];

  let write = 0;
  let removedWrite = 0;
  for (let face = 0; face < faceCount; face += 1) {
    if (face % batchSize === 0) progress.onBatch?.(face);

    if (removeMask?.[face] === 1) {
      removedSourceFaces[removedWrite] = face;
      removedWrite += 1;
      continue;
    }

    const flip = flipMask?.[face] === 1;
    if (flip) flipped.push(face);

    // A flip swaps the second and third corners. Winding reverses; the three
    // referenced vertices are the same vertices, in a different order.
    const sourceBase = face * 3;
    const cornerOrder = flip ? [0, 2, 1] : [0, 1, 2];
    for (const offset of cornerOrder) {
      const vertex = mesh.indices[sourceBase + offset] ?? 0;
      /*
       * `?? vertex` keeps a structurally impossible index OUT OF RANGE rather
       * than silently mapping it to vertex 0. An index past the position buffer
       * cannot occur in resident geometry — import validates it and every
       * mutation is revalidated — and if one ever did, a candidate quietly
       * rewired to the first vertex would be wrong geometry that passes every
       * check. Left out of range, `validateMeshStructure` refuses it.
       */
      indices[write] = remap[vertex] ?? vertex;
      write += 1;
    }

    candidateToSourceFace[write / 3 - 1] = face;
  }
  progress.onBatch?.(faceCount);

  const groups = rebuildGroups(mesh.groups, removeMask, faceCount, batchSize, progress.onBatch);

  return {
    mesh: {
      positions,
      indices,
      ...(groups === undefined ? {} : { groups }),
      metadata: mesh.metadata,
    },
    candidateToSourceFace,
    removedSourceFaces,
    flippedSourceFaces: Uint32Array.from(flipped),
  };
}

/**
 * Recomputes group ranges after face removal.
 *
 * Groups address `indices` by offset and length, so every removal shifts every
 * later group. Leaving stale ranges would silently reassign triangles to the
 * wrong object or material — a data-integrity failure that no topology check
 * would catch, because the geometry would be fine.
 *
 * A group that loses every face becomes zero-length rather than disappearing:
 * dropping it would renumber the remaining groups and break any external
 * reference to "group 3". Zero-length is representable and honest.
 */
function rebuildGroups(
  groups: readonly MeshGroup[] | undefined,
  removeMask: Uint8Array | undefined,
  faceCount: number,
  batchSize: number,
  onBatch: ((processed: number) => void) | undefined,
): MeshGroup[] | undefined {
  if (groups === undefined) return undefined;
  if (removeMask === undefined) return [...groups];

  // Surviving face count before each source face, so a group's new offset is a
  // lookup rather than a rescan.
  const survivorsBefore = new Uint32Array(faceCount + 1);
  for (let face = 0; face < faceCount; face += 1) {
    if (face % batchSize === 0) onBatch?.(faceCount);
    survivorsBefore[face + 1] = (survivorsBefore[face] ?? 0) + (removeMask[face] === 1 ? 0 : 1);
  }

  return groups.map((group) => {
    const firstFace = Math.min(faceCount, Math.floor(group.indexOffset / 3));
    const endFace = Math.min(faceCount, firstFace + Math.floor(group.indexCount / 3));
    const newFirst = survivorsBefore[firstFace] ?? 0;
    const newEnd = survivorsBefore[endFace] ?? newFirst;
    return {
      name: group.name,
      indexOffset: newFirst * 3,
      indexCount: (newEnd - newFirst) * 3,
      ...(group.materialRef === undefined ? {} : { materialRef: group.materialRef }),
    };
  });
}
