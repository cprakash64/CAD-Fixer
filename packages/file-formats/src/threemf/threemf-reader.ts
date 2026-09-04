import {
  composePartTransforms,
  createIndexArray,
  DEFAULT_DOCUMENT_LIMITS,
  triangleCount,
  vertexCount,
  createPositionArray,
  partId,
  IDENTITY_PART_TRANSFORM,
  type CanonicalMesh,
  type GeometryDocument,
  type GeometryPart,
  type PartTransform,
} from '@cadfixer/mesh-core';
import {
  diagnostic,
  isLengthUnit,
  throwIfCancelled,
  type Diagnostic,
  type LengthUnit,
} from '@cadfixer/shared';
import type { FormatReadContext } from '../context';
import { MeshFormatId } from '../formats';
import {
  EMPTY_COMPATIBILITY,
  UnsupportedFeature,
  type DocumentReadResult,
  type ImportCompatibility,
} from '../document-reader';
import { ImportRefusal, importMalformed, importTooLarge, internalRefusal } from '../import-errors';
import {
  createInflationBudget,
  DEFAULT_ZIP_LIMITS,
  readZipDirectory,
  readZipEntry,
  type InflationBudget,
  type ZipEntry,
  type ZipLimits,
  type ZipReadOptions,
} from './zip';
import { DEFAULT_XML_LIMITS, readAttrs, scanXml, type XmlLimits } from './xml-scan';

/**
 * THE PRODUCTION 3MF READER — core mesh subset.
 *
 * Reads exactly what ADR 0013 froze: the model unit, mesh objects, component
 * objects, build items and their transforms. Everything else is REPORTED as
 * unsupported rather than ignored, because an importer that quietly drops half
 * a file is worse than one that says what it left behind.
 *
 * STRUCTURAL VALIDITY AND MESH HEALTH ARE DIFFERENT QUESTIONS, and conflating
 * them is the mistake this reader most exists to avoid. A triangle referencing
 * vertex 9 of a 4-vertex mesh is a broken FILE and is refused. A zero-area
 * triangle is valid 3MF describing a defective mesh, so it imports and becomes
 * Mesh Health's problem — refusing it would leave the product unable to load
 * the very models it exists to repair.
 *
 * Promoted from `experiments/format-io/threemf.mjs`, which passed 42/42 reader
 * and writer checks and refused 12/12 hostile inputs through the geometry path.
 */

export interface ThreeMfLimits {
  readonly maxObjects: number;
  /**
   * The most parts an expansion may EMIT.
   *
   * NOT THE READER'S OWN NUMBER. It is `DocumentLimits.maxParts`, because the
   * document is the thing that has to hold the result: a reader ceiling above
   * the document's would let a file be fully expanded and then refused, which
   * is all of the work and none of the protection.
   */
  readonly maxParts: number;
  readonly maxComponentDepth: number;
  readonly maxVerticesPerObject: number;
  readonly maxTrianglesPerObject: number;
}

export const DEFAULT_3MF_LIMITS: ThreeMfLimits = Object.freeze({
  maxObjects: 65_536,
  /*
   * ONE AUTHORITY FOR THE PART CEILING, read from `mesh-core` rather than
   * restated here.
   *
   * This used to be 65,536 — sixteen times the document's ceiling — so a
   * hostile component graph was expanded to sixty-five thousand parts, each
   * with a transform and a mesh reference, before `assertGeometryDocument`
   * refused the candidate at four thousand and ninety-six. The refusal was
   * correct and the work was wasted, which is the shape of a resource bug even
   * when nothing is committed. A test asserts the two stay equal.
   */
  maxParts: DEFAULT_DOCUMENT_LIMITS.maxParts,
  /** ADR 0013's frozen cap. Deep enough for real assemblies, shallow enough to bound. */
  maxComponentDepth: 16,
  /*
   * Tighter than the document's 60,000,000 total, and left where it is: a
   * limit is not broadened to match a looser sibling.
   */
  maxVerticesPerObject: 40_000_000,
  /*
   * ONE OBJECT CANNOT EXCEED THE DOCUMENT'S TOTAL, because a placed object
   * contributes its triangles at least once. This was 40,000,000 against a
   * 20,000,000 document ceiling, so a single oversized object was materialised
   * in full before anything could refuse it.
   */
  maxTrianglesPerObject: DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles,
});

