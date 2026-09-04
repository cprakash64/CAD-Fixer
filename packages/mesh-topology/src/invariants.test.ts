import { describe, expect, it } from 'vitest';
import { AppErrorCode, CancellationSource, isAppError, uncancellable } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  analyseTopology,
  estimateDetailBytes,
  estimateTopologyWorkspaceBytes,
  type TopologyProgress,
} from './analyze';
import { estimateEdgeBytes } from './edges';
import { estimateVertexIdentityBytes } from './identity';
import { estimateManifoldBytes } from './manifold';
import { peakOf, stage } from './memory';
import * as fixtures from './fixtures';

/**
 * The invariants that make this engine safe to point at a user's model:
 * it reads and never writes, it answers the same way twice, and it stops when
 * asked without leaving anything half-finished.
 */

/** A mesh with enough structure that every analysis phase does real work. */
function busyMesh(): CanonicalMesh {
  const triangles: (readonly [fixtures.Point, fixtures.Point, fixtures.Point])[] = [];
  for (let i = 0; i < 4000; i += 1) {
    const x = i % 64;
    const y = Math.floor(i / 64);
    triangles.push([
      [x, y, 0],
      [x + 1, y, 0],
      [x, y + 1, 0],
    ]);
    triangles.push([
      [x + 1, y, 0],
      [x + 1, y + 1, 0],
      [x, y + 1, 0],
    ]);
  }
  return fixtures.soup(triangles);
}

describe('non-mutation', () => {
  /**
   * THE CORE PRINCIPLE. Analysis is read-only: no welding, no reordering, no
   * dropping, no flipping, no index rewriting. Compared byte for byte rather
   * than by length, because a length check would pass even if every coordinate
   * had been overwritten.
   */
  it('leaves canonical positions and indices byte-identical', () => {
    const mesh = fixtures.cubeMissingOneFace();
    const positionsBefore = new Uint8Array(mesh.positions.buffer.slice(0));
    const indicesBefore = new Uint8Array(mesh.indices.buffer.slice(0));

    analyseTopology(mesh, {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    });

    expect(new Uint8Array(mesh.positions.buffer)).toEqual(positionsBefore);
    expect(new Uint8Array(mesh.indices.buffer)).toEqual(indicesBefore);
  });

  it('does not weld a mesh that has coincident-but-distinct points', () => {
    const { mesh } = fixtures.nearButDistinctPair();
    const before = new Uint8Array(mesh.positions.buffer.slice(0));

    analyseTopology(mesh, {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    });

    expect(new Uint8Array(mesh.positions.buffer)).toEqual(before);
  });

  it('does not remove degenerate or duplicate faces', () => {
    const mesh = fixtures.duplicateSameOrientation();
    const cornersBefore = mesh.positions.length;

    const { report } = analyseTopology(mesh, {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    });

    expect(mesh.positions.length).toBe(cornersBefore);
    expect(report.sourceFaceCount).toBe(2);
  });

  it('leaves the mesh untouched even when analysis is cancelled midway', () => {
    const mesh = busyMesh();
    const before = new Uint8Array(mesh.positions.buffer.slice(0));
    const source = new CancellationSource();

    try {
      analyseTopology(mesh, {
        documentId: 'model-1',
        partId: 'part-1',
        documentRevision: 1,
        cancellation: source.token,
        onPhaseStart: (phase) => {
          if (phase === 'building edges') source.cancel();
        },
      });
    } catch {
      // Expected; the assertion below is the point.
    }

    expect(new Uint8Array(mesh.positions.buffer)).toEqual(before);
  });
});

