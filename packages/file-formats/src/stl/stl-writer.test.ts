import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import {
  assertMeshStructure,
  triangleCount,
  validateMeshStructure,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { DEFAULT_IMPORT_BUDGET } from '../budget';
import { estimateAsciiStlBytes } from './stl-writer';
import { asciiToBytes } from './fixtures';
import { BINARY_HEADER_BYTES, binaryStlByteLength, StlEncoding } from './detect';
import {
  buildBinaryStl,
  testContext,
  triangleAt,
  UNIT_TRIANGLE,
  type RecordingContext,
  type Triangle,
} from './fixtures';
import { readStl } from './stl-reader';
import { writeAsciiStl, writeBinaryStl } from './stl-writer';

/**
 * Writers return `{ bytes, warnings }`. Most tests only care about the bytes, so
 * these thin helpers keep the assertions readable; the warning-specific tests
 * call the writers directly.
 */
async function binaryBytes(
  mesh: CanonicalMesh,
  context: RecordingContext = testContext(),
): Promise<Uint8Array> {
  return (await writeBinaryStl(mesh, context)).bytes;
}

async function asciiBytes(
  mesh: CanonicalMesh,
  context: RecordingContext = testContext(),
): Promise<Uint8Array> {
  return (await writeAsciiStl(mesh, context)).bytes;
}

/** Builds a canonical mesh by importing generated STL bytes, so the writers are
 * always fed exactly what the production import path produces. */
async function meshFrom(triangles: readonly Triangle[]): Promise<CanonicalMesh> {
  return (await readStl(buildBinaryStl(triangles), testContext())).mesh;
}

const SAMPLE: readonly Triangle[] = [
  triangleAt(0),
  triangleAt(3),
  {
    normal: [0, 1, 0],
    vertices: [
      [-12.5, 0.125, 1000.5],
      [7.25, -3.5, -0.75],
      [0.0009765625, 4, -2048],
    ],
  },
];

describe('binary STL writer', () => {
  it('produces a file of exactly the right length', async () => {
    const bytes = await binaryBytes(await meshFrom(SAMPLE), testContext());

    expect(bytes.byteLength).toBe(binaryStlByteLength(SAMPLE.length));
  });

  it('writes the triangle count as little-endian uint32', async () => {
    const bytes = await binaryBytes(await meshFrom(SAMPLE), testContext());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(view.getUint32(BINARY_HEADER_BYTES, true)).toBe(SAMPLE.length);
  });

  it('writes a fixed header containing no user-supplied data', async () => {
    // The source filename must never be baked into an exported file: the header
    // is a fixed-width field many tools display verbatim.
    const mesh = (
      await readStl(
        buildBinaryStl(SAMPLE, { header: 'client-confidential-part-name' }),
        testContext(),
      )
    ).mesh;

    const bytes = await binaryBytes(mesh, testContext());
    let header = '';
    for (let index = 0; index < BINARY_HEADER_BYTES; index += 1) {
      const byte = bytes[index] ?? 0;
      if (byte !== 0) header += String.fromCharCode(byte);
    }

    expect(header).not.toContain('client-confidential');
    expect(header).toContain('CAD Fixer');
  });

  it('writes zero for the attribute byte count', async () => {
    const bytes = await binaryBytes(await meshFrom([UNIT_TRIANGLE]), testContext());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(view.getUint16(84 + 48, true)).toBe(0);
  });

  it('computes facet normals from the geometry rather than trusting the source', async () => {
    const backwards: Triangle = { ...UNIT_TRIANGLE, normal: [0, 0, -1] };
    const bytes = await binaryBytes(await meshFrom([backwards]), testContext());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Winding is counter-clockwise in the XY plane, so the true normal is +Z,
    // regardless of the -Z the source file claimed.
    expect(view.getFloat32(84, true)).toBeCloseTo(0, 6);
    expect(view.getFloat32(88, true)).toBeCloseTo(0, 6);
    expect(view.getFloat32(92, true)).toBeCloseTo(1, 6);
  });

  it('emits a zero normal, never NaN, for a degenerate triangle', async () => {
    const degenerate: Triangle = {
      normal: [0, 0, 1],
      vertices: [
        [2, 2, 2],
        [2, 2, 2],
        [2, 2, 2],
      ],
    };

    const bytes = await binaryBytes(await meshFrom([degenerate]), testContext());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (const offset of [84, 88, 92]) {
      const component = view.getFloat32(offset, true);
      expect(Number.isNaN(component)).toBe(false);
      expect(component).toBe(0);
    }
  });

  it('does not mutate the source mesh', async () => {
    const mesh = await meshFrom(SAMPLE);
    const before = [...mesh.positions];

    await binaryBytes(mesh, testContext());

    expect([...mesh.positions]).toEqual(before);
  });

  it('refuses to allocate beyond the output budget', async () => {
    const mesh = await meshFrom(SAMPLE);
    const context = testContext({ budget: { ...DEFAULT_IMPORT_BUDGET, maxOutputBytes: 32 } });

    try {
      await writeBinaryStl(mesh, context);
      expect.unreachable('expected the export to be refused');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.ResourceLimitExceeded);
      expect(caught.details.operation).toBe('stl/export/binary');
    }
  });
});

