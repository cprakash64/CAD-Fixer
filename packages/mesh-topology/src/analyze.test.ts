import { describe, expect, it } from 'vitest';
import { uncancellable } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology } from './analyze';
import { BoundaryKind } from './components';
import { PrintabilityStatus, SelfIntersectionStatus, type TopologyResult } from './report';
import { VolumeStatus } from './metrics';
import * as fixtures from './fixtures';

/**
 * The Stage 2C-1 correctness matrix.
 *
 * Every fixture is triangle soup — independent corners, sequential indices —
 * because that is what STL import produces. A test built on a pre-indexed mesh
 * would pass while the real pipeline failed, since soup is exactly the case
 * where connectivity has to be recovered from coordinates rather than read from
 * indices.
 *
 * These assert mathematically meaningful values, not "is defined". Returning
 * zeros or defaults from the analysis would fail nearly every case here.
 */

function analyse(mesh: CanonicalMesh): TopologyResult {
  return analyseTopology(mesh, {
    documentId: 'model-test',
    partId: 'part-1',
    documentRevision: 1,
    cancellation: uncancellable,
  });
}

describe('A — single triangle', () => {
  it('has three boundary edges forming one loop, in one component', () => {
    const { report } = analyse(fixtures.singleTriangle());

    expect(report.sourceFaceCount).toBe(1);
    expect(report.topologicalVertexCount).toBe(3);
    expect(report.uniqueEdgeCount).toBe(3);
    expect(report.boundaryEdgeCount).toBe(3);
    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.componentCount).toBe(1);
    expect(report.isBoundaryFree).toBe(false);
    // Three edges, every vertex of boundary degree 2: a cycle.
    expect(report.simpleBoundaryLoopCount).toBe(1);
  });
});

describe('B — two-triangle square, correct winding', () => {
  it('shares one ordinary edge with no winding conflict', () => {
    const { report } = analyse(fixtures.square());

    expect(report.topologicalVertexCount).toBe(4);
    expect(report.uniqueEdgeCount).toBe(5);
    expect(report.boundaryEdgeCount).toBe(4);
    expect(report.ordinaryEdgeCount).toBe(1);
    expect(report.windingConflictEdgeCount).toBe(0);
    expect(report.isWindingConsistent).toBe(true);
    expect(report.componentCount).toBe(1);
    expect(report.simpleBoundaryLoopCount).toBe(1);
  });
});

describe('C — two-triangle square, wrong winding', () => {
  it('reports the shared edge as a winding conflict', () => {
    const { report } = analyse(fixtures.squareWrongWinding());

    expect(report.ordinaryEdgeCount).toBe(1);
    expect(report.windingConflictEdgeCount).toBe(1);
    expect(report.isWindingConsistent).toBe(false);
    // The defect is orientation only — the mesh is still edge-manifold.
    expect(report.nonManifoldEdgeCount).toBe(0);
  });
});

describe('D — closed tetrahedron', () => {
  it('is closed, manifold, χ = 2, with non-zero signed volume', () => {
    const { report } = analyse(fixtures.tetrahedron());

    expect(report.sourceFaceCount).toBe(4);
    expect(report.topologicalVertexCount).toBe(4);
    expect(report.uniqueEdgeCount).toBe(6);
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.isBoundaryFree).toBe(true);
    expect(report.isEdgeManifold).toBe(true);
    expect(report.isVertexManifold).toBe(true);
    expect(report.isWindingConsistent).toBe(true);
    expect(report.componentCount).toBe(1);
    // V - E + F = 4 - 6 + 4 = 2, the sphere.
    expect(report.components[0]?.eulerCharacteristic).toBe(2);
    // The unit corner tetrahedron has volume 1/6.
    expect(Math.abs(report.totalSignedVolume)).toBeCloseTo(1 / 6, 10);
    expect(report.components[0]?.volumeStatus).toBe(VolumeStatus.ClosedManifold);
  });
});

