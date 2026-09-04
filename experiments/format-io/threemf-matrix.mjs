/**
 * Stage 4A-1-R1 — 3MF round-trip, invalid-input, F10-F17 and writer-security
 * matrices. RESEARCH ONLY.
 *
 * The independent oracle for produced archives is Node's own `zlib` inflater
 * driven by a separate reader, plus a structural XML check that does not use the
 * scanner under test. Validating our writer with only our reader would prove the
 * two agree, which is not the same as being right.
 */
import { inflateRawSync } from 'node:zlib';
import { buildZip } from './zip-fixtures.mjs';
import { read3mf } from './threemf.mjs';
import { write3mf, writeModelXml } from './threemf-write.mjs';
import { IDENTITY_TRANSFORM, applyTransform } from './document.mjs';

const say = (l = '') => process.stdout.write(`${l}\n`);
let pass = 0;
let total = 0;
function check(id, description, fn) {
  total += 1;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      say(`${id.padEnd(7)} PASS  ${description}`);
    })
    .catch((error) => {
      say(`${id.padEnd(7)} ***FAIL*** ${description}\n          ${error.message}`);
    });
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

/* ---------------------------------------------------------- fixtures -- */

const tetra = (offset = 0) => ({
  vertices: [0 + offset, 0, 0, 10 + offset, 0, 0, 0 + offset, 10, 0, 0 + offset, 0, 10],
  triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
});

function modelXml({ unit = 'millimeter', objects, build }) {
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
    ' <resources>',
  ];
  for (const o of objects) {
    const nameAttr = o.name === undefined ? '' : ` name="${o.name}"`;
    const pidAttr = o.pid === undefined ? '' : ` pid="${o.pid}"`;
    parts.push(`  <object id="${o.id}" type="model"${nameAttr}${pidAttr}>`);
    if (o.components !== undefined) {
      parts.push('   <components>');
      for (const c of o.components) {
        const t = c.transform === undefined ? '' : ` transform="${c.transform}"`;
        parts.push(`    <component objectid="${c.objectid}"${t}/>`);
      }
      parts.push('   </components>');
    } else {
      parts.push('   <mesh>', '    <vertices>');
      for (let i = 0; i < o.vertices.length; i += 3) {
        parts.push(
          `     <vertex x="${o.vertices[i]}" y="${o.vertices[i + 1]}" z="${o.vertices[i + 2]}"/>`,
        );
      }
      parts.push('    </vertices>', '    <triangles>');
      for (let i = 0; i < o.triangles.length; i += 3) {
        parts.push(
          `     <triangle v1="${o.triangles[i]}" v2="${o.triangles[i + 1]}" v3="${o.triangles[i + 2]}"/>`,
        );
      }
      parts.push('    </triangles>', '   </mesh>');
    }
    parts.push('  </object>');
  }
  parts.push(' </resources>', ' <build>');
  for (const b of build) {
    const t = b.transform === undefined ? '' : ` transform="${b.transform}"`;
    parts.push(`  <item objectid="${b.objectid}"${t}/>`);
  }
  parts.push(' </build>', '</model>');
  return parts.join('\n');
}

const archive = async (xml) =>
  buildZip([
    { name: '[Content_Types].xml', method: 8, content: '<Types/>' },
    { name: '_rels/.rels', method: 8, content: '<Relationships/>' },
    { name: '3D/3dmodel.model', method: 8, content: xml },
  ]);

/* ------------------------------------------------- independent oracle -- */

/** Reads an archive WITHOUT the reader under test. */
function oracleEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map();
  for (let i = 0; i < bytes.length - 4; i += 1) {
    if (view.getUint32(i, true) !== 0x04034b50) continue;
    const method = view.getUint16(i + 8, true);
    const crcDeclared = view.getUint32(i + 14, true);
    const compressed = view.getUint32(i + 18, true);
    const uncompressed = view.getUint32(i + 22, true);
    const nameLength = view.getUint16(i + 26, true);
    const extraLength = view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLength));
    const start = i + 30 + nameLength + extraLength;
    const payload = bytes.subarray(start, start + compressed);
    const content = method === 8 ? inflateRawSync(payload) : payload;
    out.set(name, { content, declaredUncompressed: uncompressed, crcDeclared });
  }
  return out;
}