/** The canonical model part path, and the fallback the research allowed. */
const MODEL_PART = '3d/3dmodel.model';

/**
 * The 3MF core specification's permitted `unit` values, spelled as the format
 * spells them.
 *
 * These are exactly `LengthUnit`'s spellings, which is not a coincidence:
 * `packages/shared/src/units.ts` chose them from this list. The check below is
 * still explicit rather than trusting that they stay aligned.
 */
export const THREE_MF_UNITS: readonly string[] = Object.freeze([
  'micron',
  'millimeter',
  'centimeter',
  'inch',
  'foot',
  'meter',
]);

/**
 * What `<model>` means when it omits `unit`.
 *
 * The 3MF core specification gives the attribute a default value, so an absent
 * `unit` is a STATED millimetre rather than an unknown one. This is the
 * opposite of STL, which has no unit field at all and therefore genuinely
 * states nothing — see `describeUnit` in the application.
 */
export const THREE_MF_DEFAULT_UNIT = 'millimeter';

/** Resource elements CAD Fixer knowingly does not model. Recorded, never dropped silently. */
const UNSUPPORTED_RESOURCE_ELEMENTS: readonly string[] = Object.freeze([
  'texture2d',
  'texture2dgroup',
  'colorgroup',
  'basematerials',
  'multiproperties',
  'compositematerials',
]);

const TEXTURE_ELEMENTS: readonly string[] = Object.freeze(['texture2d', 'texture2dgroup']);

interface ObjectRecord {
  readonly id: string;
  readonly name: string | undefined;
  readonly materialRef: string | undefined;
  readonly positions: number[];
  readonly triangles: number[];
  readonly components: { readonly objectId: string; readonly transform: PartTransform }[];
  mesh?: CanonicalMesh;
}

interface ParsedModel {
  readonly unit: string | undefined;
  readonly objects: Map<string, ObjectRecord>;
  readonly build: { readonly objectId: string; readonly transform: PartTransform }[];
  readonly unsupported: Set<string>;
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function readCoordinate(raw: string | undefined, what: string, objectId: string): number {
  const value = Number(raw);
  /*
   * `Number`, NOT `parseFloat`. `parseFloat('1abc')` is 1, which would silently
   * accept a corrupt attribute; `Number('1abc')` is NaN and is refused below.
   * This is also the single Float64 step: the decimal text becomes a JS number
   * here and a Float32 exactly once, when it is written into the position array.
   */
  if (raw === undefined || raw === '' || !Number.isFinite(value)) {
    throw importMalformed(
      ImportRefusal.ThreeMfNonFinite,
      'This 3MF file contains a vertex coordinate CAD Fixer cannot use.',
      { objectId: objectId.slice(0, 64), axis: what },
    );
  }
  return value;
}

/**
 * Parses a `transform` attribute into a 12-value Float64 placement.
 *
 * FLOAT64, NEVER NARROWED. A transform is read from text and written back to
 * text; narrowing it to Float32 in between would introduce a rounding error the
 * source never had, for no benefit. The research measured 99,959 transform
 * values surviving the full pipeline bit-identically.
 */
function parseTransform(raw: string | undefined): PartTransform {
  if (raw === undefined || raw.trim() === '') return IDENTITY_PART_TRANSFORM;
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 12) {
    throw importMalformed(
      ImportRefusal.ThreeMfBadTransform,
      'This 3MF file contains a placement that is not a 3×4 matrix.',
      { values: parts.length },
    );
  }
  const values: number[] = [];
  for (const token of parts) {
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw importMalformed(
        ImportRefusal.ThreeMfBadTransform,
        'This 3MF file contains a placement value CAD Fixer cannot use.',
        { token: token.slice(0, 32) },
      );
    }
    values.push(value);
  }
  return values as unknown as PartTransform;
}

function readIndex(raw: string | undefined, objectId: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw importMalformed(
      ImportRefusal.ThreeMfBadVertexIndex,
      'This 3MF file contains a triangle index CAD Fixer cannot read.',
      { objectId: objectId.slice(0, 64) },
    );
  }
  return value;
}

