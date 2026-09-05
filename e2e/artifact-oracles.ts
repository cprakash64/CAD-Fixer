import { inflateRawSync } from 'node:zlib';

/**
 * STRUCTURAL READERS FOR DOWNLOADED ARTIFACTS. TEST-PROCESS ONLY.
 *
 * WHY THESE EXIST. The end-to-end suite has two independent ways to check an
 * exported file and needs both:
 *
 *   1. RE-IMPORT IT. Feeding the downloaded bytes back through the file chooser
 *      exercises the real production reader in the real application, which is
 *      the strongest evidence that the file opens — but it can only tell us
 *      what the UI shows.
 *   2. READ IT HERE. These do the second half: they answer questions about the
 *      FILE that the application never displays — how many `o` records an OBJ
 *      has, what `unit` attribute a 3MF declares, whether an STL's header count
 *      matches its length.
 *
 * They share no code with the production readers, deliberately, for the same
 * reason `obj-oracle.ts` and `stl-oracle.ts` do: our reader agreeing with our
 * writer proves only that they agree.
 *
 * They are DELIBERATELY DUMB. No geometry is built, no index is resolved, and
 * nothing here is or may become a parser the product uses.
 */

/* -------------------------------------------------------------------- stl -- */

const STL_PREFIX_BYTES = 84;
const STL_FACET_BYTES = 50;

export interface StlArtifact {
  readonly byteLength: number;
  readonly declaredTriangles: number;
  readonly header: string;
  /** Every facet's nine corner floats, in file order. */
  readonly corners: readonly number[];
  readonly normals: readonly (readonly [number, number, number])[];
}

export function readStlArtifact(bytes: Buffer): StlArtifact {
  if (bytes.byteLength < STL_PREFIX_BYTES) {
    throw new Error(`not a binary STL: ${String(bytes.byteLength)} bytes`);
  }
  const declaredTriangles = bytes.readUInt32LE(80);
  const body = bytes.byteLength - STL_PREFIX_BYTES;
  if (body % STL_FACET_BYTES !== 0) {
    throw new Error(`STL body is ${String(body)} bytes, not a multiple of 50`);
  }
  if (body / STL_FACET_BYTES !== declaredTriangles) {
    throw new Error(
      `STL header declares ${String(declaredTriangles)} triangles, length implies ${String(body / STL_FACET_BYTES)}`,
    );
  }

  const corners: number[] = [];
  const normals: [number, number, number][] = [];
  for (let triangle = 0; triangle < declaredTriangles; triangle += 1) {
    const at = STL_PREFIX_BYTES + triangle * STL_FACET_BYTES;
    normals.push([bytes.readFloatLE(at), bytes.readFloatLE(at + 4), bytes.readFloatLE(at + 8)]);
    for (let value = 0; value < 9; value += 1) {
      corners.push(bytes.readFloatLE(at + 12 + value * 4));
    }
  }

  let header = '';
  for (let index = 0; index < 80; index += 1) {
    const code = bytes[index] ?? 0;
    if (code === 0) break;
    header += String.fromCharCode(code);
  }

  return { byteLength: bytes.byteLength, declaredTriangles, header, corners, normals };
}

/* -------------------------------------------------------------------- obj -- */

export interface ObjArtifact {
  readonly vertexCount: number;
  readonly faceCount: number;
  readonly objects: readonly string[];
  readonly groups: readonly string[];
  readonly materials: readonly string[];
  readonly hasMtllib: boolean;
  /** Every `v` record's three numbers, in file order. */
  readonly vertices: readonly (readonly [number, number, number])[];
}

export function readObjArtifact(bytes: Buffer): ObjArtifact {
  const objects: string[] = [];
  const groups: string[] = [];
  const materials: string[] = [];
  const vertices: [number, number, number][] = [];
  let faceCount = 0;
  let hasMtllib = false;

  for (const rawLine of bytes.toString('utf8').split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const space = line.indexOf(' ');
    const keyword = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? '' : line.slice(space + 1).trim();

    switch (keyword) {
      case 'v': {
        const parts = rest.split(/\s+/).map(Number);
        vertices.push([parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]);
        break;
      }
      case 'f':
        faceCount += 1;
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
        hasMtllib = true;
        break;
      default:
        break;
    }
  }

  return {
    vertexCount: vertices.length,
    faceCount,
    objects,
    groups,
    materials,
    hasMtllib,
    vertices,
  };
}

/* -------------------------------------------------------------------- 3mf -- */

/**
 * A minimal ZIP reader, from the End of Central Directory backwards.
 *
 * Bounded and deliberately unforgiving: it reads what our writer emits and
 * throws on anything else. It is not a general archive reader and must not
 * become one.
 */
