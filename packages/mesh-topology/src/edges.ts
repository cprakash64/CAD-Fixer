import { stage, type StageMemory } from './memory';
/**
 * EDGE RECOVERY AND GROUPING.
 *
 * Every triangle contributes three DIRECTED edges, in winding order:
 * (a→b), (b→c), (c→a). Direction is what carries orientation, so it is
 * retained; identity is undirected, so `(a,b)` and `(b,a)` are the same edge.
 *
 * REPRESENTATION — parallel typed arrays, no object per edge. For a
 * two-million-triangle model there are six million directed edges; an object
 * apiece would be gigabytes and would bury the garbage collector.
 *
 *   edgeLow[i]    smaller endpoint vertex id       (undirected identity)
 *   edgeHigh[i]   larger endpoint vertex id        (undirected identity)
 *   edgeFace[i]   the face that produced it
 *   edgeForward[i] 1 when the face traverses low→high, 0 when high→low
 *
 * GROUPING — the directed edges are sorted by (low, high) so that every
 * undirected edge occupies one contiguous run. Sorting is done with a
 * **two-pass LSD radix sort over an index permutation**, which keeps everything
 * in typed arrays: no comparator closures, no boxed records, no `Array.sort`
 * over millions of objects.
 *
 * The sort key is the pair (low, high). Rather than combine them into one
 * 64-bit key — which JavaScript numbers cannot hold exactly beyond 2^53 — the
 * radix passes sort by `high` first and then by `low`, which is stable and
 * yields (low, high) order overall.
 *
 * COMPLEXITY — O(E) for construction and O(E · passes) for the radix sort,
 * where E = 3F. With 16-bit digits that is four passes over `high` and `low`
 * combined for realistic vertex counts, so linear in practice. No comparison
 * sort and no pairwise scanning appears anywhere.
 *
 * MEMORY — 4 arrays × 4 bytes × 3F, plus an index permutation and one scratch
 * permutation: about 20 bytes per directed edge, or 60F bytes.
 */

export interface DirectedEdges {
  /** Smaller endpoint of each directed edge. Length = directedCount. */
  readonly low: Uint32Array;
  /** Larger endpoint of each directed edge. */
  readonly high: Uint32Array;
  /** Face index that produced each directed edge. */
  readonly face: Uint32Array;
  /** 1 when the producing face traverses low→high; 0 when high→low. */
  readonly forward: Uint8Array;
  readonly directedCount: number;
}

/**
 * Builds the directed edge set for a face-topology view.
 *
 * `faceVertices` holds three topological vertex ids per face, in winding order.
 * Nothing here deduplicates faces: a duplicated triangle contributes its edges
 * again and therefore raises incidence, which is exactly what makes duplicate
 * faces visible as a topological defect rather than a silent no-op.
 */
export function buildDirectedEdges(
  faceVertices: Uint32Array,
  faceCount: number,
  onBatch?: (facesProcessed: number) => void,
): DirectedEdges {
  const directedCount = faceCount * 3;
  const low = new Uint32Array(directedCount);
  const high = new Uint32Array(directedCount);
  const face = new Uint32Array(directedCount);
  const forward = new Uint8Array(directedCount);

  const FACES_PER_BATCH = 65_536;

  for (let f = 0; f < faceCount; f += 1) {
    if (f % FACES_PER_BATCH === 0) onBatch?.(f);

    const base = f * 3;
    const a = faceVertices[base] ?? 0;
    const b = faceVertices[base + 1] ?? 0;
    const c = faceVertices[base + 2] ?? 0;

    writeEdge(low, high, face, forward, base, a, b, f);
    writeEdge(low, high, face, forward, base + 1, b, c, f);
    writeEdge(low, high, face, forward, base + 2, c, a, f);
  }

  onBatch?.(faceCount);
  return { low, high, face, forward, directedCount };
}

function writeEdge(
  low: Uint32Array,
  high: Uint32Array,
  face: Uint32Array,
  forward: Uint8Array,
  slot: number,
  from: number,
  to: number,
  faceIndex: number,
): void {
  if (from <= to) {
    low[slot] = from;
    high[slot] = to;
    forward[slot] = 1;
  } else {
    low[slot] = to;
    high[slot] = from;
    forward[slot] = 0;
  }
  face[slot] = faceIndex;
}

