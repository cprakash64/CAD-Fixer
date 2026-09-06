import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  BoundaryLoopRefusal,
  extractBoundaryLoops,
  findBoundaryLoop,
  type BoundaryLoop,
} from './boundary-loops';
import {
  bowTieVertex,
  branchedBoundary,
  concat,
  cubeMissingOneFace,
  repeatedPositionTriangle,
  reverseWinding,
  soup,
  square,
  tetrahedron,
  threeTrianglesSharingEdge,
  translate,
  type Point,
} from './fixtures';

const eligible = (loops: readonly BoundaryLoop[]): readonly BoundaryLoop[] =>
  loops.filter((loop) => loop.refusal === undefined);

/** Directed (from,to) vertex pairs of every source face, as `a>b` keys. */
function sourceDirectedEdges(mesh: CanonicalMesh, cornerToVertex: Uint32Array): Set<string> {
  const out = new Set<string>();
  for (let face = 0; face < mesh.indices.length / 3; face += 1) {
    const ids = [0, 1, 2].map((c) => cornerToVertex[mesh.indices[face * 3 + c] ?? 0] ?? 0);
    for (const [from, to] of [
      [ids[0], ids[1]],
      [ids[1], ids[2]],
      [ids[2], ids[0]],
    ]) {
      out.add(`${String(from)}>${String(to)}`);
    }
  }
  return out;
}

