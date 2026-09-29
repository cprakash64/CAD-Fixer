import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  BoundaryScanStatus,
  extractBoundaryLoops,
  scanBoundaries,
  type BoundaryScan,
  type BoundaryScanLimits,
} from '@cadfixer/mesh-topology';
import * as topology from '@cadfixer/mesh-topology/fixtures';
import * as holes from './fixtures';

/**
 * REPAIR-CORE-02: THE COMPACT SCAN AGREES WITH `extractBoundaryLoops`.
 *
 * The scan is a second implementation of boundary discovery, written to use a
 * fraction of the memory. A second implementation is exactly how two answers to
 * "where are the openings" come about, so this suite holds the two to the SAME
 * loops — same membership, same refusal, same cyclic order and direction — on
 * every fixture both packages already pin their engines against, and on a few
 * thousand random meshes built to produce every boundary shape.
 */

const LIMITS: BoundaryScanLimits = { maxBoundaryEdges: 1_000_000, maxLoopVertices: 512 };

type Key = string;

/** A loop as the multiset of its coordinates plus, when ordered, its cyclic order. */
interface Described {
  readonly vertexCount: number;
  readonly edgeCount: number;
  readonly members: Key;
  readonly refusal: string | undefined;
  readonly cycle: Key | undefined;
}

function coordinateKey(x: number, y: number, z: number): string {
  const n = (v: number): number => (v === 0 ? 0 : v);
  return `${String(n(x))},${String(n(y))},${String(n(z))}`;
}

/** Canonical rotation of a cyclic sequence of keys, preserving direction. */
function canonicalCycle(keys: readonly string[]): string {
  let best = 0;
  for (let i = 1; i < keys.length; i += 1) if ((keys[i] ?? '') < (keys[best] ?? '')) best = i;
  const out: string[] = [];
  for (let s = 0; s < keys.length; s += 1) out.push(keys[(best + s) % keys.length] ?? '');
  return out.join(' > ');
}

function describeReference(mesh: CanonicalMesh): Described[] {
  const set = extractBoundaryLoops(mesh, { maxLoopVertices: LIMITS.maxLoopVertices });
  // Membership needs every vertex of a component, including refused ones, and
  // the reference exposes them only through its ordered cycle. Recover them
  // from the corners: every corner whose vertex is a boundary vertex of the
  // component. The component of a vertex is not exposed, so membership is
  // compared only for ELIGIBLE loops (where the cycle is the membership), and
  // refused loops are compared by count per refusal.
  const coordinateOf = (vertex: number): string => {
    const corner = (set.vertexRepresentativeCorner[vertex] ?? 0) * 3;
    return coordinateKey(
      mesh.positions[corner] ?? 0,
      mesh.positions[corner + 1] ?? 0,
      mesh.positions[corner + 2] ?? 0,
    );
  };
  return set.loops.map((loop) => {
    const keys = [...loop.vertices].map(coordinateOf);
    return {
      vertexCount: loop.vertexCount,
      edgeCount: loop.edgeCount,
      members: loop.refusal === undefined ? [...keys].sort().join(' ') : '',
      refusal: loop.refusal,
      cycle: loop.refusal === undefined ? canonicalCycle(keys) : undefined,
    };
  });
}

function describeScan(scan: BoundaryScan): Described[] {
  return scan.loops.map((loop) => {
    const keys: string[] = [];
    for (let i = 0; i < loop.points.length; i += 3) {
      keys.push(
        coordinateKey(loop.points[i] ?? 0, loop.points[i + 1] ?? 0, loop.points[i + 2] ?? 0),
      );
    }
    return {
      vertexCount: loop.vertexCount,
      edgeCount: loop.edgeCount,
      members: loop.refusal === undefined ? [...keys].sort().join(' ') : '',
      refusal: loop.refusal,
      cycle: loop.refusal === undefined ? canonicalCycle(keys) : undefined,
    };
  });
}