describe('E — tetrahedron with one face reversed', () => {
  it('reports winding conflicts on that face’s edges', () => {
    const { report } = analyse(fixtures.tetrahedronOneFaceReversed());

    expect(report.windingConflictEdgeCount).toBeGreaterThan(0);
    expect(report.isWindingConsistent).toBe(false);
    // Still closed and edge-manifold — only the orientation is wrong.
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.components[0]?.volumeStatus).toBe(VolumeStatus.NotInterpretable);
  });
});

describe('F — two disconnected tetrahedra', () => {
  it('reports two components', () => {
    const { report } = analyse(fixtures.twoTetrahedra());

    expect(report.componentCount).toBe(2);
    expect(report.topologicalVertexCount).toBe(8);
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.components).toHaveLength(2);
    expect(report.components[0]?.faceCount).toBe(4);
    expect(report.components[1]?.faceCount).toBe(4);
  });
});

describe('G — three triangles sharing one edge', () => {
  it('reports exactly one non-manifold edge', () => {
    const { report } = analyse(fixtures.threeTrianglesSharingEdge());

    expect(report.nonManifoldEdgeCount).toBe(1);
    expect(report.isEdgeManifold).toBe(false);
    // The shared edge's endpoints cannot have disc neighbourhoods either.
    expect(report.nonManifoldVertexCount).toBeGreaterThan(0);
  });
});

describe('H — BOW-TIE VERTEX (mandatory)', () => {
  /**
   * The case that edge-only manifold checks miss. Two square patches touch at
   * exactly one vertex; no edge is shared between them, so every edge has at
   * most two incident faces. Only genuine fan analysis finds the pinch.
   */
  it('detects a non-manifold vertex with NO non-manifold edge', () => {
    const { report } = analyse(fixtures.bowTieVertex());

    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.isEdgeManifold).toBe(true);

    expect(report.nonManifoldVertexCount).toBe(1);
    expect(report.isVertexManifold).toBe(false);
  });

  it('keeps the two patches as separate face components', () => {
    // They touch at a point, not across an edge, so they are not
    // face-connected. Calling them one component would hide the pinch.
    const { report } = analyse(fixtures.bowTieVertex());

    expect(report.componentCount).toBe(2);
  });

  it('is not reported as printable', () => {
    const { report } = analyse(fixtures.bowTieVertex());

    expect(report.printabilityStatus).toBe(PrintabilityStatus.TopologicalDefects);
  });

  /**
   * Component-local values, worked out from the fixture geometry rather than
   * read back from the implementation.
   *
   * Patch 1 is apex(0,0,0), A(1,0,0), B(1,1,0), C(0,1,0) as triangles
   * (apex,A,B) and (apex,B,C):
   *   V = 4   {apex, A, B, C}
   *   E = 5   {apex-A, A-B, apex-B, B-C, apex-C}
   *   F = 2
   *   χ = 4 − 5 + 2 = 1        (a disc)
   *   boundary = 4             (every edge but the shared apex-B diagonal)
   * Patch 2 is the mirror image, so identical.
   *
   * The apex is a member of BOTH local vertex sets. Denying it to one of them
   * would give that component V = 3 and χ = 0, which is not a disc and not what
   * the geometry is.
   */
  it('counts the shared apex in BOTH component vertex sets', () => {
    const { report } = analyse(fixtures.bowTieVertex());

    expect(report.components).toHaveLength(2);

    for (const component of report.components) {
      expect(component.faceCount).toBe(2);
      expect(component.topologicalVertexCount).toBe(4);
      expect(component.edgeCount).toBe(5);
      expect(component.eulerCharacteristic).toBe(1);
      expect(component.boundaryEdgeCount).toBe(4);
    }
  });

  it('keeps the apex a single global vertex even though both components see it', () => {
    const { report } = analyse(fixtures.bowTieVertex());

    // 4 + 4 corners, with the apex shared: 7 globally unique.
    expect(report.topologicalVertexCount).toBe(7);
    expect(report.uniqueEdgeCount).toBe(10);
    expect(report.sourceFaceCount).toBe(4);

    // The overlap shows up here, and must not be removed by adjusting either
    // side: 4 + 4 = 8 = 7 global + 1 vertex belonging to two components.
    const summed = report.components.reduce((total, c) => total + c.topologicalVertexCount, 0);
    expect(summed).toBe(8);
    expect(summed).toBe(report.topologicalVertexCount + 1);
  });

  it('reports the singularity in both components, not just the first', () => {
    const { report } = analyse(fixtures.bowTieVertex());

    for (const component of report.components) {
      expect(component.nonManifoldVertexCount).toBe(1);
      expect(component.nonManifoldEdgeCount).toBe(0);
    }
    // Globally it is still one non-manifold vertex.
    expect(report.nonManifoldVertexCount).toBe(1);
  });
});

