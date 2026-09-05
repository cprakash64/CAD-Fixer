import { deflateRawSync } from 'node:zlib';

/**
 * OBJ and 3MF fixture builders for the end-to-end suite.
 *
 * Generated in the test process and handed to the page through Playwright's
 * file-chooser API, so nothing large is committed and every byte under test is
 * auditable here.
 *
 * THE ARCHIVES ARE BUILT BY HAND, byte by byte, for the same reason the
 * research corpus was: a ZIP library will not emit a traversal path, will not
 * lie about a declared size, and has no reason to produce a 1000:1 ratio. The
 * attacks have to be constructed deliberately.
 *
 * `node:zlib` rather than `CompressionStream` here because this half runs in
 * the Playwright process, not the browser, and a synchronous deflate keeps the
 * builders readable. The BROWSER only ever sees finished bytes.
 */

/* -------------------------------------------------------------------- obj -- */

export interface GeneratedObj {
  readonly bytes: Buffer;
  readonly triangles: number;
  readonly objects: number;
}

/** A single triangle. The smallest importable OBJ. */
export function objTriangle(): GeneratedObj {
  return {
    bytes: Buffer.from('v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n', 'utf8'),
    triangles: 1,
    objects: 1,
  };
}

/**
 * `objects` separate `o` records, each a closed tetrahedron, spaced apart.
 *
 * Separated in space so a browser test can tell them apart by bounding box as
 * well as by count.
 */
export function objMultiPart(objects: number, name = 'Part'): GeneratedObj {
  const lines: string[] = [];
  let vertexBase = 0;
  for (let index = 0; index < objects; index += 1) {
    const x = index * 40;
    lines.push(`o ${name} ${String(index + 1)}`);
    lines.push(`v ${String(x)} 0 0`);
    lines.push(`v ${String(x + 10)} 0 0`);
    lines.push(`v ${String(x)} 10 0`);
    lines.push(`v ${String(x)} 0 10`);
    const a = vertexBase + 1;
    lines.push(`f ${String(a)} ${String(a + 2)} ${String(a + 1)}`);
    lines.push(`f ${String(a)} ${String(a + 1)} ${String(a + 3)}`);
    lines.push(`f ${String(a)} ${String(a + 3)} ${String(a + 2)}`);
    lines.push(`f ${String(a + 1)} ${String(a + 2)} ${String(a + 3)}`);
    vertexBase += 4;
  }
  return {
    bytes: Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
    triangles: objects * 4,
    objects,
  };
}

/**
 * Two objects: the first carries an EXACT DUPLICATE FACE, the second is clean.
 *
 * Both are tetrahedra, so neither the vertex count nor the bounding box
 * distinguishes them — only the face count does, and only for the defective
 * one. A report or a repair plan attributed to the wrong part therefore shows
 * up as a wrong number rather than as a passing test.
 */
export function objDefectAndClean(): GeneratedObj {
  const lines: string[] = [
    'o Defective',
    'v 0 0 0',
    'v 10 0 0',
    'v 0 10 0',
    'v 0 0 10',
    'f 1 3 2',
    'f 1 2 4',
    'f 1 4 3',
    'f 2 3 4',
    // The duplicate: same three corners, same rotational order.
    'f 1 3 2',
    'o Clean',
    'v 40 0 0',
    'v 50 0 0',
    'v 40 10 0',
    'v 40 0 10',
    'f 5 7 6',
    'f 5 6 8',
    'f 5 8 7',
    'f 6 7 8',
  ];
  return { bytes: Buffer.from(`${lines.join('\n')}\n`, 'utf8'), triangles: 9, objects: 2 };
}

