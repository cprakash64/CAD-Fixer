/**
 * STAGE 6D-R3 — DETERMINISTIC FIXTURE GENERATION FOR RESOURCE QUALIFICATION.
 *
 * NOT A TEST AND NOT PART OF ANY SUITE. Shared by
 * `scripts/import-phases.qualify.mjs`, which imports these builders rather than
 * carrying a second copy: a qualification run that measured a different file
 * from the one a later run measured would not be a ladder.
 *
 * Every builder is deterministic — same argument, same bytes — so a measurement
 * can be repeated exactly. Geometry is a strip of independent triangles in the
 * z=0 plane unless a shape deliberately says otherwise, because the resource
 * question is about COUNTS and SHARING, not about what the model looks like.
 */

import { deflateRawSync } from 'node:zlib';

export const MIB = 1024 * 1024;
export const BINARY_STL_HEADER = 84;
export const BINARY_STL_FACET = 50;

/** Triangles a binary STL of `sizeMb` MiB carries: `(bytes - 84) / 50`, floored. */
export function stlTrianglesFor(sizeMb) {
  return Math.floor((sizeMb * MIB - BINARY_STL_HEADER) / BINARY_STL_FACET);
}

/** A binary STL of `triangles` non-degenerate facets, deterministic. */
export function binaryStl(triangles) {
  const buffer = Buffer.alloc(BINARY_STL_HEADER + BINARY_STL_FACET * triangles);
  buffer.writeUInt32LE(triangles, 80);
  for (let facet = 0; facet < triangles; facet += 1) {
    const at = BINARY_STL_HEADER + facet * BINARY_STL_FACET;
    const x = (facet % 512) * 0.5;
    const y = Math.floor(facet / 512) * 0.5;
    buffer.writeFloatLE(0, at);
    buffer.writeFloatLE(0, at + 4);
    buffer.writeFloatLE(1, at + 8);
    buffer.writeFloatLE(x, at + 12);
    buffer.writeFloatLE(y, at + 16);
    buffer.writeFloatLE(0, at + 20);
    buffer.writeFloatLE(x + 0.4, at + 24);
    buffer.writeFloatLE(y, at + 28);
    buffer.writeFloatLE(0, at + 32);
    buffer.writeFloatLE(x, at + 36);
    buffer.writeFloatLE(y + 0.4, at + 40);
    buffer.writeFloatLE(0, at + 44);
  }
  return buffer;
}

/**
 * T2 — A WELDED GRID, emitted as binary STL facets.
 *
 * WHY THIS SHAPE EXISTS BESIDE `binaryStl`. `binaryStl` writes independent
 * triangles at a spacing that shares no coordinate, so exact-coordinate
 * topology recovers ONE BOUNDARY COMPONENT PER FACE — the T1 worst case. A real
 * print model is nothing like that: its triangles meet, so it welds to about
 * half as many vertices as faces and has a handful of boundary components.
 *
 * Both shapes matter and they are not interchangeable. A ceiling qualified only
 * on T1 would be calibrated against per-component bookkeeping that a real model
 * never pays; a ceiling qualified only on T2 would be blind to the shape an
 * adversarial or badly exported file actually has.
 *
 * Coordinates are written as Float32 from a grid of multiples of 0.5, which are
 * exactly representable, so two facets meeting at a corner store IDENTICAL
 * bytes and weld with no tolerance.
 */
export function weldedStl(targetTriangles) {
  const cells = Math.max(1, Math.floor(targetTriangles / 2));
  const cols = Math.max(2, Math.ceil(Math.sqrt(cells)));
  const rows = Math.max(1, Math.ceil(cells / cols));
  const triangles = rows * cols * 2;
  const buffer = Buffer.alloc(BINARY_STL_HEADER + BINARY_STL_FACET * triangles);
  buffer.writeUInt32LE(triangles, 80);
  let facet = 0;
  const write = (ax, ay, bx, by, cx, cy) => {
    const at = BINARY_STL_HEADER + facet * BINARY_STL_FACET;
    buffer.writeFloatLE(0, at);
    buffer.writeFloatLE(0, at + 4);
    buffer.writeFloatLE(1, at + 8);
    buffer.writeFloatLE(ax, at + 12);
    buffer.writeFloatLE(ay, at + 16);
    buffer.writeFloatLE(0, at + 20);
    buffer.writeFloatLE(bx, at + 24);
    buffer.writeFloatLE(by, at + 28);
    buffer.writeFloatLE(0, at + 32);
    buffer.writeFloatLE(cx, at + 36);
    buffer.writeFloatLE(cy, at + 40);
    buffer.writeFloatLE(0, at + 44);
    facet += 1;
  };
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = col * 0.5;
      const y = row * 0.5;
      write(x, y, x + 0.5, y, x, y + 0.5);
      write(x + 0.5, y, x + 0.5, y + 0.5, x, y + 0.5);
    }
  }
  return buffer;
}

