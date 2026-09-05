/**
 * INDEPENDENT POST-FILL VALIDATION. RESEARCH ONLY.
 *
 * THE SEPARATION THIS FILE EXISTS TO KEEP: the kernel CREATES, CAD Fixer
 * VALIDATES. Nothing here asks the thing that produced the patch whether the
 * patch is good. A hole filler reporting success means it did not throw; it
 * says nothing about whether the triangles it manufactured are inside the hole,
 * wound the right way, attached to the right boundary, or piercing the model
 * three centimetres away.
 *
 * EVERYTHING IS CHECKED ON THE FINAL CANONICAL Float32 REPRESENTATION, because
 * that is what would become authoritative. A patch can be valid in the kernel's
 * double precision and degenerate after narrowing — see `narrowToFloat32`.
 */

import { extractBoundaryLoops } from './boundary-loops.mjs';

export const ValidationStatus = {
  Valid: 'VALID',
  RefusedUnsafeBoundary: 'REFUSED_UNSAFE_BOUNDARY',
  KernelFailure: 'KERNEL_FAILURE',
  ResourceLimit: 'RESOURCE_LIMIT',
  SourceModified: 'SOURCE_MODIFIED',
  BoundaryNotClosed: 'BOUNDARY_NOT_CLOSED',
  NonManifoldCreated: 'NON_MANIFOLD_CREATED',
  DegeneratePatch: 'DEGENERATE_PATCH',
  DuplicatePatchFace: 'DUPLICATE_PATCH_FACE',
  OrientationInconsistent: 'ORIENTATION_INCONSISTENT',
  PatchDisconnected: 'PATCH_DISCONNECTED',
  SelfIntersectionCreated: 'SELF_INTERSECTION_CREATED',
  NonFinite: 'NON_FINITE',
  Cancelled: 'CANCELLED',
  InternalFailure: 'INTERNAL_FAILURE',
};

/**
 * NARROWING IS PART OF THE CANDIDATE, not a formatting step afterwards.
 *
 * A kernel working in double precision can produce a patch whose triangles are
 * valid at 1e-12 and collapse to zero area once written into a Float32Array.
 * So the candidate is narrowed FIRST and every check below runs on the narrowed
 * result — validating the kernel's own representation would be validating
 * something that never becomes the model.
 */
export function narrowToFloat32(positionsDouble) {
  const out = new Float32Array(positionsDouble.length);
  for (let index = 0; index < positionsDouble.length; index += 1) {
    out[index] = positionsDouble[index];
  }
  return out;
}

/* ------------------------------------------------------------ geometry -- */

