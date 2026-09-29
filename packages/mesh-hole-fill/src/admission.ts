import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  BoundaryLoopRefusal,
  BoundaryScanStatus,
  type BoundaryScan,
  type ScannedLoop,
} from '@cadfixer/mesh-topology';
import { earClip, EarClipRefusal } from './ear-clip';
import { assessPlanarity, type LoopPoint } from './planarity';
import { HOLE_FILL_MAX_BOUNDARY_VERTICES } from './limits';

/**
 * AUTOMATIC BOUNDARY-FILL ADMISSION — REPAIR-CORE-02.
 *
 * Decides, for every boundary a compact scan found, whether Repair model may
 * attempt to close it — and if so, the exact patch it would add. PURE and
 * BOUNDED: every loop is at most `maxLoopVertices` points, at most
 * `maxLoopsPerCandidate` loops are admitted, and nothing here is proportional
 * to the part except the scan it is handed. It runs in the authoritative
 * geometry worker for exactly that reason; the exact intersection check, which
 * is not bounded by the loop, stays in the disposable worker.
 *
 * ADMISSION IS PER LOOP, NEVER "ALL". A loop is admitted only when it is
 * independently a simple closed cycle, relatively planar, triangulable without
 * adding a point, produces no degenerate triangle, and adds no edge the part
 * already has. Two admitted loops must not be able to interact: if their
 * bounding boxes touch, the later one is deferred rather than batched, so
 * patch order can never decide topology. What is not admitted is reported with
 * its reason and left exactly as it is.
 *
 * NO TOLERANCE, NO NEW POINT, NO MOVED POINT. A patch triangle references three
 * of the loop's own corners; the planarity ratio is the engine's existing
 * dimensionless eligibility rule (ADR 0018), not a distance.
 */

export const BoundaryFillVerdict = {
  Admitted: 'ADMITTED',
  /** Branches, converges, does not close, or revisits a vertex. */
  NotSimple: 'NOT_SIMPLE',
  NonManifoldBoundary: 'NON_MANIFOLD_BOUNDARY',
  AmbiguousOrientation: 'AMBIGUOUS_ORIENTATION',
  DegenerateBoundary: 'DEGENERATE_BOUNDARY',
  TooManyVertices: 'TOO_MANY_VERTICES',
  NonPlanar: 'NON_PLANAR',
  NoTriangulation: 'NO_TRIANGULATION',
  DegeneratePatch: 'DEGENERATE_PATCH',
  /** A patch diagonal would reuse an edge the part already has. */
  EdgeAlreadyExists: 'EDGE_ALREADY_EXISTS',
  /** The patch would coincide with an existing triangle. */
  DuplicatesExistingFace: 'DUPLICATES_EXISTING_FACE',
  /** Its bounds touch an opening admitted before it; left for a later repair. */
  InteractsWithAnotherOpening: 'INTERACTS_WITH_ANOTHER_OPENING',
  /** The per-repair batch limits were reached; left for a later repair. */
  BatchLimit: 'BATCH_LIMIT',
  /** Two loops produced the same identity; neither is filled. */
  AmbiguousIdentity: 'AMBIGUOUS_IDENTITY',
  /* ---- set after admission, by the local intersection check ---- */
  /** The patch would pass through or overlap existing geometry. */
  WouldIntersect: 'WOULD_INTERSECT',
  /** The exact check could not classify every pair, or hit its budget. */
  NotVerifiable: 'NOT_VERIFIABLE',
  /** Too many existing triangles surround it to check within the limits. */
  RegionTooLarge: 'REGION_TOO_LARGE',
} as const;

export type BoundaryFillVerdict = (typeof BoundaryFillVerdict)[keyof typeof BoundaryFillVerdict];

export interface BoundaryFillLimits {
  /** Points in one loop. The engine's qualified ceiling. */
  readonly maxLoopVertices: number;
  /** Loops one repair candidate may close. */
  readonly maxLoopsPerCandidate: number;
  /** Rim points across every loop of one candidate. */
  readonly maxTotalBoundaryVertices: number;
  /** Boundary edges above which the scan assembles no loop at all. */
  readonly maxBoundaryEdges: number;
  /** Existing triangles the local intersection check may examine, in total. */
  readonly maxLocalFaces: number;
}