describe('X — two CLOSED shells touching at exactly one vertex', () => {
  /**
   * Independent protection for the same rule, with closed components.
   *
   * Two tetrahedra, the second the first reflected through the origin, touching
   * only at (0,0,0). Per shell, from the geometry:
   *   V = 4, E = 6, F = 4, χ = 4 − 6 + 4 = 2   (a sphere)
   * Globally V = 7, because the apex is one vertex, not two.
   */
  it('stays two face components despite the point of contact', () => {
    const { report } = analyse(fixtures.tetrahedraTouchingAtOneVertex());

    expect(report.componentCount).toBe(2);
    // Touching at a point shares no edge, so nothing merges.
    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.isEdgeManifold).toBe(true);
  });

  it('has one global apex vertex that appears in both local vertex sets', () => {
    const { report } = analyse(fixtures.tetrahedraTouchingAtOneVertex());

    expect(report.topologicalVertexCount).toBe(7);
    expect(report.uniqueEdgeCount).toBe(12);
    expect(report.sourceFaceCount).toBe(8);

    expect(report.components).toHaveLength(2);
    for (const component of report.components) {
      expect(component.topologicalVertexCount).toBe(4);
      expect(component.edgeCount).toBe(6);
      expect(component.faceCount).toBe(4);
      expect(component.eulerCharacteristic).toBe(2);
      expect(component.boundaryEdgeCount).toBe(0);
    }

    const summed = report.components.reduce((total, c) => total + c.topologicalVertexCount, 0);
    expect(summed).toBe(8);
    expect(summed).toBe(report.topologicalVertexCount + 1);
  });

  it('flags the pinch in both components and measures each shell', () => {
    const { report } = analyse(fixtures.tetrahedraTouchingAtOneVertex());

    expect(report.nonManifoldVertexCount).toBe(1);
    for (const component of report.components) {
      expect(component.nonManifoldVertexCount).toBe(1);
      // Both shells are wound outward, so each encloses +1/6.
      expect(component.signedVolume).toBeCloseTo(1 / 6, 10);
      // Closed, but pinched at a vertex, so not a manifold surface.
      expect(component.volumeStatus).toBe(VolumeStatus.NotInterpretable);
    }
    expect(report.totalSignedVolume).toBeCloseTo(1 / 3, 10);
  });

  it('is unaffected by the order the faces arrive in', () => {
    const permuted = analyse(
      fixtures.permuteFaceOrder(fixtures.tetrahedraTouchingAtOneVertex()),
    ).report;

    expect(permuted.componentCount).toBe(2);
    expect(permuted.topologicalVertexCount).toBe(7);
    for (const component of permuted.components) {
      expect(component.topologicalVertexCount).toBe(4);
      expect(component.edgeCount).toBe(6);
      expect(component.faceCount).toBe(4);
      expect(component.eulerCharacteristic).toBe(2);
    }
  });
});

describe('I — cube missing one face', () => {
  it('has a four-edge simple boundary loop', () => {
    const { report } = analyse(fixtures.cubeMissingOneFace());

    expect(report.topologicalVertexCount).toBe(8);
    expect(report.boundaryEdgeCount).toBe(4);
    expect(report.simpleBoundaryLoopCount).toBe(1);
    expect(report.branchedBoundaryCount).toBe(0);
    expect(report.componentCount).toBe(1);
    expect(report.boundaryComponents[0]?.kind).toBe(BoundaryKind.SimpleLoop);
  });
});

describe('J — branched boundary', () => {
  it('is reported as branched, not as a simple loop', () => {
    const { report } = analyse(fixtures.branchedBoundary());

    expect(report.branchedBoundaryCount).toBeGreaterThan(0);
    expect(report.simpleBoundaryLoopCount).toBe(0);
    expect(report.boundaryComponents.some((c) => c.kind === BoundaryKind.Branched)).toBe(true);
  });
});

