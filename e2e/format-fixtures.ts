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

/**
 * A tetrahedron carrying an EXACT DUPLICATE FACE — four vertices, five triangles.
 *
 * The conservative repair fixture for 3MF, and genuinely INDEXED in the way that
 * matters: five triangles reference four vertices, so a round trip that returned
 * soup would need fifteen. That is the whole §17 gate.
 */
export function defectiveTetrahedronMesh(scale = 10): string {
  return `<mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/><vertex x="${String(scale)}" y="0" z="0"/>
     <vertex x="0" y="${String(scale)}" z="0"/><vertex x="0" y="0" z="${String(scale)}"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
     <triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
     <triangle v1="0" v2="2" v3="1"/>
    </triangles>
   </mesh>`;
}

/** A millimetre 3MF holding one repairable, genuinely indexed object. */
export function threeMfDefectiveTetrahedron(): Buffer {
  return threeMf(
    modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model" name="Solid">${defectiveTetrahedronMesh()}</object>`,
    }),
  );
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
 * Each entry declares 200 MiB against a 256 MiB per-entry cap, and a ratio
 * under 200:1 against a 200:1 cap — every per-entry ceiling satisfied, and
 * 600 MiB in total against 512 MiB. The UNCOMPRESSED size is declared rather
 * than real, because producing half a gigabyte to prove a half-gigabyte ceiling
 * would allocate exactly what the ceiling exists to prevent.
 *
 * THE COMPRESSED BYTES ARE REAL — Stage 6D-A4. This used to declare 2 MiB of
 * compressed data per entry inside a file of a few hundred bytes, to keep the
 * ratio under the cap. Since Stage 6D-A4 the directory refuses an entry whose
 * data would lie outside the archive, which that one did, so it now carries
 * 1.2 MiB of incompressible bytes per entry and the only ceiling it can reach
 * is the one it exists to prove.
 */
export function zipOverTotalBudget(): Buffer {
  return buildZip(
    ['a', 'b', 'c'].map((name, index) => ({
      name: `3D/${name}.model`,
      content: incompressible(1.2 * 1024 * 1024, index + 1),
      method: 8,
      declaredUncompressedSize: 200 * 1024 * 1024,
    })),
  );
}

/** Deterministic bytes deflate cannot shrink: an xorshift stream, seeded. */
function incompressible(length: number, seed: number): Buffer {
  const out = Buffer.alloc(Math.floor(length));
  let state = 0x9e3779b9 ^ seed;
  for (let at = 0; at < out.length; at += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[at] = state & 0xff;
  }
  return out;
}

/* --------------------------------------- valid but unsupported packages -- */

const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

/**
 * A VALID multi-model-part package, of the shape a consumer slicer emits for a
 * multi-material project.
 *
 * The root model holds only a component; the geometry lives in a second model
 * part, named by the production extension's `path` attribute.
 *
 * STAGE 6D-A2 MADE THIS IMPORT. Stage 6B-C1 used it to prove that a valid file
 * is not described as a broken one — a refusal that named the extension rather
 * than accusing the file. A2 supplies the better answer to the same
 * requirement, so the fixture now proves the geometry arrives.
 */
export function threeMfProductionExtension(): Buffer {
  const root = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}">
 <resources>
  <object id="2" type="model"><components>
   <component p:path="/3D/Objects/object_1.model" objectid="1"/>
  </components></object>
 </resources>
 <build><item objectid="2"/></build>
</model>`;

  const objectPart = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}">
 <resources><object id="1" type="model">${tetrahedronMesh()}</object></resources>
 <build/>
</model>`;

  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    { name: '3D/3dmodel.model', content: root },
    { name: '3D/Objects/object_1.model', content: objectPart },
  ]);
}

