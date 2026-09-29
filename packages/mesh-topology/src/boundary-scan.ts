import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { BoundaryLoopRefusal } from './boundary-loops';
import { exactStoredCoordinateIdentity, tableCapacityFor } from './identity';

/**
 * THE COMPACT BOUNDARY SCAN — REPAIR-CORE-02.
 *
 * WHAT IT IS FOR. Finding the open boundaries of a LARGE part — millions of
 * triangles — without paying for the full topology machinery that
 * `extractBoundaryLoops` builds. That function recovers a vertex id for every
 * corner (16 bytes a corner, plus a probe table), materialises and radix-sorts
 * every directed edge (about 60 bytes a face), classifies every edge, and keeps
 * per-component JavaScript arrays; measured at 691–1,034 bytes a face on
 * loose-triangle shapes. It is correct, and it is the reason hole filling had a
 * 250,000-face ceiling.
 *
 * WHAT THIS DOES INSTEAD. One open-addressed hash table of UNDIRECTED EDGES,
 * keyed by the EXACT stored coordinates of their endpoints. An entry holds five
 * bytes: the directed-edge slot that first produced it (`face * 3 + corner`,
 * from which both endpoint corners and the owning face are recovered) and one
 * byte of incidence metadata. No per-corner array, no per-edge sort, no
 * per-component object. Everything proportional to the whole part is in that
 * one table; everything else is proportional to the BOUNDARY, and the boundary
 * is capped before any of it is allocated.
 *
 * THE SAME ANSWERS. Vertex identity is ADR 0009's exact stored-coordinate rule —
 * the same hash, the same `-0` normalisation, the same exact comparison — so
 * two corners are one vertex here exactly when they are one vertex in Stage 2.
 * Edge incidence, winding conflict, the boundary walk direction, the refusal
 * taxonomy and its ORDER are `extractBoundaryLoops`'s, and a differential test
 * holds the two to identical loops on every fixture both can read. It never
 * welds, snaps, rounds or moves anything, and it writes no canonical buffer.
 *
 * WHAT IT DOES NOT PRODUCE. Global vertex numbering. Loop identities are
 * therefore GEOMETRIC (`bx-…`, a hash of the canonical ordered coordinates)
 * rather than the `bl-…` identities of the per-opening workflow, and the two
 * are never compared: they belong to different operations.
 */

export const BoundaryScanStatus = {
  /** Every boundary edge was found, grouped and classified. */
  Scanned: 'SCANNED',
  /**
   * The part has more boundary edges than the scan will assemble. The count is
   * exact; no loop is reported, because a partial list would read as the
   * whole of the part's openings.
   */
  TooManyBoundaryEdges: 'TOO_MANY_BOUNDARY_EDGES',
} as const;

export type BoundaryScanStatus = (typeof BoundaryScanStatus)[keyof typeof BoundaryScanStatus];

export interface BoundaryScanLimits {
  /** Boundary edges above which no loop is assembled. */
  readonly maxBoundaryEdges: number;
  /** Ordered loops above this many vertices are refused `TOO_MANY_VERTICES`. */
  readonly maxLoopVertices: number;
}

export interface ScannedLoop {
  /** Geometric identity: `bx-<vertexCount>-<hash64>`. Stable across revisions whose boundary is unchanged. */
  readonly id: string;
  /** Undefined exactly when this component is an ordered, simple, closed cycle. */
  readonly refusal: BoundaryLoopRefusal | undefined;
  /** Distinct vertices in the boundary component. */
  readonly vertexCount: number;
  /** Boundary edges in the component. */
  readonly edgeCount: number;
  /**
   * A canonical corner for each ordered vertex, in PATCH WINDING ORDER, starting
   * at the lexicographically smallest coordinate. Empty when refused.
   */
  readonly corners: Uint32Array;
  /** `incidentFaces[i]` owns the rim edge `corners[i] → corners[i+1]`, traversed the other way. */
  readonly incidentFaces: Uint32Array;
  /** Exact Float64 widening of each ordered vertex. Empty when refused. */
  readonly points: Float64Array;
}

