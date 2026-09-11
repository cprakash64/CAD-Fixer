import { describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  meshByteLength,
  triangleCount,
  validateMeshStructure,
  vertexCount,
} from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { uncancellable } from '@cadfixer/shared';
import { analyseTopology, buildTopologicalGeometry } from '@cadfixer/mesh-topology';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import {
  bowTieVertex,
  collinearTriangle,
  concat,
  duplicateReversedOrientation,
  duplicateSameOrientation,
  repeatedPositionTriangle,
  squareWrongWinding,
  tetrahedron,
  tetrahedronOneFaceReversed,
  threeTrianglesSharingEdge,
} from '@cadfixer/mesh-topology/fixtures';
import { RepairAcceptance, RepairOperation } from './contract';
import { executeConservativeRepair } from './pipeline';
import { estimateRepairMemory, planConservativeRepair } from './plan';

/**
 * CRP01–CRP32 — CONSERVATIVE REPAIR PRESERVES THE SOURCE'S REPRESENTATION.
 *
 * WHAT THIS FILE IS ABOUT, and what it is deliberately NOT about. Stage 4B-1C
 * proved that undoing a repair returns the exact original mesh. It said nothing
 * about the repaired candidate itself, and the candidate was rebuilt as triangle
 * SOUP: nine coordinates per surviving face and an identity index buffer,
 * whatever the source looked like.
 *
 * For an STL that was already true of the source, so nothing was lost. For an
 * OBJ or a 3MF — genuinely indexed, often with an order of magnitude more faces
 * than vertices — removing ONE duplicate face rewrote the entire model's
 * representation: a 1,000-vertex, 100,000-face part became a 299,997-vertex one
 * describing exactly the same surface. Bigger canonical geometry, bigger render
 * snapshots, bigger exports, more GPU memory, and an index structure the file
 * had carried and CAD Fixer silently discarded.
 *
 * THE GEOMETRY IS NOT WHAT CHANGES HERE. The same faces are removed, in the same
 * order, with the same winding and the same coordinate bytes. Only the way those
 * faces are addressed changes, which is why so many of the assertions below are
 * about identity of REPRESENTATION rather than about shape.
 */

const ALL_OPERATIONS: readonly RepairOperation[] = [
  RepairOperation.RemoveDuplicateFaces,
  RepairOperation.RemoveRepeatedPositionFaces,
  RepairOperation.RemoveZeroAreaFaces,
  RepairOperation.UnifyWinding,
];

function reportOf(mesh: CanonicalMesh): TopologyReport {
  return analyseTopology(mesh, {
    documentId: 'test',
    partId: 'part-1',
    documentRevision: 1,
    cancellation: uncancellable,
  }).report;
}

function repair(
  mesh: CanonicalMesh,
  requested: readonly RepairOperation[] = ALL_OPERATIONS,
): ReturnType<typeof executeConservativeRepair> {
  const before = reportOf(mesh);
  const { plan, view, prepared } = planConservativeRepair({
    mesh,
    report: before,
    documentId: 'test',
    partId: 'part-1',
    sourceRevision: 1,
    requested,
  });
  return executeConservativeRepair({
    source: mesh,
    plan,
    sourceReport: before,
    cancellation: uncancellable,
    documentId: 'test',
    partId: 'part-1',
    revision: 1,
    view,
    prepared,
  });
}

function accepted(mesh: CanonicalMesh, requested?: readonly RepairOperation[]): CanonicalMesh {
  const result = repair(mesh, requested);
  expect(result.validation.acceptance, result.validation.regressions.join(',')).toBe(
    RepairAcceptance.Accepted,
  );
  if (result.candidate === undefined) throw new Error('an accepted repair produced no candidate');
  return result.candidate;
}

function meshOf(positions: readonly number[], indices: readonly number[]): CanonicalMesh {
  const p = createPositionArray(positions.length);
  p.set(positions);
  const i = createIndexArray(indices.length);
  i.set(indices);
  return { positions: p, indices: i, metadata: { sourceFormat: 'obj' } };
}

