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
  }
}