/** Incidence of an undirected edge in the scanned mesh, by exact endpoint coordinates. */
export interface EdgeIncidenceQuery {
  /** 0, 1, 2, or 3 for "three or more". */
  incidence(cornerA: number, cornerB: number): number;
}

export interface BoundaryScan {
  readonly status: BoundaryScanStatus;
  readonly faceCount: number;
  readonly uniqueEdgeCount: number;
  readonly boundaryEdgeCount: number;
  /** Ordered by each loop's smallest coordinate, lexicographically. Empty unless `Scanned`. */
  readonly loops: readonly ScannedLoop[];
  /** Components that are simple closed cycles, whatever their size or geometry. */
  readonly simpleLoopCount: number;
  /** Components that branch, converge, stay open or touch non-manifold geometry. */
  readonly complexBoundaryCount: number;
  /** Bytes held by the edge table at its largest. */
  readonly tableBytes: number;
  /** Edge incidence of the scanned mesh. Holds the table; drop the scan to release it. */
  readonly edges: EdgeIncidenceQuery;
}

export interface BoundaryScanOptions {
  readonly limits: BoundaryScanLimits;
  /** Called with a running face count; may throw to cancel. */
  poll?(processed: number): void;
}

/* ------------------------------------------------------------ constants -- */

const EMPTY = 0;
const NOT_SET = 0xffffffff;
const COUNT_MASK = 0b11;
const CONFLICT_BIT = 0b100;
/** Faces between polls. Matches the repair engine's interval. */
const POLL_INTERVAL = 32_768;

/** Refusals that describe a component that is NOT a single simple cycle. */
const COMPLEX_REFUSALS: ReadonlySet<BoundaryLoopRefusal> = new Set([
  BoundaryLoopRefusal.BranchedBoundary,
  BoundaryLoopRefusal.ConvergentBoundary,
  BoundaryLoopRefusal.NotClosed,
  BoundaryLoopRefusal.RepeatedVertex,
  BoundaryLoopRefusal.NonManifoldAdjacency,
  BoundaryLoopRefusal.AmbiguousOrientation,
  BoundaryLoopRefusal.DegenerateSegment,
  BoundaryLoopRefusal.TooFewVertices,
]);

/* ---------------------------------------------------------------- scan -- */