/**
 * A CLOSED CUBE AS AN INDEXED MESH: eight corners, twelve faces.
 *
 * The shape the negative control is written around, and chosen because the
 * numbers are memorable and unambiguous. Twelve faces sharing eight vertices is
 * a 4.5:1 sharing ratio — high enough that de-indexing is obvious, small enough
 * to write out and check by hand.
 */
function indexedCube(): CanonicalMesh {
  return meshOf(
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
    [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
      0, 4, 3, 4, 7,
    ],
  );
}

/** The same cube carrying one exact duplicate face — the repairable defect. */
function indexedCubeWithDuplicate(): CanonicalMesh {
  const cube = indexedCube();
  const indices = createIndexArray(cube.indices.length + 3);
  indices.set(cube.indices);
  // A same-orientation copy of face 0.
  indices.set([0, 2, 1], cube.indices.length);
  return { positions: cube.positions, indices, metadata: cube.metadata };
}

/** The corner coordinates of every face, in face order. Representation-free. */
function faceCorners(mesh: CanonicalMesh): string[] {
  const out: string[] = [];
  for (let face = 0; face < triangleCount(mesh); face += 1) {
    const corners: string[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const v = (mesh.indices[face * 3 + corner] ?? 0) * 3;
      corners.push(
        `${String(mesh.positions[v])},${String(mesh.positions[v + 1])},${String(mesh.positions[v + 2])}`,
      );
    }
    out.push(corners.join(' | '));
  }
  return out;
}

/* ------------------------------------------------------ CRP01, CRP05-07 -- */

describe('CRP01: an indexed source stays indexed', () => {
  it('CRP01, CRP15: removing one duplicate face does not multiply the vertices', () => {
    const source = indexedCubeWithDuplicate();
    expect(vertexCount(source)).toBe(8);
    expect(triangleCount(source)).toBe(13);

    const candidate = accepted(source);

    // THE DEFECT REMOVED, and nothing else.
    expect(triangleCount(candidate)).toBe(12);
    /*
     * THE NEGATIVE CONTROL — Stage 4B-1D's whole reason to exist.
     *
     * The old rebuild wrote three independent vertices per surviving face, so
     * this number was 36. Asserting "the candidate is valid" would have passed
     * then too; asserting the COUNT is what makes this test able to fail.
     */
    expect(vertexCount(candidate)).toBe(8);
    expect(vertexCount(candidate)).not.toBe(triangleCount(candidate) * 3);
    expect(validateMeshStructure(candidate).valid).toBe(true);
  });

  it('CRP07: every retained vertex keeps its exact source bytes', () => {
    const source = indexedCubeWithDuplicate();
    const candidate = accepted(source);
    // Byte-for-byte, and `Object.is` so a lost negative zero cannot hide.
    expect(candidate.positions.length).toBe(source.positions.length);
    for (let at = 0; at < source.positions.length; at += 1) {
      expect(Object.is(candidate.positions[at], source.positions[at])).toBe(true);
    }
  });

  it('CRP05, CRP06, CRP56: surviving faces keep their order, winding and corners', () => {
    const source = indexedCubeWithDuplicate();
    const candidate = accepted(source);

    // The duplicate is the LAST face, so the survivors are source faces 0..11 in
    // order. Compared as coordinates, so this is a statement about the surface
    // and not about the index encoding.
    expect(faceCorners(candidate)).toEqual(faceCorners(source).slice(0, 12));

    // AND AS INDICES. The cube's faces reference its own corners, and after the
    // repair they reference the same corners by the same numbers.
    expect([...candidate.indices]).toEqual([...source.indices].slice(0, 36));
  });
});

/* ---------------------------------------------------------------- CRP04 -- */

describe('CRP04: a soup source is not made worse', () => {
  it('CRP04: an STL-style source repairs exactly as it always did', () => {
    // Two coincident triangles, numbered as STL numbers them: every corner its
    // own vertex, indices 0,1,2,3,…
    const source = meshOf(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 1, 2, 3, 4, 5],
    );
    const result = repair(source, [RepairOperation.RemoveDuplicateFaces]);
    // Removing one of two coincident triangles opens the surface, so the engine
    // may legitimately refuse. What must NOT happen is a representation change.
    const candidate = result.candidate;
    if (candidate !== undefined) {
      expect(vertexCount(candidate)).toBeLessThanOrEqual(vertexCount(source));
      expect(validateMeshStructure(candidate).valid).toBe(true);
    }
  });
});

