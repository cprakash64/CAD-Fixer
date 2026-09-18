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
  formatCount,
  isLengthUnit,
  throwIfCancelled,
  type Diagnostic,
  type LengthUnit,
} from '@cadfixer/shared';
import type { FormatReadContext } from '../context';
import { MeshFormatId } from '../formats';
/*
 * THE UNIT TOKENS LIVE IN A LEAF MODULE, not here.
 *
 * `export/compatibility.ts` runs on the MAIN THREAD and needs this list to
 * decide whether a unit the user chose can be written. Importing it from this
 * file would invite a bundler to follow this file's own imports — the XML
 * scanner, the ZIP reader, the whole intake path — into the application bundle,
 * for six strings. Re-exported so every existing caller is unaffected.
 */
import { THREE_MF_DEFAULT_UNIT, THREE_MF_UNITS } from './units';

export { THREE_MF_DEFAULT_UNIT, THREE_MF_UNITS };
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
  internalRefusal,
} from '../import-errors';
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
import { ModelPartRole, PackageModelGraph, type ModelPart } from './package-graph';
import {
  modelPartKeyOfEntry,
  objectKeyToString,
  resolvePackageModelPath,
  type ModelPartKey,
} from './package-path';

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
  /**
   * The PACKAGE'S totals, across every reachable model part.
   *
   * NOT THE READER'S OWN NUMBERS, exactly as `maxParts` is not: both read
   * `DocumentLimits`, because the document is the thing that has to hold the
   * result. Stage 6D-A2 gave them names here for one reason — the walk enforces
   * them package-wide, and a ceiling that can only be exercised by generating
   * twenty million triangles of fixture is a ceiling no test actually covers.
   * Naming them makes the package-wide property provable at four triangles.
   *
   * A test asserts they stay equal to the document's.
   */
  readonly maxTotalTriangles: number;
  readonly maxTotalVertices: number;
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
  maxTotalTriangles: DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles,
  maxTotalVertices: DEFAULT_DOCUMENT_LIMITS.maxTotalVertices,
});

/**
 * THE PHASES A 3MF IMPORT REPORTS, named rather than spelled inline.
 *
 * These travel on the existing progress mechanism as the `note`, which is what
 * the interface already renders and what Stage 6D-B2's MF-P24 keys on. Naming
 * them is what lets a test assert the SYMBOL the worker actually emits instead
 * of a copy of the sentence: a test that hard-codes `'parsing model'` drifts
 * silently the day the wording changes, and MF-P24's whole proof is that
 * cancellation was requested in a specific phase.
 *
 * `Parsing` IS THE POST-INFLATE BOUNDARY, and that is the one that matters.
 * It is reported after `readZipEntry` has returned and before the decode, so
 * observing it is proof that inflation finished.
 */
export const ThreeMfImportPhase = {
  ReadingPackage: 'reading package',
  Decompressing: 'decompressing',
  Parsing: 'parsing model',
  BuildingDocument: 'building document',
  Complete: 'complete',
} as const;

export type ThreeMfImportPhase = (typeof ThreeMfImportPhase)[keyof typeof ThreeMfImportPhase];

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

/**
 * What `<model>` means when it omits `unit`.
 *
 * The 3MF core specification gives the attribute a default value, so an absent
 * `unit` is a STATED millimetre rather than an unknown one. This is the
 * opposite of STL, which has no unit field at all and therefore genuinely
 * states nothing — see `describeUnit` in the application.
 */

/** Resource elements CAD Fixer knowingly does not model. Recorded, never dropped silently. */
/**
 * Resources a `pid` may legitimately point at.
 *
 * CAD Fixer does not INTERPRET any of them — it imports geometry — but it must
 * know they exist, because "this property reference names a resource I do not
 * understand" and "this property reference names nothing at all" are a valid
 * file and a malformed one. Without this set the reader could not tell them
 * apart, and it accepted both.
 */
const PROPERTY_GROUP_ELEMENTS: readonly string[] = Object.freeze([
  'basematerials',
  'colorgroup',
  'texture2dgroup',
  'multiproperties',
  'compositematerials',
]);

/** Resource elements that are not property groups but still occupy the id space. */
const OTHER_RESOURCE_ELEMENTS: readonly string[] = Object.freeze(['texture2d']);

const UNSUPPORTED_RESOURCE_ELEMENTS: readonly string[] = Object.freeze([
  ...OTHER_RESOURCE_ELEMENTS,
  ...PROPERTY_GROUP_ELEMENTS,
]);

/**
 * 3MF resource ids are `ST_ResourceID`: POSITIVE INTEGERS.
 *
 * Enforced LEXICALLY rather than by coercion. `Number('0x10')`, `Number(' 7 ')`
 * and `Number('1e3')` all produce integers, and none of those is a resource id
 * — accepting them is how a value that is not an id ends up stored as one and,
 * eventually, written back out. The upper bound is the signed 32-bit maximum,
 * the ceiling the id space uses.
 */
const MAX_RESOURCE_ID = 2_147_483_647;

function isResourceId(value: string): boolean {
  if (!/^[1-9][0-9]*$/.test(value)) return false;
  // Length-guarded before `Number`, so a thousand-digit string is rejected on
  // shape rather than turned into `Infinity` and compared.
  if (value.length > 10) return false;
  return Number(value) <= MAX_RESOURCE_ID;
}

/**
 * THE ONE NAMESPACE CAD FIXER IMPLEMENTS.
 *
 * Everything the reader understands — objects, meshes, components, build items,
 * units — is 3MF core. An element or attribute from any other namespace belongs
 * to an extension, and CAD Fixer implements none of them.
 */
const CORE_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

/**
 * The 3MF PRODUCTION EXTENSION, which is what a `p:path` component reference
 * belongs to.
 *
 * Named separately from the generic unsupported-extension case only so the
 * refusal can say what the file is actually doing — storing its objects in
 * several model parts — rather than naming a URI at the user.
 */
const PRODUCTION_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