/** Parses the model XML into resources and build items. No expansion yet. */
export function parseModelXml(
  xml: string,
  limits: ThreeMfLimits = DEFAULT_3MF_LIMITS,
  xmlLimits: XmlLimits = DEFAULT_XML_LIMITS,
  onElements?: (count: number) => void,
): ParsedModel {
  let unit: string | undefined;
  const objects = new Map<string, ObjectRecord>();
  const build: { objectId: string; transform: PartTransform }[] = [];
  const unsupported = new Set<string>();

  let current: ObjectRecord | undefined;
  let inBuild = false;
  /*
   * Held on an object rather than in a local, because the assignment happens
   * inside the scanner's callback: TypeScript's control-flow analysis cannot
   * see across that boundary and would narrow a plain `let` to its initial
   * value for the check below.
   */
  const seen = { model: false };

  scanXml(
    xml,
    {
      onOpen(name, attributeText, selfClosing) {
        const local = localName(name);

        if (local === 'model') {
          seen.model = true;
          const attrs = readAttrs(attributeText, xmlLimits);
          unit = attrs.unit;
          if (unit !== undefined && !THREE_MF_UNITS.includes(unit)) {
            throw importMalformed(
              ImportRefusal.ThreeMfUnsupportedUnit,
              'This 3MF file declares a unit CAD Fixer does not recognise.',
              { unit: unit.slice(0, 32) },
            );
          }
          return;
        }

        if (local === 'build') {
          inBuild = true;
          return;
        }

        if (local === 'item' && inBuild) {
          const attrs = readAttrs(attributeText, xmlLimits);
          const objectId = attrs.objectid;
          if (objectId === undefined) {
            throw importMalformed(
              ImportRefusal.ThreeMfMalformedStructure,
              'This 3MF file contains a build item that names no object.',
            );
          }
          build.push({ objectId, transform: parseTransform(attrs.transform) });
          return;
        }

        if (local === 'object') {
          const attrs = readAttrs(attributeText, xmlLimits);
          const id = attrs.id;
          if (id === undefined) {
            throw importMalformed(
              ImportRefusal.ThreeMfMalformedStructure,
              'This 3MF file contains an object with no id.',
            );
          }
          if (objects.has(id)) {
            throw importMalformed(
              ImportRefusal.ThreeMfDuplicateObjectId,
              'This 3MF file declares two objects with the same id.',
              { objectId: id.slice(0, 64) },
            );
          }
          /*
           * NAMES ARE TRUNCATED, NOT REFUSED, and to the DOCUMENT'S cap.
           *
           * A name is display metadata, and refusing an entire model because a
           * string is long would be the wrong trade — but truncating to a
           * larger number than the document accepts is not truncating at all.
           * A 600-character object name used to be carried through the reader
           * intact and then refused by `assertGeometryDocument`, which made a
           * perfectly good model unimportable for a cosmetic reason.
           */
          const record: ObjectRecord = {
            id,
            name: attrs.name?.slice(0, DEFAULT_DOCUMENT_LIMITS.maxNameLength),
            materialRef: attrs.pid?.slice(0, DEFAULT_DOCUMENT_LIMITS.maxMaterialRefLength),
            positions: [],
            triangles: [],
            components: [],
          };
          objects.set(id, record);
          if (objects.size > limits.maxObjects) {
            throw importTooLarge(
              ImportRefusal.ThreeMfTooManyObjects,
              'This 3MF file declares more objects than CAD Fixer will hold.',
              { limit: limits.maxObjects },
            );
          }
          current = selfClosing ? undefined : record;
          return;
        }

        if (UNSUPPORTED_RESOURCE_ELEMENTS.includes(local)) {
          // RECORDED, never silently dropped. What CAD Fixer did not import is
          // reported to the user rather than being left for them to discover.
          unsupported.add(local);
          return;
        }

        if (current === undefined) return;

        if (local === 'vertex') {
          const attrs = readAttrs(attributeText, xmlLimits);
          current.positions.push(
            readCoordinate(attrs.x, 'x', current.id),
            readCoordinate(attrs.y, 'y', current.id),
            readCoordinate(attrs.z, 'z', current.id),
          );
          if (current.positions.length / 3 > limits.maxVerticesPerObject) {
            throw importTooLarge(
              ImportRefusal.ThreeMfTooManyVertices,
              'This 3MF file contains an object with more vertices than CAD Fixer will hold.',
              { limit: limits.maxVerticesPerObject },
            );
          }
          return;
        }

        if (local === 'triangle') {
          const attrs = readAttrs(attributeText, xmlLimits);
          current.triangles.push(
            readIndex(attrs.v1, current.id),
            readIndex(attrs.v2, current.id),
            readIndex(attrs.v3, current.id),
          );
          if (current.triangles.length / 3 > limits.maxTrianglesPerObject) {
            throw importTooLarge(
              ImportRefusal.ThreeMfTooManyTriangles,
              'This 3MF file contains an object with more triangles than CAD Fixer will hold.',
              { limit: limits.maxTrianglesPerObject },
            );
          }
          return;
        }

        if (local === 'component') {
          const attrs = readAttrs(attributeText, xmlLimits);
          const objectId = attrs.objectid;
          if (objectId === undefined) {
            throw importMalformed(
              ImportRefusal.ThreeMfMalformedStructure,
              'This 3MF file contains a component that names no object.',
            );
          }
          current.components.push({ objectId, transform: parseTransform(attrs.transform) });
        }
      },
      onClose(name) {
        const local = localName(name);
        if (local === 'object') current = undefined;
        if (local === 'build') inBuild = false;
      },
      ...(onElements === undefined ? {} : { onProgress: onElements }),
    },
    xmlLimits,
  );

  if (!seen.model) {
    throw importMalformed(
      ImportRefusal.ThreeMfMalformedStructure,
      'This file does not contain a 3MF model.',
    );
  }

  /*
   * STRUCTURAL VALIDATION, after the shape is known.
   *
   * Index bounds cannot be checked while scanning: a `<triangle>` may legally
   * precede the `<vertex>` elements it refers to in a malformed file, and
   * refusing early would reject on ordering rather than on validity.
   */
  for (const object of objects.values()) {
    const vertexCount = object.positions.length / 3;
    for (const index of object.triangles) {
      if (index < 0 || index >= vertexCount) {
        throw importMalformed(
          ImportRefusal.ThreeMfBadVertexIndex,
          'This 3MF file contains a triangle that refers to a vertex which does not exist.',
          { objectId: object.id.slice(0, 64), index, vertexCount },
        );
      }
    }
    for (const component of object.components) {
      if (!objects.has(component.objectId)) {
        throw importMalformed(
          ImportRefusal.ThreeMfMissingObject,
          'This 3MF file contains a component that refers to an object which does not exist.',
          { objectId: component.objectId.slice(0, 64) },
        );
      }
    }
  }
  for (const item of build) {
    if (!objects.has(item.objectId)) {
      throw importMalformed(
        ImportRefusal.ThreeMfMissingObject,
        'This 3MF file builds an object which does not exist.',
        { objectId: item.objectId.slice(0, 64) },
      );
    }
  }
  if (build.length === 0) {
    throw importMalformed(
      ImportRefusal.ThreeMfNoBuildItems,
      'This 3MF file contains no build items, so there is nothing to show.',
    );
  }

  return { unit, objects, build, unsupported };
}