/** Structural XML check that does not use the scanner under test. */
function oracleXmlWellFormed(text) {
  const stack = [];
  const tag = /<\/?([A-Za-z_:][\w.:-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = tag.exec(text)) !== null) {
    const whole = m[0];
    if (whole.startsWith('</')) {
      if (stack.pop() !== m[1]) return false;
    } else if (m[3] !== '/') {
      stack.push(m[1]);
    }
  }
  return stack.length === 0;
}

/* ------------------------------------------------------- RT matrix -- */

say('=== RT: 3MF round trips ===');

const roundTrip = async (parts, unit) => {
  const bytes = await write3mf(parts, unit);
  return { bytes, back: await read3mf(bytes) };
};

const meshOf = (v, t) => ({
  positions: Float32Array.from(v),
  indices: Uint32Array.from(t),
});

await check('RT01', 'single mesh, one build item', async () => {
  const t = tetra();
  const parts = [
    { id: 'p1', mesh: meshOf(t.vertices, t.triangles), transform: IDENTITY_TRANSFORM },
  ];
  const { back } = await roundTrip(parts, 'millimeter');
  assert(back.parts.length === 1, 'part count');
  assert(back.unit === 'millimeter', 'unit');
  const m = back.parts[0].mesh;
  assert(m.positions.length === 12 && m.indices.length === 12, 'geometry size');
  for (let i = 0; i < 12; i += 1) {
    assert(
      Object.is(m.positions[i], parts[0].mesh.positions[i]),
      `coordinate ${String(i)} differs`,
    );
    assert(m.indices[i] === parts[0].mesh.indices[i], `index ${String(i)} differs`);
  }
});

await check('RT02', 'multiple independent parts', async () => {
  const a = tetra(0);
  const b = tetra(100);
  const parts = [
    { id: 'a', name: 'left', mesh: meshOf(a.vertices, a.triangles), transform: IDENTITY_TRANSFORM },
    {
      id: 'b',
      name: 'right',
      mesh: meshOf(b.vertices, b.triangles),
      transform: IDENTITY_TRANSFORM,
    },
  ];
  const { back } = await roundTrip(parts, 'millimeter');
  assert(back.parts.length === 2, `part count ${String(back.parts.length)}`);
  assert(back.parts[0].name === 'left' && back.parts[1].name === 'right', 'names lost');
  assert(
    !Object.is(back.parts[0].mesh.positions[0], back.parts[1].mesh.positions[0]),
    'parts merged',
  );
});

await check('RT03', 'same mesh referenced by two build items', async () => {
  const xml = modelXml({
    objects: [{ id: '1', ...tetra() }],
    build: [{ objectid: '1' }, { objectid: '1', transform: '1 0 0 0 1 0 0 0 1 50 0 0' }],
  });
  const r = await read3mf(await archive(xml));
  assert(r.parts.length === 2, `expected two placements, got ${String(r.parts.length)}`);
  // STRUCTURAL SHARING: one object materialised once, two placements.
  assert(r.parts[0].mesh === r.parts[1].mesh, 'geometry was duplicated per placement');
  assert(r.parts[1].transform[9] === 50, 'second placement transform lost');
  assert(r.objectCount === 1, 'object count');
});

