import { EdgeClass } from '@cadfixer/mesh-topology';
import { uncancellable, type CancellationToken } from '@cadfixer/shared';
import { CANCEL_POLL_MASK, RepairCancelled } from './cancellation';
import {
  facesOnNonManifoldEdges,
  facesOnNonManifoldVertices,
  hasRepeatedPosition,
  isExactlyZeroArea,
  type RepairView,
} from './view';

/**
 * The three conservative transformations, as deterministic face selections.
 *
 * NOTHING HERE MUTATES A MESH. Each function returns a mask or a parity vector;
 * `rebuild.ts` turns those into a candidate. Keeping selection and mutation
 * apart is what makes each decision testable on its own, and it is why an
 * operation can be refused after its selection is computed but before anything
 * is built.
 */

/* ------------------------------------------------- same-orientation duplicates -- */

export interface DuplicateSelection {
  /** 1 where a face is an extra copy to remove. Length = faceCount. */
  readonly removeMask: Uint8Array;
  readonly removeCount: number;
  /** Distinct duplicate groups found (each contributes copies - 1 removals). */
  readonly groupCount: number;
  /**
   * True when some duplicate group spans two different mesh groups.
   *
   * Removing a copy would then silently discard a semantic assignment the
   * canonical mesh can still express, so the operation refuses instead. See
   * `describeGroupConflict`.
   */
  readonly spansMeshGroups: boolean;
}

/**
 * Rotates a face's vertex triple so the smallest id is first.
 *
 * THE ORIENTATION TEST. (a,b,c), (b,c,a) and (c,a,b) are the same triangle
 * traversed the same way, so they must compare equal; (a,c,b) is the REVERSED
 * duplicate and must not. Rotating to a canonical starting corner makes the
 * first equal and the second different, with no sorting and no hashing — which
 * matters because hash iteration order is not deterministic and the
 * representative choice must be.
 */
function canonicalRotation(a: number, b: number, c: number): [number, number, number] {
  if (a <= b && a <= c) return [a, b, c];
  if (b <= a && b <= c) return [b, c, a];
  return [c, a, b];
}

/**
 * Selects extra same-orientation copies, retaining the LOWEST source face index.
 *
 * COMPLEXITY O(F log F), from one sort of canonical keys. No pairwise
 * comparison, no `Set` per vertex, no string keys.
 *
 * Faces that are already degenerate are skipped: "duplicate" is not a
 * meaningful classification for a triangle with a repeated corner, and counting
 * it as both would let one defect inflate two operations. This matches
 * `analyseDuplicates`, so the plan's targeted count and the removal agree.
 */
export function selectDuplicateFaces(
  view: RepairView,
  cancellation: CancellationToken = uncancellable,
): DuplicateSelection {
  const { faceCount } = view;
  const keyA = new Uint32Array(faceCount);
  const keyB = new Uint32Array(faceCount);
  const keyC = new Uint32Array(faceCount);
  const usable = new Uint8Array(faceCount);
  const order = new Uint32Array(faceCount);

  for (let face = 0; face < faceCount; face += 1) {
    if ((face & CANCEL_POLL_MASK) === 0 && cancellation.isCancelled) throw new RepairCancelled();
    order[face] = face;
    if (hasRepeatedPosition(view, face)) continue;
    const base = face * 3;
    const [a, b, c] = canonicalRotation(
      view.faceVertices[base] ?? 0,
      view.faceVertices[base + 1] ?? 0,
      view.faceVertices[base + 2] ?? 0,
    );
    keyA[face] = a;
    keyB[face] = b;
    keyC[face] = c;
    usable[face] = 1;
  }

  // Sorted by canonical triple, then by face index. The face-index tie-break is
  // what makes "lowest surviving index is the representative" exact rather than
  // dependent on the sort's stability.
  const sorted = Array.from(order).sort((left, right) => {
    const leftUsable = usable[left] ?? 0;
    const rightUsable = usable[right] ?? 0;
    if (leftUsable !== rightUsable) return rightUsable - leftUsable;
    if (leftUsable === 0) return left - right;
    const a = (keyA[left] ?? 0) - (keyA[right] ?? 0);
    if (a !== 0) return a;
    const b = (keyB[left] ?? 0) - (keyB[right] ?? 0);
    if (b !== 0) return b;
    const c = (keyC[left] ?? 0) - (keyC[right] ?? 0);
    if (c !== 0) return c;
    return left - right;
  });

  const groupOfFace = meshGroupIndexPerFace(view);
  const removeMask = new Uint8Array(faceCount);
  let removeCount = 0;
  let groupCount = 0;
  let spansMeshGroups = false;

  let runStart = 0;
  while (runStart < sorted.length) {
    const first = sorted[runStart] ?? 0;
    if ((usable[first] ?? 0) === 0) break;

    let runEnd = runStart + 1;
    while (runEnd < sorted.length) {
      const candidate = sorted[runEnd] ?? 0;
      if (
        (usable[candidate] ?? 0) === 0 ||
        keyA[candidate] !== keyA[first] ||
        keyB[candidate] !== keyB[first] ||
        keyC[candidate] !== keyC[first]
      ) {
        break;
      }
      runEnd += 1;
    }

    if (runEnd - runStart > 1) {
      groupCount += 1;
      const representativeGroup = groupOfFace?.[first] ?? -1;
      for (let slot = runStart + 1; slot < runEnd; slot += 1) {
        const face = sorted[slot] ?? 0;
        if (groupOfFace !== null && (groupOfFace[face] ?? -1) !== representativeGroup) {
          spansMeshGroups = true;
        }
        removeMask[face] = 1;
        removeCount += 1;
      }
    }

    runStart = runEnd;
  }

  return { removeMask, removeCount, groupCount, spansMeshGroups };
}