function sortDescribed(list: Described[]): Described[] {
  return [...list].sort((a, b) =>
    `${a.refusal ?? ''}|${String(a.vertexCount)}|${String(a.edgeCount)}|${a.cycle ?? ''}` <
    `${b.refusal ?? ''}|${String(b.vertexCount)}|${String(b.edgeCount)}|${b.cycle ?? ''}`
      ? -1
      : 1,
  );
}

function expectAgreement(name: string, mesh: CanonicalMesh): void {
  const scan = scanBoundaries(mesh, { limits: LIMITS });
  expect(scan.status, name).toBe(BoundaryScanStatus.Scanned);
  const reference = extractBoundaryLoops(mesh, { maxLoopVertices: LIMITS.maxLoopVertices });
  expect(scan.boundaryEdgeCount, `${name}: boundary edges`).toBe(reference.boundaryEdgeCount);
  expect(sortDescribed(describeScan(scan)), name).toEqual(sortDescribed(describeReference(mesh)));
  // Every eligible loop's rim is owned, edge by edge, by a real face that
  // traverses it the other way.
  for (const loop of scan.loops) {
    if (loop.refusal !== undefined) continue;
    expect(loop.corners.length).toBe(loop.vertexCount);
    expect(loop.incidentFaces.length).toBe(loop.vertexCount);
  }
}

