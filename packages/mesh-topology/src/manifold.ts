import type { DirectedEdges, EdgeGroups } from './edges';
import { stage, type StageMemory } from './memory';

/**
 * MANIFOLD ANALYSIS — edges, winding, and genuine vertex umbrellas.
 *
 * Edge classification is the easy half: count incident faces per undirected
 * edge. 1 is a boundary edge, 2 is ordinary, more than 2 is non-manifold.
 *
 * WINDING. Two faces sharing an edge are locally orientation-consistent only if
 * they traverse it in OPPOSITE directions — one low→high, the other high→low.
 * If both traverse it the same way, the surface folds back on itself there and
 * that edge is a winding conflict. This is derived purely from vertex order.
 * Stored STL facet normals are ignored: they are advisory, frequently wrong,
 * and using them would let a bad normal invent or hide a defect.
 *
 * VERTEX MANIFOLDNESS IS NOT IMPLIED BY EDGE MANIFOLDNESS. This is the part
 * that is easy to get wrong, and the reason the shortcut
 * "a vertex is non-manifold iff it touches a non-manifold edge" is
 * insufficient: the bow-tie counterexample has every edge at exactly two faces
 * and is still non-manifold.
 *
 * The real condition is local. Around a manifold vertex the incident faces form
 * ONE connected fan — a closed cycle in the interior, an open fan on a
 * boundary. Two cones meeting at a single point form two fans that share the
 * apex and nothing else, and that is a pinch point no surface can be cut from.
 *
 * ALGORITHM. Union-find over face incidences, restricted to one vertex at a
 * time. Each (vertex, face) incidence is a node. For every undirected edge, its
 * incident faces are unioned AT BOTH ENDPOINTS — because sharing an edge is
 * exactly what makes two faces adjacent within a vertex's fan. Afterwards a
 * vertex whose incidences fall into more than one set has more than one fan,
 * and is non-manifold. A bow-tie apex ends with two sets; nothing about its
 * edges is unusual.
 *
 * Vertices touched by a non-manifold edge are additionally marked directly:
 * their local neighbourhood is not a disc either, and the fan count alone would
 * not always say so once all the incident faces are unioned together.
 *
 * COMPLEXITY — O(F α) to build the incidence structure and O(E log d) for the
 * edge-to-slot lookups, where d is vertex degree. No pairwise comparison.
 *
 * MEMORY — CSR incidence (4·(V+1) + 4·3F), a union-find parent array (4·3F) and
 * two small per-vertex byte arrays. No object per vertex, edge, or face.
 */

export const EdgeClass = {
  Boundary: 0,
  Ordinary: 1,
  NonManifold: 2,
} as const;

export type EdgeClass = (typeof EdgeClass)[keyof typeof EdgeClass];

export interface EdgeAnalysis {
  /** Classification per undirected edge. Length = uniqueEdgeCount. */
  readonly edgeClass: Uint8Array;
  /** 1 when an ordinary edge's two faces traverse it the same way. */
  readonly windingConflict: Uint8Array;
  readonly boundaryEdgeCount: number;
  readonly ordinaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  readonly windingConflictCount: number;
}

export function analyseEdges(
  edges: DirectedEdges,
  groups: EdgeGroups,
  onBatch?: (processed: number) => void,
): EdgeAnalysis {
  const { uniqueEdgeCount, groupStart, order } = groups;
  const edgeClass = new Uint8Array(uniqueEdgeCount);
  const windingConflict = new Uint8Array(uniqueEdgeCount);

  let boundaryEdgeCount = 0;
  let ordinaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let windingConflictCount = 0;

  const EDGES_PER_BATCH = 65_536;

  for (let g = 0; g < uniqueEdgeCount; g += 1) {
    if (g % EDGES_PER_BATCH === 0) onBatch?.(g);

    const start = groupStart[g] ?? 0;
    const end = groupStart[g + 1] ?? 0;
    const incidence = end - start;

    if (incidence === 1) {
      edgeClass[g] = EdgeClass.Boundary;
      boundaryEdgeCount += 1;
      continue;
    }

    if (incidence === 2) {
      edgeClass[g] = EdgeClass.Ordinary;
      ordinaryEdgeCount += 1;

      const first = order[start] ?? 0;
      const second = order[start + 1] ?? 0;
      // Consistent orientation means opposite traversal of the shared edge.
      if ((edges.forward[first] ?? 0) === (edges.forward[second] ?? 0)) {
        windingConflict[g] = 1;
        windingConflictCount += 1;
      }
      continue;
    }

    edgeClass[g] = EdgeClass.NonManifold;
    nonManifoldEdgeCount += 1;
  }

  onBatch?.(uniqueEdgeCount);

  return {
    edgeClass,
    windingConflict,
    boundaryEdgeCount,
    ordinaryEdgeCount,
    nonManifoldEdgeCount,
    windingConflictCount,
  };
}