/** A large single-object OBJ, for responsiveness and cancellation. */
export function objLarge(triangles: number): GeneratedObj {
  const lines: string[] = ['o Large'];
  for (let index = 0; index < triangles; index += 1) {
    const x = (index % 512) * 0.5;
    const y = Math.floor(index / 512) * 0.5;
    lines.push(`v ${x.toFixed(3)} ${y.toFixed(3)} 0`);
    lines.push(`v ${(x + 0.4).toFixed(3)} ${y.toFixed(3)} 0`);
    lines.push(`v ${x.toFixed(3)} ${(y + 0.4).toFixed(3)} 0`);
  }
  for (let index = 0; index < triangles; index += 1) {
    const base = index * 3 + 1;
    lines.push(`f ${String(base)} ${String(base + 1)} ${String(base + 2)}`);
  }
  return { bytes: Buffer.from(`${lines.join('\n')}\n`, 'utf8'), triangles, objects: 1 };
}

/** A quad, which the importer must refuse rather than triangulate. */
export function objWithQuad(): Buffer {
  return Buffer.from('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n', 'utf8');
}

/** A face index that does not exist. */
export function objWithBadIndex(): Buffer {
  return Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n', 'utf8');
}

/** An OBJ naming a remote material library, which must never be fetched. */
export function objWithRemoteMtllib(): Buffer {
  return Buffer.from(
    'mtllib https://evil.test/materials.mtl\nusemtl steel\n' +
      'v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n',
    'utf8',
  );
}

/** An OBJ whose object name contains markup, which must render as text. */
export function objWithHostileName(): Buffer {
  // TWO objects, because a part name is only ever displayed when there is more
  // than one part to choose between. A one-part fixture would pass this test
  // without the name reaching the DOM at all.
  return Buffer.from(
    'o <img src=x onerror="document.title=\'XSS\'">\n' +
      'v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n' +
      'o Harmless\n' +
      'v 20 0 0\nv 30 0 0\nv 20 10 0\nf 4 5 6\n',
    'utf8',
  );
}

/* -------------------------------------------------------------------- zip -- */

export interface ZipFixtureEntry {
  readonly name: string;
  readonly content: string | Buffer;
  /** 0 stored, 8 deflate. Defaults to deflate. */
  readonly method?: number;
  /** Bit 0 set marks the entry encrypted. */
  readonly flags?: number;
  readonly declaredUncompressedSize?: number;
  /**
   * Overrides the compressed size in the directory only.
   *
   * A fixture that declares a large uncompressed size needs a matching
   * compressed size, or the ratio cap refuses it before the total does — and
   * then the test proves the wrong rule.
   */
  readonly declaredCompressedSize?: number;
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds an archive. Every field is settable, so a fixture can lie. */
export function buildZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const raw =
      typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const method = entry.method ?? 8;
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const declaredUncompressed = entry.declaredUncompressedSize ?? raw.length;
    const declaredCompressed = entry.declaredCompressedSize ?? payload.length;
    const flags = entry.flags ?? 0;

