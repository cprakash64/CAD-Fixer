import { createIndexArray, createPositionArray } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { recoverVertexIdentity } from '@cadfixer/mesh-topology';

/**
 * THE CANDIDATE-NEUTRAL TRANSFER REPRESENTATION — evaluation only.
 *
 * THIS IS THE CODE THAT FABRICATED EVIDENCE ONCE, so it now lives in one place
 * with tests around it instead of inline in a bench suite.
 *
 * Stage 3A-2's first version handed candidates DE-INDEXED SOUP — every triangle
 * carrying its own three corners, sharing nothing. Under that representation no
 * two faces are adjacent, so PMP happily ingested the bow-tie and the
 * non-manifold-edge fixtures (every triangle is an isolated, trivially manifold
 * island) and Manifold rejected almost everything as non-manifold. Both results
 * were properties of the harness, and both looked exactly like properties of
 * the kernels.
 *
 * Welding uses the Stage 2 exact stored-coordinate identity — the same
 * connectivity recovery the product performs, no tolerance, per ADR 0009 — so
 * each candidate receives the topology a production integration would really
 * hand it.
 */
export interface TransferMesh {
  readonly positions: Float64Array;
  readonly triangles: Uint32Array;
}

export function toTransfer(mesh: CanonicalMesh): TransferMesh {
  const identity = recoverVertexIdentity(mesh);
  const positions = new Float64Array(identity.vertexCount * 3);
  for (let v = 0; v < identity.vertexCount; v += 1) {
    const corner = (identity.vertexRepresentativeCorner[v] ?? 0) * 3;
    positions[v * 3] = mesh.positions[corner] ?? 0;
    positions[v * 3 + 1] = mesh.positions[corner + 1] ?? 0;
    positions[v * 3 + 2] = mesh.positions[corner + 2] ?? 0;
  }

  const triangles = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i += 1) {
    triangles[i] = identity.cornerToVertex[mesh.indices[i] ?? 0] ?? 0;
  }
  return { positions, triangles };
}

/**
 * Rebuilds a canonical soup mesh from a candidate's indexed output, so OUR
 * validators judge it.
 *
 * Deliberately de-indexes: Stage 2 recovers identity from coordinates, and
 * handing it a candidate's own vertex numbering would let a candidate's
 * indexing choices influence the diagnosis of its own output.
 */
export function fromTransfer(
  positions: readonly number[] | Float64Array,
  triangles: readonly number[] | Uint32Array,
): CanonicalMesh {
  const out = createPositionArray(triangles.length * 3);
  const indices = createIndexArray(triangles.length);
  for (let i = 0; i < triangles.length; i += 1) {
    const source = (triangles[i] ?? 0) * 3;
    out[i * 3] = positions[source] ?? 0;
    out[i * 3 + 1] = positions[source + 1] ?? 0;
    out[i * 3 + 2] = positions[source + 2] ?? 0;
    indices[i] = i;
  }
  return {
    positions: out,
    indices,
    metadata: { sourceFormat: 'stl' },
  };
}
