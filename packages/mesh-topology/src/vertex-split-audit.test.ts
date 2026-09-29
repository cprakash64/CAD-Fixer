import { describe, expect, it } from 'vitest';
import { uncancellable } from '@cadfixer/shared';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology } from './analyze';
import type { TopologyReport } from './report';

/**
 * REPAIR-UX-01 CAPABILITY AUDIT — "split non-manifold vertex fans".
 *
 * The proposed conservative operation: give each disconnected fan around a
 * non-manifold vertex its OWN vertex record, at the EXACT same stored
 * coordinate, and reassign each fan's triangles to it. No coordinate moves.
 *
 * What these tests establish is that, under ADR 0009's identity policy, such an
 * operation CANNOT change Pybrix's own diagnosis. Topology identifies a vertex
 * by its exact stored coordinate, never by its index, so two records at one
 * point are one topological vertex and the pinch is found again. The repair
 * pipeline accepts a candidate only when re-analysis confirms the targeted
 * defect is gone (`TargetDefectNotRemoved` otherwise), so the operation would
 * be refused by the validator on every input — and any consumer that joins
 * triangles by position, as every STL consumer must, would see the same pinch.
 *
 * Offering it would therefore mean either a repair the validator always
 * rejects, or a change to the identity policy itself — index-based identity
 * for indexed formats — which is an architectural decision (REPAIR-CORE-02),
 * not a repair operation. These tests pin the evidence so that decision is
 * made from it.
 */

type Point = readonly [number, number, number];

function indexed(
  points: readonly Point[],
  faces: readonly (readonly [number, number, number])[],
): CanonicalMesh {
  const positions = createPositionArray(points.length * 3);
  points.forEach((point, index) => {
    positions.set(point, index * 3);
  });
  const indices = createIndexArray(faces.length * 3);
  faces.forEach((face, index) => {
    indices.set(face, index * 3);
  });
  return { positions, indices, metadata: { sourceFormat: '3mf' } };
}

function analyse(mesh: CanonicalMesh): TopologyReport {
  return analyseTopology(mesh, {
    documentId: 'audit',
    partId: 'part-1',
    documentRevision: 1,
    cancellation: uncancellable,
  }).report;
}

const APEX: Point = [0, 0, 0];

/** Two triangles that share ONLY their apex: the minimal bow-tie. */
const BOW_TIE_POINTS: readonly Point[] = [APEX, [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]];

describe('REPAIR-UX-01 audit: splitting a non-manifold vertex without moving it', () => {
  it('finds the bow-tie pinch when the apex is ONE vertex record', () => {
    const report = analyse(
      indexed(BOW_TIE_POINTS, [
        [0, 1, 2],
        [0, 3, 4],
      ]),
    );
    expect(report.nonManifoldVertexCount).toBe(1);
    expect(report.isVertexManifold).toBe(false);
    expect(report.componentCount).toBe(2);
  });

  it('finds the SAME pinch after the apex is split into two records at the same coordinate', () => {
    const split = indexed(
      [...BOW_TIE_POINTS, APEX],
      [
        [0, 1, 2],
        // The second fan now uses its own record, index 5, at the same point.
        [5, 3, 4],
      ],
    );
    const report = analyse(split);

    // Exact-coordinate identity re-joins the two records: nothing changed.
    expect(report.topologicalVertexCount).toBe(5);
    expect(report.nonManifoldVertexCount).toBe(1);
    expect(report.isVertexManifold).toBe(false);
  });

  it('finds the pinch with three fans split three ways, too', () => {
    const points: Point[] = [
      APEX,
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
      [0, 0, 1],
      [1, 1, 1],
    ];
    const joined = analyse(
      indexed(points, [
        [0, 1, 2],
        [0, 3, 4],
        [0, 5, 6],
      ]),
    );
    const split = analyse(
      indexed(
        [...points, APEX, APEX],
        [
          [0, 1, 2],
          [7, 3, 4],
          [8, 5, 6],
        ],
      ),
    );
    expect(joined.nonManifoldVertexCount).toBe(1);
    expect(split.nonManifoldVertexCount).toBe(joined.nonManifoldVertexCount);
    expect(split.topologicalVertexCount).toBe(joined.topologicalVertexCount);
  });

  it('leaves a manifold vertex manifold whichever way it is recorded', () => {
    // A fan of two triangles sharing an EDGE through the apex: one fan, manifold.
    const report = analyse(
      indexed(
        [APEX, [1, 0, 0], [0, 1, 0], [-1, 0, 0]],
        [
          [0, 1, 2],
          [0, 2, 3],
        ],
      ),
    );
    expect(report.nonManifoldVertexCount).toBe(0);
  });
});
