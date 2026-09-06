import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  hp23PatchPiercesOppositeShell,
  hp24ThinWallNoIntersection,
  hpBoundaryOfSize,
} from '@cadfixer/mesh-hole-fill/fixtures';
import { binaryStlFrom, type Point } from './stl-fixtures';

/**
 * STL FIXTURES FOR THE OPEN-BOUNDARY WORKFLOW.
 *
 * WHY STL. These go through the real file picker, the real format
 * identification, the real parser and the real resident commit, so the browser
 * suite exercises exactly the path a user's file takes. A synthetic document
 * injected past the importer would be evidence about the harness.
 *
 * TWO KINDS OF FIXTURE, AND THE DIFFERENCE MATTERS:
 *
 *   - the cubes below are written here, because a closed box with one face
 *     removed is the plainest possible case and spelling it out makes the
 *     winding checkable by reading it;
 *   - HP23 and HP24 are SERIALISED FROM THE ENGINE'S OWN CORPUS rather than
 *     re-modelled. They are the two cases the whole validation gate exists for —
 *     one must be rejected, one must be accepted — and a hand-built
 *     approximation of either would prove something about the approximation.
 *     The research corpus is the definition; this file only changes its
 *     encoding.
 *
 * COORDINATES SURVIVE THE ROUND TRIP EXACTLY. STL holds float32 and a
 * `CanonicalMesh` position array IS float32, so nothing is rounded on the way
 * out or on the way back.
 */

/** Serialises any soup mesh as a binary STL, face for face. */
export function stlFromMesh(mesh: CanonicalMesh): Buffer {
  const faces = Math.floor(mesh.indices.length / 3);
  const triangles: (readonly [Point, Point, Point])[] = [];
  for (let face = 0; face < faces; face += 1) {
    triangles.push([cornerOf(mesh, face, 0), cornerOf(mesh, face, 1), cornerOf(mesh, face, 2)]);
  }
  return binaryStlFrom(triangles);
}

/** One corner's stored coordinates, resolved through the index buffer. */
function cornerOf(mesh: CanonicalMesh, face: number, corner: number): Point {
  const vertex = mesh.indices[face * 3 + corner] ?? 0;
  return [
    mesh.positions[vertex * 3] ?? 0,
    mesh.positions[vertex * 3 + 1] ?? 0,
    mesh.positions[vertex * 3 + 2] ?? 0,
  ];
}

/**
 * The eight corners of an axis-aligned box, with one corner optionally raised.
 *
 * `lift` displaces the `(size, size, size)` corner along +Z. Because that corner
 * is shared by the top face and two side faces, moving it here moves it
 * everywhere it appears — which is what makes the top rim genuinely non-planar
 * rather than merely inconsistent.
 */
function corners(size: number, lift = 0): readonly Point[] {
  return [
    [0, 0, 0],
    [size, 0, 0],
    [size, size, 0],
    [0, size, 0],
    [0, 0, size],
    [size, 0, size],
    [size, size, size + lift],
    [0, size, size],
  ];
}

/**
 * The twelve triangles of a closed box, wound OUTWARD.
 *
 * Written out per face and checked by hand rather than generated, because
 * "reverse one of them" is exactly the kind of thing that is easy to get
 * backwards — and a fixture with an inconsistent rim would be refused by the
 * engine for the right reason and prove nothing about the workflow.
 *
 * Returned as index triples so a face can be omitted by NAME below.
 */
const BOX_FACES: Readonly<Record<string, readonly (readonly [number, number, number])[]>> = {
  // z = 0, facing -Z
  bottom: [
    [0, 2, 1],
    [0, 3, 2],
  ],
  // z = size, facing +Z
  top: [
    [4, 5, 6],
    [4, 6, 7],
  ],
  // y = 0, facing -Y
  front: [
    [0, 1, 5],
    [0, 5, 4],
  ],
  // y = size, facing +Y
  back: [
    [3, 7, 6],
    [3, 6, 2],
  ],
  // x = 0, facing -X
  left: [
    [0, 4, 7],
    [0, 7, 3],
  ],
  // x = size, facing +X
  right: [
    [1, 2, 6],
    [1, 6, 5],
  ],
};

/** A corner by index. The eight are built together, so none is ever missing. */
function pointAt(points: readonly Point[], index: number): Point {
  return points[index] ?? [0, 0, 0];
}