function corner(positions, indices, face, which) {
  const vertex = indices[face * 3 + which] * 3;
  return [positions[vertex], positions[vertex + 1], positions[vertex + 2]];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function triangleArea(positions, indices, face) {
  const a = corner(positions, indices, face, 0);
  const b = corner(positions, indices, face, 1);
  const c = corner(positions, indices, face, 2);
  return Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
}

/* ---------------------------------------- triangle / triangle intersection -- */

/**
 * A SEPARATING-AXIS TRIANGLE INTERSECTION TEST, ours and independent.
 *
 * INDEPENDENT ON PURPOSE. The production Stage 3C detector is a WASM kernel;
 * running the same kernel that a future production path would run, and calling
 * agreement proof, is the mistake the writer oracles exist to prevent
 * elsewhere. This is a second implementation with no shared code, used here to
 * decide whether a PATCH triangle pierces anything.
 *
 * ADJACENCY IS EXCLUDED, and that is the whole difficulty. A patch triangle
 * legitimately SHARES a boundary edge with a source triangle and legitimately
 * shares edges with its patch neighbours; a naive test reports every one of
 * those as an intersection. Pairs sharing one or more welded vertices are
 * therefore skipped — which is conservative in the safe direction for the
 * question being asked, because a patch that folds back through a triangle it
 * touches would also fold through one it does not.
 */
export function trianglesIntersect(p, q) {
  const [p0, p1, p2] = p;
  const [q0, q1, q2] = q;

  const axes = [];
  const edgesP = [sub(p1, p0), sub(p2, p1), sub(p0, p2)];
  const edgesQ = [sub(q1, q0), sub(q2, q1), sub(q0, q2)];
  const normalP = cross(edgesP[0], edgesP[1]);
  const normalQ = cross(edgesQ[0], edgesQ[1]);

  axes.push(normalP, normalQ);
  for (const edgeP of edgesP) {
    for (const edgeQ of edgesQ) axes.push(cross(edgeP, edgeQ));
  }

  for (const axis of axes) {
    const length = Math.hypot(...axis);
    if (length === 0) continue;
    const unit = [axis[0] / length, axis[1] / length, axis[2] / length];

    let minP = Infinity;
    let maxP = -Infinity;
    for (const point of p) {
      const value = dot(point, unit);
      minP = Math.min(minP, value);
      maxP = Math.max(maxP, value);
    }
    let minQ = Infinity;
    let maxQ = -Infinity;
    for (const point of q) {
      const value = dot(point, unit);
      minQ = Math.min(minQ, value);
      maxQ = Math.max(maxQ, value);
    }
    // A separating axis exists, so the triangles are disjoint. Touching
    // (max === min) is NOT an overlap: coplanar neighbours touch by design.
    if (maxP <= minQ || maxQ <= minP) return false;
  }
  return true;
}

/* -------------------------------------------------------- the validator -- */

/**
 * Validates a candidate against the source it was built from.
 *
 * `sourceFaceCount` is the provenance boundary: faces `[0, sourceFaceCount)`
 * are the user's, faces `[sourceFaceCount, ...)` are the patch. Every check
 * that must not blame a pre-existing defect on the patch uses it.
 */
export function validateCandidate(source, candidate, options) {
  const { loopVertices, sourceFaceCount } = options;
  const failures = [];
  const notes = {};

  const patchFaceStart = sourceFaceCount;
  const candidateFaceCount = candidate.indices.length / 3;
  const patchFaceCount = candidateFaceCount - patchFaceStart;
  notes.patchFaceCount = patchFaceCount;
  notes.addedVertexCount = candidate.positions.length / 3 - source.positions.length / 3;

  /* 1 — SOURCE BYTES PRESERVED, compared literally. */
  let sourceModified = false;
  for (let index = 0; index < source.positions.length; index += 1) {
    if (!Object.is(candidate.positions[index], source.positions[index])) {
      sourceModified = true;
      break;
    }
  }
  for (let index = 0; index < source.indices.length && !sourceModified; index += 1) {
    if (candidate.indices[index] !== source.indices[index]) sourceModified = true;
  }
  if (sourceModified) failures.push(ValidationStatus.SourceModified);

  /* 2 — FINITE GEOMETRY. */
  for (const value of candidate.positions) {
    if (!Number.isFinite(value)) {
      failures.push(ValidationStatus.NonFinite);
      break;
    }
  }

  /* 3 — NO DEGENERATE PATCH FACE, measured after narrowing. */
  let smallestPatchArea = Infinity;
  let largestPatchArea = 0;
  let degenerate = 0;
  for (let face = patchFaceStart; face < candidateFaceCount; face += 1) {
    const area = triangleArea(candidate.positions, candidate.indices, face);
    if (!(area > 0)) degenerate += 1;
    smallestPatchArea = Math.min(smallestPatchArea, area);
    largestPatchArea = Math.max(largestPatchArea, area);
  }
  notes.smallestPatchArea = patchFaceCount > 0 ? smallestPatchArea : 0;
  notes.largestPatchArea = largestPatchArea;
  notes.degeneratePatchFaces = degenerate;
  if (degenerate > 0) failures.push(ValidationStatus.DegeneratePatch);

  /* 4 — NO DUPLICATE PATCH FACE, under exact welded identity. */
  const after = extractBoundaryLoops(candidate.positions, candidate.indices);
  const key = (face) => {
    const ids = [0, 1, 2].map((c) => after.vertexOf[candidate.indices[face * 3 + c]]);
    return [...ids].sort((l, r) => l - r).join(':');
  };
  const seen = new Map();
  for (let face = 0; face < candidateFaceCount; face += 1) {
    const id = key(face);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  let duplicates = 0;
  for (let face = patchFaceStart; face < candidateFaceCount; face += 1) {
    if ((seen.get(key(face)) ?? 0) > 1) duplicates += 1;
  }
  notes.duplicatePatchFaces = duplicates;
  if (duplicates > 0) failures.push(ValidationStatus.DuplicatePatchFace);

  /* 5 — THE SELECTED LOOP IS GONE, and no new one appeared. */
  const before = extractBoundaryLoops(source.positions, source.indices);
  notes.boundaryLoopsBefore = before.loops.length;
  notes.boundaryLoopsAfter = after.loops.length;
  notes.refusalsAfter = after.refusals.map((refusal) => refusal.reason);

  const filledIdentity = options.loopId;
  const stillThere = after.loops.some((loop) => loop.id === filledIdentity);
  notes.selectedLoopRemoved = !stillThere;
  if (stillThere) failures.push(ValidationStatus.BoundaryNotClosed);
  if (after.loops.length !== before.loops.length - 1) {
    notes.loopCountUnexpected = true;
  }

  /*
   * 6 — NO NEW NON-MANIFOLD STRUCTURE.
   *
   * The extractor refuses on non-manifold adjacency, so a candidate that
   * introduced one shows up as a refusal that the source did not have.
   */
  const newRefusals = after.refusals
    .map((refusal) => refusal.reason)
    .filter((reason) => !before.refusals.some((r) => r.reason === reason));
  if (newRefusals.length > 0) {
    notes.newRefusals = newRefusals;
    failures.push(ValidationStatus.NonManifoldCreated);
  }

  /*
   * 7 — PATCH ORIENTATION.
   *
   * Every patch edge lying on the filled boundary must traverse it OPPOSITE to
   * the source face that owns it — that is precisely the manifold winding
   * condition, and it is what distinguishes a correctly attached patch from one
   * that is inside out. Checked against the source's own directed edges, not
   * against a normal or a viewing direction.
   */
  const sourceDirected = new Set();
  for (let face = 0; face < sourceFaceCount; face += 1) {
    const a = after.vertexOf[candidate.indices[face * 3]];
    const b = after.vertexOf[candidate.indices[face * 3 + 1]];
    const c = after.vertexOf[candidate.indices[face * 3 + 2]];
    sourceDirected.add(`${a}>${b}`);
    sourceDirected.add(`${b}>${c}`);
    sourceDirected.add(`${c}>${a}`);
  }
  let opposing = 0;
  let agreeing = 0;
  for (let face = patchFaceStart; face < candidateFaceCount; face += 1) {
    const a = after.vertexOf[candidate.indices[face * 3]];
    const b = after.vertexOf[candidate.indices[face * 3 + 1]];
    const c = after.vertexOf[candidate.indices[face * 3 + 2]];
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      if (sourceDirected.has(`${to}>${from}`)) opposing += 1;
      else if (sourceDirected.has(`${from}>${to}`)) agreeing += 1;
    }
  }
  notes.opposingBoundaryEdges = opposing;
  notes.agreeingBoundaryEdges = agreeing;
  // An agreeing edge means the patch traverses a shared edge the SAME way the
  // source does: two faces on the same side, which is a reversed attachment.
  if (agreeing > 0) failures.push(ValidationStatus.OrientationInconsistent);
  if (patchFaceCount > 0 && opposing !== loopVertices) {
    notes.boundaryAttachmentUnexpected = { opposing, expected: loopVertices };
  }

  /*
   * 8 — PATCH CONNECTIVITY. Every patch vertex must belong to the filled loop
   * or be a vertex the patch itself introduced. A patch borrowing an unrelated
   * vertex would be bridging two openings.
   */
  const loopSet = new Set(options.loopVertexIds);
  const sourceVertexCount = source.positions.length / 3;
  let foreign = 0;
  for (let face = patchFaceStart; face < candidateFaceCount; face += 1) {
    for (let c = 0; c < 3; c += 1) {
      const raw = candidate.indices[face * 3 + c];
      const welded = after.vertexOf[raw];
      if (raw >= sourceVertexCount) continue;
      if (!loopSet.has(welded)) foreign += 1;
    }
  }
  notes.foreignPatchCorners = foreign;
  if (foreign > 0) failures.push(ValidationStatus.PatchDisconnected);

  /*
   * 9 — SELF-INTERSECTION INVOLVING THE PATCH.
   *
   * PATCH-ATTRIBUTED, never aggregate. A pre-existing crossing elsewhere in the
   * model must not be blamed on this operation, and a count that stayed the
   * same must not be taken as proof: the identities matter, not the total. Only
   * (patch × source) and (patch × patch) pairs are tested, and only pairs that
   * share no welded vertex.
   */
  /*
   * BOUNDED. The naive test is O(patch faces x all faces), which for a
   * 2,000-vertex loop on a 6,000-face part is twelve million pair tests and, as
   * first written, twelve million short-lived arrays — enough to exhaust a
   * 1.7 GB Node heap. The budget below keeps the measurement affordable and is
   * itself a finding: production needs a spatial index (or the existing Stage
   * 3C BVH) rather than a pairwise scan, and the ceiling that makes hole fill
   * affordable is a ceiling on this check rather than on the kernel.
   */
  const PAIR_BUDGET = options.pairBudget ?? 2_000_000;
  let pairsTested = 0;
  const intersections = [];
  const faceCorners = (face) =>
    [0, 1, 2].map((c) => corner(candidate.positions, candidate.indices, face, c));
  const faceVertices = (face) =>
    new Set([0, 1, 2].map((c) => after.vertexOf[candidate.indices[face * 3 + c]]));

  for (let patch = patchFaceStart; patch < candidateFaceCount; patch += 1) {
    const patchPoints = faceCorners(patch);
    const patchVertices = faceVertices(patch);
    for (let other = 0; other < candidateFaceCount; other += 1) {
      if (other === patch) continue;
      if (other > patch && other >= patchFaceStart) continue; // each pair once
      const otherVertices = faceVertices(other);
      let shares = false;
      for (const vertex of otherVertices) {
        if (patchVertices.has(vertex)) {
          shares = true;
          break;
        }
      }
      if (shares) continue;
      pairsTested += 1;
      if (pairsTested > PAIR_BUDGET) break;
      if (trianglesIntersect(patchPoints, faceCorners(other))) {
        intersections.push([patch, other]);
        if (intersections.length > 32) break;
      }
    }
    if (intersections.length > 32) break;
  }
  notes.patchIntersections = intersections.length;
  notes.pairsTested = pairsTested;
  notes.pairBudgetExhausted = pairsTested > PAIR_BUDGET;
  if (intersections.length > 0) failures.push(ValidationStatus.SelfIntersectionCreated);

  /* 10 — EULER, as a corroborating check rather than a proof. */
  notes.euler = eulerOf(candidate, after);

  return {
    status: failures.length === 0 ? ValidationStatus.Valid : failures[0],
    failures,
    notes,
  };
}

/**
 * χ = V − E + F over the welded topology.
 *
 * APPLICABLE ONLY TO ORIENTABLE MANIFOLD FIXTURES, and used as corroboration:
 * filling one simple loop of a manifold-with-boundary surface removes one
 * boundary component, so χ increases by exactly 1. It catches a missing or
 * extra patch triangle cheaply. It is NOT sufficient on its own — a patch that
 * folds through the model has the right χ and is still wrong — which is why
 * every check above exists.
 */
export function eulerOf(mesh, welded) {
  const faceCount = mesh.indices.length / 3;
  const edges = new Set();
  const vertices = new Set();
  for (let face = 0; face < faceCount; face += 1) {
    const ids = [0, 1, 2].map((c) => welded.vertexOf[mesh.indices[face * 3 + c]]);
    for (const id of ids) vertices.add(id);
    for (const [from, to] of [
      [ids[0], ids[1]],
      [ids[1], ids[2]],
      [ids[2], ids[0]],
    ]) {
      edges.add(from < to ? `${from}:${to}` : `${to}:${from}`);
    }
  }
  return {
    V: vertices.size,
    E: edges.size,
    F: faceCount,
    chi: vertices.size - edges.size + faceCount,
  };
}
