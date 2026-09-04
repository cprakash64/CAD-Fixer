import {
  createIndexArray,
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
import {
  ImportRefusal,
  importMalformed,
  importTooLarge,
  importUnsupported,
} from '../import-errors';
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

/** Corners handled between cancellation polls and event-loop yields. */
const FACES_PER_BATCH = 32_768;

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
      'This OBJ file is larger than CAD Fixer will open.',
      { bytes: bytes.byteLength, limit: limits.maxBytes },
    );
  }
  return decode(bytes);
}

/** A finite number, or a refusal naming the token that was not one. */
function readFinite(token: string | undefined, line: number, what: string): number {
  if (token === undefined || token === '') {
    throw importMalformed(
      ImportRefusal.ObjMalformedNumber,
      `This OBJ file has a ${what} value missing on line ${String(line)}.`,
      { line, what },
    );
  }
  const value = Number(token);
  /*
   * `Number` rather than `parseFloat`, deliberately. `parseFloat('1abc')` is 1,
   * which would silently accept a corrupt token; `Number('1abc')` is NaN. Both
   * accept 'Infinity' and 'NaN' as words, and neither has a bounding box or an
   * exact predicate, so both are refused below.
   */
  if (!Number.isFinite(value)) {
    throw importMalformed(
      ImportRefusal.ObjNonFinite,
      `This OBJ file has a ${what} value CAD Fixer cannot use on line ${String(line)}.`,
      { line, what, token: token.slice(0, 64) },
    );
  }
  return value;
}

/**
 * Splits a whitespace-separated record without allocating for the whole line.
 *
 * `line.split(/\s+/)` on a 65,536-character line allocates an array of every
 * token whether the caller wants them or not. This yields them.
 */
function* tokens(line: string, from: number): Generator<string, undefined, undefined> {
  let index = from;
  const length = line.length;
  while (index < length) {
    while (index < length && isSpace(line.charCodeAt(index))) index += 1;
    if (index >= length) return;
    const start = index;
    while (index < length && !isSpace(line.charCodeAt(index))) index += 1;
    yield line.slice(start, index);
  }
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 13;
}

/**
 * Parses the records, resolving face indices as it goes.
 *
 * NEGATIVE INDICES ARE RELATIVE to the vertices seen SO FAR, which is why they
 * cannot be resolved in a second pass: `-1` means a different vertex on every
 * line it appears.
 */
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
  let currentMaterial: string | undefined;
  let sawMaterialUse = false;
  let faceCount = 0;

  let lineNumber = 0;
  let cursor = 0;
  const length = text.length;

  while (cursor <= length) {
    let end = text.indexOf('\n', cursor);
    if (end === -1) end = length;
    // A trailing '\r' belongs to the separator, not to the record.
    const stop = end > cursor && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const lineLength = stop - cursor;
    lineNumber += 1;

    if (lineLength > limits.maxLineLength) {
      throw importTooLarge(
        ImportRefusal.ObjLineTooLong,
        `This OBJ file has a line longer than CAD Fixer will read (line ${String(lineNumber)}).`,
        { line: lineNumber, length: lineLength, limit: limits.maxLineLength },
      );
    }

    if (lineLength > 0) {
      const line = text.slice(cursor, stop);
      let at = 0;
      while (at < line.length && isSpace(line.charCodeAt(at))) at += 1;
      const first = line.charCodeAt(at);

      // Blank lines and comments, cheapest checks first.
      if (at < line.length && first !== 35 /* # */) {
        const iterator = tokens(line, at);
        const keyword: string | undefined = iterator.next().value;

        switch (keyword) {
          case 'v': {
            positions.push(
              readFinite(nextToken(iterator), lineNumber, 'x'),
              readFinite(nextToken(iterator), lineNumber, 'y'),
              readFinite(nextToken(iterator), lineNumber, 'z'),
            );
            if (positions.length / 3 > limits.maxVertices) {
              throw importTooLarge(
                ImportRefusal.ObjTooManyVertices,
                'This OBJ file contains more vertices than CAD Fixer will hold.',
                { limit: limits.maxVertices },
              );
            }
            break;
          }

          /*
           * `vn` and `vt` are PARSED FOR VALIDITY AND DISCARDED.
           *
           * ADR 0013 froze normals and UVs as "parsed, not authoritative;
           * recomputed as today". Stored normals frequently disagree with
           * winding order — the same reason STL's facet normals are dropped —
           * and a UV has no bearing on topology, repair or export at this
           * stage. Retaining them would mean carrying buffers no code reads and
           * claiming a fidelity the product does not have. They are still
           * validated, so a file with a NaN normal is refused rather than
           * quietly accepted.
           */
          case 'vn': {
            readFinite(nextToken(iterator), lineNumber, 'normal x');
            readFinite(nextToken(iterator), lineNumber, 'normal y');
            readFinite(nextToken(iterator), lineNumber, 'normal z');
            break;
          }
          case 'vt': {
            readFinite(nextToken(iterator), lineNumber, 'texture u');
            const v = nextToken(iterator);
            // `vt` legally carries one, two or three values.
            if (v !== undefined) readFinite(v, lineNumber, 'texture v');
            break;
          }

          case 'o': {
            const name = readName(iterator, limits);
            objects.push({ name, firstFace: faceCount });
            if (objects.length > limits.maxObjects) {
              throw importTooLarge(
                ImportRefusal.ObjTooManyObjects,
                'This OBJ file declares more objects than CAD Fixer will hold.',
                { limit: limits.maxObjects },
              );
            }
            break;
          }

          case 'g': {
            const name = readName(iterator, limits) ?? '';
            groups.push({ name, firstFace: faceCount, material: currentMaterial });
            if (groups.length > limits.maxGroups) {
              throw importTooLarge(
                ImportRefusal.ObjTooManyGroups,
                'This OBJ file declares more groups than CAD Fixer will hold.',
                { limit: limits.maxGroups },
              );
            }
            break;
          }

          case 'usemtl': {
            currentMaterial = readName(iterator, limits);
            sawMaterialUse = true;
            // A material change starts a new run of faces, which is what a
            // `MeshGroup` records. Without this a file that never says `g`
            // would lose its material boundaries entirely.
            groups.push({
              name: currentMaterial ?? '',
              firstFace: faceCount,
              material: currentMaterial,
            });
            break;
          }

          case 'mtllib': {
            /*
             * RECORDED AS TEXT. NEVER OPENED.
             *
             * No file is read, no path is resolved, no picker is raised and no
             * request is made. A standalone OBJ therefore cannot cause any file
             * or network access, which is the property that made a single-file
             * picker sufficient for this stage — see ADR 0013.
             */
            mtllib = readName(iterator, limits);
            break;
          }

          case 'f': {
            faceCount += 1;
            readFace(iterator, faceIndices, positions.length / 3, lineNumber, limits);
            if (faceCount > limits.maxFaces) {
              throw importTooLarge(
                ImportRefusal.ObjTooManyFaces,
                'This OBJ file contains more faces than CAD Fixer will hold.',
                { limit: limits.maxFaces },
              );
            }
            if (faceCount % FACES_PER_BATCH === 0) {
              /*
               * THE CANCELLATION POINT, and it is a real one. The token is
               * polled AND the event loop is released, so a cancel that arrived
               * as a message can actually be read. Polling a flag without
               * yielding would be cancellation that cannot happen — see
               * docs/ARCHITECTURE.md.
               */
              throwIfCancelled(context.cancellation);
              await context.yieldToEventLoop();
              throwIfCancelled(context.cancellation);
              context.progress.report(
                progressFrom + ((progressTo - progressFrom) * cursor) / Math.max(1, length),
                'parsing',
              );
            }
            break;
          }

          default:
            // Unknown records are SKIPPED, not refused. OBJ is an extensible
            // text format and files in the wild carry `s`, `l`, `p`, `mg` and
            // vendor records; refusing a file for a line that says nothing
            // about geometry would reject valid models for no benefit.
            break;
        }
      }
    }

    cursor = end + 1;
    if (end >= length) break;
  }

  return { positions, faceIndices, objects, groups, mtllib, sawMaterialUse };
}

