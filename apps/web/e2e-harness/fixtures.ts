import {
  IDENTITY_PART_TRANSFORM,
  partId,
  type CanonicalMesh,
  type GeometryDocument,
  type GeometryPart,
  type PartTransform,
} from '@cadfixer/mesh-core';
import {
  duplicateDefectMesh,
  faceCountMesh,
  makePart,
  mp02SharedGeometry,
  mp08SharedPlacements,
  selfIntersectingMesh,
  tetrahedronMesh,
  translation,
} from '@cadfixer/mesh-core/fixtures';
import {
  concatMeshes,
  hp02QuadHole,
  hp23PatchPiercesOppositeShell,
  hpBoundaryOfSize,
  tetrahedron as holeFillTetrahedron,
} from '@cadfixer/mesh-hole-fill/fixtures';
import { LengthUnit } from '@cadfixer/shared';

/**
 * THE DOCUMENTS THE BROWSER HARNESS CAN BUILD.
 *
 * Every one of them is assembled from `@cadfixer/mesh-core/fixtures` — the same
 * MP01–MP08 builders the unit and worker suites use — so a browser test and a
 * unit test that name the same fixture are looking at the same geometry rather
 * than at two drifting copies.
 *
 * WHY THIS EXISTS AT ALL. Production import is STL-only, and STL describes
 * exactly one part, so no shipped code path can produce a multi-part document
 * for the viewport to draw. That is the whole reason DF07, DF08 and DF10 had no
 * browser evidence. These fixtures close that gap WITHOUT adding an import
 * format: nothing here is reachable from the application, and the module is not
 * in its import graph.
 *
 * The geometry is deliberately analytic. A tetrahedron of edge 1 at the origin
 * beside the same tetrahedron translated 10 along X is a placement a test can
 * assert on exactly, which a scanned bracket is not.
 */

/** Distances chosen so a wrong or dropped transform is unmistakable, not marginal. */
export const PART_B_OFFSET_X = 10;
export const PART_C_OFFSET_Y = 7;

export const HarnessFixtureId = {
  /** MP-BROWSER-01: two independent parts, different geometry, different places. */
  TwoIndependentParts: 'two-independent-parts',
  /** Two parts sharing ONE CanonicalMesh, placed apart. */
  SharedPairApart: 'shared-pair-apart',
  /** Two parts sharing one mesh at the SAME place: overlapping, both valid. */
  SharedPairOverlapping: 'shared-pair-overlapping',
  /** Three parts, three distinct placements, one shared mesh. */
  ThreeTransformedParts: 'three-transformed-parts',
  /** A repairable duplicate defect beside a clean part. */
  DefectAndClean: 'defect-and-clean',
  /** A self-intersecting part beside a clean part that overlaps it in space. */
  CrossingAndOverlappingClean: 'crossing-and-overlapping-clean',
  /** A small part beside one above the self-intersection face ceiling. */
  SmallAndOversized: 'small-and-oversized',
  /** Ten placements of one mesh. */
  Shared10: 'shared-10',
  /** One hundred placements of one mesh. */
  Shared100: 'shared-100',
  /** One thousand placements of one mesh. */
  Shared1000: 'shared-1000',
  /** A single part, for comparing against the STL-era baseline. */
  SinglePart: 'single-part',
  /*
   * WITH A DECLARED UNIT, for export.
   *
   * Every fixture above states none — which is correct for a document derived
   * from an STL, and is exactly why a 3MF export of one is BLOCKED. These two
   * exist so the browser suite can exercise both sides of that rule against the
   * same geometry rather than only the refusal.
   */
  MillimetreTwoParts: 'millimetre-two-parts',
  MillimetreShared1000: 'millimetre-shared-1000',
  /*
   * LARGE, FOR EXPORT RESPONSIVENESS. Stage 4A-2B2-R1.
   *
   * The fixtures above are small on purpose — they exist to make a placement or
   * a defect unmistakable, and a browser test of RENDERING does not need
   * megabytes. Measuring whether a page stays usable while a document is
   * serialised does: an export that finishes in twelve milliseconds has no
   * window to be unresponsive in.
   *
   * Grid meshes rather than repeated tetrahedra, because a serialiser's cost is
   * per vertex and per triangle and a four-triangle mesh repeated a thousand
   * times measures the placement loop instead of the geometry loop.
   */
  MillimetreLargeSinglePart: 'millimetre-large-single-part',
  /** 400 placements of a 1,152-triangle mesh: 460,800 triangles once baked. */
  MillimetreSharedMedium400: 'millimetre-shared-medium-400',
  /** 1,000 placements of the same mesh. One resource; a million triangles placed. */
  MillimetreSharedMedium1000: 'millimetre-shared-medium-1000',

  /*
   * HOLE-FILL DOCUMENTS. Stage 4B-1B1.
   *
   * The shipped application still imports STL, OBJ and 3MF, so it CAN produce a
   * part with a fillable hole — but not one beside a clean part, not a
   * 512-vertex boundary on a hundred thousand faces, and not the HP23
   * configuration whose patch pierces an internal wall. These three exist so
   * the browser can be shown the cases that decide the stage.
   */
  /** A small fillable hole beside an untouched clean part. */
  HoleFillSmall: 'hole-fill-small',
  /** A 512-vertex boundary on a part near the face ceiling. The worst in-policy case. */
  HoleFillLarge: 'hole-fill-large',
  /** HP23: topologically perfect, and the patch runs through an opposing surface. */
  HoleFillPierced: 'hole-fill-pierced',
} as const;