/**
 * Groups directed edges into undirected edges.
 *
 * `order` is a permutation of directed-edge indices sorted by (low, high).
 * `groupStart[g] .. groupStart[g+1]` delimits the run of directed edges that
 * belong to undirected edge `g`, so incidence is a subtraction and the incident
 * faces are a contiguous slice. No per-edge array of faces is ever allocated.
 */
export interface EdgeGroups {
  /** Directed-edge indices, sorted by (low, high). */
  readonly order: Uint32Array;
  /** Offsets into `order`. Length = uniqueEdgeCount + 1. */
  readonly groupStart: Uint32Array;
  readonly uniqueEdgeCount: number;
}

export function groupEdges(
  edges: DirectedEdges,
  onBatch?: (processed: number) => void,
): EdgeGroups {
  const order = radixSortEdges(edges, onBatch);
  const { low, high, directedCount } = edges;

  // One extra slot so the last group's end is expressible.
  const groupStart = new Uint32Array(directedCount + 1);
  let groups = 0;

  let index = 0;
  while (index < directedCount) {
    const first = order[index] ?? 0;
    const runLow = low[first] ?? 0;
    const runHigh = high[first] ?? 0;
    groupStart[groups] = index;
    groups += 1;

    index += 1;
    while (index < directedCount) {
      const candidate = order[index] ?? 0;
      if ((low[candidate] ?? 0) !== runLow || (high[candidate] ?? 0) !== runHigh) break;
      index += 1;
    }
  }
  groupStart[groups] = directedCount;

  return {
    order,
    groupStart: groupStart.subarray(0, groups + 1),
    uniqueEdgeCount: groups,
  };
}

/**
 * LSD radix sort of an index permutation by (low, high).
 *
 * Two 16-bit digits per key, `high` sorted before `low`, each pass stable — so
 * the final order is by `low` then `high`. Everything is a typed array; there
 * is no comparator, no closure allocation, and no boxing.
 */
function radixSortEdges(edges: DirectedEdges, onBatch?: (processed: number) => void): Uint32Array {
  const { low, high, directedCount } = edges;

  let current = new Uint32Array(directedCount);
  for (let i = 0; i < directedCount; i += 1) current[i] = i;
  let scratch = new Uint32Array(directedCount);

  // Least significant key first: high, then low.
  for (const key of [high, low]) {
    for (const shift of [0, 16]) {
      const counts = new Uint32Array(65_536 + 1);
      for (let i = 0; i < directedCount; i += 1) {
        const value = key[current[i] ?? 0] ?? 0;
        const bucket = ((value >>> shift) & 0xffff) + 1;
        counts[bucket] = (counts[bucket] ?? 0) + 1;
      }
      for (let bucket = 0; bucket < 65_536; bucket += 1) {
        counts[bucket + 1] = (counts[bucket + 1] ?? 0) + (counts[bucket] ?? 0);
      }
      for (let i = 0; i < directedCount; i += 1) {
        const item = current[i] ?? 0;
        const bucket = ((key[item] ?? 0) >>> shift) & 0xffff;
        const target = counts[bucket] ?? 0;
        scratch[target] = item;
        counts[bucket] = target + 1;
      }
      const swap = current;
      current = scratch;
      scratch = swap;
      onBatch?.(directedCount);
    }
  }

  return current;
}

/** Memory profile of `buildDirectedEdges` + `groupEdges` for F faces. */
export function estimateEdgeBytes(faceCount: number): StageMemory {
  const directed = faceCount * 3;
  // Retained to the end of the analysis: low, high, face (4 bytes each) and
  // forward (1); the sorted `order` permutation (4); and `groupStart`, which is
  // ALLOCATED at directed+1 and only subarray-trimmed, so the full buffer stays.
  const retained = directed * (4 + 4 + 4 + 1) + directed * 4 + (directed + 1) * 4;
  // Released with the sort: the radix ping-pong buffer, plus the 65 536-bucket
  // counting array that each pass allocates.
  const transient = directed * 4 + (65_536 + 1) * 4;
  return stage(retained, transient);
}