/** A genuinely dangling component reference: object 17's second component. */
export function threeMfDanglingComponent(): Buffer {
  return threeMf(
    modelXml({
      unit: 'millimeter',
      resources:
        `<object id="1" type="model">${tetrahedronMesh()}</object>` +
        '<object id="17" type="model"><components>' +
        '<component objectid="1"/><component objectid="42"/>' +
        '</components></object>',
      build: '<item objectid="17"/>',
    }),
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

/**
 * A production-extension package whose referenced model part is not in the
 * archive.
 *
 * THE INCOMPLETE-PACKAGE CASE, kept distinct from the malformed-reference one:
 * the `path` is perfectly well formed and the entry it names simply is not
 * there. Stage 6D-A2 refuses it as `THREEMF_MODEL_PART_NOT_FOUND`, which is a
 * statement about the archive rather than about the reference.
 */
export function threeMfMissingModelPart(): Buffer {
  const root = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}">
 <resources/>
 <build><item objectid="1" p:path="/3D/Objects/absent.model"/></build>
</model>`;

  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    { name: '3D/3dmodel.model', content: root },
  ]);
}

/* ------------------------------------------------- Stage 6D-A4 fixtures -- */

/**
 * Rewrites a finished archive into ZIP64 FORM, the way Bambu Studio and
 * OrcaSlicer write theirs: every size and offset in the central directory is
 * the `0xFFFFFFFF` sentinel with the real values in a tag-1 extra field, and the
 * EOCD defers to a Zip64 record and locator. The local headers are untouched,
 * exactly as in those producers' packages.
 */
export function toZip64(archive: Buffer): Buffer {
  const eocd = archive.length - 22;
  const entryCount = archive.readUInt16LE(eocd + 10);
  let at = archive.readUInt32LE(eocd + 16);
  const locals = archive.subarray(0, at);
  const centrals: Buffer[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = archive.readUInt16LE(at + 28);
    const fixed = Buffer.from(archive.subarray(at, at + 46 + nameLength));
    const compressed = fixed.readUInt32LE(20);
    const uncompressed = fixed.readUInt32LE(24);
    const offset = fixed.readUInt32LE(42);
    fixed.writeUInt32LE(0xffffffff, 20);
    fixed.writeUInt32LE(0xffffffff, 24);
    fixed.writeUInt32LE(0xffffffff, 42);
    fixed.writeUInt16LE(28, 30);
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(uncompressed), 4);
    extra.writeBigUInt64LE(BigInt(compressed), 12);
    extra.writeBigUInt64LE(BigInt(offset), 20);
    centrals.push(fixed, extra);
    at += 46 + nameLength;
  }
  const central = Buffer.concat(centrals);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(entryCount), 24);
  record.writeBigUInt64LE(BigInt(entryCount), 32);
  record.writeBigUInt64LE(BigInt(central.length), 40);
  record.writeBigUInt64LE(BigInt(locals.length), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(locals.length + central.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([locals, central, record, locator, end]);
}

/** The production-extension package in Zip64 form. */
export function threeMfZip64Production(): Buffer {
  return toZip64(threeMfProductionExtension());
}

/** Zip64 form with its record's signature destroyed: corrupt, not "65,535 entries". */
export function threeMfZip64CorruptRecord(): Buffer {
  const archive = threeMfZip64Production();
  archive.writeUInt32LE(0x12345678, archive.length - 22 - 20 - 56);
  return archive;
}

/** An intact directory over a damaged deflate stream in the model part. */
export function threeMfCorruptDeflate(): Buffer {
  const archive = threeMf();
  // Find the model entry's data through its local header, and damage it.
  let at = 0;
  while (archive.readUInt32LE(at) === 0x04034b50) {
    const nameLength = archive.readUInt16LE(at + 26);
    const name = archive.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const data = at + 30 + nameLength + archive.readUInt16LE(at + 28);
    if (name === '3D/3dmodel.model') {
      archive[data] = (archive[data] ?? 0) ^ 0xff;
      archive[data + 1] = (archive[data + 1] ?? 0) ^ 0xff;
      return archive;
    }
    at = data + archive.readUInt32LE(at + 18);
  }
  throw new Error('fixture has no model entry');
}

/** A valid package that REQUIRES an extension CAD Fixer does not implement. */
export function threeMfRequiresUnknownExtension(): Buffer {
  return threeMf(
    modelXml({ unit: 'millimeter' }).replace(
      '<model unit="millimeter"',
      '<model unit="millimeter" xmlns:q="http://example.invalid/quux" requiredextensions="q"',
    ),
  );
}

/**
 * A large production package: the root holds only components, each naming a
 * CHILD model part that carries a large mesh — so parsing, and therefore a
 * cancel, lands inside a child rather than in the root.
 */
export function threeMfProductionLarge(children: number, trianglesPerChild: number): Buffer {
  const vertices: string[] = [];
  const faces: string[] = [];
  for (let index = 0; index < trianglesPerChild; index += 1) {
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
  const child = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}"><resources><object id="1" type="model">${mesh}</object></resources><build/></model>`;
  const components = Array.from(
    { length: children },
    (_child, index) =>
      `<component p:path="/3D/Objects/part_${String(index)}.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 ${String(index * 5)}"/>`,
  ).join('');
  const root = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" requiredextensions="p">
 <resources><object id="9" type="model"><components>${components}</components></object></resources>
 <build><item objectid="9"/></build>
</model>`;
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    { name: '3D/3dmodel.model', content: root },
    ...Array.from({ length: children }, (_child, index) => ({
      name: `3D/Objects/part_${String(index)}.model`,
      content: child,
    })),
  ]);
}

/**
 * A 3MF whose model part DECLARES more than the 256 MiB per-entry ceiling —
 * Stage 6E-A2's eligibility proof. Two mebibytes of incompressible bytes behind
 * a 300 MiB declaration: the declared-to-compressed ratio (~150:1) stays inside
 * the 200:1 directory check, so the refusal is the per-entry one, and it lands
 * before anything is inflated — the bytes are never read.
 */
export function threeMfOverEntryCeiling(): Buffer {
  const noise = Buffer.alloc(2 * 1024 * 1024);
  let seed = 0x6e2;
  for (let at = 0; at < noise.length; at += 4) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    noise.writeUInt32LE(seed, at);
  }
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    { name: '3D/3dmodel.model', content: noise, declaredUncompressedSize: 300 * 1024 * 1024 },
  ]);
}