/**
 * T4 — `components` welded patches, each a small grid, laid out far enough
 * apart to share no coordinate. Boundary components scale with `components`
 * while vertices per face stay near the welded ratio, which separates
 * per-component bookkeeping from per-vertex bookkeeping.
 */
export function patchedStl(components, trianglesEach) {
  const cells = Math.max(1, Math.floor(trianglesEach / 2));
  const cols = Math.max(1, Math.ceil(Math.sqrt(cells)));
  const rows = Math.max(1, Math.ceil(cells / cols));
  const perComponent = rows * cols * 2;
  const triangles = perComponent * components;
  const buffer = Buffer.alloc(BINARY_STL_HEADER + BINARY_STL_FACET * triangles);
  buffer.writeUInt32LE(triangles, 80);
  let facet = 0;
  const write = (ax, ay, bx, by, cx, cy) => {
    const at = BINARY_STL_HEADER + facet * BINARY_STL_FACET;
    buffer.writeFloatLE(0, at);
    buffer.writeFloatLE(0, at + 4);
    buffer.writeFloatLE(1, at + 8);
    buffer.writeFloatLE(ax, at + 12);
    buffer.writeFloatLE(ay, at + 16);
    buffer.writeFloatLE(0, at + 20);
    buffer.writeFloatLE(bx, at + 24);
    buffer.writeFloatLE(by, at + 28);
    buffer.writeFloatLE(0, at + 32);
    buffer.writeFloatLE(cx, at + 36);
    buffer.writeFloatLE(cy, at + 40);
    buffer.writeFloatLE(0, at + 44);
    facet += 1;
  };
  const span = (cols + 4) * 0.5;
  for (let component = 0; component < components; component += 1) {
    const ox = (component % 1024) * span;
    const oy = Math.floor(component / 1024) * span;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = ox + col * 0.5;
        const y = oy + row * 0.5;
        write(x, y, x + 0.5, y, x, y + 0.5);
        write(x + 0.5, y, x + 0.5, y + 0.5, x, y + 0.5);
      }
    }
  }
  return buffer;
}

/* ------------------------------------------------------------------ OBJ -- */

/**
 * O1 — MAXIMALLY SHARED. A regular grid of `cols x rows` vertices triangulated
 * into two faces per cell, so vertices ~= faces / 2 and every interior vertex
 * is referenced by six faces. This is the shape that makes a canonical mesh
 * cheapest per triangle, and the one a gate keyed on FILE BYTES gets most
 * wrong.
 */
export function objShared(targetTriangles) {
  const cells = Math.max(1, Math.floor(targetTriangles / 2));
  const cols = Math.max(2, Math.ceil(Math.sqrt(cells)));
  const rows = Math.max(1, Math.ceil(cells / cols));
  const out = [];
  out.push('# CAD Fixer R3 fixture: shared-vertex grid\no shared-grid\n');
  for (let row = 0; row <= rows; row += 1) {
    let block = '';
    for (let col = 0; col <= cols; col += 1) {
      block += `v ${(col * 0.5).toFixed(4)} ${(row * 0.5).toFixed(4)} 0.0000\n`;
    }
    out.push(block);
  }
  const at = (row, col) => row * (cols + 1) + col + 1;
  for (let row = 0; row < rows; row += 1) {
    let block = '';
    for (let col = 0; col < cols; col += 1) {
      block +=
        `f ${at(row, col)} ${at(row, col + 1)} ${at(row + 1, col)}\n` +
        `f ${at(row, col + 1)} ${at(row + 1, col + 1)} ${at(row + 1, col)}\n`;
    }
    out.push(block);
  }
  return Buffer.from(out.join(''), 'utf8');
}

/**
 * O2 — NO SHARING. Three distinct vertices per face, which is the vertex
 * explosion an STL-shaped OBJ actually has: vertices = 3 x faces.
 */
export function objSoup(targetTriangles) {
  const out = ['# CAD Fixer R3 fixture: unshared triangles\no soup\n'];
  const BATCH = 4096;
  for (let index = 0; index < targetTriangles; index += BATCH) {
    const upto = Math.min(index + BATCH, targetTriangles);
    let block = '';
    for (let n = index; n < upto; n += 1) {
      const x = (n % 512) * 0.5;
      const y = Math.floor(n / 512) * 0.5;
      block +=
        `v ${x.toFixed(4)} ${y.toFixed(4)} 0.0000\n` +
        `v ${(x + 0.4).toFixed(4)} ${y.toFixed(4)} 0.0000\n` +
        `v ${x.toFixed(4)} ${(y + 0.4).toFixed(4)} 0.0000\n`;
    }
    out.push(block);
  }
  for (let index = 0; index < targetTriangles; index += BATCH) {
    const upto = Math.min(index + BATCH, targetTriangles);
    let block = '';
    for (let n = index; n < upto; n += 1) {
      const base = n * 3 + 1;
      block += `f ${base} ${base + 1} ${base + 2}\n`;
    }
    out.push(block);
  }
  return Buffer.from(out.join(''), 'utf8');
}

