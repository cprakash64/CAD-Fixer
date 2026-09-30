import { readObjRecordStream } from './obj-records';
import {
  createIndexArray,
  DEFAULT_DOCUMENT_LIMITS,
  createPositionArray,
  partId,
  IDENTITY_PART_TRANSFORM,
  type CanonicalMesh,
  type GeometryDocument,
  type GeometryPart,
  type MeshGroup,
} from '@cadfixer/mesh-core';
import { diagnostic, throwIfCancelled, type Diagnostic } from '@cadfixer/shared';
import type { FormatReadContext } from '../context';
import { MeshFormatId } from '../formats';
import {
  EMPTY_COMPATIBILITY,
  UnsupportedFeature,
  type DocumentReadResult,
  type ImportCompatibility,
} from '../document-reader';
import { ImportRefusal, importMalformed, importTooLarge } from '../import-errors';
import { DEFAULT_OBJ_LIMITS, type ObjLimits } from './limits';

/**
 * THE PRODUCTION OBJ READER.
 *
 * Semantically equivalent to the qualified research parser in
 * `experiments/format-io/obj.mjs`, and structurally different in three ways
 * that the research deliberately did not have to care about:
 *
 *   1. it REFUSES on the first problem rather than collecting a refusal list.
 *      Research wanted to characterise a corpus; production has one file and
 *      one user, and "the import failed, here is why" beats a list of the
 *      seventeen further ways it would also have failed;
 *   2. it produces a `GeometryDocument`, so `o` records become parts;
 *   3. it scans line by line without materialising a line array, polls
 *      cancellation, and yields — a 50 MiB `split()` is a second copy of the
 *      file and a point at which nothing can be interrupted.
 *
 * NO SILENT REPAIR, unchanged from research and from every codec here: a
 * malformed index is refused, not clamped; a polygon is refused, not fanned.
 */

interface ObjObjectRecord {
  readonly name: string | undefined;
  /** Index into `faces` where this object's faces begin. */
  readonly firstFace: number;
}

interface ObjGroupRecord {
  readonly name: string;
  readonly firstFace: number;
  readonly material: string | undefined;
}

interface ParsedObj {
  readonly positions: number[];
  /** Three position indices per face, already resolved to zero-based. */
  readonly faceIndices: number[];
  readonly objects: ObjObjectRecord[];
  readonly groups: ObjGroupRecord[];
  readonly mtllib: string | undefined;
  readonly sawMaterialUse: boolean;
}

function decodeText(
  bytes: Uint8Array,
  limits: ObjLimits,
  decode: (input: Uint8Array) => string,
): string {
  if (bytes.byteLength > limits.maxBytes) {
    throw importTooLarge(
      ImportRefusal.InputTooLarge,
      'This OBJ file is larger than Pybrix will open.',
      { bytes: bytes.byteLength, limit: limits.maxBytes },
    );
  }
  return decode(bytes);
}

/** Import collects the shared production records into its document builder. */
async function parseRecords(
  text: string,
  limits: ObjLimits,
  context: FormatReadContext,
  progressFrom: number,
  progressTo: number,
): Promise<ParsedObj> {
  const positions: number[] = [];
  const faceIndices: number[] = [];
  const objects: ObjObjectRecord[] = [];
  const groups: ObjGroupRecord[] = [];
  let mtllib: string | undefined;
  let sawMaterialUse = false;
  async function* pieces(): AsyncIterable<string> {
    yield await Promise.resolve(text);
  }
  await readObjRecordStream(
    pieces(),
    limits,
    context,
    {
      vertex: (x, y, z) => {
        positions.push(x, y, z);
      },
      face: (a, b, c) => {
        faceIndices.push(a, b, c);
      },
      object: (name, firstFace) => {
        objects.push({ name, firstFace });
      },
      group: (name, material, firstFace) => {
        groups.push({ name, material, firstFace });
      },
      materialUse: () => {
        sawMaterialUse = true;
      },
      materialLibrary: (name) => {
        mtllib = name;
      },
    },
    (characters) => {
      context.progress.report(
        progressFrom + ((progressTo - progressFrom) * characters) / Math.max(1, text.length),
        'parsing',
      );
    },
  );
  return { positions, faceIndices, objects, groups, mtllib, sawMaterialUse };
}

/* ------------------------------------------------------------- assembly -- */

interface PartPlan {
  readonly name: string | undefined;
  readonly firstFace: number;
  readonly faceCount: number;
}