/**
 * A reference to an object, which may leave this model part.
 *
 * `path` IS THE PRODUCTION EXTENSION'S, VERBATIM AND UNRESOLVED. The parser
 * records what the file wrote and decides nothing: whether the reference is
 * well formed, whether the part exists and whether this part was even allowed
 * to write one are all decided by the package walk, which is the only place
 * that knows the package.
 *
 * STAGE 6D-A2 REPLACED A SINGLE `crossPart` FLAG WITH THIS. The flag recorded
 * that SOME reference in the part carried a path and then refused the whole
 * file; it could not say which references were local and which were not, which
 * is precisely what following them requires.
 */
interface ObjectReference {
  readonly objectId: string;
  readonly transform: PartTransform;
  /** The raw `p:path`, when the reference carried one. */
  readonly path?: string;
}

/**
 * Maps namespace prefixes declared on an element to their URIs.
 *
 * Only `<model>` is inspected, which is where a 3MF declares its namespaces and
 * is the document element, so the map is complete before any component is read.
 */
function namespacePrefixes(attrs: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  const prefixes = new Map<string, string>();
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('xmlns:')) prefixes.set(key.slice('xmlns:'.length), value);
  }
  return prefixes;
}

/**
 * Finds a `path` attribute belonging to the production extension.
 *
 * RESOLVED THROUGH THE PREFIX MAP, not matched on the literal text `p:path`.
 * The prefix is the author's to choose — `p`, `prod` and `production` are all
 * the same attribute — so matching the spelling would miss the file and matching
 * a bare `path` would catch an attribute from some unrelated namespace.
 */
export function productionPathValueOf(
  attrs: Readonly<Record<string, string>>,
  prefixes: ReadonlyMap<string, string>,
): string | undefined {
  for (const [key, value] of Object.entries(attrs)) {
    const colon = key.indexOf(':');
    if (colon === -1) continue;
    if (key.slice(colon + 1) !== 'path') continue;
    if (prefixes.get(key.slice(0, colon)) === PRODUCTION_NAMESPACE) return value;
  }
  return undefined;
}

const TEXTURE_ELEMENTS: readonly string[] = Object.freeze(['texture2d', 'texture2dgroup']);

interface ObjectRecord {
  readonly id: string;
  readonly name: string | undefined;
  readonly materialRef?: string;
  /**
   * Float64 scratch, CLEARED once the canonical buffers exist.
   *
   * `number[]` at eight bytes an element is the single largest transient a
   * parse produces — three of them per vertex and three per triangle. Holding
   * it after `materialiseMeshes` has copied it into typed arrays would mean a
   * package's every loaded part kept its scratch alive for the whole import,
   * which is the accumulation Stage 6D-R1's lifetime contract exists to
   * prevent. Nothing reads these after materialisation: index bounds are
   * validated before it, and the walk reads `mesh` and `components` only.
   */
  positions: number[];
  triangles: number[];
  readonly components: ObjectReference[];
  mesh?: CanonicalMesh;
}

