import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { buildDirectedEdges, groupEdges } from './edges';
import { recoverVertexIdentity } from './identity';
import { analyseEdges, EdgeClass } from './manifold';
import { stage, type StageMemory } from './memory';

/**
 * ORDERED BOUNDARY LOOPS.
 *
 * WHAT THIS PACKAGE ALREADY HAD, and what it did not. `analyseBoundary` groups
 * boundary edges into components and classifies each as `simple-loop`,
 * `open-chain` or `branched`. That is enough to COUNT openings and to say a
 * boundary is ambiguous. It is not enough to TARGET one: a fill needs an
 * ORDERED CYCLE — which vertex follows which, and in which direction — and a
 * STABLE IDENTITY, so that a candidate built for one opening can never be
 * applied to another.
 *
 * This module supplies both, and nothing else. IT NEVER REPAIRS. It walks the
 * connectivity the existing stages already recover, under the same exact
 * stored-coordinate identity Stage 2 uses, and it leaves every canonical buffer
 * byte-identical. See `docs/adr/0009-exact-topology-recovery.md`.
 *
 * NO TOLERANCE APPEARS HERE AND NONE MAY. A loop that does not close under the
 * stored coordinates is not a loop for this purpose. It may be a hairline crack
 * that tolerance welding would close, and that is a different operation with a
 * value the user chooses — inventing one here would make a defect disappear
 * from the report and close an opening the user never had.
 *
 * ORIENTATION IS DERIVED, NEVER CHOSEN. For a boundary edge traversed `u → v`
 * by its one incident face, the absent face traverses `v → u`. Walking those
 * reversed directions yields a cycle already wound as a patch must be wound, so
 * orientation falls out of the topology rather than out of a camera, a signed
 * volume or a world axis.
 */

declare const boundaryLoopIdBrand: unique symbol;

/**
 * A stable, targetable identity for one boundary component.
 *
 * See `boundaryLoopIdentity` for why it is shaped this way. In short: a bare
 * 32-bit hash is not enough for an identifier that selects which geometry gets
 * mutated, and an array index is not an identity at all.
 */
export type BoundaryLoopId = string & { readonly [boundaryLoopIdBrand]: true };

/**
 * Why a boundary component cannot be treated as one ordered fillable cycle.
 *
 * EVERY COMPONENT GETS AN ID, INCLUDING A REFUSED ONE. A caller that names a
 * branched boundary deserves to be told it is branched, not that the loop does
 * not exist — an engine that answered `UNKNOWN_LOOP` for every defect would
 * make a T-junction indistinguishable from a typo.
 */
export const BoundaryLoopRefusal = {
  /** A boundary vertex with more than one outgoing boundary half-edge. */
  BranchedBoundary: 'BRANCHED_BOUNDARY',
  /** A boundary vertex with more than one incoming boundary half-edge. */
  ConvergentBoundary: 'CONVERGENT_BOUNDARY',
  /** The walk ran out of half-edges without returning to its start. */
  NotClosed: 'NOT_CLOSED',
  /** The walk revisited a vertex before closing. */
  RepeatedVertex: 'REPEATED_VERTEX',
  /** Fewer than three distinct vertices; there is no polygon. */
  TooFewVertices: 'TOO_FEW_VERTICES',
  /** More boundary vertices than the extraction ceiling allows. */
  TooManyVertices: 'TOO_MANY_VERTICES',
  /** A boundary edge whose two endpoints are the same welded vertex. */
  DegenerateSegment: 'DEGENERATE_SEGMENT',
  /** A coordinate on this boundary is not finite. */
  NonFinite: 'NON_FINITE',
  /** An edge with three or more incident faces touches this boundary. */
  NonManifoldAdjacency: 'NON_MANIFOLD_ADJACENCY',
  /**
   * Two faces sharing an ordinary edge at this boundary traverse it the SAME
   * way, so the surface folds back and the rim has no single outward side.
   *
   * THIS IS THE MIXED-RIM CASE, and refusing it is deliberate: a fill must not
   * silently repair a winding it was not asked to repair, and attaching a patch
   * to a rim whose own orientation disagrees would produce a candidate whose
   * correctness nothing could state.
   */
  AmbiguousOrientation: 'AMBIGUOUS_ORIENTATION',
} as const;

export type BoundaryLoopRefusal = (typeof BoundaryLoopRefusal)[keyof typeof BoundaryLoopRefusal];