/**
 * The production limits. Each is justified in
 * `docs/design/REPAIR_CORE_02.md` from measurement; changing one needs the
 * scale qualification re-run, not an argument.
 */
export const DEFAULT_BOUNDARY_FILL_LIMITS: BoundaryFillLimits = Object.freeze({
  maxLoopVertices: HOLE_FILL_MAX_BOUNDARY_VERTICES,
  maxLoopsPerCandidate: 64,
  maxTotalBoundaryVertices: 4_096,
  maxBoundaryEdges: 100_000,
  // The narrowphase workload the per-opening engine was qualified at: the
  // local region of all admitted loops together is never larger than the whole
  // part that engine accepted.
  maxLocalFaces: 250_000,
});

/** Narrowing only: a caller can make admission stricter, never looser. */
export function narrowBoundaryFillLimits(
  requested: Partial<BoundaryFillLimits> | undefined,
): BoundaryFillLimits {
  const base = DEFAULT_BOUNDARY_FILL_LIMITS;
  const pick = (key: keyof BoundaryFillLimits): number => {
    const value = requested?.[key];
    return value === undefined || !Number.isFinite(value) || value < 0
      ? base[key]
      : Math.min(base[key], Math.floor(value));
  };
  return {
    maxLoopVertices: pick('maxLoopVertices'),
    maxLoopsPerCandidate: pick('maxLoopsPerCandidate'),
    maxTotalBoundaryVertices: pick('maxTotalBoundaryVertices'),
    maxBoundaryEdges: pick('maxBoundaryEdges'),
    maxLocalFaces: pick('maxLocalFaces'),
  };
}

export interface AdmittedLoop {
  readonly id: string;
  readonly vertexCount: number;
  /** Patch triangles as CORNER indices into the scanned mesh, three per face. */
  readonly patch: Uint32Array;
  readonly patchFaceCount: number;
  /** Sum of patch triangle areas, by the topology engine's own formula. */
  readonly patchArea: number;
  /** Axis-aligned bounds of the loop (and therefore of its patch), Float64. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface LoopDecision {
  readonly id: string;
  readonly vertexCount: number;
  readonly verdict: BoundaryFillVerdict;
}

export interface BoundaryFillAdmission {
  readonly admitted: readonly AdmittedLoop[];
  /** Every loop the scan found, admitted or not, in the scan's order. */
  readonly decisions: readonly LoopDecision[];
}

/**
 * Admits loops from a scan of `mesh`. `mesh` must be the mesh that was scanned.
 */
export function admitBoundaryLoops(
  mesh: CanonicalMesh,
  scan: BoundaryScan,
  limitsRequest?: Partial<BoundaryFillLimits>,
): BoundaryFillAdmission {
  const limits = narrowBoundaryFillLimits(limitsRequest);
  if (scan.status !== BoundaryScanStatus.Scanned) return { admitted: [], decisions: [] };

  const idCounts = new Map<string, number>();
  for (const loop of scan.loops) idCounts.set(loop.id, (idCounts.get(loop.id) ?? 0) + 1);

  const admitted: AdmittedLoop[] = [];
  const decisions: LoopDecision[] = [];
  let totalVertices = 0;

  for (const loop of scan.loops) {
    const decide = (verdict: BoundaryFillVerdict): void => {
      decisions.push({ id: loop.id, vertexCount: loop.vertexCount, verdict });
    };

    if ((idCounts.get(loop.id) ?? 0) > 1) {
      decide(BoundaryFillVerdict.AmbiguousIdentity);
      continue;
    }
    if (loop.refusal !== undefined) {
      decide(verdictForRefusal(loop.refusal));
      continue;
    }
    if (loop.vertexCount > limits.maxLoopVertices) {
      decide(BoundaryFillVerdict.TooManyVertices);
      continue;
    }

    const candidate = buildPatch(mesh, scan, loop);
    if (candidate.verdict !== BoundaryFillVerdict.Admitted) {
      decide(candidate.verdict);
      continue;
    }

    // Independence: a later loop whose box touches an admitted one waits.
    // Inclusive overlap, so touching counts as interacting.
    if (admitted.some((other) => boxesTouch(other, candidate.loop))) {
      decide(BoundaryFillVerdict.InteractsWithAnotherOpening);
      continue;
    }
    if (
      admitted.length + 1 > limits.maxLoopsPerCandidate ||
      totalVertices + loop.vertexCount > limits.maxTotalBoundaryVertices
    ) {
      decide(BoundaryFillVerdict.BatchLimit);
      continue;
    }

    admitted.push(candidate.loop);
    totalVertices += loop.vertexCount;
    decide(BoundaryFillVerdict.Admitted);
  }

  return { admitted, decisions };
}

