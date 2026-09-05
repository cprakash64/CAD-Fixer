/**
 * DETERMINISTIC BOUNDARY-LOOP EXTRACTION AND HOLE ELIGIBILITY. RESEARCH ONLY.
 *
 * WHAT PRODUCTION ALREADY HAS, and what it does not.
 *
 * `packages/mesh-topology` recovers exact-coordinate vertex identity, builds
 * directed edges, groups them, classifies every edge as boundary / manifold /
 * non-manifold, and classifies each boundary COMPONENT as `simple-loop`,
 * `open-chain` or `branched`. That is enough to COUNT openings and to say a
 * boundary is ambiguous.
 *
 * It is not enough to FILL one. Filling needs an ORDERED CYCLE of vertices —
 * which vertex follows which, and in which direction — and production produces
 * no such thing. It also needs a STABLE IDENTITY for the loop, so that a
 * candidate built for one opening cannot be applied to another.
 *
 * This module is the research answer to both, written so its rules can be
 * argued with before any of it becomes production.
 *
 * EXACT IDENTITY THROUGHOUT. Vertices are welded only by exact stored
 * coordinates, exactly as Stage 2 does, with `+0` and `-0` normalised together.
 * There is no epsilon here, and there must not be: a tolerance that closed a
 * hairline crack would make a defect disappear from the report and would fill
 * an opening the user never had. Tolerance welding is a separate, later
 * operation with a value the user chooses.
 */

/** Normalises `-0` to `0` so the two spellings of one point weld together. */
function norm(value) {
  return value === 0 ? 0 : value;
}

/**
 * Welds corners into topological vertices by EXACT stored coordinates.
 *
 * Mirrors `packages/mesh-topology/src/identity.ts`. Restated here rather than
 * imported because this is a research module that must run under plain node
 * against raw arrays, and because the point of the exercise is to be able to
 * change one without silently changing the other.
 */
export function weldVertices(positions) {
  const map = new Map();
  const vertexOf = new Int32Array(positions.length / 3);
  const representative = [];

  for (let corner = 0; corner < positions.length / 3; corner += 1) {
    const x = norm(positions[corner * 3]);
    const y = norm(positions[corner * 3 + 1]);
    const z = norm(positions[corner * 3 + 2]);
    const key = `${x},${y},${z}`;
    let id = map.get(key);
    if (id === undefined) {
      id = representative.length;
      map.set(key, id);
      representative.push([x, y, z]);
    }
    vertexOf[corner] = id;
  }

  return { vertexOf, representative, vertexCount: representative.length };
}

/* ------------------------------------------------------- directed edges -- */

export const LoopRefusal = {
  /** A boundary vertex with more than one outgoing boundary edge. */
  BranchedBoundary: 'BRANCHED_BOUNDARY',
  /** A boundary vertex with more than one incoming boundary edge. */
  ConvergentBoundary: 'CONVERGENT_BOUNDARY',
  /** The same directed boundary edge appears twice. */
  DuplicateBoundaryEdge: 'DUPLICATE_BOUNDARY_EDGE',
  /** The walk revisited a vertex before closing. */
  RepeatedVertex: 'REPEATED_VERTEX',
  /** The walk ran out of edges without returning to its start. */
  NotClosed: 'NOT_CLOSED',
  /** Fewer than three distinct vertices. */
  TooFewVertices: 'TOO_FEW_VERTICES',
  /** A boundary segment whose endpoints are the same welded vertex. */
  DegenerateSegment: 'DEGENERATE_SEGMENT',
  /** A coordinate that is not finite. */
  NonFinite: 'NON_FINITE',
  /** More boundary vertices than the ceiling allows. */
  TooManyVertices: 'TOO_MANY_VERTICES',
  /** An edge with more than two incident faces touches this boundary. */
  NonManifoldAdjacency: 'NON_MANIFOLD_ADJACENCY',
};

/**
 * Extracts ordered boundary loops.
 *
 * THE WALK IS OVER DIRECTED HALF-EDGES, which is what makes the traversal
 * unambiguous and the resulting orientation meaningful. Every triangle
 * contributes three directed edges in winding order. An edge with exactly one
 * incident face is a boundary edge, and its OPPOSITE direction is the direction
 * the missing face would have used — so walking the opposite directions
 * produces a cycle wound as the patch must be wound. Orientation therefore
 * falls out of the topology rather than being chosen.
 *
 * DETERMINISM. Loops start at the smallest participating vertex id, and the
 * successor of each boundary vertex is unique or the loop is refused, so there
 * is never a choice to make. The same mesh always yields the same loops in the
 * same order.
 *
 * BOUNDED. The walk cannot exceed the number of boundary edges, so a malformed
 * adjacency cannot spin.
 */