/**
 * Materialises each object's canonical buffers ONCE, shared by every placement.
 *
 * This is where structural sharing is created: every part that resolves to this
 * object receives the SAME `CanonicalMesh` object, so N placements cost N
 * transforms rather than N copies of the geometry.
 */
function materialiseMeshes(model: ParsedModel, stats?: ThreeMfExpansionStats): void {
  for (const object of model.objects.values()) {
    if (object.triangles.length === 0) continue;
    if (stats !== undefined) stats.meshResourcesMaterialised += 1;
    const positions = createPositionArray(object.positions.length);
    // ONE ASSIGNMENT PER COMPONENT — the single Float64-to-Float32 conversion.
    for (let index = 0; index < object.positions.length; index += 1) {
      positions[index] = object.positions[index] ?? 0;
    }
    const indices = createIndexArray(object.triangles.length);
    for (let index = 0; index < object.triangles.length; index += 1) {
      indices[index] = object.triangles[index] ?? 0;
    }
    object.mesh = { positions, indices, metadata: { sourceFormat: MeshFormatId.ThreeMf } };
  }
}

/**
 * Expands build items into parts, following components depth-first.
 *
 * COMPONENTS ARE SUPPORTED, and this is why it was affordable: expansion carries
 * a composed transform, uses an explicit path set for cycle detection, and caps
 * depth. Geometry is shared structurally — every part points at the same
 * `CanonicalMesh` as its source object.
 *
 * FROZEN MAPPING (ADR 0013): a build item on a mesh object is one part; two
 * items on the same object are two parts sharing one mesh; a component instance
 * is one part per leaf with transforms composed; an object with vertices but no
 * triangles, or one the build never references, becomes NO part.
 */