/**
 * Decides which faces belong to which part.
 *
 * FROZEN MAPPING (ADR 0013): `o` becomes a part, `g` becomes a group inside
 * one, and a disconnected shell becomes NEITHER — splitting a shell is a future
 * Split feature, not an import decision.
 *
 * The cases the format leaves open, decided deterministically here:
 *
 *   - NO `o` AT ALL: one part. The commonest OBJ in the world has no object
 *     record, and inventing several from connectivity would be exactly the
 *     shell-splitting the ADR rules out.
 *   - FACES BEFORE THE FIRST `o`: they become a leading unnamed part rather
 *     than being attached to the first named object, which would put geometry
 *     under a name the file never gave it.
 *   - AN `o` WITH NO FACES: no part. A part with nothing in it would appear in
 *     the selector, be selectable, and have nothing to show.
 *   - REPEATED NAMES: kept as written. Names are display metadata; identity is
 *     the generated `PartId`, so two objects called `Cube` are two parts.
 */
function planParts(parsed: ParsedObj, totalFaces: number): readonly PartPlan[] {
  if (parsed.objects.length === 0) {
    return totalFaces === 0 ? [] : [{ name: undefined, firstFace: 0, faceCount: totalFaces }];
  }

  const plans: PartPlan[] = [];
  const leading = parsed.objects[0]?.firstFace ?? 0;
  if (leading > 0) plans.push({ name: undefined, firstFace: 0, faceCount: leading });

  for (let index = 0; index < parsed.objects.length; index += 1) {
    const record = parsed.objects[index];
    if (record === undefined) continue;
    const next = parsed.objects[index + 1]?.firstFace ?? totalFaces;
    const faceCount = next - record.firstFace;
    if (faceCount <= 0) continue;
    plans.push({ name: record.name, firstFace: record.firstFace, faceCount });
  }
  return plans;
}

/**
 * Builds one part's mesh as an indexed triangle soup over the file's vertices.
 *
 * THE POSITION BUFFER IS PER PART, not the whole file's. An OBJ shares one
 * vertex pool across every object, so a part that uses a tenth of the vertices
 * would otherwise carry all of them — and every downstream count, byte figure
 * and bounding box would describe the file rather than the part.
 */
function buildPartMesh(
  parsed: ParsedObj,
  plan: PartPlan,
  groups: readonly MeshGroup[],
): CanonicalMesh {
  const from = plan.firstFace * 3;
  const to = from + plan.faceCount * 3;

  const remap = new Map<number, number>();
  const indices = createIndexArray(plan.faceCount * 3);
  let nextLocal = 0;
  for (let at = from; at < to; at += 1) {
    const source = parsed.faceIndices[at] ?? 0;
    let local = remap.get(source);
    if (local === undefined) {
      local = nextLocal;
      nextLocal += 1;
      remap.set(source, local);
    }
    indices[at - from] = local;
  }

  const positions = createPositionArray(nextLocal * 3);
  for (const [source, local] of remap) {
    /*
     * ONE ASSIGNMENT PER COMPONENT, from a JS number into a Float32Array.
     *
     * That assignment IS the Float32 conversion, and it is the same one the STL
     * readers make. No intermediate rounding, no `toFixed`, no re-parse: the
     * decimal text became a Float64 in `Number()` and becomes a Float32 exactly
     * once, here.
     */
    positions[local * 3] = parsed.positions[source * 3] ?? 0;
    positions[local * 3 + 1] = parsed.positions[source * 3 + 1] ?? 0;
    positions[local * 3 + 2] = parsed.positions[source * 3 + 2] ?? 0;
  }

  return {
    positions,
    indices,
    ...(groups.length > 0 ? { groups } : {}),
    metadata: { sourceFormat: MeshFormatId.Obj },
  };
}

/** The `g` and `usemtl` runs that fall inside one part, clipped to it. */
function groupsFor(parsed: ParsedObj, plan: PartPlan, limits: ObjLimits): readonly MeshGroup[] {
  const partEnd = plan.firstFace + plan.faceCount;
  const out: MeshGroup[] = [];

  for (let index = 0; index < parsed.groups.length; index += 1) {
    const record = parsed.groups[index];
    if (record === undefined) continue;
    const start = Math.max(record.firstFace, plan.firstFace);
    const nextStart = parsed.groups[index + 1]?.firstFace ?? partEnd;
    const end = Math.min(nextStart, partEnd);
    if (end <= start) continue;

    out.push({
      name: record.name.slice(0, limits.maxNameLength),
      indexOffset: (start - plan.firstFace) * 3,
      indexCount: (end - start) * 3,
      ...(record.material === undefined ? {} : { materialRef: record.material }),
    });
  }
  return out;
}