function decodeAscii(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

describe('ASCII STL writer', () => {
  function decode(bytes: Uint8Array): string {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
  }

  it('produces well-formed, deterministic output', async () => {
    const mesh = await meshFrom(SAMPLE);

    const first = decode(await asciiBytes(mesh, testContext()));
    const second = decode(await asciiBytes(mesh, testContext()));

    expect(first).toBe(second);
    expect(first.startsWith('solid cadfixer\n')).toBe(true);
    expect(first.trimEnd().endsWith('endsolid cadfixer')).toBe(true);
    expect(first.match(/facet normal/g)).toHaveLength(SAMPLE.length);
    expect(first.match(/vertex/g)).toHaveLength(SAMPLE.length * 3);
  });

  it('formats numbers without locale separators', async () => {
    // `toLocaleString` would emit "1,5" across much of Europe and silently
    // corrupt every exported file, so the writer must not depend on locale.
    const text = decode(await asciiBytes(await meshFrom(SAMPLE), testContext()));
    const numbers = text.match(/-?\d\.\d+e[+-]\d+/g) ?? [];

    expect(numbers.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/\d,\d/);
    for (const number of numbers) expect(Number.isFinite(Number(number))).toBe(true);
  });

  it('emits only ASCII bytes', async () => {
    const bytes = await asciiBytes(await meshFrom(SAMPLE), testContext());
    for (const byte of bytes) expect(byte).toBeLessThan(128);
  });

  it('contains no user-supplied text', async () => {
    const mesh = (
      await readStl(
        buildBinaryStl(SAMPLE, { header: 'solid client-confidential-part' }),
        testContext(),
      )
    ).mesh;

    expect(decode(await asciiBytes(mesh, testContext()))).not.toContain('client-confidential');
  });

  it('does not mutate the source mesh', async () => {
    const mesh = await meshFrom(SAMPLE);
    const before = [...mesh.positions];

    await asciiBytes(mesh, testContext());

    expect([...mesh.positions]).toEqual(before);
  });
});

/* ------------------------------------------------------------ round trip -- */

describe('round trip through our own parser', () => {
  /**
   * The writers are only complete once their output survives OUR parser and OUR
   * validation. "Another viewer opened it" is not evidence.
   */
  async function roundTrip(mesh: CanonicalMesh, encoding: StlEncoding): Promise<CanonicalMesh> {
    const bytes =
      encoding === StlEncoding.Binary
        ? await binaryBytes(mesh, testContext())
        : await asciiBytes(mesh, testContext());
    const reimported = await readStl(bytes, testContext());
    expect(reimported.encoding).toBe(encoding);
    assertMeshStructure(reimported.mesh, `stl round trip (${encoding})`);
    return reimported.mesh;
  }

  it.each([StlEncoding.Binary, StlEncoding.Ascii])(
    'preserves geometry exactly through a %s round trip',
    async (encoding) => {
      const original = await meshFrom(SAMPLE);

      const restored = await roundTrip(original, encoding);

      // Exact, not approximate. Binary STL stores float32 and canonical
      // positions are float32, so the bits survive; the ASCII writer emits nine
      // significant digits, which uniquely identifies any float32.
      expect(triangleCount(restored)).toBe(triangleCount(original));
      expect([...restored.positions]).toEqual([...original.positions]);
      expect([...restored.indices]).toEqual([...original.indices]);
    },
  );

  it.each([StlEncoding.Binary, StlEncoding.Ascii])(
    'survives extreme coordinate magnitudes through %s',
    async (encoding) => {
      const extreme: readonly Triangle[] = [
        {
          normal: [0, 0, 1],
          vertices: [
            [1.5e7, -2.5e7, 3.5e7],
            [1.5e7 + 64, -2.5e7, 3.5e7],
            [1.5e7, -2.5e7 + 64, 3.5e7],
          ],
        },
        {
          normal: [0, 0, 1],
          vertices: [
            [1e-7, -2e-7, 3e-7],
            [2e-7, -2e-7, 3e-7],
            [1e-7, -1e-7, 3e-7],
          ],
        },
      ];
      const original = await meshFrom(extreme);

      expect([...(await roundTrip(original, encoding)).positions]).toEqual([...original.positions]);
    },
  );

  it.each([StlEncoding.Binary, StlEncoding.Ascii])(
    'preserves triangle count and order through %s for a larger mesh',
    async (encoding) => {
      const many = Array.from({ length: 500 }, (_unused, index) => triangleAt(index));
      const original = await meshFrom(many);

      const restored = await roundTrip(original, encoding);

      expect(triangleCount(restored)).toBe(500);
      expect([...restored.positions]).toEqual([...original.positions]);
    },
  );

  it('keeps a degenerate triangle across a round trip rather than dropping it', async () => {
    const withDegenerate: readonly Triangle[] = [
      UNIT_TRIANGLE,
      {
        normal: [0, 0, 0],
        vertices: [
          [5, 5, 5],
          [5, 5, 5],
          [5, 5, 5],
        ],
      },
    ];
    const original = await meshFrom(withDegenerate);

    for (const encoding of [StlEncoding.Binary, StlEncoding.Ascii]) {
      const restored = await roundTrip(original, encoding);
      expect(triangleCount(restored)).toBe(2);
      expect([...restored.positions]).toEqual([...original.positions]);
    }
  });

  it('produces output that passes structural validation cleanly', async () => {
    const original = await meshFrom(SAMPLE);

    for (const encoding of [StlEncoding.Binary, StlEncoding.Ascii]) {
      const report = validateMeshStructure(await roundTrip(original, encoding));
      expect(report.valid).toBe(true);
      expect(report.issues).toEqual([]);
    }
  });

  it('is stable across repeated round trips', async () => {
    let mesh = await meshFrom(SAMPLE);
    const expected = [...mesh.positions];

    for (let generation = 0; generation < 3; generation += 1) {
      mesh = await roundTrip(mesh, StlEncoding.Binary);
      mesh = await roundTrip(mesh, StlEncoding.Ascii);
    }

    expect([...mesh.positions]).toEqual(expected);
  });
});

/* ------------------------------------------------- ascii size policy (A5) -- */

describe('ASCII self-round-trip policy', () => {
  /**
   * ASCII STL is ~5x the size of binary, so a model near the top of the
   * supported range produces a file this application would then refuse to open.
   * Emitting output that violates our own import contract is a trap the user
   * only discovers on the way back in.
   */
  it('estimates conservatively — real output never exceeds the estimate', async () => {
    // The property the whole policy rests on. If the estimate could
    // under-shoot, the check would let through exactly the file it exists to
    // prevent.
    for (const count of [1, 2, 17, 500]) {
      const triangles = Array.from({ length: count }, (_unused, index) => triangleAt(index));
      const mesh = await meshFrom(triangles);

      const produced = (await asciiBytes(mesh)).byteLength;

      expect(produced).toBeLessThanOrEqual(estimateAsciiStlBytes(count));
    }
  });

  it('holds even for coordinates with the widest possible exponents', async () => {
    const extreme: readonly Triangle[] = [
      {
        normal: [0, 0, 1],
        vertices: [
          [-3.4e38, 1.4e-45, 3.4e38],
          [3.4e38, -1.4e-45, -3.4e38],
          [-1.17e-38, 1.17e38, -1.17e-38],
        ],
      },
    ];
    const mesh = await meshFrom(extreme);

    expect((await asciiBytes(mesh)).byteLength).toBeLessThanOrEqual(estimateAsciiStlBytes(1));
  });

  it('refuses ASCII export whose output could not be re-imported', async () => {
    const mesh = await meshFrom(SAMPLE);
    // A budget under which this model's ASCII form would exceed what we accept
    // back in.
    const context = testContext({
      budget: { ...DEFAULT_IMPORT_BUDGET, maxInputBytes: 200 },
    });

    try {
      await writeAsciiStl(mesh, context);
      expect.unreachable('expected the ASCII export to be refused');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.ResourceLimitExceeded);
      expect(caught.details.operation).toBe('stl/export/ascii');
      // And it tells the user what to do instead, rather than just refusing.
      expect(caught.details.recommendedEncoding).toBe('binary');
      expect(caught.message).toContain('binary');
    }
  });

  it('still allows binary export of the same model', async () => {
    // The recommendation has to be real: binary must actually fit where ASCII
    // did not.
    const mesh = await meshFrom(SAMPLE);
    const context = testContext({
      budget: { ...DEFAULT_IMPORT_BUDGET, maxInputBytes: 200 },
    });

    expect((await binaryBytes(mesh, context)).byteLength).toBe(84 + SAMPLE.length * 50);
  });
});