/** The next token, typed. `Generator.next().value` is `any` without this. */
function nextToken(iterator: Generator<string, undefined, undefined>): string | undefined {
  const next = iterator.next();
  return next.done === true ? undefined : next.value;
}

function readName(
  iterator: Generator<string, undefined, undefined>,
  limits: ObjLimits,
): string | undefined {
  const parts: string[] = [];
  for (const token of iterator) {
    parts.push(token);
    if (parts.join(' ').length >= limits.maxNameLength) break;
  }
  if (parts.length === 0) return undefined;
  // TRUNCATED, not refused. A long name is a display nuisance, not a
  // structural fault, and refusing a whole model over one would be the wrong
  // trade. It is text throughout and is never treated as markup or as a path.
  return parts.join(' ').slice(0, limits.maxNameLength);
}

/** Reads one `f` record, refusing anything that is not exactly a triangle. */
function readFace(
  iterator: Generator<string, undefined, undefined>,
  out: number[],
  vertexCount: number,
  line: number,
  limits: ObjLimits,
): void {
  const corners: string[] = [];
  for (const token of iterator) {
    corners.push(token);
    if (corners.length > limits.maxFaceVertices) {
      /*
       * THE POLYGON DECISION, enforced rather than worked around. Reading stops
       * at the first corner past the limit: a hostile `f` with a million
       * corners costs four tokens, not a million.
       */
      throw importUnsupported(
        ImportRefusal.ObjPolygonUnsupported,
        'CAD Fixer currently supports triangle faces in OBJ files. This file contains a face with more than three corners, and CAD Fixer will not split it into triangles, because doing so would invent geometry the file does not describe.',
        { line },
      );
    }
  }
  if (corners.length < 3) {
    throw importMalformed(
      ImportRefusal.ObjTooFewFaceVertices,
      `This OBJ file has a face with fewer than three corners on line ${String(line)}.`,
      { line, corners: corners.length },
    );
  }

  for (const corner of corners) {
    // v, v/vt, v//vn and v/vt/vn all begin with the position index.
    const slash = corner.indexOf('/');
    const token = slash === -1 ? corner : corner.slice(0, slash);
    const parsed = Number(token);
    if (!Number.isInteger(parsed)) {
      throw importMalformed(
        ImportRefusal.ObjBadIndex,
        `This OBJ file has a face index CAD Fixer cannot read on line ${String(line)}.`,
        { line, token: token.slice(0, 64) },
      );
    }
    if (parsed === 0) {
      // OBJ indices are one-based; zero is not a vertex, it is a malformed file.
      throw importMalformed(
        ImportRefusal.ObjZeroIndex,
        `This OBJ file uses vertex index 0 on line ${String(line)}. OBJ indices start at 1.`,
        { line },
      );
    }
    const index = parsed > 0 ? parsed - 1 : vertexCount + parsed;
    if (index < 0 || index >= vertexCount) {
      throw importMalformed(
        ImportRefusal.ObjBadIndex,
        `This OBJ file references vertex ${String(parsed)} on line ${String(line)}, which does not exist.`,
        { line, index: parsed, vertexCount },
      );
    }
    out.push(index);
  }
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
        'This OBJ file names a material library. CAD Fixer imports geometry only and does not open it, so materials and colours are not loaded.',
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