describe('ordered boundary loop extraction', () => {
  it('finds no loop on a closed surface', () => {
    const set = extractBoundaryLoops(tetrahedron());
    expect(set.loops).toEqual([]);
    expect(set.boundaryEdgeCount).toBe(0);
  });

  it('orders the square boundary as one four-vertex cycle', () => {
    const mesh = square();
    const set = extractBoundaryLoops(mesh);
    expect(set.loops).toHaveLength(1);

    const loop = set.loops[0];
    expect(loop?.refusal).toBeUndefined();
    expect(loop?.vertices).toHaveLength(4);
    expect(loop?.incidentFaces).toHaveLength(4);
    expect(loop?.vertexCount).toBe(4);
    expect(loop?.edgeCount).toBe(4);
  });

  it('walks the cube opening as one four-vertex cycle', () => {
    const set = extractBoundaryLoops(cubeMissingOneFace());
    expect(eligible(set.loops)).toHaveLength(1);
    expect(eligible(set.loops)[0]?.vertices).toHaveLength(4);
  });

  it('produces a cycle wound OPPOSITE to the source faces that own its edges', () => {
    /*
     * THE ORIENTATION CONTRACT, checked against the source's own directed
     * edges rather than against a normal or a view direction. A patch built
     * from this ordering attaches with opposing winding, which IS the manifold
     * condition; an agreeing edge would mean two faces on the same side.
     */
    const mesh = cubeMissingOneFace();
    const set = extractBoundaryLoops(mesh);
    const loop = eligible(set.loops)[0];
    expect(loop).toBeDefined();
    const directed = sourceDirectedEdges(mesh, set.cornerToVertex);

    const vertices = [...(loop?.vertices ?? [])];
    for (let index = 0; index < vertices.length; index += 1) {
      const from = vertices[index] ?? 0;
      const to = vertices[(index + 1) % vertices.length] ?? 0;
      expect(directed.has(`${String(to)}>${String(from)}`)).toBe(true);
      expect(directed.has(`${String(from)}>${String(to)}`)).toBe(false);
    }
  });

  it('names the source face that owns each ordered edge', () => {
    const mesh = square();
    const set = extractBoundaryLoops(mesh);
    const loop = eligible(set.loops)[0];
    expect(loop).toBeDefined();

    const vertices = [...(loop?.vertices ?? [])];
    const faces = [...(loop?.incidentFaces ?? [])];
    for (let index = 0; index < vertices.length; index += 1) {
      const from = vertices[index] ?? 0;
      const to = vertices[(index + 1) % vertices.length] ?? 0;
      const face = faces[index] ?? 0;
      const ids = [0, 1, 2].map((c) => set.cornerToVertex[mesh.indices[face * 3 + c] ?? 0] ?? 0);
      const owns = [
        `${String(ids[0])}>${String(ids[1])}`,
        `${String(ids[1])}>${String(ids[2])}`,
        `${String(ids[2])}>${String(ids[0])}`,
      ];
      expect(owns).toContain(`${String(to)}>${String(from)}`);
    }
  });

  it('separates two independent openings into two loops', () => {
    const mesh = concat(cubeMissingOneFace(), translate(cubeMissingOneFace(), [10, 0, 0]));
    const set = extractBoundaryLoops(mesh);
    expect(eligible(set.loops)).toHaveLength(2);
    for (const loop of eligible(set.loops)) expect(loop.vertices).toHaveLength(4);
  });

  it('refuses a branched boundary rather than choosing a successor', () => {
    /*
     * Three triangles meeting at ONE vertex and sharing no edge. Every edge has
     * a single incident face, so nothing here is non-manifold by edge count —
     * the defect is that three boundary half-edges leave the apex, and there is
     * no non-arbitrary way to pick which opening a patch would close.
     */
    const apex: Point = [0, 0, 0];
    const mesh = soup([
      [apex, [1, 0, 0], [1, 1, 0]],
      [apex, [-1, 1, 0], [-1, 0, 0]],
      [apex, [0, 0, 1], [0, 1, 1]],
    ]);
    const set = extractBoundaryLoops(mesh);
    expect(set.loops.length).toBeGreaterThan(0);
    expect(eligible(set.loops)).toHaveLength(0);
    expect(set.loops.map((loop) => loop.refusal)).toContain(BoundaryLoopRefusal.BranchedBoundary);
  });

  it('refuses the fixture fan whose shared edge is non-manifold', () => {
    const set = extractBoundaryLoops(branchedBoundary());
    expect(eligible(set.loops)).toHaveLength(0);
    expect(set.loops.map((loop) => loop.refusal)).toContain(
      BoundaryLoopRefusal.NonManifoldAdjacency,
    );
  });

  it('refuses a bow-tie boundary', () => {
    const set = extractBoundaryLoops(bowTieVertex());
    expect(eligible(set.loops)).toHaveLength(0);
  });

  it('refuses a boundary touched by a non-manifold edge', () => {
    const set = extractBoundaryLoops(threeTrianglesSharingEdge());
    expect(eligible(set.loops)).toHaveLength(0);
    expect(set.loops.map((loop) => loop.refusal)).toContain(
      BoundaryLoopRefusal.NonManifoldAdjacency,
    );
  });

  it('refuses a boundary edge whose endpoints weld to one vertex', () => {
    const set = extractBoundaryLoops(repeatedPositionTriangle());
    expect(eligible(set.loops)).toHaveLength(0);
    expect(set.loops.map((loop) => loop.refusal)).toContain(BoundaryLoopRefusal.DegenerateSegment);
  });

  it('refuses a rim whose adjacent faces disagree about winding', () => {
    /*
     * MIXED RIM. Two triangles share an edge and traverse it the SAME way, so
     * the surface folds back there. The boundary still walks, which is exactly
     * why this needs its own check: a patch attached here would have no single
     * side to face.
     */
    const a: Point = [0, 0, 0];
    const b: Point = [1, 0, 0];
    const c: Point = [0, 1, 0];
    const d: Point = [1, 1, 0];
    const mesh = soup([
      [a, b, c],
      // Shares b→c with the first face IN THE SAME DIRECTION.
      [b, c, d],
    ]);
    const set = extractBoundaryLoops(mesh);
    expect(eligible(set.loops)).toHaveLength(0);
    expect(set.loops.map((loop) => loop.refusal)).toContain(
      BoundaryLoopRefusal.AmbiguousOrientation,
    );
  });

  it('refuses a loop above the vertex ceiling but still names it', () => {
    const set = extractBoundaryLoops(square(), { maxLoopVertices: 3 });
    expect(set.loops).toHaveLength(1);
    expect(set.loops[0]?.refusal).toBe(BoundaryLoopRefusal.TooManyVertices);
    expect(set.loops[0]?.id).toMatch(/^bl-/);
  });

  it('refuses a non-finite boundary coordinate', () => {
    const mesh = square();
    const broken: CanonicalMesh = {
      ...mesh,
      positions: mesh.positions.map((value, index) => (index === 0 ? Number.NaN : value)),
    };
    const set = extractBoundaryLoops(broken);
    expect(eligible(set.loops)).toHaveLength(0);
  });
});