await check('RT04', 'translated item', async () => {
  const t = tetra();
  const parts = [
    {
      id: 'p',
      mesh: meshOf(t.vertices, t.triangles),
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 3.5, -2.25, 7],
    },
  ];
  const { back } = await roundTrip(parts, 'millimeter');
  const tr = back.parts[0].transform;
  assert(tr[9] === 3.5 && tr[10] === -2.25 && tr[11] === 7, `transform ${JSON.stringify(tr)}`);
  // Local coordinates are untouched by placement.
  assert(Object.is(back.parts[0].mesh.positions[0], 0), 'local coordinates were baked');
});

await check('RT05', 'rotated and scaled item', async () => {
  const t = tetra();
  const rotScale = [0, 2, 0, -2, 0, 0, 0, 0, 2, 0, 0, 0];
  const parts = [{ id: 'p', mesh: meshOf(t.vertices, t.triangles), transform: rotScale }];
  const { back } = await roundTrip(parts, 'millimeter');
  const placed = applyTransform(back.parts[0].transform, [1, 0, 0]);
  assert(placed[0] === 0 && placed[1] === 2, `placement ${JSON.stringify(placed)}`);
});

await check('RT06', 'non-millimetre unit survives exactly', async () => {
  for (const unit of ['micron', 'centimeter', 'inch', 'foot', 'meter']) {
    const t = tetra();
    const parts = [
      { id: 'p', mesh: meshOf(t.vertices, t.triangles), transform: IDENTITY_TRANSFORM },
    ];
    const { back } = await roundTrip(parts, unit);
    assert(back.unit === unit, `unit ${unit} became ${String(back.unit)}`);
    // Coordinates are NOT rescaled by the unit.
    assert(Object.is(back.parts[0].mesh.positions[3], 10), `coordinates rescaled for ${unit}`);
  }
});

await check('RT07', 'names round-trip', async () => {
  const t = tetra();
  const parts = [
    {
      id: 'p',
      name: 'Bracket 12',
      mesh: meshOf(t.vertices, t.triangles),
      transform: IDENTITY_TRANSFORM,
    },
  ];
  const { back } = await roundTrip(parts, 'millimeter');
  assert(back.parts[0].name === 'Bracket 12', `name became ${String(back.parts[0].name)}`);
});

await check('RT08', 'material reference string round-trips', async () => {
  const t = tetra();
  const parts = [
    {
      id: 'p',
      materialRef: '7',
      mesh: meshOf(t.vertices, t.triangles),
      transform: IDENTITY_TRANSFORM,
    },
  ];
  const { back } = await roundTrip(parts, 'millimeter');
  assert(
    back.parts[0].materialRef === '7',
    `materialRef became ${String(back.parts[0].materialRef)}`,
  );
});

await check('RT09', 'component instance expands to a part per placement', async () => {
  const xml = modelXml({
    objects: [
      { id: '1', ...tetra() },
      {
        id: '2',
        components: [{ objectid: '1' }, { objectid: '1', transform: '1 0 0 0 1 0 0 0 1 20 0 0' }],
      },
    ],
    build: [{ objectid: '2' }],
  });
  const r = await read3mf(await archive(xml));
  assert(r.parts.length === 2, `expected two instances, got ${String(r.parts.length)}`);
  assert(r.parts[0].mesh === r.parts[1].mesh, 'component geometry duplicated');
  assert(r.parts[1].transform[9] === 20, 'component transform lost');
});

await check('RT10', 'nested component transforms compose', async () => {
  const xml = modelXml({
    objects: [
      { id: '1', ...tetra() },
      { id: '2', components: [{ objectid: '1', transform: '1 0 0 0 1 0 0 0 1 10 0 0' }] },
      { id: '3', components: [{ objectid: '2', transform: '1 0 0 0 1 0 0 0 1 0 5 0' }] },
    ],
    build: [{ objectid: '3' }],
  });
  const r = await read3mf(await archive(xml));
  assert(r.parts.length === 1, 'expected one leaf part');
  const p = applyTransform(r.parts[0].transform, [0, 0, 0]);
  // outer(+0,+5) applied after inner(+10,0) => (10, 5, 0)
  assert(p[0] === 10 && p[1] === 5, `composed placement ${JSON.stringify(p)}`);
});

