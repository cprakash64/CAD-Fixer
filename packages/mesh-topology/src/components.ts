import { EdgeClass, type EdgeAnalysis } from './manifold';
import type { DirectedEdges, EdgeGroups } from './edges';
import { stage, type StageMemory } from './memory';

/**
 * FACE-CONNECTED COMPONENTS AND BOUNDARY STRUCTURE.
 *
 * ADJACENCY POLICY — two faces are in the same component when they are joined
 * through a chain of SHARED EDGES. Sharing only a vertex does not connect them.
 *
 * That choice is deliberate and is what makes the bow-tie report honestly: two
 * cones meeting at one point are two surface patches that happen to touch, not
 * one surface. Calling them one component would hide the pinch. It also matches
 * how a slicer or a repair operation would have to treat them — you cannot walk
 * from one to the other across the surface.
 *
 * Component ids are assigned by ascending smallest member face index, so the
 * ordering in the report is deterministic and independent of hash or union-find
 * internals.
 *
 * COMPLEXITY — O(F α(F)) union-find over faces, plus one O(F) labelling pass.
 * MEMORY — three Uint32Arrays of length F.
 */

export interface ComponentAnalysis {
  /** Component id per face. Length = faceCount. */
  readonly faceComponent: Uint32Array;
  readonly componentCount: number;
}