function expandBuild(
  model: ParsedModel,
  limits: ThreeMfLimits,
  stats?: ThreeMfExpansionStats,
): readonly GeometryPart[] {
  const parts: GeometryPart[] = [];
  /*
   * RUNNING DOCUMENT TOTALS, because the document counts PER PART.
   *
   * `documentTriangleCount` sums every part, so a shared mesh multiplies: four
   * thousand placements of a five-thousand-triangle object is twenty million
   * and one triangles against a twenty-million ceiling. A file that small can
   * therefore be expanded to completion and then refused, which is the same
   * class of wasted work the part ceiling above fixes. Both totals are O(1) per
   * part, so keeping them is free.
   *
   * BYTES ARE NOT COUNTED HERE, and that is not an oversight:
   * `maxTotalGeometryBytes` is charged per DISTINCT mesh, so placements do not
   * multiply it and the per-object caps already bound each mesh. It stays with
   * the document gate, where the distinct set is known.
   */
  let totalTriangles = 0;
  let totalVertices = 0;

  const walk = (
    objectId: string,
    transform: PartTransform,
    path: ReadonlySet<string>,
    depth: number,
    nameHint: string | undefined,
  ): void => {
    if (depth > limits.maxComponentDepth) {
      throw importTooLarge(
        ImportRefusal.ThreeMfComponentTooDeep,
        'This 3MF file nests components more deeply than CAD Fixer will expand.',
        { depth, limit: limits.maxComponentDepth },
      );
    }
    if (path.has(objectId)) {
      // A CYCLE IS REFUSED, not survived. Expanding one would either loop
      // forever or silently truncate the model at an arbitrary depth.
      throw importMalformed(
        ImportRefusal.ThreeMfComponentCycle,
        'This 3MF file contains components that refer to each other in a loop.',
        { objectId: objectId.slice(0, 64) },
      );
    }
    const object = model.objects.get(objectId);
    if (object === undefined) {
      throw importMalformed(
        ImportRefusal.ThreeMfMissingObject,
        'This 3MF file refers to an object which does not exist.',
        { objectId: objectId.slice(0, 64) },
      );
    }

    const mesh = object.mesh;
    if (mesh !== undefined) {
      if (stats !== undefined) stats.leafPlacementsVisited += 1;
      /*
       * PART IDS ARE GENERATED FROM EXPANSION ORDER, never from the file's
       * object ids or names. Object ids are unique among RESOURCES but two
       * placements of one object are two parts, and names may repeat, be empty,
       * or be a kilobyte of hostile text. Identity has to be unique, short and
       * ours; the name travels as display metadata.
       */
      /*
       * CHECKED BEFORE THE PART EXISTS, not after.
       *
       * The budget is spent by APPENDING, so the only moment at which refusing
       * costs nothing is before the append. Building part 4,097 and then
       * throwing would allocate it, name it, compose its transform and attach
       * its mesh reference — and the throw would unwind all of that anyway.
       * More importantly the walk stops HERE, so the remainder of a
       * combinatorial subtree is never visited: an expansion is refused as soon
       * as it is known to be too large, not after it has been performed.
       */
      if (parts.length >= limits.maxParts) {
        throw importTooLarge(
          ImportRefusal.ThreeMfTooManyParts,
          'This 3MF file expands to more parts than CAD Fixer will hold.',
          { limit: limits.maxParts, emitted: parts.length },
        );
      }

      const prospectiveTriangles = totalTriangles + triangleCount(mesh);
      if (prospectiveTriangles > DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles) {
        throw importTooLarge(
          ImportRefusal.ThreeMfTooManyTriangles,
          'This 3MF file expands to more triangles than CAD Fixer will hold.',
          { limit: DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles, emitted: parts.length },
        );
      }
      const prospectiveVertices = totalVertices + vertexCount(mesh);
      if (prospectiveVertices > DEFAULT_DOCUMENT_LIMITS.maxTotalVertices) {
        throw importTooLarge(
          ImportRefusal.ThreeMfTooManyVertices,
          'This 3MF file expands to more vertices than CAD Fixer will hold.',
          { limit: DEFAULT_DOCUMENT_LIMITS.maxTotalVertices, emitted: parts.length },
        );
      }
      totalTriangles = prospectiveTriangles;
      totalVertices = prospectiveVertices;
      parts.push({
        id: partId(`part-${String(parts.length + 1)}`),
        mesh,
        transform,
        ...(object.name === undefined || object.name === ''
          ? nameHint === undefined || nameHint === ''
            ? {}
            : { name: nameHint }
          : { name: object.name }),
        ...(object.materialRef === undefined ? {} : { materialRef: object.materialRef }),
      });
      if (stats !== undefined) stats.partsEmitted = parts.length;
    }

    const nextPath = new Set(path).add(objectId);
    for (const component of object.components) {
      walk(
        component.objectId,
        composePartTransforms(transform, component.transform),
        nextPath,
        depth + 1,
        object.name,
      );
    }
  };

  for (const item of model.build) {
    walk(item.objectId, item.transform, new Set<string>(), 0, undefined);
  }
  return parts;
}

