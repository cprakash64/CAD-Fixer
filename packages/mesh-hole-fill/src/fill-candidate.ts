import { createIndexArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import type { AdmittedLoop } from './admission';

/**
 * THE FILLED CANDIDATE AND ITS INDEPENDENT VERDICT — REPAIR-CORE-02.
 *
 * APPEND-ONLY. The candidate is the source's position buffer, SHARED by
 * reference because no point is added or moved, and a new index buffer whose
 * prefix is the source's index bytes verbatim, followed by every patch. Face
 * `f < sourceFaceCount` keeps meaning what it meant; groups are carried over
 * unchanged and patch faces join none, exactly as the per-opening workflow
 * does.
 *
 * THE ALGORITHM DOES NOT DECIDE ITS OWN SUCCESS. The candidate is re-analysed by
 * Stage 2 — the whole part, by the same engine that produced the report the user
 * saw — and `judgeFilledCandidate` compares that report against what closing
 * exactly these loops must do. Every count is predicted exactly; only area is
 * compared relatively, because summation order changes and float addition is
 * not associative.
 */

export function appendPatches(
  source: CanonicalMesh,
  loops: readonly AdmittedLoop[],
): CanonicalMesh {
  let patchIndices = 0;
  for (const loop of loops) patchIndices += loop.patch.length;
  const indices = createIndexArray(source.indices.length + patchIndices);
  indices.set(source.indices, 0);
  let write = source.indices.length;
  for (const loop of loops) {
    indices.set(loop.patch, write);
    write += loop.patch.length;
  }
  return {
    positions: source.positions,
    indices,
    ...(source.normals === undefined ? {} : { normals: source.normals }),
    ...(source.uvs === undefined ? {} : { uvs: source.uvs }),
    ...(source.groups === undefined ? {} : { groups: source.groups }),
    metadata: source.metadata,
  };
}

export const FillRegression = {
  FaceCount: 'FACE_COUNT',
  BoundaryEdges: 'BOUNDARY_EDGES',
  BoundaryComponents: 'BOUNDARY_COMPONENTS',
  NonManifoldEdges: 'NON_MANIFOLD_EDGES',
  NonManifoldVertices: 'NON_MANIFOLD_VERTICES',
  WindingConflicts: 'WINDING_CONFLICTS',
  Components: 'COMPONENTS',
  Vertices: 'VERTICES',
  Duplicates: 'DUPLICATES',
  Degenerate: 'DEGENERATE',
  SurfaceArea: 'SURFACE_AREA',
  SourceRewritten: 'SOURCE_REWRITTEN',
} as const;

export type FillRegression = (typeof FillRegression)[keyof typeof FillRegression];

/** What closing exactly `loops` must do to a report, count by count. */
export function judgeFilledCandidate(
  before: TopologyReport,
  after: TopologyReport,
  loops: readonly AdmittedLoop[],
): readonly FillRegression[] {
  let rimEdges = 0;
  let patchFaces = 0;
  let patchArea = 0;
  for (const loop of loops) {
    rimEdges += loop.vertexCount;
    patchFaces += loop.patchFaceCount;
    patchArea += loop.patchArea;
  }
  const components = (report: TopologyReport): number =>
    report.simpleBoundaryLoopCount + report.openBoundaryChainCount + report.branchedBoundaryCount;

  const regressions: FillRegression[] = [];
  if (after.sourceFaceCount !== before.sourceFaceCount + patchFaces) {
    regressions.push(FillRegression.FaceCount);
  }
  // Every rim edge gains its second face; every diagonal is new and used twice.
  if (after.boundaryEdgeCount !== before.boundaryEdgeCount - rimEdges) {
    regressions.push(FillRegression.BoundaryEdges);
  }
  if (components(after) !== components(before) - loops.length) {
    regressions.push(FillRegression.BoundaryComponents);
  }
  if (after.nonManifoldEdgeCount !== before.nonManifoldEdgeCount) {
    regressions.push(FillRegression.NonManifoldEdges);
  }
  // Closing a manifold boundary fan cannot create a pinch; a vertex that was
  // already pinched stays pinched. Never more.
  if (after.nonManifoldVertexCount > before.nonManifoldVertexCount) {
    regressions.push(FillRegression.NonManifoldVertices);
  }
  if (after.windingConflictEdgeCount !== before.windingConflictEdgeCount) {
    regressions.push(FillRegression.WindingConflicts);
  }
  // A patch attaches to one component along its whole rim; it joins nothing.
  if (after.componentCount !== before.componentCount) regressions.push(FillRegression.Components);
  if (after.topologicalVertexCount !== before.topologicalVertexCount) {
    regressions.push(FillRegression.Vertices);
  }
  if (
    after.sameOrientationDuplicateCount !== before.sameOrientationDuplicateCount ||
    after.reversedOrientationDuplicateCount !== before.reversedOrientationDuplicateCount
  ) {
    regressions.push(FillRegression.Duplicates);
  }
  if (
    after.repeatedPositionFaceCount !== before.repeatedPositionFaceCount ||
    after.zeroAreaFaceCount !== before.zeroAreaFaceCount
  ) {
    regressions.push(FillRegression.Degenerate);
  }
  const expected = before.totalSurfaceArea + patchArea;
  if (Math.abs(after.totalSurfaceArea - expected) > Math.max(1, Math.abs(expected)) * 1e-9) {
    regressions.push(FillRegression.SurfaceArea);
  }
  return regressions;
}

/**
 * The candidate must BEGIN with the source's index bytes and share its position
 * buffer. Compared as bytes, so `-0` and NaN payloads compare as stored.
 */
export function sourcePreserved(source: CanonicalMesh, candidate: CanonicalMesh): boolean {
  if (candidate.positions !== source.positions) {
    if (candidate.positions.byteLength !== source.positions.byteLength) return false;
    const a = new Uint8Array(
      source.positions.buffer,
      source.positions.byteOffset,
      source.positions.byteLength,
    );
    const b = new Uint8Array(
      candidate.positions.buffer,
      candidate.positions.byteOffset,
      candidate.positions.byteLength,
    );
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  }
  if (candidate.indices.byteLength < source.indices.byteLength) return false;
  const a = new Uint8Array(
    source.indices.buffer,
    source.indices.byteOffset,
    source.indices.byteLength,
  );
  const b = new Uint8Array(
    candidate.indices.buffer,
    candidate.indices.byteOffset,
    source.indices.byteLength,
  );
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