describe('determinism', () => {
  /**
   * Internal hashing must never leak into the public result. Vertex ids are
   * assigned in first-appearance order and components are labelled by smallest
   * member face, so repeated runs agree exactly.
   */
  it('produces identical reports across repeated runs', () => {
    const mesh = fixtures.cubeMissingOneFace();
    const options = {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    };

    const first = analyseTopology(mesh, options).report;
    const second = analyseTopology(mesh, options).report;

    // Timing is the one field allowed to differ, so it is neutralised rather
    // than dropped — every other field is still compared.
    expect({ ...second, analysisMilliseconds: 0 }).toEqual({ ...first, analysisMilliseconds: 0 });
  });

  it('produces identical detail samples across repeated runs', () => {
    const mesh = fixtures.cubeMissingOneFace();
    const options = {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    };

    const first = analyseTopology(mesh, options).detail;
    const second = analyseTopology(mesh, options).detail;

    expect([...second.boundaryEdges]).toEqual([...first.boundaryEdges]);
    expect([...second.degenerateFaces]).toEqual([...first.degenerateFaces]);
  });

  it('orders components deterministically by smallest member face', () => {
    const mesh = fixtures.twoTetrahedra();

    const report = analyseTopology(mesh, {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;

    expect(report.components.map((c) => c.componentId)).toEqual([0, 1]);
  });
});

describe('progress', () => {
  it('is monotonic, bounded, and only completes with a valid report', () => {
    const seen: TopologyProgress[] = [];

    const { report } = analyseTopology(busyMesh(), {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
      onProgress: (progress) => seen.push(progress),
    });

    expect(seen.length).toBeGreaterThan(5);
    for (const entry of seen) {
      expect(entry.fraction).toBeGreaterThanOrEqual(0);
      expect(entry.fraction).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]?.fraction).toBeGreaterThanOrEqual(seen[i - 1]?.fraction ?? 0);
    }
    // Completion is only reached once the report exists.
    expect(seen.at(-1)?.fraction).toBe(1);
    expect(report.sourceFaceCount).toBeGreaterThan(0);
  });

  it('names the phase it is in', () => {
    const phases = new Set<string>();

    analyseTopology(fixtures.tetrahedron(), {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
      onProgress: (progress) => phases.add(progress.phase),
    });

    expect(phases.has('canonicalizing vertices')).toBe(true);
    expect(phases.has('analyzing vertex fans')).toBe(true);
  });
});

describe('cancellation', () => {
  /**
   * Cancellation is tested at three separate phases rather than "somewhere in
   * the middle", because each is a different loop with its own polling.
   * `onPhaseStart` makes the point deterministic — no timing luck involved.
   */
  function cancelAt(phase: string): unknown {
    const source = new CancellationSource();
    try {
      analyseTopology(busyMesh(), {
        documentId: 'model-1',
        partId: 'part-1',
        documentRevision: 1,
        cancellation: source.token,
        onPhaseStart: (started) => {
          if (started === phase) source.cancel();
        },
      });
      return undefined;
    } catch (caught) {
      return caught;
    }
  }

  it.each([['canonicalizing vertices'], ['analyzing edge incidence'], ['analyzing vertex fans']])(
    'stops during %s with a typed cancellation',
    (phase) => {
      const caught = cancelAt(phase);

      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.OperationCancelled);
    },
  );

  it('publishes no report when cancelled', () => {
    const source = new CancellationSource();
    let result: unknown;

    try {
      result = analyseTopology(busyMesh(), {
        documentId: 'model-1',
        partId: 'part-1',
        documentRevision: 1,
        cancellation: source.token,
        onPhaseStart: (phase) => {
          if (phase === 'finding components') source.cancel();
        },
      });
    } catch {
      result = undefined;
    }

    // A partial report is worse than none: it would look authoritative.
    expect(result).toBeUndefined();
  });

  it('never reports progress of 1 for a cancelled analysis', () => {
    const source = new CancellationSource();
    const seen: number[] = [];

    try {
      analyseTopology(busyMesh(), {
        documentId: 'model-1',
        partId: 'part-1',
        documentRevision: 1,
        cancellation: source.token,
        onProgress: (progress) => seen.push(progress.fraction),
        onPhaseStart: (phase) => {
          if (phase === 'analyzing vertex fans') source.cancel();
        },
      });
    } catch {
      // Expected.
    }

    expect(seen.every((fraction) => fraction < 1)).toBe(true);
  });
});