function verdictForRefusal(refusal: BoundaryLoopRefusal): BoundaryFillVerdict {
  switch (refusal) {
    case BoundaryLoopRefusal.BranchedBoundary:
    case BoundaryLoopRefusal.ConvergentBoundary:
    case BoundaryLoopRefusal.NotClosed:
    case BoundaryLoopRefusal.RepeatedVertex:
      return BoundaryFillVerdict.NotSimple;
    case BoundaryLoopRefusal.NonManifoldAdjacency:
      return BoundaryFillVerdict.NonManifoldBoundary;
    case BoundaryLoopRefusal.AmbiguousOrientation:
      return BoundaryFillVerdict.AmbiguousOrientation;
    case BoundaryLoopRefusal.DegenerateSegment:
    case BoundaryLoopRefusal.TooFewVertices:
    case BoundaryLoopRefusal.NonFinite:
      return BoundaryFillVerdict.DegenerateBoundary;
    case BoundaryLoopRefusal.TooManyVertices:
      return BoundaryFillVerdict.TooManyVertices;
  }
}

type PatchResult =
  | { readonly verdict: typeof BoundaryFillVerdict.Admitted; readonly loop: AdmittedLoop }
  | { readonly verdict: Exclude<BoundaryFillVerdict, typeof BoundaryFillVerdict.Admitted> };

/**
 * Planarity, triangulation and every check that needs only the loop and the
 * edge table. Nothing here reads a face outside the loop's own rim.
 */
