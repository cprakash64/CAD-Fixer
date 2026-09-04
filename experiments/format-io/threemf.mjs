/**
 * Stage 4A-1-R1 — minimal 3MF core reader and writer. RESEARCH ONLY.
 *
 * Reads exactly the MVP subset: model unit, mesh objects, component objects,
 * build items and their transforms. Everything else is REPORTED as unsupported
 * rather than ignored, because a diagnostic that quietly drops half a file is
 * worse than one that refuses it.
 *
 * STRUCTURAL VALIDITY AND MESH HEALTH ARE DIFFERENT QUESTIONS. A triangle
 * referencing vertex 9 of a 4-vertex mesh is a broken FILE and is refused. A
 * zero-area triangle is valid 3MF describing a defective mesh, so it imports and
 * becomes Mesh Health's problem. Confusing the two would make the importer
 * either too permissive or unable to load the very models the product exists to
 * repair.
 */
import { DEFAULT_ZIP_LIMITS, readDirectory, readEntry } from './zip.mjs';
import { readAttrs, scanXml, XmlError } from './xml-scan.mjs';
import { THREE_MF_UNITS, composeTransforms, IDENTITY_TRANSFORM } from './document.mjs';

export const ThreeMfRefusal = {
  NoModelPart: 'NO_MODEL_PART',
  BadUnit: 'UNSUPPORTED_UNIT',
  DuplicateObjectId: 'DUPLICATE_OBJECT_ID',
  MissingObject: 'MISSING_OBJECT_REFERENCE',
  BadVertexIndex: 'TRIANGLE_INDEX_OUT_OF_RANGE',
  NonFinite: 'NON_FINITE_COORDINATE',
  BadTransform: 'MALFORMED_TRANSFORM',
  ComponentCycle: 'COMPONENT_CYCLE',
  ComponentTooDeep: 'COMPONENT_TOO_DEEP',
  TooManyParts: 'TOO_MANY_PARTS',
  NoBuild: 'NO_BUILD_ITEMS',
};

export class ThreeMfError extends Error {
  constructor(refusal, detail) {
    super(`${refusal}${detail === undefined ? '' : `: ${detail}`}`);
    this.name = 'ThreeMfError';
    this.refusal = refusal;
  }
}

export const DEFAULT_3MF_LIMITS = Object.freeze({
  maxObjects: 65_536,
  maxParts: 65_536,
  maxComponentDepth: 16,
  maxVerticesPerObject: 40_000_000,
  maxTrianglesPerObject: 40_000_000,
});

const MODEL_PART = '3D/3dmodel.model';

function parseNumber(raw, what) {
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new ThreeMfError(ThreeMfRefusal.NonFinite, `${what}="${String(raw)}"`);
  return value;
}

function parseTransform(raw) {
  if (raw === undefined) return IDENTITY_TRANSFORM;
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 12)
    throw new ThreeMfError(ThreeMfRefusal.BadTransform, `${String(parts.length)} values`);
  const values = parts.map((p) => {
    const v = Number(p);
    if (!Number.isFinite(v)) throw new ThreeMfError(ThreeMfRefusal.BadTransform, p);
    return v;
  });
  return values;
}

/** Parses the model XML into resources and build items. No expansion yet. */
export function parseModelXml(xml, limits = DEFAULT_3MF_LIMITS) {
  let unit;
  const objects = new Map();
  const build = [];
  const unsupported = new Set();

  let current;
  let inBuild = false;

  scanXml(xml, {
    onOpen(name, attrText, selfClosing) {
      const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;

      if (local === 'model') {
        const a = readAttrs(attrText);
        unit = a.unit;
        if (unit !== undefined && !THREE_MF_UNITS.includes(unit)) {
          throw new ThreeMfError(ThreeMfRefusal.BadUnit, unit);
        }
        return;
      }

      if (local === 'build') {
        inBuild = true;
        return;
      }

      if (local === 'item' && inBuild) {
        const a = readAttrs(attrText);
        build.push({
          objectid: a.objectid,
          transform: parseTransform(a.transform),
        });
        return;
      }

      if (local === 'object') {
        const a = readAttrs(attrText);
        if (objects.has(a.id)) throw new ThreeMfError(ThreeMfRefusal.DuplicateObjectId, a.id);
        current = {
          id: a.id,
          name: a.name,
          materialRef: a.pid,
          positions: [],
          triangles: [],
          components: [],
        };
        objects.set(a.id, current);
        if (objects.size > limits.maxObjects) throw new ThreeMfError(ThreeMfRefusal.TooManyParts);
        if (selfClosing) current = undefined;
        return;
      }

      if (current === undefined) {
        // Resources we knowingly do not model. RECORDED, never silently dropped.
        if (
          [
            'texture2d',
            'texture2dgroup',
            'colorgroup',
            'basematerials',
            'multiproperties',
          ].includes(local)
        ) {
          unsupported.add(local);
        }
        return;
      }

      if (local === 'vertex') {
        const a = readAttrs(attrText);
        current.positions.push(parseNumber(a.x, 'x'), parseNumber(a.y, 'y'), parseNumber(a.z, 'z'));
        return;
      }
      if (local === 'triangle') {
        const a = readAttrs(attrText);
        current.triangles.push(
          Number.parseInt(a.v1, 10),
          Number.parseInt(a.v2, 10),
          Number.parseInt(a.v3, 10),
        );
        return;
      }
      if (local === 'component') {
        const a = readAttrs(attrText);
        current.components.push({ objectid: a.objectid, transform: parseTransform(a.transform) });
        return;
      }
      if (['texture2d', 'texture2dgroup', 'colorgroup', 'basematerials'].includes(local)) {
        unsupported.add(local);
      }
    },
    onClose(name) {
      const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
      if (local === 'object') current = undefined;
      if (local === 'build') inBuild = false;
    },
  });

  // Structural validation, after the shape is known.
  for (const object of objects.values()) {
    const vertexCount = object.positions.length / 3;
    if (vertexCount > limits.maxVerticesPerObject)
      throw new ThreeMfError(ThreeMfRefusal.TooManyParts);
    for (const index of object.triangles) {
      if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
        throw new ThreeMfError(
          ThreeMfRefusal.BadVertexIndex,
          `object ${String(object.id)} references vertex ${String(index)} of ${String(vertexCount)}`,
        );
      }
    }
    for (const component of object.components) {
      if (!objects.has(component.objectid)) {
        throw new ThreeMfError(
          ThreeMfRefusal.MissingObject,
          `component -> ${String(component.objectid)}`,
        );
      }
    }
  }
  for (const item of build) {
    if (!objects.has(item.objectid)) {
      throw new ThreeMfError(
        ThreeMfRefusal.MissingObject,
        `build item -> ${String(item.objectid)}`,
      );
    }
  }

  return { unit, objects, build, unsupported: [...unsupported] };
}