export interface BoundaryLoop {
  readonly id: BoundaryLoopId;
  /**
   * Welded vertex ids in PATCH WINDING ORDER, one entry per loop edge.
   *
   * Empty when `refusal` is set: a component that is not a simple cycle has no
   * ordering to report, and returning a partial walk would invite a caller to
   * fill half a boundary.
   */
  readonly vertices: Uint32Array;
  /**
   * The single source face incident to each ordered edge.
   *
   * `incidentFaces[i]` owns the rim edge `vertices[i] → vertices[i + 1]`, which
   * it traverses in the OPPOSITE direction. Aligned with `vertices`, so a
   * validator can check patch attachment against the face that actually owns
   * the edge rather than against a normal or a view direction.
   */
  readonly incidentFaces: Uint32Array;
  /** Distinct welded vertices in this boundary component. */
  readonly vertexCount: number;
  /** Boundary edges in this component. */
  readonly edgeCount: number;
  /** Undefined exactly when this component is an ordered, fillable cycle. */
  readonly refusal: BoundaryLoopRefusal | undefined;
}

export interface BoundaryLoopSet {
  /** Ordered by ascending smallest participating welded vertex id. */
  readonly loops: readonly BoundaryLoop[];
  /** Welded vertex id per canonical corner. */
  readonly cornerToVertex: Uint32Array;
  /** A corner whose coordinates define each welded vertex. */
  readonly vertexRepresentativeCorner: Uint32Array;
  readonly vertexCount: number;
  readonly boundaryEdgeCount: number;
  /** e.g. `exact-stored-coordinate`. The set states its own identity rules. */
  readonly identityMode: string;
}

export interface BoundaryLoopOptions {
  /**
   * Refuse a component with more than this many boundary vertices.
   *
   * A CEILING ON THE RESULT, not a silent truncation: the refusal is recorded
   * and the component keeps its id, so a caller learns the loop is too large
   * rather than that it is missing.
   */
  readonly maxLoopVertices?: number;
  /** Polled between batches so a long extraction can be cancelled. */
  onBatch?(processed: number): void;
}

const NOT_SET = 0xffffffff;

/**
 * Extracts every boundary component as an ordered loop or a typed refusal.
 *
 * BUILT ON THE EXISTING TOPOLOGY STAGES rather than beside them.
 * `recoverVertexIdentity`, `buildDirectedEdges`, `groupEdges` and `analyseEdges`
 * are the same functions `analyseTopology` runs, so a loop and a report can
 * never disagree about what the model is. A second welding scheme here would be
 * a second answer to "which corners are the same point", which is precisely the
 * drift ADR 0009 exists to prevent.
 *
 * BOUNDED AND LINEAR. Components come from a union-find over boundary
 * half-edges — O(B α(B)) for B boundary edges — and each walk is bounded by its
 * own component's size, so a malformed adjacency cannot spin and a mesh with
 * twenty thousand openings does not become quadratic.
 *
 * DETERMINISTIC. Components are keyed by their smallest welded vertex id, each
 * walk starts there, and the result is sorted by it, so the same mesh always
 * yields the same loops, in the same order, with the same ids.
 */