/* ------------------------------------------------ multi-solid export (A6) -- */

describe('group preservation on export', () => {
  /** An ASCII source with two named solids, which import keeps as groups. */
  async function groupedMesh(): Promise<CanonicalMesh> {
    const solid = (name: string, offset: number): string =>
      `solid ${name}\nfacet normal 0 0 1\nouter loop\n` +
      `vertex ${String(offset)} 0 0\nvertex ${String(offset + 1)} 0 0\nvertex ${String(offset)} 1 0\n` +
      `endloop\nendfacet\nendsolid ${name}\n`;
    const bytes = asciiToBytes(`${solid('alpha', 0)}${solid('beta', 5)}`);
    return (await readStl(bytes, testContext())).mesh;
  }

  it('writes one solid block per group instead of flattening them', async () => {
    const mesh = await groupedMesh();
    expect(mesh.groups).toHaveLength(2);

    const text = decodeAscii(await asciiBytes(mesh));

    expect(text.match(/^solid /gm)).toHaveLength(2);
    expect(text.match(/^endsolid /gm)).toHaveLength(2);
  });

  it('round-trips group boundaries through our own parser', async () => {
    const mesh = await groupedMesh();

    const reimported = (await readStl(await asciiBytes(mesh), testContext())).mesh;

    expect(reimported.groups).toHaveLength(2);
    expect(reimported.groups?.[0]?.indexCount).toBe(3);
    expect(reimported.groups?.[1]?.indexCount).toBe(3);
    expect([...reimported.positions]).toEqual([...mesh.positions]);
  });

  it('uses generated names, never the source names', async () => {
    // A solid name is user-controlled text that routinely holds a path or a
    // project name. Copying it into an exported file would leak it onward.
    const bytes = asciiToBytes(
      'solid /home/alice/acme-prosthetic-v4\nfacet normal 0 0 1\nouter loop\n' +
        'vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid /home/alice/acme-prosthetic-v4\n',
    );
    const mesh = (await readStl(bytes, testContext())).mesh;

    const text = decodeAscii(await asciiBytes(mesh));

    expect(text).not.toContain('acme-prosthetic');
    expect(text).not.toContain('/home/alice');
  });

  it('warns that ASCII export renamed the solids', async () => {
    const result = await writeAsciiStl(await groupedMesh(), testContext());

    expect(result.warnings.map((warning) => warning.code)).toContain('STL_GROUPS_RENAMED');
  });

  it('WARNS that binary export discards grouping rather than losing it silently', async () => {
    // Binary STL has no multi-solid construct at all. The loss is real; saying
    // so is the difference between documented and silent.
    const result = await writeBinaryStl(await groupedMesh(), testContext());

    const warning = result.warnings.find((entry) => entry.code === 'STL_GROUPS_FLATTENED');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('ASCII');
    expect(warning?.details?.groupCount).toBe(2);
  });

  it('does not warn about grouping when there is none to lose', async () => {
    const plain = await meshFrom(SAMPLE);

    expect((await writeBinaryStl(plain, testContext())).warnings).toEqual([]);
    expect((await writeAsciiStl(plain, testContext())).warnings).toEqual([]);
  });

  it('preserves every triangle across a grouped ASCII round trip', async () => {
    const mesh = await groupedMesh();

    const reimported = (await readStl(await asciiBytes(mesh), testContext())).mesh;

    expect(triangleCount(reimported)).toBe(triangleCount(mesh));
  });
});