describe('K/L — duplicate faces', () => {
  it('counts a same-orientation duplicate as one extra face', () => {
    const { report } = analyse(fixtures.duplicateSameOrientation());

    expect(report.sameOrientationDuplicateCount).toBe(1);
    expect(report.reversedOrientationDuplicateCount).toBe(0);
  });

  it('counts a reversed-orientation duplicate separately', () => {
    const { report } = analyse(fixtures.duplicateReversedOrientation());

    expect(report.reversedOrientationDuplicateCount).toBe(1);
    expect(report.sameOrientationDuplicateCount).toBe(0);
  });

  it('does not remove duplicates from the face count', () => {
    const { report } = analyse(fixtures.duplicateSameOrientation());

    expect(report.sourceFaceCount).toBe(2);
  });
});

describe('M/N — degenerate faces', () => {
  it('detects repeated-position degeneracy despite distinct soup indices', () => {
    const { report } = analyse(fixtures.repeatedPositionTriangle());

    // Source corners are 0,1,2 — all different — so only recovered identity
    // can see this.
    expect(report.repeatedPositionFaceCount).toBe(1);
    expect(report.zeroAreaFaceCount).toBe(0);
    expect(report.topologicalVertexCount).toBe(2);
  });

  it('detects exact zero-area collinearity', () => {
    const { report } = analyse(fixtures.collinearTriangle());

    expect(report.zeroAreaFaceCount).toBe(1);
    expect(report.repeatedPositionFaceCount).toBe(0);
    expect(report.totalSurfaceArea).toBe(0);
  });

  it('keeps the categories exclusive so counts do not double up', () => {
    const { report } = analyse(fixtures.repeatedPositionTriangle());

    expect(report.repeatedPositionFaceCount + report.zeroAreaFaceCount).toBe(1);
  });
});

describe('O — signed zero', () => {
  it('treats -0 and +0 as the same topological vertex', () => {
    const { report } = analyse(fixtures.signedZeroPair());

    // Both triangles reference the origin; if -0 and +0 were distinct there
    // would be 5 vertices and no shared edge.
    expect(report.topologicalVertexCount).toBe(4);
    expect(report.componentCount).toBe(1);
  });
});

describe('P — near but not equal', () => {
  it('keeps two adjacent representable values distinct', () => {
    const { mesh, a, b } = fixtures.nearButDistinctPair();

    // The fixture must genuinely differ once stored, or this proves nothing.
    expect(b).not.toBe(a);

    const { report } = analyse(mesh);

    // 4 vertices: two distinct x-values plus the two shared points.
    expect(report.topologicalVertexCount).toBe(4);
    // No tolerance merged them, so the faces share an edge but not the apex.
    expect(report.componentCount).toBe(1);
  });
});

describe('Q/R — extreme coordinate magnitudes', () => {
  it('recovers correct topology at very large coordinates', () => {
    const { report } = analyse(fixtures.tetrahedron([1e7, -1e7, 1e7], 1000));

    expect(report.topologicalVertexCount).toBe(4);
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.componentCount).toBe(1);
  });

  it('merges nothing at very small coordinates', () => {
    const { report } = analyse(fixtures.tetrahedron([0, 0, 0], 1e-6));

    expect(report.topologicalVertexCount).toBe(4);
    expect(report.uniqueEdgeCount).toBe(6);
    expect(report.boundaryEdgeCount).toBe(0);
  });
});

describe('S — face-order permutation', () => {
  it('leaves aggregate topology unchanged', () => {
    const original = analyse(fixtures.tetrahedron()).report;
    const permuted = analyse(fixtures.permuteFaceOrder(fixtures.tetrahedron())).report;

    expect(permuted.topologicalVertexCount).toBe(original.topologicalVertexCount);
    expect(permuted.uniqueEdgeCount).toBe(original.uniqueEdgeCount);
    expect(permuted.boundaryEdgeCount).toBe(original.boundaryEdgeCount);
    expect(permuted.componentCount).toBe(original.componentCount);
    expect(permuted.windingConflictEdgeCount).toBe(original.windingConflictEdgeCount);
    expect(permuted.totalSurfaceArea).toBeCloseTo(original.totalSurfaceArea, 12);
  });
});

