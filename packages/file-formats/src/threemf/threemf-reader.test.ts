import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError, LengthUnit } from '@cadfixer/shared';
import {
  applyPartTransform,
  assertGeometryDocument,
  DEFAULT_DOCUMENT_LIMITS,
  distinctMeshes,
  triangleCount,
} from '@cadfixer/mesh-core';
import { testReadContext } from '../test-context';
import { ImportRefusal, refusalOf } from '../import-errors';
import { UnsupportedFeature, type DocumentReadResult } from '../document-reader';
import {
  read3mf,
  DEFAULT_3MF_LIMITS,
  THREE_MF_DEFAULT_UNIT,
  type ThreeMfExpansionStats,
} from './threemf-reader';
import { DEFAULT_ZIP_LIMITS } from './zip';
import {
  buildZip,
  compressionBomb,
  CONTENT_TYPES,
  modelXml,
  TETRAHEDRON_MESH,
  valid3mf,
} from './zip-fixtures';

/**
 * MF-P01 – MF-P24, through the PRODUCTION import path.
 *
 * The hostile half is the Stage 4A research corpus, run against production
 * rather than against the reference implementation: a security property that
 * only the prototype has is not a security property.
 */

async function expectRefusal(
  run: () => Promise<unknown>,
  code: string,
  reason: ImportRefusal,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (cause) {
    caught = cause;
  }
  expect(isAppError(caught), 'expected a typed AppError').toBe(true);
  if (!isAppError(caught)) return;
  expect(caught.code).toBe(code);
  expect(refusalOf(caught)).toBe(reason);
}

function object(id: string, extra = '', mesh = TETRAHEDRON_MESH): string {
  return `<object id="${id}" type="model"${extra}>${mesh}</object>`;
}

/* ------------------------------------------------------------ valid 3MF -- */