/**
 * Expands build items into parts, following components.
 *
 * COMPONENTS ARE SUPPORTED, and this is why it was affordable: expansion is a
 * depth-first walk with an explicit path set for cycle detection and a hard
 * depth cap. Geometry is SHARED structurally — every part points at the same
 * vertex arrays as its source object — so N placements of one object cost N
 * transforms, not N copies of the mesh.
 */
export function expandBuild(model, limits = DEFAULT_3MF_LIMITS) {
  const parts = [];

  const walk = (objectId, transform, path, depth, nameHint) => {
    if (depth > limits.maxComponentDepth) {
      throw new ThreeMfError(ThreeMfRefusal.ComponentTooDeep, String(depth));
    }
    if (path.has(objectId)) {
      throw new ThreeMfError(ThreeMfRefusal.ComponentCycle, [...path, objectId].join(' -> '));
    }
    const object = model.objects.get(objectId);
    if (object === undefined) throw new ThreeMfError(ThreeMfRefusal.MissingObject, objectId);

    const hasMesh = object.triangles.length > 0;
    if (hasMesh) {
      parts.push({
        id: `part-${String(parts.length + 1)}`,
        sourceObjectId: objectId,
        name: object.name ?? nameHint,
        materialRef: object.materialRef,
        transform,
        mesh: object.mesh,
      });
      if (parts.length > limits.maxParts) throw new ThreeMfError(ThreeMfRefusal.TooManyParts);
    }

    const nextPath = new Set(path).add(objectId);
    for (const component of object.components) {
      walk(
        component.objectid,
        composeTransforms(transform, component.transform),
        nextPath,
        depth + 1,
        object.name,
      );
    }
  };

  for (const item of model.build) {
    walk(item.objectid, item.transform, new Set(), 0, undefined);
  }
  return parts;
}

/** Materialises each object's Float32 buffers once, shared by every placement. */
export function materialiseMeshes(model) {
  for (const object of model.objects.values()) {
    const positions = new Float32Array(object.positions.length);
    for (let i = 0; i < object.positions.length; i += 1) positions[i] = object.positions[i];
    const indices = new Uint32Array(object.triangles.length);
    for (let i = 0; i < object.triangles.length; i += 1) indices[i] = object.triangles[i];
    object.mesh = { positions, indices };
  }
  return model;
}

/** Reads a 3MF archive into `{ unit, parts, unsupported }`. */
export async function read3mf(bytes, limits = DEFAULT_3MF_LIMITS, zipLimits = DEFAULT_ZIP_LIMITS) {
  const { entries } = readDirectory(bytes, zipLimits);
  const modelEntry =
    entries.find((e) => e.name === MODEL_PART) ??
    entries.find((e) => e.name.toLowerCase().endsWith('.model'));
  if (modelEntry === undefined) throw new ThreeMfError(ThreeMfRefusal.NoModelPart);

  const xml = new TextDecoder('utf-8', { fatal: false }).decode(
    await readEntry(bytes, modelEntry, zipLimits),
  );
  const model = materialiseMeshes(parseModelXml(xml, limits));
  const parts = expandBuild(model, limits);
  return {
    unit: model.unit,
    parts,
    unsupported: model.unsupported,
    objectCount: model.objects.size,
  };
}

export { XmlError };