describe('global versus component-local counts', () => {
  /**
   * Which per-component values partition the mesh and which may overlap is a
   * contract, not an accident, so both halves are pinned. Faces and edges
   * partition — every face has one component, and sharing an edge is what
   * merges components, so an edge cannot be in two. Vertices do not partition,
   * because a point of contact belongs to both sides.
   */
  it('partitions faces and edges, but not vertices', () => {
    const { report } = analyseTopology(fixtures.tetrahedraTouchingAtOneVertex(), {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    });

    const sum = (pick: (c: (typeof report.components)[number]) => number): number =>
      report.components.reduce((total, component) => total + pick(component), 0);

    expect(sum((c) => c.faceCount)).toBe(report.sourceFaceCount);
    expect(sum((c) => c.edgeCount)).toBe(report.uniqueEdgeCount);
    expect(sum((c) => c.boundaryEdgeCount)).toBe(report.boundaryEdgeCount);
    expect(sum((c) => c.nonManifoldEdgeCount)).toBe(report.nonManifoldEdgeCount);

    // The overlap. Deliberately asserted as an inequality with an exact value,
    // so a future change that "fixes" the sum would fail here rather than pass
    // quietly.
    expect(sum((c) => c.topologicalVertexCount)).toBe(report.topologicalVertexCount + 1);
  });

  it('keeps global counts deduplicated when components overlap', () => {
    const shared = analyseTopology(fixtures.tetrahedraTouchingAtOneVertex(), {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;
    const separate = analyseTopology(fixtures.twoTetrahedra(), {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;

    // Same face and edge totals; exactly one fewer global vertex, because one
    // vertex is shared instead of duplicated. The local counts do not leak into
    // the global ones.
    expect(shared.sourceFaceCount).toBe(separate.sourceFaceCount);
    expect(shared.uniqueEdgeCount).toBe(separate.uniqueEdgeCount);
    expect(shared.topologicalVertexCount).toBe(separate.topologicalVertexCount - 1);
    expect(separate.topologicalVertexCount).toBe(8);
    expect(shared.topologicalVertexCount).toBe(7);
  });

  it('does not mutate the mesh while computing component-local sets', () => {
    const mesh = fixtures.tetrahedraTouchingAtOneVertex();
    const before = new Uint8Array(mesh.positions.buffer.slice(0));

    analyseTopology(mesh, {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    });

    expect(new Uint8Array(mesh.positions.buffer)).toEqual(before);
  });
});

describe('bounded detail output', () => {
  /**
   * The detail payload is transferred out of the worker on every analysis, so
   * its size must follow the DEFECTS found, never the mesh size. An earlier
   * version emitted one position per topological vertex, which made a clean
   * two-million-triangle model pay a ~72 MB transfer to be told it was clean.
   */
  it('emits no vertex payload for a mesh with nothing to point at', () => {
    const { detail } = analyseTopology(fixtures.tetrahedron(), {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    });

    expect(detail.boundaryEdges.length).toBe(0);
    expect(detail.nonManifoldEdges.length).toBe(0);
    expect(detail.sampleVertexIds.length).toBe(0);
    expect(detail.sampleVertexPositions.length).toBe(0);
  });

  it('does not grow the payload as a defect-free mesh grows', () => {
    const measure = (mesh: CanonicalMesh): number => {
      const { detail } = analyseTopology(mesh, {
        documentId: 'model-1',
        partId: 'part-1',
        documentRevision: 1,
        cancellation: uncancellable,
      });
      return detail.sampleVertexIds.byteLength + detail.sampleVertexPositions.byteLength;
    };

    // Closed tetrahedra, so there is no defect to sample at either size.
    let many = fixtures.tetrahedron();
    for (let i = 1; i < 40; i += 1) {
      many = fixtures.concat(many, fixtures.tetrahedron([i * 10, 0, 0]));
    }

    expect(measure(many)).toBe(measure(fixtures.tetrahedron()));
  });

  it('caps the summary lists while keeping the counts exact', () => {
    // 30 separate triangles: 30 face components AND 30 boundary loops, both of
    // which would otherwise be object lists that scale with the mesh.
    let mesh = fixtures.singleTriangle();
    for (let i = 1; i < 30; i += 1) {
      mesh = fixtures.concat(mesh, fixtures.translate(fixtures.singleTriangle(), [i * 10, 0, 0]));
    }

    const { report } = analyseTopology(mesh, {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
      componentSummaryLimit: 4,
    });

    // Exact counts, unaffected by the cap.
    expect(report.componentCount).toBe(30);
    expect(report.simpleBoundaryLoopCount).toBe(30);

    // Capped lists, each saying so.
    expect(report.components).toHaveLength(4);
    expect(report.componentsTruncated).toBe(true);
    expect(report.boundaryComponents).toHaveLength(4);
    expect(report.boundaryComponentsTruncated).toBe(true);
  });

  it('carries exactly the vertices its samples name, in ascending order', () => {
    const { detail } = analyseTopology(fixtures.cubeMissingOneFace(), {
      documentId: 'model-1',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    });

    const named = new Set([...detail.boundaryEdges, ...detail.nonManifoldEdges]);
    expect(named.size).toBeGreaterThan(0);

    const ids = [...detail.sampleVertexIds];
    expect(new Set(ids)).toEqual(named);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(detail.sampleVertexPositions.length).toBe(ids.length * 3);
  });
});

describe('memory preflight estimate', () => {
  it('scales with mesh size and stays an exact integer', () => {
    const small = estimateTopologyWorkspaceBytes(1_000, 3_000);
    const large = estimateTopologyWorkspaceBytes(2_000_000, 6_000_000);

    expect(large).toBeGreaterThan(small);
    expect(Number.isSafeInteger(large)).toBe(true);
  });

  it('treats non-finite or negative counts as unbounded rather than trusting them', () => {
    // A NaN would otherwise compare false against every limit and silently
    // authorise the allocation it was supposed to prevent.
    expect(estimateTopologyWorkspaceBytes(Number.NaN, 10)).toBe(Number.POSITIVE_INFINITY);
    expect(estimateTopologyWorkspaceBytes(10, -1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('is in a plausible range for a two-million-triangle model', () => {
    // Roughly 6M corners. The estimate should be hundreds of MB, not GB or KB —
    // a sanity bound that would catch an order-of-magnitude formula error.
    const bytes = estimateTopologyWorkspaceBytes(2_000_000, 6_000_000);
    const mib = bytes / (1024 * 1024);

    expect(mib).toBeGreaterThan(100);
    expect(mib).toBeLessThan(2048);
  });

  /**
   * THE POINT OF THE ESTIMATE is the SIMULTANEOUSLY LIVE set, not the largest
   * single stage. The edge arrays are still resident when the fan analysis
   * allocates on top of them, so both must appear in the number. A model that
   * reported only the biggest stage would clear an allocation the process
   * cannot actually hold.
   */
  it('covers every retained array at once, not just the largest stage', () => {
    const faces = 2_000_000;
    const corners = 6_000_000;

    const identity = estimateVertexIdentityBytes(corners);
    const edges = estimateEdgeBytes(faces);
    const manifold = estimateManifoldBytes(faces, corners);
    const total = estimateTopologyWorkspaceBytes(faces, corners);

    // Each of these is genuinely live while the others are.
    const coexisting = identity.retained + edges.retained + manifold.retained;
    expect(total).toBeGreaterThan(coexisting);

    // And strictly more than any one stage's whole footprint, which is the
    // failure mode being guarded against.
    for (const single of [identity, edges, manifold]) {
      expect(total).toBeGreaterThan(single.retained + single.transient);
    }
  });

  it('includes the face-vertex mapping the orchestrator itself allocates', () => {
    // 12 bytes per face, allocated in `analyseTopology` rather than in any
    // stage, and read by every stage afterwards. It was missing from the first
    // version of this estimator.
    const faces = 1_000_000;
    const corners = 3_000_000;

    const stages =
      estimateVertexIdentityBytes(corners).retained +
      estimateEdgeBytes(faces).retained +
      estimateManifoldBytes(faces, corners).retained;

    expect(estimateTopologyWorkspaceBytes(faces, corners)).toBeGreaterThanOrEqual(
      stages + faces * 12,
    );
  });

  it('models the peak as the live set plus the largest single transient', () => {
    const peak = peakOf([stage(100, 5), stage(200, 50), stage(0, 20)]);

    // 300 retained coexist; only the 50-byte transient is charged on top.
    expect(peak).toBe(350);
  });

  it('bounds the detail payload by the sample limit alone', () => {
    // Mesh size does not appear, which is what makes the payload bounded.
    const small = estimateDetailBytes(1_000);
    const large = estimateDetailBytes(50_000);

    expect(large).toBe(small * 50);
    expect(estimateDetailBytes(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
  });
});