export function extractBoundaryLoops(
  mesh: CanonicalMesh,
  options: BoundaryLoopOptions = {},
): BoundaryLoopSet {
  const maxLoopVertices = options.maxLoopVertices ?? Number.MAX_SAFE_INTEGER;
  const identity = recoverVertexIdentity(mesh);
  const faceCount = Math.floor(mesh.indices.length / 3);

  const faceVertices = new Uint32Array(faceCount * 3);
  for (let i = 0; i < faceVertices.length; i += 1) {
    faceVertices[i] = identity.cornerToVertex[mesh.indices[i] ?? 0] ?? 0;
  }

  // Wrapped rather than passed by reference: an unbound method would carry the
  // caller's `this` into the edge stages, and the linter is right to object.
  const onBatch = (processed: number): void => {
    options.onBatch?.(processed);
  };

  const edges = buildDirectedEdges(faceVertices, faceCount, onBatch);
  const groups = groupEdges(edges, onBatch);
  const analysis = analyseEdges(edges, groups, onBatch);

  const vertexCount = identity.vertexCount;

  /*
   * THE ABSENT FACE'S DIRECTION, per boundary vertex.
   *
   * `nextVertex[v]` is where the missing surface would go from `v`, and
   * `incidentFace[v]` is the one real face that owns that rim edge. A second
   * half-edge leaving the same `v` is recorded in `outDegree` and makes the
   * component branched — it is refused rather than resolved by picking one.
   */
  const nextVertex = new Uint32Array(vertexCount).fill(NOT_SET);
  const incidentFace = new Uint32Array(vertexCount).fill(NOT_SET);
  const inDegree = new Uint32Array(vertexCount);
  const outDegree = new Uint32Array(vertexCount);
  const isBoundaryVertex = new Uint8Array(vertexCount);
  const degenerateAt = new Uint8Array(vertexCount);

  // Union-find over boundary vertices; the smaller id always wins, so a root is
  // its component's smallest member and no sort of roots is needed.
  const parent = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v += 1) parent[v] = v;
  const find = (node: number): number => {
    let root = node;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    let walk = node;
    while ((parent[walk] ?? walk) !== walk) {
      const step = parent[walk] ?? walk;
      parent[walk] = root;
      walk = step;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    if (a < b) parent[b] = a;
    else parent[a] = b;
  };

  let boundaryEdgeCount = 0;

  for (let group = 0; group < groups.uniqueEdgeCount; group += 1) {
    if (analysis.edgeClass[group] !== EdgeClass.Boundary) continue;

    const directed = groups.order[groups.groupStart[group] ?? 0] ?? 0;
    const low = edges.low[directed] ?? 0;
    const high = edges.high[directed] ?? 0;
    const face = edges.face[directed] ?? 0;
    boundaryEdgeCount += 1;

    if (low === high) {
      // A face with a repeated corner: there is no segment here to walk along,
      // and no patch edge could attach to it.
      degenerateAt[low] = 1;
      isBoundaryVertex[low] = 1;
      continue;
    }

    // `forward` is 1 when the owning face traverses low→high; the absent face
    // traverses the other way, and that is the direction the walk follows.
    const faceFrom = (edges.forward[directed] ?? 0) === 1 ? low : high;
    const faceTo = faceFrom === low ? high : low;
    const from = faceTo;
    const to = faceFrom;

    isBoundaryVertex[from] = 1;
    isBoundaryVertex[to] = 1;
    outDegree[from] = (outDegree[from] ?? 0) + 1;
    inDegree[to] = (inDegree[to] ?? 0) + 1;
    union(from, to);

    if (nextVertex[from] === NOT_SET) {
      nextVertex[from] = to;
      incidentFace[from] = face;
    }
  }

  /*
   * NON-MANIFOLD AND WINDING-CONFLICTED EDGES THAT TOUCH A BOUNDARY.
   *
   * A non-manifold edge has no single "other side", and a winding conflict
   * means two faces fold back onto each other. Either one, anywhere on a
   * boundary component, makes what a patch would attach to undetermined. Marked
   * per vertex so the refusal lands on the component that owns it and every
   * other component of the same part stays fillable.
   */
  const nonManifoldAt = new Uint8Array(vertexCount);
  const orientationConflictAt = new Uint8Array(vertexCount);

  for (let group = 0; group < groups.uniqueEdgeCount; group += 1) {
    const nonManifold = analysis.edgeClass[group] === EdgeClass.NonManifold;
    const conflicted = (analysis.windingConflict[group] ?? 0) === 1;
    if (!nonManifold && !conflicted) continue;

    const directed = groups.order[groups.groupStart[group] ?? 0] ?? 0;
    const low = edges.low[directed] ?? 0;
    const high = edges.high[directed] ?? 0;
    const mark = nonManifold ? nonManifoldAt : orientationConflictAt;
    if ((isBoundaryVertex[low] ?? 0) === 1) mark[low] = 1;
    if ((isBoundaryVertex[high] ?? 0) === 1) mark[high] = 1;
  }

  /* -------------------------------------------------------- components -- */

  const membersByRoot = new Map<number, number[]>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if ((isBoundaryVertex[vertex] ?? 0) === 0) continue;
    const root = find(vertex);
    const bucket = membersByRoot.get(root);
    if (bucket === undefined) membersByRoot.set(root, [vertex]);
    else bucket.push(vertex);
  }

  const positions = mesh.positions;
  const coordinateOf = (vertex: number): readonly [number, number, number] => {
    const corner = (identity.vertexRepresentativeCorner[vertex] ?? 0) * 3;
    const x = positions[corner] ?? 0;
    const y = positions[corner + 1] ?? 0;
    const z = positions[corner + 2] ?? 0;
    // `-0` normalises to `0`, exactly as vertex identity does, so an id cannot
    // distinguish two spellings of one point.
    return [x === 0 ? 0 : x, y === 0 ? 0 : y, z === 0 ? 0 : z];
  };

  const signals: ComponentSignals = {
    nextVertex,
    inDegree,
    outDegree,
    degenerateAt,
    nonManifoldAt,
    orientationConflictAt,
  };

  const loops: BoundaryLoop[] = [];
  // Ascending root id, which is ascending smallest member: union keeps the
  // smaller index as the root, so this ordering needs no second sort.
  for (const root of [...membersByRoot.keys()].sort((left, right) => left - right)) {
    // Members arrive in ascending vertex order because the scan above is.
    const members = membersByRoot.get(root) ?? [];

    let refusal = componentRefusal(members, signals);
    let cycle: readonly number[] = [];
    let faces: readonly number[] = [];

    if (refusal === undefined) {
      const walk = walkCycle(root, nextVertex, incidentFace, members.length);
      refusal = walk.refusal;
      cycle = walk.vertices;
      faces = walk.faces;
    }

    if (refusal === undefined && cycle.length !== members.length) {
      // The walk closed without visiting every member, so this component holds
      // more than one cycle joined at nothing the walk could see.
      refusal = BoundaryLoopRefusal.NotClosed;
      cycle = [];
      faces = [];
    }
    if (refusal === undefined && cycle.length < 3) {
      refusal = BoundaryLoopRefusal.TooFewVertices;
    }
    if (refusal === undefined && cycle.length > maxLoopVertices) {
      refusal = BoundaryLoopRefusal.TooManyVertices;
    }
    if (refusal === undefined) {
      for (const vertex of cycle) {
        const [x, y, z] = coordinateOf(vertex);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) continue;
        refusal = BoundaryLoopRefusal.NonFinite;
        break;
      }
    }

    /*
     * THE IDENTITY IS COMPUTED FROM THE WALK, NOT FROM THE VERDICT.
     *
     * This was got wrong once and it mattered: hashing only the ordering of an
     * ELIGIBLE loop made the same boundary hash two different ways depending on
     * whether the caller happened to pass a vertex ceiling — so a loop listed
     * without a ceiling could not be named with one, and the engine answered
     * `UNKNOWN_LOOP` for a loop it was looking straight at. An identity must be
     * a property of the geometry, never of the options the caller used to
     * enumerate it.
     */
    const ordered = Uint32Array.from(cycle);
    const eligible = refusal === undefined;
    loops.push({
      id: boundaryLoopIdentity(members, ordered, coordinateOf),
      // The public ordering is withheld when the component is refused: a
      // partial walk would invite a caller to fill half a boundary.
      vertices: eligible ? ordered : new Uint32Array(0),
      incidentFaces: eligible ? Uint32Array.from(faces) : new Uint32Array(0),
      vertexCount: members.length,
      edgeCount: countComponentEdges(members, outDegree),
      refusal,
    });
  }

  options.onBatch?.(vertexCount);

  return {
    loops,
    cornerToVertex: identity.cornerToVertex,
    vertexRepresentativeCorner: identity.vertexRepresentativeCorner,
    vertexCount,
    boundaryEdgeCount,
    identityMode: identity.mode,
  };
}