/**
 * Maps each face to the index of the mesh group that owns it, or `null` when
 * the mesh has no groups.
 *
 * WHY THIS MATTERS FOR REPAIR. Two geometrically identical triangles can belong
 * to different objects or materials. Deleting one would destroy a distinction
 * the canonical mesh is still capable of representing, so `selectDuplicateFaces`
 * reports the conflict and the plan refuses. Silently keeping whichever copy
 * sorted first would be a data-integrity failure, not a repair.
 */
function meshGroupIndexPerFace(view: RepairView): Int32Array | null {
  const groups = view.mesh.groups;
  if (groups === undefined || groups.length === 0) return null;
  const perFace = new Int32Array(view.faceCount).fill(-1);
  for (const [index, group] of groups.entries()) {
    const firstFace = Math.floor(group.indexOffset / 3);
    const faceSpan = Math.floor(group.indexCount / 3);
    for (let face = firstFace; face < firstFace + faceSpan && face < view.faceCount; face += 1) {
      perFace[face] = index;
    }
  }
  return perFace;
}

/* ------------------------------------------------------------- degeneracy -- */

export interface DegenerateSelection {
  readonly removeMask: Uint8Array;
  readonly removeCount: number;
}

/** Faces with fewer than three distinct topological vertices. */
export function selectRepeatedPositionFaces(
  view: RepairView,
  cancellation: CancellationToken = uncancellable,
): DegenerateSelection {
  const removeMask = new Uint8Array(view.faceCount);
  let removeCount = 0;
  for (let face = 0; face < view.faceCount; face += 1) {
    if ((face & CANCEL_POLL_MASK) === 0 && cancellation.isCancelled) throw new RepairCancelled();
    if (hasRepeatedPosition(view, face)) {
      removeMask[face] = 1;
      removeCount += 1;
    }
  }
  return { removeMask, removeCount };
}

/** Faces with three distinct vertices that are exactly collinear. */
export function selectZeroAreaFaces(
  view: RepairView,
  cancellation: CancellationToken = uncancellable,
): DegenerateSelection {
  const removeMask = new Uint8Array(view.faceCount);
  let removeCount = 0;
  for (let face = 0; face < view.faceCount; face += 1) {
    if ((face & CANCEL_POLL_MASK) === 0 && cancellation.isCancelled) throw new RepairCancelled();
    if (isExactlyZeroArea(view, face)) {
      removeMask[face] = 1;
      removeCount += 1;
    }
  }
  return { removeMask, removeCount };
}

/* ---------------------------------------------------------------- winding -- */

