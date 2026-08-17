import { triangleCount } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  analyseComponents,
  analyseEdges,
  analyseVertexManifoldness,
  buildDirectedEdges,
  buildVertexIncidence,
  groupEdges,
  recoverVertexIdentity,
  EdgeClass,
} from '@cadfixer/mesh-topology';
import type {
  ComponentAnalysis,
  DirectedEdges,
  EdgeAnalysis,
  EdgeGroups,
  VertexIdentityResult,
  VertexManifoldAnalysis,
} from '@cadfixer/mesh-topology';

/**
 * The connectivity view every conservative operation shares.
 *
 * WHY ONE VIEW. Duplicate detection, degeneracy classification and the winding
 * parity solve all need the same exact-coordinate identity and the same edge
 * structure. Building it once means the three operations cannot disagree about
 * what a vertex is — and rebuilding it per operation on a two-million-triangle
 * model would be the dominant cost.
 *
 * BUILT FROM STAGE 2 PRIMITIVES, not reimplemented. Identity is
 * `recoverVertexIdentity`, exact and tolerance-free per ADR 0009. If repair
 * derived connectivity differently from diagnosis, the report a user sees and
 * the repair they get would be answering different questions.
 *
 * READ-ONLY. Nothing here mutates the mesh it describes.
 */
export interface RepairView {
  readonly mesh: CanonicalMesh;
  readonly faceCount: number;
  readonly identity: VertexIdentityResult;
  /** Three topological vertex ids per face, in winding order. */
  readonly faceVertices: Uint32Array;
  readonly edges: DirectedEdges;
  readonly edgeGroups: EdgeGroups;
  readonly edgeAnalysis: EdgeAnalysis;
  readonly vertexManifold: VertexManifoldAnalysis;
  readonly components: ComponentAnalysis;
}

export interface ViewProgress {
  /** Called with a 0..1 fraction between stages, for cancellation polling. */
  onStage?: (fraction: number) => void;
}

export function buildRepairView(mesh: CanonicalMesh, progress: ViewProgress = {}): RepairView {
  const faceCount = triangleCount(mesh);
  const identity = recoverVertexIdentity(mesh);
  progress.onStage?.(0.2);

  const faceVertices = new Uint32Array(faceCount * 3);
  for (let i = 0; i < faceCount * 3; i += 1) {
    faceVertices[i] = identity.cornerToVertex[mesh.indices[i] ?? 0] ?? 0;
  }
  progress.onStage?.(0.35);

  const edges = buildDirectedEdges(faceVertices, faceCount);
  const edgeGroups = groupEdges(edges);
  progress.onStage?.(0.6);

  const edgeAnalysis = analyseEdges(edges, edgeGroups);
  progress.onStage?.(0.75);

  const incidence = buildVertexIncidence(faceVertices, faceCount, identity.vertexCount);
  const vertexManifold = analyseVertexManifoldness(
    edges,
    edgeGroups,
    edgeAnalysis,
    incidence,
    identity.vertexCount,
  );
  progress.onStage?.(0.9);

  const components = analyseComponents(edges, edgeGroups, faceCount);
  progress.onStage?.(1);

  return {
    mesh,
    faceCount,
    identity,
    faceVertices,
    edges,
    edgeGroups,
    edgeAnalysis,
    vertexManifold,
    components,
  };
}

/**
 * Reads a topological vertex's stored coordinate through its representative
 * corner.
 *
 * The representative is the identity's choice, so every consumer reads the same
 * bytes for the same vertex — which is what makes "coordinates did not move" a
 * checkable claim rather than an approximate one.
 */
export function vertexCoordinate(view: RepairView, vertex: number, axis: number): number {
  const corner = view.identity.vertexRepresentativeCorner[vertex] ?? 0;
  return view.mesh.positions[corner * 3 + axis] ?? 0;
}

/** True when a face has fewer than three distinct topological vertices. */
export function hasRepeatedPosition(view: RepairView, face: number): boolean {
  const base = face * 3;
  const a = view.faceVertices[base] ?? 0;
  const b = view.faceVertices[base + 1] ?? 0;
  const c = view.faceVertices[base + 2] ?? 0;
  return a === b || b === c || a === c;
}

/**
 * True when a face has three distinct vertices that are EXACTLY collinear.
 *
 * The cross product must be zero in all three components — the same test
 * `analyseDegeneracy` applies, deliberately duplicated in behaviour rather than
 * approximated, so a face the report calls zero-area is exactly the face this
 * operation removes. No epsilon: an "almost collinear" triangle is real
 * geometry and is not this stage's business.
 */
export function isExactlyZeroArea(view: RepairView, face: number): boolean {
  if (hasRepeatedPosition(view, face)) return false;
  const base = face * 3;
  const a = view.faceVertices[base] ?? 0;
  const b = view.faceVertices[base + 1] ?? 0;
  const c = view.faceVertices[base + 2] ?? 0;

  const ax = vertexCoordinate(view, a, 0);
  const ay = vertexCoordinate(view, a, 1);
  const az = vertexCoordinate(view, a, 2);
  const e1x = vertexCoordinate(view, b, 0) - ax;
  const e1y = vertexCoordinate(view, b, 1) - ay;
  const e1z = vertexCoordinate(view, b, 2) - az;
  const e2x = vertexCoordinate(view, c, 0) - ax;
  const e2y = vertexCoordinate(view, c, 1) - ay;
  const e2z = vertexCoordinate(view, c, 2) - az;

  return e1y * e2z - e1z * e2y === 0 && e1z * e2x - e1x * e2z === 0 && e1x * e2y - e1y * e2x === 0;
}

/** Marks every face touching a non-manifold edge. Length = faceCount. */
export function facesOnNonManifoldEdges(view: RepairView): Uint8Array {
  const flagged = new Uint8Array(view.faceCount);
  const { groupStart, order, uniqueEdgeCount } = view.edgeGroups;
  for (let edge = 0; edge < uniqueEdgeCount; edge += 1) {
    if (view.edgeAnalysis.edgeClass[edge] !== EdgeClass.NonManifold) continue;
    const start = groupStart[edge] ?? 0;
    const end = groupStart[edge + 1] ?? start;
    for (let slot = start; slot < end; slot += 1) {
      flagged[view.edges.face[order[slot] ?? 0] ?? 0] = 1;
    }
  }
  return flagged;
}

/** Marks every face incident to a non-manifold vertex. Length = faceCount. */
export function facesOnNonManifoldVertices(view: RepairView): Uint8Array {
  const flagged = new Uint8Array(view.faceCount);
  for (let face = 0; face < view.faceCount; face += 1) {
    const base = face * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = view.faceVertices[base + corner] ?? 0;
      if (view.vertexManifold.nonManifoldVertex[vertex] === 1) {
        flagged[face] = 1;
        break;
      }
    }
  }
  return flagged;
}