export function extractBoundaryLoops(positions, indices, options = {}) {
  const maxLoopVertices = options.maxLoopVertices ?? Number.MAX_SAFE_INTEGER;
  const { vertexOf, representative } = weldVertices(positions);

  for (const [x, y, z] of representative) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return { loops: [], refusals: [{ reason: LoopRefusal.NonFinite }], vertexOf, representative };
    }
  }

  const faceCount = indices.length / 3;

  /*
   * UNDIRECTED EDGE INCIDENCE, keyed on the welded vertex pair. An edge with
   * one incident face is boundary; with two, manifold; with three or more,
   * non-manifold — and a non-manifold edge touching a boundary makes the
   * boundary's local structure ambiguous, which is a refusal rather than a
   * guess.
   */
  const incidence = new Map();
  const directed = new Map();

  for (let face = 0; face < faceCount; face += 1) {
    const a = vertexOf[indices[face * 3]];
    const b = vertexOf[indices[face * 3 + 1]];
    const c = vertexOf[indices[face * 3 + 2]];
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const undirected = from < to ? `${from}:${to}` : `${to}:${from}`;
      incidence.set(undirected, (incidence.get(undirected) ?? 0) + 1);
      const key = `${from}>${to}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }

  /*
   * THE BOUNDARY HALF-EDGES, in the direction the MISSING face would use.
   *
   * For a boundary edge (u,v) traversed u→v by its single incident face, the
   * absent face traverses v→u. Collecting those reversed directions gives a set
   * whose cycles are the loops, already wound so that a patch built from them
   * attaches with opposing orientation — which is precisely the manifold
   * winding condition.
   */
  const successors = new Map();
  const predecessorCount = new Map();
  const refusals = [];

  for (let face = 0; face < faceCount; face += 1) {
    const a = vertexOf[indices[face * 3]];
    const b = vertexOf[indices[face * 3 + 1]];
    const c = vertexOf[indices[face * 3 + 2]];
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const undirected = from < to ? `${from}:${to}` : `${to}:${from}`;
      const count = incidence.get(undirected);
      if (count !== 1) continue;
      if (from === to) {
        refusals.push({ reason: LoopRefusal.DegenerateSegment, at: from });
        continue;
      }
      // The missing face's direction.
      if (successors.has(to)) {
        refusals.push({ reason: LoopRefusal.BranchedBoundary, at: to });
        continue;
      }
      successors.set(to, from);
      predecessorCount.set(from, (predecessorCount.get(from) ?? 0) + 1);
    }
  }

  for (const [vertex, count] of predecessorCount) {
    if (count > 1) refusals.push({ reason: LoopRefusal.ConvergentBoundary, at: vertex });
  }

  /*
   * A NON-MANIFOLD EDGE TOUCHING A BOUNDARY VERTEX POISONS THE LOOP. The local
   * surface has no single "other side", so what the patch should attach to is
   * not determined — which is a refusal, not something to resolve by picking.
   */
  const boundaryVertices = new Set([...successors.keys(), ...predecessorCount.keys()]);
  for (const [key, count] of incidence) {
    if (count <= 2) continue;
    const [u, v] = key.split(':').map(Number);
    if (boundaryVertices.has(u) || boundaryVertices.has(v)) {
      refusals.push({ reason: LoopRefusal.NonManifoldAdjacency, at: u });
    }
  }

  for (const [key, count] of directed) {
    if (count <= 1) continue;
    const [from, to] = key.split('>').map(Number);
    const undirected = from < to ? `${from}:${to}` : `${to}:${from}`;
    if (incidence.get(undirected) === 1) {
      refusals.push({ reason: LoopRefusal.DuplicateBoundaryEdge, at: from });
    }
  }

  if (refusals.length > 0) {
    return { loops: [], refusals: dedupe(refusals), vertexOf, representative };
  }

  /* ----------------------------------------------------------- the walk -- */

  const visited = new Set();
  const loops = [];
  const starts = [...successors.keys()].sort((left, right) => left - right);

  for (const start of starts) {
    if (visited.has(start)) continue;

    const cycle = [];
    const seen = new Set();
    let current = start;
    let steps = 0;

    for (;;) {
      if (steps > successors.size) {
        refusals.push({ reason: LoopRefusal.NotClosed, at: start });
        break;
      }
      if (seen.has(current)) {
        if (current !== start) {
          refusals.push({ reason: LoopRefusal.RepeatedVertex, at: current });
        }
        break;
      }
      seen.add(current);
      cycle.push(current);
      const next = successors.get(current);
      if (next === undefined) {
        refusals.push({ reason: LoopRefusal.NotClosed, at: current });
        break;
      }
      current = next;
      steps += 1;
      if (current === start) break;
    }

    if (current !== start || cycle.length === 0) continue;
    for (const vertex of cycle) visited.add(vertex);

    if (cycle.length < 3) {
      refusals.push({ reason: LoopRefusal.TooFewVertices, at: start, size: cycle.length });
      continue;
    }
    if (cycle.length > maxLoopVertices) {
      refusals.push({ reason: LoopRefusal.TooManyVertices, at: start, size: cycle.length });
      continue;
    }

    loops.push({ vertices: cycle, id: loopIdentity(cycle, representative) });
  }

  return { loops, refusals: dedupe(refusals), vertexOf, representative };
}

function dedupe(refusals) {
  const seen = new Set();
  const out = [];
  for (const refusal of refusals) {
    const key = `${refusal.reason}:${refusal.at ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(refusal);
  }
  return out;
}

/**
 * A STABLE, USER-FACING LOOP IDENTITY.
 *
 * NOT an object reference and NOT a position in an array: a candidate built for
 * one opening must never be applicable to another, and an index would silently
 * become a different loop the moment the mesh changed.
 *
 * The identity is derived from the loop's own COORDINATES, rotated to start at
 * its lexicographically smallest vertex so the same cycle hashes the same way
 * whichever edge the walk happened to begin at. Direction is preserved, because
 * a reversed loop is a different orientation and must not collide.
 */
export function loopIdentity(cycle, representative) {
  const points = cycle.map((vertex) => representative[vertex]);
  let smallest = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (comparePoint(points[index], points[smallest]) < 0) smallest = index;
  }
  const rotated = [...points.slice(smallest), ...points.slice(0, smallest)];
  const text = rotated.map((point) => point.join(',')).join(';');
  return `loop-${fnv1a(text)}-${cycle.length}`;
}

function comparePoint(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