/** Finds the model part, preferring the spec's fixed path. */
/**
 * The model part, by its canonical path or by extension.
 *
 * TYPED AS `ZipEntry`, which it always was. The narrower `{ name: string }`
 * signature forced an `as never` at the only call site, and that cast erased
 * the one check worth having there: that what reaches `readZipEntry` is a real
 * directory entry with a real offset and size.
 */
function findModelEntry(entries: readonly ZipEntry[]): ZipEntry {
  const canonical = entries.find((entry) => entry.name.toLowerCase() === MODEL_PART);
  if (canonical !== undefined) return canonical;
  const anyModel = entries.find((entry) => entry.name.toLowerCase().endsWith('.model'));
  if (anyModel !== undefined) return anyModel;
  throw importMalformed(
    ImportRefusal.ThreeMfNoModelPart,
    'This archive does not contain a 3MF model part, so it is not a 3MF file.',
  );
}

/**
 * What an expansion actually did, for tests and research to assert on.
 *
 * INSTRUMENTATION, NOT A RESULT. It exists because "no work was wasted" is
 * otherwise only inferrable: a refusal that stops early and one that expands a
 * subtree and then throws are indistinguishable from the outside, and both
 * produce the same error. Mutated in place rather than returned, precisely so
 * it can be read after a refusal has unwound the call.
 *
 * Nothing in production passes one, and a boundary test asserts that.
 */
export interface ThreeMfExpansionStats {
  /** Leaf placements the walk reached — objects carrying a mesh. */
  leafPlacementsVisited: number;
  /** Parts appended to the document. Never more than `maxParts`. */
  partsEmitted: number;
  /** Distinct `CanonicalMesh` objects built. One per mesh-bearing OBJECT. */
  meshResourcesMaterialised: number;
}

export interface ThreeMfReadOptions {
  readonly limits?: ThreeMfLimits;
  readonly zipLimits?: ZipLimits;
  readonly xmlLimits?: XmlLimits;
  /** See `ThreeMfExpansionStats`. Test and research use only. */
  readonly stats?: ThreeMfExpansionStats;
  /**
   * The archive-wide inflation budget.
   *
   * Supplied only by tests that want to observe or narrow it; production
   * creates a fresh one per import, which is the correct scope — a budget
   * shared between imports would refuse a second valid file for the sins of the
   * first.
   */
  readonly budget?: InflationBudget;
}