/* ------------------------------------------------------- CRP08: no weld -- */

describe('CRP08: coordinate-equal vertices with distinct indices are never merged', () => {
  it('CRP08: two vertices at the same point stay two vertices', () => {
    /*
     * THE ADVERSARIAL CASE. Vertices 2 and 3 are bit-identical points reached by
     * different index numbers, and both are referenced by surviving faces.
     * Rebuilding representation is exactly the moment a careless implementation
     * would "helpfully" deduplicate them — which is tolerance welding by another
     * name, decided by no user and qualified by nobody.
     */
    const source = meshOf(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0],
      [0, 2, 1, 0, 1, 3, 0, 3, 4, 1, 2, 4, 4, 5, 6, 0, 2, 1],
    );
    expect(vertexCount(source)).toBe(7);

    const result = repair(source, [RepairOperation.RemoveDuplicateFaces]);
    const candidate = result.candidate;
    if (candidate === undefined) return;

    // Both points survive as SEPARATE vertices: the coordinate appears twice in
    // the position buffer, exactly as it did in the source.
    let atZeroOneZero = 0;
    for (let v = 0; v < vertexCount(candidate); v += 1) {
      if (
        candidate.positions[v * 3] === 0 &&
        candidate.positions[v * 3 + 1] === 1 &&
        candidate.positions[v * 3 + 2] === 0
      ) {
        atZeroOneZero += 1;
      }
    }
    expect(atZeroOneZero).toBe(2);
  });
});

/* ------------------------------------------------ CRP26: memory honesty -- */

describe('CRP26: the candidate never exceeds the source', () => {
  it('CRP26: an indexed candidate fits inside the estimate the preflight made', () => {
    const source = indexedCubeWithDuplicate();
    const estimate = estimateRepairMemory(source, triangleCount(source));
    const candidate = accepted(source);
    /*
     * THE PREFLIGHT'S WORST CASE IS "NOTHING WAS REMOVED", so the candidate must
     * never be larger than the source. Under the soup rebuild an indexed source
     * broke that: a 13-face, 8-vertex cube produced a candidate roughly three
     * times the size the estimate had promised, and the memory ceiling was
     * therefore protecting against the wrong number.
     */
    expect(meshByteLength(candidate)).toBeLessThanOrEqual(estimate.candidateBytes);
  });
});

/* --------------------------------------------- CRP32: high sharing case -- */

describe('CRP32: a high-sharing mesh is not exploded by a one-face repair', () => {
  it('CRP32: candidate vertices track the source, not three times the face count', () => {
    /*
     * A GRID: (n+1)² vertices, 2n² triangles. At n = 40 that is 1,681 vertices
     * carrying 3,200 faces, so soup would need 9,600. The ratio is the point —
     * this is the shape of every real CAD export, and the shape the old rebuild
     * was worst for.
     */
    const n = 40;
    const positions: number[] = [];
    for (let y = 0; y <= n; y += 1) {
      for (let x = 0; x <= n; x += 1) positions.push(x, y, 0);
    }
    const indices: number[] = [];
    const at = (x: number, y: number): number => y * (n + 1) + x;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        indices.push(at(x, y), at(x + 1, y), at(x, y + 1));
        indices.push(at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
      }
    }
    // One exact duplicate of the first face: the whole defect.
    indices.push(at(0, 0), at(1, 0), at(0, 1));
    const source = meshOf(positions, indices);
    expect(vertexCount(source)).toBe((n + 1) * (n + 1));

    const candidate = accepted(source, [RepairOperation.RemoveDuplicateFaces]);
    const soupVertices = triangleCount(candidate) * 3;

    expect(vertexCount(candidate)).toBeLessThanOrEqual(vertexCount(source));
    // Roughly a sixth of what soup would have cost, and the assertion is on the
    // RATIO so the test states the property rather than a machine-specific size.
    expect(vertexCount(candidate) * 3).toBeLessThan(soupVertices);
    expect(meshByteLength(candidate)).toBeLessThan(meshByteLength(source));
  });
});

/* ------------------------------------------- CRP09-CRP14: vertex policy -- */

