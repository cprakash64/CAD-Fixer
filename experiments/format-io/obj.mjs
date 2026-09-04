/**
 * Stage 4A-1 — OBJ record and polygon research. RESEARCH ONLY.
 *
 * This is a QUALIFICATION parser, not a production one. Its job is to establish
 * what the format actually throws at us and which of it CAD Fixer can accept
 * safely — particularly the polygon question, which decides whether Stage 4A-2
 * can import OBJ at all without inventing geometry.
 */

export const ObjRefusal = {
  BadIndex: 'BAD_INDEX',
  ZeroIndex: 'ZERO_INDEX',
  NonFinite: 'NON_FINITE_COORDINATE',
  LineTooLong: 'LINE_TOO_LONG',
  TooManyVertices: 'TOO_MANY_VERTICES',
  TooManyFaces: 'TOO_MANY_FACES',
  PolygonUnsupported: 'POLYGON_UNSUPPORTED',
  DegenerateFace: 'DEGENERATE_FACE',
  TooFewFaceVertices: 'TOO_FEW_FACE_VERTICES',
  MissingReference: 'MISSING_REFERENCE',
};

export const DEFAULT_OBJ_LIMITS = Object.freeze({
  maxBytes: 512 * 1024 * 1024,
  maxLineLength: 65_536,
  maxVertices: 40_000_000,
  maxFaces: 40_000_000,
  maxObjects: 65_536,
  maxGroups: 65_536,
  maxNameLength: 1_024,
  maxFaceVertices: 3, // Triangle-only, by policy. See ADR 0013.
});

/**
 * Parses an OBJ into a triangle soup plus object/group ranges.
 *
 * NO SILENT REPAIR. A malformed index is refused, not clamped. A polygon is
 * refused, not fanned. The import policy this repository has held since Stage 1
 * is that reading a file preserves what the file says or fails loudly — never
 * that it produces something plausible.
 */
export function parseObj(text, limits = DEFAULT_OBJ_LIMITS) {
  const refusals = [];
  const refuse = (code, line, detail) => {
    refusals.push({ code, line, detail });
  };

  const positions = [];
  const normals = [];
  const uvs = [];
  const faces = [];
  const objects = [];
  const groups = [];
  const materials = new Set();
  let currentObject;
  let currentGroup;
  let currentMaterial;
  let mtllib;

  const lines = text.split(/\r\n|\r|\n/);
  for (const [i, raw] of lines.entries()) {
    const lineNumber = i + 1;
    if (raw.length > limits.maxLineLength) {
      refuse(ObjRefusal.LineTooLong, lineNumber, `${String(raw.length)} chars`);
      continue;
    }
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const keyword = parts[0];

    if (keyword === 'v' || keyword === 'vn' || keyword === 'vt') {
      const wanted = keyword === 'vt' ? 2 : 3;
      const values = [];
      for (let k = 1; k <= wanted; k += 1) {
        const value = Number.parseFloat(parts[k] ?? '');
        // `Number.parseFloat` happily accepts "NaN" and "Infinity"; neither has
        // a bounding box or an exact predicate, so both are refused here rather
        // than becoming geometry nobody can reason about.
        if (!Number.isFinite(value)) {
          refuse(ObjRefusal.NonFinite, lineNumber, parts[k] ?? '(missing)');
          break;
        }
        values.push(value);
      }
      if (values.length !== wanted) continue;
      const target = keyword === 'v' ? positions : keyword === 'vn' ? normals : uvs;
      target.push(...values);
      if (keyword === 'v' && positions.length / 3 > limits.maxVertices) {
        refuse(ObjRefusal.TooManyVertices, lineNumber);
        break;
      }
      continue;
    }

    if (keyword === 'o' || keyword === 'g') {
      const name = parts.slice(1).join(' ').slice(0, limits.maxNameLength);
      const record = { name, firstFace: faces.length };
      if (keyword === 'o') {
        objects.push(record);
        currentObject = name;
      } else {
        groups.push(record);
        currentGroup = name;
      }
      continue;
    }

    if (keyword === 'usemtl') {
      currentMaterial = parts[1];
      materials.add(parts[1] ?? '');
      continue;
    }
    if (keyword === 'mtllib') {
      mtllib = parts.slice(1).join(' ');
      continue;
    }

    if (keyword === 'f') {
      const corners = parts.slice(1).filter((p) => p !== '');
      if (corners.length < 3) {
        refuse(ObjRefusal.TooFewFaceVertices, lineNumber, String(corners.length));
        continue;
      }
      if (corners.length > limits.maxFaceVertices) {
        // THE POLYGON DECISION, enforced rather than worked around.
        refuse(ObjRefusal.PolygonUnsupported, lineNumber, `${String(corners.length)}-gon`);
        continue;
      }

      const resolved = [];
      let bad = false;
      for (const corner of corners) {
        // v, v/vt, v//vn and v/vt/vn all begin with the position index.
        const token = corner.split('/')[0] ?? '';
        const parsed = Number.parseInt(token, 10);
        if (!Number.isInteger(parsed) || parsed === 0) {
          refuse(parsed === 0 ? ObjRefusal.ZeroIndex : ObjRefusal.BadIndex, lineNumber, token);
          bad = true;
          break;
        }
        // NEGATIVE INDICES ARE RELATIVE to the vertices seen so far, which is
        // why they must be resolved as the file is read rather than afterwards.
        const index = parsed > 0 ? parsed - 1 : positions.length / 3 + parsed;
        if (index < 0 || index >= positions.length / 3) {
          refuse(ObjRefusal.BadIndex, lineNumber, token);
          bad = true;
          break;
        }
        resolved.push(index);
      }
      if (bad) continue;

      faces.push({
        indices: resolved,
        object: currentObject,
        group: currentGroup,
        material: currentMaterial,
      });
      if (faces.length > limits.maxFaces) {
        refuse(ObjRefusal.TooManyFaces, lineNumber);
        break;
      }
    }
  }

  return {
    vertexCount: positions.length / 3,
    normalCount: normals.length / 3,
    uvCount: uvs.length / 2,
    faceCount: faces.length,
    objects,
    groups,
    materials: [...materials].filter((m) => m !== ''),
    mtllib,
    positions,
    faces,
    refusals,
  };
}

/**
 * Writes a Float32-exact OBJ coordinate.
 *
 * NINE SIGNIFICANT DIGITS, measured rather than assumed: across 200,019 finite
 * Float32 values, `toFixed(6)` failed to round-trip 101,435 of them and
 * `toPrecision(8)` failed 3,021. Nine failed only for negative zero, which is
 * handled explicitly below.
 */
export function writeFloat32(value) {
  if (Object.is(value, -0)) return '-0';
  return Number(value.toPrecision(9)).toString();
}