export function analyseComponents(
  edges: DirectedEdges,
  groups: EdgeGroups,
  faceCount: number,
  onBatch?: (processed: number) => void,
): ComponentAnalysis {
  const parent = new Uint32Array(faceCount);
  for (let f = 0; f < faceCount; f += 1) parent[f] = f;

  const find = (node: number): number => {
    let root = node;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    let walk = node;
    while ((parent[walk] ?? walk) !== walk) {
      const next = parent[walk] ?? walk;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  const EDGES_PER_BATCH = 65_536;

  for (let g = 0; g < groups.uniqueEdgeCount; g += 1) {
    if (g % EDGES_PER_BATCH === 0) onBatch?.(g);

    const start = groups.groupStart[g] ?? 0;
    const end = groups.groupStart[g + 1] ?? 0;
    if (end - start < 2) continue;

    // Every face on this edge joins the same component, including the third and
    // later faces of a non-manifold edge — they genuinely are edge-connected.
    const first = find(edges.face[groups.order[start] ?? 0] ?? 0);
    for (let i = start + 1; i < end; i += 1) {
      const other = find(edges.face[groups.order[i] ?? 0] ?? 0);
      if (other === first) continue;
      if (first < other) parent[other] = first;
      else parent[first] = other;
    }
  }

  // Label by ascending smallest member face, which is exactly what scanning
  // faces in order and assigning ids on first sight produces.
  const faceComponent = new Uint32Array(faceCount);
  const rootToComponent = new Int32Array(faceCount).fill(-1);
  let componentCount = 0;

  for (let f = 0; f < faceCount; f += 1) {
    const root = find(f);
    let id = rootToComponent[root] ?? -1;
    if (id === -1) {
      id = componentCount;
      rootToComponent[root] = id;
      componentCount += 1;
    }
    faceComponent[f] = id;
  }

  onBatch?.(faceCount);
  return { faceComponent, componentCount };
}

/* ------------------------------------------------------------- boundary -- */

export const BoundaryKind = {
  /** Every vertex has boundary degree 2 and the edges form one cycle. */
  SimpleLoop: 'simple-loop',
  /** Exactly two endpoints of degree 1, everything else degree 2. */
  OpenChain: 'open-chain',
  /** Anything else: a vertex of degree 3+, or a degree pattern that is neither. */
  Branched: 'branched',
} as const;

export type BoundaryKind = (typeof BoundaryKind)[keyof typeof BoundaryKind];

export interface BoundaryComponent {
  readonly kind: BoundaryKind;
  readonly edgeCount: number;
  readonly vertexCount: number;
}

export interface BoundaryAnalysis {
  /**
   * Bounded summary list. The three counts below are EXACT; this list is capped,
   * because a mesh of disconnected triangles has one boundary component per
   * triangle and the whole list crosses the worker boundary.
   */
  readonly components: readonly BoundaryComponent[];
  readonly componentsTruncated: boolean;
  readonly simpleLoopCount: number;
  readonly openChainCount: number;
  readonly branchedCount: number;
}

/**
 * Classifies the boundary graph.
 *
 * WHY "BOUNDARY LOOP" AND NOT "HOLE". A boundary cycle is a topological fact:
 * these edges have one incident face. Whether it corresponds to a hole a user
 * would want filled is a geometric interpretation that needs more than
 * topology — the opening might be the intended open end of a tube. Reporting a
 * count of "holes" here would be asserting an interpretation the data does not
 * support, so the report says what it actually knows.
 *
 * A branched boundary — a vertex where three or more boundary edges meet — has
 * no well-defined loop count at all, and is reported as ambiguous rather than
 * being forced into a number.
 */
export function analyseBoundary(
  edges: DirectedEdges,
  groups: EdgeGroups,
  edgeAnalysis: EdgeAnalysis,
  vertexCount: number,
  summaryLimit: number,
  onBatch?: (processed: number) => void,
): BoundaryAnalysis {
  // Boundary degree per vertex, and union-find over boundary vertices.
  const degree = new Uint32Array(vertexCount);
  const parent = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v += 1) parent[v] = v;

  const find = (node: number): number => {
    let root = node;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    let walk = node;
    while ((parent[walk] ?? walk) !== walk) {
      const next = parent[walk] ?? walk;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  let boundaryEdgeTotal = 0;
  const EDGES_PER_BATCH = 65_536;

  for (let g = 0; g < groups.uniqueEdgeCount; g += 1) {
    if (g % EDGES_PER_BATCH === 0) onBatch?.(g);
    if (edgeAnalysis.edgeClass[g] !== EdgeClass.Boundary) continue;

    const directed = groups.order[groups.groupStart[g] ?? 0] ?? 0;
    const low = edges.low[directed] ?? 0;
    const high = edges.high[directed] ?? 0;

    degree[low] = (degree[low] ?? 0) + 1;
    degree[high] = (degree[high] ?? 0) + 1;
    boundaryEdgeTotal += 1;

    const rootLow = find(low);
    const rootHigh = find(high);
    if (rootLow !== rootHigh) {
      if (rootLow < rootHigh) parent[rootHigh] = rootLow;
      else parent[rootLow] = rootHigh;
    }
  }

  if (boundaryEdgeTotal === 0) {
    return {
      components: [],
      componentsTruncated: false,
      simpleLoopCount: 0,
      openChainCount: 0,
      branchedCount: 0,
    };
  }

  // Aggregates per boundary component, in parallel typed arrays indexed by the
  // component's union-find root. NOT a Map of accumulator objects: a mesh of
  // disconnected triangles has one boundary component per triangle, so objects
  // here would scale with the mesh.
  const edgeHalves = new Uint32Array(vertexCount);
  const memberVertices = new Uint32Array(vertexCount);
  const degreeOne = new Uint32Array(vertexCount);
  const degreeOther = new Uint32Array(vertexCount);

  const bump = (array: Uint32Array, index: number, by: number): void => {
    array[index] = (array[index] ?? 0) + by;
  };

  for (let v = 0; v < vertexCount; v += 1) {
    const d = degree[v] ?? 0;
    if (d === 0) continue;
    const root = find(v);
    bump(edgeHalves, root, d);
    bump(memberVertices, root, 1);
    if (d === 1) bump(degreeOne, root, 1);
    else if (d > 2) bump(degreeOther, root, 1);
  }

  const components: BoundaryComponent[] = [];
  let simpleLoopCount = 0;
  let openChainCount = 0;
  let branchedCount = 0;
  let componentsTruncated = false;

  // Roots are visited in ascending vertex order, and union always keeps the
  // smaller index as the root, so this IS "ordered by smallest participating
  // vertex" — deterministic without a sort.
  for (let root = 0; root < vertexCount; root += 1) {
    const vertices = memberVertices[root] ?? 0;
    if (vertices === 0) continue;

    const ones = degreeOne[root] ?? 0;
    const others = degreeOther[root] ?? 0;
    let kind: BoundaryKind;

    if (others > 0) {
      kind = BoundaryKind.Branched;
      branchedCount += 1;
    } else if (ones === 0) {
      // Every vertex degree 2 and connected: a single cycle.
      kind = BoundaryKind.SimpleLoop;
      simpleLoopCount += 1;
    } else if (ones === 2) {
      kind = BoundaryKind.OpenChain;
      openChainCount += 1;
    } else {
      // An odd number of degree-1 ends cannot form loops or a single chain.
      kind = BoundaryKind.Branched;
      branchedCount += 1;
    }

    if (components.length < summaryLimit) {
      components.push({ kind, edgeCount: (edgeHalves[root] ?? 0) / 2, vertexCount: vertices });
    } else {
      componentsTruncated = true;
    }
  }

  onBatch?.(groups.uniqueEdgeCount);
  return { components, componentsTruncated, simpleLoopCount, openChainCount, branchedCount };
}

/** Memory profile of the component and boundary stages. */
export function estimateComponentBytes(faceCount: number, vertexCount: number): StageMemory {
  // Retained: the face→component labelling, which every later stage reads.
  const retained = faceCount * 4;
  // Released: the component union-find parent and root→id map, and the boundary
  // pass's degree, parent, and four per-root aggregate arrays. The boundary
  // arrays are the larger of the two, but both are charged as one stage's worst
  // moment rather than assuming which dominates.
  const transient = Math.max(faceCount * 4 * 2, vertexCount * 4 * 6);
  return stage(retained, transient);
}