/** Compressed-sparse-row incidence: which faces touch each topological vertex. */
export interface VertexIncidence {
  /** Offsets into `faces`. Length = vertexCount + 1. */
  readonly start: Uint32Array;
  /** Face index per incidence slot, ascending within each vertex's range. */
  readonly faces: Uint32Array;
}

/**
 * Builds vertex→faces incidence in CSR form.
 *
 * Faces are appended in ascending face order, so each vertex's slice is sorted
 * and a slot can be found by binary search rather than by a per-vertex map.
 */
export function buildVertexIncidence(
  faceVertices: Uint32Array,
  faceCount: number,
  vertexCount: number,
  onBatch?: (processed: number) => void,
): VertexIncidence {
  // Three O(N) passes, each polled on the same batch cadence as every other
  // topology primitive. Before Stage 3B-1C this function took no callback at
  // all, which made it a multi-pass blind spot in the middle of an otherwise
  // interruptible analysis: on a large model the whole of CSR construction ran
  // with no opportunity to observe a cancel.
  const EDGES_PER_BATCH = 65_536;
  const start = new Uint32Array(vertexCount + 1);

  /*
   * Progress is reported as a MONOTONIC count across all three passes, not as
   * each pass's own index. Reporting a per-pass index would send the fraction
   * back to zero twice, and `analyseTopology` publishes progress that is
   * required to be monotonic — a reset there is a contract violation, not a
   * cosmetic glitch.
   */
  const totalWork = faceCount * 2 + vertexCount;
  let done = 0;
  const tick = (): void => {
    if (done % EDGES_PER_BATCH === 0) onBatch?.(done);
  };

  for (let f = 0; f < faceCount; f += 1) {
    tick();
    done += 1;
    const base = f * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const slot = (faceVertices[base + corner] ?? 0) + 1;
      start[slot] = (start[slot] ?? 0) + 1;
    }
  }
  for (let v = 0; v < vertexCount; v += 1) {
    tick();
    done += 1;
    start[v + 1] = (start[v + 1] ?? 0) + (start[v] ?? 0);
  }

  const cursor = Uint32Array.from(start.subarray(0, vertexCount));
  const faces = new Uint32Array(faceCount * 3);

  for (let f = 0; f < faceCount; f += 1) {
    tick();
    done += 1;
    const base = f * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = faceVertices[base + corner] ?? 0;
      const slot = cursor[vertex] ?? 0;
      faces[slot] = f;
      cursor[vertex] = slot + 1;
    }
  }

  onBatch?.(totalWork);
  return { start, faces };
}

export interface VertexManifoldAnalysis {
  /** 1 when the vertex's incident faces do not form a single fan. */
  readonly nonManifoldVertex: Uint8Array;
  readonly nonManifoldVertexCount: number;
  /** Union-find roots per incidence slot; reused by component analysis. */
  readonly incidenceParent: Uint32Array;
}