describe('boundary loop identity', () => {
  it('is stable across repeated extraction of the same mesh', () => {
    const first = extractBoundaryLoops(cubeMissingOneFace()).loops.map((loop) => loop.id);
    const second = extractBoundaryLoops(cubeMissingOneFace()).loops.map((loop) => loop.id);
    expect(second).toEqual(first);
  });

  it('distinguishes two GEOMETRICALLY CONGRUENT loops in one part', () => {
    /*
     * The research id was derived from coordinates alone. Two congruent
     * openings at different places are the case that must not collide, and the
     * one a user is most likely to have: the same bracket, drilled twice.
     */
    const mesh = concat(cubeMissingOneFace(), translate(cubeMissingOneFace(), [10, 0, 0]));
    const ids = extractBoundaryLoops(mesh).loops.map((loop) => loop.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('changes when the loop is re-wound', () => {
    const forward = extractBoundaryLoops(cubeMissingOneFace()).loops[0]?.id;
    const reversed = extractBoundaryLoops(reverseWinding(cubeMissingOneFace())).loops[0]?.id;
    expect(forward).toBeDefined();
    expect(reversed).toBeDefined();
    expect(reversed).not.toBe(forward);
  });

  it('is unique across many loops in one part, structurally rather than by luck', () => {
    /*
     * THE COLLISION AUDIT. Boundary components are VERTEX-DISJOINT, so the
     * smallest welded vertex id in a component cannot be shared — which is what
     * makes intra-part uniqueness structural instead of probabilistic. This
     * exercises it at a scale where a 32-bit hash alone would be gambling: at
     * 20,000 loops the birthday probability of a 32-bit collision is ~4.6%.
     */
    const LOOPS = 4_000;
    const positions = createPositionArray(LOOPS * 9);
    const indices = createIndexArray(LOOPS * 3);
    for (let loop = 0; loop < LOOPS; loop += 1) {
      const corners: readonly Point[] = [
        [loop * 4, 0, 0],
        [loop * 4 + 1, 0, 0],
        [loop * 4, 1, 0],
      ];
      corners.forEach((point, corner) => {
        const base = loop * 9 + corner * 3;
        positions[base] = point[0];
        positions[base + 1] = point[1];
        positions[base + 2] = point[2];
        indices[loop * 3 + corner] = loop * 3 + corner;
      });
    }
    const mesh: CanonicalMesh = { positions, indices, metadata: { sourceFormat: 'stl' } };

    const ids = extractBoundaryLoops(mesh).loops.map((loop) => loop.id);
    expect(ids).toHaveLength(LOOPS);
    expect(new Set(ids).size).toBe(LOOPS);
  });

  it('survives a hash collision that the research 32-bit identity would not', () => {
    /*
     * THE AUDIT §8 ASKED FOR, done against the actual research function rather
     * than against an argument about it.
     *
     * `experiments/hole-fill/boundary-loops.mjs` names a loop
     * `loop-<fnv1a32(coordinates)>-<length>`. Two loops of equal length whose
     * coordinate text collides under that 32-bit hash become interchangeable —
     * and the search below finds such a pair by birthday in well under a second,
     * which is the whole point: the collision is not hypothetical.
     *
     * The production id keeps them distinct, because `minVertex` is structural.
     */
    const fnv1a = (text: string): string => {
      let hash = 0x811c9dc5;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash.toString(16).padStart(8, '0');
    };
    // The research identity text for a three-vertex loop at x = k.
    const researchText = (k: number): string =>
      `${String(k)},0,0;${String(k + 1)},0,0;${String(k)},1,0`;

    const seen = new Map<string, number>();
    let collision: readonly [number, number] | undefined;
    for (let k = 0; k < 400_000 && collision === undefined; k += 1) {
      const digest = fnv1a(researchText(k));
      const previous = seen.get(digest);
      if (previous === undefined) seen.set(digest, k);
      else collision = [previous, k];
    }

    expect(collision, 'a 32-bit identity collides well inside one realistic part').toBeDefined();
    const [first, second] = collision ?? [0, 0];
    expect(fnv1a(researchText(first))).toBe(fnv1a(researchText(second)));

    // Now build a mesh holding exactly those two loops and prove production
    // tells them apart.
    const triangleAt = (k: number): readonly [Point, Point, Point] => [
      [k, 0, 0],
      [k + 1, 0, 0],
      [k, 1, 0],
    ];
    const set = extractBoundaryLoops(soup([triangleAt(first), triangleAt(second)]));
    const ids = set.loops.map((loop) => loop.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('is findable by id and refuses an unknown one', () => {
    const set = extractBoundaryLoops(cubeMissingOneFace());
    const id = set.loops[0]?.id;
    expect(id).toBeDefined();
    expect(findBoundaryLoop(set, id ?? '')).toBeDefined();
    expect(findBoundaryLoop(set, 'bl-0-0-0000000000000000')).toBeUndefined();
  });
});