interface ParsedModel {
  readonly unit: string | undefined;
  readonly objects: Map<string, ObjectRecord>;
  readonly build: ObjectReference[];
  readonly unsupported: Set<string>;
  /**
   * The role this part was parsed AS.
   *
   * Carried on the result so a consumer cannot lose track of whether the build
   * it is holding is the package's build or a referenced part's ignorable one.
   * `expandBuild` must only ever walk the root's.
   */
  readonly role: ModelPartRole;
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
/**
 * What a parse needs to know beyond the bytes.
 *
 * `role` EXISTS SO THE PARSER CAN BE TOLD WHICH PART IT IS READING — Stage
 * 6D-A1. The specification treats the two differently: the root part carries
 * the package's only valid build section, and a REFERENCED part is required to
 * carry an empty one, with consumers obliged to ignore any entries it does
 * have. Today's parser refuses a model with no build items, which is right for
 * the only part it ever opens and wrong for a conformant referenced part — so a
 * referenced part could not be parsed at all.
 *
 * NOTHING IN PRODUCTION PASSES `Referenced` YET. `read3mf` opens the root and
 * nothing else, and every production-extension package is still refused. The
 * default is `Root`, so every existing caller is unaffected and root validation
 * is untouched: the `no build items` refusal still fires exactly where it did.
 */
export function parseModelXml(
  xml: string,
  limits: ThreeMfLimits = DEFAULT_3MF_LIMITS,
  xmlLimits: XmlLimits = DEFAULT_XML_LIMITS,
  onElements?: (count: number) => void,
  /** Defaults to `Root`. A referenced part must be parsed AS one — see below. */
  role: ModelPartRole = ModelPartRole.Root,
): ParsedModel {
  let unit: string | undefined;
  const objects = new Map<string, ObjectRecord>();
  const build: ObjectReference[] = [];
  const unsupported = new Set<string>();
  /*
   * THE PROPERTY-RESOURCE ID SPACE, and the references into it.
   *
   * Resolved AFTER the scan rather than during it, because a reference may
   * legitimately be read before the resource it names — resolving inline would
   * refuse a valid file purely for its element order. Collecting is O(1) per
   * reference and the check is one pass at the end.
   */
  const propertyGroupIds = new Set<string>();
  const propertyReferences: { readonly id: string; readonly where: string }[] = [];

  let current: ObjectRecord | undefined;
  let inBuild = false;
  /*
   * NAMESPACE STATE, declared on `<model>` and read by every reference below.
   *
   * `<model>` is the document element, so this is populated before the first
   * component is seen. An empty map simply means nothing resolves to an
   * extension, which is the correct reading of a file that declares none.
   */
  let prefixes: ReadonlyMap<string, string> = new Map<string, string>();
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
          prefixes = namespacePrefixes(attrs);
          /*
           * A DECLARED REQUIREMENT IS REFUSED BEFORE THE BODY IS READ.
           *
           * `requiredextensions` is the format's own way of saying the file
           * cannot be understood without those semantics. Reading the parts we
           * happen to recognise and presenting the result as the user's model
           * would be incomplete geometry reported as success — so this is
           * checked at the document element, which is as early as it can be
           * known, and nothing after it runs.
           *
           * The attribute holds PREFIXES, not URIs, so each is resolved through
           * the namespace map. A prefix that resolves to nothing is refused
           * too: an unresolvable requirement is a requirement whose semantics
           * are unknown, and guessing is the one thing this must not do.
           */
          const required = attrs.requiredextensions;
          if (required !== undefined) {
            for (const prefix of required.split(/\s+/)) {
              if (prefix === '') continue;
              const namespace = prefixes.get(prefix);
              if (namespace === CORE_NAMESPACE) continue;
              /*
               * THE PRODUCTION EXTENSION IS NOW IMPLEMENTED, SO REQUIRING IT IS
               * NOT A REFUSAL — Stage 6D-A2, and this line is the whole
               * compatibility transition.
               *
               * It is not a weakening of the rule. `requiredextensions` says
               * the file cannot be understood without those semantics, and that
               * remains a refusal for every extension CAD Fixer does not
               * implement. What changed is that this one IS implemented, for
               * the reachable cross-part subset — and a construct of it outside
               * that subset is still refused, by name, where it is encountered.
               * Declaring an extension is not the same as using a part of it
               * nobody supports.
               */
              if (namespace === PRODUCTION_NAMESPACE) continue;
              throw importUnsupported(
                ImportRefusal.ThreeMfUnsupportedExtension,
                'This 3MF requires a 3MF extension that CAD Fixer does not support yet. Try exporting a plain 3MF, or an STL, from the tool that made it.',
                {
                  extension: (namespace ?? prefix).slice(0, 128),
                  resolved: namespace !== undefined,
                },
              );
            }
          }
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
          /*
           * THE PATH TRAVELS WITH THE REFERENCE THAT CARRIED IT — Stage 6D-A2.
           * Recorded unresolved and unvalidated; the package walk decides what
           * it means, because only the walk knows the package.
           */
          const itemPath = productionPathValueOf(attrs, prefixes);
          build.push({
            objectId,
            transform: parseTransform(attrs.transform),
            ...(itemPath === undefined ? {} : { path: itemPath }),
          });
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
          /*
           * `pid` IS A RESOURCE ID, NOT AN OPAQUE LABEL.
           *
           * It used to be sliced to a length cap and stored as a string, which
           * meant `pid="steel"` and `pid="0"` were carried through the document
           * and — before the property-reference fix — written straight back out
           * into a file CAD Fixer produced. The shape is checked here and the
           * reference is resolved after the scan.
           */
          const pid = attrs.pid;
          if (pid !== undefined) {
            if (!isResourceId(pid)) {
              throw importMalformed(
                ImportRefusal.ThreeMfMalformedResourceId,
                'This 3MF file contains a property reference that is not a resource id.',
                { objectId: id.slice(0, 40), pid: pid.slice(0, 40) },
              );
            }
            propertyReferences.push({ id: pid, where: id.slice(0, 40) });
          }
          /*
           * `pindex` SELECTS WITHIN A PROPERTY GROUP, so it means nothing
           * without one. An object carrying it alone is malformed, and reading
           * past it would be reading an index into a resource that was never
           * named.
           */
          if (pid === undefined && attrs.pindex !== undefined) {
            throw importMalformed(
              ImportRefusal.ThreeMfMalformedStructure,
              'This 3MF file contains an object with a property index but no property reference.',
              { objectId: id.slice(0, 40) },
            );
          }

          const record: ObjectRecord = {
            id,
            name: attrs.name?.slice(0, DEFAULT_DOCUMENT_LIMITS.maxNameLength),
            ...(pid === undefined ? {} : { materialRef: pid }),
            positions: [],
            triangles: [],
            components: [],
          };
          objects.set(id, record);
          if (objects.size > limits.maxObjects) {
            throw importTooLarge(
              ImportRefusal.ThreeMfTooManyObjects,
              `This 3MF file declares ${formatCount(objects.size)} objects; CAD Fixer's limit is ${formatCount(limits.maxObjects)} objects.`,
              { declared: objects.size, limit: limits.maxObjects },
            );
          }
          current = selfClosing ? undefined : record;
          return;
        }

