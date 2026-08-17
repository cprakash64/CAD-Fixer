import { createIndexArray, createPositionArray } from '@cadfixer/mesh-core';
import type { CanonicalMesh, MeshGroup } from '@cadfixer/mesh-core';

/**
 * Builds the candidate mesh from a removal mask and a flip mask.
 *
 * PERFORMANCE CONTRACT, because this runs on multi-million-triangle models:
 *   - surviving faces are counted first, so both output buffers are allocated
 *     exactly once at the right size;
 *   - no `push` per coordinate, no object per face, no `Set` per vertex;
 *   - one linear pass to copy, one to rebuild groups.
 *
 * POSITIONS ARE COPIED VERBATIM. A flip reorders a face's three CORNERS; it
 * never touches a coordinate. That is what lets `validate.ts` assert that no
 * coordinate moved, byte for byte, rather than "moved less than some epsilon".
 *
 * SOUP IN, SOUP OUT. The canonical representation is non-indexed triangle soup
 * (STL has no shared vertices), so compaction copies three corners per surviving
 * face and re-numbers indices sequentially. Vertex identity is recovered from
 * coordinates when it is needed, per ADR 0009 — it is not stored.
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
  /** Source indices of removed faces, ascending. Drives the inverse patch. */
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

  let survivorCount = 0;
  let removedCount = 0;
  for (let face = 0; face < faceCount; face += 1) {
    if (removeMask?.[face] === 1) removedCount += 1;
    else survivorCount += 1;
  }

  const positions = createPositionArray(survivorCount * 9);
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
    // stored coordinate triples are the same values, in a different order.
    const sourceBase = face * 3;
    const cornerOrder = flip ? [0, 2, 1] : [0, 1, 2];
    for (const offset of cornerOrder) {
      const vertex = mesh.indices[sourceBase + offset] ?? 0;
      positions[write * 3] = mesh.positions[vertex * 3] ?? 0;
      positions[write * 3 + 1] = mesh.positions[vertex * 3 + 1] ?? 0;
      positions[write * 3 + 2] = mesh.positions[vertex * 3 + 2] ?? 0;
      indices[write] = write;
      write += 1;
    }

    candidateToSourceFace[write / 3 - 1] = face;
  }
  progress.onBatch?.(faceCount);

  const groups = rebuildGroups(mesh.groups, removeMask, faceCount);

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
): MeshGroup[] | undefined {
  if (groups === undefined) return undefined;
  if (removeMask === undefined) return [...groups];

  // Surviving face count before each source face, so a group's new offset is a
  // lookup rather than a rescan.
  const survivorsBefore = new Uint32Array(faceCount + 1);
  for (let face = 0; face < faceCount; face += 1) {
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