export async function readObj(
  bytes: Uint8Array,
  context: FormatReadContext,
  limits: ObjLimits = DEFAULT_OBJ_LIMITS,
): Promise<DocumentReadResult> {
  context.progress.report(0, 'reading');
  const text = decodeText(bytes, limits, context.decodeText);
  throwIfCancelled(context.cancellation);

  const parsed = await parseRecords(text, limits, context, 0.05, 0.8);
  throwIfCancelled(context.cancellation);
  context.progress.report(0.8, 'building document');

  const totalFaces = parsed.faceIndices.length / 3;
  const plans = planParts(parsed, totalFaces);

  if (plans.length === 0) {
    /*
     * A FILE WITH NO FACES IS REFUSED, not imported as an empty document.
     * Committing one would put a model on screen with nothing in it, and every
     * workflow would then have to explain why it could do nothing with it.
     */
    throw importMalformed(
      ImportRefusal.ObjNoGeometry,
      'This OBJ file contains no triangles, so there is nothing to import.',
      { vertices: parsed.positions.length / 3 },
    );
  }

  /*
   * REFUSED BEFORE A SINGLE MESH IS BUILT.
   *
   * `planParts` produces names and face ranges — a few numbers per part — so an
   * over-large OBJ is known to be over-large before any geometry exists. Doing
   * this after the loop below would allocate a position and index array per
   * part, walk the file's vertex pool once per part, and then discard all of it
   * when `assertGeometryDocument` refused the result.
   *
   * The ceiling is the DOCUMENT'S, read from `mesh-core`, for the same reason
   * the 3MF expander uses it: the document is what has to hold the result.
   */
  if (plans.length > DEFAULT_DOCUMENT_LIMITS.maxParts) {
    throw importTooLarge(
      ImportRefusal.ObjTooManyObjects,
      'This OBJ file declares more objects than Pybrix will hold.',
      { limit: DEFAULT_DOCUMENT_LIMITS.maxParts, planned: plans.length },
    );
  }

  const parts: GeometryPart[] = [];
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    if (plan === undefined) continue;
    /*
     * PART IDS ARE GENERATED FROM TRAVERSAL ORDER, never from the file's names.
     * Names may repeat, be empty, or be a kilobyte of hostile text; identity
     * has to be unique, short and ours. The name travels as display metadata.
     */
    parts.push({
      id: partId(`part-${String(index + 1)}`),
      mesh: buildPartMesh(parsed, plan, groupsFor(parsed, plan, limits)),
      transform: IDENTITY_PART_TRANSFORM,
      ...(plan.name === undefined || plan.name === '' ? {} : { name: plan.name }),
    });
    throwIfCancelled(context.cancellation);
  }

  /*
   * UNIT IS ABSENT, not defaulted.
   *
   * OBJ has no standardised unit record, so the honest statement is "the source
   * did not say". Defaulting to millimetres would invent information about the
   * user's model, and coordinates are never rescaled on import in any case.
   */
  const document: GeometryDocument = { parts };

  const warnings: Diagnostic[] = [];
  const unsupported: UnsupportedFeature[] = [];
  const externalReferences: string[] = [];

  if (parsed.mtllib !== undefined && parsed.mtllib !== '') {
    unsupported.push(UnsupportedFeature.ExternalMaterialLibrary);
    externalReferences.push(parsed.mtllib);
    warnings.push(
      diagnostic(
        'OBJ_MTLLIB_NOT_LOADED',
        'This OBJ file names a material library. Pybrix imports geometry only and does not open it, so materials and colours are not loaded.',
        { library: parsed.mtllib.slice(0, 128) },
      ),
    );
  } else if (parsed.sawMaterialUse) {
    // `usemtl` without `mtllib`: the references are kept as opaque group
    // metadata and nothing is resolved, which is worth saying once.
    unsupported.push(UnsupportedFeature.Materials);
  }

  const compatibility: ImportCompatibility =
    unsupported.length === 0 && externalReferences.length === 0
      ? EMPTY_COMPATIBILITY
      : { unsupported, externalReferences };

  context.progress.report(1, 'complete');
  return { document, encoding: 'text', warnings, compatibility };
}