    const local = Buffer.alloc(30 + nameBytes.length + payload.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declaredUncompressed, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    payload.copy(local, 30 + nameBytes.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(declaredCompressed, 20);
    central.writeUInt32LE(declaredUncompressed, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

/* -------------------------------------------------------------------- 3mf -- */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/** A closed tetrahedron of the given size, at the origin. */
export function tetrahedronMesh(scale = 10): string {
  return `<mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/><vertex x="${String(scale)}" y="0" z="0"/>
     <vertex x="0" y="${String(scale)}" z="0"/><vertex x="0" y="0" z="${String(scale)}"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
     <triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
    </triangles>
   </mesh>`;
}

export interface ModelXmlOptions {
  readonly unit?: string;
  readonly resources?: string;
  readonly build?: string;
  /** Placed before `<model>`, for prolog attacks. */
  readonly prolog?: string;
}

export function modelXml(options: ModelXmlOptions = {}): string {
  const unit = options.unit === undefined ? '' : ` unit="${options.unit}"`;
  const resources =
    options.resources ?? `<object id="1" type="model" name="Solid">${tetrahedronMesh()}</object>`;
  const build = options.build ?? '<item objectid="1"/>';
  return `<?xml version="1.0" encoding="UTF-8"?>
${options.prolog ?? ''}<model${unit} xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>${resources}</resources>
 <build>${build}</build>
</model>`;
}

/** A well-formed 3MF package around the given model XML. */
export function threeMf(model: string = modelXml({ unit: 'millimeter' })): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    { name: '3D/3dmodel.model', content: model },
  ]);
}

/** Two build items on two distinct objects, placed apart. */
export function threeMfTwoParts(): Buffer {
  return threeMf(
    modelXml({
      resources:
        `<object id="1" type="model" name="Left">${tetrahedronMesh(10)}</object>` +
        `<object id="2" type="model" name="Right">${tetrahedronMesh(6)}</object>`,
      build: '<item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 40 0 0"/>',
    }),
  );
}

/** `count` build items on ONE object: repeated placements sharing geometry. */
export function threeMfSharedPlacements(count: number): Buffer {
  const items = Array.from(
    { length: count },
    (_item, index) =>
      `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${String(index * 20)} 0 0"/>`,
  ).join('');
  return threeMf(
    modelXml({
      resources: `<object id="1" type="model" name="Repeated">${tetrahedronMesh()}</object>`,
      build: items,
    }),
  );
}

/** A nested component instance, so transforms must compose. */
export function threeMfNestedComponents(): Buffer {
  return threeMf(
    modelXml({
      resources:
        `<object id="1" type="model" name="Leaf">${tetrahedronMesh()}</object>` +
        '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 30 0 0"/></components></object>' +
        '<object id="3" type="model"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 0 25 0"/></components></object>',
      build: '<item objectid="1"/><item objectid="3"/>',
    }),
  );
}

/** A large single-object 3MF, for responsiveness and cancellation. */
export function threeMfLarge(triangles: number): Buffer {
  const vertices: string[] = [];
  const faces: string[] = [];
  for (let index = 0; index < triangles; index += 1) {
    const x = (index % 512) * 0.5;
    const y = Math.floor(index / 512) * 0.5;
    const base = index * 3;
    vertices.push(
      `<vertex x="${x.toFixed(3)}" y="${y.toFixed(3)}" z="0"/>` +
        `<vertex x="${(x + 0.4).toFixed(3)}" y="${y.toFixed(3)}" z="0"/>` +
        `<vertex x="${x.toFixed(3)}" y="${(y + 0.4).toFixed(3)}" z="0"/>`,
    );
    faces.push(
      `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`,
    );
  }
  const mesh = `<mesh><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh>`;
  return threeMf(
    modelXml({ resources: `<object id="1" type="model" name="Large">${mesh}</object>` }),
  );
}

/** A 3MF whose object name contains markup, which must render as text. */
export function threeMfHostileName(): Buffer {
  // Two build items, for the same reason as `objWithHostileName`.
  return threeMf(
    modelXml({
      resources:
        `<object id="1" type="model" name="&lt;img src=x onerror=&quot;document.title='XSS'&quot;&gt;">${tetrahedronMesh()}</object>` +
        `<object id="2" type="model" name="Harmless">${tetrahedronMesh(6)}</object>`,
      build: '<item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 40 0 0"/>',
    }),
  );
}

/**
 * A 3MF whose object carries a VALID property reference.
 *
 * `<basematerials id="7">` exists, so `pid="7"` resolves: the file is well
 * formed, CAD Fixer imports the geometry, and the material is reported as
 * unimported rather than the file being refused. This is the fixture the
 * property-reference conformance test converts — the document carries a
 * `materialRef`, and no export may turn it back into a dangling `pid`.
 */
export function threeMfWithMaterial(): Buffer {
  return threeMf(
    modelXml({
      resources:
        '<basematerials id="7"><base name="Steel" displaycolor="#808080FF"/></basematerials>' +
        `<object id="1" type="model" name="Bracket" pid="7">${tetrahedronMesh()}</object>`,
    }),
  );
}

/**
 * A 3MF whose object name contains characters a writer must normalise.
 *
 * A DOUBLE SPACE, which is completely legal in XML and in a 3MF, and which OBJ
 * cannot represent: a reader splits on whitespace, so the name comes back
 * collapsed. Legal input, real loss — which is what the disclosure has to be
 * about.
 */
export function threeMfAwkwardName(): Buffer {
  /*
   * TWO PARTS, so the part selector renders and a test can read the name back
   * off the interface — a one-part document shows no selector at all, which is
   * deliberate and would leave the name unobservable.
   *
   * Only ONE of them is affected, which is also the point: the disclosure has to
   * report the number of names it actually changes, not the number of parts.
   */
  return threeMf(
    modelXml({
      resources:
        `<object id="1" type="model" name="Left  Bracket">${tetrahedronMesh(10)}</object>` +
        `<object id="2" type="model" name="Right Bracket">${tetrahedronMesh(6)}</object>`,
      build: '<item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 40 0 0"/>',
    }),
  );
}

/** A 3MF declaring a texture, which must be reported and never fetched. */
export function threeMfWithTexture(): Buffer {
  return threeMf(
    modelXml({
      resources:
        '<texture2d id="9" path="https://evil.test/skin.png" contenttype="image/png"/>' +
        `<object id="1" type="model" name="Textured">${tetrahedronMesh()}</object>`,
    }),
  );
}

/**
 * More build items than a `GeometryDocument` may hold.
 *
 * ONE OBJECT, `count` placements. The archive is a few kilobytes: the point is
 * that a tiny file can describe a document nothing can hold, which is why the
 * expander has to stop while it walks rather than after it finishes.
 */
export function threeMfPlacements(count: number): Buffer {
  return threeMfSharedPlacements(count);
}

/**
 * An archive whose entries TOGETHER exceed the total uncompressed budget.
 *
 * Each entry declares 200 MiB against a 256 MiB per-entry cap, and a 100:1
 * ratio against a 200:1 cap — every per-entry ceiling satisfied, and 600 MiB
 * in total against 512 MiB. Declared rather than real, because producing half
 * a gigabyte to prove a half-gigabyte ceiling would allocate exactly what the
 * ceiling exists to prevent.
 */
export function zipOverTotalBudget(): Buffer {
  return buildZip(
    ['a', 'b', 'c'].map((name) => ({
      name: `3D/${name}.model`,
      content: 'x',
      method: 8,
      declaredUncompressedSize: 200 * 1024 * 1024,
      declaredCompressedSize: 2 * 1024 * 1024,
    })),
  );
}

/* ------------------------------------------------------ hostile archives -- */

export function zipWithTraversalPath(): Buffer {
  return buildZip([{ name: '../../etc/passwd', content: 'root:x:0:0' }]);
}

export function zipCompressionBomb(): Buffer {
  return buildZip([{ name: '3D/3dmodel.model', content: Buffer.alloc(64 * 1024 * 1024) }]);
}

export function zipEncryptedEntry(): Buffer {
  return buildZip([{ name: '3D/3dmodel.model', content: 'x', flags: 0x1 }]);
}

export function threeMfWithDoctype(): Buffer {
  return threeMf(
    modelXml({ prolog: '<!DOCTYPE model [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>\n' }),
  );
}

export function threeMfWithExternalReference(): Buffer {
  return threeMf(modelXml({ prolog: '<?xml-stylesheet SYSTEM "http://evil.test/x.dtd"?>\n' }));
}

export function threeMfComponentCycle(): Buffer {
  return threeMf(
    modelXml({
      resources:
        '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
        '<object id="2" type="model"><components><component objectid="1"/></components></object>',
      build: '<item objectid="1"/>',
    }),
  );
}