/** Finds a boundary loop by id. Returns `undefined` when nothing matches. */
export function findBoundaryLoop(
  set: BoundaryLoopSet,
  id: BoundaryLoopId | string,
): BoundaryLoop | undefined {
  for (const loop of set.loops) {
    if (loop.id === id) return loop;
  }
  return undefined;
}

/* ------------------------------------------------------------ internals -- */

interface ComponentSignals {
  readonly nextVertex: Uint32Array;
  readonly inDegree: Uint32Array;
  readonly outDegree: Uint32Array;
  readonly degenerateAt: Uint8Array;
  readonly nonManifoldAt: Uint8Array;
  readonly orientationConflictAt: Uint8Array;
}

/**
 * The eligibility rules, applied to a whole component before any walk.
 *
 * ORDER IS PART OF THE CONTRACT, so a component with several defects reports
 * the same reason every time. Structural impossibility first (a degenerate
 * segment, a non-manifold edge, a folded winding), then the degree conditions
 * that decide whether a single cycle can exist at all.
 *
 * THE TRIANGULATOR IS NEVER ASKED TO VALIDATE TOPOLOGY. Every condition here is
 * settled before a single ear is considered.
 */
function componentRefusal(
  members: readonly number[],
  signals: ComponentSignals,
): BoundaryLoopRefusal | undefined {
  for (const vertex of members) {
    if ((signals.degenerateAt[vertex] ?? 0) === 1) return BoundaryLoopRefusal.DegenerateSegment;
  }
  for (const vertex of members) {
    if ((signals.nonManifoldAt[vertex] ?? 0) === 1) {
      return BoundaryLoopRefusal.NonManifoldAdjacency;
    }
  }
  for (const vertex of members) {
    if ((signals.orientationConflictAt[vertex] ?? 0) === 1) {
      return BoundaryLoopRefusal.AmbiguousOrientation;
    }
  }
  for (const vertex of members) {
    if ((signals.outDegree[vertex] ?? 0) > 1) return BoundaryLoopRefusal.BranchedBoundary;
  }
  for (const vertex of members) {
    if ((signals.inDegree[vertex] ?? 0) > 1) return BoundaryLoopRefusal.ConvergentBoundary;
  }
  for (const vertex of members) {
    if ((signals.nextVertex[vertex] ?? NOT_SET) === NOT_SET) return BoundaryLoopRefusal.NotClosed;
    if ((signals.inDegree[vertex] ?? 0) === 0) return BoundaryLoopRefusal.NotClosed;
  }
  return undefined;
}