export const WindingOutcome = {
  Solved: 'solved',
  AlreadyConsistent: 'already-consistent',
  BlockedNonManifoldEdge: 'blocked-non-manifold-edge',
  BlockedNonManifoldVertex: 'blocked-non-manifold-vertex',
  BlockedNonOrientable: 'blocked-non-orientable',
} as const;

export type WindingOutcome = (typeof WindingOutcome)[keyof typeof WindingOutcome];

export interface WindingSolution {
  readonly outcome: WindingOutcome;
  /** 1 where a face must be flipped. Length = faceCount. */
  readonly flipMask: Uint8Array;
  readonly flipCount: number;
  /** Components that could not be solved, for reporting. */
  readonly blockedComponents: readonly number[];
}

/**
 * Solves RELATIVE winding by two-colouring the face adjacency graph.
 *
 * WHAT THIS IS: for every edge with exactly two incident faces, the two faces
 * should traverse it in OPPOSITE directions. That gives one parity constraint
 * per ordinary edge, and a breadth-first walk assigns each face a flip bit
 * satisfying them. A contradiction means the component is non-orientable.
 *
 * WHAT THIS IS NOT: a decision about which side is outside. A connected
 * orientable component admits two globally reversed solutions and this stage
 * has no basis for choosing between them — signed volume, world axes, the
 * bounding box and the stored STL facet normal are all unreliable in the
 * presence of self-intersections and containment, none of which is checked.
 *
 * THE SEED RULE, stated so it can be relied on: the LOWEST-INDEXED surviving
 * face in each component keeps its orientation (flip parity 0). That fixes
 * relative winding deterministically while making no claim about inside or
 * outside. See docs/adr/0010.
 *
 * NO GEOMETRIC HEURISTIC IS USED ANYWHERE in this function. It reads
 * connectivity only.
 */