export function scanBoundaries(mesh: CanonicalMesh, options: BoundaryScanOptions): BoundaryScan {
  const { positions, indices } = mesh;
  const faceCount = Math.floor(indices.length / 3);
  const geometry = new CornerGeometry(positions, indices);
  const table = new EdgeTable(geometry, Math.ceil(faceCount * 1.5));

  /* ---- pass 1: every directed edge into the table ---- */
  for (let face = 0; face < faceCount; face += 1) {
    if (face % POLL_INTERVAL === 0) options.poll?.(face);
    const base = face * 3;
    table.insert(base);
    table.insert(base + 1);
    table.insert(base + 2);
  }
  options.poll?.(faceCount);

  /* ---- pass 2: count, then collect, the boundary ---- */
  let boundaryEdgeCount = 0;
  for (let slot = 0; slot < table.capacity; slot += 1) {
    if (table.countAt(slot) === 1) boundaryEdgeCount += 1;
  }

  const base: Omit<BoundaryScan, 'status' | 'loops' | 'simpleLoopCount' | 'complexBoundaryCount'> =
    {
      faceCount,
      uniqueEdgeCount: table.size,
      boundaryEdgeCount,
      tableBytes: table.peakBytes,
      edges: table,
    };

  if (boundaryEdgeCount > options.limits.maxBoundaryEdges) {
    return {
      ...base,
      status: BoundaryScanStatus.TooManyBoundaryEdges,
      loops: [],
      simpleLoopCount: 0,
      complexBoundaryCount: 0,
    };
  }

  // Directed-edge slots of the boundary, in ASCENDING FACE ORDER, so every
  // number derived below depends on the mesh and not on the table's layout.
  const boundary = new Uint32Array(boundaryEdgeCount);
  let written = 0;
  for (let slot = 0; slot < table.capacity; slot += 1) {
    if (table.countAt(slot) === 1) {
      boundary[written] = table.directedAt(slot);
      written += 1;
    }
  }
  boundary.sort();
  options.poll?.(faceCount);

  /* ---- boundary vertices: a small exact-coordinate table ---- */
  const vertices = new VertexTable(geometry, boundaryEdgeCount * 2);
  const localCount = boundaryEdgeCount * 2;
  const nextVertex = new Uint32Array(localCount).fill(NOT_SET);
  const incidentFace = new Uint32Array(localCount).fill(NOT_SET);
  const inDegree = new Uint32Array(localCount);
  const outDegree = new Uint32Array(localCount);
  const degenerateAt = new Uint8Array(localCount);
  const nonManifoldAt = new Uint8Array(localCount);
  const orientationConflictAt = new Uint8Array(localCount);
  const parent = new Uint32Array(localCount);
  for (let v = 0; v < localCount; v += 1) parent[v] = v;

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

  for (const directed of boundary) {
    const from = geometry.startCorner(directed);
    const to = geometry.endCorner(directed);
    const face = Math.floor(directed / 3);
    const a = vertices.insert(from);
    if (geometry.samePoint(from, to)) {
      // A face with a repeated corner: no segment to walk and nothing a patch
      // edge could attach to. Exactly `extractBoundaryLoops`'s rule.
      degenerateAt[a] = 1;
      continue;
    }
    const b = vertices.insert(to);
    // The owning face traverses a → b; the absent face — and the walk — b → a.
    outDegree[b] = (outDegree[b] ?? 0) + 1;
    inDegree[a] = (inDegree[a] ?? 0) + 1;
    union(b, a);
    if (nextVertex[b] === NOT_SET) {
      nextVertex[b] = a;
      incidentFace[b] = face;
    }
  }

  /* ---- pass 3: non-manifold and folded edges that touch the boundary ---- */
  for (let slot = 0; slot < table.capacity; slot += 1) {
    const count = table.countAt(slot);
    const conflicted = count === 2 && table.conflictAt(slot);
    if (count < 3 && !conflicted) continue;
    const directed = table.directedAt(slot);
    const mark = count >= 3 ? nonManifoldAt : orientationConflictAt;
    const low = vertices.find(geometry.startCorner(directed));
    const high = vertices.find(geometry.endCorner(directed));
    if (low >= 0) mark[low] = 1;
    if (high >= 0) mark[high] = 1;
  }
  options.poll?.(faceCount);

  /* ---- components, walks, refusals ---- */
  const membersByRoot = new Map<number, number[]>();
  for (let vertex = 0; vertex < vertices.size; vertex += 1) {
    const root = find(vertex);
    const bucket = membersByRoot.get(root);
    if (bucket === undefined) membersByRoot.set(root, [vertex]);
    else bucket.push(vertex);
  }

  const loops: ScannedLoop[] = [];
  let simpleLoopCount = 0;
  let complexBoundaryCount = 0;

  for (const members of membersByRoot.values()) {
    let refusal = componentRefusal(members, {
      nextVertex,
      inDegree,
      outDegree,
      degenerateAt,
      nonManifoldAt,
      orientationConflictAt,
    });
    let cycle: number[] = [];
    let faces: number[] = [];

    if (refusal === undefined) {
      const start = members[0] ?? 0;
      const walk = walkCycle(start, nextVertex, incidentFace, members.length);
      refusal = walk.refusal;
      cycle = walk.vertices;
      faces = walk.faces;
    }
    if (refusal === undefined && cycle.length !== members.length) {
      refusal = BoundaryLoopRefusal.NotClosed;
    }
    if (refusal === undefined && cycle.length < 3) refusal = BoundaryLoopRefusal.TooFewVertices;
    // Counted as simple BEFORE the size and finiteness refusals: those describe
    // a simple cycle Pybrix will not fill, not a boundary that is not one.
    const simple = refusal === undefined;
    if (refusal === undefined && cycle.length > options.limits.maxLoopVertices) {
      refusal = BoundaryLoopRefusal.TooManyVertices;
    }
    if (refusal === undefined) {
      for (const vertex of cycle) {
        if (!geometry.isFinite(vertices.cornerOf(vertex))) {
          refusal = BoundaryLoopRefusal.NonFinite;
          break;
        }
      }
    }
    if (simple) simpleLoopCount += 1;
    else if (refusal !== undefined && COMPLEX_REFUSALS.has(refusal)) complexBoundaryCount += 1;

    const eligible = refusal === undefined;
    const ordered = eligible ? canonicalRotation(cycle, faces, vertices, geometry) : undefined;
    const identityCycle = ordered?.vertices ?? sortedByCoordinate(members, vertices, geometry);

    let edgeCount = 0;
    for (const vertex of members) edgeCount += outDegree[vertex] ?? 0;

    loops.push({
      id: loopIdentity(identityCycle, vertices, geometry, eligible),
      refusal,
      vertexCount: members.length,
      edgeCount,
      corners: ordered === undefined ? new Uint32Array(0) : ordered.corners,
      incidentFaces: ordered === undefined ? new Uint32Array(0) : Uint32Array.from(ordered.faces),
      points: ordered === undefined ? new Float64Array(0) : ordered.points,
    });
  }

  loops.sort((left, right) => compareLoops(left, right));

  return {
    ...base,
    status: BoundaryScanStatus.Scanned,
    loops,
    simpleLoopCount,
    complexBoundaryCount,
  };
}