interface WalkResult {
  readonly vertices: readonly number[];
  readonly faces: readonly number[];
  readonly refusal: BoundaryLoopRefusal | undefined;
}

/**
 * Follows the absent face's direction until it returns to `start`.
 *
 * BOUNDED BY THE COMPONENT'S OWN SIZE. A walk taking more steps than there are
 * members has left the component or is looping, and is refused rather than
 * allowed to continue.
 */
function walkCycle(
  start: number,
  nextVertex: Uint32Array,
  incidentFace: Uint32Array,
  memberCount: number,
): WalkResult {
  const vertices: number[] = [];
  const faces: number[] = [];
  const seen = new Set<number>();
  let current = start;

  for (let step = 0; step <= memberCount; step += 1) {
    if (seen.has(current)) {
      return { vertices: [], faces: [], refusal: BoundaryLoopRefusal.RepeatedVertex };
    }
    seen.add(current);
    const next = nextVertex[current] ?? NOT_SET;
    const face = incidentFace[current] ?? NOT_SET;
    if (next === NOT_SET || face === NOT_SET) {
      return { vertices: [], faces: [], refusal: BoundaryLoopRefusal.NotClosed };
    }
    vertices.push(current);
    faces.push(face);
    current = next;
    if (current === start) return { vertices, faces, refusal: undefined };
  }

  return { vertices: [], faces: [], refusal: BoundaryLoopRefusal.NotClosed };
}

function countComponentEdges(members: readonly number[], outDegree: Uint32Array): number {
  let total = 0;
  for (const vertex of members) total += outDegree[vertex] ?? 0;
  return total;
}

/* ------------------------------------------------------------- identity -- */

/**
 * THE LOOP IDENTITY, and why it is not the research hash.
 *
 * Stage 4B-1A derived a loop id from a 32-bit FNV-1a over the loop's
 * coordinates. That is fine for naming a row in a results table and NOT fine
 * for an identifier that selects which geometry a mutation targets. A 32-bit
 * space has a birthday collision around 65,000 items, and the research corpus
 * itself contains a part with 20,165 boundary loops — roughly a 4.6% chance
 * that two of them would become interchangeable. Two loops that collide are two
 * loops the engine cannot tell apart, and filling the wrong hole is exactly the
 * failure this stage exists to make impossible.
 *
 * SO THE ID CARRIES TOPOLOGY, NOT ONLY GEOMETRY, and its uniqueness is
 * STRUCTURAL rather than probabilistic:
 *
 *   1. `minVertex` — the smallest welded vertex id in the component. Boundary
 *      components are VERTEX-DISJOINT by construction, so no two components of
 *      one part can share it. That alone makes intra-part collision impossible,
 *      which is the case that matters: an operation already names a document, a
 *      revision and a part, and the loop only has to be unique inside those.
 *   2. `vertexCount` — cheap, and it makes a truncated or extended boundary a
 *      different name rather than a near miss.
 *   3. A 64-bit hash over BOTH the sorted (vertex id, coordinate) triples and
 *      the canonical ordered rotation. This is what makes a STALE id fail to
 *      match: after an edit, a component whose smallest vertex id happens to be
 *      unchanged but whose shape or winding is not gets a different name, so it
 *      is refused as unknown rather than silently accepted as the same opening.
 *
 * DIRECTION IS PRESERVED, because a reversed loop is a different orientation
 * and must not collide with its own reverse.
 *
 * NOT USED, ANYWHERE: a boundary-list index, render order, a part name, an
 * array position from the interface, or JavaScript object identity. Every one
 * of those silently becomes a different loop the moment the mesh changes.
 */