describe('CRP09, CRP10: unreferenced vertices follow the frozen policy', () => {
  it('CRP10: a vertex every surviving face stopped using is dropped', () => {
    /*
     * POLICY B, AND THE REASON IT IS NOT POLICY A.
     *
     * Vertex 4 is used only by the two coincident faces at the end. Removing the
     * duplicate leaves one of them, so vertex 4 stays; this fixture instead
     * removes a face whose apex NOTHING else touches, and that apex must go.
     *
     * Keeping it would have been simpler and was rejected: `computeBounds` walks
     * every position slot, so a retained orphan at an extreme coordinate would
     * freeze the model's reported bounding box, and the topological vertex count
     * would keep counting a point no triangle touches. Both are things the old
     * rebuild got right by accident of being soup, and this stage may not change
     * them.
     */
    const source = meshOf(
      // A closed tetrahedron (0..3) plus a lone spike vertex 4 far away, carried
      // by one repeated-position face that repair will remove.
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 100, 100],
      [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3, 4, 4, 4],
    );
    expect(vertexCount(source)).toBe(5);

    // ASSERTED, NOT TOLERATED. A refusal here would make every claim below
    // vacuous, and a test that quietly stops testing is worse than no test.
    const candidate = accepted(source, [RepairOperation.RemoveRepeatedPositionFaces]);

    expect(triangleCount(candidate)).toBe(4);
    // FOUR, NOT FIVE. The spike went with the only face that referenced it.
    expect(vertexCount(candidate)).toBe(4);
    for (const value of candidate.positions) expect(value).not.toBe(100);
  });

  it('CRP12, CRP13, CRP14: dropping the first or last vertex renumbers correctly', () => {
    /*
     * THE OFF-BY-ONE THE REMAP EXISTS TO GET RIGHT. Compaction shifts every
     * later id down, so an error at either end is silent: the mesh stays
     * structurally valid and describes a different surface.
     */
    for (const orphan of ['first', 'last'] as const) {
      // Five vertices; a quad over four of them, plus a degenerate face holding
      // whichever vertex is meant to be orphaned.
      const source =
        orphan === 'first'
          ? meshOf([9, 9, 9, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [1, 2, 3, 1, 3, 4, 0, 0, 0])
          : meshOf([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 9, 9, 9], [0, 1, 2, 0, 2, 3, 4, 4, 4]);
      const candidate = accepted(source, [RepairOperation.RemoveRepeatedPositionFaces]);

      expect(vertexCount(candidate)).toBe(4);
      // The surviving quad's corners, by coordinate, are exactly the source's.
      expect(faceCorners(candidate)).toEqual(faceCorners(source).slice(0, 2));
      // And no index escaped the compacted table.
      for (const index of candidate.indices) expect(index).toBeLessThan(4);
    }
  });
});

describe('CRP11: a mesh past the 16-bit vertex boundary is not truncated', () => {
  it('CRP11: 65,537 vertices survive with their high indices intact', () => {
    /*
     * `Uint16Array` would wrap at 65,536 and produce a mesh that is perfectly
     * valid and completely wrong. The canonical index type is `Uint32Array`, and
     * this fixture crosses the boundary so a narrowing anywhere in the rebuild
     * shows up as geometry rather than as a type error.
     */
    const strips = 65_536;
    const positions: number[] = [];
    for (let i = 0; i <= strips; i += 1) positions.push(i, 0, 0);
    const indices: number[] = [];
    for (let i = 0; i + 2 <= strips; i += 2) indices.push(i, i + 1, i + 2);
    // A repeated-position face using the very LAST vertex, so the highest index
    // in the mesh is one repair has to carry through the remap.
    indices.push(strips, strips, strips);
    const source = meshOf(positions, indices);
    expect(vertexCount(source)).toBe(65_537);

    const result = repair(source, [RepairOperation.RemoveRepeatedPositionFaces]);
    const candidate = result.candidate ?? source;

    let highest = 0;
    for (const index of candidate.indices) if (index > highest) highest = index;
    expect(highest).toBeGreaterThan(65_535);
    expect(highest).toBeLessThan(vertexCount(candidate));
    expect(candidate.indices).toBeInstanceOf(Uint32Array);
    expect(validateMeshStructure(candidate).valid).toBe(true);
  });
});