/** Bytes the scan's table holds for a part of `faceCount` faces, at worst. */
export function estimateBoundaryScanBytes(faceCount: number): number {
  // Worst case: every edge distinct (loose triangles), so 3F unique edges.
  const capacity = tableCapacityFor(faceCount * 3);
  // Five bytes an entry, and during the final growth the previous table (half
  // the size) coexists with the new one.
  return capacity * 5 * 1.5;
}

/* ------------------------------------------------------------ internals -- */

/** Corner coordinates and edge endpoints, read straight from the canonical buffers. */
class CornerGeometry {
  private readonly positions: ArrayLike<number>;
  private readonly indices: ArrayLike<number>;

  public constructor(positions: ArrayLike<number>, indices: ArrayLike<number>) {
    this.positions = positions;
    this.indices = indices;
  }

  /** The corner a directed edge starts at. */
  public startCorner(directed: number): number {
    return this.indices[directed] ?? 0;
  }

  /** The corner a directed edge ends at: the next corner of the same face. */
  public endCorner(directed: number): number {
    const face = Math.floor(directed / 3);
    return this.indices[face * 3 + ((directed - face * 3 + 1) % 3)] ?? 0;
  }

  public coordinate(corner: number, axis: number): number {
    const value = this.positions[corner * 3 + axis] ?? 0;
    // `-0` and `+0` are one point, exactly as vertex identity says.
    return value === 0 ? 0 : value;
  }

  public hash(corner: number): number {
    return exactStoredCoordinateIdentity.hash(
      this.coordinate(corner, 0),
      this.coordinate(corner, 1),
      this.coordinate(corner, 2),
    );
  }

  public samePoint(a: number, b: number): boolean {
    return (
      this.coordinate(a, 0) === this.coordinate(b, 0) &&
      this.coordinate(a, 1) === this.coordinate(b, 1) &&
      this.coordinate(a, 2) === this.coordinate(b, 2)
    );
  }

  public isFinite(corner: number): boolean {
    return (
      Number.isFinite(this.coordinate(corner, 0)) &&
      Number.isFinite(this.coordinate(corner, 1)) &&
      Number.isFinite(this.coordinate(corner, 2))
    );
  }
}

