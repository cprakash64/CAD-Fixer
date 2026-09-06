import type { CanonicalMesh } from '@cadfixer/mesh-core';

/**
 * INDEPENDENT POST-FILL VALIDATION.
 *
 * THE SEPARATION THIS FILE EXISTS TO KEEP: the triangulator CREATES, and these
 * functions VALIDATE. Nothing here asks the thing that produced the patch
 * whether the patch is good. A hole filler reporting success means it did not
 * throw; it says nothing about whether the triangles it manufactured are inside
 * the hole, wound the right way, attached to the right boundary, or piercing
 * the model three centimetres away. ADR 0018's governing result, HF25, is a
 * patch that passes every topological postcondition and the Euler check and
 * still runs straight through an internal wall.
 *
 * EVERY CHECK RUNS ON THE FINAL CANONICAL Float32 REPRESENTATION, because that
 * is what would become authoritative. A patch can be valid in double precision
 * and collapse after narrowing, so validating a working representation would be
 * validating something that never becomes the model. Working ARITHMETIC is
 * Float64 over exactly widened Float32 values; the VALUES are the stored ones.
 *
 * PROVENANCE IS FROZEN, NEVER INFERRED. Faces `[0, sourceFaceCount)` are the
 * user's and `[sourceFaceCount, candidateFaceCount)` are the patch. Every check
 * that must not blame a pre-existing defect on this operation reads that
 * boundary rather than guessing which faces look new.
 */

/**
 * Byte-level source preservation.
 *
 * COMPARED AS BYTES, not as numbers. A numeric comparison would call `NaN`
 * unequal to itself and `-0` equal to `+0`, so it could both invent a
 * difference and hide one. The candidate's positions must be the source's
 * bytes exactly, and its index buffer must begin with the source's index bytes
 * exactly — which is what "append-only" means and what makes the patch's
 * provenance a fact rather than a claim.
 */
export interface SourcePreservation {
  readonly positionsIdentical: boolean;
  readonly indexPrefixIdentical: boolean;
  readonly faceOrderPreserved: boolean;
}