/* ---------------------------------------------------- invalid inputs -- */

say('');
say('=== invalid 3MF structure ===');

const invalid = [
  [
    'missing vertex reference',
    modelXml({
      objects: [{ id: '1', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 9] }],
      build: [{ objectid: '1' }],
    }),
    'TRIANGLE_INDEX_OUT_OF_RANGE',
  ],
  [
    'duplicate object id',
    modelXml({
      objects: [
        { id: '1', ...tetra() },
        { id: '1', ...tetra() },
      ],
      build: [{ objectid: '1' }],
    }),
    'DUPLICATE_OBJECT_ID',
  ],
  [
    'build references missing object',
    modelXml({ objects: [{ id: '1', ...tetra() }], build: [{ objectid: '99' }] }),
    'MISSING_OBJECT_REFERENCE',
  ],
  [
    'NaN coordinate',
    modelXml({
      objects: [{ id: '1', vertices: [0, 0, 0, NaN, 0, 0, 0, 1, 0], triangles: [0, 1, 2] }],
      build: [{ objectid: '1' }],
    }),
    'NON_FINITE_COORDINATE',
  ],
  [
    'Infinity coordinate',
    modelXml({
      objects: [{ id: '1', vertices: [0, 0, 0, Infinity, 0, 0, 0, 1, 0], triangles: [0, 1, 2] }],
      build: [{ objectid: '1' }],
    }),
    'NON_FINITE_COORDINATE',
  ],
  [
    'malformed transform (10 values)',
    modelXml({
      objects: [{ id: '1', ...tetra() }],
      build: [{ objectid: '1', transform: '1 0 0 0 1 0 0 0 1 5' }],
    }),
    'MALFORMED_TRANSFORM',
  ],
  [
    'non-numeric transform',
    modelXml({
      objects: [{ id: '1', ...tetra() }],
      build: [{ objectid: '1', transform: '1 0 0 0 1 0 0 0 1 a b c' }],
    }),
    'MALFORMED_TRANSFORM',
  ],
  [
    'unsupported unit',
    modelXml({ unit: 'furlong', objects: [{ id: '1', ...tetra() }], build: [{ objectid: '1' }] }),
    'UNSUPPORTED_UNIT',
  ],
  [
    'component cycle',
    modelXml({
      objects: [
        { id: '1', components: [{ objectid: '2' }] },
        { id: '2', components: [{ objectid: '1' }] },
      ],
      build: [{ objectid: '1' }],
    }),
    'COMPONENT_CYCLE',
  ],
  [
    'component references missing object',
    modelXml({
      objects: [{ id: '1', components: [{ objectid: '42' }] }],
      build: [{ objectid: '1' }],
    }),
    'MISSING_OBJECT_REFERENCE',
  ],
];

for (const [name, xml, expected] of invalid) {
  await check('INV', `refuses ${name} (${expected})`, async () => {
    let refusal = '';
    try {
      await read3mf(await archive(xml));
    } catch (error) {
      refusal = error.refusal ?? error.name;
    }
    assert(refusal === expected, `got "${refusal}"`);
  });
}

// Structurally VALID but geometrically defective: must import, not refuse.
await check('INV', 'imports a zero-area triangle as geometry, not as corruption', async () => {
  const xml = modelXml({
    objects: [{ id: '1', vertices: [0, 0, 0, 1, 0, 0, 2, 0, 0], triangles: [0, 1, 2] }],
    build: [{ objectid: '1' }],
  });
  const r = await read3mf(await archive(xml));
  assert(r.parts.length === 1, 'collinear triangle was refused by the parser');
  assert(r.parts[0].mesh.indices.length === 3, 'geometry lost');
});

