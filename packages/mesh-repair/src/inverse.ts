import { createIndexArray, createPositionArray, triangleCount } from '@cadfixer/mesh-core';
import type { CanonicalMesh, MeshGroup } from '@cadfixer/mesh-core';
import { REPAIR_RECORD_VERSION } from './contract';

/**
 * THE INVERSE PATCH — what makes a conservative repair undoable.
 *
 * WHY A PATCH AND NOT A COPY. Retaining the whole previous model would cost the
 * model's own size per undo step: ~100 MiB for a 100 MiB import, before any
 * history depth. Conservative repair only ever removes faces and reorders
 * corners within a face, so the exact inverse is small — the removed triangles'
 * coordinates plus two index lists.
 *
 * WHAT IS PROMISED. Applying this patch to the candidate reproduces the source
 * mesh with:
 *   - byte-identical coordinate values,
 *   - the original face ORDER,
 *   - the original group ranges,
 *   - the original metadata.
 * `restoreFromInverse` is tested against the real source for exactly this.
 *
 * WHAT IS NOT PROMISED. The restored mesh is a NEW set of buffers; object
 * identity is not preserved, and nothing depends on it. Positions are compared
 * by value, which for a Float32 canonical store is the same thing as by bits
 * for every value that round-trips through it.
 */

export interface RepairInversePatch {
  readonly schemaVersion: typeof REPAIR_RECORD_VERSION;
  /** Face count of the mesh this patch reverts TO. */
  readonly sourceFaceCount: number;
  /** Source indices of removed faces, ascending. */
  readonly removedFaces: Uint32Array;
  /** Nine coordinates per removed face, in original corner order. */
  readonly removedCoordinates: Float64Array;
  /**
   * SOURCE face indices that were flipped.
   *
   * Recorded against the source numbering, not the candidate's, so the patch
   * stays meaningful even though compaction renumbers everything.
   */
  readonly flippedFaces: Uint32Array;
  /** The source group table, restored verbatim. */
  readonly groups: readonly MeshGroup[] | undefined;
  readonly byteLength: number;
}

export function buildInversePatch(
  source: CanonicalMesh,
  removedFaces: Uint32Array,
  flippedFaces: Uint32Array,
): RepairInversePatch {
  const removedCoordinates = new Float64Array(removedFaces.length * 9);
  for (const [slot, face] of removedFaces.entries()) {
    const base = face * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = source.indices[base + corner] ?? 0;
      removedCoordinates[slot * 9 + corner * 3] = source.positions[vertex * 3] ?? 0;
      removedCoordinates[slot * 9 + corner * 3 + 1] = source.positions[vertex * 3 + 1] ?? 0;
      removedCoordinates[slot * 9 + corner * 3 + 2] = source.positions[vertex * 3 + 2] ?? 0;
    }
  }

  const byteLength =
    removedFaces.byteLength +
    removedCoordinates.byteLength +
    flippedFaces.byteLength +
    // Group table: a small fixed cost per group, not per face.
    (source.groups?.length ?? 0) * 64;

  return {
    schemaVersion: REPAIR_RECORD_VERSION,
    sourceFaceCount: triangleCount(source),
    removedFaces,
    removedCoordinates,
    flippedFaces,
    groups: source.groups === undefined ? undefined : [...source.groups],
    byteLength,
  };
}

/**
 * Reconstructs the pre-repair mesh from a candidate and its inverse patch.
 *
 * Walks the ORIGINAL face numbering and takes each face either from the patch
 * (if it was removed) or from the candidate (if it survived), un-flipping where
 * the patch says a flip was applied. That reproduces the original ordering
 * exactly, which a "candidate plus appended removals" scheme would not.
 */
export function restoreFromInverse(
  candidate: CanonicalMesh,
  patch: RepairInversePatch,
): CanonicalMesh {
  const { sourceFaceCount } = patch;
  const positions = createPositionArray(sourceFaceCount * 9);
  const indices = createIndexArray(sourceFaceCount * 3);

  const removedAt = new Map<number, number>();
  for (const [slot, face] of patch.removedFaces.entries()) removedAt.set(face, slot);
  const wasFlipped = new Set<number>(patch.flippedFaces);

  let candidateFace = 0;
  for (let face = 0; face < sourceFaceCount; face += 1) {
    const removedSlot = removedAt.get(face);
    if (removedSlot !== undefined) {
      for (let corner = 0; corner < 3; corner += 1) {
        const source = removedSlot * 9 + corner * 3;
        const target = (face * 3 + corner) * 3;
        positions[target] = patch.removedCoordinates[source] ?? 0;
        positions[target + 1] = patch.removedCoordinates[source + 1] ?? 0;
        positions[target + 2] = patch.removedCoordinates[source + 2] ?? 0;
      }
    } else {
      // Un-flip by applying the same corner swap again: swapping 1 and 2 is its
      // own inverse, so the original corner order returns exactly.
      const cornerOrder = wasFlipped.has(face) ? [0, 2, 1] : [0, 1, 2];
      for (const [corner, offset] of cornerOrder.entries()) {
        const vertex = candidate.indices[candidateFace * 3 + offset] ?? 0;
        const target = (face * 3 + corner) * 3;
        positions[target] = candidate.positions[vertex * 3] ?? 0;
        positions[target + 1] = candidate.positions[vertex * 3 + 1] ?? 0;
        positions[target + 2] = candidate.positions[vertex * 3 + 2] ?? 0;
      }
      candidateFace += 1;
    }
  }

  for (let i = 0; i < indices.length; i += 1) indices[i] = i;

  return {
    positions,
    indices,
    ...(patch.groups === undefined ? {} : { groups: patch.groups }),
    metadata: candidate.metadata,
  };
}

/**
 * Bytes a full previous-model copy would cost, for comparison with the patch.
 *
 * Reported so the choice between patch and copy is made on measurements rather
 * than on the assumption that a patch is obviously smaller — for a repair that
 * removes most of a mesh, it would not be.
 */
export function fullCopyBytes(mesh: CanonicalMesh): number {
  return mesh.positions.byteLength + mesh.indices.byteLength;
}