describe('the compact scan agrees with extractBoundaryLoops', () => {
  const topologyFixtures: Readonly<Record<string, () => CanonicalMesh>> = {
    singleTriangle: topology.singleTriangle,
    square: topology.square,
    squareWrongWinding: topology.squareWrongWinding,
    tetrahedron: () => topology.tetrahedron(),
    tetrahedronOneFaceReversed: topology.tetrahedronOneFaceReversed,
    twoTetrahedra: topology.twoTetrahedra,
    threeTrianglesSharingEdge: topology.threeTrianglesSharingEdge,
    bowTieVertex: topology.bowTieVertex,
    cubeMissingOneFace: topology.cubeMissingOneFace,
    branchedBoundary: topology.branchedBoundary,
    duplicateSameOrientation: topology.duplicateSameOrientation,
    duplicateReversedOrientation: topology.duplicateReversedOrientation,
    repeatedPositionTriangle: topology.repeatedPositionTriangle,
    collinearTriangle: topology.collinearTriangle,
    signedZeroPair: topology.signedZeroPair,
    overlappingClosedShells: topology.overlappingClosedShells,
    tetrahedraTouchingAtOneVertex: topology.tetrahedraTouchingAtOneVertex,
  };
  for (const [name, build] of Object.entries(topologyFixtures)) {
    it(`topology fixture ${name}`, () => {
      expectAgreement(name, build());
    });
  }

  const holeFixtures: Readonly<Record<string, () => CanonicalMesh>> = {
    hp01TriangleHole: holes.hp01TriangleHole,
    hp02QuadHole: holes.hp02QuadHole,
    hp03ConvexEight: holes.hp03ConvexEight,
    hp04ConcaveL: holes.hp04ConcaveL,
    hp05DeepConcave: holes.hp05DeepConcave,
    hp06MildlyWarped: holes.hp06MildlyWarped,
    hp07NonPlanar: holes.hp07NonPlanar,
    hp08StronglyNonPlanar: holes.hp08StronglyNonPlanar,
    hp12TwoIndependentHoles: holes.hp12TwoIndependentHoles,
    hp13BranchedBoundary: holes.hp13BranchedBoundary,
    hp14TJunction: holes.hp14TJunction,
    hp15BowTie: holes.hp15BowTie,
    hp16TwoLoopsSharingVertex: holes.hp16TwoLoopsSharingVertex,
    hp17DuplicateBoundaryEdge: holes.hp17DuplicateBoundaryEdge,
    hp18RepeatedVertex: holes.hp18RepeatedVertex,
    hp19ZeroLengthEdge: holes.hp19ZeroLengthEdge,
    hp20CollinearBoundary: holes.hp20CollinearBoundary,
    hp21NearCollinear: holes.hp21NearCollinear,
    hp22PreExistingSourceIntersection: holes.hp22PreExistingSourceIntersection,
    hp23PatchPiercesOppositeShell: holes.hp23PatchPiercesOppositeShell,
    hp24ThinWallNoIntersection: holes.hp24ThinWallNoIntersection,
    hp25GloballyReversed: holes.hp25GloballyReversed,
    hp26MixedLocalWinding: holes.hp26MixedLocalWinding,
    hp29FarFromOrigin: holes.hp29FarFromOrigin,
    unrelatedNonManifoldCluster: () => holes.unrelatedNonManifoldCluster(),
    chordTetrahedron: holes.chordTetrahedron,
    tp02ExistingNonManifoldOnly: holes.tp02ExistingNonManifoldOnly,
    tp03ChordCollisionWithExistingDefect: holes.tp03ChordCollisionWithExistingDefect,
    tp04ChordCollisionAlone: holes.tp04ChordCollisionAlone,
    reviewCoplanarOverlap: holes.reviewCoplanarOverlap,
    reviewNonAdjacentPointTouch: holes.reviewNonAdjacentPointTouch,
    boundaryOf600: () => holes.hpBoundaryOfSize(600),
  };
  for (const [name, build] of Object.entries(holeFixtures)) {
    it(`hole-fill fixture ${name}`, () => {
      expectAgreement(name, build());
    });
  }

  // ~2.5 s alone; the whole suite running in parallel has pushed it past the
  // 5 s default. The work is fixed, so the limit is a load allowance only.
  it(
    'agrees on 2,000 random meshes built to produce every boundary shape',
    { timeout: 60_000 },
    () => {
      let seed = 0x1234567;
      const random = (): number => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed / 0x100000000;
      };
      const seen = new Set<string>();
      for (let trial = 0; trial < 2_000; trial += 1) {
        const mesh = randomGridMesh(random, trial % 3 === 0);
        expectAgreement(`random #${String(trial)}`, mesh);
        for (const loop of scanBoundaries(mesh, { limits: LIMITS }).loops) {
          seen.add(loop.refusal ?? 'ELIGIBLE');
        }
      }
      // Not vacuous: the corpus reached eligible loops and the refusal kinds a
      // grid can produce.
      for (const kind of [
        'ELIGIBLE',
        'BRANCHED_BOUNDARY',
        'NON_MANIFOLD_ADJACENCY',
        'AMBIGUOUS_ORIENTATION',
      ]) {
        expect(seen, kind).toContain(kind);
      }
    },
  );

  it('agrees when the same point is stored at several indices, and as -0', () => {
    // An indexed quad whose shared corner appears at two indices, one as -0.
    const positions = createPositionArray(15);
    positions.set([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, -0, 0, 0]);
    const indices = createIndexArray(6);
    indices.set([0, 1, 2, 4, 2, 3]);
    expectAgreement('indexed with a duplicated corner', {
      positions,
      indices,
      metadata: { sourceFormat: 'obj' },
    });
  });
});