await check('INV', 'an object with vertices but no triangles produces no part', async () => {
  const xml = modelXml({
    objects: [{ id: '1', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [] }],
    build: [{ objectid: '1' }],
  });
  const r = await read3mf(await archive(xml));
  assert(r.parts.length === 0, `expected no parts, got ${String(r.parts.length)}`);
});

await check('INV', 'an UNUSED resource object does not become a visible part', async () => {
  const xml = modelXml({
    objects: [
      { id: '1', ...tetra() },
      { id: '2', ...tetra(50) },
    ],
    build: [{ objectid: '1' }],
  });
  const r = await read3mf(await archive(xml));
  assert(r.objectCount === 2, 'both objects should be parsed as resources');
  assert(r.parts.length === 1, `only the built item is a part, got ${String(r.parts.length)}`);
});

await check('INV', 'refuses a model with no build items', async () => {
  const xml = modelXml({ objects: [{ id: '1', ...tetra() }], build: [] });
  const r = await read3mf(await archive(xml));
  assert(r.parts.length === 0, 'no build items must yield no parts');
});

/* -------------------------------------------------------- F10-F17 -- */

say('');
say('=== F10-F17 corpus ===');

await check('F10', 'simple one-object 3MF', async () => {
  const r = await read3mf(
    await archive(modelXml({ objects: [{ id: '1', ...tetra() }], build: [{ objectid: '1' }] })),
  );
  assert(r.parts.length === 1 && r.parts[0].mesh.indices.length === 12, 'geometry');
});
await check('F11', 'explicit millimetre', async () => {
  const r = await read3mf(
    await archive(
      modelXml({
        unit: 'millimeter',
        objects: [{ id: '1', ...tetra() }],
        build: [{ objectid: '1' }],
      }),
    ),
  );
  assert(r.unit === 'millimeter', 'unit');
});
await check('F12', 'non-mm unit (inch)', async () => {
  const r = await read3mf(
    await archive(
      modelXml({ unit: 'inch', objects: [{ id: '1', ...tetra() }], build: [{ objectid: '1' }] }),
    ),
  );
  assert(r.unit === 'inch', 'unit');
  assert(r.parts[0].mesh.positions[3] === 10, 'coordinates were rescaled');
});
await check('F13', 'multiple build items', async () => {
  const r = await read3mf(
    await archive(
      modelXml({
        objects: [
          { id: '1', ...tetra() },
          { id: '2', ...tetra(50) },
        ],
        build: [{ objectid: '1' }, { objectid: '2' }],
      }),
    ),
  );
  assert(r.parts.length === 2, 'part count');
});
await check('F14', 'transformed instance', async () => {
  const r = await read3mf(
    await archive(
      modelXml({
        objects: [{ id: '1', ...tetra() }],
        build: [{ objectid: '1', transform: '2 0 0 0 2 0 0 0 2 1 2 3' }],
      }),
    ),
  );
  const p = applyTransform(r.parts[0].transform, [1, 1, 1]);
  assert(p[0] === 3 && p[1] === 4 && p[2] === 5, `placement ${JSON.stringify(p)}`);
});
await check('F15', 'repeated component instance', async () => {
  const r = await read3mf(
    await archive(
      modelXml({
        objects: [
          { id: '1', ...tetra() },
          {
            id: '2',
            components: [
              { objectid: '1' },
              { objectid: '1', transform: '1 0 0 0 1 0 0 0 1 30 0 0' },
              { objectid: '1', transform: '1 0 0 0 1 0 0 0 1 60 0 0' },
            ],
          },
        ],
        build: [{ objectid: '2' }],
      }),
    ),
  );
  assert(r.parts.length === 3, `expected three instances, got ${String(r.parts.length)}`);
  assert(r.parts[0].mesh === r.parts[2].mesh, 'geometry duplicated across instances');
});
await check(
  'F16',
  'materials/colours are recorded as unsupported, reference preserved',
  async () => {
    const xml = modelXml({
      objects: [{ id: '1', pid: '5', ...tetra() }],
      build: [{ objectid: '1' }],
    }).replace(
      '<resources>',
      '<resources>\n  <basematerials id="5"><base name="red" displaycolor="#FF0000"/></basematerials>',
    );
    const r = await read3mf(await archive(xml));
    assert(r.parts[0].materialRef === '5', 'material reference lost');
    assert(r.unsupported.includes('basematerials'), 'basematerials not reported unsupported');
  },
);
await check('F17', 'texture resource is reported unsupported, never silently dropped', async () => {
  const xml = modelXml({ objects: [{ id: '1', ...tetra() }], build: [{ objectid: '1' }] }).replace(
    '<resources>',
    '<resources>\n  <texture2d id="9" path="/3D/Textures/t.png" contenttype="image/png"/>',
  );
  const r = await read3mf(await archive(xml));
  assert(r.unsupported.includes('texture2d'), 'texture not reported');
  assert(r.parts.length === 1, 'geometry should still import');
});

