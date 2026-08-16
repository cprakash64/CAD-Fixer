import type { CanonicalMesh } from '@cadfixer/mesh-core';

/**
 * EVALUATION-ONLY bounding volume hierarchy over a triangle soup.
 *
 * RESEARCH ONLY. This package is never imported by `apps/**` or by any worker,
 * and a test asserts that. This is deliberately NOT a production geometry
 * structure: it exists so the surface-distance evaluator can answer nearest-
 * triangle queries without an O(samples x triangles) scan, and it stops there.
 * No refit, no update, no ray casting, no traversal order tuning. When
 * production needs spatial acceleration it will get one designed for that job.
 *
 * DETERMINISM IS THE POINT. A preservation metric that varied run to run could
 * not distinguish "the kernel changed the model" from "the metric wobbled", so
 * every choice here is reproducible: the split axis comes from the node's own
 * extent, the split position is the median of an explicitly ordered array, and
 * every comparator breaks ties on triangle index so no two builds can disagree.
 *
 * TYPED ARRAYS, NOT OBJECTS. One object per node would allocate ~10 objects per
 * 8 triangles and make a large evaluation mesh a GC problem. Nodes are flat
 * arrays with a fixed stride.
 */

/** Triangles per leaf. Small enough to prune well, large enough to stay flat. */
const LEAF_SIZE = 4;

const NODE_STRIDE = 6;

export interface TriangleBvh {
  /** Triangle ids, permuted so each leaf owns a contiguous run. */
  readonly order: Uint32Array;
  /** min/max per node, 6 doubles each. */
  readonly bounds: Float64Array;
  /** Left child index for an internal node, first `order` offset for a leaf. */
  readonly leftOrFirst: Int32Array;
  /** 0 for an internal node, triangle count for a leaf. */
  readonly count: Int32Array;
  readonly nodeCount: number;
  /** Flat triangle corners, 9 doubles per triangle, in ORIGINAL triangle order. */
  readonly corners: Float64Array;
  readonly triangleCount: number;
}

/**
 * Flattens a canonical mesh into 9 doubles per triangle.
 *
 * Float64 throughout: this is measurement code, and narrowing to Float32 here
 * would put the metric's own error on the same order as the differences it is
 * meant to detect on a small model.
 */
export function flattenTriangles(mesh: CanonicalMesh): Float64Array {
  const triangles = Math.floor(mesh.indices.length / 3);
  const corners = new Float64Array(triangles * 9);
  for (let t = 0; t < triangles; t += 1) {
    for (let c = 0; c < 3; c += 1) {
      const vertex = mesh.indices[t * 3 + c] ?? 0;
      corners[t * 9 + c * 3] = mesh.positions[vertex * 3] ?? 0;
      corners[t * 9 + c * 3 + 1] = mesh.positions[vertex * 3 + 1] ?? 0;
      corners[t * 9 + c * 3 + 2] = mesh.positions[vertex * 3 + 2] ?? 0;
    }
  }
  return corners;
}