/**
 * O3 — MANY OBJECTS. `objects` separate `o` declarations, each a small
 * unshared patch, so the document carries many PARTS over DISTINCT meshes.
 * OBJ cannot express placement sharing, so this is the only OBJ part-count
 * stress that exists.
 */
export function objManyObjects(objects, trianglesEach) {
  const out = ['# CAD Fixer R3 fixture: many objects\n'];
  let vertexBase = 1;
  for (let object = 0; object < objects; object += 1) {
    let block = `o part-${String(object)}\n`;
    for (let n = 0; n < trianglesEach; n += 1) {
      const x = ((object * trianglesEach + n) % 512) * 0.5;
      const y = Math.floor((object * trianglesEach + n) / 512) * 0.5;
      block +=
        `v ${x.toFixed(4)} ${y.toFixed(4)} 0.0000\n` +
        `v ${(x + 0.4).toFixed(4)} ${y.toFixed(4)} 0.0000\n` +
        `v ${x.toFixed(4)} ${(y + 0.4).toFixed(4)} 0.0000\n`;
    }
    for (let n = 0; n < trianglesEach; n += 1) {
      const base = vertexBase + n * 3;
      block += `f ${base} ${base + 1} ${base + 2}\n`;
    }
    vertexBase += trianglesEach * 3;
    out.push(block);
  }
  return Buffer.from(out.join(''), 'utf8');
}

/* ------------------------------------------------------------------ ZIP -- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A stored-or-deflated ZIP. Same layout the large-entry bench suite writes. */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.content, { level: 6 });
    const crc = crc32(entry.content);

    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.content.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.content.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.byteLength + compressed.byteLength;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  '</Types>';

const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rel0" Target="/3D/3dmodel.model" ' +
  'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
  '</Relationships>';