describe('resource behaviour', () => {
  it('refuses to assemble loops above the boundary-edge ceiling, and reports the exact count', () => {
    const mesh = holes.hpBoundaryOfSize(40);
    const scan = scanBoundaries(mesh, { limits: { maxBoundaryEdges: 10, maxLoopVertices: 512 } });
    expect(scan.status).toBe(BoundaryScanStatus.TooManyBoundaryEdges);
    expect(scan.boundaryEdgeCount).toBe(extractBoundaryLoops(mesh).boundaryEdgeCount);
    expect(scan.loops).toEqual([]);
  });

  it('holds about five bytes per table slot, far below the full topology path', () => {
    const mesh = holes.hp27LargeInPolicyPart(40_000);
    const scan = scanBoundaries(mesh, { limits: LIMITS });
    const faces = mesh.indices.length / 3;
    // Five bytes a slot at under 70% load: at most ~15-22 bytes a face for a
    // closed-ish mesh, including the transient overlap of the final growth.
    expect(scan.tableBytes / faces).toBeLessThan(45);
  });

  it('is deterministic: the same mesh gives the same loops, ids and order', () => {
    const mesh = holes.hp12TwoIndependentHoles();
    const first = scanBoundaries(mesh, { limits: LIMITS });
    const second = scanBoundaries(mesh, { limits: LIMITS });
    expect(second.loops.map((loop) => loop.id)).toEqual(first.loops.map((loop) => loop.id));
    expect(second.loops.map((loop) => [...loop.corners])).toEqual(
      first.loops.map((loop) => [...loop.corners]),
    );
  });

  it('gives a loop the same id whatever order the file lists its faces in', () => {
    const mesh = holes.hp03ConvexEight();
    const permuted = topology.permuteFaceOrder(mesh);
    const a = scanBoundaries(mesh, { limits: LIMITS })
      .loops.map((loop) => loop.id)
      .sort();
    const b = scanBoundaries(permuted, { limits: LIMITS })
      .loops.map((loop) => loop.id)
      .sort();
    expect(b).toEqual(a);
  });

  it('writes nothing to the canonical buffers', () => {
    const mesh = holes.hp04ConcaveL();
    const positions = new Uint8Array(mesh.positions.buffer.slice(0));
    const indices = new Uint8Array(mesh.indices.buffer.slice(0));
    scanBoundaries(mesh, { limits: LIMITS });
    expect(new Uint8Array(mesh.positions.buffer)).toEqual(positions);
    expect(new Uint8Array(mesh.indices.buffer)).toEqual(indices);
  });
});

/**
 * A random subset of a small grid of unit squares, some faces reversed, some
 * duplicated, some extra faces sharing an edge three ways — every boundary
 * shape the taxonomy names, on small integer coordinates. Soup or indexed.
 */
function randomGridMesh(random: () => number, indexed: boolean): CanonicalMesh {
  const size = 3 + Math.floor(random() * 3);
  const triangles: number[][] = [];
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      const a = [x, y, 0];
      const b = [x + 1, y, 0];
      const c = [x + 1, y + 1, 0];
      const d = [x, y + 1, 0];
      for (const tri of [
        [a, b, c],
        [a, c, d],
      ]) {
        const roll = random();
        if (roll < 0.25) continue;
        const face = roll < 0.3 ? [tri[0], tri[2], tri[1]] : tri;
        triangles.push(face.flat() as number[]);
        if (random() < 0.03) triangles.push(face.flat() as number[]);
        if (random() < 0.03) {
          // A third face on this triangle's first edge, lifted out of plane.
          const [p, q] = [tri[0] ?? [0, 0, 0], tri[1] ?? [0, 0, 0]];
          triangles.push([...p, ...q, (p[0] ?? 0) + 0.5, (p[1] ?? 0) - 0.5, 1]);
        }
      }
    }
  }
  const faceCount = triangles.length;
  if (!indexed) {
    const positions = createPositionArray(faceCount * 9);
    const indices = createIndexArray(faceCount * 3);
    triangles.forEach((tri, face) => {
      positions.set(tri, face * 9);
      indices.set([face * 3, face * 3 + 1, face * 3 + 2], face * 3);
    });
    return { positions, indices, metadata: { sourceFormat: 'stl' } };
  }
  // Indexed: shared vertices through a map, so identity is carried by indices
  // AND by coordinates — the scan must give the same answer either way.
  const lookup = new Map<string, number>();
  const points: number[] = [];
  const indexList: number[] = [];
  for (const tri of triangles) {
    for (let corner = 0; corner < 3; corner += 1) {
      const p = tri.slice(corner * 3, corner * 3 + 3);
      const key = p.join(',');
      let index = lookup.get(key);
      if (index === undefined) {
        index = points.length / 3;
        lookup.set(key, index);
        points.push(...p);
      }
      indexList.push(index);
    }
  }
  const positions = createPositionArray(points.length);
  positions.set(points);
  const indices = createIndexArray(indexList.length);
  indices.set(indexList);
  return { positions, indices, metadata: { sourceFormat: 'obj' } };
}
