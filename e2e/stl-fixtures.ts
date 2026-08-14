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