export function buildTriangleBvh(corners: Float64Array): TriangleBvh {
  const triangleCount = Math.floor(corners.length / 9);

  /*
   * NODE CAPACITY. Splitting happens only while a node holds more than
   * LEAF_SIZE triangles, so a split sees at least LEAF_SIZE+1 = 5 and gives
   * children of at least 2. Leaves therefore hold >= 2 triangles (except the
   * single-triangle mesh), giving at most floor(N/2) leaves and at most
   * 2*floor(N/2)-1 <= N nodes. N+2 is that bound with slack.
   *
   * The obvious 2*ceil(N/LEAF_SIZE) is WRONG and was a real defect here: median
   * splitting does not fill leaves to LEAF_SIZE, so 200 triangles wanted ~133
   * nodes against a 100-node allocation. Typed arrays ignore out-of-range
   * writes silently, so the overflowing nodes read back as count 0 and
   * leftOrFirst 0 — an "internal node" whose left child is the root. Queries
   * then looped forever. Allocating up front also keeps node indices
   * independent of allocation history, which determinism depends on.
   */
  const maxNodes = Math.max(1, triangleCount + 2);
  const bounds = new Float64Array(maxNodes * NODE_STRIDE);
  const leftOrFirst = new Int32Array(maxNodes);
  const count = new Int32Array(maxNodes);
  const order = new Uint32Array(triangleCount);
  for (let t = 0; t < triangleCount; t += 1) order[t] = t;

  const centroids = new Float64Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const a = corners[t * 9 + axis] ?? 0;
      const b = corners[t * 9 + 3 + axis] ?? 0;
      const c = corners[t * 9 + 6 + axis] ?? 0;
      centroids[t * 3 + axis] = (a + b + c) / 3;
    }
  }

  const setBounds = (node: number, first: number, length: number): void => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = first; i < first + length; i += 1) {
      const t = order[i] ?? 0;
      for (let c = 0; c < 3; c += 1) {
        const x = corners[t * 9 + c * 3] ?? 0;
        const y = corners[t * 9 + c * 3 + 1] ?? 0;
        const z = corners[t * 9 + c * 3 + 2] ?? 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    bounds[node * NODE_STRIDE] = minX;
    bounds[node * NODE_STRIDE + 1] = minY;
    bounds[node * NODE_STRIDE + 2] = minZ;
    bounds[node * NODE_STRIDE + 3] = maxX;
    bounds[node * NODE_STRIDE + 4] = maxY;
    bounds[node * NODE_STRIDE + 5] = maxZ;
  };

  if (triangleCount === 0) {
    // An empty hierarchy is a legitimate input (an empty candidate output), so
    // it gets one empty leaf rather than an exception. Queries against it
    // return Infinity, which the caller reports rather than silently treating
    // as zero distance.
    bounds.fill(0, 0, NODE_STRIDE);
    leftOrFirst[0] = 0;
    count[0] = 0;
    return { order, bounds, leftOrFirst, count, nodeCount: 1, corners, triangleCount };
  }

  setBounds(0, 0, triangleCount);
  leftOrFirst[0] = 0;
  count[0] = triangleCount;

  let nodeCount = 1;
  // Explicit stack: a degenerate split chain could otherwise recurse as deep as
  // the triangle count.
  const stack: number[] = [0];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    const length = count[node] ?? 0;
    if (length <= LEAF_SIZE) continue;
    const first = leftOrFirst[node] ?? 0;

    const extentX = (bounds[node * NODE_STRIDE + 3] ?? 0) - (bounds[node * NODE_STRIDE] ?? 0);
    const extentY = (bounds[node * NODE_STRIDE + 4] ?? 0) - (bounds[node * NODE_STRIDE + 1] ?? 0);
    const extentZ = (bounds[node * NODE_STRIDE + 5] ?? 0) - (bounds[node * NODE_STRIDE + 2] ?? 0);
    let axis = 0;
    if (extentY > extentX && extentY >= extentZ) axis = 1;
    else if (extentZ > extentX && extentZ > extentY) axis = 2;

    // Sorted, not partitioned around a pivot. Median-of-sorted is the same for
    // every build of the same input; a quickselect partition is not, because
    // its result depends on pivot choice among equal keys. The tie-break on
    // triangle id makes the order total even when centroids coincide, which is
    // exactly what a coplanar or duplicated fixture produces.
    const slice = Array.from(order.subarray(first, first + length));
    slice.sort((left, right) => {
      const a = centroids[left * 3 + axis] ?? 0;
      const b = centroids[right * 3 + axis] ?? 0;
      if (a < b) return -1;
      if (a > b) return 1;
      return left - right;
    });
    order.set(slice, first);

    const half = length >> 1;
    // Loud rather than silent. A typed array drops out-of-range writes without
    // complaint, and the resulting hierarchy hangs the query instead of
    // reporting a problem — so the invariant is checked, not assumed.
    if (nodeCount + 2 > maxNodes) {
      throw new Error(
        `BVH node capacity exceeded: ${String(nodeCount + 2)} > ${String(maxNodes)} for ${String(triangleCount)} triangles`,
      );
    }
    const leftNode = nodeCount;
    const rightNode = nodeCount + 1;
    nodeCount += 2;

    leftOrFirst[leftNode] = first;
    count[leftNode] = half;
    setBounds(leftNode, first, half);

    leftOrFirst[rightNode] = first + half;
    count[rightNode] = length - half;
    setBounds(rightNode, first + half, length - half);

    leftOrFirst[node] = leftNode;
    count[node] = 0;

    stack.push(leftNode, rightNode);
  }

  return { order, bounds, leftOrFirst, count, nodeCount, corners, triangleCount };
}

/**
 * Squared distance from a point to the closest point on a triangle.
 *
 * The standard Voronoi-region solution (Ericson, Real-Time Collision
 * Detection): classify the point against the triangle's vertex, edge and face
 * regions and clamp barycentric coordinates accordingly. Written out rather
 * than projected-and-clamped because the naive version is wrong precisely at
 * the edges and corners, which is where a repaired seam puts its samples.
 *
 * DEGENERATE TARGETS ARE HANDLED, not assumed away. The corpus contains
 * zero-area and repeated-position faces on purpose, and a candidate may emit
 * more. When the triangle has no area the region tests divide by zero, so the
 * denominators are checked and the function falls back to the closest point on
 * the three edges — which is the correct answer for a sliver or a segment.
 */
