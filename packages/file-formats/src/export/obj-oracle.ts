/**
 * AN INDEPENDENT STRUCTURAL VIEW OF AN OBJ FILE. TEST-ONLY.
 *
 * WHY THIS EXISTS. Parse-back validation runs the production reader over the
 * production writer's output. That is the right check — the file has to open
 * where a user's import opens — but on its own it proves only that the two
 * agree. A shared misunderstanding is invisible to it: a writer that emitted
 * zero-based face indices and a reader that accepted them would round-trip
 * perfectly and produce a file no other tool could read.
 *
 * So this counts records with a deliberately dumb line scan. It is NOT a second
 * production parser and must never become one: it builds no geometry, resolves
 * no indices into vertices, and knows nothing about parts or transforms. It
 * answers "what records are in this text", which is exactly the question the
 * production reader cannot be asked to answer about itself.
 */

export interface ObjInspection {
  readonly vertexCount: number;
  readonly faceCount: number;
  readonly objects: readonly string[];
  readonly groups: readonly string[];
  readonly materials: readonly string[];
  readonly mtllib: string | undefined;
  /** Every face's corner tokens, in file order. */
  readonly faces: readonly (readonly string[])[];
  /** Lines whose first token is none of the records this writer emits. */
  readonly unexpectedRecords: readonly string[];
}

const EXPECTED = new Set(['v', 'f', 'o', 'g', 'usemtl', 'mtllib', '#']);

export function inspectObj(bytes: Uint8Array): ObjInspection {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

  let vertexCount = 0;
  const objects: string[] = [];
  const groups: string[] = [];
  const materials: string[] = [];
  const faces: string[][] = [];
  const unexpectedRecords: string[] = [];
  let mtllib: string | undefined;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0) continue;

    const space = line.indexOf(' ');
    const keyword = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? '' : line.slice(space + 1).trim();

    if (line.startsWith('#')) continue;

    switch (keyword) {
      case 'v':
        vertexCount += 1;
        break;
      case 'f':
        faces.push(rest.split(/\s+/).filter((token) => token.length > 0));
        break;
      case 'o':
        objects.push(rest);
        break;
      case 'g':
        groups.push(rest);
        break;
      case 'usemtl':
        materials.push(rest);
        break;
      case 'mtllib':
        mtllib = rest;
        break;
      default:
        if (!EXPECTED.has(keyword)) unexpectedRecords.push(keyword);
    }
  }

  return {
    vertexCount,
    faceCount: faces.length,
    objects,
    groups,
    materials,
    mtllib,
    faces,
    unexpectedRecords,
  };
}

/**
 * Checks the structural invariants a valid OBJ must satisfy, independently of
 * what any reader would accept.
 *
 * Returns the problems it found, so a test asserts on an empty array rather
 * than on a boolean that hides which rule broke.
 */
export function checkObjStructure(inspection: ObjInspection): readonly string[] {
  const problems: string[] = [];

  if (inspection.unexpectedRecords.length > 0) {
    problems.push(`unexpected records: ${[...new Set(inspection.unexpectedRecords)].join(',')}`);
  }

  for (const [at, face] of inspection.faces.entries()) {
    if (face.length !== 3) {
      problems.push(`face ${String(at)} has ${String(face.length)} corners`);
      continue;
    }
    for (const corner of face) {
      const token = corner.split('/')[0] ?? '';
      const index = Number(token);
      if (!Number.isInteger(index)) {
        problems.push(`face ${String(at)} corner "${corner}" is not an integer`);
        continue;
      }
      // OBJ indices are ONE-BASED. Zero is not a vertex, and a negative index
      // is a relative reference this writer deliberately never emits.
      if (index <= 0) problems.push(`face ${String(at)} uses non-positive index ${String(index)}`);
      if (index > inspection.vertexCount) {
        problems.push(
          `face ${String(at)} references vertex ${String(index)} of ${String(inspection.vertexCount)}`,
        );
      }
    }
  }

  return problems;
}
