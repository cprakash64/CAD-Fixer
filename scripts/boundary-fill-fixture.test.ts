import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology, scanBoundaries } from '@cadfixer/mesh-topology';
import { admitBoundaryLoops } from '@cadfixer/mesh-hole-fill';
import { uncancellable } from '@cadfixer/shared';
import { gridForTriangles, holedCubeStl } from './boundary-fill-fixture.mjs';

/**
 * The REPAIR-CORE-02 qualification fixture is what it claims to be: a closed
 * cube whose only boundaries are the openings it was built with.
 */

function soupFromBinaryStl(bytes: Uint8Array): CanonicalMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const positions = createPositionArray(count * 9);
  const indices = createIndexArray(count * 3);
  for (let face = 0; face < count; face += 1) {
    const base = 84 + face * 50 + 12;
    for (let k = 0; k < 9; k += 1) positions[face * 9 + k] = view.getFloat32(base + k * 4, true);
    indices[face * 3] = face * 3;
    indices[face * 3 + 1] = face * 3 + 1;
    indices[face * 3 + 2] = face * 3 + 2;
  }
  return { positions, indices, metadata: { sourceFormat: 'stl' } };
}

describe('the holed-cube fixture', () => {
  it('has exactly 6 fillable simple openings and 7 branched boundaries, and nothing else open', () => {
    const fixture = holedCubeStl(24);
    const mesh = soupFromBinaryStl(fixture.bytes);
    const report = analyseTopology(mesh, {
      documentId: 'f',
      partId: 'p',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;
    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.windingConflictEdgeCount).toBe(0);
    expect(report.componentCount).toBe(1);
    // 6 × 4 rim edges + 7 × 8 rim edges.
    expect(report.boundaryEdgeCount).toBe(6 * 4 + 7 * 8);

    const scan = scanBoundaries(mesh, {
      limits: { maxBoundaryEdges: 10_000, maxLoopVertices: 512 },
    });
    const admission = admitBoundaryLoops(mesh, scan);
    expect(admission.admitted).toHaveLength(6);
    expect(admission.decisions.filter((d) => d.verdict === 'NOT_SIMPLE')).toHaveLength(7);
  });

  it('sizes the grid for a target triangle count', () => {
    const grid = gridForTriangles(2_000_000);
    expect(Math.abs(12 * grid * grid - 2_000_000) / 2_000_000).toBeLessThan(0.01);
  });
});