export function pointTriangleDistanceSquared(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const denominator = d1 - d3;
    const v = denominator !== 0 ? d1 / denominator : 0;
    const qx = ax + abx * v - px;
    const qy = ay + aby * v - py;
    const qz = az + abz * v - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const denominator = d2 - d6;
    const w = denominator !== 0 ? d2 / denominator : 0;
    const qx = ax + acx * w - px;
    const qy = ay + acy * w - py;
    const qz = az + acz * w - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const denominator = d4 - d3 + (d5 - d6);
    const w = denominator !== 0 ? (d4 - d3) / denominator : 0;
    const qx = bx + (cx - bx) * w - px;
    const qy = by + (cy - by) * w - py;
    const qz = bz + (cz - bz) * w - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  const denominator = va + vb + vc;
  if (denominator === 0) {
    // Zero area: every region test degenerated. The closest point lies on an
    // edge, so take the best of the three rather than returning a wrong face
    // projection.
    return Math.min(
      segmentDistanceSquared(px, py, pz, ax, ay, az, bx, by, bz),
      segmentDistanceSquared(px, py, pz, bx, by, bz, cx, cy, cz),
      segmentDistanceSquared(px, py, pz, cx, cy, cz, ax, ay, az),
    );
  }

  const v = vb / denominator;
  const w = vc / denominator;
  const qx = ax + abx * v + acx * w - px;
  const qy = ay + aby * v + acy * w - py;
  const qz = az + abz * v + acz * w - pz;
  return qx * qx + qy * qy + qz * qz;
}

function segmentDistanceSquared(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const lengthSquared = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / lengthSquared;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const qx = ax + abx * t - px;
  const qy = ay + aby * t - py;
  const qz = az + abz * t - pz;
  return qx * qx + qy * qy + qz * qz;
}

function boxDistanceSquared(
  bounds: Float64Array,
  node: number,
  px: number,
  py: number,
  pz: number,
): number {
  const minX = bounds[node * NODE_STRIDE] ?? 0;
  const minY = bounds[node * NODE_STRIDE + 1] ?? 0;
  const minZ = bounds[node * NODE_STRIDE + 2] ?? 0;
  const maxX = bounds[node * NODE_STRIDE + 3] ?? 0;
  const maxY = bounds[node * NODE_STRIDE + 4] ?? 0;
  const maxZ = bounds[node * NODE_STRIDE + 5] ?? 0;
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
  const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0;
  const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Squared distance from a point to the nearest triangle in the hierarchy.
 *
 * Returns `Infinity` for an empty hierarchy — the honest answer, and one the
 * caller must decide about rather than receive as a silent 0.
 *
 * Iterative, with a nearest-child-first order and a pruning test against the
 * running best. Traversal order affects only how much is pruned, never the
 * result: the returned value is the exact minimum over all triangles.
 */
export function nearestTriangleDistanceSquared(
  bvh: TriangleBvh,
  px: number,
  py: number,
  pz: number,
): number {
  if (bvh.triangleCount === 0) return Number.POSITIVE_INFINITY;

  let best = Number.POSITIVE_INFINITY;
  const stack: number[] = [0];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (boxDistanceSquared(bvh.bounds, node, px, py, pz) >= best) continue;

    const length = bvh.count[node] ?? 0;
    if (length > 0) {
      const first = bvh.leftOrFirst[node] ?? 0;
      for (let i = first; i < first + length; i += 1) {
        const t = bvh.order[i] ?? 0;
        const distance = pointTriangleDistanceSquared(
          px,
          py,
          pz,
          bvh.corners[t * 9] ?? 0,
          bvh.corners[t * 9 + 1] ?? 0,
          bvh.corners[t * 9 + 2] ?? 0,
          bvh.corners[t * 9 + 3] ?? 0,
          bvh.corners[t * 9 + 4] ?? 0,
          bvh.corners[t * 9 + 5] ?? 0,
          bvh.corners[t * 9 + 6] ?? 0,
          bvh.corners[t * 9 + 7] ?? 0,
          bvh.corners[t * 9 + 8] ?? 0,
        );
        if (distance < best) best = distance;
      }
      continue;
    }

    const left = bvh.leftOrFirst[node] ?? 0;
    const right = left + 1;
    const leftDistance = boxDistanceSquared(bvh.bounds, left, px, py, pz);
    const rightDistance = boxDistanceSquared(bvh.bounds, right, px, py, pz);
    // Farther child pushed first, so the nearer one pops first and raises the
    // pruning bound sooner.
    if (leftDistance <= rightDistance) stack.push(right, left);
    else stack.push(left, right);
  }

  return best;
}

/**
 * Brute-force nearest distance. TEST ORACLE ONLY.
 *
 * Exported so the BVH can be checked against it on small fixtures. It is
 * deliberately O(triangles) per query: if the accelerated path ever disagrees
 * with this, the acceleration is fabricating preservation evidence, which is
 * the specific failure this pair exists to catch. Never call it on a real
 * evaluation workload.
 */
export function bruteForceNearestDistanceSquared(
  corners: Float64Array,
  px: number,
  py: number,
  pz: number,
): number {
  const triangles = Math.floor(corners.length / 9);
  if (triangles === 0) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let t = 0; t < triangles; t += 1) {
    const distance = pointTriangleDistanceSquared(
      px,
      py,
      pz,
      corners[t * 9] ?? 0,
      corners[t * 9 + 1] ?? 0,
      corners[t * 9 + 2] ?? 0,
      corners[t * 9 + 3] ?? 0,
      corners[t * 9 + 4] ?? 0,
      corners[t * 9 + 5] ?? 0,
      corners[t * 9 + 6] ?? 0,
      corners[t * 9 + 7] ?? 0,
      corners[t * 9 + 8] ?? 0,
    );
    if (distance < best) best = distance;
  }
  return best;
}