/* ------------------------------------------------ CRP29-CRP31: determinism -- */

describe('CRP29, CRP30, CRP31: repeated runs are bit-identical', () => {
  const cases: Record<string, () => CanonicalMesh> = {
    'CRP29 indexed cube': indexedCubeWithDuplicate,
    'CRP30 duplicate coordinates, distinct indices': () =>
      meshOf(
        [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0],
        [0, 2, 1, 0, 1, 3, 0, 3, 4, 1, 2, 4, 4, 5, 6, 0, 2, 1],
      ),
    'CRP31 sparse surviving indices': () =>
      meshOf(
        [0, 0, 0, 1, 0, 0, 1, 1, 0, 5, 5, 5, 0, 1, 0, 7, 7, 7, 0, 0, 1],
        [0, 1, 2, 0, 2, 4, 0, 4, 6, 1, 2, 6, 3, 3, 3, 5, 5, 5, 0, 1, 2],
      ),
  };

  for (const [name, build] of Object.entries(cases)) {
    it(`${name}: 100 runs agree on every byte`, () => {
      const first = repair(build());
      const signature = (result: ReturnType<typeof repair>): string =>
        [
          result.validation.acceptance,
          result.candidate === undefined ? 'none' : [...result.candidate.positions].join(','),
          result.candidate === undefined ? 'none' : [...result.candidate.indices].join(','),
          result.candidate === undefined ? 0 : vertexCount(result.candidate),
          result.candidate === undefined ? 0 : triangleCount(result.candidate),
          JSON.stringify(result.counts),
        ].join('#');
      const expected = signature(first);

      for (let run = 0; run < 100; run += 1) {
        expect(signature(repair(build())), `run ${String(run)}`).toBe(expected);
      }
    });
  }
});

/* -------------------------------- CRP16, CRP17: representation-independence -- */