/** Wraps one `.model` entry into a complete 3MF package. */
export function packageModel(modelXml) {
  return buildZip([
    { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', content: Buffer.from(RELS, 'utf8') },
    { name: '3D/3dmodel.model', content: modelXml },
  ]);
}

const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

/**
 * A PRODUCTION-EXTENSION PACKAGE: a manifest root and `parts` referenced model
 * parts, each carrying `trianglesEach` unshared triangles.
 *
 * THE SHAPE STAGE 6D-A2 ADDED SUPPORT FOR, and the one whose lifetime claim
 * needs measuring: the reader opens the root, then each child in turn, and the
 * claim is that it holds ONE model part's transient at a time. A package built
 * from several large entries is the only way to see whether that is true — a
 * reader that accumulated would grow by roughly one entry per part.
 *
 * Each child is its own ZIP entry, so `maxEntryBytes` applies per child and the
 * package-wide inflation budget applies to their sum.
 */
export function threeMfProductionPackage(parts, trianglesEach) {
  const entries = [
    { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', content: Buffer.from(RELS, 'utf8') },
  ];

  const items = [];
  for (let part = 0; part < parts; part += 1) {
    const path = `3D/Objects/object_${String(part + 1)}.model`;
    items.push(
      `<item objectid="1" p:path="/${path}" transform="1 0 0 0 1 0 0 0 1 ${String(part * 400)} 0 0"/>`,
    );

    const blocks = [
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
        '<resources><object id="1" type="model"><mesh><vertices>',
    ];
    const BATCH = 4096;
    for (let index = 0; index < trianglesEach; index += BATCH) {
      const upto = Math.min(index + BATCH, trianglesEach);
      let block = '';
      for (let n = index; n < upto; n += 1) {
        const x = (n % 512) * 0.5;
        const y = Math.floor(n / 512) * 0.5;
        block +=
          `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
          `<vertex x="${(x + 0.4).toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
          `<vertex x="${x.toFixed(4)}" y="${(y + 0.4).toFixed(4)}" z="0.0000"/>`;
      }
      blocks.push(block);
    }
    blocks.push('</vertices><triangles>');
    for (let index = 0; index < trianglesEach; index += BATCH) {
      const upto = Math.min(index + BATCH, trianglesEach);
      let block = '';
      for (let n = index; n < upto; n += 1) {
        const base = n * 3;
        block += `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`;
      }
      blocks.push(block);
    }
    blocks.push('</triangles></mesh></object></resources><build/></model>');
    entries.push({ name: path, content: Buffer.from(blocks.join(''), 'utf8') });
  }

  const root =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
    `xmlns:p="${PRODUCTION_NS}" requiredextensions="p">` +
    `<resources/><build>${items.join('')}</build></model>`;
  entries.splice(2, 0, { name: '3D/3dmodel.model', content: Buffer.from(root, 'utf8') });

  return buildZip(entries);
}

const HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
  '<resources>';

/** M1 — one object of `triangles` unshared triangles, placed once. */
export function threeMfDense(triangles) {
  const parts = [HEAD, '<object id="1" type="model" name="Dense"><mesh><vertices>'];
  const BATCH = 4096;
  for (let index = 0; index < triangles; index += BATCH) {
    const upto = Math.min(index + BATCH, triangles);
    let block = '';
    for (let n = index; n < upto; n += 1) {
      const x = (n % 512) * 0.5;
      const y = Math.floor(n / 512) * 0.5;
      block +=
        `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
        `<vertex x="${(x + 0.4).toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
        `<vertex x="${x.toFixed(4)}" y="${(y + 0.4).toFixed(4)}" z="0.0000"/>`;
    }
    parts.push(block);
  }
  parts.push('</vertices><triangles>');
  for (let index = 0; index < triangles; index += BATCH) {
    const upto = Math.min(index + BATCH, triangles);
    let block = '';
    for (let n = index; n < upto; n += 1) {
      const base = n * 3;
      block += `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`;
    }
    parts.push(block);
  }
  parts.push('</triangles></mesh></object></resources><build><item objectid="1"/></build></model>');
  return packageModel(Buffer.from(parts.join(''), 'utf8'));
}

/**
 * M4 — PLACEMENT-HEAVY. ONE object of `trianglesEach` triangles, placed
 * `placements` times through separate build items. The document holds
 * `placements` parts over ONE distinct mesh, which is precisely the shape the
 * retired estimator refuses while it costs almost nothing.
 */
export function threeMfPlacements(placements, trianglesEach) {
  const parts = [HEAD, '<object id="1" type="model" name="Unit"><mesh><vertices>'];
  for (let n = 0; n < trianglesEach; n += 1) {
    const x = (n % 64) * 0.5;
    const y = Math.floor(n / 64) * 0.5;
    parts.push(
      `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
        `<vertex x="${(x + 0.4).toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
        `<vertex x="${x.toFixed(4)}" y="${(y + 0.4).toFixed(4)}" z="0.0000"/>`,
    );
  }
  parts.push('</vertices><triangles>');
  for (let n = 0; n < trianglesEach; n += 1) {
    const base = n * 3;
    parts.push(
      `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`,
    );
  }
  parts.push('</triangles></mesh></object></resources><build>');
  for (let n = 0; n < placements; n += 1) {
    const dx = (n % 64) * 40;
    const dy = Math.floor(n / 64) * 40;
    parts.push(`<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${String(dx)} ${String(dy)} 0"/>`);
  }
  parts.push('</build></model>');
  return packageModel(Buffer.from(parts.join(''), 'utf8'));
}

/**
 * M3 — OBJECT-HEAVY. `objects` distinct small objects, each placed once, so
 * the document holds `objects` parts over `objects` DISTINCT meshes.
 */
export function threeMfManyObjects(objects, trianglesEach) {
  const parts = [HEAD];
  for (let object = 0; object < objects; object += 1) {
    const id = object + 1;
    parts.push(`<object id="${String(id)}" type="model" name="o${String(id)}"><mesh><vertices>`);
    for (let n = 0; n < trianglesEach; n += 1) {
      const x = (n % 64) * 0.5;
      const y = Math.floor(n / 64) * 0.5;
      parts.push(
        `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
          `<vertex x="${(x + 0.4).toFixed(4)}" y="${y.toFixed(4)}" z="0.0000"/>` +
          `<vertex x="${x.toFixed(4)}" y="${(y + 0.4).toFixed(4)}" z="0.0000"/>`,
      );
    }
    parts.push('</vertices><triangles>');
    for (let n = 0; n < trianglesEach; n += 1) {
      const base = n * 3;
      parts.push(
        `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`,
      );
    }
    parts.push('</triangles></mesh></object>');
  }
  parts.push('</resources><build>');
  for (let object = 0; object < objects; object += 1) {
    const dx = (object % 64) * 40;
    const dy = Math.floor(object / 64) * 40;
    parts.push(
      `<item objectid="${String(object + 1)}" transform="1 0 0 0 1 0 0 0 1 ${String(dx)} ${String(dy)} 0"/>`,
    );
  }
  parts.push('</build></model>');
  return packageModel(Buffer.from(parts.join(''), 'utf8'));
}