export async function read3mf(
  bytes: Uint8Array,
  context: FormatReadContext,
  options: ThreeMfReadOptions = {},
): Promise<DocumentReadResult> {
  const limits = options.limits ?? DEFAULT_3MF_LIMITS;
  const zipLimits = options.zipLimits ?? DEFAULT_ZIP_LIMITS;
  const xmlLimits = options.xmlLimits ?? DEFAULT_XML_LIMITS;

  const inflateRaw = context.inflateRaw;
  if (inflateRaw === undefined) {
    // A caller that dispatched 3MF without supplying an inflater is a wiring
    // fault, not a bad file, and must not be reported to the user as one.
    throw internalRefusal('3MF import needs a decompressor, and none was provided.');
  }

  context.progress.report(0, 'reading package');
  const entries = readZipDirectory(bytes, zipLimits);
  throwIfCancelled(context.cancellation);

  const modelEntry = findModelEntry(entries);
  context.progress.report(0.1, 'decompressing');

  /*
   * ONE BUDGET FOR THE WHOLE ARCHIVE, created here and passed to every entry
   * this import inflates. Today that is the model part alone; the budget is
   * threaded rather than inlined so that reading a second entry cannot
   * accidentally get a second full allowance.
   */
  const budget = options.budget ?? createInflationBudget(zipLimits);
  const zipOptions: ZipReadOptions = {
    limits: zipLimits,
    inflateRaw,
    budget,
    throwIfCancelled: () => {
      throwIfCancelled(context.cancellation);
    },
  };

  const modelBytes = await readZipEntry(bytes, modelEntry, zipOptions);
  throwIfCancelled(context.cancellation);

  context.progress.report(0.3, 'parsing model');
  const xml = context.decodeText(modelBytes);
  throwIfCancelled(context.cancellation);

  const model = parseModelXml(xml, limits, xmlLimits, () => {
    // Polled between elements. The scanner is synchronous, so this cannot
    // interrupt it on its own — the disposable worker's termination is the
    // hard bound. See docs/ARCHITECTURE.md.
    throwIfCancelled(context.cancellation);
  });
  throwIfCancelled(context.cancellation);

  context.progress.report(0.75, 'building document');
  materialiseMeshes(model, options.stats);
  const parts = expandBuild(model, limits, options.stats);
  throwIfCancelled(context.cancellation);

  if (parts.length === 0) {
    throw importMalformed(
      ImportRefusal.ThreeMfNoBuildItems,
      'This 3MF file builds nothing that contains geometry, so there is nothing to import.',
    );
  }

  /*
   * THE UNIT IS PRESERVED EXACTLY, AND COORDINATES ARE NEVER RESCALED.
   *
   * The same `<vertex x="1">` under `unit="millimeter"` and under `unit="inch"`
   * stores the same canonical number and a different document unit. Rescaling
   * would change the stored values that exact topology, no-tolerance repair and
   * exact self-intersection all depend on.
   *
   * AN ABSENT `unit` IS NOT AN UNKNOWN UNIT. The specification defaults the
   * attribute to millimetre, so a file that omits it has said millimetre — and
   * reporting "unspecified" would be misreading the format rather than being
   * careful about it. Nothing is invented here: the value comes from the
   * format's own definition, not from a guess about the user's intent.
   */
  const declared = model.unit ?? THREE_MF_DEFAULT_UNIT;
  const unit: LengthUnit | undefined = isLengthUnit(declared) ? declared : undefined;

  const document: GeometryDocument = {
    ...(unit === undefined ? {} : { unit }),
    parts,
  };

  const warnings: Diagnostic[] = [];
  const unsupportedFeatures: UnsupportedFeature[] = [];

  const sawTexture = [...model.unsupported].some((element) => TEXTURE_ELEMENTS.includes(element));
  const sawOtherMaterial = [...model.unsupported].some(
    (element) => !TEXTURE_ELEMENTS.includes(element),
  );

  if (sawTexture) {
    unsupportedFeatures.push(UnsupportedFeature.Textures);
    warnings.push(
      diagnostic(
        'THREEMF_TEXTURES_NOT_IMPORTED',
        'This 3MF file contains textures. CAD Fixer imports geometry only: the textures were not read, and nothing was downloaded.',
      ),
    );
  }
  if (sawOtherMaterial) {
    unsupportedFeatures.push(UnsupportedFeature.Materials);
    warnings.push(
      diagnostic(
        'THREEMF_MATERIALS_NOT_IMPORTED',
        'This 3MF file contains colour or material definitions. CAD Fixer keeps the reference each part names but does not interpret them, so colours are not shown.',
      ),
    );
  }

  const placed = new Set(parts.map((part) => part.mesh));
  let unreferenced = 0;
  for (const object of model.objects.values()) {
    if (object.mesh !== undefined && !placed.has(object.mesh)) unreferenced += 1;
  }
  if (unreferenced > 0) {
    unsupportedFeatures.push(UnsupportedFeature.UnreferencedObject);
    warnings.push(
      diagnostic(
        'THREEMF_UNREFERENCED_OBJECTS',
        `This 3MF file defines ${String(unreferenced)} mesh ${unreferenced === 1 ? 'object' : 'objects'} that its build never places. They are not shown, because the file does not ask for them to be.`,
        { count: unreferenced },
      ),
    );
  }

  const compatibility: ImportCompatibility =
    unsupportedFeatures.length === 0
      ? EMPTY_COMPATIBILITY
      : { unsupported: unsupportedFeatures, externalReferences: [] };

  context.progress.report(1, 'complete');
  return { document, encoding: '3mf', warnings, compatibility };
}
