/**
 * STL fixture builders for the end-to-end suite.
 *
 * Generated in the test process and handed to the page through Playwright's
 * file-chooser API, so nothing large is committed to the repository and every
 * byte under test is auditable here.
 */

const BINARY_PREFIX_BYTES = 84;
const BINARY_FACET_BYTES = 50;

export interface GeneratedStl {
  readonly bytes: Buffer;
  readonly triangles: number;
}

/**
 * Builds a binary STL approximating a lattice of distinct triangles.
 *
 * `triangles` is chosen by the caller so a test can ask for something big
 * enough to be genuinely slow to parse, which is what the responsiveness test
 * needs.
 */
export function binaryStl(triangles: number): GeneratedStl {
  const bytes = Buffer.alloc(BINARY_PREFIX_BYTES + triangles * BINARY_FACET_BYTES);
  bytes.write('cadfixer e2e fixture', 0, 'ascii');
  bytes.writeUInt32LE(triangles, 80);

  for (let index = 0; index < triangles; index += 1) {
    const offset = BINARY_PREFIX_BYTES + index * BINARY_FACET_BYTES;
    const x = (index % 256) * 0.5;
    const y = Math.floor(index / 256) * 0.5;

    // Facet normal left at zero: it is advisory, and leaving it unset also
    // exercises the "zero stored normals" diagnostic path.
    bytes.writeFloatLE(x, offset + 12);
    bytes.writeFloatLE(y, offset + 16);
    bytes.writeFloatLE(0, offset + 20);

    bytes.writeFloatLE(x + 0.4, offset + 24);
    bytes.writeFloatLE(y, offset + 28);
    bytes.writeFloatLE(0, offset + 32);

    bytes.writeFloatLE(x, offset + 36);
    bytes.writeFloatLE(y + 0.4, offset + 40);
    bytes.writeFloatLE(0.2, offset + 44);
  }

  return { bytes, triangles };
}

/** A minimal, unambiguous ASCII STL. */
export function asciiStl(triangles: number): GeneratedStl {
  const lines: string[] = ['solid e2e'];
  for (let index = 0; index < triangles; index += 1) {
    const x = index * 1.5;
    lines.push(
      '  facet normal 0.0 0.0 1.0',
      '    outer loop',
      `      vertex ${x.toFixed(4)} 0.0000 0.0000`,
      `      vertex ${(x + 1).toFixed(4)} 0.0000 0.0000`,
      `      vertex ${x.toFixed(4)} 1.0000 0.0000`,
      '    endloop',
      '  endfacet',
    );
  }
  lines.push('endsolid e2e', '');
  return { bytes: Buffer.from(lines.join('\n'), 'ascii'), triangles };
}

/**
 * A binary STL whose 80-byte header begins with "solid".
 *
 * This is the file that breaks naive detectors, and it exists in the wild.
 */
export function binaryStlWithSolidHeader(triangles: number): GeneratedStl {
  const generated = binaryStl(triangles);
  generated.bytes.fill(0, 0, 80);
  generated.bytes.write('solid a binary file with a misleading header', 0, 'ascii');
  return generated;
}

/** A binary STL that declares far more triangles than it contains. */
export function truncatedBinaryStl(): Buffer {
  const generated = binaryStl(4);
  generated.bytes.writeUInt32LE(9000, 80);
  return generated.bytes;
}

/* ------------------------------------------------- topology fixtures -- */

export type Point = readonly [number, number, number];

/**
 * Writes an arbitrary triangle list as a binary STL.
 *
 * The topology fixtures below are generated at test time and imported through
 * the real file picker, so the browser tests exercise the same parse → resident
 * model → analyze path a user would. Coordinates are written as float32, which
 * is exactly what the format holds, so what the engine recovers is what the file
 * actually says.
 */
