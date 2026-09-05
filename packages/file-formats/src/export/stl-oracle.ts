/**
 * AN INDEPENDENT STRUCTURAL VIEW OF A BINARY STL FILE. TEST-ONLY.
 *
 * WHY THIS EXISTS. Parse-back validation runs the production STL reader over
 * the production STL writer's output. That is the right check — the file has to
 * open where a user's import opens — but on its own it proves only that the two
 * agree. A shared misunderstanding is invisible to it: a writer that wrote the
 * triangle count big-endian and a reader that read it big-endian would round
 * trip perfectly and produce a file no slicer could open.
 *
 * So this reads the container by hand, from the format's own definition:
 * 80 header bytes, a little-endian `uint32` count, then exactly 50 bytes per
 * facet. It builds no mesh, resolves no topology and knows nothing about parts
 * — it answers "is this a well-formed binary STL, and what is in it", which is
 * the question the production reader cannot be asked about itself.
 *
 * IT MUST NEVER BECOME A SECOND PRODUCTION PARSER. A boundary test keeps it out
 * of `apps/**` and `packages/**` production code.
 */

const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
const PREFIX_BYTES = HEADER_BYTES + COUNT_BYTES;
const FACET_BYTES = 50;

export interface StlFacet {
  readonly normal: readonly [number, number, number];
  /** Nine floats: three corners, XYZ each, in file order. */
  readonly corners: readonly number[];
  readonly attributeByteCount: number;
}

export interface StlInspection {
  readonly byteLength: number;
  /** The count the header DECLARES, which is not necessarily the truth. */
  readonly declaredTriangles: number;
  /** The count the file's LENGTH implies. Equal to the above in a sound file. */
  readonly impliedTriangles: number;
  readonly header: string;
  readonly facets: readonly StlFacet[];
  /** Every reason this is not a sound binary STL. Empty means sound. */
  readonly problems: readonly string[];
}

export function inspectBinaryStl(bytes: Uint8Array): StlInspection {
  const problems: string[] = [];

  if (bytes.byteLength < PREFIX_BYTES) {
    return {
      byteLength: bytes.byteLength,
      declaredTriangles: 0,
      impliedTriangles: 0,
      header: '',
      facets: [],
      problems: [`file is shorter than the ${String(PREFIX_BYTES)}-byte prefix`],
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredTriangles = view.getUint32(HEADER_BYTES, true);
  const bodyBytes = bytes.byteLength - PREFIX_BYTES;
  const impliedTriangles = Math.floor(bodyBytes / FACET_BYTES);

  if (bodyBytes % FACET_BYTES !== 0) {
    problems.push(`body is ${String(bodyBytes)} bytes, not a multiple of ${String(FACET_BYTES)}`);
  }
  if (declaredTriangles !== impliedTriangles) {
    problems.push(
      `header declares ${String(declaredTriangles)} triangles, length implies ${String(impliedTriangles)}`,
    );
  }

  let header = '';
  for (let index = 0; index < HEADER_BYTES; index += 1) {
    const code = bytes[index] ?? 0;
    if (code === 0) break;
    header += String.fromCharCode(code);
  }

  /*
   * "solid" AT THE START OF A BINARY FILE is the classic ambiguity that makes
   * a binary STL look like an ASCII one to a naive reader. Reported rather than
   * assumed absent, so a header change that reintroduced it is caught here.
   */
  if (header.trimStart().toLowerCase().startsWith('solid')) {
    problems.push('binary header begins with "solid", which reads as ASCII STL');
  }

  const facets: StlFacet[] = [];
  for (let triangle = 0; triangle < impliedTriangles; triangle += 1) {
    const at = PREFIX_BYTES + triangle * FACET_BYTES;
    const normal: [number, number, number] = [
      view.getFloat32(at, true),
      view.getFloat32(at + 4, true),
      view.getFloat32(at + 8, true),
    ];
    const corners: number[] = [];
    for (let value = 0; value < 9; value += 1) {
      corners.push(view.getFloat32(at + 12 + value * 4, true));
    }
    const attributeByteCount = view.getUint16(at + 48, true);

    for (const value of [...normal, ...corners]) {
      if (!Number.isFinite(value)) {
        problems.push(`facet ${String(triangle)} contains a non-finite value`);
        break;
      }
    }

    facets.push({ normal, corners, attributeByteCount });
  }

  return {
    byteLength: bytes.byteLength,
    declaredTriangles,
    impliedTriangles,
    header,
    facets,
    problems,
  };
}

/** Throws with every problem at once, rather than one assertion at a time. */
export function checkBinaryStlStructure(bytes: Uint8Array): StlInspection {
  const inspection = inspectBinaryStl(bytes);
  if (inspection.problems.length > 0) {
    throw new Error(`binary STL is not well formed: ${inspection.problems.join('; ')}`);
  }
  return inspection;
}