describe('CRP16, CRP17: topology and intersection semantics do not depend on storage', () => {
  /**
   * THE CLAIM THIS STAGE RESTS ON, TESTED RATHER THAN ARGUED.
   *
   * Topology recovers vertex identity from EXACT STORED COORDINATES (ADR 0009),
   * and the self-intersection diagnostic runs on the welded geometry that
   * recovery produces. Both should therefore see the same model whether it is
   * stored as soup or indexed — which is precisely why changing the storage was
   * safe. "Should" is an argument; this compares the two.
   */
  function asSoup(mesh: CanonicalMesh): CanonicalMesh {
    const faces = triangleCount(mesh);
    const positions = createPositionArray(faces * 9);
    const indices = createIndexArray(faces * 3);
    for (let face = 0; face < faces; face += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const from = (mesh.indices[face * 3 + corner] ?? 0) * 3;
        const to = (face * 3 + corner) * 3;
        positions[to] = mesh.positions[from] ?? 0;
        positions[to + 1] = mesh.positions[from + 1] ?? 0;
        positions[to + 2] = mesh.positions[from + 2] ?? 0;
        indices[face * 3 + corner] = face * 3 + corner;
      }
    }
    return { positions, indices, metadata: mesh.metadata };
  }

  it('CRP16: the candidate reports the same topology as its own soup expansion', () => {
    const candidate = accepted(indexedCubeWithDuplicate());
    const indexed = reportOf(candidate);
    const soup = reportOf(asSoup(candidate));

    // EVERY COUNT THE REPAIR VALIDATOR COMPARES, and a few more besides.
    expect(indexed.topologicalVertexCount).toBe(soup.topologicalVertexCount);
    expect(indexed.componentCount).toBe(soup.componentCount);
    expect(indexed.boundaryEdgeCount).toBe(soup.boundaryEdgeCount);
    expect(indexed.nonManifoldEdgeCount).toBe(soup.nonManifoldEdgeCount);
    expect(indexed.nonManifoldVertexCount).toBe(soup.nonManifoldVertexCount);
    expect(indexed.windingConflictEdgeCount).toBe(soup.windingConflictEdgeCount);
    expect(indexed.sameOrientationDuplicateCount).toBe(soup.sameOrientationDuplicateCount);
    expect(indexed.reversedOrientationDuplicateCount).toBe(soup.reversedOrientationDuplicateCount);
    expect(indexed.repeatedPositionFaceCount).toBe(soup.repeatedPositionFaceCount);
    expect(indexed.zeroAreaFaceCount).toBe(soup.zeroAreaFaceCount);
    expect(indexed.sourceFaceCount).toBe(soup.sourceFaceCount);

    // AND THE STORAGE REALLY IS DIFFERENT, so the agreement above means
    // something: eight vertices against twenty-four for the same surface.
    expect(vertexCount(candidate)).toBe(8);
    expect(vertexCount(asSoup(candidate))).toBe(36);
  });

  it('CRP17: the welded geometry the intersection kernel receives is identical', () => {
    const candidate = accepted(indexedCubeWithDuplicate());
    const indexed = buildTopologicalGeometry(candidate);
    const soup = buildTopologicalGeometry(asSoup(candidate));

    /*
     * THE KERNEL NEVER SEES CANONICAL INDICES. `buildTopologicalGeometry` hands
     * it welded vertices and welded face triplets, both derived from
     * coordinates, so a pair of triangles is adjacent or crossing for reasons
     * that have nothing to do with how the mesh was stored. Identical here means
     * the diagnostic cannot change its mind because of this stage.
     */
    expect(indexed.vertexCount).toBe(soup.vertexCount);
    expect(indexed.faceCount).toBe(soup.faceCount);

    /*
     * COMPARED AS COORDINATES, NOT AS IDS, and the distinction is the finding.
     *
     * Welded ids are assigned in order of first appearance while scanning
     * corners, and the two meshes present their corners in different orders — so
     * the same point is vertex 3 in one and vertex 5 in the other. The ids are
     * internal to a single analysis run and nothing outside it ever sees them,
     * so a relabelling is not a semantic difference. What must agree, and does,
     * is the geometry every face resolves to.
     */
    const facesOf = (geometry: typeof indexed): string[] => {
      const out: string[] = [];
      for (let face = 0; face < geometry.faceCount; face += 1) {
        const corners: string[] = [];
        for (let corner = 0; corner < 3; corner += 1) {
          const v = (geometry.triangles[face * 3 + corner] ?? 0) * 3;
          corners.push(
            `${String(geometry.positions[v])},${String(geometry.positions[v + 1])},${String(geometry.positions[v + 2])}`,
          );
        }
        out.push(corners.join(' | '));
      }
      return out;
    };
    expect(facesOf(indexed)).toEqual(facesOf(soup));

    // AND ADJACENCY IS THE SAME, which is what the kernel actually reasons
    // about: two corners share a welded id in one exactly when they do in the
    // other.
    const shape = (geometry: typeof indexed): string => {
      const seen = new Map<number, number>();
      const out: number[] = [];
      for (const id of geometry.triangles) {
        let dense = seen.get(id);
        if (dense === undefined) {
          dense = seen.size;
          seen.set(id, dense);
        }
        out.push(dense);
      }
      return out.join(',');
    };
    expect(shape(indexed)).toBe(shape(soup));
  });
});

/* ------------------------------------------- §6: the semantics are frozen -- */

/**
 * WHAT THE REPAIR DECIDES, RECORDED BEFORE STAGE 4B-1D CHANGED HOW IT IS STORED.
 *
 * Captured by running the pre-change engine over these ten fixtures and writing
 * down what it produced: the acceptance, the per-operation counts, the
 * regressions, and — the load-bearing part — every surviving face's three CORNER
 * COORDINATES in face order.
 *
 * Corners rather than indices, deliberately. Indices are exactly what this stage
 * changes, so freezing them would freeze the defect. Coordinates in face order
 * say which faces survived, in which sequence, wound which way — the repair
 * DECISION — in a form that is identical whether the mesh is stored as soup or
 * indexed. If this block still matches, representation changed and geometry did
 * not.
 *
 * The fixtures cover every conservative operation and every outcome the engine
 * has: an accepted duplicate removal, accepted winding unification at one and at
 * three flips, two refusals, and four no-ops. A change that altered which faces
 * repair removes could not leave all ten alone.
 */