/** Symmetric combination of two endpoint hashes, so (a,b) and (b,a) collide by design. */
function edgeHash(ha: number, hb: number): number {
  const low = Math.min(ha, hb);
  const high = Math.max(ha, hb);
  let h = (low ^ Math.imul(high, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * The undirected edge table. Five bytes an entry: the first directed slot + 1
 * (zero marks empty), and a byte holding a saturating incidence count and a
 * "second use ran the same way" flag.
 */
class EdgeTable implements EdgeIncidenceQuery {
  private slots: Uint32Array;
  private meta: Uint8Array;
  public capacity: number;
  private mask: number;
  public size = 0;
  public peakBytes = 0;
  private readonly geometry: CornerGeometry;

  public constructor(geometry: CornerGeometry, expectedEdges: number) {
    this.geometry = geometry;
    this.capacity = tableCapacityFor(Math.max(1, expectedEdges));
    this.mask = this.capacity - 1;
    this.slots = new Uint32Array(this.capacity);
    this.meta = new Uint8Array(this.capacity);
    this.peakBytes = this.capacity * 5;
  }

  public insert(directed: number): void {
    if ((this.size + 1) / this.capacity > 0.7) this.grow();
    const a = this.geometry.startCorner(directed);
    const b = this.geometry.endCorner(directed);
    let slot = edgeHash(this.geometry.hash(a), this.geometry.hash(b)) & this.mask;
    for (;;) {
      const stored = this.slots[slot] ?? EMPTY;
      if (stored === EMPTY) {
        this.slots[slot] = directed + 1;
        this.meta[slot] = 1;
        this.size += 1;
        return;
      }
      const match = this.compare(stored - 1, a, b);
      if (match !== Match.None) {
        const meta = this.meta[slot] ?? 0;
        const count = meta & COUNT_MASK;
        if (count === 3) return;
        let next = (meta & ~COUNT_MASK) | (count + 1);
        // The second use traverses the edge the same way the first did: the
        // two faces fold onto each other. Only meaningful at exactly two.
        if (count === 1 && match === Match.Same) next |= CONFLICT_BIT;
        this.meta[slot] = next;
        return;
      }
      slot = (slot + 1) & this.mask;
    }
  }

  public incidence(cornerA: number, cornerB: number): number {
    let slot = edgeHash(this.geometry.hash(cornerA), this.geometry.hash(cornerB)) & this.mask;
    for (;;) {
      const stored = this.slots[slot] ?? EMPTY;
      if (stored === EMPTY) return 0;
      if (this.compare(stored - 1, cornerA, cornerB) !== Match.None) {
        return (this.meta[slot] ?? 0) & COUNT_MASK;
      }
      slot = (slot + 1) & this.mask;
    }
  }

  public countAt(slot: number): number {
    return this.slots[slot] === EMPTY ? 0 : (this.meta[slot] ?? 0) & COUNT_MASK;
  }

  public conflictAt(slot: number): boolean {
    return ((this.meta[slot] ?? 0) & CONFLICT_BIT) !== 0;
  }

  public directedAt(slot: number): number {
    return (this.slots[slot] ?? 1) - 1;
  }

  private compare(storedDirected: number, a: number, b: number): Match {
    const sa = this.geometry.startCorner(storedDirected);
    const sb = this.geometry.endCorner(storedDirected);
    if (this.geometry.samePoint(sa, a) && this.geometry.samePoint(sb, b)) return Match.Same;
    if (this.geometry.samePoint(sa, b) && this.geometry.samePoint(sb, a)) return Match.Reversed;
    return Match.None;
  }

  private grow(): void {
    const oldSlots = this.slots;
    const oldMeta = this.meta;
    this.capacity *= 2;
    this.mask = this.capacity - 1;
    this.slots = new Uint32Array(this.capacity);
    this.meta = new Uint8Array(this.capacity);
    this.peakBytes = Math.max(this.peakBytes, this.capacity * 5 + oldSlots.length * 5);
    for (let index = 0; index < oldSlots.length; index += 1) {
      const stored = oldSlots[index] ?? EMPTY;
      if (stored === EMPTY) continue;
      const directed = stored - 1;
      const a = this.geometry.startCorner(directed);
      const b = this.geometry.endCorner(directed);
      let slot = edgeHash(this.geometry.hash(a), this.geometry.hash(b)) & this.mask;
      while ((this.slots[slot] ?? EMPTY) !== EMPTY) slot = (slot + 1) & this.mask;
      this.slots[slot] = stored;
      this.meta[slot] = oldMeta[index] ?? 0;
    }
  }
}

const Match = { None: 0, Same: 1, Reversed: 2 } as const;
type Match = (typeof Match)[keyof typeof Match];

/** Exact-coordinate vertex ids for the BOUNDARY only. Sized by the boundary, never the part. */
class VertexTable {
  private readonly table: Int32Array;
  private readonly corners: Uint32Array;
  private readonly mask: number;
  public size = 0;
  private readonly geometry: CornerGeometry;

  public constructor(geometry: CornerGeometry, maxVertices: number) {
    this.geometry = geometry;
    const capacity = tableCapacityFor(Math.max(1, maxVertices));
    this.mask = capacity - 1;
    this.table = new Int32Array(capacity).fill(-1);
    this.corners = new Uint32Array(Math.max(1, maxVertices));
  }

  public insert(corner: number): number {
    let slot = this.geometry.hash(corner) & this.mask;
    for (;;) {
      const existing = this.table[slot] ?? -1;
      if (existing === -1) {
        const id = this.size;
        this.table[slot] = id;
        this.corners[id] = corner;
        this.size += 1;
        return id;
      }
      if (this.geometry.samePoint(this.corners[existing] ?? 0, corner)) return existing;
      slot = (slot + 1) & this.mask;
    }
  }

  public find(corner: number): number {
    let slot = this.geometry.hash(corner) & this.mask;
    for (;;) {
      const existing = this.table[slot] ?? -1;
      if (existing === -1) return -1;
      if (this.geometry.samePoint(this.corners[existing] ?? 0, corner)) return existing;
      slot = (slot + 1) & this.mask;
    }
  }

  public cornerOf(vertex: number): number {
    return this.corners[vertex] ?? 0;
  }
}

interface ComponentSignals {
  readonly nextVertex: Uint32Array;
  readonly inDegree: Uint32Array;
  readonly outDegree: Uint32Array;
  readonly degenerateAt: Uint8Array;
  readonly nonManifoldAt: Uint8Array;
  readonly orientationConflictAt: Uint8Array;
}

/** `extractBoundaryLoops`'s refusal order, unchanged. */
function componentRefusal(
  members: readonly number[],
  signals: ComponentSignals,
): BoundaryLoopRefusal | undefined {
  for (const v of members)
    if ((signals.degenerateAt[v] ?? 0) === 1) return BoundaryLoopRefusal.DegenerateSegment;
  for (const v of members)
    if ((signals.nonManifoldAt[v] ?? 0) === 1) return BoundaryLoopRefusal.NonManifoldAdjacency;
  for (const v of members)
    if ((signals.orientationConflictAt[v] ?? 0) === 1)
      return BoundaryLoopRefusal.AmbiguousOrientation;
  for (const v of members)
    if ((signals.outDegree[v] ?? 0) > 1) return BoundaryLoopRefusal.BranchedBoundary;
  for (const v of members)
    if ((signals.inDegree[v] ?? 0) > 1) return BoundaryLoopRefusal.ConvergentBoundary;
  for (const v of members) {
    if ((signals.nextVertex[v] ?? NOT_SET) === NOT_SET) return BoundaryLoopRefusal.NotClosed;
    if ((signals.inDegree[v] ?? 0) === 0) return BoundaryLoopRefusal.NotClosed;
  }
  return undefined;
}

function walkCycle(
  start: number,
  nextVertex: Uint32Array,
  incidentFace: Uint32Array,
  memberCount: number,
): { vertices: number[]; faces: number[]; refusal: BoundaryLoopRefusal | undefined } {
  const vertices: number[] = [];
  const faces: number[] = [];
  const seen = new Set<number>();
  let current = start;
  for (let step = 0; step <= memberCount; step += 1) {
    if (seen.has(current))
      return { vertices: [], faces: [], refusal: BoundaryLoopRefusal.RepeatedVertex };
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

/** Lexicographic comparison of two corners' exact coordinates. */
function compareCorners(geometry: CornerGeometry, a: number, b: number): number {
  for (let axis = 0; axis < 3; axis += 1) {
    const left = geometry.coordinate(a, axis);
    const right = geometry.coordinate(b, axis);
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Rotates a cycle to start at its lexicographically smallest coordinate, so the
 * same boundary produces the same ordering whatever face order the file used.
 * Direction is preserved: a reversed loop is a different orientation.
 */
function canonicalRotation(
  cycle: readonly number[],
  faces: readonly number[],
  vertices: VertexTable,
  geometry: CornerGeometry,
): { vertices: number[]; faces: number[]; corners: Uint32Array; points: Float64Array } {
  let smallest = 0;
  for (let index = 1; index < cycle.length; index += 1) {
    if (
      compareCorners(
        geometry,
        vertices.cornerOf(cycle[index] ?? 0),
        vertices.cornerOf(cycle[smallest] ?? 0),
      ) < 0
    ) {
      smallest = index;
    }
  }
  const rotated: number[] = [];
  const rotatedFaces: number[] = [];
  const corners = new Uint32Array(cycle.length);
  const points = new Float64Array(cycle.length * 3);
  for (let step = 0; step < cycle.length; step += 1) {
    const index = (smallest + step) % cycle.length;
    const vertex = cycle[index] ?? 0;
    const corner = vertices.cornerOf(vertex);
    rotated.push(vertex);
    rotatedFaces.push(faces[index] ?? 0);
    corners[step] = corner;
    points[step * 3] = geometry.coordinate(corner, 0);
    points[step * 3 + 1] = geometry.coordinate(corner, 1);
    points[step * 3 + 2] = geometry.coordinate(corner, 2);
  }
  return { vertices: rotated, faces: rotatedFaces, corners, points };
}

function sortedByCoordinate(
  members: readonly number[],
  vertices: VertexTable,
  geometry: CornerGeometry,
): number[] {
  return [...members].sort((a, b) =>
    compareCorners(geometry, vertices.cornerOf(a), vertices.cornerOf(b)),
  );
}

const hashBuffer = new ArrayBuffer(8);
const hashFloat = new Float64Array(hashBuffer);
const hashWords = new Uint32Array(hashBuffer);

/**
 * A 64-bit geometric identity over the ordered (or, for a refused component,
 * sorted) coordinates. Components are vertex-disjoint, so two components never
 * hash the same input; a caller that nonetheless meets a duplicate id refuses
 * both rather than choosing.
 */
function loopIdentity(
  ordered: readonly number[],
  vertices: VertexTable,
  geometry: CornerGeometry,
  eligible: boolean,
): string {
  let a = 0x811c9dc5;
  let b = eligible ? 0x01000193 : 0x2545f491;
  const push = (value: number): void => {
    a = Math.imul(a ^ (value >>> 0), 0x01000193) >>> 0;
    b = Math.imul(b ^ (value >>> 0), 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  };
  for (const vertex of ordered) {
    const corner = vertices.cornerOf(vertex);
    for (let axis = 0; axis < 3; axis += 1) {
      hashFloat[0] = geometry.coordinate(corner, axis);
      push(hashWords[0] ?? 0);
      push(hashWords[1] ?? 0);
    }
  }
  const high = (a ^ (a >>> 16)) >>> 0;
  const low = (b ^ (b >>> 16)) >>> 0;
  return `bx-${String(ordered.length)}-${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

/** Deterministic order: eligible loops by their first (smallest) point, then everything else by id. */
function compareLoops(left: ScannedLoop, right: ScannedLoop): number {
  if (left.points.length > 0 && right.points.length > 0) {
    for (let axis = 0; axis < 3; axis += 1) {
      const l = left.points[axis] ?? 0;
      const r = right.points[axis] ?? 0;
      if (l !== r) return l < r ? -1 : 1;
    }
  }
  if (left.points.length > 0 !== right.points.length > 0) return left.points.length > 0 ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