/* ------------------------------------------------- writer security -- */

say('');
say('=== writer security: hostile names stay content ===');

const hostileNames = [
  '../../evil',
  '/absolute/path',
  'C:\\windows\\system32',
  'https://evil.test/x',
  'a<b>c&d"e\'f',
  '<!ENTITY xxe SYSTEM "file:///etc/passwd">',
  '</name><script>alert(1)</script>',
  '部品Ａ／テスト',
];

for (const name of hostileNames) {
  await check('WS', `name is escaped and never becomes a path: ${name.slice(0, 26)}`, async () => {
    const t = tetra();
    const parts = [
      { id: 'p', name, mesh: meshOf(t.vertices, t.triangles), transform: IDENTITY_TRANSFORM },
    ];
    const bytes = await write3mf(parts, 'millimeter');

    // ORACLE: entry paths are exactly the three fixed ones, regardless of name.
    const entries = oracleEntries(bytes);
    const names = [...entries.keys()].sort();
    assert(
      JSON.stringify(names) ===
        JSON.stringify(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']),
      `archive paths changed: ${JSON.stringify(names)}`,
    );

    const xml = new TextDecoder().decode(entries.get('3D/3dmodel.model').content);
    assert(oracleXmlWellFormed(xml), 'writer produced malformed XML');
    assert(!/<!DOCTYPE/i.test(xml) && !/<!ENTITY/i.test(xml), 'writer emitted a DTD or entity');

    // And the name survives a round trip unchanged.
    const back = await read3mf(bytes);
    assert(back.parts[0].name === name, `name became ${String(back.parts[0].name)}`);
  });
}

/* ------------------------------------------- independent validation -- */

say('');
say('=== independent oracle on produced archives ===');

await check('OR01', 'produced ZIP opens with an independent reader and CRCs match', async () => {
  const t = tetra();
  const bytes = await write3mf(
    [{ id: 'p', mesh: meshOf(t.vertices, t.triangles), transform: IDENTITY_TRANSFORM }],
    'millimeter',
  );
  const entries = oracleEntries(bytes);
  assert(entries.size === 3, `expected 3 entries, got ${String(entries.size)}`);
  for (const [name, e] of entries) {
    assert(e.content.length === e.declaredUncompressed, `${name}: size mismatch`);
  }
});

await check('OR02', 'produced XML is well-formed by an independent check', async () => {
  const t = tetra();
  const xml = writeModelXml(
    [{ id: 'p', name: 'x', mesh: meshOf(t.vertices, t.triangles), transform: IDENTITY_TRANSFORM }],
    'millimeter',
  );
  assert(oracleXmlWellFormed(xml), 'not well formed');
  assert(
    xml.includes('xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'),
    'namespace missing',
  );
  assert(/unit="millimeter"/.test(xml), 'unit missing');
});

say('');
say(`3MF matrix: ${String(pass)}/${String(total)} checks passed`);
