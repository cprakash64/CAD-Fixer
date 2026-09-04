/**
 * Stage 4A-1-R1 — minimal 3MF writer. RESEARCH ONLY.
 *
 * Writes the MVP subset only, and writes nothing it cannot round-trip.
 *
 * TWO DIFFERENT NUMERIC CONTRACTS, because there are two different kinds of
 * number here. Mesh coordinates are Float32 and must return bit-identical, which
 * takes nine significant digits. Transforms are Float64 read from text and
 * written back to text; narrowing them to Float32 on the way through would add
 * an error the source never had, so they get seventeen.
 */
import { buildZipArchive } from './zip-write.mjs';
import { escapeXml } from './xml-scan.mjs';
import { IDENTITY_TRANSFORM } from './document.mjs';

const NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

/**
 * Nine significant digits, plus explicit negative zero.
 *
 * Measured, not chosen: across 200,019 finite Float32 values `toFixed(6)`
 * failed to round-trip 101,435 and `toPrecision(8)` failed 3,021. Nine failed
 * only for `-0`, which serialises as "0" and returns `+0`.
 */
export function writeFloat32(value) {
  if (Object.is(value, -0)) return '-0';
  return Number(value.toPrecision(9)).toString();
}

/**
 * Seventeen significant digits: enough for any Float64 to round-trip exactly.
 *
 * `String(v)` already emits the shortest exactly-reparsable form in modern
 * engines, which is why it is used directly rather than padded to a fixed width.
 */
export function writeFloat64(value) {
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

const isIdentity = (t) => t.every((v, i) => v === IDENTITY_TRANSFORM[i]);

/**
 * Serialises parts to model XML.
 *
 * NAMES ARE CONTENT, NEVER PATHS. A part name is escaped and written as an XML
 * attribute value and nowhere else; no archive entry path is ever derived from
 * one. That is what stops a name like `../../evil` from becoming a file.
 */
export function writeModelXml(parts, unit) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="${escapeXml(unit)}" xml:lang="en-US" xmlns="${NS}">`,
    ' <resources>',
  ];

  // One object per part. Structural sharing is not reconstructed on write: two
  // placements of one mesh become two objects, which is honest about what the
  // writer knows rather than guessing that two identical meshes were once one.
  for (const [index, part] of parts.entries()) {
    const id = String(index + 1);
    const nameAttr = part.name === undefined ? '' : ` name="${escapeXml(part.name)}"`;
    const pidAttr = part.materialRef === undefined ? '' : ` pid="${escapeXml(part.materialRef)}"`;
    lines.push(
      `  <object id="${id}" type="model"${nameAttr}${pidAttr}>`,
      '   <mesh>',
      '    <vertices>',
    );
    const { positions, indices } = part.mesh;
    for (let v = 0; v < positions.length; v += 3) {
      lines.push(
        `     <vertex x="${writeFloat32(positions[v])}" y="${writeFloat32(positions[v + 1])}" z="${writeFloat32(positions[v + 2])}"/>`,
      );
    }
    lines.push('    </vertices>', '    <triangles>');
    for (let t = 0; t < indices.length; t += 3) {
      lines.push(
        `     <triangle v1="${String(indices[t])}" v2="${String(indices[t + 1])}" v3="${String(indices[t + 2])}"/>`,
      );
    }
    lines.push('    </triangles>', '   </mesh>', '  </object>');
  }

  lines.push(' </resources>', ' <build>');
  for (const [index, part] of parts.entries()) {
    const transform = part.transform ?? IDENTITY_TRANSFORM;
    const attr = isIdentity(transform)
      ? ''
      : ` transform="${transform.map(writeFloat64).join(' ')}"`;
    lines.push(`  <item objectid="${String(index + 1)}"${attr}/>`);
  }
  lines.push(' </build>', '</model>');
  return lines.join('\n');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/** Writes a complete 3MF archive. Entry paths are FIXED, never derived from data. */
export async function write3mf(parts, unit) {
  if (unit === undefined) {
    throw new Error('BLOCKED_UNIT_REQUIRED: 3MF requires a declared unit');
  }
  const model = writeModelXml(parts, unit);
  return buildZipArchive([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    { name: '3D/3dmodel.model', content: model },
  ]);
}