export type HarnessFixtureId = (typeof HarnessFixtureId)[keyof typeof HarnessFixtureId];

export function isHarnessFixtureId(value: string): value is HarnessFixtureId {
  return Object.values(HarnessFixtureId).some((id) => id === value);
}

function named(
  id: string,
  mesh: CanonicalMesh,
  name: string,
  transform: PartTransform = IDENTITY_PART_TRANSFORM,
): GeometryPart {
  return { id: partId(id), mesh, transform, name };
}

/**
 * Two clean parts occupying the SAME world space.
 *
 * The case ADR 0013 exists to keep honest: neither part's own faces cross, so
 * neither is self-intersecting, however much they overlap each other. A
 * diagnostic that flattened the document before checking would report a
 * crossing that does not exist.
 */
function sharedPairOverlapping(): GeometryDocument {
  const shared = tetrahedronMesh();
  return {
    parts: [named('a', shared, 'Overlapping A'), named('b', shared, 'Overlapping B')],
  };
}

function crossingAndOverlappingClean(): GeometryDocument {
  return {
    parts: [
      // Its own two faces genuinely cross each other.
      named('a', selfIntersectingMesh(), 'Crossing'),
      // Clean, and deliberately placed INSIDE the first part's bounding volume
      // so any flattening would manufacture crossings between the two.
      named('b', tetrahedronMesh(2), 'Clean overlapping', translation(1, 1, 0)),
    ],
  };
}

/**
 * A `side x side` quad grid: `side * side * 2` triangles over shared corners.
 *
 * Deterministic and cheap to build, and every coordinate is a small exact
 * Float32 — so a round trip that loses one is a mismatch a test can point at,
 * not a rounding argument.
 */
function gridMesh(side: number): CanonicalMesh {
  const positions = new Float32Array((side + 1) * (side + 1) * 3);
  let at = 0;
  for (let row = 0; row <= side; row += 1) {
    for (let column = 0; column <= side; column += 1) {
      positions[at] = column;
      positions[at + 1] = row;
      positions[at + 2] = ((column * 7 + row * 13) % 17) * 0.25;
      at += 3;
    }
  }

  const indices = new Uint32Array(side * side * 6);
  let out = 0;
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const base = row * (side + 1) + column;
      indices[out] = base;
      indices[out + 1] = base + 1;
      indices[out + 2] = base + side + 1;
      indices[out + 3] = base + 1;
      indices[out + 4] = base + side + 2;
      indices[out + 5] = base + side + 1;
      out += 6;
    }
  }
  return { positions, indices, metadata: {} };
}

/** `count` placements of ONE grid mesh, spread along X. Shared, never copied. */
function sharedGridPlacements(side: number, count: number): GeometryDocument {
  const mesh = gridMesh(side);
  return {
    unit: LengthUnit.Millimeter,
    parts: Array.from({ length: count }, (_part, index) =>
      makePart(`p${String(index)}`, mesh, {
        transform: translation(index * (side + 4), 0, 0),
      }),
    ),
  };
}