function readZipEntries(bytes: Buffer): ReadonlyMap<string, Buffer> {
  const EOCD_SIGNATURE = 0x0605_4b50;
  let eocd = -1;
  for (let at = bytes.byteLength - 22; at >= 0; at -= 1) {
    if (bytes.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error('no ZIP end-of-central-directory record');

  const count = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(at) !== 0x0201_4b50) throw new Error('bad central directory header');
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localOffset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');

    if (bytes.readUInt32LE(localOffset) !== 0x0403_4b50) throw new Error('bad local file header');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataAt = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataAt, dataAt + compressedSize);

    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export interface ThreeMfObject {
  readonly id: string;
  readonly name: string | undefined;
  readonly materialRef: string | undefined;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly vertices: readonly (readonly [number, number, number])[];
}

export interface ThreeMfArtifact {
  readonly entryNames: readonly string[];
  readonly modelXml: string;
  readonly unit: string | undefined;
  readonly objects: readonly ThreeMfObject[];
  /** Every `<item>`: which object it places and its transform text. */
  readonly items: readonly { readonly objectId: string; readonly transform: string | undefined }[];
  /**
   * Every property reference the file makes, and every property resource it
   * declares.
   *
   * CARRIED SO A DOWNLOAD TEST CAN CHECK THE RELATIONSHIP. CAD Fixer shipped a
   * writer that emitted `pid="5"` with no resource 5, and every structural check
   * it had — ZIP, CRC, XML well-formedness — passed the file.
   */
  readonly propertyReferences: readonly string[];
  readonly propertyResourceIds: readonly string[];
  /** Empty when every reference resolves. */
  readonly referenceProblems: readonly string[];
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match?.[1];
}

export function readThreeMfArtifact(bytes: Buffer): ThreeMfArtifact {
  const entries = readZipEntries(bytes);
  const model = entries.get('3D/3dmodel.model');
  if (model === undefined) throw new Error('3MF has no 3D/3dmodel.model entry');
  const xml = model.toString('utf8');

  const modelTag = /<model[^>]*>/.exec(xml)?.[0] ?? '';
  const unit = attribute(modelTag, 'unit');

  const objects: ThreeMfObject[] = [];
  for (const block of xml.match(/<object[\s\S]*?<\/object>/g) ?? []) {
    const openTag = /<object[^>]*>/.exec(block)?.[0] ?? '';
    const vertices: [number, number, number][] = [];
    for (const vertex of block.match(/<vertex[^>]*\/>/g) ?? []) {
      vertices.push([
        Number(attribute(vertex, 'x') ?? '0'),
        Number(attribute(vertex, 'y') ?? '0'),
        Number(attribute(vertex, 'z') ?? '0'),
      ]);
    }
    objects.push({
      id: attribute(openTag, 'id') ?? '',
      name: attribute(openTag, 'name'),
      materialRef: attribute(openTag, 'pid'),
      vertexCount: vertices.length,
      triangleCount: (block.match(/<triangle[^>]*\/>/g) ?? []).length,
      vertices,
    });
  }

  const items = (xml.match(/<item[^>]*\/>/g) ?? []).map((tag) => ({
    objectId: attribute(tag, 'objectid') ?? '',
    ...(attribute(tag, 'transform') === undefined
      ? { transform: undefined }
      : { transform: attribute(tag, 'transform') }),
  }));

  /*
   * THE SEMANTIC CHECK THE ORIGINAL ORACLE LACKED.
   *
   * A resource id is a positive integer, and a `pid` names a PROPERTY GROUP
   * that must exist. Both halves matter: CAD Fixer emitted `pid="5"` with no
   * resource 5, and `pid="steel-brushed"`, which is not an id at all.
   */
  const propertyResourceIds: string[] = [];
  for (const element of [
    'basematerials',
    'colorgroup',
    'texture2dgroup',
    'multiproperties',
    'compositematerials',
  ]) {
    for (const tag of xml.match(new RegExp(`<${element}\\b[^>]*>`, 'g')) ?? []) {
      const id = attribute(tag, 'id');
      if (id !== undefined) propertyResourceIds.push(id);
    }
  }

  const propertyReferences: string[] = [];
  for (const tag of [
    ...(xml.match(/<object\b[^>]*>/g) ?? []),
    ...(xml.match(/<triangle\b[^>]*\/>/g) ?? []),
  ]) {
    const pid = attribute(tag, 'pid');
    if (pid !== undefined) propertyReferences.push(pid);
  }

  const referenceProblems: string[] = [];
  for (const pid of propertyReferences) {
    if (!/^[1-9][0-9]*$/.test(pid)) {
      referenceProblems.push(`pid "${pid}" is not a positive integer resource id`);
      continue;
    }
    if (!propertyResourceIds.includes(pid)) {
      referenceProblems.push(`pid "${pid}" references no property group resource`);
    }
  }

  return {
    entryNames: [...entries.keys()],
    modelXml: xml,
    unit,
    objects,
    items,
    propertyReferences,
    propertyResourceIds,
    referenceProblems,
  };
}
