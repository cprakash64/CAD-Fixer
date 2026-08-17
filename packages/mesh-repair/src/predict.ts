import { EdgeClass } from '@cadfixer/mesh-topology';
import { vertexCoordinate, type RepairView } from './view';

/**
 * What the SOURCE topology says a removal will produce.
 *
 * WHY PREDICT AT ALL. "Boundary edges must not increase" is the obvious safety
 * rule and it is WRONG for duplicate removal. Stage 2 counts every face, so two
 * coincident triangles pair each other's edges and look closed; deleting the
 * redundant copy correctly reveals three boundary edges. Rejecting that would
 * refuse a correct repair — and Stage 3A-1's own R03 criterion already said as
 * much about the matching surface-area effect.
 *
 * So the invariant is not "nothing increased", it is "nothing changed that the
 * removal does not account for". These functions compute the accounted-for
 * change from the source view and the removal mask.
 *
 * THIS IS NOT THE VALIDATOR MARKING ITS OWN HOMEWORK. The prediction is derived
 * from the SOURCE analysis; the actual figures come from independently
 * re-analysing the rebuilt candidate. A compaction bug, a bad group rebuild or a
 * corrupted index would make the two disagree, which is exactly what the
 * comparison is for.
 */

export interface RemovalPrediction {
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  /**
   * Winding conflicts among the SURVIVING faces.
   *
   * Predicted, because removal can EXPOSE conflicts rather than create them: an
   * edge with four incident faces is non-manifold and is not counted as a
   * winding conflict at all, so deleting a duplicate can drop it to two faces
   * that disagree. The conflict was always in the data; it only becomes
   * countable once the edge is ordinary. Treating that as damage would reject a
   * correct duplicate removal.
   */
  readonly windingConflictCount: number;
  /** Summed area of the removed faces, in the same convention Stage 2 uses. */
  readonly removedArea: number;
}

/**
 * Classifies every undirected edge by how many SURVIVING faces touch it.
 *
 * Mirrors `analyseEdges`: incidence 1 is a boundary edge, 2 is ordinary, more
 * is non-manifold. Edges with no surviving face disappear entirely.
 */
export function predictAfterRemoval(view: RepairView, removed: Uint8Array): RemovalPrediction {
  const { groupStart, order, uniqueEdgeCount } = view.edgeGroups;
  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let windingConflictCount = 0;

  for (let edge = 0; edge < uniqueEdgeCount; edge += 1) {
    const start = groupStart[edge] ?? 0;
    const end = groupStart[edge + 1] ?? start;
    let surviving = 0;
    let firstDirected = -1;
    let secondDirected = -1;
    for (let slot = start; slot < end; slot += 1) {
      const directed = order[slot] ?? 0;
      const face = view.edges.face[directed] ?? 0;
      if (removed[face] === 1) continue;
      surviving += 1;
      if (firstDirected < 0) firstDirected = directed;
      else if (secondDirected < 0) secondDirected = directed;
    }
    if (surviving === 1) boundaryEdgeCount += 1;
    else if (surviving > 2) nonManifoldEdgeCount += 1;
    else if (surviving === 2 && firstDirected >= 0 && secondDirected >= 0) {
      // Two faces traversing the shared edge the SAME way disagree about which
      // side is which. Same test `analyseEdges` applies.
      if (view.edges.forward[firstDirected] === view.edges.forward[secondDirected]) {
        windingConflictCount += 1;
      }
    }
  }

  let removedArea = 0;
  for (let face = 0; face < view.faceCount; face += 1) {
    if (removed[face] !== 1) continue;
    removedArea += faceArea(view, face);
  }

  return { boundaryEdgeCount, nonManifoldEdgeCount, windingConflictCount, removedArea };
}

/** Half the magnitude of the edge cross product, read through vertex identity. */
function faceArea(view: RepairView, face: number): number {
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

  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

/**
 * Whether removing exactly these DEGENERATE faces is conservatively safe.
 *
 * Part E2's rule, and it is strict on purpose: a zero-area face contributes no
 * surface but does contribute edges, so deleting one can open a boundary or
 * split a component. Duplicate removal is judged by prediction because its
 * effects are expected; degeneracy removal must be inert, and if it is not, the
 * operation is refused rather than allowed to "succeed" with a new defect.
 */
export function isDegenerateRemovalSafe(
  view: RepairView,
  removed: Uint8Array,
): { safe: boolean; boundaryDelta: number; nonManifoldDelta: number } {
  const before = predictAfterRemoval(view, new Uint8Array(view.faceCount));
  const after = predictAfterRemoval(view, removed);
  const boundaryDelta = after.boundaryEdgeCount - before.boundaryEdgeCount;
  const nonManifoldDelta = after.nonManifoldEdgeCount - before.nonManifoldEdgeCount;
  return {
    safe: boundaryDelta <= 0 && nonManifoldDelta <= 0,
    boundaryDelta,
    nonManifoldDelta,
  };
}

/** Non-manifold edge count that survives once `removed` is applied. */
export function residualNonManifoldEdges(view: RepairView, removed: Uint8Array): number {
  return predictAfterRemoval(view, removed).nonManifoldEdgeCount;
}

/** Edge classes are re-exported so callers need not import two modules. */
export { EdgeClass };