        if (UNSUPPORTED_RESOURCE_ELEMENTS.includes(local)) {
          // RECORDED, never silently dropped. What CAD Fixer did not import is
          // reported to the user rather than being left for them to discover.
          unsupported.add(local);
          /*
           * ITS ID IS STILL READ. The resource is not interpreted, but a `pid`
           * pointing at it is a VALID reference to something CAD Fixer chose not
           * to import — which is a completely different fact from a reference to
           * nothing, and the only way to tell them apart is to know this id
           * exists.
           */
          if (PROPERTY_GROUP_ELEMENTS.includes(local)) {
            const attrs = readAttrs(attributeText, xmlLimits);
            const id = attrs.id;
            if (id !== undefined) {
              if (!isResourceId(id)) {
                throw importMalformed(
                  ImportRefusal.ThreeMfMalformedResourceId,
                  'This 3MF file declares a property resource whose id is not a resource id.',
                  { element: local, id: id.slice(0, 40) },
                );
              }
              propertyGroupIds.add(id);
            }
          }
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
              `An object in this 3MF file contains ${formatCount(current.positions.length / 3)} vertices; CAD Fixer's limit is ${formatCount(limits.maxVerticesPerObject)} vertices for one object.`,
              { declared: current.positions.length / 3, limit: limits.maxVerticesPerObject },
            );
          }
          return;
        }

        if (local === 'triangle') {
          const attrs = readAttrs(attributeText, xmlLimits);
          /*
           * A TRIANGLE MAY CARRY ITS OWN PROPERTY REFERENCE, and CAD Fixer does
           * not import per-triangle properties — but it must still refuse a
           * reference to a resource that does not exist, for the same reason it
           * refuses one on an object. The attributes are already parsed here, so
           * checking costs a property read on a path that is otherwise
           * untouched.
           */
          const trianglePid = attrs.pid;
          if (trianglePid !== undefined) {
            if (!isResourceId(trianglePid)) {
              throw importMalformed(
                ImportRefusal.ThreeMfMalformedResourceId,
                'This 3MF file contains a triangle property reference that is not a resource id.',
                { objectId: current.id.slice(0, 40), pid: trianglePid.slice(0, 40) },
              );
            }
            propertyReferences.push({ id: trianglePid, where: current.id.slice(0, 40) });
          }

          current.triangles.push(
            readIndex(attrs.v1, current.id),
            readIndex(attrs.v2, current.id),
            readIndex(attrs.v3, current.id),
          );
          if (current.triangles.length / 3 > limits.maxTrianglesPerObject) {
            throw importTooLarge(
              ImportRefusal.ThreeMfTooManyTriangles,
              `An object in this 3MF file contains ${formatCount(current.triangles.length / 3)} triangles; CAD Fixer's limit is ${formatCount(limits.maxTrianglesPerObject)} triangles for one object.`,
              { declared: current.triangles.length / 3, limit: limits.maxTrianglesPerObject },
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
          /*
           * THE PATH IS RECORDED, NOT ACTED ON HERE — and that is still true
           * after Stage 6D-A2, for the same reason it was before: only the walk
           * knows which part this is, which parts the package holds, and
           * therefore whether this reference is legal, resolvable or neither.
           * Deciding here would scatter that judgement across the scanner.
           */
          const componentPath = productionPathValueOf(attrs, prefixes);
          current.components.push({
            objectId,
            transform: parseTransform(attrs.transform),
            ...(componentPath === undefined ? {} : { path: componentPath }),
          });
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
   * A PATH-BEARING REFERENCE IS LEGAL ONLY IN THE ROOT PART — Stage 6D-A2.
   *
   * The production extension lets the ROOT model part point into the others; a
   * referenced part may not chain further. Refused here, before any structural
   * check that would misread it: a path-bearing reference in a referenced part
   * names an object this table was never going to hold, so the missing-object
   * check below would otherwise fire on it and report a rule violation as a
   * broken object graph.
   *
   * REFUSED RATHER THAN IGNORED. Ignoring would silently drop a placement the
   * file asked for, which is the one outcome worse than refusing.
   */
  if (role !== ModelPartRole.Root) {
    for (const object of objects.values()) {
      for (const component of object.components) {
        if (component.path === undefined) continue;
        throw importMalformed(
          ImportRefusal.ThreeMfNonRootModelPartPath,
          'This 3MF has a model part that points at a further model part, which the 3MF production extension only allows the main part to do.',
          { objectId: object.id.slice(0, 64), via: 'component' },
        );
      }
    }
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
    for (let at = 0; at < object.components.length; at += 1) {
      const component = object.components[at];
      if (component === undefined) continue;
      /*
       * A CROSS-PART REFERENCE IS NOT RESOLVED AGAINST THIS TABLE, EVER.
       *
       * Its object lives in the part the path names, so `objects` here is the
       * wrong table by construction — and checking it anyway is exactly the
       * v0.1.0 defect that told users a valid slicer export contained a
       * reference to an object that does not exist. The walk resolves it
       * against the part it actually names, and reports
       * `THREEMF_MISSING_MODEL_PART_OBJECT` when it is genuinely absent there.
       */
      if (component.path !== undefined) continue;
      if (objects.has(component.objectId)) continue;
      /*
       * THE IDS REACH THE SENTENCE ONLY IF THEY ARE IDS.
       *
       * `isResourceId` is the same lexical gate `pid` goes through, and it is
       * applied here because an object id is UNTRUSTED text: a file may put a
       * kilobyte of anything in it. A well-formed id is at most ten digits and
       * says exactly where to look; anything else is described in `details` and
       * kept out of the prose, so no refusal can be made to carry arbitrary
       * file content.
       */
      const missing = component.objectId;
      const holder = object.id;
      const locatable = isResourceId(missing) && isResourceId(holder);
      throw importMalformed(
        ImportRefusal.ThreeMfMissingObject,
        locatable
          ? `This 3MF file contains a component that refers to an object which does not exist. Object ${holder}, component ${String(at + 1)} refers to missing object ${missing}.`
          : 'This 3MF file contains a component that refers to an object which does not exist.',
        {
          objectId: missing.slice(0, 64),
          referencingObjectId: holder.slice(0, 64),
          componentIndex: at + 1,
        },
      );
    }
  }
  /*
   * ONLY THE ROOT'S BUILD IS VALIDATED, BECAUSE ONLY THE ROOT'S IS USED.
   *
   * The specification requires a referenced part's build section to be ignored
   * by consumers. Validating one CAD Fixer will never walk would refuse
   * packages that every conformant consumer accepts, on the strength of
   * entries that mean nothing — so a referenced part's build is read into the
   * record and then left alone. See the ignored-metadata note in
   * `expandPackageBuild`.
   *
   * A path-bearing ROOT item is skipped here for the same reason its component
   * equivalent is: its object is in another part's table.
   */
  if (role === ModelPartRole.Root) {
    for (const item of build) {
      if (item.path !== undefined) continue;
      if (!objects.has(item.objectId)) {
        throw importMalformed(
          ImportRefusal.ThreeMfMissingObject,
          'This 3MF file builds an object which does not exist.',
          { objectId: item.objectId.slice(0, 64) },
        );
      }
    }
  }
  /*
   * THE BUILD SECTION IS THE ROOT PART'S, AND ONLY THE ROOT PART'S.
   *
   * A referenced model part is required by the specification to carry an EMPTY
   * build section, and every consumer is required to ignore its entries. So an
   * empty build is malformed in the root and entirely ordinary in a referenced
   * part, and a single rule cannot be right for both.
   *
   * ROOT VALIDATION IS UNCHANGED. `role` defaults to `Root` and production
   * passes nothing else in Stage 6D-A1, so this refusal fires exactly where it
   * fired before. What changed is that a referenced part can now be parsed at
   * all — previously it could not, which was the first blocker A2 would have
   * hit.
   */
  if (role === ModelPartRole.Root && build.length === 0) {
    throw importMalformed(
      ImportRefusal.ThreeMfNoBuildItems,
      'This 3MF file contains no build items, so there is nothing to show.',
    );
  }

  /*
   * EVERY PROPERTY REFERENCE MUST LAND, and this is where that is decided.
   *
   * Deferred to here rather than checked inline so declaration ORDER cannot
   * refuse a valid file. What it catches is the case CAD Fixer used to accept
   * silently — and then reproduce in its own output: `pid="5"` with no resource
   * 5 anywhere.
   *
   * A reference to a property group CAD Fixer does not interpret is NOT an
   * error: the id exists, the file is valid, and the unsupported-feature record
   * above reports that its contents were not imported.
   */
  for (const reference of propertyReferences) {
    if (!propertyGroupIds.has(reference.id)) {
      throw importMalformed(
        ImportRefusal.ThreeMfDanglingPropertyReference,
        'This 3MF file refers to a property resource which does not exist.',
        { pid: reference.id.slice(0, 40), objectId: reference.where },
      );
    }
  }

  return { unit, objects, build, unsupported, role };
}

/**
 * Elements copied between cancellation polls in the materialisation loops.
 *
 * MATCHES `scanXml`'S INTERVAL, deliberately: 65,536 is the number this
 * codebase already uses for "often enough to stop promptly, rarely enough to
 * cost nothing", and a second, different interval would be a second thing to
 * reason about. The loops are blocked rather than tested per element so the
 * inner copy stays a tight loop with no branch in it.
 */
const MATERIALISE_POLL_ELEMENTS = 65_536;

/**
 * Materialises each object's canonical buffers ONCE, shared by every placement.
 *
 * This is where structural sharing is created: every part that resolves to this
 * object receives the SAME `CanonicalMesh` object, so N placements cost N
 * transforms rather than N copies of the geometry.
 *
 * POLLED SINCE STAGE 6D-B2. These loops are bounded only by the document's
 * ceilings, not by anything this file knows, so "it was 71 ms on the fixture I
 * measured" is not a reason to leave them uninterruptible — the same loops run
 * over twenty million triangles' worth of scratch at the document ceiling.
 * `onPoll` is injected rather than imported because this package knows nothing
 * about cancellation tokens, exactly as `decodeText` and `inflateRaw` are
 * injected.
 */
function materialiseMeshes(
  model: ParsedModel,
  stats?: ThreeMfExpansionStats,
  onPoll?: () => void,
): void {
  for (const object of model.objects.values()) {
    if (object.triangles.length === 0) continue;
    onPoll?.();
    if (stats !== undefined) stats.meshResourcesMaterialised += 1;
    const positions = createPositionArray(object.positions.length);
    // ONE ASSIGNMENT PER COMPONENT — the single Float64-to-Float32 conversion.
    for (let from = 0; from < object.positions.length; from += MATERIALISE_POLL_ELEMENTS) {
      const upto = Math.min(from + MATERIALISE_POLL_ELEMENTS, object.positions.length);
      for (let index = from; index < upto; index += 1) {
        positions[index] = object.positions[index] ?? 0;
      }
      onPoll?.();
    }
    const indices = createIndexArray(object.triangles.length);
    for (let from = 0; from < object.triangles.length; from += MATERIALISE_POLL_ELEMENTS) {
      const upto = Math.min(from + MATERIALISE_POLL_ELEMENTS, object.triangles.length);
      for (let index = from; index < upto; index += 1) {
        indices[index] = object.triangles[index] ?? 0;
      }
      onPoll?.();
    }
    object.mesh = { positions, indices, metadata: { sourceFormat: MeshFormatId.ThreeMf } };
    /*
     * THE SCRATCH IS RELEASED HERE — Stage 6D-A2, and it is a lifetime
     * requirement rather than tidiness.
     *
     * `number[]` costs eight bytes an element against the canonical four, so a
     * parsed object holds rather more in scratch than in the buffers built from
     * it. With one model part that merely inflated the peak; with a package of
     * them it would ACCUMULATE, because every loaded part stays reachable from
     * the graph until the import ends — which is exactly the transient
     * accumulation Stage 6D-R1's one-part-in-flight contract exists to prevent.
     *
     * Safe by construction: triangle indices are bounds-checked against
     * `positions.length` during parsing, before this runs, and the package walk
     * reads only `mesh`, `components`, `name` and `materialRef`.
     */
    object.positions.length = 0;
    object.triangles.length = 0;
  }
  /*
   * OBJECTS THAT PRODUCE NO MESH STILL HELD SCRATCH. A component-only object
   * has neither, but an object with vertices and no triangles has a full
   * position array and becomes no part at all — the largest thing a package
   * could keep alive for nothing.
   */
  for (const object of model.objects.values()) {
    if (object.mesh !== undefined) continue;
    object.positions.length = 0;
    object.triangles.length = 0;
  }
}

/**
 * Expands the ROOT's build into parts, following components and package
 * references depth-first.
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
 *
 * STAGE 6D-A2 MADE IT A PACKAGE WALK, and changed nothing else about it. A
 * reference may now carry a production-extension `path`, in which case the
 * object it names is looked up in the part that path resolves to rather than in
 * the part that wrote the reference. Everything the single-part walk guaranteed
 * still holds, and now holds PACKAGE-WIDE: one part table per canonical model
 * part, one running triangle total, one vertex total, one part count, one depth
 * budget and one cycle path.
 *
 * THE ROOT'S BUILD IS THE ONLY BUILD. A referenced part's build section is read
 * into its record and never walked, because the specification requires
 * consumers to ignore it. Walking one would invent placements the package never
 * asked for — the child's own `<item>` entries describe how that part looks on
 * its own, not where it belongs in this document.
 */
interface ExpandedBuild {
  readonly parts: readonly GeometryPart[];
  /**
   * True when at least one imported part came from inside a `<component>`.
   *
   * RECORDED BECAUSE THE HIERARCHY IS NOT RETAINED. A `GeometryDocument` holds
   * leaf placements with composed transforms, which is a faithful description of
   * WHERE everything is and a lossy one of HOW the file said so. Export can
   * therefore not reconstruct the nesting, and a conversion report has to be
   * able to say that — but only when there was nesting to lose. A flat file gets
   * no such note, because inventing one would be a warning about a structure the
   * user never wrote.
   */
  readonly expandedFromComponents: boolean;
}

/** What the package walk needs beyond the graph it walks. */
interface PackageExpansionContext {
  readonly graph: PackageModelGraph<ParsedModel>;
  readonly entries: readonly ZipEntry[];
  readonly limits: ThreeMfLimits;
  readonly zipLimits: ZipLimits;
  readonly stats?: ThreeMfExpansionStats;
  readonly onPoll?: () => void;
}

async function expandPackageBuild(
  root: ModelPart<ParsedModel>,
  context: PackageExpansionContext,
): Promise<ExpandedBuild> {
  const { graph, entries, limits, zipLimits, stats, onPoll } = context;
  const parts: GeometryPart[] = [];
  let expandedFromComponents = false;
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
   * PACKAGE-WIDE SINCE STAGE 6D-A2, and that is the whole reason the walk owns
   * them rather than `parseModelXml` doing so. Stage 6D-R1 recorded that these
   * counters reset per parsed model, which would have let a package of two
   * twelve-million-triangle parts pass a twenty-million ceiling because neither
   * part crossed it alone. There is one walk over the package, so there is one
   * of each of these.
   *
   * BYTES ARE NOT COUNTED HERE, and that is not an oversight:
   * `maxTotalGeometryBytes` is charged per DISTINCT mesh, so placements do not
   * multiply it and the per-object caps already bound each mesh. It stays with
   * the document gate, where the distinct set is known — as does
   * `checkImportGeometry`, which charges canonical and render bytes once per
   * distinct mesh however many parts of however many model parts placed it.
   */
  let totalTriangles = 0;
  let totalVertices = 0;

  /**
   * Resolves the model part a reference's object lives in.
   *
   * WITHOUT A PATH THE ANSWER IS THE REFERRING PART, and there is deliberately
   * no fallback in either direction: a cross-part reference is never retried
   * against the referring part's table, and a local one never reaches the
   * package resolver. Both fallbacks would import geometry the file did not
   * name and report it as success.
   */
  const partFor = async (
    from: ModelPart<ParsedModel>,
    reference: ObjectReference,
  ): Promise<ModelPart<ParsedModel>> => {
    if (reference.path === undefined) return from;
    /*
     * PACKAGE IDENTITY, NOT A FILE PATH AND NOT A URL. `resolvePackageModelPath`
     * validates the reference's shape, refuses traversal, drive letters, URL
     * schemes, control characters and percent-encoded separators, and then looks
     * the canonical key up in THIS ARCHIVE'S directory. Nothing here can reach a
     * filesystem or a network, and a target that is not a `.model` is refused
     * rather than opened.
     */
    const resolved = resolvePackageModelPath(reference.path, entries, zipLimits);
    onPoll?.();
    const part = await graph.ensurePart(resolved.key, ModelPartRole.Referenced, (failure) => {
      throw importTooLarge(
        ImportRefusal.ThreeMfTooManyModelParts,
        `This 3MF would need ${formatCount(failure.loaded + 1)} model parts loaded; CAD Fixer's limit is ${formatCount(failure.limit)}.`,
        { loaded: failure.loaded, limit: failure.limit },
      );
    });
    onPoll?.();
    return part;
  };

  const walk = async (
    from: ModelPart<ParsedModel>,
    reference: ObjectReference,
    transform: PartTransform,
    visited: ReadonlySet<string>,
    depth: number,
    nameHint: string | undefined,
  ): Promise<void> => {
    if (depth > limits.maxComponentDepth) {
      throw importTooLarge(
        ImportRefusal.ThreeMfComponentTooDeep,
        `This 3MF file nests components ${formatCount(depth)} levels deep; CAD Fixer's limit is ${formatCount(limits.maxComponentDepth)} levels.`,
        { depth, limit: limits.maxComponentDepth },
      );
    }

    /*
     * POLLED PER WALK STEP — Stage 6D-B2.
     *
     * Bounded by construction: `maxParts` caps emitted parts and
     * `maxComponentDepth` caps recursion, so this runs at most a few thousand
     * times and costs a flag read each. It is here rather than only at the leaf
     * because a hostile component graph can spend its time in the walk without
     * emitting a part.
     */
    onPoll?.();

    const target = await partFor(from, reference);
    const objectId = reference.objectId;

    /*
     * THE CYCLE PATH IS KEYED ON (MODEL PART, OBJECT), NEVER ON THE BARE ID.
     *
     * Two model parts may each legally declare `id="1"`, so a bare-id path set
     * would call `A.model:1 -> B.model:1` a cycle and refuse a perfectly ordinary
     * package. The same lesson as the document invariant THE PART IS PART OF THE
     * IDENTITY, one level further out.
     *
     * THE DEPTH AND THE PATH DO NOT RESET AT A PART BOUNDARY. A package that
     * could re-enter the budget by crossing into another model part would have
     * no bound at all.
     */
    const identity = objectKeyToString({ part: target.key, objectId });
    if (visited.has(identity)) {
      // A CYCLE IS REFUSED, not survived. Expanding one would either loop
      // forever or silently truncate the model at an arbitrary depth.
      throw importMalformed(
        ImportRefusal.ThreeMfComponentCycle,
        'This 3MF file contains components that refer to each other in a loop.',
        { objectId: objectId.slice(0, 64) },
      );
    }

    const object = target.parsed.objects.get(objectId);
    if (object === undefined) {
      /*
       * TWO DIFFERENT FAILURES, AND THEY SEND A USER TO DIFFERENT PLACES.
       *
       * A local reference to a missing object is a broken object graph inside
       * one model part. A cross-part reference to a missing object is a package
       * whose parts disagree — the target part exists, was opened, parsed
       * cleanly, and simply does not declare what was asked for. There is NO
       * fallback to the referring part's table.
       */
      if (reference.path !== undefined) {
        throw importMalformed(
          ImportRefusal.ThreeMfMissingModelPartObject,
          'This 3MF refers to an object in another part of the package, and that part does not contain it.',
          {
            objectId: objectId.slice(0, 64),
            part: target.key.slice(0, 128),
            referencedFrom: from.key.slice(0, 128),
          },
        );
      }
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
       * ours; the name travels as display metadata. Across model parts this
       * matters more, not less: two parts may each declare `id="1"`.
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
       * as it is known to be too large, not after it has been performed. The
       * count is the PACKAGE'S, so no model part gets an allowance of its own.
       */
      if (parts.length >= limits.maxParts) {
        throw importTooLarge(
          ImportRefusal.ThreeMfTooManyParts,
          `This 3MF file expands to more than ${formatCount(limits.maxParts)} parts, which is CAD Fixer's limit.`,
          { limit: limits.maxParts, emitted: parts.length },
        );
      }

      const prospectiveTriangles = totalTriangles + triangleCount(mesh);
      if (prospectiveTriangles > limits.maxTotalTriangles) {
        throw importTooLarge(
          ImportRefusal.ThreeMfTooManyTriangles,
          `Placing every part of this 3MF file would produce ${formatCount(prospectiveTriangles)} triangles in total; CAD Fixer's limit is ${formatCount(limits.maxTotalTriangles)} triangles.`,
          {
            produced: prospectiveTriangles,
            limit: limits.maxTotalTriangles,
            emitted: parts.length,
          },
        );
      }
      const prospectiveVertices = totalVertices + vertexCount(mesh);
      if (prospectiveVertices > limits.maxTotalVertices) {
        throw importTooLarge(
          ImportRefusal.ThreeMfTooManyVertices,
          `Placing every part of this 3MF file would produce ${formatCount(prospectiveVertices)} vertices in total; CAD Fixer's limit is ${formatCount(limits.maxTotalVertices)} vertices.`,
          {
            produced: prospectiveVertices,
            limit: limits.maxTotalVertices,
            emitted: parts.length,
          },
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

    const nextVisited = new Set(visited).add(identity);
    if (object.components.length > 0) expandedFromComponents = true;
    /*
     * STRICTLY SEQUENTIAL, AND DELIBERATELY NOT `Promise.all`.
     *
     * Two reasons, and either alone would be enough. Ordering: the document's
     * part order must be the file's traversal order, not the order in which
     * loads happened to settle. Lifetime: Stage 6D-R1's contract is that ONE
     * model part is open at a time, and concurrent branches would inflate,
     * decode and parse several at once — which is the transient accumulation
     * the whole resource argument rests on not happening.
     */
    for (const component of object.components) {
      await walk(
        target,
        component,
        composePartTransforms(transform, component.transform),
        nextVisited,
        depth + 1,
        object.name,
      );
    }
  };

  for (const item of root.parsed.build) {
    await walk(root, item, item.transform, new Set<string>(), 0, undefined);
  }
  return { parts, expandedFromComponents };
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

  context.progress.report(0, ThreeMfImportPhase.ReadingPackage);
  const entries = readZipDirectory(bytes, zipLimits);
  throwIfCancelled(context.cancellation);

  const modelEntry = findModelEntry(entries);

  /*
   * ONE BUDGET FOR THE WHOLE ARCHIVE, created here and passed to every entry
   * this import inflates — the root part and every referenced part alike. A
   * per-part budget would be a per-part FULL allowance, which is how a package
   * with twenty parts extracts twenty times the ceiling.
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

  /*
   * BOTH ARE POLLED SINCE STAGE 6D-B2. They were the last two long loops in
   * this reader with no cancellation site at all: a cancel arriving here used
   * to wait for the whole of materialisation and expansion.
   *
   * ONE TOKEN FOR THE WHOLE PACKAGE — Stage 6D-A2. Every model part inflates,
   * decodes, parses and materialises against `context.cancellation`, so a
   * cancel requested while the third child is parsing is observed there rather
   * than being scoped to a part the user never saw.
   */
  const poll = (): void => {
    throwIfCancelled(context.cancellation);
  };

  /*
   * PROGRESS ACROSS AN UNKNOWN NUMBER OF PARTS.
   *
   * How many model parts a package will need is not known until the walk finds
   * them, so the fraction cannot be a share of a total. It approaches the end
   * of the parsing band instead, which is honest about being indeterminate and
   * stays monotonic — a bar that went backwards when a fourth child appeared
   * would be worse than one that slows down.
   *
   * THE ROOT STILL REPORTS `Parsing` AT 0.3, AFTER ITS INFLATE RETURNS. Stage
   * 6D-B2's MF-P24 keys on observing that phase to prove a cancel was requested
   * post-inflation, and that proof must not become a statement about some
   * child's inflate instead.
   */
  let partsLoaded = 0;
  const reportPartProgress = (phase: ThreeMfImportPhase): void => {
    if (partsLoaded === 0) {
      /*
       * THE ROOT KEEPS THE FRACTIONS IT ALWAYS HAD, so a single-part import —
       * still the overwhelming majority — reports exactly the sequence it did
       * before: reading package, decompressing, parsing model, building
       * document, complete.
       */
      context.progress.report(phase === ThreeMfImportPhase.Parsing ? 0.3 : 0.1, phase);
      return;
    }
    const approach = 0.7 - 0.4 / (partsLoaded + 1);
    context.progress.report(approach, phase);
  };

  /**
   * Reads ONE model part: inflate, decode, parse, materialise, release.
   *
   * THE ONLY PLACE A MODEL PART'S BYTES EXIST. The entry buffer and the decoded
   * XML string are locals of this function, so both become collectible the
   * moment it returns; `materialiseMeshes` releases the parser's Float64
   * scratch before that. What survives is canonical geometry and the object
   * table's metadata, which is what the walk needs and all it needs.
   *
   * ONE AT A TIME, guaranteed by the walk awaiting each call before it
   * continues — never by anything in here.
   */
  const loadModelPart = async (
    entry: ZipEntry,
    key: ModelPartKey,
    role: ModelPartRole,
  ): Promise<{ parsed: ParsedModel; unit: string | undefined }> => {
    throwIfCancelled(context.cancellation);
    reportPartProgress(ThreeMfImportPhase.Decompressing);
    const partBytes = await readZipEntry(bytes, entry, zipOptions);
    throwIfCancelled(context.cancellation);

    reportPartProgress(ThreeMfImportPhase.Parsing);
    const partXml = context.decodeText(partBytes);
    throwIfCancelled(context.cancellation);

    const parsed = parseModelXml(
      partXml,
      limits,
      xmlLimits,
      () => {
        /*
         * POLLED EVERY 65,536 ELEMENTS, AND SINCE STAGE 6D-B2 THAT POLL IS
         * REAL. This site existed from the beginning and did nothing:
         * `model/import` was not dispatched as interruptible, so the token it
         * reads was backed only by a `cancel` MESSAGE — and a message cannot be
         * delivered while this synchronous scan is running, because delivering
         * it needs the worker's event loop. The flag could not change, so
         * polling it could not help. Import now carries a `SharedArrayBuffer`
         * control word that the main thread writes with `Atomics.store`, which
         * this observes mid-scan.
         */
        throwIfCancelled(context.cancellation);
      },
      role,
    );
    throwIfCancelled(context.cancellation);
    materialiseMeshes(parsed, options.stats, poll);
    throwIfCancelled(context.cancellation);
    partsLoaded += 1;
    void key;
    return { parsed, unit: parsed.unit };
  };

  /*
   * THE PACKAGE, NOT THE PART — Stage 6D-A2.
   *
   * The graph holds the archive's ONE inflation budget and parses each
   * canonical model part at most once, so a package that places one referenced
   * object fifty times reads it once and shares the result. Entries are handed
   * over as a LOOKUP TABLE and never enumerated into the graph: a `.model`
   * nothing references is never opened, never inflated and never charged.
   *
   * NO `maxModelParts` IS CONFIGURED, and that is Stage 6D-R1's decision
   * standing rather than an omission: the archive's entry ceiling, the one
   * package-wide inflation budget and the document's part and triangle ceilings
   * already bound a multi-part load, and a fourth bound with no measurement
   * behind it would be a number pretending to be a policy.
   */
  const graph = new PackageModelGraph<ParsedModel>({
    rootKey: modelPartKeyOfEntry(modelEntry),
    entries,
    budget,
    load: loadModelPart,
  });

  const rootPart = await graph.ensurePart(graph.rootKey, ModelPartRole.Root, (failure) => {
    throw importTooLarge(
      ImportRefusal.ThreeMfTooManyModelParts,
      `This 3MF would need ${formatCount(failure.loaded + 1)} model parts loaded; CAD Fixer's limit is ${formatCount(failure.limit)}.`,
      { loaded: failure.loaded, limit: failure.limit },
    );
  });
  throwIfCancelled(context.cancellation);

  context.progress.report(0.75, ThreeMfImportPhase.BuildingDocument);
  const { parts, expandedFromComponents } = await expandPackageBuild(rootPart, {
    graph,
    entries,
    limits,
    zipLimits,
    ...(options.stats === undefined ? {} : { stats: options.stats }),
    onPoll: poll,
  });
  throwIfCancelled(context.cancellation);

  /*
   * EVERY REACHABLE PART MUST AGREE ABOUT THE UNIT — Stage 6D-A2.
   *
   * A document holds ONE unit authority, and CAD Fixer never rescales stored
   * coordinates. So a package whose parts declare different units cannot be
   * imported under either of them: reading a child's numbers as the root's unit
   * would silently resize that geometry, and rescaling them would change the
   * exact values that no-tolerance topology, repair and self-intersection all
   * depend on.
   *
   * AN ABSENT `unit` IS MILLIMETRE, because the specification defaults the
   * attribute — so a root that says nothing and a child that says `millimeter`
   * agree, and refusing them would be misreading the format rather than being
   * careful about it.
   *
   * ONLY LOADED PARTS ARE COMPARED, which is the same thing as only reachable
   * ones: a `.model` nothing references is never opened and its unit is not a
   * fact about this document.
   */
  const rootUnit = rootPart.unit ?? THREE_MF_DEFAULT_UNIT;
  for (const part of graph.loaded()) {
    const partUnit = part.unit ?? THREE_MF_DEFAULT_UNIT;
    if (partUnit === rootUnit) continue;
    throw importUnsupported(
      ImportRefusal.ThreeMfInconsistentModelPartUnits,
      'This 3MF stores its objects in several parts that declare different units. CAD Fixer keeps one unit for a model and never rescales geometry, so it cannot combine them.',
      {
        rootUnit: rootUnit.slice(0, 32),
        partUnit: partUnit.slice(0, 32),
        part: part.key.slice(0, 128),
      },
    );
  }

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
  const unit: LengthUnit | undefined = isLengthUnit(rootUnit) ? rootUnit : undefined;

  const document: GeometryDocument = {
    ...(unit === undefined ? {} : { unit }),
    parts,
  };

  const warnings: Diagnostic[] = [];
  const unsupportedFeatures: UnsupportedFeature[] = [];

  /*
   * REPORTED ACROSS THE WHOLE PACKAGE — Stage 6D-A2. A texture declared only in
   * a referenced part is exactly as unimported as one in the root, and saying
   * nothing about it because the root was clean would be the silent drop this
   * reader exists not to perform.
   */
  const unsupportedElements = new Set<string>();
  for (const part of graph.loaded()) {
    for (const element of part.parsed.unsupported) unsupportedElements.add(element);
  }
  const sawTexture = [...unsupportedElements].some((element) => TEXTURE_ELEMENTS.includes(element));
  const sawOtherMaterial = [...unsupportedElements].some(
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

  if (expandedFromComponents) {
    /*
     * NOT AN ERROR AND NOT A DEGRADED IMPORT. Every placement is present and in
     * the right place; what is gone is the nesting that described it. Recorded
     * so a later conversion can say so, and recorded ONLY when it happened.
     */
    unsupportedFeatures.push(UnsupportedFeature.ComponentHierarchy);
    warnings.push(
      diagnostic(
        'THREEMF_COMPONENT_HIERARCHY_FLATTENED',
        'This 3MF file nests objects inside components. Every placement was imported in the right position, but the nesting itself is not kept, so exporting cannot rebuild it.',
      ),
    );
  }

  /*
   * COUNTED OVER THE PARTS THAT WERE ACTUALLY OPENED, never over the archive.
   *
   * A `.model` entry nothing references is not "an unreferenced object" — it is
   * a part of the package this import never had a reason to read, and counting
   * its objects would mean opening it to do so. What this reports is a mesh
   * inside a part the package DID reach whose build never places it.
   */
  const placed = new Set(parts.map((part) => part.mesh));
  let unreferenced = 0;
  for (const part of graph.loaded()) {
    for (const object of part.parsed.objects.values()) {
      if (object.mesh !== undefined && !placed.has(object.mesh)) unreferenced += 1;
    }
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

  context.progress.report(1, ThreeMfImportPhase.Complete);
  return { document, encoding: '3mf', warnings, compatibility };
}