export function solveWinding(
  view: RepairView,
  removed?: Uint8Array,
  cancellation: CancellationToken = uncancellable,
): WindingSolution {
  const alive = (face: number): boolean => removed?.[face] !== 1;

  // Preconditions are evaluated over SURVIVING faces only: a non-manifold edge
  // created solely by a duplicate that this pipeline already removed must not
  // block the winding step.
  const nonManifoldEdgeFaces = facesOnNonManifoldEdges(view);
  const nonManifoldVertexFaces = facesOnNonManifoldVertices(view);
  for (let face = 0; face < view.faceCount; face += 1) {
    if ((face & CANCEL_POLL_MASK) === 0 && cancellation.isCancelled) throw new RepairCancelled();
    if (!alive(face)) continue;
    if (nonManifoldEdgeFaces[face] === 1 && edgeStillNonManifold(view, face, removed)) {
      return {
        outcome: WindingOutcome.BlockedNonManifoldEdge,
        flipMask: new Uint8Array(view.faceCount),
        flipCount: 0,
        blockedComponents: [view.components.faceComponent[face] ?? 0],
      };
    }
    if (nonManifoldVertexFaces[face] === 1) {
      return {
        outcome: WindingOutcome.BlockedNonManifoldVertex,
        flipMask: new Uint8Array(view.faceCount),
        flipCount: 0,
        blockedComponents: [view.components.faceComponent[face] ?? 0],
      };
    }
  }

  // Adjacency over ordinary (incidence-2) edges among surviving faces, with the
  // parity each edge demands.
  const neighbourFace: number[][] = Array.from({ length: view.faceCount }, () => []);
  const neighbourParity: number[][] = Array.from({ length: view.faceCount }, () => []);

  const { groupStart, order, uniqueEdgeCount } = view.edgeGroups;
  for (let edge = 0; edge < uniqueEdgeCount; edge += 1) {
    if ((edge & CANCEL_POLL_MASK) === 0 && cancellation.isCancelled) throw new RepairCancelled();
    const start = groupStart[edge] ?? 0;
    const end = groupStart[edge + 1] ?? start;
    const live: number[] = [];
    for (let slot = start; slot < end; slot += 1) {
      const directed = order[slot] ?? 0;
      const face = view.edges.face[directed] ?? 0;
      if (alive(face)) live.push(directed);
    }
    if (live.length !== 2) continue;

    const [firstDirected, secondDirected] = live as [number, number];
    const faceA = view.edges.face[firstDirected] ?? 0;
    const faceB = view.edges.face[secondDirected] ?? 0;
    if (faceA === faceB) continue;

    // Consistent when the two faces traverse the shared edge in OPPOSITE
    // directions. Same direction means one of them must flip.
    const sameDirection = view.edges.forward[firstDirected] === view.edges.forward[secondDirected];
    const parity = sameDirection ? 1 : 0;
    neighbourFace[faceA]?.push(faceB);
    neighbourParity[faceA]?.push(parity);
    neighbourFace[faceB]?.push(faceA);
    neighbourParity[faceB]?.push(parity);
  }

  const flipMask = new Uint8Array(view.faceCount);
  const visited = new Uint8Array(view.faceCount);
  const blocked = new Set<number>();
  let flipCount = 0;
  let contradiction = false;

  // Ascending face order: the first face reached in each component is its
  // lowest surviving index, which is exactly the seed rule.
  /*
   * POLLED ON BOTH LEVELS. Seeding alone would not be enough: a single connected
   * component can be the entire mesh, so one seed can walk every face without
   * the outer loop advancing once. The inner counter is what bounds latency on
   * the traversal that actually dominates this phase.
   */
  let visitedFaces = 0;
  for (let seed = 0; seed < view.faceCount; seed += 1) {
    if ((seed & CANCEL_POLL_MASK) === 0 && cancellation.isCancelled) throw new RepairCancelled();
    if (!alive(seed) || visited[seed] === 1) continue;
    visited[seed] = 1;
    flipMask[seed] = 0;

    const queue = [seed];
    let head = 0;
    while (head < queue.length) {
      const face = queue[head] ?? 0;
      head += 1;
      visitedFaces += 1;
      if ((visitedFaces & CANCEL_POLL_MASK) === 0 && cancellation.isCancelled) {
        throw new RepairCancelled();
      }
      const neighbours = neighbourFace[face] ?? [];
      const parities = neighbourParity[face] ?? [];
      for (const [index, other] of neighbours.entries()) {
        const wanted = ((flipMask[face] ?? 0) ^ (parities[index] ?? 0)) as 0 | 1;
        if (visited[other] === 1) {
          if ((flipMask[other] ?? 0) !== wanted) {
            // Two paths demand opposite parities: the component cannot be
            // consistently oriented. No arbitrary choice is made.
            contradiction = true;
            blocked.add(view.components.faceComponent[other] ?? 0);
          }
          continue;
        }
        visited[other] = 1;
        flipMask[other] = wanted;
        if (wanted === 1) flipCount += 1;
        queue.push(other);
      }
    }
  }

  if (contradiction) {
    return {
      outcome: WindingOutcome.BlockedNonOrientable,
      flipMask: new Uint8Array(view.faceCount),
      flipCount: 0,
      blockedComponents: [...blocked].sort((left, right) => left - right),
    };
  }

  return {
    outcome: flipCount === 0 ? WindingOutcome.AlreadyConsistent : WindingOutcome.Solved,
    flipMask,
    flipCount,
    blockedComponents: [],
  };
}

/**
 * Whether a face still sits on a non-manifold edge once removals are applied.
 *
 * A duplicated triangle pushes its edges to incidence 4. Removing the duplicate
 * restores incidence 2, so the edge was never really non-manifold in the
 * surviving surface — refusing to unify winding because of it would block a
 * repair the pipeline has already made safe.
 */
function edgeStillNonManifold(
  view: RepairView,
  face: number,
  removed: Uint8Array | undefined,
): boolean {
  const { groupStart, order, uniqueEdgeCount } = view.edgeGroups;
  for (let edge = 0; edge < uniqueEdgeCount; edge += 1) {
    if (view.edgeAnalysis.edgeClass[edge] !== EdgeClass.NonManifold) continue;
    const start = groupStart[edge] ?? 0;
    const end = groupStart[edge + 1] ?? start;
    let liveCount = 0;
    let touchesFace = false;
    for (let slot = start; slot < end; slot += 1) {
      const directed = order[slot] ?? 0;
      const owner = view.edges.face[directed] ?? 0;
      if (removed?.[owner] === 1) continue;
      liveCount += 1;
      if (owner === face) touchesFace = true;
    }
    if (touchesFace && liveCount > 2) return true;
  }
  return false;
}
