import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { ForbiddenOutcome, RepairOperation } from './contract';
import {
  box,
  boxMissingOneFace,
  crackedPatch,
  gridPatch,
  openTube,
  reverseAll,
  scalePoints,
  soup,
  tetrahedron,
  translate,
  type Point,
  type Triangle,
} from './geometry';

/**
 * THE ADVERSARIAL REPAIR CORPUS — R01 to R30.
 *
 * Every candidate in Stage 3A-2 sees exactly this geometry, so results are
 * comparable. Fixtures are generated, not checked in, and each one carries:
 *
 *   - what defect it contains, on purpose;
 *   - what Stage 2 must report about it BEFORE any repair (the oracle);
 *   - what an acceptable repair looks like;
 *   - what outcomes disqualify a result outright.
 *
 * THE ORACLE MATTERS MORE THAN IT LOOKS. Pinning the pre-repair diagnosis is
 * what stops the whole bakeoff from being run against a fixture that does not
 * contain the defect it claims to. A "repair" of a defect that was never there
 * would score perfectly.
 *
 * CONTROLS ARE FIXTURES TOO. R01, R02, R09, R15, R21, R22 and R30 exist to
 * catch a candidate that improves its scores by damaging things: filling every
 * loop, welding everything, merging everything, or quietly rewriting clean
 * input.
 */

export const FixtureScale = {
  Tiny: 'tiny',
  Medium: 'medium',
  Large: 'large',
} as const;

export type FixtureScale = (typeof FixtureScale)[keyof typeof FixtureScale];

/**
 * Expected Stage 2 diagnosis, as exact equalities or bounds.
 *
 * A field left `undefined` is not asserted — used where a fixture's value is
 * incidental to what it tests, so the corpus does not over-pin and become
 * brittle for no benefit.
 */
export interface ExpectedDiagnosis {
  readonly triangles?: number;
  readonly topologicalVertices?: number;
  readonly components?: number;
  readonly boundaryEdges?: number;
  readonly boundaryEdgesAtLeast?: number;
  readonly simpleBoundaryLoops?: number;
  readonly branchedBoundaries?: number;
  readonly openBoundaryChains?: number;
  readonly nonManifoldEdges?: number;
  readonly nonManifoldEdgesAtLeast?: number;
  readonly nonManifoldVertices?: number;
  readonly nonManifoldVerticesAtLeast?: number;
  readonly windingConflicts?: number;
  readonly windingConflictsAtLeast?: number;
  readonly duplicateFaces?: number;
  readonly reversedDuplicateFaces?: number;
  readonly repeatedPositionFaces?: number;
  readonly zeroAreaFaces?: number;
  readonly isEdgeManifold?: boolean;
  readonly isVertexManifold?: boolean;
  readonly isWindingConsistent?: boolean;
  readonly isBoundaryFree?: boolean;
  /** Sign of the algebraic signed volume: 1, -1, or 0 for "not asserted". */
  readonly signedVolumeSign?: -1 | 0 | 1;
}

/**
 * What a repaired result must satisfy to be accepted for this fixture.
 *
 * "The kernel returned a mesh" is never sufficient, so this is expressed as
 * conditions on the OUTPUT's own Stage 2 report plus geometry-change bounds.
 */
export interface AcceptanceCriteria {
  /** Ids recorded in results, so a verdict can be audited line by line. */
  readonly id: string;
  readonly description: string;
  /** Required post-repair diagnosis. */
  readonly post?: ExpectedDiagnosis;
  /** Output must be unchanged from input in every counted respect. */
  readonly requiresUnchanged?: boolean;
  /** Largest acceptable |surface area change| as a fraction of the input area. */
  readonly maxAreaChangeFraction?: number;
  /** Largest acceptable bounding-box movement, as a fraction of the diagonal. */
  readonly maxBoundingBoxChangeFraction?: number;
  /** Running the same repair again must change nothing further. */
  readonly requiresIdempotence?: boolean;
}

export interface RepairFixture {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** What is deliberately wrong with it. Empty for controls. */
  readonly intentionalDefects: readonly string[];
  /** Operations worth pointing at this fixture. */
  readonly relevantOperations: readonly RepairOperation[];
  readonly expected: ExpectedDiagnosis;
  readonly acceptance: readonly AcceptanceCriteria[];
  readonly forbidden: readonly ForbiddenOutcome[];
  readonly scales: readonly FixtureScale[];
  build(scale?: FixtureScale): CanonicalMesh;
}

/* --------------------------------------------------------------- helpers -- */

const UNIT = 10;

/** Grid side per scale. Kept small: this corpus runs in ordinary dev tests. */
function sideFor(scale: FixtureScale): number {
  switch (scale) {
    case FixtureScale.Tiny:
      return 4;
    case FixtureScale.Medium:
      return 20;
    case FixtureScale.Large:
      return 60;
  }
}