export function validateSourcePreservation(
  source: CanonicalMesh,
  candidate: CanonicalMesh,
): SourcePreservation {
  const positionsIdentical =
    source.positions.length === candidate.positions.length &&
    bytesEqual(
      new Uint8Array(
        source.positions.buffer,
        source.positions.byteOffset,
        source.positions.byteLength,
      ),
      new Uint8Array(
        candidate.positions.buffer,
        candidate.positions.byteOffset,
        candidate.positions.byteLength,
      ),
    );

  const prefixLength = source.indices.byteLength;
  const indexPrefixIdentical =
    candidate.indices.byteLength >= prefixLength &&
    bytesEqual(
      new Uint8Array(source.indices.buffer, source.indices.byteOffset, prefixLength),
      new Uint8Array(candidate.indices.buffer, candidate.indices.byteOffset, prefixLength),
    );

  // Face ORDER is the index prefix: face f occupies indices [3f, 3f+3) in both,
  // so an identical prefix is an identical ordering. Stated separately because
  // it is a separate promise a reader should be able to find.
  return {
    positionsIdentical,
    indexPrefixIdentical,
    faceOrderPreserved: indexPrefixIdentical,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/* --------------------------------------------------------- patch faces -- */

export interface PatchFaceReport {
  readonly degenerateFaces: number;
  readonly duplicateFaces: number;
  readonly smallestArea: number;
  readonly largestArea: number;
  readonly nonFiniteCoordinates: boolean;
}

/**
 * Degeneracy and duplication of the manufactured faces.
 *
 * AREA IS MEASURED AFTER NARROWING. A triangle valid at 1e-12 in double
 * precision can collapse to exactly zero once written into a Float32Array, and
 * the collapsed one is what would ship.
 *
 * DUPLICATION IS UNDER EXACT WELDED IDENTITY and is checked against EVERY face,
 * not only against other patch faces: a patch triangle that reproduces a face
 * the user already had is a defect regardless of which half of the mesh the
 * other copy is in.
 */
export function analysePatchFaces(
  candidate: CanonicalMesh,
  cornerToVertex: Uint32Array,
  sourceFaceCount: number,
): PatchFaceReport {
  const faceCount = Math.floor(candidate.indices.length / 3);
  const positions = candidate.positions;

  const keyOf = (face: number): string => {
    const a = cornerToVertex[candidate.indices[face * 3] ?? 0] ?? 0;
    const b = cornerToVertex[candidate.indices[face * 3 + 1] ?? 0] ?? 0;
    const c = cornerToVertex[candidate.indices[face * 3 + 2] ?? 0] ?? 0;
    const sorted = [a, b, c].sort((left, right) => left - right);
    return `${String(sorted[0])}:${String(sorted[1])}:${String(sorted[2])}`;
  };

  const occurrences = new Map<string, number>();
  for (let face = 0; face < faceCount; face += 1) {
    const key = keyOf(face);
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }

  let degenerateFaces = 0;
  let duplicateFaces = 0;
  let smallestArea = Infinity;
  let largestArea = 0;
  let nonFiniteCoordinates = false;

  for (let face = sourceFaceCount; face < faceCount; face += 1) {
    if ((occurrences.get(keyOf(face)) ?? 0) > 1) duplicateFaces += 1;

    const corners = [0, 1, 2].map((slot) => (candidate.indices[face * 3 + slot] ?? 0) * 3);
    const read = (base: number, axis: number): number => positions[base + axis] ?? 0;
    for (const base of corners) {
      for (let axis = 0; axis < 3; axis += 1) {
        if (!Number.isFinite(read(base, axis))) nonFiniteCoordinates = true;
      }
    }

    const a = corners[0] ?? 0;
    const b = corners[1] ?? 0;
    const c = corners[2] ?? 0;
    const ux = read(b, 0) - read(a, 0);
    const uy = read(b, 1) - read(a, 1);
    const uz = read(b, 2) - read(a, 2);
    const vx = read(c, 0) - read(a, 0);
    const vy = read(c, 1) - read(a, 1);
    const vz = read(c, 2) - read(a, 2);
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    if (!(area > 0)) degenerateFaces += 1;
    smallestArea = Math.min(smallestArea, area);
    largestArea = Math.max(largestArea, area);
  }

  return {
    degenerateFaces,
    duplicateFaces,
    smallestArea: faceCount > sourceFaceCount ? smallestArea : 0,
    largestArea,
    nonFiniteCoordinates,
  };
}

/* -------------------------------------------------------- orientation -- */

export interface PatchOrientationReport {
  /** Patch half-edges traversing a rim edge OPPOSITE to its source face. */
  readonly opposing: number;
  /** Patch half-edges AGREEING with a source face: a reversed attachment. */
  readonly agreeing: number;
  /** Interior patch edges not used exactly twice in opposing directions. */
  readonly inconsistentInteriorEdges: number;
}

/**
 * Patch winding, checked against the source's own DIRECTED edges.
 *
 * THE RULE. Every patch half-edge lying on the filled boundary must traverse it
 * OPPOSITE to the source face that owns it — that is precisely the manifold
 * winding condition, and it is what distinguishes a correctly attached patch
 * from one that is inside out. An AGREEING edge means two faces on the same
 * side of one edge.
 *
 * NOT CHECKED AGAINST A NORMAL, a signed volume, a world axis or a camera. A
 * globally reversed but internally consistent model fills correctly because the
 * rule is RELATIVE, exactly as winding unification in conservative repair is.
 *
 * INTERIOR PATCH EDGES get the same treatment: an edge shared by two patch
 * triangles must appear exactly twice, once in each direction. Anything else is
 * a patch that folds on itself.
 */
export function analysePatchOrientation(
  candidate: CanonicalMesh,
  cornerToVertex: Uint32Array,
  sourceFaceCount: number,
  loopVertices: Uint32Array,
): PatchOrientationReport {
  const faceCount = Math.floor(candidate.indices.length / 3);
  const vertexOfCorner = (corner: number): number => cornerToVertex[corner] ?? 0;

  const sourceDirected = new Set<string>();
  for (let face = 0; face < sourceFaceCount; face += 1) {
    const ids = [0, 1, 2].map((slot) => vertexOfCorner(candidate.indices[face * 3 + slot] ?? 0));
    for (const [from, to] of pairsOf(ids)) sourceDirected.add(edgeKey(from, to));
  }

  const loopSet = new Set<number>();
  for (const vertex of loopVertices) loopSet.add(vertex);

  let opposing = 0;
  let agreeing = 0;
  const patchDirected = new Map<string, number>();

  for (let face = sourceFaceCount; face < faceCount; face += 1) {
    const ids = [0, 1, 2].map((slot) => vertexOfCorner(candidate.indices[face * 3 + slot] ?? 0));
    for (const [from, to] of pairsOf(ids)) {
      patchDirected.set(edgeKey(from, to), (patchDirected.get(edgeKey(from, to)) ?? 0) + 1);
      if (sourceDirected.has(edgeKey(to, from))) opposing += 1;
      else if (sourceDirected.has(edgeKey(from, to))) agreeing += 1;
    }
  }

  /*
   * INTERIOR EDGES. An edge used by the patch and NOT present in the source in
   * either direction is internal to the patch. It must be used exactly twice,
   * once each way, or the patch does not form a consistently wound surface.
   */
  let inconsistentInteriorEdges = 0;
  const seen = new Set<string>();
  for (const [key, count] of patchDirected) {
    const [from, to] = key.split('>').map(Number);
    const forwardInSource = sourceDirected.has(edgeKey(from ?? 0, to ?? 0));
    const backwardInSource = sourceDirected.has(edgeKey(to ?? 0, from ?? 0));
    if (forwardInSource || backwardInSource) continue;

    const undirected = (from ?? 0) < (to ?? 0) ? key : edgeKey(to ?? 0, from ?? 0);
    if (seen.has(undirected)) continue;
    seen.add(undirected);

    const reverse = patchDirected.get(edgeKey(to ?? 0, from ?? 0)) ?? 0;
    if (count !== 1 || reverse !== 1) inconsistentInteriorEdges += 1;
  }

  return { opposing, agreeing, inconsistentInteriorEdges };
}

function pairsOf(ids: readonly (number | undefined)[]): readonly (readonly [number, number])[] {
  const a = ids[0] ?? 0;
  const b = ids[1] ?? 0;
  const c = ids[2] ?? 0;
  return [
    [a, b],
    [b, c],
    [c, a],
  ];
}

function edgeKey(from: number, to: number): string {
  return `${String(from)}>${String(to)}`;
}

/* ------------------------------------------------------- connectivity -- */

export interface PatchConnectivityReport {
  /** Patch corners referencing a vertex outside the filled loop. */
  readonly foreignCorners: number;
  /** Edge-connected pieces the patch falls into. Must be exactly one. */
  readonly pieces: number;
  /** χ of the patch alone. A triangulated disk has exactly 1. */
  readonly patchEuler: number;
  readonly diskLike: boolean;
}

/**
 * Where the patch attaches, and what shape it is.
 *
 * A PATCH BORROWING AN UNRELATED VERTEX WOULD BE BRIDGING TWO OPENINGS, which
 * is a different operation with a different meaning and no qualification behind
 * it. Since this triangulator adds no vertices, every legitimate patch corner
 * is a vertex of the filled loop and nothing else — so a single foreign corner
 * is decisive rather than suspicious.
 *
 * ONE PIECE, AND DISK-LIKE. `n - 2` triangles over `n` boundary vertices and
 * `2n - 3` edges give χ = 1, which is a triangulated disk. A patch that came
 * back in two pieces, or that closed on itself, would have a different χ.
 */
export function analysePatchConnectivity(
  candidate: CanonicalMesh,
  cornerToVertex: Uint32Array,
  sourceFaceCount: number,
  loopVertices: Uint32Array,
): PatchConnectivityReport {
  const faceCount = Math.floor(candidate.indices.length / 3);
  const patchFaceCount = faceCount - sourceFaceCount;

  const loopSet = new Set<number>();
  for (const vertex of loopVertices) loopSet.add(vertex);

  let foreignCorners = 0;
  const vertices = new Set<number>();
  const edges = new Set<string>();
  const edgeToFaces = new Map<string, number[]>();

  for (let face = sourceFaceCount; face < faceCount; face += 1) {
    const ids = [0, 1, 2].map(
      (slot) => cornerToVertex[candidate.indices[face * 3 + slot] ?? 0] ?? 0,
    );
    for (const id of ids) {
      if (!loopSet.has(id)) foreignCorners += 1;
      vertices.add(id);
    }
    for (const [from, to] of pairsOf(ids)) {
      const key = from < to ? edgeKey(from, to) : edgeKey(to, from);
      edges.add(key);
      const bucket = edgeToFaces.get(key);
      if (bucket === undefined) edgeToFaces.set(key, [face]);
      else bucket.push(face);
    }
  }

  // Edge-connected pieces of the patch, by union-find over patch faces.
  const parent = new Map<number, number>();
  const find = (node: number): number => {
    let root = node;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  for (let face = sourceFaceCount; face < faceCount; face += 1) parent.set(face, face);
  for (const faces of edgeToFaces.values()) {
    for (let index = 1; index < faces.length; index += 1) {
      const a = find(faces[0] ?? 0);
      const b = find(faces[index] ?? 0);
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  }
  const roots = new Set<number>();
  for (let face = sourceFaceCount; face < faceCount; face += 1) roots.add(find(face));

  const patchEuler = vertices.size - edges.size + patchFaceCount;

  return {
    foreignCorners,
    pieces: patchFaceCount === 0 ? 0 : roots.size,
    patchEuler,
    diskLike: patchFaceCount > 0 && roots.size === 1 && patchEuler === 1,
  };
}

/* -------------------------------------------------------------- Euler -- */

/**
 * χ = V − E + F over the welded topology.
 *
 * CORROBORATION, NEVER PROOF, and this is the check ADR 0018 singles out.
 * Filling one simple loop of a manifold-with-boundary surface removes one
 * boundary component, so χ increases by exactly 1 — which catches a missing or
 * an extra patch triangle cheaply. HF25 has exactly the right χ and drives its
 * patch through an internal wall, so a passing Euler check may never override a
 * failing validator, and nothing in the engine lets it.
 */
export function eulerCharacteristicOf(mesh: CanonicalMesh, cornerToVertex: Uint32Array): number {
  const faceCount = Math.floor(mesh.indices.length / 3);
  const vertices = new Set<number>();
  const edges = new Set<string>();
  for (let face = 0; face < faceCount; face += 1) {
    const ids = [0, 1, 2].map((slot) => cornerToVertex[mesh.indices[face * 3 + slot] ?? 0] ?? 0);
    for (const id of ids) vertices.add(id);
    for (const [from, to] of pairsOf(ids)) {
      edges.add(from < to ? edgeKey(from, to) : edgeKey(to, from));
    }
  }
  return vertices.size - edges.size + faceCount;
}