function buildPatch(mesh: CanonicalMesh, scan: BoundaryScan, loop: ScannedLoop): PatchResult {
  const n = loop.vertexCount;
  const points: LoopPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    points.push([
      loop.points[i * 3] ?? 0,
      loop.points[i * 3 + 1] ?? 0,
      loop.points[i * 3 + 2] ?? 0,
    ]);
  }

  const planarity = assessPlanarity(points);
  if (planarity.degenerate) return { verdict: BoundaryFillVerdict.DegenerateBoundary };
  if (!planarity.planar) return { verdict: BoundaryFillVerdict.NonPlanar };

  const clipped = earClip(points, planarity.normal ?? [0, 0, 1]);
  if (clipped.refusal !== undefined) {
    return {
      verdict:
        clipped.refusal === EarClipRefusal.NoEarFound
          ? BoundaryFillVerdict.NoTriangulation
          : BoundaryFillVerdict.DegenerateBoundary,
    };
  }
  // Structural properties of ear clipping; a violation is a broken
  // triangulator, and nothing broken is admitted.
  if (clipped.triangles.length !== n - 2 || clipped.addedVertices !== 0) {
    return { verdict: BoundaryFillVerdict.NoTriangulation };
  }

  // A triangle loop whose three rim edges belong to ONE face would add that
  // face's reverse: a zero-thickness double, not a closure.
  if (n === 3) {
    const f0 = loop.incidentFaces[0];
    if (f0 === loop.incidentFaces[1] && f0 === loop.incidentFaces[2]) {
      return { verdict: BoundaryFillVerdict.DuplicatesExistingFace };
    }
  }

  const patch = new Uint32Array((n - 2) * 3);
  let patchArea = 0;
  const rimUses = new Uint8Array(n);
  const diagonals = new Map<string, number>();

  for (const [index, triangle] of clipped.triangles.entries()) {
    const [i, j, k] = triangle;
    const ca = loop.corners[i] ?? 0;
    const cb = loop.corners[j] ?? 0;
    const cc = loop.corners[k] ?? 0;
    patch[index * 3] = ca;
    patch[index * 3 + 1] = cb;
    patch[index * 3 + 2] = cc;

    // The topology engine's zero-area rule and area formula, verbatim: first
    // corner as origin, float64, exact comparison with zero.
    const area = triangleArea(mesh, ca, cb, cc);
    if (area === 0) return { verdict: BoundaryFillVerdict.DegeneratePatch };
    patchArea += area;

    for (const [from, to] of [
      [i, j],
      [j, k],
      [k, i],
    ] as const) {
      if ((from + 1) % n === to) {
        // A rim edge, traversed in loop order — the direction the absent face
        // takes. Each rim edge must be used exactly once.
        rimUses[from] = (rimUses[from] ?? 0) + 1;
        continue;
      }
      if ((to + 1) % n === from) {
        // A rim edge traversed AGAINST the loop: the patch would face the same
        // way as the rim face, a winding conflict.
        return { verdict: BoundaryFillVerdict.NoTriangulation };
      }
      // A diagonal. It must be new to the part, and used exactly twice by the
      // patch, once each way.
      if (scan.edges.incidence(loop.corners[from] ?? 0, loop.corners[to] ?? 0) !== 0) {
        return { verdict: BoundaryFillVerdict.EdgeAlreadyExists };
      }
      const key = from < to ? `${String(from)}:${String(to)}` : `${String(to)}:${String(from)}`;
      diagonals.set(key, (diagonals.get(key) ?? 0) + (from < to ? 1 : 16));
    }
  }
  for (const uses of rimUses) {
    if (uses !== 1) return { verdict: BoundaryFillVerdict.NoTriangulation };
  }
  for (const pattern of diagonals.values()) {
    // Once in each direction: 1 + 16.
    if (pattern !== 17) return { verdict: BoundaryFillVerdict.NoTriangulation };
  }
  if (diagonals.size !== n - 3) return { verdict: BoundaryFillVerdict.NoTriangulation };

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = point[axis] ?? 0;
      if (value < (min[axis] ?? Infinity)) min[axis] = value;
      if (value > (max[axis] ?? -Infinity)) max[axis] = value;
    }
  }

  return {
    verdict: BoundaryFillVerdict.Admitted,
    loop: { id: loop.id, vertexCount: n, patch, patchFaceCount: n - 2, patchArea, min, max },
  };
}

/** The topology engine's per-face area, first corner as origin. */
export function triangleArea(mesh: CanonicalMesh, a: number, b: number, c: number): number {
  const p = mesh.positions;
  const ax = p[a * 3] ?? 0;
  const ay = p[a * 3 + 1] ?? 0;
  const az = p[a * 3 + 2] ?? 0;
  const e1x = (p[b * 3] ?? 0) - ax;
  const e1y = (p[b * 3 + 1] ?? 0) - ay;
  const e1z = (p[b * 3 + 2] ?? 0) - az;
  const e2x = (p[c * 3] ?? 0) - ax;
  const e2y = (p[c * 3 + 1] ?? 0) - ay;
  const e2z = (p[c * 3 + 2] ?? 0) - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  if (nx === 0 && ny === 0 && nz === 0) return 0;
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
}

function boxesTouch(a: AdmittedLoop, b: AdmittedLoop): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if ((a.max[axis] ?? 0) < (b.min[axis] ?? 0) || (b.max[axis] ?? 0) < (a.min[axis] ?? 0)) {
      return false;
    }
  }
  return true;
}