describe('MF-P01: a simple mesh', () => {
  it('imports as a one-part document with the file’s exact coordinates', async () => {
    const result = await read3mf(await valid3mf(), testReadContext());

    expect(result.document.parts).toHaveLength(1);
    expect(triangleCount(result.document.parts[0]?.mesh as never)).toBe(4);
    expect([...(result.document.parts[0]?.mesh.positions ?? [])]).toEqual([
      0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10,
    ]);
    expect(result.encoding).toBe('3mf');
  });

  it('reports nothing unsupported for an ordinary file', async () => {
    const result = await read3mf(await valid3mf(), testReadContext());
    expect(result.compatibility.unsupported).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('MF-P02: all six units', () => {
  it.each(['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter'])(
    'preserves %s exactly and rescales nothing',
    async (unit) => {
      const result = await read3mf(await valid3mf(modelXml({ unit })), testReadContext());

      expect(result.document.unit).toBe(unit);
      /*
       * THE SAME NUMBERS UNDER EVERY UNIT. Rescaling would change the stored
       * values that exact topology, no-tolerance repair and exact
       * self-intersection all depend on. The unit travels as metadata beside
       * the coordinates, never applied to them.
       */
      expect([...(result.document.parts[0]?.mesh.positions ?? [])]).toEqual([
        0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10,
      ]);
    },
  );

  it("applies the specification's default when the attribute is absent", async () => {
    /*
     * NOT "unspecified". The 3MF core specification defaults `<model unit>` to
     * millimetre, so a file that omits the attribute has stated millimetres as
     * definitely as one that spells them out. This is not the STL case: STL has
     * no unit field, so an STL genuinely states nothing and CAD Fixer says so.
     */
    const result = await read3mf(await valid3mf(modelXml({})), testReadContext());
    expect(result.document.unit).toBe(LengthUnit.Millimeter);
    expect(THREE_MF_DEFAULT_UNIT).toBe('millimeter');
  });

  it('does not rescale coordinates to reach the default unit', async () => {
    // The default decides what the numbers MEAN, never what they are.
    const withDefault = await read3mf(await valid3mf(modelXml({})), testReadContext());
    const explicit = await read3mf(
      await valid3mf(modelXml({ unit: 'millimeter' })),
      testReadContext(),
    );
    expect([...(withDefault.document.parts[0]?.mesh.positions ?? [])]).toEqual([
      ...(explicit.document.parts[0]?.mesh.positions ?? []),
    ]);
  });

  it('refuses a unit outside the six the specification allows', async () => {
    await expectRefusal(
      async () => read3mf(await valid3mf(modelXml({ unit: 'furlong' })), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfUnsupportedUnit,
    );
  });

  it('maps every supported unit onto a canonical LengthUnit', async () => {
    // The document's unit has to be a value the rest of the product can use,
    // not a string that merely looks like one.
    const result = await read3mf(await valid3mf(modelXml({ unit: 'inch' })), testReadContext());
    expect(result.document.unit).toBe(LengthUnit.Inch);
  });
});

describe('MF-P03/MF-P04: build items become parts', () => {
  it('makes two items on two objects into two parts', async () => {
    const xml = modelXml({
      resources: object('1', ' name="left"') + object('2', ' name="right"'),
      build: '<item objectid="1"/><item objectid="2"/>',
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    expect(result.document.parts).toHaveLength(2);
    expect(result.document.parts.map((part) => part.name)).toEqual(['left', 'right']);
    expect(distinctMeshes(result.document)).toHaveLength(2);
  });

  it('MF-P04: two items on ONE object share a single mesh', async () => {
    const xml = modelXml({
      resources: object('1'),
      build: '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 0 0"/>',
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    expect(result.document.parts).toHaveLength(2);
    // THE SAME OBJECT, not two copies. This is what makes a thousand
    // placements cost one mesh.
    expect(result.document.parts[0]?.mesh).toBe(result.document.parts[1]?.mesh);
    expect(distinctMeshes(result.document)).toHaveLength(1);
  });

  it('gives every part a generated id, never the object id or name', async () => {
    const xml = modelXml({
      resources: object('1', ' name="Same"'),
      build: '<item objectid="1"/><item objectid="1"/>',
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    const ids = result.document.parts.map((part) => part.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain('1');
    expect(ids).not.toContain('Same');
  });

  it('shows nothing for a mesh object the build never places', async () => {
    const xml = modelXml({
      resources: object('1') + object('2'),
      build: '<item objectid="1"/>',
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    expect(result.document.parts).toHaveLength(1);
    // Reported rather than silently omitted: the file defines something the
    // user may expect to see.
    expect(result.compatibility.unsupported).toContain(UnsupportedFeature.UnreferencedObject);
    expect(result.warnings.map((warning) => warning.code)).toContain(
      'THREEMF_UNREFERENCED_OBJECTS',
    );
  });

  it('refuses a file with no build items', async () => {
    await expectRefusal(
      async () => read3mf(await valid3mf(modelXml({ build: '' })), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfNoBuildItems,
    );
  });
});

describe('MF-P05/MF-P06: transforms', () => {
  it('preserves a translation as a placement, not as moved coordinates', async () => {
    const xml = modelXml({
      build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 3.5 -2.25 7"/>',
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());
    const part = result.document.parts[0];

    expect([...(part?.transform ?? [])].slice(9)).toEqual([3.5, -2.25, 7]);
    // The coordinates are untouched: baking a placement into Float32 vertices
    // is irreversible and would make two placements of one object into two
    // unrelated meshes.
    expect([...(part?.mesh.positions ?? [])]).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
  });

  it('reads a rotation and scale in 3MF’s row-vector convention', async () => {
    /*
     * RT05 FROM THE RESEARCH MATRIX, asserted against production. Under this
     * transform (1,0,0) lands at (0,2,0); reading the twelve numbers as column
     * vectors would give (0,-2,0), and no translation-only fixture can tell the
     * two apart.
     */
    const xml = modelXml({ build: '<item objectid="1" transform="0 2 0 -2 0 0 0 0 2 0 0 0"/>' });

    const result = await read3mf(await valid3mf(xml), testReadContext());
    const placed = applyPartTransform(result.document.parts[0]?.transform as never, 1, 0, 0);

    expect(placed[0]).toBeCloseTo(0, 12);
    expect(placed[1]).toBeCloseTo(2, 12);
  });

  it('keeps transform values in Float64, never narrowed', async () => {
    // A value that is not representable in Float32 must survive exactly.
    const precise = '0.1234567890123457';
    const xml = modelXml({
      build: `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${precise} 0 0"/>`,
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    expect(result.document.parts[0]?.transform[9]).toBe(Number(precise));
    expect(result.document.parts[0]?.transform[9]).not.toBe(Math.fround(Number(precise)));
  });

  it('refuses a transform that is not twelve values', async () => {
    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(modelXml({ build: '<item objectid="1" transform="1 0 0"/>' })),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfBadTransform,
    );
  });

  it('refuses a non-finite transform value', async () => {
    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(
            modelXml({ build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 NaN 0 0"/>' }),
          ),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfBadTransform,
    );
  });
});

describe('MF-P07/MF-P08: components', () => {
  it('expands a component instance into a part sharing the source mesh', async () => {
    const xml = modelXml({
      resources:
        object('1') +
        '<object id="2" type="model"><components><component objectid="1"/></components></object>',
      build: '<item objectid="2"/>',
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    expect(result.document.parts).toHaveLength(1);
    expect(distinctMeshes(result.document)).toHaveLength(1);
  });

  it('makes repeated component instances share one authoritative mesh', async () => {
    const xml = modelXml({
      resources:
        object('1') +
        '<object id="2" type="model"><components>' +
        '<component objectid="1"/>' +
        '<component objectid="1" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>' +
        '</components></object>',
      build: '<item objectid="2"/>',
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    expect(result.document.parts).toHaveLength(2);
    expect(result.document.parts[0]?.mesh).toBe(result.document.parts[1]?.mesh);
    expect(result.document.parts[1]?.transform[9]).toBe(20);
  });

  it('MF-P08: composes nested component transforms in the right order', async () => {
    /*
     * RT10. An outer placement of (0,+5) applied after an inner one of (+10,0)
     * puts the leaf at (10,5). A reversed composition gives the same answer for
     * pure translations only when they commute — which they do here, so the
     * rotation case above is what actually pins the order.
     */
    const xml = modelXml({
      resources:
        object('1') +
        '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>' +
        '<object id="3" type="model"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 0 5 0"/></components></object>',
      build: '<item objectid="3"/>',
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    expect(result.document.parts).toHaveLength(1);
    const placed = applyPartTransform(result.document.parts[0]?.transform as never, 0, 0, 0);
    expect(placed[0]).toBeCloseTo(10, 12);
    expect(placed[1]).toBeCloseTo(5, 12);
  });

  it('MF-P09: refuses a component cycle rather than looping', async () => {
    const xml = modelXml({
      resources:
        '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
        '<object id="2" type="model"><components><component objectid="1"/></components></object>',
      build: '<item objectid="1"/>',
    });

    await expectRefusal(
      async () => read3mf(await valid3mf(xml), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfComponentCycle,
    );
  });

  it('MF-P10: refuses nesting deeper than the frozen cap of 16', async () => {
    const depth = DEFAULT_3MF_LIMITS.maxComponentDepth + 3;
    let resources = object('0');
    for (let level = 1; level <= depth; level += 1) {
      resources += `<object id="${String(level)}" type="model"><components><component objectid="${String(level - 1)}"/></components></object>`;
    }

    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(modelXml({ resources, build: `<item objectid="${String(depth)}"/>` })),
          testReadContext(),
        ),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ThreeMfComponentTooDeep,
    );
  });

  it('accepts nesting exactly at the cap', async () => {
    // Just below and just above: the boundary itself is the thing being pinned.
    const depth = DEFAULT_3MF_LIMITS.maxComponentDepth;
    let resources = object('0');
    for (let level = 1; level <= depth; level += 1) {
      resources += `<object id="${String(level)}" type="model"><components><component objectid="${String(level - 1)}"/></components></object>`;
    }

    const result = await read3mf(
      await valid3mf(modelXml({ resources, build: `<item objectid="${String(depth)}"/>` })),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });

  it('refuses an expansion that would exceed the part ceiling', async () => {
    // A syntactically small component graph must not expand into a document
    // nothing can hold. Doubling per level reaches the cap in a few lines.
    let resources = object('0');
    for (let level = 1; level <= 20; level += 1) {
      resources +=
        `<object id="${String(level)}" type="model"><components>` +
        `<component objectid="${String(level - 1)}"/><component objectid="${String(level - 1)}"/>` +
        `</components></object>`;
    }

    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(modelXml({ resources, build: '<item objectid="20"/>' })),
          testReadContext(),
        ),
      AppErrorCode.ResourceLimitExceeded,
      // Depth is reached first for this shape, which is itself the point: the
      // cheaper bound fires before the expensive one.
      ImportRefusal.ThreeMfComponentTooDeep,
    );
  });
});

describe('MF-P11/MF-P12/MF-P13: structural validity is not mesh health', () => {
  it('MF-P11: refuses a build item naming an object that does not exist', async () => {
    await expectRefusal(
      async () =>
        read3mf(await valid3mf(modelXml({ build: '<item objectid="99"/>' })), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfMissingObject,
    );
  });

  it('refuses a component naming an object that does not exist', async () => {
    const xml = modelXml({
      resources:
        object('1') +
        '<object id="2" type="model"><components><component objectid="99"/></components></object>',
      build: '<item objectid="2"/>',
    });

    await expectRefusal(
      async () => read3mf(await valid3mf(xml), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfMissingObject,
    );
  });

  it('MF-P12: refuses a triangle index outside the vertex list', async () => {
    const mesh = `<mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
      </vertices><triangles><triangle v1="0" v2="1" v3="9"/></triangles></mesh>`;

    await expectRefusal(
      async () =>
        read3mf(await valid3mf(modelXml({ resources: object('1', '', mesh) })), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfBadVertexIndex,
    );
  });

  it('refuses a non-finite vertex coordinate', async () => {
    const mesh = `<mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="NaN" y="0" z="0"/><vertex x="0" y="1" z="0"/>
      </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>`;

    await expectRefusal(
      async () =>
        read3mf(await valid3mf(modelXml({ resources: object('1', '', mesh) })), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfNonFinite,
    );
  });

  it('refuses two objects sharing an id', async () => {
    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(modelXml({ resources: object('1') + object('1') })),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfDuplicateObjectId,
    );
  });

  it('MF-P13: IMPORTS a zero-area triangle, because that is a defect and not a broken file', async () => {
    /*
     * THE LINE THIS DRAWS. A zero-area triangle is valid 3MF describing a
     * defective mesh. Refusing it would leave the product unable to load the
     * very models it exists to repair; Mesh Health reports it afterwards.
     */
    const mesh = `<mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="2" y="0" z="0"/>
      </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>`;

    const result = await read3mf(
      await valid3mf(modelXml({ resources: object('1', '', mesh) })),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(triangleCount(result.document.parts[0]?.mesh as never)).toBe(1);
  });
});

describe('MF-P14/MF-P15: unsupported resources and hostile names', () => {
  it('imports geometry and reports that textures were not read', async () => {
    const xml = modelXml({
      resources:
        '<texture2d id="9" path="/3D/Textures/skin.png" contenttype="image/png"/>' + object('1'),
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    expect(result.document.parts).toHaveLength(1);
    expect(result.compatibility.unsupported).toContain(UnsupportedFeature.Textures);
    const message = result.warnings.map((warning) => warning.message).join(' ');
    expect(message).toMatch(/textures/i);
    expect(message).toMatch(/nothing was downloaded/i);
  });

  it('reports colour and material resources as not interpreted', async () => {
    const xml = modelXml({
      resources:
        '<basematerials id="8"><base name="steel" displaycolor="#808080"/></basematerials>' +
        object('1'),
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    expect(result.compatibility.unsupported).toContain(UnsupportedFeature.Materials);
  });

  /*
   * THIS USED TO ASSERT THAT ANY `pid` WAS KEPT AS AN OPAQUE STRING, and that
   * permissiveness was a real defect rather than a stylistic choice: it let a
   * reference to a resource that does not exist into the document, from where
   * the writer reproduced it in CAD Fixer's own output.
   *
   * The two cases below are the distinction that replaced it, and they are
   * genuinely different files: one is VALID and carries materials CAD Fixer
   * does not interpret; the other is MALFORMED.
   */
  it('keeps a property reference that RESOLVES, and reports the materials as unimported', async () => {
    const result = await read3mf(
      await valid3mf(
        modelXml({
          resources:
            '<basematerials id="7"><base name="Steel" displaycolor="#808080FF"/></basematerials>' +
            object('1', ' pid="7"'),
        }),
      ),
      testReadContext(),
    );

    // The geometry imports, the reference is kept, and the loss is reported.
    expect(result.document.parts[0]?.materialRef).toBe('7');
    expect((result.document.parts[0]?.mesh.indices.length ?? 0) / 3).toBe(4);
    expect(result.compatibility.unsupported).toContain(UnsupportedFeature.Materials);
  });

  it('resolves a property reference declared AFTER the object that uses it', async () => {
    // Element ORDER must not decide validity: the reference is resolved once the
    // whole resource id space is known, not at the moment it is read.
    const result = await read3mf(
      await valid3mf(
        modelXml({
          resources:
            object('1', ' pid="7"') +
            '<basematerials id="7"><base name="Steel" displaycolor="#808080FF"/></basematerials>',
        }),
      ),
      testReadContext(),
    );
    expect(result.document.parts[0]?.materialRef).toBe('7');
  });

  it('refuses a property reference that names no resource', async () => {
    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(modelXml({ resources: object('1', ' pid="7"') })),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfDanglingPropertyReference,
    );
  });

  it('refuses a property reference that points at an OBJECT rather than a property group', async () => {
    /*
     * A NAIVE "DOES THIS ID EXIST" CHECK WOULD PASS THIS. `pid` names a property
     * group specifically, so resolving it against the object id space would
     * accept a reference that means nothing.
     */
    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(
            modelXml({
              resources: object('1') + object('2', ' pid="1"'),
              build: '<item objectid="1"/><item objectid="2"/>',
            }),
          ),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfDanglingPropertyReference,
    );
  });

  it('refuses a triangle property reference that names no resource', async () => {
    const mesh =
      '<mesh><vertices>' +
      '<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/>' +
      '</vertices><triangles>' +
      '<triangle v1="0" v2="1" v3="2" pid="9"/>' +
      '</triangles></mesh>';
    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(modelXml({ resources: `<object id="1" type="model">${mesh}</object>` })),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfDanglingPropertyReference,
    );
  });

  it('refuses an object carrying a property index with no property reference', async () => {
    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(modelXml({ resources: object('1', ' pindex="0"') })),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfMalformedStructure,
    );
  });

  it.each([
    ['zero', '0'],
    ['negative', '-3'],
    ['decimal', '1.0'],
    ['alphabetic', 'steel'],
    ['leading zero', '007'],
    ['leading whitespace', ' 7'],
    ['trailing whitespace', '7 '],
    ['hexadecimal', '0x7'],
    ['exponent', '1e3'],
    ['plus sign', '+7'],
    ['empty', ''],
    ['above the id range', '2147483648'],
    ['absurdly long', '9'.repeat(400)],
  ])('refuses a %s property reference as a malformed resource id', async (_label, pid) => {
    /*
     * LEXICAL, NOT COERCED. `Number` accepts most of these — ` 7 `, `0x7`, `1e3`
     * — and every one of them would then be stored as a resource id and,
     * before the fix, written back out as one.
     */
    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(
            modelXml({
              resources:
                '<basematerials id="7"><base name="Steel" displaycolor="#808080FF"/></basematerials>' +
                object('1', ` pid="${pid}"`),
            }),
          ),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfMalformedResourceId,
    );
  });

  it('accepts the largest valid resource id', async () => {
    const result = await read3mf(
      await valid3mf(
        modelXml({
          resources:
            '<basematerials id="2147483647"><base name="Steel" displaycolor="#808080FF"/></basematerials>' +
            object('1', ' pid="2147483647"'),
        }),
      ),
      testReadContext(),
    );
    expect(result.document.parts[0]?.materialRef).toBe('2147483647');
  });

  it('MF-P15: carries a hostile object name through as TEXT', async () => {
    const xml = modelXml({
      resources: object('1', ' name="&lt;img src=x onerror=alert(1)&gt;"'),
    });

    const result = await read3mf(await valid3mf(xml), testReadContext());

    // Entity-decoded to the literal characters, and stored as a string. It is
    // React's job to render it as text, and a browser test asserts it does.
    expect(result.document.parts[0]?.name).toBe('<img src=x onerror=alert(1)>');
  });
});

/* ------------------------------------------------------ hostile archives -- */

describe('MF-P16/MF-P17/MF-P18: container attacks', () => {
  it.each([
    ['parent traversal', '../../etc/passwd'],
    ['nested traversal', '3D/../../escape.model'],
    ['absolute path', '/absolute/3dmodel.model'],
    ['drive-letter path', 'C:\\windows\\system32'],
    ['backslash traversal', '3D\\..\\..\\escape'],
    ['percent-encoded traversal', '3D/%2e%2e/%2e%2e/escape'],
    ['URL-like name', 'https://evil.test/x.model'],
    ['file URL name', 'file:///etc/passwd'],
  ])('MF-P16: refuses %s', async (_label, name) => {
    await expectRefusal(
      async () => read3mf(await buildZip([{ name, content: 'x' }]), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ZipUnsafePath,
    );
  });

  it('refuses a NUL byte in an entry path', async () => {
    await expectRefusal(
      async () =>
        read3mf(await buildZip([{ name: '3D/a\u0000b.model', content: 'x' }]), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ZipUnsafePath,
    );
  });

  it('refuses two entries whose paths differ only in case', async () => {
    await expectRefusal(
      async () =>
        read3mf(
          await buildZip([
            { name: '3D/3dmodel.model', content: 'a' },
            { name: '3D/3DMODEL.MODEL', content: 'b' },
          ]),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ZipDuplicatePath,
    );
  });

  it('MF-P17: refuses a compression bomb', async () => {
    /*
     * A GENUINE BOMB: 64 MiB of zeros that deflates to a few KiB. The research
     * measured a naive reader inflating it to 67,108,864 bytes at 1027:1. This
     * refuses it on the declared ratio, before a byte is inflated.
     */
    await expectRefusal(
      async () => read3mf(await compressionBomb(), testReadContext()),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipRatioExceeded,
    );
  });

  it('refuses a bomb that LIES about its size, while inflating', async () => {
    // The declared ratio looks fine, so the declaration check passes and the
    // mid-inflation budget is what catches it. A reader that checked only the
    // header would allocate the whole thing.
    const bytes = await buildZip([
      {
        name: '3D/3dmodel.model',
        method: 8,
        content: new Uint8Array(8 * 1024 * 1024),
        declaredUncompressedSize: 1_024,
      },
    ]);

    await expectRefusal(
      () =>
        read3mf(bytes, testReadContext(), {
          zipLimits: { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 64 * 1024 },
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipEntryTooLarge,
    );
  });

  it('MF-P18: refuses an encrypted entry', async () => {
    await expectRefusal(
      async () =>
        read3mf(
          await buildZip([{ name: '3D/3dmodel.model', content: 'x', flags: 0x1 }]),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ZipEncrypted,
    );
  });

  it('refuses an unsupported compression method', async () => {
    await expectRefusal(
      async () =>
        read3mf(
          await buildZip([{ name: '3D/3dmodel.model', content: 'x', method: 12 }]),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ZipUnsupportedMethod,
    );
  });

  it('refuses more entries than the cap', async () => {
    await expectRefusal(
      async () =>
        read3mf(await valid3mf(), testReadContext(), {
          zipLimits: { ...DEFAULT_ZIP_LIMITS, maxEntries: 2 },
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipTooManyEntries,
    );
  });

  it('refuses an archive larger than the cap before reading it', async () => {
    await expectRefusal(
      async () =>
        read3mf(await valid3mf(), testReadContext(), {
          zipLimits: { ...DEFAULT_ZIP_LIMITS, maxArchiveBytes: 16 },
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipArchiveTooLarge,
    );
  });

  it('refuses a truncated archive with no central directory', async () => {
    const bytes = (await valid3mf()).subarray(0, 40);
    await expectRefusal(
      () => read3mf(bytes, testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.ZipNoCentralDirectory,
    );
  });

  it('refuses an archive with no model part', async () => {
    await expectRefusal(
      async () =>
        read3mf(
          await buildZip([{ name: '[Content_Types].xml', content: CONTENT_TYPES }]),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfNoModelPart,
    );
  });
});

describe('MF-P19/MF-P20: XML attacks', () => {
  it('MF-P19: refuses a DOCTYPE before interpreting the document', async () => {
    const xml = modelXml({ prolog: '<!DOCTYPE model [ <!ELEMENT model ANY> ]>\n' });

    await expectRefusal(
      async () => read3mf(await valid3mf(xml), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.XmlDoctypeRefused,
    );
  });

  it('refuses an entity declaration, so billion-laughs never expands', async () => {
    const xml = modelXml({
      prolog: '<!DOCTYPE lolz [ <!ENTITY lol "lol"> <!ENTITY lol2 "&lol;&lol;&lol;&lol;"> ]>\n',
    });

    await expectRefusal(
      async () => read3mf(await valid3mf(xml), testReadContext()),
      AppErrorCode.MalformedFile,
      // The DOCTYPE is seen first, which is the cheaper and earlier refusal.
      ImportRefusal.XmlDoctypeRefused,
    );
  });

  it('refuses a bare ENTITY declaration with no DOCTYPE', async () => {
    const xml = modelXml({ prolog: '<!ENTITY xxe SYSTEM "file:///etc/passwd">\n' });

    await expectRefusal(
      async () => read3mf(await valid3mf(xml), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.XmlEntityRefused,
    );
  });

  it('MF-P20: refuses an external SYSTEM identifier rather than ignoring it', async () => {
    const xml = modelXml({ prolog: '<?xml-stylesheet SYSTEM "http://evil.test/x.dtd"?>\n' });

    await expectRefusal(
      async () => read3mf(await valid3mf(xml), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.XmlExternalIdRefused,
    );
  });

  it('refuses a DOCTYPE pushed past a padded prolog', async () => {
    /*
     * THE BYPASS THIS PINS. The unsafe-construct check used to look at the
     * first 8 KiB only, on the reasoning that a DOCTYPE may only appear in the
     * prolog. A prolog can be padded to any length with comments while staying
     * well-formed, so ten kilobytes of them put the DOCTYPE outside the window.
     *
     * Nothing downstream fetches anything, so such a file was never dangerous
     * — but a rule with a documented bypass is worse than no rule, because it
     * is trusted.
     */
    const padding = `${'<!-- '.padEnd(80, 'x')} -->\n`.repeat(200);
    const xml = modelXml({
      prolog: `${padding}<!DOCTYPE model SYSTEM "http://evil.test/model.dtd">\n`,
    });
    expect(xml.indexOf('<!DOCTYPE')).toBeGreaterThan(8_192);

    await expectRefusal(
      async () => read3mf(await valid3mf(xml), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.XmlDoctypeRefused,
    );
  });

  it('does not refuse a document merely for containing the word SYSTEM in its content', async () => {
    // The prolog is where an external identifier can appear. An object NAMED
    // "SYSTEM 'part'" is a name, and refusing it would be a false positive that
    // makes a legitimate file unopenable.
    const result = await read3mf(
      await valid3mf(
        modelXml({
          resources: `<object id="1" type="model" name="SYSTEM &quot;part&quot;">${TETRAHEDRON_MESH}</object>`,
        }),
      ),
      testReadContext(),
    );
    expect(result.document.parts[0]?.name).toBe('SYSTEM "part"');
  });

  it('refuses malformed XML rather than salvaging what it can', async () => {
    await expectRefusal(
      async () => read3mf(await valid3mf('<model><resources><object id="1">'), testReadContext()),
      AppErrorCode.MalformedFile,
      ImportRefusal.XmlMalformed,
    );
  });

  it('refuses XML nested deeper than the cap', async () => {
    const deep = '<a>'.repeat(80) + '</a>'.repeat(80);
    await expectRefusal(
      async () => read3mf(await valid3mf(`<?xml version="1.0"?>${deep}`), testReadContext()),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.XmlTooDeep,
    );
  });

  it('leaves an undeclared entity as written rather than expanding or dropping it', async () => {
    // Nothing can smuggle content through a name the decoder does not know.
    const result = await read3mf(
      await valid3mf(modelXml({ resources: object('1', ' name="a&unknown;b"') })),
      testReadContext(),
    );
    expect(result.document.parts[0]?.name).toBe('a&unknown;b');
  });
});

describe('wiring faults are not blamed on the file', () => {
  it('reports a missing decompressor as an internal failure, not a corrupt file', async () => {
    let caught: unknown;
    try {
      await read3mf(await valid3mf(), testReadContext({ withInflater: false }));
    } catch (cause) {
      caught = cause;
    }
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    // Telling a user their good file is corrupt would send them looking for a
    // problem that is not there.
    expect(caught.code).toBe(AppErrorCode.Internal);
  });
});

/* ------------------------------------------- R1: bounded part expansion -- */

describe('the part ceiling is the DOCUMENT’s, and it stops expansion', () => {
  function items(count: number): string {
    return Array.from({ length: count }, () => '<item objectid="1"/>').join('');
  }

  async function readItems(
    count: number,
    stats?: ThreeMfExpansionStats,
  ): Promise<DocumentReadResult> {
    return read3mf(
      await valid3mf(modelXml({ resources: object('1'), build: items(count) })),
      testReadContext(),
      stats === undefined ? {} : { stats },
    );
  }

  it('uses the production document limit rather than a number of its own', () => {
    /*
     * THE DRIFT THIS EXISTS TO PREVENT. The reader's own cap used to be 65,536
     * — sixteen times the document's — so a hostile component graph was fully
     * expanded and then refused by `assertGeometryDocument`. The refusal was
     * correct; the sixty-five thousand parts built to reach it were not.
     */
    expect(DEFAULT_3MF_LIMITS.maxParts).toBe(DEFAULT_DOCUMENT_LIMITS.maxParts);
    expect(DEFAULT_3MF_LIMITS.maxParts).toBe(4096);
  });

  it('accepts 4,095 parts', async () => {
    const result = await readItems(4_095);
    expect(result.document.parts).toHaveLength(4_095);
  });

  it('accepts 4,096 parts — the ceiling itself is inside the contract', async () => {
    const result = await readItems(4_096);
    expect(result.document.parts).toHaveLength(4_096);
    // AND THEY STILL SHARE ONE MESH. A bounded expansion must not have become
    // a copying one on the way to being bounded.
    expect(distinctMeshes(result.document)).toHaveLength(1);
  });

  it('refuses 4,097 parts, and never builds the 4,097th', async () => {
    const stats: ThreeMfExpansionStats = {
      leafPlacementsVisited: 0,
      partsEmitted: 0,
      meshResourcesMaterialised: 0,
    };

    await expectRefusal(
      async () => readItems(4_097, stats),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ThreeMfTooManyParts,
    );

    // THE PART THAT WOULD HAVE CROSSED THE LINE WAS NEVER CONSTRUCTED. The
    // check runs before the append, so `partsEmitted` stops at the ceiling
    // rather than one past it.
    expect(stats.partsEmitted).toBe(DEFAULT_DOCUMENT_LIMITS.maxParts);
    // The walk reached the leaf that would have been 4,097 and stopped there.
    expect(stats.leafPlacementsVisited).toBe(DEFAULT_DOCUMENT_LIMITS.maxParts + 1);
    // One object, one mesh — no per-placement geometry, even on the way to a
    // refusal.
    expect(stats.meshResourcesMaterialised).toBe(1);
  });

  it('bounds a NESTED component expansion during the walk, not after it', async () => {
    /*
     * A COMBINATORIAL SUBTREE THAT COULD NEVER BE FLATTENED.
     *
     * Sixteen levels, four children each: 4^16 leaf placements, about 4.3
     * billion. Building a complete instance list first — or continuing to
     * recurse after the budget was spent — does not finish, on any machine, in
     * any amount of time this suite would tolerate. That this test RETURNS is
     * the proof that expansion stops at the ceiling.
     */
    const depth = DEFAULT_3MF_LIMITS.maxComponentDepth;
    let resources = object('0');
    for (let level = 1; level <= depth; level += 1) {
      const child = String(level - 1);
      const children = Array.from({ length: 4 }, () => `<component objectid="${child}"/>`).join('');
      resources += `<object id="${String(level)}" type="model"><components>${children}</components></object>`;
    }

    const stats: ThreeMfExpansionStats = {
      leafPlacementsVisited: 0,
      partsEmitted: 0,
      meshResourcesMaterialised: 0,
    };

    const started = Date.now();
    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(modelXml({ resources, build: `<item objectid="${String(depth)}"/>` })),
          testReadContext(),
          { stats },
        ),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ThreeMfTooManyParts,
    );
    const elapsed = Date.now() - started;

    expect(stats.partsEmitted).toBe(DEFAULT_DOCUMENT_LIMITS.maxParts);
    expect(stats.leafPlacementsVisited).toBe(DEFAULT_DOCUMENT_LIMITS.maxParts + 1);
    expect(stats.meshResourcesMaterialised).toBe(1);
    /*
     * A generous ceiling on a proposition about 4.3 billion placements. Even a
     * machine a thousand times slower than this one cannot visit them in ten
     * seconds, so this is not a timing measurement dressed up as a limit — it
     * is the difference between finishing and not finishing.
     */
    expect(elapsed).toBeLessThan(10_000);
  });

  it('keeps depth, cycles and missing references independent of the part budget', async () => {
    // Each of the three must still be reported as ITSELF, not swallowed by the
    // part ceiling now that the ceiling is sixteen times lower.
    const deep = ((): string => {
      let resources = object('0');
      for (let level = 1; level <= DEFAULT_3MF_LIMITS.maxComponentDepth + 1; level += 1) {
        resources += `<object id="${String(level)}" type="model"><components><component objectid="${String(level - 1)}"/></components></object>`;
      }
      return resources;
    })();

    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(
            modelXml({
              resources: deep,
              build: `<item objectid="${String(DEFAULT_3MF_LIMITS.maxComponentDepth + 1)}"/>`,
            }),
          ),
          testReadContext(),
        ),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ThreeMfComponentTooDeep,
    );

    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(
            modelXml({
              resources:
                '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
                '<object id="2" type="model"><components><component objectid="1"/></components></object>',
              build: '<item objectid="1"/>',
            }),
          ),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfComponentCycle,
    );

    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(modelXml({ resources: object('1'), build: '<item objectid="9"/>' })),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfMissingObject,
    );
  });

  it('refuses a mixed flat-and-nested expansion at the same ceiling', async () => {
    // Four thousand flat items plus a component that fans out to a hundred
    // more: the budget is one budget, not one per shape of placement.
    const fan = Array.from({ length: 100 }, () => '<component objectid="1"/>').join('');
    const resources = `${object('1')}<object id="2" type="model"><components>${fan}</components></object>`;
    const build = `${Array.from({ length: 4_050 }, () => '<item objectid="1"/>').join('')}<item objectid="2"/>`;

    const stats: ThreeMfExpansionStats = {
      leafPlacementsVisited: 0,
      partsEmitted: 0,
      meshResourcesMaterialised: 0,
    };

    await expectRefusal(
      async () =>
        read3mf(await valid3mf(modelXml({ resources, build })), testReadContext(), { stats }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ThreeMfTooManyParts,
    );
    expect(stats.partsEmitted).toBe(DEFAULT_DOCUMENT_LIMITS.maxParts);
  });
});

/* ------------------------------------ R1: cumulative inflation, in situ -- */

describe('the archive-wide inflation budget reaches the real import path', () => {
  it('refuses a model part that inflates past the archive budget', async () => {
    const big = 'x'.repeat(200_000);
    const archive = await valid3mf(
      modelXml({ resources: object('1'), build: `<item objectid="1"/><!--${big}-->` }),
    );

    await expectRefusal(
      async () =>
        read3mf(archive, testReadContext(), {
          zipLimits: { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 4_096 },
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipTotalTooLarge,
    );
  });

  it('gives the next import a fresh allowance', async () => {
    // A budget is per import. Reusing one across imports would refuse a
    // perfectly good second file for what the first one spent.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await read3mf(await valid3mf(), testReadContext());
      expect(result.document.parts).toHaveLength(1);
    }
  });

  it('leaves the reader recoverable after a budget refusal', async () => {
    const big = 'x'.repeat(200_000);
    const hostile = await valid3mf(
      modelXml({ resources: object('1'), build: `<item objectid="1"/><!--${big}-->` }),
    );

    await expectRefusal(
      async () =>
        read3mf(hostile, testReadContext(), {
          zipLimits: { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 4_096 },
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ZipTotalTooLarge,
    );

    // THE VERY NEXT IMPORT SUCCEEDS. A refusal that left the decompressor or
    // the reader in a bad state would show up here and nowhere else.
    const recovered = await read3mf(await valid3mf(), testReadContext());
    expect(recovered.document.parts).toHaveLength(1);
  });
});

/* -------------------------- R1: other document-wide limits, during build -- */

describe('document-wide ceilings that an expansion can reach', () => {
  /** A strip: `triangles` faces over `triangles + 2` vertices. */
  function strip(triangles: number): string {
    const vertices: string[] = [];
    for (let index = 0; index < triangles + 2; index += 1) {
      vertices.push(`<vertex x="${String(index % 64)}" y="${String(index % 7)}" z="0"/>`);
    }
    const faces: string[] = [];
    for (let index = 0; index < triangles; index += 1) {
      faces.push(
        `<triangle v1="${String(index)}" v2="${String(index + 1)}" v3="${String(index + 2)}"/>`,
      );
    }
    return `<mesh><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh>`;
  }

  it('refuses on the document TRIANGLE total, before the part that crosses it', async () => {
    /*
     * A DOCUMENT COUNTS PER PART, so repeated placements of one object multiply
     * its triangles. Five thousand triangles placed four thousand times is
     * exactly the twenty-million ceiling, and the four-thousand-and-first
     * placement crosses it — while the PART count, 4,001, is still comfortably
     * inside its own 4,096 ceiling.
     *
     * Without the running total this file expands completely and is refused by
     * `assertGeometryDocument` afterwards: twenty million triangles' worth of
     * part records built to reach a refusal that was knowable at the first one.
     */
    const perPlacement = 5_000;
    const allowed = DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles / perPlacement;
    expect(allowed).toBeLessThan(DEFAULT_DOCUMENT_LIMITS.maxParts);

    const stats: ThreeMfExpansionStats = {
      leafPlacementsVisited: 0,
      partsEmitted: 0,
      meshResourcesMaterialised: 0,
    };
    const resources = `<object id="1" type="model">${strip(perPlacement)}</object>`;
    const build = Array.from({ length: allowed + 1 }, () => '<item objectid="1"/>').join('');

    await expectRefusal(
      async () =>
        read3mf(await valid3mf(modelXml({ resources, build })), testReadContext(), { stats }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ThreeMfTooManyTriangles,
    );

    // Stopped at the ceiling, with the crossing part never built.
    expect(stats.partsEmitted).toBe(allowed);
    expect(stats.meshResourcesMaterialised).toBe(1);
  });

  it('accepts a placement count that reaches the triangle ceiling exactly', async () => {
    // The other side of the same boundary: at the ceiling, not past it.
    const perPlacement = 5_000;
    const allowed = DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles / perPlacement;
    const resources = `<object id="1" type="model">${strip(perPlacement)}</object>`;
    const build = Array.from({ length: allowed }, () => '<item objectid="1"/>').join('');

    const result = await read3mf(await valid3mf(modelXml({ resources, build })), testReadContext());
    expect(result.document.parts).toHaveLength(allowed);
    // ONE MESH for four thousand placements, at the ceiling.
    expect(distinctMeshes(result.document)).toHaveLength(1);
  });

  it('refuses on the document VERTEX total when that ceiling is reached first', async () => {
    /*
     * A DIFFERENT SHAPE OF MESH REACHES A DIFFERENT CEILING FIRST. Twenty
     * thousand vertices carrying a hundred triangles crosses sixty million
     * vertices at the three-thousand-and-first placement, while its triangles
     * are nowhere near their own limit and the part count is inside 4,096.
     *
     * Both totals are kept for exactly this reason: whichever ceiling a file
     * reaches first should be the one it is refused on, and should be named.
     */
    const vertices = 20_000;
    const allowed = Math.floor(DEFAULT_DOCUMENT_LIMITS.maxTotalVertices / vertices);
    expect(allowed).toBeLessThan(DEFAULT_DOCUMENT_LIMITS.maxParts);

    const vertexXml = Array.from(
      { length: vertices },
      (_v, index) => `<vertex x="${String(index % 64)}" y="${String(index % 7)}" z="0"/>`,
    ).join('');
    const faceXml = Array.from(
      { length: 100 },
      (_f, index) =>
        `<triangle v1="${String(index)}" v2="${String(index + 1)}" v3="${String(index + 2)}"/>`,
    ).join('');
    const resources = `<object id="1" type="model"><mesh><vertices>${vertexXml}</vertices><triangles>${faceXml}</triangles></mesh></object>`;
    const build = Array.from({ length: allowed + 1 }, () => '<item objectid="1"/>').join('');

    const stats: ThreeMfExpansionStats = {
      leafPlacementsVisited: 0,
      partsEmitted: 0,
      meshResourcesMaterialised: 0,
    };

    await expectRefusal(
      async () =>
        read3mf(await valid3mf(modelXml({ resources, build })), testReadContext(), { stats }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ThreeMfTooManyVertices,
    );
    expect(stats.partsEmitted).toBe(allowed);
  });

  it('truncates a long object name instead of making the model unimportable', async () => {
    /*
     * THE BUG THIS PINS. The reader carried a 600-character name through
     * intact, and `assertGeometryDocument` — whose cap is 512 — then refused
     * the whole document. A perfectly good model was unopenable because of a
     * display string, which is precisely the trade the truncation rule exists
     * to avoid.
     */
    const name = 'n'.repeat(600);
    const result = await read3mf(
      await valid3mf(
        modelXml({
          resources: `<object id="1" type="model" name="${name}">${TETRAHEDRON_MESH}</object>`,
        }),
      ),
      testReadContext(),
    );

    expect(result.document.parts[0]?.name).toHaveLength(DEFAULT_DOCUMENT_LIMITS.maxNameLength);
    // AND THE DOCUMENT GATE ACCEPTS IT, which is the half that was failing.
    expect(() => {
      assertGeometryDocument(result.document, '3MF import');
    }).not.toThrow();
  });

  /*
   * A LONG `pid` IS NO LONGER TRUNCATED, because truncation only makes sense for
   * free text. This used to cut a 900-character `pid` down to the document's
   * material-reference cap and keep it — turning a value that was never a
   * resource id into a shorter value that still was not one. A resource id has a
   * shape; a value without that shape is refused, and the cap is unreachable
   * because no valid id is longer than ten digits.
   */
  it('refuses a long material reference rather than truncating it into a different one', async () => {
    const pid = 'm'.repeat(900);
    await expectRefusal(
      async () =>
        read3mf(
          await valid3mf(
            modelXml({
              resources: `<object id="1" type="model" pid="${pid}">${TETRAHEDRON_MESH}</object>`,
            }),
          ),
          testReadContext(),
        ),
      AppErrorCode.MalformedFile,
      ImportRefusal.ThreeMfMalformedResourceId,
    );
  });

  it('keeps the document material-reference cap unreachable by a valid id', () => {
    // Ten digits is the longest a resource id can be, so the document's cap
    // cannot be the thing that constrains one.
    expect(DEFAULT_DOCUMENT_LIMITS.maxMaterialRefLength).toBeGreaterThan(10);
  });

  it('still validates the resulting document', async () => {
    const result = await read3mf(
      await valid3mf(
        modelXml({
          resources:
            '<basematerials id="7"><base name="Steel" displaycolor="#808080FF"/></basematerials>' +
            `<object id="1" type="model" pid="7">${TETRAHEDRON_MESH}</object>`,
        }),
      ),
      testReadContext(),
    );

    expect(() => {
      assertGeometryDocument(result.document, '3MF import');
    }).not.toThrow();
  });
});