export function analyseVertexManifoldness(
  edges: DirectedEdges,
  groups: EdgeGroups,
  edgeAnalysis: EdgeAnalysis,
  incidence: VertexIncidence,
  vertexCount: number,
  onBatch?: (processed: number) => void,
): VertexManifoldAnalysis {
  const parent = new Uint32Array(incidence.faces.length);
  for (let i = 0; i < parent.length; i += 1) parent[i] = i;

  const find = (node: number): number => {
    let root = node;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    // Path compression, iterative so deep chains cannot blow the JS stack.
    let walk = node;
    while ((parent[walk] ?? walk) !== walk) {
      const next = parent[walk] ?? walk;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // Union by index keeps the structure deterministic.
    if (rootA < rootB) parent[rootB] = rootA;
    else parent[rootA] = rootB;
  };

  /** Finds the incidence slot for (vertex, face) by binary search. */
  const slotOf = (vertex: number, face: number): number => {
    let lo = incidence.start[vertex] ?? 0;
    let hi = (incidence.start[vertex + 1] ?? 0) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = incidence.faces[mid] ?? 0;
      if (value === face) return mid;
      if (value < face) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };

  const nonManifoldVertex = new Uint8Array(vertexCount);
  const EDGES_PER_BATCH = 65_536;

  for (let g = 0; g < groups.uniqueEdgeCount; g += 1) {
    if (g % EDGES_PER_BATCH === 0) onBatch?.(g);

    const start = groups.groupStart[g] ?? 0;
    const end = groups.groupStart[g + 1] ?? 0;
    if (end - start < 2) continue;

    const firstDirected = groups.order[start] ?? 0;
    const vertexLow = edges.low[firstDirected] ?? 0;
    const vertexHigh = edges.high[firstDirected] ?? 0;

    // A non-manifold edge means neither endpoint has a disc neighbourhood,
    // whatever the fan count works out to once these faces are unioned.
    if (edgeAnalysis.edgeClass[g] === EdgeClass.NonManifold) {
      nonManifoldVertex[vertexLow] = 1;
      nonManifoldVertex[vertexHigh] = 1;
    }

    // Sharing an edge is what makes two faces adjacent within a fan, so the
    // union happens at BOTH endpoints of that edge.
    // Written out for both endpoints rather than iterating a pair, because a
    // literal here would allocate once per shared edge — millions of two-element
    // arrays on a real model, in the hottest loop of the analysis.
    const baseFace = edges.face[groups.order[start] ?? 0] ?? 0;
    const lowBase = slotOf(vertexLow, baseFace);
    const highBase = slotOf(vertexHigh, baseFace);
    for (let i = start + 1; i < end; i += 1) {
      const otherFace = edges.face[groups.order[i] ?? 0] ?? 0;

      const lowOther = slotOf(vertexLow, otherFace);
      if (lowBase >= 0 && lowOther >= 0) union(lowBase, lowOther);

      const highOther = slotOf(vertexHigh, otherFace);
      if (highBase >= 0 && highOther >= 0) union(highBase, highOther);
    }
  }

  // A vertex is manifold only if all of its incident faces ended up in one set.
  let nonManifoldVertexCount = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    const start = incidence.start[v] ?? 0;
    const end = incidence.start[v + 1] ?? 0;
    if (end - start > 1) {
      const root = find(start);
      for (let slot = start + 1; slot < end; slot += 1) {
        if (find(slot) !== root) {
          nonManifoldVertex[v] = 1;
          break;
        }
      }
    }
    if (nonManifoldVertex[v] === 1) nonManifoldVertexCount += 1;
  }

  onBatch?.(groups.uniqueEdgeCount);

  return { nonManifoldVertex, nonManifoldVertexCount, incidenceParent: parent };
}

/** Memory profile of edge classification, CSR incidence, and fan analysis. */
export function estimateManifoldBytes(faceCount: number, vertexCount: number): StageMemory {
  const incidenceSlots = faceCount * 3;
  // Retained: edgeClass + windingConflict (1 byte per edge, at most 3F edges),
  // the CSR incidence (start + faces), the union-find parent over incidence
  // slots, and the per-vertex non-manifold flag.
  const retained =
    incidenceSlots * 2 +
    (vertexCount + 1) * 4 +
    incidenceSlots * 4 +
    incidenceSlots * 4 +
    vertexCount;
  // Released: the CSR fill cursor.
  const transient = vertexCount * 4;
  return stage(retained, transient);
}
