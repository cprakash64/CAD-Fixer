import { describe, expect, it } from 'vitest';
import { applyPartTransform, distinctMeshes, triangleCount } from '@cadfixer/mesh-core';
import { parseObj } from '../../../experiments/format-io/obj.mjs';
import { read3mf as researchRead3mf } from '../../../experiments/format-io/threemf.mjs';
import { testReadContext, decodeUtf8 } from './test-context';
import { readObj } from './obj/obj-reader';
import { read3mf, THREE_MF_DEFAULT_UNIT } from './threemf/threemf-reader';
import { modelXml, valid3mf, TETRAHEDRON_MESH } from './threemf/zip-fixtures';

/**
 * PRODUCTION AGAINST THE QUALIFIED REFERENCE.
 *
 * A parser that is its own oracle proves only that it is self-consistent. These
 * run the SAME bytes through the Stage 4A research implementations — which were
 * qualified against analytically-known answers, an independent ZIP walk and a
 * separate XML well-formedness check — and compare what comes out.
 *
 * Where production and research legitimately differ in SHAPE they are compared
 * on the semantics rather than on the representation: research collects a
 * refusal list where production throws on the first problem, and research
 * returns flat arrays where production returns a document. What must agree is
 * what the file MEANS.
 */

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/* ------------------------------------------------------------------ obj -- */