const CONTROL_FORBIDDEN: readonly ForbiddenOutcome[] = [
  ForbiddenOutcome.CleanInputChanged,
  ForbiddenOutcome.NonFiniteCoordinate,
  ForbiddenOutcome.UnexpectedlyEmpty,
  ForbiddenOutcome.Crashed,
  ForbiddenOutcome.NonDeterministic,
];

const BASE_FORBIDDEN: readonly ForbiddenOutcome[] = [
  ForbiddenOutcome.NonFiniteCoordinate,
  ForbiddenOutcome.UnexpectedlyEmpty,
  ForbiddenOutcome.TriangleExplosion,
  ForbiddenOutcome.IntroducedNewDefect,
  ForbiddenOutcome.Crashed,
  ForbiddenOutcome.OutputNotReimportable,
  ForbiddenOutcome.NonDeterministic,
];

/* -------------------------------------------------------------- fixtures -- */

export const CORPUS: readonly RepairFixture[] = [
  {
    id: 'R01',
    title: 'Clean tetrahedron',
    description: 'The simplest closed manifold solid. A control: repair must not touch it.',
    intentionalDefects: [],
    relevantOperations: [
      RepairOperation.RemoveDuplicateFaces,
      RepairOperation.RemoveDegenerateFaces,
      RepairOperation.UnifyWinding,
      RepairOperation.OrientOutward,
    ],
    expected: {
      triangles: 4,
      topologicalVertices: 4,
      components: 1,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      nonManifoldVertices: 0,
      windingConflicts: 0,
      isBoundaryFree: true,
      isEdgeManifold: true,
      isVertexManifold: true,
      isWindingConsistent: true,
      signedVolumeSign: 1,
    },
    acceptance: [
      {
        id: 'control-unchanged',
        description: 'A clean solid must survive every conservative operation untouched.',
        requiresUnchanged: true,
        requiresIdempotence: true,
      },
    ],
    forbidden: CONTROL_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () => soup(tetrahedron(UNIT)),
  },

  {
    id: 'R02',
    title: 'Clean cube',
    description: 'A closed manifold box with shared corners. Control.',
    intentionalDefects: [],
    relevantOperations: [
      RepairOperation.RemoveDuplicateFaces,
      RepairOperation.RemoveDegenerateFaces,
      RepairOperation.UnifyWinding,
    ],
    expected: {
      triangles: 12,
      topologicalVertices: 8,
      components: 1,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      nonManifoldVertices: 0,
      windingConflicts: 0,
      isBoundaryFree: true,
      isWindingConsistent: true,
      signedVolumeSign: 1,
    },
    acceptance: [
      {
        id: 'control-unchanged',
        description: 'Clean input must not be modified.',
        requiresUnchanged: true,
        requiresIdempotence: true,
      },
    ],
    forbidden: CONTROL_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () => soup(box([0, 0, 0], [UNIT, UNIT, UNIT])),
  },

  {
    id: 'R03',
    title: 'Exact same-winding duplicate face',
    description: 'A closed cube with one face duplicated in the same cyclic order.',
    intentionalDefects: ['exact duplicate face, same winding'],
    relevantOperations: [RepairOperation.RemoveDuplicateFaces],
    expected: { duplicateFaces: 1, reversedDuplicateFaces: 0, triangles: 13 },
    acceptance: [
      {
        id: 'duplicate-removed',
        description: 'The extra face is gone and no new defect appears.',
        post: { duplicateFaces: 0, boundaryEdges: 0, nonManifoldEdges: 0, isBoundaryFree: true },
        // NOT zero. Stage 2's surface area sums every face, so a duplicate
        // contributes its area twice and removing it legitimately reduces the
        // total — by one face of a cube, roughly 1/13 of the summed area. The
        // surface occupies the same space; only the double-count goes. The
        // invariant that does hold exactly is the bounding box.
        maxAreaChangeFraction: 0.1,
        maxBoundingBoxChangeFraction: 0,
        requiresIdempotence: true,
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: (): CanonicalMesh => {
      const faces = box([0, 0, 0], [UNIT, UNIT, UNIT]);
      const first = faces[0];
      if (first === undefined) throw new Error('box produced no faces');
      return soup([...faces, first]);
    },
  },

  {
    id: 'R04',
    title: 'Exact reversed duplicate face',
    description:
      'A closed cube with one face duplicated in the OPPOSITE cyclic order. Removing one leaves a single-sided face; removing both deletes the surface there. Not the same defect as R03.',
    intentionalDefects: ['reversed duplicate face'],
    relevantOperations: [RepairOperation.RemoveDuplicateFaces],
    expected: { reversedDuplicateFaces: 1, duplicateFaces: 0, triangles: 13 },
    acceptance: [
      {
        id: 'reversed-not-silently-removed',
        description:
          'A reversed duplicate may encode a zero-thickness feature. Removing it automatically is not acceptable; reporting it is.',
        post: { nonManifoldEdgesAtLeast: 0 },
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: (): CanonicalMesh => {
      const faces = box([0, 0, 0], [UNIT, UNIT, UNIT]);
      const first = faces[0];
      if (first === undefined) throw new Error('box produced no faces');
      return soup([...faces, [first[0], first[2], first[1]] as Triangle]);
    },
  },

  {
    id: 'R05',
    title: 'Repeated-position degenerate face',
    description: 'A triangle whose corners occupy only two distinct positions.',
    intentionalDefects: ['repeated-position degenerate face'],
    relevantOperations: [RepairOperation.RemoveDegenerateFaces],
    expected: { repeatedPositionFaces: 1, zeroAreaFaces: 0 },
    acceptance: [
      {
        id: 'degenerate-removed',
        description: 'The face is removed; it contributed no area.',
        post: { repeatedPositionFaces: 0 },
        maxAreaChangeFraction: 0,
        requiresIdempotence: true,
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () =>
      soup([
        ...tetrahedron(UNIT),
        [
          [0, 0, 0],
          [UNIT, 0, 0],
          [UNIT, 0, 0],
        ],
      ]),
  },

  {
    id: 'R06',
    title: 'Exactly collinear zero-area face',
    description:
      'Three distinct but exactly collinear vertices. Contributes no area but does contribute three edges — so removing it can change connectivity.',
    intentionalDefects: ['zero-area collinear face'],
    relevantOperations: [RepairOperation.RemoveDegenerateFaces],
    expected: { zeroAreaFaces: 1, repeatedPositionFaces: 0 },
    acceptance: [
      {
        id: 'zero-area-removed-without-splitting',
        description:
          'The face goes, and the component count does not increase — if it does, the face was load-bearing connectivity and that must be disclosed.',
        post: { zeroAreaFaces: 0 },
        maxAreaChangeFraction: 0,
        requiresIdempotence: true,
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () =>
      soup([
        ...tetrahedron(UNIT),
        [
          [0, 0, 0],
          [UNIT, 0, 0],
          [2 * UNIT, 0, 0],
        ],
      ]),
  },

  {
    id: 'R07',
    title: 'One wrong-wound face in a closed shell',
    description: 'A closed tetrahedron with a single face reversed.',
    intentionalDefects: ['winding conflict'],
    relevantOperations: [RepairOperation.UnifyWinding],
    expected: {
      windingConflictsAtLeast: 1,
      boundaryEdges: 0,
      isWindingConsistent: false,
      isEdgeManifold: true,
    },
    acceptance: [
      {
        id: 'winding-unified',
        description: 'Winding becomes consistent without changing any vertex position.',
        post: { windingConflicts: 0, isWindingConsistent: true, boundaryEdges: 0 },
        maxAreaChangeFraction: 0,
        maxBoundingBoxChangeFraction: 0,
        requiresIdempotence: true,
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: (): CanonicalMesh => {
      const faces = tetrahedron(UNIT);
      const first = faces[0];
      if (first === undefined) throw new Error('tetrahedron produced no faces');
      return soup([[first[0], first[2], first[1]] as Triangle, ...faces.slice(1)]);
    },
  },

  {
    id: 'R08',
    title: 'Cube missing one face',
    description: 'One simple boundary loop of four edges. The archetypal fillable opening.',
    intentionalDefects: ['simple boundary loop'],
    relevantOperations: [RepairOperation.FillBoundaryLoops],
    expected: {
      triangles: 10,
      boundaryEdges: 4,
      simpleBoundaryLoops: 1,
      branchedBoundaries: 0,
      components: 1,
      isBoundaryFree: false,
    },
    acceptance: [
      {
        id: 'loop-filled-on-request',
        description:
          'When the loop is named explicitly, filling it closes the shell without creating new defects.',
        post: {
          boundaryEdges: 0,
          isBoundaryFree: true,
          nonManifoldEdges: 0,
          nonManifoldVertices: 0,
        },
        maxBoundingBoxChangeFraction: 0,
        requiresIdempotence: true,
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () => soup(boxMissingOneFace([0, 0, 0], [UNIT, UNIT, UNIT])),
  },

  {
    id: 'R09',
    title: 'Open tube — openings are INTENTIONAL',
    description:
      'A pipe with two open ends. Filling them turns a pipe into a rod. This fixture exists to catch a candidate whose repair fills every boundary loop and calls it success.',
    intentionalDefects: [],
    relevantOperations: [RepairOperation.FillBoundaryLoops, RepairOperation.UnifyWinding],
    expected: { simpleBoundaryLoops: 2, components: 1, isBoundaryFree: false },
    acceptance: [
      {
        id: 'openings-preserved',
        description:
          'Without an explicit instruction naming a loop, both openings must remain open.',
        post: { simpleBoundaryLoops: 2, isBoundaryFree: false },
        requiresIdempotence: true,
      },
    ],
    forbidden: [...BASE_FORBIDDEN, ForbiddenOutcome.FilledIntentionalOpening],
    scales: [FixtureScale.Tiny, FixtureScale.Medium],
    build: (scale = FixtureScale.Tiny) =>
      soup(openTube(UNIT, UNIT * 3, scale === FixtureScale.Tiny ? 12 : 64)),
  },

  {
    id: 'R10',
    title: 'Branched boundary',
    description:
      'Three triangles sharing one rim edge, producing a boundary vertex of degree three. No simple loop exists, so there is nothing well defined to fill.',
    intentionalDefects: ['branched boundary'],
    relevantOperations: [RepairOperation.FillBoundaryLoops, RepairOperation.ResolveNonManifold],
    expected: { branchedBoundaries: 1, simpleBoundaryLoops: 0 },
    acceptance: [
      {
        id: 'branched-not-blindly-filled',
        description:
          'A branched boundary has no single loop. A candidate must refuse or report, not invent a patch.',
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: (): CanonicalMesh => {
      const centre: Point = [0, 0, 0];
      const rim: Point = [UNIT, 0, 0];
      return soup([
        [centre, rim, [UNIT, UNIT, 0]],
        [centre, rim, [UNIT, -UNIT, 0]],
        [centre, rim, [0, 0, UNIT]],
      ]);
    },
  },

  {
    id: 'R11',
    title: 'Three faces sharing one edge',
    description: 'A non-manifold edge. PMP-class libraries cannot ingest this at all.',
    intentionalDefects: ['non-manifold edge'],
    relevantOperations: [RepairOperation.ResolveNonManifold],
    expected: { nonManifoldEdges: 1, isEdgeManifold: false, nonManifoldVerticesAtLeast: 1 },
    acceptance: [
      {
        id: 'non-manifold-edge-resolved',
        description:
          'The edge becomes manifold. Splitting into more components is an acceptable resolution and must be reported, not hidden.',
        post: { nonManifoldEdges: 0, isEdgeManifold: true },
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: (): CanonicalMesh => {
      const a: Point = [0, 0, 0];
      const b: Point = [UNIT, 0, 0];
      return soup([
        [a, b, [0, UNIT, 0]],
        [a, b, [0, 0, UNIT]],
        [a, b, [0, -UNIT, 0]],
      ]);
    },
  },

  {
    id: 'R12',
    title: 'Bow-tie vertex',
    description:
      'Two patches meeting at exactly one vertex. Every edge has at most two faces, so an edge-only manifold check reports this as clean. THE case that separates real fan analysis from a shortcut.',
    intentionalDefects: ['non-manifold vertex'],
    relevantOperations: [RepairOperation.ResolveNonManifold],
    expected: {
      nonManifoldEdges: 0,
      isEdgeManifold: true,
      nonManifoldVertices: 1,
      isVertexManifold: false,
      components: 2,
    },
    acceptance: [
      {
        id: 'bow-tie-vertex-split',
        description:
          'Splitting the apex leaves two clean patches. The component count staying at two is correct, not a failure.',
        post: { nonManifoldVertices: 0, isVertexManifold: true, components: 2 },
        maxAreaChangeFraction: 0,
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: (): CanonicalMesh => {
      const apex: Point = [0, 0, 0];
      return soup([
        [apex, [UNIT, 0, 0], [UNIT, UNIT, 0]],
        [apex, [UNIT, UNIT, 0], [0, UNIT, 0]],
        [apex, [-UNIT, 0, 0], [-UNIT, -UNIT, 0]],
        [apex, [-UNIT, -UNIT, 0], [0, -UNIT, 0]],
      ]);
    },
  },

  {
    id: 'R13',
    title: 'Two valid shells touching at one vertex',
    description: 'Two closed tetrahedra sharing exactly one corner. Point contact, no shared edge.',
    intentionalDefects: ['non-manifold vertex between closed shells'],
    relevantOperations: [RepairOperation.ResolveNonManifold, RepairOperation.UnionShells],
    expected: {
      components: 2,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      nonManifoldVerticesAtLeast: 1,
    },
    acceptance: [
      {
        id: 'shells-remain-two',
        description: 'Both shells stay closed and stay separate unless a union was requested.',
        post: { boundaryEdges: 0, components: 2 },
      },
    ],
    forbidden: [...BASE_FORBIDDEN, ForbiddenOutcome.MergedDisjointShells],
    scales: [FixtureScale.Tiny],
    build: () => soup([...tetrahedron(UNIT), ...reverseAll(scalePoints(tetrahedron(UNIT), -1))]),
  },

  {
    id: 'R14',
    title: 'Two valid shells touching along one edge',
    description:
      'Two closed shells sharing exactly two vertices, hence one edge. Four faces meet on that edge.',
    intentionalDefects: ['non-manifold edge between closed shells'],
    relevantOperations: [RepairOperation.ResolveNonManifold, RepairOperation.UnionShells],
    expected: { nonManifoldEdgesAtLeast: 1, isEdgeManifold: false },
    acceptance: [
      {
        id: 'shared-edge-resolved',
        description: 'The shared edge becomes manifold without merging the two solids.',
        post: { nonManifoldEdges: 0 },
      },
    ],
    forbidden: [...BASE_FORBIDDEN, ForbiddenOutcome.MergedDisjointShells],
    scales: [FixtureScale.Tiny],
    build: (): CanonicalMesh => {
      // Two tetrahedra sharing the edge from the origin to (UNIT,0,0).
      const a: Point = [0, 0, 0];
      const b: Point = [UNIT, 0, 0];
      const c: Point = [0, UNIT, 0];
      const d: Point = [0, 0, UNIT];
      const e: Point = [0, -UNIT, 0];
      const f: Point = [0, 0, -UNIT];
      return soup([
        [a, c, b],
        [a, b, d],
        [a, d, c],
        [b, c, d],
        [a, b, e],
        [a, f, b],
        [a, e, f],
        [b, f, e],
      ]);
    },
  },

  {
    id: 'R15',
    title: 'Two disjoint clean shells',
    description:
      'Two closed tetrahedra far apart, sharing nothing. A candidate must not join them.',
    intentionalDefects: [],
    relevantOperations: [RepairOperation.WeldWithinTolerance, RepairOperation.UnionShells],
    expected: {
      components: 2,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      nonManifoldVertices: 0,
      isBoundaryFree: true,
    },
    acceptance: [
      {
        id: 'shells-stay-disjoint',
        description: 'Two separate solids remain two separate solids.',
        post: { components: 2, boundaryEdges: 0 },
        requiresUnchanged: true,
        requiresIdempotence: true,
      },
    ],
    forbidden: [...CONTROL_FORBIDDEN, ForbiddenOutcome.MergedDisjointShells],
    scales: [FixtureScale.Tiny],
    build: () => soup([...tetrahedron(UNIT), ...translate(tetrahedron(UNIT), [UNIT * 10, 0, 0])]),
  },

  {
    id: 'R16',
    title: 'Interpenetrating closed shells',
    description:
      'Two closed boxes overlapping in space. Topology is clean; the defect is purely geometric and Stage 2 cannot see it.',
    intentionalDefects: ['inter-shell intersection'],
    relevantOperations: [RepairOperation.UnionShells, RepairOperation.ResolveSelfIntersections],
    expected: {
      components: 2,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      isEdgeManifold: true,
      isBoundaryFree: true,
    },
    acceptance: [
      {
        id: 'union-produces-one-clean-solid',
        description:
          'A union yields a single closed manifold solid with no boundary and no self-intersection.',
        post: { components: 1, boundaryEdges: 0, nonManifoldEdges: 0, isBoundaryFree: true },
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () =>
      soup([
        ...box([0, 0, 0], [UNIT, UNIT, UNIT]),
        ...box([UNIT / 2, UNIT / 2, UNIT / 2], [UNIT * 1.5, UNIT * 1.5, UNIT * 1.5]),
      ]),
  },

  {
    id: 'R17',
    title: 'Self-intersecting single shell',
    description:
      'One component that passes through itself. Closed, manifold, consistently wound — and not printable. The clearest demonstration of why topology alone cannot establish printability.',
    intentionalDefects: ['self-intersection'],
    relevantOperations: [RepairOperation.ResolveSelfIntersections],
    expected: { components: 1, boundaryEdges: 0, isEdgeManifold: true, isBoundaryFree: true },
    acceptance: [
      {
        id: 'self-intersection-resolved',
        description: 'Output is closed, manifold, and free of self-intersection where detectable.',
        post: { boundaryEdges: 0, nonManifoldEdges: 0, isBoundaryFree: true },
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: (): CanonicalMesh => {
      // A bow-tie prism: the quad cross-section crosses itself, so the swept
      // solid passes through itself while remaining a single closed shell.
      const z0 = 0;
      const z1 = UNIT;
      const p: Point[] = [
        [0, 0, z0],
        [UNIT, UNIT, z0],
        [UNIT, 0, z0],
        [0, UNIT, z0],
      ];
      const q: Point[] = p.map((v) => [v[0], v[1], z1] as Point);
      const tri: Triangle[] = [];
      for (let i = 0; i < 4; i += 1) {
        const j = (i + 1) % 4;
        const a = p[i];
        const b = p[j];
        const c = q[j];
        const d = q[i];
        if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
        tri.push([a, b, c], [a, c, d]);
      }
      const [p0, p1, p2, p3] = p;
      const [q0, q1, q2, q3] = q;
      if (
        p0 === undefined ||
        p1 === undefined ||
        p2 === undefined ||
        p3 === undefined ||
        q0 === undefined ||
        q1 === undefined ||
        q2 === undefined ||
        q3 === undefined
      ) {
        throw new Error('prism construction failed');
      }
      tri.push([p0, p2, p1], [p0, p3, p2], [q0, q1, q2], [q0, q2, q3]);
      return soup(tri);
    },
  },

  {
    id: 'R18',
    title: 'Coplanar overlapping triangles',
    description:
      'Two triangles in the same plane overlapping partially, sharing no recovered vertex. Invisible to exact topology.',
    intentionalDefects: ['coplanar overlap'],
    relevantOperations: [RepairOperation.ResolveSelfIntersections],
    expected: { components: 2, nonManifoldEdges: 0 },
    acceptance: [
      {
        id: 'overlap-detected-or-resolved',
        description:
          'A candidate that can see coplanar overlap should report or resolve it; one that cannot must not claim the mesh is clean.',
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () =>
      soup([
        [
          [0, 0, 0],
          [UNIT, 0, 0],
          [0, UNIT, 0],
        ],
        [
          [UNIT / 3, UNIT / 3, 0],
          [UNIT * 1.3, UNIT / 3, 0],
          [UNIT / 3, UNIT * 1.3, 0],
        ],
      ]),
  },

  {
    id: 'R19',
    title: 'Tiny crack — near-coincident seam',
    description:
      'Two patches whose facing edges are close but NOT exactly equal. Reports as boundary edges; welding needs a tolerance nobody can pick without a unit.',
    intentionalDefects: ['near-coincident seam'],
    relevantOperations: [RepairOperation.WeldWithinTolerance],
    expected: { components: 2, boundaryEdgesAtLeast: 1 },
    acceptance: [
      {
        id: 'seam-welded-with-explicit-tolerance',
        description:
          'Given a tolerance larger than the gap, the two patches become one component with the seam closed.',
        post: { components: 1 },
        maxBoundingBoxChangeFraction: 0.01,
        requiresIdempotence: true,
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny, FixtureScale.Medium],
    build: (scale = FixtureScale.Tiny) => soup(crackedPatch(sideFor(scale), 1e-3)),
  },

  {
    id: 'R20',
    title: 'Multiple crack sizes',
    description:
      'The same geometry at several explicit separations, so the bakeoff can find the tolerance at which each heals rather than assuming one.',
    intentionalDefects: ['near-coincident seams at several scales'],
    relevantOperations: [RepairOperation.WeldWithinTolerance],
    expected: { components: 4 },
    acceptance: [
      {
        id: 'tolerance-response-is-monotonic',
        description:
          'Increasing tolerance heals progressively wider gaps and never fewer. A non-monotonic response indicates an unstable weld.',
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: (): CanonicalMesh => {
      const side = 3;
      const gaps = [1e-4, 1e-3, 1e-2];
      const triangles: Triangle[] = [...gridPatch(side, 1, [0, 0, 0])];
      let x = side;
      for (const gap of gaps) {
        x += gap;
        triangles.push(...gridPatch(side, 1, [x, 0, 0]));
        x += side;
      }
      return soup(triangles);
    },
  },

  {
    id: 'R21',
    title: 'Near but INTENTIONALLY parallel surfaces',
    description:
      'Two parallel sheets separated by less than the crack in R19. Any tolerance wide enough to heal R19 destroys this if applied blindly. The fixture that decides whether tolerance can be global at all.',
    intentionalDefects: [],
    relevantOperations: [RepairOperation.WeldWithinTolerance],
    expected: { components: 2 },
    acceptance: [
      {
        id: 'thin-gap-preserved',
        description: 'The two sheets must remain two components and must not be welded together.',
        post: { components: 2 },
      },
    ],
    forbidden: [...CONTROL_FORBIDDEN, ForbiddenOutcome.MergedDisjointShells],
    scales: [FixtureScale.Tiny],
    build: () => soup([...gridPatch(3, 1, [0, 0, 0]), ...gridPatch(3, 1, [0, 0, 5e-4])]),
  },

  {
    id: 'R22',
    title: 'Very thin feature',
    description:
      'A closed box with one dimension far smaller than the others. Conservative repair must not simplify it away.',
    intentionalDefects: [],
    relevantOperations: [
      RepairOperation.RemoveDegenerateFaces,
      RepairOperation.WeldWithinTolerance,
    ],
    expected: { components: 1, boundaryEdges: 0, isBoundaryFree: true },
    acceptance: [
      {
        id: 'thin-feature-survives',
        description: 'The thin dimension is still present and the shell is still closed.',
        post: { boundaryEdges: 0, isBoundaryFree: true, components: 1 },
        maxBoundingBoxChangeFraction: 0.01,
      },
    ],
    forbidden: [...BASE_FORBIDDEN, ForbiddenOutcome.RemovedThinFeature],
    scales: [FixtureScale.Tiny],
    build: () => soup(box([0, 0, 0], [UNIT, UNIT, UNIT * 1e-3])),
  },

  {
    id: 'R23',
    title: 'Tiny isolated sliver component',
    description:
      'A clean solid plus a minuscule separate shell. Removing debris is defensible; doing it silently is not.',
    intentionalDefects: ['isolated tiny component'],
    relevantOperations: [RepairOperation.RemoveDegenerateFaces],
    expected: { components: 2 },
    acceptance: [
      {
        id: 'sliver-not-silently-dropped',
        description:
          'If the tiny component is removed, that removal must be reported as a component change.',
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () =>
      soup([...tetrahedron(UNIT), ...translate(tetrahedron(UNIT * 1e-4), [UNIT * 5, 0, 0])]),
  },

  {
    id: 'R24',
    title: 'Internal nested shell',
    description:
      'A small closed shell entirely inside a larger one, both wound outward — a cavity or debris, depending on intent. Stage 2 sees only two components.',
    intentionalDefects: ['internal shell'],
    relevantOperations: [RepairOperation.UnionShells, RepairOperation.OrientOutward],
    expected: { components: 2, boundaryEdges: 0, isBoundaryFree: true },
    acceptance: [
      {
        id: 'nesting-not-misread',
        description:
          'A candidate must not assume the inner shell is debris, nor that it is a cavity, without a containment test.',
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () =>
      soup([
        ...box([0, 0, 0], [UNIT, UNIT, UNIT]),
        ...box([UNIT * 0.3, UNIT * 0.3, UNIT * 0.3], [UNIT * 0.7, UNIT * 0.7, UNIT * 0.7]),
      ]),
  },

  {
    id: 'R25',
    title: 'Nested shell with reversed orientation',
    description:
      'As R24, but the inner shell is wound inward — the correct encoding of a cavity. A naive orient-outward pass would destroy the cavity.',
    intentionalDefects: ['inward-wound inner shell (a cavity)'],
    relevantOperations: [RepairOperation.OrientOutward],
    expected: { components: 2, boundaryEdges: 0, isBoundaryFree: true },
    acceptance: [
      {
        id: 'cavity-orientation-preserved',
        description:
          'Flipping the inner shell to face outward turns a cavity into solid material. Orientation repair must not do that without containment knowledge.',
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () =>
      soup([
        ...box([0, 0, 0], [UNIT, UNIT, UNIT]),
        ...reverseAll(
          box([UNIT * 0.3, UNIT * 0.3, UNIT * 0.3], [UNIT * 0.7, UNIT * 0.7, UNIT * 0.7]),
        ),
      ]),
  },

  {
    id: 'R26',
    title: 'Large coordinate magnitude with a tiny feature',
    description:
      'A small solid translated 10^6 units from the origin. Numeric robustness, and the strongest evidence available for ADR 0004.',
    intentionalDefects: [],
    relevantOperations: [RepairOperation.UnifyWinding, RepairOperation.WeldWithinTolerance],
    expected: { components: 1, boundaryEdges: 0, isBoundaryFree: true },
    acceptance: [
      {
        id: 'far-from-origin-unchanged',
        description:
          'Topology at 10^6 units out must match topology at the origin. Divergence is precision loss, not a repair.',
        requiresUnchanged: true,
      },
    ],
    forbidden: CONTROL_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () => soup(translate(box([0, 0, 0], [1, 1, 1]), [1e6, -1e6, 1e6])),
  },

  {
    id: 'R27',
    title: 'Very small coordinate scale',
    description: 'A solid whose whole extent is 10^-4 units. The opposite end of the same axis.',
    intentionalDefects: [],
    relevantOperations: [RepairOperation.UnifyWinding, RepairOperation.WeldWithinTolerance],
    expected: { components: 1, boundaryEdges: 0, isBoundaryFree: true },
    acceptance: [
      {
        id: 'tiny-scale-unchanged',
        description: 'A tiny model is still a model; an absolute tolerance must not swallow it.',
        requiresUnchanged: true,
      },
    ],
    forbidden: CONTROL_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () => soup(box([0, 0, 0], [1e-4, 1e-4, 1e-4])),
  },

  {
    id: 'R28',
    title: 'Mixed defect mesh',
    description:
      'Duplicate, degenerate, wrong winding, and an opening in one model. Tests whether repairs compose or interfere.',
    intentionalDefects: [
      'duplicate face',
      'zero-area face',
      'winding conflict',
      'simple boundary loop',
    ],
    relevantOperations: [
      RepairOperation.RemoveDuplicateFaces,
      RepairOperation.RemoveDegenerateFaces,
      RepairOperation.UnifyWinding,
      RepairOperation.FillBoundaryLoops,
    ],
    expected: {
      duplicateFaces: 1,
      zeroAreaFaces: 1,
      windingConflictsAtLeast: 1,
      simpleBoundaryLoops: 1,
    },
    acceptance: [
      {
        id: 'defects-fixed-without-interference',
        description:
          'Each targeted defect goes to zero and no untargeted defect appears. Fixing one defect by creating another is not a repair.',
        post: { duplicateFaces: 0, zeroAreaFaces: 0, windingConflicts: 0 },
        requiresIdempotence: true,
      },
    ],
    forbidden: BASE_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: (): CanonicalMesh => {
      const faces = boxMissingOneFace([0, 0, 0], [UNIT, UNIT, UNIT]);
      const first = faces[0];
      if (first === undefined) throw new Error('box produced no faces');
      return soup([
        ...faces,
        first,
        [first[0], first[2], first[1]] as Triangle,
        [
          [0, 0, 0],
          [UNIT, 0, 0],
          [2 * UNIT, 0, 0],
        ],
      ]);
    },
  },

  {
    id: 'R29',
    title: 'Catastrophic intersecting triangle soup',
    description:
      'Deterministic pseudo-random triangles with no coherent surface. There is no correct repair; the test is whether a candidate fails cleanly instead of hanging, crashing, or returning nonsense.',
    intentionalDefects: ['no recoverable surface'],
    relevantOperations: [RepairOperation.ResolveSelfIntersections, RepairOperation.RebuildAsSolid],
    expected: {},
    acceptance: [
      {
        id: 'fails-cleanly-or-rebuilds-honestly',
        description:
          'Acceptable outcomes: a clean refusal, or a rebuild that is labelled as reconstruction. Unacceptable: a crash, a hang, or a mesh presented as a repair.',
      },
    ],
    forbidden: [
      ForbiddenOutcome.NonFiniteCoordinate,
      ForbiddenOutcome.Crashed,
      ForbiddenOutcome.OutputNotReimportable,
      ForbiddenOutcome.NonDeterministic,
    ],
    scales: [FixtureScale.Tiny, FixtureScale.Medium],
    build: (scale = FixtureScale.Tiny): CanonicalMesh => {
      // A deterministic LCG: the corpus must be byte-identical between runs and
      // between machines, so Math.random is not an option.
      let seed = 0x2f6e2b1;
      const next = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const count = scale === FixtureScale.Tiny ? 200 : 2000;
      const triangles: Triangle[] = [];
      for (let i = 0; i < count; i += 1) {
        const corner = (): Point => [next() * UNIT, next() * UNIT, next() * UNIT];
        triangles.push([corner(), corner(), corner()]);
      }
      return soup(triangles);
    },
  },

  {
    id: 'R30',
    title: 'Clean model repaired repeatedly',
    description:
      'Idempotence control: a clean solid put through the same repair several times must stop changing after the first pass, and ideally never change at all.',
    intentionalDefects: [],
    relevantOperations: [
      RepairOperation.RemoveDuplicateFaces,
      RepairOperation.RemoveDegenerateFaces,
      RepairOperation.UnifyWinding,
      RepairOperation.OrientOutward,
    ],
    expected: {
      components: 1,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      nonManifoldVertices: 0,
      windingConflicts: 0,
      isBoundaryFree: true,
    },
    acceptance: [
      {
        id: 'idempotent-and-unchanged',
        description: 'Repeated repair of clean input changes nothing, on any pass.',
        requiresUnchanged: true,
        requiresIdempotence: true,
      },
    ],
    forbidden: CONTROL_FORBIDDEN,
    scales: [FixtureScale.Tiny],
    build: () => soup(box([0, 0, 0], [UNIT, UNIT, UNIT])),
  },
];

/** Looks a fixture up by id. Throws rather than returning undefined: a missing
 * fixture in a benchmark run is a configuration error, not a data condition. */
export function fixtureById(id: string): RepairFixture {
  const found = CORPUS.find((fixture) => fixture.id === id);
  if (found === undefined) throw new Error(`Unknown repair fixture: ${id}`);
  return found;
}