export function binaryStlFrom(triangles: readonly (readonly [Point, Point, Point])[]): Buffer {
  const bytes = Buffer.alloc(BINARY_PREFIX_BYTES + triangles.length * BINARY_FACET_BYTES);
  bytes.write('cadfixer topology fixture', 0, 'ascii');
  bytes.writeUInt32LE(triangles.length, 80);

  triangles.forEach((triangle, index) => {
    const offset = BINARY_PREFIX_BYTES + index * BINARY_FACET_BYTES;
    // Normal left at zero: stored normals are advisory and the engine ignores
    // them, deriving orientation from vertex order instead.
    triangle.forEach((point, corner) => {
      const base = offset + 12 + corner * 12;
      bytes.writeFloatLE(point[0], base);
      bytes.writeFloatLE(point[1], base + 4);
      bytes.writeFloatLE(point[2], base + 8);
    });
  });

  return bytes;
}

/** A closed tetrahedron, wound outward. No topological defects. */
export function tetrahedronStl(): Buffer {
  const a: Point = [0, 0, 0];
  const b: Point = [10, 0, 0];
  const c: Point = [0, 10, 0];
  const d: Point = [0, 0, 10];
  return binaryStlFrom([
    [a, c, b],
    [a, b, d],
    [a, d, c],
    [b, c, d],
  ]);
}

/** One triangle: three boundary edges forming one simple loop. */
export function singleTriangleStl(): Buffer {
  return binaryStlFrom([
    [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ],
  ]);
}

/** Three triangles sharing one edge: exactly one non-manifold edge. */
export function nonManifoldEdgeStl(): Buffer {
  const a: Point = [0, 0, 0];
  const b: Point = [10, 0, 0];
  return binaryStlFrom([
    [a, b, [0, 10, 0]],
    [a, b, [0, 0, 10]],
    [a, b, [0, -10, 0]],
  ]);
}

/**
 * THE BOW-TIE. Two square patches meeting at exactly one vertex.
 *
 * No edge is shared between the patches, so every edge has at most two incident
 * faces. Only genuine vertex-fan analysis finds the pinch — which is why this
 * fixture is in the browser suite and not only the unit suite: it proves the
 * interface did not reduce manifoldness to an edge count somewhere on the way to
 * the screen.
 */
export function bowTieStl(): Buffer {
  const apex: Point = [0, 0, 0];
  return binaryStlFrom([
    [apex, [10, 0, 0], [10, 10, 0]],
    [apex, [10, 10, 0], [0, 10, 0]],
    [apex, [-10, 0, 0], [-10, -10, 0]],
    [apex, [-10, -10, 0], [0, -10, 0]],
  ]);
}

/**
 * Two adjacent triangles that traverse their shared edge the SAME way.
 *
 * Worked through explicitly, because "reverse one of them" is easy to get
 * backwards. The first triangle (a,b,c) traverses its edges a→b, b→c, c→a, so
 * it crosses the shared edge {a,c} in the direction c→a. A consistently wound
 * neighbour must therefore cross it a→c. This one is (d,c,a): its edges are
 * d→c, c→a, a→d — it crosses c→a as well, which is the conflict.
 */
export function windingConflictStl(): Buffer {
  const a: Point = [0, 0, 0];
  const b: Point = [10, 0, 0];
  const c: Point = [10, 10, 0];
  const d: Point = [0, 10, 0];
  return binaryStlFrom([
    [a, b, c],
    [d, c, a],
  ]);
}

/** A valid triangle plus one whose three corners are exactly collinear. */
export function degenerateFaceStl(): Buffer {
  return binaryStlFrom([
    [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ],
    [
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
    ],
  ]);
}

/**
 * A grid of open quads, large enough that analysis takes measurable time.
 *
 * Used for cancellation and responsiveness. Height varies with grid position so
 * neighbouring quads genuinely share vertices — a fixture where every quad has
 * its own corners would exercise the hash table's insert path and almost none of
 * its merging, which is the part that costs.
 */
export function analysisHeavyStl(side: number): GeneratedStl {
  const triangles: (readonly [Point, Point, Point])[] = [];
  const height = (x: number, y: number): number => ((x * 7 + y * 13) % 17) * 0.01;

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const p00: Point = [col, row, height(col, row)];
      const p10: Point = [col + 1, row, height(col + 1, row)];
      const p01: Point = [col, row + 1, height(col, row + 1)];
      const p11: Point = [col + 1, row + 1, height(col + 1, row + 1)];
      triangles.push([p00, p10, p01], [p10, p11, p01]);
    }
  }

  return { bytes: binaryStlFrom(triangles), triangles: triangles.length };
}