export function boundaryLoopIdentity(
  members: readonly number[],
  ordered: Uint32Array,
  coordinateOf: (vertex: number) => readonly [number, number, number],
): BoundaryLoopId {
  const hash = new LoopHash();

  // Sorted membership: defined for a refused component too, which has no
  // ordering but still needs a name a caller can be told about.
  for (const vertex of members) {
    hash.pushUint32(vertex);
    const [x, y, z] = coordinateOf(vertex);
    hash.pushFloat(x);
    hash.pushFloat(y);
    hash.pushFloat(z);
  }

  hash.pushUint32(0xffffffff);

  // The canonical rotation: start at the smallest vertex id so the same cycle
  // hashes identically whichever edge the walk began at.
  if (ordered.length > 0) {
    let smallest = 0;
    for (let index = 1; index < ordered.length; index += 1) {
      if ((ordered[index] ?? 0) < (ordered[smallest] ?? 0)) smallest = index;
    }
    for (let step = 0; step < ordered.length; step += 1) {
      hash.pushUint32(ordered[(smallest + step) % ordered.length] ?? 0);
    }
  }

  const minVertex = members.length === 0 ? 0 : (members[0] ?? 0);
  return `bl-${String(minVertex)}-${String(members.length)}-${hash.digest()}` as BoundaryLoopId;
}

const hashBuffer = new ArrayBuffer(8);
const hashFloat = new Float64Array(hashBuffer);
const hashWords = new Uint32Array(hashBuffer);

/**
 * A 64-bit hash in two independently seeded, independently mixed 32-bit lanes.
 *
 * TWO LANES RATHER THAN ONE. JavaScript has no cheap 64-bit integer arithmetic,
 * and a single 32-bit lane is the weakness this identity exists to fix. Two
 * lanes with different offset bases and different mixing constants give 64 bits
 * of output; combined with the structural `minVertex` component above, even a
 * full lane collision cannot make two loops of one part interchangeable.
 */
class LoopHash {
  private a = 0x811c9dc5;
  private b = 0x01000193;

  public pushUint32(value: number): void {
    this.a = Math.imul(this.a ^ (value >>> 0), 0x01000193) >>> 0;
    this.b = Math.imul(this.b ^ (value >>> 0), 0x85ebca6b) >>> 0;
    this.b = (this.b ^ (this.b >>> 13)) >>> 0;
  }

  /**
   * Hashes a coordinate through its float64 BIT PATTERN.
   *
   * Arithmetic hashing of floats collides badly on structured data, and CAD
   * meshes are nothing but structured data — lattices, repeated offsets, axis
   * planes. Equal doubles have identical bit patterns once `-0` is normalised,
   * which the caller does, so equal points always hash equally.
   */
  public pushFloat(value: number): void {
    hashFloat[0] = value;
    this.pushUint32(hashWords[0] ?? 0);
    this.pushUint32(hashWords[1] ?? 0);
  }

  public digest(): string {
    const a = (this.a ^ (this.a >>> 16)) >>> 0;
    const b = (this.b ^ (this.b >>> 16)) >>> 0;
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
}

/** Bytes `extractBoundaryLoops` allocates beyond the shared topology stages. */
export function estimateBoundaryLoopBytes(faceCount: number, vertexCount: number): StageMemory {
  // Retained: the ordered loops, at most one entry per boundary vertex across
  // every component, plus the incident face aligned with them.
  const retained = vertexCount * 4 * 2;
  // Released with the extraction: the per-vertex successor, degree, marker and
  // union-find arrays, plus the face-vertex view built for the edge stages.
  const transient = vertexCount * (4 * 5 + 4) + faceCount * 3 * 4;
  return stage(retained, transient);
}