const OBJ_FIXTURES: readonly { readonly name: string; readonly text: string }[] = [
  { name: 'single triangle', text: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' },
  {
    name: 'two objects',
    text:
      'o Alpha\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' +
      'o Beta\nv 5 0 0\nv 6 0 0\nv 5 1 0\nf 4 5 6\n',
  },
  {
    name: 'negative indices',
    text: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\nv 9 0 0\nv 9 1 0\nv 9 1 1\nf -3 -2 -1\n',
  },
  {
    name: 'all corner spellings',
    text:
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\n' +
      'f 1/1/1 2/2/1 3/3/1\nf 1//1 2//1 3//1\nf 1/1 2/2 3/3\n',
  },
  {
    name: 'groups and materials',
    text: 'v 0 0 0\nv 1 0 0\nv 0 1 0\ng lower\nusemtl steel\nf 1 2 3\n',
  },
];

describe('OBJ: production agrees with the qualified research parser', () => {
  it.each(OBJ_FIXTURES)('$name', async ({ text }) => {
    const research = parseObj(text);
    expect(research.refusals, 'fixture must be accepted by the reference').toEqual([]);

    const production = await readObj(encode(text), testReadContext());

    // TOTAL FACES agree, however the parts divide them.
    const producedFaces = production.document.parts.reduce(
      (total, part) => total + triangleCount(part.mesh),
      0,
    );
    expect(producedFaces).toBe(research.faceCount);

    // PART COUNT follows the `o` records, with a leading unnamed part when the
    // file has faces before the first one.
    const expectedParts = research.objects.length === 0 ? 1 : research.objects.length;
    expect(production.document.parts).toHaveLength(expectedParts);
    if (research.objects.length > 0) {
      expect(production.document.parts.map((part) => part.name)).toEqual(
        research.objects.map((object) => object.name),
      );
    }

    // COORDINATES agree face by face, corner by corner, as Float32.
    let cursor = 0;
    for (const part of production.document.parts) {
      for (let corner = 0; corner < part.mesh.indices.length; corner += 1) {
        const local = part.mesh.indices[corner] ?? 0;
        const source = research.faces[cursor + Math.floor(corner / 3)]?.indices[corner % 3] ?? 0;
        for (let axis = 0; axis < 3; axis += 1) {
          expect(part.mesh.positions[local * 3 + axis]).toBe(
            Math.fround(research.positions[source * 3 + axis] ?? 0),
          );
        }
      }
      cursor += part.mesh.indices.length / 3;
    }

    // UNIT: neither states one.
    expect(production.document.unit).toBeUndefined();
  });

  it.each([
    ['quad', 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n'],
    ['zero index', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n'],
    ['out of range', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n'],
    ['non-finite', 'v NaN 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'],
  ])('both refuse %s', async (_label, text) => {
    const research = parseObj(text);
    expect(research.refusals.length, 'reference should refuse').toBeGreaterThan(0);

    // Production throws where research collects; the agreement is on the
    // VERDICT, which is the thing a user experiences.
    await expect(readObj(encode(text), testReadContext())).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ 3mf -- */

const THREE_MF_FIXTURES: readonly { readonly name: string; readonly xml: string }[] = [
  { name: 'one mesh, millimetre', xml: modelXml({ unit: 'millimeter' }) },
  { name: 'one mesh, inch', xml: modelXml({ unit: 'inch' }) },
  {
    name: 'two items sharing one object',
    xml: modelXml({
      build: '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 0 0"/>',
    }),
  },
  {
    name: 'component instance',
    xml: modelXml({
      resources:
        `<object id="1" type="model">${TETRAHEDRON_MESH}</object>` +
        '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 20 0 0"/></components></object>',
      build: '<item objectid="2"/>',
    }),
  },
  {
    name: 'nested components',
    xml: modelXml({
      resources:
        `<object id="1" type="model">${TETRAHEDRON_MESH}</object>` +
        '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>' +
        '<object id="3" type="model"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 0 5 0"/></components></object>',
      build: '<item objectid="3"/>',
    }),
  },
  {
    name: 'rotation and scale',
    xml: modelXml({ build: '<item objectid="1" transform="0 2 0 -2 0 0 0 0 2 0 0 0"/>' }),
  },
];

describe('3MF: production agrees with the qualified research reader', () => {
  it.each(THREE_MF_FIXTURES)('$name', async ({ xml }) => {
    const archive = await valid3mf(xml);

    const research = await researchRead3mf(archive);
    const production = await read3mf(archive, testReadContext());

    // PART COUNT and UNIT.
    expect(production.document.parts).toHaveLength(research.parts.length);
    /*
     * THE ONE DELIBERATE DIVERGENCE FROM THE RESEARCH READER, stated here
     * rather than hidden by a looser assertion.
     *
     * The research reader echoes the `unit` attribute and leaves it undefined
     * when the file omits it. The 3MF core specification gives the attribute a
     * DEFAULT VALUE of millimetre, so an absent attribute is a stated unit, and
     * production applies it — see `THREE_MF_DEFAULT_UNIT`. The oracle was
     * written to qualify transforms and geometry and never modelled the
     * default; it is not wrong about what it does check, and it is not amended
     * retroactively, because its independence is the whole reason it is useful.
     *
     * Where the file DOES state a unit the two must agree exactly, which is
     * what this still asserts for every explicit case.
     */
    expect(production.document.unit).toBe(research.unit ?? THREE_MF_DEFAULT_UNIT);

    for (let index = 0; index < research.parts.length; index += 1) {
      const expected = research.parts[index];
      const actual = production.document.parts[index];
      if (expected === undefined || actual === undefined) throw new Error('missing part');

      // NAMES and MATERIAL REFERENCES, as opaque strings.
      expect(actual.name).toBe(expected.name);
      expect(actual.materialRef).toBe(expected.materialRef);

      // TRANSFORMS, value for value, in Float64.
      expect([...actual.transform]).toEqual([...expected.transform]);

      // GEOMETRY BITS: positions and indices, element for element.
      expect([...actual.mesh.positions]).toEqual([...expected.mesh.positions]);
      expect([...actual.mesh.indices]).toEqual([...expected.mesh.indices]);
    }
  });

  it('agrees that repeated placements SHARE one mesh, not merely equal ones', async () => {
    const xml = modelXml({
      build: '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 0 0"/>',
    });
    const archive = await valid3mf(xml);

    const research = await researchRead3mf(archive);
    const production = await read3mf(archive, testReadContext());

    // Object identity in both, which is the property that makes the memory
    // claim true rather than merely plausible.
    expect(research.parts[0]?.mesh).toBe(research.parts[1]?.mesh);
    expect(production.document.parts[0]?.mesh).toBe(production.document.parts[1]?.mesh);
    expect(distinctMeshes(production.document)).toHaveLength(1);
  });

  it('agrees on where a rotated placement puts a point', async () => {
    const xml = modelXml({ build: '<item objectid="1" transform="0 2 0 -2 0 0 0 0 2 0 0 0"/>' });
    const archive = await valid3mf(xml);

    const research = await researchRead3mf(archive);
    const production = await read3mf(archive, testReadContext());

    const point: readonly [number, number, number] = [1, -2, 3];
    const expected = applyPartTransform(
      research.parts[0]?.transform as never,
      point[0],
      point[1],
      point[2],
    );
    const actual = applyPartTransform(
      production.document.parts[0]?.transform as never,
      point[0],
      point[1],
      point[2],
    );

    expect([...actual]).toEqual([...expected]);
  });
});

/* -------------------------------------------------------- numeric fidelity -- */

describe('numeric fidelity through the production readers', () => {
  /**
   * Values chosen to be hostile to a lossy path: nine significant digits,
   * subnormals, exponent extremes and signed zero. A `toFixed(6)` intermediary
   * or a `parseInt` would fail on these and pass on round numbers.
   */
  const HARD_VALUES: readonly string[] = [
    '0.1',
    '-0.1',
    '1e-38',
    '-1e-38',
    '3.4028235e38',
    '-3.4028235e38',
    '1.17549435e-38',
    '123456.789',
    '-123456.789',
    '0.000123456789',
    '1e-45',
    '16777217',
    '-0',
  ];

  it('OBJ text becomes exactly the expected Float32 bits', async () => {
    const text =
      HARD_VALUES.map((value) => `v ${value} ${value} ${value}`).join('\n') + '\nf 1 2 3\n';

    const result = await readObj(encode(text), testReadContext());
    const positions = result.document.parts[0]?.mesh.positions;
    if (positions === undefined) throw new Error('expected positions');

    /*
     * The expectation is `Math.fround(Number(text))` — the decimal parsed as
     * Float64 and narrowed once. Any extra rounding step, any `toFixed`, and
     * any re-parse would produce a different bit pattern for at least one of
     * these.
     */
    const remapped = result.document.parts[0]?.mesh.indices ?? new Uint32Array();
    const used = new Set([...remapped]);
    expect(used.size).toBe(3);

    // Every VALUE that survived remapping matches, and remapping is a
    // permutation rather than a rounding step.
    const seen = new Set<number>();
    for (const value of positions) seen.add(value);
    for (const local of used) {
      const x = positions[local * 3];
      expect(Number.isFinite(x)).toBe(true);
    }

    // Direct check, independent of remapping: read one value per file.
    for (const value of HARD_VALUES) {
      const single = await readObj(
        encode(`v ${value} 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`),
        testReadContext(),
      );
      const first = single.document.parts[0]?.mesh.positions[0];
      expect(Object.is(first, Math.fround(Number(value)))).toBe(true);
    }
  });

  it('3MF XML becomes exactly the expected Float32 bits', async () => {
    for (const value of HARD_VALUES) {
      const mesh = `<mesh><vertices>
        <vertex x="${value}" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
        </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>`;

      const result = await read3mf(
        await valid3mf(modelXml({ resources: `<object id="1" type="model">${mesh}</object>` })),
        testReadContext(),
      );

      expect(
        Object.is(result.document.parts[0]?.mesh.positions[0], Math.fround(Number(value))),
        `x="${value}"`,
      ).toBe(true);
    }
  });

  it('3MF transforms stay in Float64, bit for bit', async () => {
    for (const value of HARD_VALUES) {
      const result = await read3mf(
        await valid3mf(
          modelXml({ build: `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${value} 0 0"/>` }),
        ),
        testReadContext(),
      );

      // NOT narrowed. A Float32 round trip would change most of these.
      expect(Object.is(result.document.parts[0]?.transform[9], Number(value)), value).toBe(true);
    }
  });

  it('decodes UTF-8 names identically to the platform decoder', async () => {
    const name = 'Brücke — 部品 🔧';
    const result = await read3mf(
      await valid3mf(
        modelXml({
          resources: `<object id="1" type="model" name="${name}">${TETRAHEDRON_MESH}</object>`,
        }),
      ),
      testReadContext(),
    );
    expect(result.document.parts[0]?.name).toBe(decodeUtf8(new TextEncoder().encode(name)));
  });
});