describe('T — global translation', () => {
  it('leaves topology and area invariant and keeps volume stable', () => {
    const original = analyse(fixtures.tetrahedron()).report;
    const moved = analyse(fixtures.translate(fixtures.tetrahedron(), [1000, -2000, 3000])).report;

    expect(moved.topologicalVertexCount).toBe(original.topologicalVertexCount);
    expect(moved.uniqueEdgeCount).toBe(original.uniqueEdgeCount);
    expect(moved.componentCount).toBe(original.componentCount);
    expect(moved.totalSurfaceArea).toBeCloseTo(original.totalSurfaceArea, 6);

    // Component-local reference points are what keep this stable; summing
    // world-origin tetrahedra would lose most of the significant digits here.
    expect(moved.totalSignedVolume).toBeCloseTo(original.totalSignedVolume, 6);
  });
});

describe('U — uniform scale', () => {
  it('scales area by s² and volume by s³', () => {
    const s = 3;
    const original = analyse(fixtures.tetrahedron()).report;
    const scaled = analyse(fixtures.scale(fixtures.tetrahedron(), s)).report;

    expect(scaled.totalSurfaceArea).toBeCloseTo(original.totalSurfaceArea * s * s, 8);
    expect(scaled.totalSignedVolume).toBeCloseTo(original.totalSignedVolume * s * s * s, 8);
    expect(scaled.topologicalVertexCount).toBe(original.topologicalVertexCount);
  });
});

describe('V — whole-mesh orientation reversal', () => {
  it('keeps topology counts and flips the volume sign', () => {
    const original = analyse(fixtures.tetrahedron()).report;
    const reversed = analyse(fixtures.reverseWinding(fixtures.tetrahedron())).report;

    expect(reversed.topologicalVertexCount).toBe(original.topologicalVertexCount);
    expect(reversed.uniqueEdgeCount).toBe(original.uniqueEdgeCount);
    expect(reversed.boundaryEdgeCount).toBe(original.boundaryEdgeCount);
    // Reversing every face keeps the surface consistently oriented.
    expect(reversed.windingConflictEdgeCount).toBe(0);

    expect(reversed.totalSignedVolume).toBeCloseTo(-original.totalSignedVolume, 12);
    expect(Math.sign(reversed.totalSignedVolume)).toBe(-Math.sign(original.totalSignedVolume));
  });
});

describe('W — combinatorially closed but self-intersecting', () => {
  it('never claims printability, and self-intersection stays NOT CHECKED', () => {
    // Two closed tetrahedra that overlap in space. Topology alone cannot see
    // the interpenetration, and Stage 2 does not look.
    const { report } = analyse(fixtures.overlappingClosedShells());

    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.isEdgeManifold).toBe(true);
    expect(report.selfIntersectionStatus).toBe(SelfIntersectionStatus.NotChecked);
    expect(report.printabilityStatus).toBe(PrintabilityStatus.NotFullyDetermined);
    // Explicitly: there is no `printable: true` anywhere in the contract.
    expect(Object.keys(report)).not.toContain('printable');
  });
});

describe('report contract', () => {
  it('carries the model identity and the identity mode it used', () => {
    const result = analyseTopology(fixtures.tetrahedron(), {
      documentId: 'model-42',
      partId: 'part-1',
      documentRevision: 7,
      cancellation: uncancellable,
    });

    expect(result.report.documentId).toBe('model-42');
    expect(result.report.documentRevision).toBe(7);
    expect(result.report.identityMode).toBe('exact-stored-coordinate');
    expect(result.report.schemaVersion).toBe(1);
  });

  it('always reports self-intersection as not checked, even for clean input', () => {
    const { report } = analyse(fixtures.tetrahedron());

    expect(report.selfIntersectionStatus).toBe(SelfIntersectionStatus.NotChecked);
    expect(report.printabilityStatus).toBe(PrintabilityStatus.NotFullyDetermined);
  });
});