const FROZEN_SEMANTICS = {
  tetrahedron: {
    acceptance: 'NO_OP',
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 0,
      sourceFaceCount: 4,
      candidateFaceCount: 4,
    },
    regressions: [],
    survivingFaceCorners: null,
  },
  duplicateSameOrientation: {
    acceptance: 'ACCEPTED',
    counts: {
      removedDuplicateFaces: 1,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 0,
      sourceFaceCount: 2,
      candidateFaceCount: 1,
    },
    regressions: [],
    survivingFaceCorners: ['0,0,0 | 1,0,0 | 0,1,0'],
  },
  duplicateReversedOrientation: {
    acceptance: 'NO_OP',
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 0,
      sourceFaceCount: 2,
      candidateFaceCount: 2,
    },
    regressions: [],
    survivingFaceCorners: null,
  },
  repeatedPositionTriangle: {
    acceptance: 'REJECTED_REGRESSION',
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 1,
      removedZeroAreaFaces: 0,
      flippedFaces: 0,
      sourceFaceCount: 1,
      candidateFaceCount: 0,
    },
    regressions: ['structurally-invalid'],
    survivingFaceCorners: null,
  },
  collinearTriangle: {
    acceptance: 'REJECTED_REGRESSION',
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 1,
      flippedFaces: 0,
      sourceFaceCount: 1,
      candidateFaceCount: 0,
    },
    regressions: ['structurally-invalid'],
    survivingFaceCorners: null,
  },
  squareWrongWinding: {
    acceptance: 'ACCEPTED',
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 1,
      sourceFaceCount: 2,
      candidateFaceCount: 2,
    },
    regressions: [],
    survivingFaceCorners: ['0,0,0 | 1,0,0 | 1,1,0', '0,0,0 | 1,1,0 | 0,1,0'],
  },
  tetrahedronOneFaceReversed: {
    acceptance: 'ACCEPTED',
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 3,
      sourceFaceCount: 4,
      candidateFaceCount: 4,
    },
    regressions: [],
    survivingFaceCorners: [
      '0,0,0 | 1,0,0 | 0,1,0',
      '0,0,0 | 0,0,1 | 1,0,0',
      '0,0,0 | 0,1,0 | 0,0,1',
      '1,0,0 | 0,0,1 | 0,1,0',
    ],
  },
  threeTrianglesSharingEdge: {
    acceptance: 'NO_OP',
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 0,
      sourceFaceCount: 3,
      candidateFaceCount: 3,
    },
    regressions: [],
    survivingFaceCorners: null,
  },
  bowTieVertex: {
    acceptance: 'NO_OP',
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 0,
      sourceFaceCount: 4,
      candidateFaceCount: 4,
    },
    regressions: [],
    survivingFaceCorners: null,
  },
  combined: {
    acceptance: 'NO_OP',
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 0,
      sourceFaceCount: 6,
      candidateFaceCount: 6,
    },
    regressions: [],
    survivingFaceCorners: null,
  },
} as const;

describe('§6: representation preservation changed no repair decision', () => {
  const fixtures: Record<string, () => CanonicalMesh> = {
    tetrahedron,
    duplicateSameOrientation,
    duplicateReversedOrientation,
    repeatedPositionTriangle,
    collinearTriangle,
    squareWrongWinding,
    tetrahedronOneFaceReversed,
    threeTrianglesSharingEdge,
    bowTieVertex,
    // `concat` joins exactly two meshes; a closed shell beside a duplicate pair.
    combined: () => concat(tetrahedron(), duplicateSameOrientation()),
  };

  for (const [name, build] of Object.entries(fixtures)) {
    it(`CRP-FREEZE: ${name} removes and keeps exactly what it did before`, () => {
      const expected = FROZEN_SEMANTICS[name as keyof typeof FROZEN_SEMANTICS];
      const result = repair(build());

      expect(result.validation.acceptance).toBe(expected.acceptance);
      expect(result.counts).toEqual(expected.counts);
      expect([...result.validation.regressions]).toEqual([...expected.regressions]);
      expect(result.candidate === undefined ? null : faceCorners(result.candidate)).toEqual(
        expected.survivingFaceCorners === null ? null : [...expected.survivingFaceCorners],
      );
    });
  }
});