function box(options: { omit?: readonly string[]; size?: number; lift?: number } = {}): Buffer {
  const size = options.size ?? 10;
  const points = corners(size, options.lift ?? 0);
  const omit = new Set(options.omit ?? []);
  const triangles: (readonly [Point, Point, Point])[] = [];
  for (const [name, faces] of Object.entries(BOX_FACES)) {
    if (omit.has(name)) continue;
    for (const face of faces) {
      triangles.push([
        pointAt(points, face[0]),
        pointAt(points, face[1]),
        pointAt(points, face[2]),
      ]);
    }
  }
  return binaryStlFrom(triangles);
}

/**
 * HFUX01: a box with one face removed.
 *
 * Ten triangles, ONE open boundary: a flat square rim of four points. The
 * simplest thing a user can bring that the automatic fill should close, and the
 * primary acceptance fixture.
 */
export function boxWithOneOpeningStl(): Buffer {
  return box({ omit: ['top'] });
}

/**
 * HFUX02: a box with two opposite faces removed.
 *
 * Eight triangles, TWO independent flat openings. Filling one must leave the
 * other exactly where it was — there is no batch fill, and nothing is closed
 * that the user did not choose.
 */
export function boxWithTwoOpeningsStl(): Buffer {
  return box({ omit: ['top', 'bottom'] });
}

/**
 * HFUX03: one fillable opening and one that is not flat.
 *
 * The top corner is lifted well clear of its own plane, so the top rim fails the
 * relative planarity policy while the bottom rim remains a flat square. Both are
 * listed; only one offers a Preview.
 */
export function boxWithFlatAndNonPlanarOpeningsStl(): Buffer {
  return box({ omit: ['top', 'bottom'], lift: 4 });
}

/**
 * HFUX04: a single non-planar opening and nothing else.
 *
 * Nothing here is fillable, and the panel has to say so without implying the
 * model is defective — a rim that curves out of a plane is a perfectly ordinary
 * thing to model.
 */
export function boxWithOnlyNonPlanarOpeningStl(): Buffer {
  return box({ omit: ['top'], lift: 4 });
}

/**
 * HFUX05 / HFUX06: a rim of exactly `vertices` points.
 *
 * From the engine's own corpus, so 512 and 513 mean here exactly what they mean
 * in the qualification: the ceiling is a property of the engine and the
 * interface must agree with it rather than keep its own copy of the number.
 */
export function boundaryOfSizeStl(vertices: number): Buffer {
  return stlFromMesh(hpBoundaryOfSize(vertices));
}

/**
 * HFUX08 / HP23: the patch would pierce an opposing surface.
 *
 * TOPOLOGICALLY PERFECT AND GEOMETRICALLY WRONG. The loop is simple, planar and
 * manifold, the fill removes it, no non-manifold structure appears and the Euler
 * characteristic moves by exactly the right amount — and the patch runs straight
 * through an internal wall. Only the patch-attributed intersection check can
 * reject it, which is why it is the hard gate: if the interface can produce a
 * previewable candidate from this file, the stage is blocked.
 */
export function piercedShellStl(): Buffer {
  return stlFromMesh(hp23PatchPiercesOppositeShell());
}

/**
 * HFUX09 / HP24: the same opposing surface, stopping 1/1024 short.
 *
 * THE CONTROL, and it must SUCCEED. Hole filling does not prove wall thickness,
 * and inventing a clearance requirement would refuse correct geometry while
 * still proving nothing about printability. Without this case, HP23 could be
 * "passing" because the interface refuses everything.
 */
export function thinWallStl(): Buffer {
  return stlFromMesh(hp24ThinWallNoIntersection());
}

/**
 * A grid of loose triangles: one open boundary per face.
 *
 * HFUX31. `count` triangles produce `count` boundary components, which is how a
 * real scan or a badly exported mesh reaches tens of thousands of openings. The
 * inventory must stay bounded and must still report the true total.
 */
export function looseTrianglesStl(count: number): Buffer {
  const triangles: (readonly [Point, Point, Point])[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = (index % 100) * 3;
    const y = Math.floor(index / 100) * 3;
    triangles.push([
      [x, y, 0],
      [x + 1, y, 0],
      [x, y + 1, 0],
    ]);
  }
  return binaryStlFrom(triangles);
}