export function buildHarnessDocument(id: HarnessFixtureId): GeometryDocument {
  switch (id) {
    case HarnessFixtureId.TwoIndependentParts:
      return {
        parts: [
          named('a', tetrahedronMesh(1), 'Alpha'),
          named('b', tetrahedronMesh(2), 'Beta', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };

    case HarnessFixtureId.SharedPairApart: {
      const document = mp02SharedGeometry();
      // Renamed and re-placed for legibility in the browser, still one mesh.
      const mesh = document.parts[0]?.mesh ?? tetrahedronMesh();
      return {
        parts: [
          named('a', mesh, 'Shared A'),
          named('b', mesh, 'Shared B', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };
    }

    case HarnessFixtureId.SharedPairOverlapping:
      return sharedPairOverlapping();

    case HarnessFixtureId.ThreeTransformedParts: {
      const mesh = tetrahedronMesh();
      return {
        parts: [
          named('a', mesh, 'At origin'),
          named('b', mesh, 'Along X', translation(PART_B_OFFSET_X, 0, 0)),
          named('c', mesh, 'Along Y', translation(0, PART_C_OFFSET_Y, 0)),
        ],
      };
    }

    case HarnessFixtureId.DefectAndClean:
      return {
        parts: [
          named('a', duplicateDefectMesh(), 'Defective'),
          named('b', tetrahedronMesh(), 'Clean', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };

    case HarnessFixtureId.CrossingAndOverlappingClean:
      return crossingAndOverlappingClean();

    case HarnessFixtureId.SmallAndOversized:
      return {
        parts: [
          named('a', tetrahedronMesh(), 'Small'),
          // Above SELF_INTERSECTION_MAX_FACES. Cheap by construction: three
          // corners and many indices, so proving the size band is refused does
          // not allocate the memory the band exists to refuse.
          named('b', faceCountMesh(250_001), 'Oversized', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };

    case HarnessFixtureId.Shared10:
      return mp08SharedPlacements(10);
    case HarnessFixtureId.Shared100:
      return mp08SharedPlacements(100);
    case HarnessFixtureId.Shared1000:
      return mp08SharedPlacements(1000);

    case HarnessFixtureId.SinglePart:
      return { parts: [makePart('only', tetrahedronMesh(), { name: 'Only part' })] };

    case HarnessFixtureId.MillimetreTwoParts:
      return {
        unit: LengthUnit.Millimeter,
        parts: [
          named('a', tetrahedronMesh(1), 'Alpha'),
          named('b', tetrahedronMesh(2), 'Beta', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };

    case HarnessFixtureId.MillimetreShared1000:
      return { unit: LengthUnit.Millimeter, ...mp08SharedPlacements(1000) };

    case HarnessFixtureId.MillimetreLargeSinglePart:
      // 400 x 400 quads = 320,000 triangles. Roughly 30 MiB of OBJ text and
      // 2.5 MiB of 3MF, which is a serialisation window long enough to be
      // unresponsive in if the work were on the wrong thread.
      return {
        unit: LengthUnit.Millimeter,
        parts: [makePart('large', gridMesh(400), { name: 'Large plate' })],
      };

    case HarnessFixtureId.MillimetreSharedMedium400:
      return sharedGridPlacements(24, 400);

    case HarnessFixtureId.MillimetreSharedMedium1000:
      return sharedGridPlacements(24, 1000);

    case HarnessFixtureId.HoleFillSmall:
      return {
        parts: [
          named('a', hp02QuadHole(), 'Open tube'),
          // Deliberately present and deliberately far away: a fill must not
          // touch it, and a digest proves that byte for byte.
          named('b', tetrahedronMesh(), 'Untouched', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };

    case HarnessFixtureId.HoleFillLarge:
      /*
       * THE WORST CASE THE POLICY ALLOWS: a 512-vertex boundary — the ceiling —
       * on roughly 100,000 faces. Measured at ~1.25 s off-thread, which is a
       * long enough window for a responsiveness test to have something to
       * sample, and long enough for a cancellation to have something to
       * interrupt.
       */
      return { parts: [named('a', largeFillablePart(), 'Large fillable')] };

    case HarnessFixtureId.HoleFillPierced:
      return { parts: [named('a', hp23PatchPiercesOppositeShell(), 'Pierced by its own patch')] };
  }
}

/** A 512-vertex boundary on ~100,000 faces of unrelated bulk. */
function largeFillablePart(): CanonicalMesh {
  const bodies: CanonicalMesh[] = [hpBoundaryOfSize(512)];
  for (let index = 0; index < 25_000; index += 1) {
    // Far from the hole, so the bulk exercises the broadphase rather than the
    // narrowphase — the question is whether a large part costs anything when
    // none of it is anywhere near the patch.
    bodies.push(holeFillTetrahedron([100_000 + index * 0.5, 0, 0], 0.25));
  }
  return concatMeshes(...bodies);
}
