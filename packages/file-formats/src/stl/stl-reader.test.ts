import { describe, expect, it } from 'vitest';
import { AppErrorCode, CancellationSource, isAppError, uncancellable } from '@cadfixer/shared';
import { triangleCount, validateMeshStructure, vertexCount } from '@cadfixer/mesh-core';
import { DEFAULT_IMPORT_BUDGET, type ImportBudget } from '../budget';
import type { FormatReadContext } from '../context';
import { StlEncoding } from './detect';
import {
  asciiToBytes,
  buildAsciiStl,
  buildBinaryStl,
  testContext,
  triangleAt,
  UNIT_TRIANGLE,
  type Triangle,
} from './fixtures';
import { readStl } from './stl-reader';
import { StlWarningCode } from './warnings';

/**
 * Parser behaviour, including the adversarial inputs a file-opening surface has
 * to survive. Every fixture is generated in code — see `fixtures.ts` — so no
 * opaque binary blobs are committed and each byte under test is auditable.
 */

async function expectAppError(run: () => Promise<unknown>, code: AppErrorCode): Promise<void> {
  try {
    await run();
    expect.unreachable('expected the parse to be rejected');
  } catch (caught) {
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(caught.code).toBe(code);
  }
}

/* -------------------------------------------------------- valid binary in -- */

describe('binary STL import', () => {
  it('reads a single triangle and preserves its coordinates exactly', async () => {
    const result = await readStl(buildBinaryStl([UNIT_TRIANGLE]), testContext());

    expect(result.encoding).toBe(StlEncoding.Binary);
    expect(triangleCount(result.mesh)).toBe(1);
    expect(vertexCount(result.mesh)).toBe(3);
    expect([...result.mesh.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect([...result.mesh.indices]).toEqual([0, 1, 2]);
  });

  it('reads many triangles in file order', async () => {
    const triangles = [triangleAt(0), triangleAt(10), triangleAt(20)];

    const result = await readStl(buildBinaryStl(triangles), testContext());

    expect(triangleCount(result.mesh)).toBe(3);
    expect(result.mesh.positions[0]).toBe(0);
    expect(result.mesh.positions[9]).toBe(10);
    expect(result.mesh.positions[18]).toBe(20);
  });

  it('records STL as the source format and leaves the unit unstated', async () => {
    const result = await readStl(buildBinaryStl([UNIT_TRIANGLE]), testContext());

    expect(result.mesh.metadata.sourceFormat).toBe('stl');
    // STL has no standardised unit field. Claiming millimetres would be
    // inventing information about the user's model. The unit travels on the
    // READ RESULT and lands on the document, so its absence is asserted there.
    expect(result.unit).toBeUndefined();
    expect('unit' in result).toBe(false);
  });

  it('leaves placement to the part and never touches the coordinates', async () => {
    const result = await readStl(buildBinaryStl([UNIT_TRIANGLE]), testContext());

    // A mesh carries no transform of its own. Placement is a property of the
    // PART that holds the mesh, so there is exactly one transform authority and
    // a shared mesh cannot be placed two contradictory ways at once.
    expect(Object.keys(result.mesh.metadata)).toEqual(['sourceFormat']);

    // The property the removed transform field was standing in for: import
    // applies nothing to the file's coordinates.
    expect([...result.mesh.positions]).toEqual(UNIT_TRIANGLE.vertices.flatMap((v) => [...v]));
  });

  it('does not store the file’s facet normals as geometry', async () => {
    // Stored normals are advisory and often disagree with winding order, so
    // they are never promoted to canonical data.
    const wrongNormal: Triangle = { ...UNIT_TRIANGLE, normal: [0, 0, -1] };

    const result = await readStl(buildBinaryStl([wrongNormal]), testContext());

    expect(result.mesh.normals).toBeUndefined();
  });

  it('warns about zero facet normals without failing', async () => {
    const zeroNormal: Triangle = { ...UNIT_TRIANGLE, normal: [0, 0, 0] };

    const result = await readStl(buildBinaryStl([zeroNormal]), testContext());

    expect(result.warnings.map((warning) => warning.code)).toContain(
      StlWarningCode.ZeroStoredNormals,
    );
    expect(validateMeshStructure(result.mesh).valid).toBe(true);
  });

  it('warns about non-finite facet normals without failing', async () => {
    const badNormal: Triangle = { ...UNIT_TRIANGLE, normal: [Number.NaN, 0, 1] };

    const result = await readStl(buildBinaryStl([badNormal]), testContext());

    expect(result.warnings.map((warning) => warning.code)).toContain(
      StlWarningCode.InvalidStoredNormals,
    );
    expect(triangleCount(result.mesh)).toBe(1);
  });

  it('warns about trailing bytes', async () => {
    const result = await readStl(
      buildBinaryStl([UNIT_TRIANGLE], { trailingBytes: 8 }),
      testContext(),
    );

    expect(result.warnings.map((warning) => warning.code)).toContain(StlWarningCode.TrailingBytes);
  });

  it('reads a file whose header begins with "solid" as binary', async () => {
    const bytes = buildBinaryStl([UNIT_TRIANGLE, UNIT_TRIANGLE], {
      header: 'solid a misleading header written by a real exporter',
    });

    const result = await readStl(bytes, testContext());

    expect(result.encoding).toBe(StlEncoding.Binary);
    expect(triangleCount(result.mesh)).toBe(2);
  });

  it('reads correctly from a Uint8Array that views part of a larger buffer', async () => {
    // A subarray has a non-zero byteOffset. Building the DataView from the whole
    // underlying buffer instead of the view's own window would read garbage.
    const source = buildBinaryStl([triangleAt(7)]);
    const padded = new Uint8Array(source.byteLength + 100);
    padded.set(source, 64);
    const view = padded.subarray(64, 64 + source.byteLength);

    const result = await readStl(view, testContext());

    expect(result.mesh.positions[0]).toBe(7);
  });
});

/* --------------------------------------------------------- valid ascii in -- */

describe('ASCII STL import', () => {
  it('reads a single triangle and preserves its coordinates exactly', async () => {
    const result = await readStl(buildAsciiStl([UNIT_TRIANGLE]), testContext());

    expect(result.encoding).toBe(StlEncoding.Ascii);
    expect(triangleCount(result.mesh)).toBe(1);
    expect([...result.mesh.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('handles CRLF line endings', async () => {
    const bytes = buildAsciiStl([UNIT_TRIANGLE, UNIT_TRIANGLE], { lineEnding: '\r\n' });

    expect(triangleCount((await readStl(bytes, testContext())).mesh)).toBe(2);
  });

  it('handles a missing final newline', async () => {
    const bytes = buildAsciiStl([UNIT_TRIANGLE], { trailingNewline: false });

    expect(triangleCount((await readStl(bytes, testContext())).mesh)).toBe(1);
  });

  it('handles extreme but legal whitespace', async () => {
    const bytes = asciiToBytes(
      'solid   spaced\n\n\n\t\tfacet\t\tnormal\t0 0 1\n\n   outer\t loop\n' +
        '\t\t\tvertex   0   0   0\n   vertex 1 0 0\n\t vertex 0 1 0\n' +
        '  endloop\n\tendfacet\n\n\nendsolid   spaced\n\n',
    );

    expect(triangleCount((await readStl(bytes, testContext())).mesh)).toBe(1);
  });

  it('accepts a file with no endsolid and warns', async () => {
    const bytes = buildAsciiStl([UNIT_TRIANGLE], { includeEndSolid: false });

    const result = await readStl(bytes, testContext());

    expect(triangleCount(result.mesh)).toBe(1);
    expect(result.warnings.map((warning) => warning.code)).toContain(
      StlWarningCode.MissingEndSolid,
    );
  });

  it('keeps multiple solids as separate groups rather than flattening them', async () => {
    const bytes = asciiToBytes(
      `${asciiSolid('alpha', [triangleAt(0)])}${asciiSolid('beta', [triangleAt(5), triangleAt(9)])}`,
    );

    const result = await readStl(bytes, testContext());

    expect(triangleCount(result.mesh)).toBe(3);
    expect(result.mesh.groups).toEqual([
      { name: 'alpha', indexOffset: 0, indexCount: 3 },
      { name: 'beta', indexOffset: 3, indexCount: 6 },
    ]);
    expect(result.warnings.map((warning) => warning.code)).toContain(StlWarningCode.MultipleSolids);
  });

  it('produces groups that pass structural validation', async () => {
    const bytes = asciiToBytes(
      `${asciiSolid('a', [triangleAt(0)])}${asciiSolid('b', [triangleAt(4)])}`,
    );

    expect(validateMeshStructure((await readStl(bytes, testContext())).mesh).valid).toBe(true);
  });

  it('parses decimal, exponential, and signed literals', async () => {
    const bytes = asciiToBytes(
      'solid n\nfacet normal 0 0 1\nouter loop\n' +
        'vertex -1.5 2.25e2 0\nvertex +3 -4.5E-1 0\nvertex 0 0 .5\n' +
        'endloop\nendfacet\nendsolid n\n',
    );

    const positions = [...(await readStl(bytes, testContext())).mesh.positions];

    expect(positions[0]).toBeCloseTo(-1.5, 6);
    expect(positions[1]).toBeCloseTo(225, 6);
    expect(positions[3]).toBeCloseTo(3, 6);
    expect(positions[4]).toBeCloseTo(-0.45, 6);
    expect(positions[8]).toBeCloseTo(0.5, 6);
  });
});

/* ------------------------------------------------------- data preservation -- */

describe('data preservation', () => {
  it('does not weld coincident vertices', async () => {
    // Two triangles sharing an edge. A welding parser would produce 4 vertices;
    // preserving the file means 6. Welding is repair, and repair is opt-in.
    const shared: readonly Triangle[] = [
      {
        normal: [0, 0, 1],
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
      },
      {
        normal: [0, 0, 1],
        vertices: [
          [1, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
        ],
      },
    ];

    const result = await readStl(buildBinaryStl(shared), testContext());

    expect(vertexCount(result.mesh)).toBe(6);
    expect(triangleCount(result.mesh)).toBe(2);
  });

  it('does not remove degenerate triangles', async () => {
    const degenerate: Triangle = {
      normal: [0, 0, 0],
      vertices: [
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
    };

    const result = await readStl(buildBinaryStl([UNIT_TRIANGLE, degenerate]), testContext());

    // Kept, not silently dropped: removing it would be repair.
    expect(triangleCount(result.mesh)).toBe(2);
    expect([...result.mesh.positions.slice(9)]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(validateMeshStructure(result.mesh).valid).toBe(true);
  });

  it('is not yet flagged by structural validation, which only sees repeated indices', async () => {
    // Documents a real gap rather than papering over it. The Stage 0 degeneracy
    // check looks for a triangle referencing the same vertex index twice. STL
    // triangle soup numbers every corner uniquely, so a zero-area triangle is
    // invisible to it. Detecting positional degeneracy needs a per-triangle
    // cross product and belongs with the topological diagnostics stage; this
    // test exists so the limitation is visible and fails loudly once that lands.
    const degenerate: Triangle = {
      normal: [0, 0, 0],
      vertices: [
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
    };

    const report = validateMeshStructure(
      (await readStl(buildBinaryStl([degenerate]), testContext())).mesh,
    );

    expect(report.issues.map((issue) => issue.code)).not.toContain('DEGENERATE_TRIANGLE');
  });

  it('does not deduplicate identical triangles', async () => {
    const result = await readStl(
      buildBinaryStl([UNIT_TRIANGLE, UNIT_TRIANGLE, UNIT_TRIANGLE]),
      testContext(),
    );

    expect(triangleCount(result.mesh)).toBe(3);
  });

  it('does not reorient winding to match the stored normal', async () => {
    const backwards: Triangle = { ...UNIT_TRIANGLE, normal: [0, 0, -1] };

    const result = await readStl(buildBinaryStl([backwards]), testContext());

    // Winding is untouched; only the advisory normal disagreed.
    expect([...result.mesh.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('does not rescale coordinates', async () => {
    const large: Triangle = {
      normal: [0, 0, 1],
      vertices: [
        [1e6, 2e6, 3e6],
        [1e6 + 1, 2e6, 3e6],
        [1e6, 2e6 + 1, 3e6],
      ],
    };

    const result = await readStl(buildBinaryStl([large]), testContext());

    expect(result.mesh.positions[0]).toBe(1e6);
    expect(result.mesh.positions[1]).toBe(2e6);
    expect(result.mesh.positions[2]).toBe(3e6);
  });

  it('preserves negative and near-zero coordinates', async () => {
    const tiny: Triangle = {
      normal: [0, 0, 1],
      vertices: [
        [-1e-6, -2e-6, 0],
        [1e-6, 0, 0],
        [0, 1e-6, 0],
      ],
    };

    const positions = [...(await readStl(buildBinaryStl([tiny]), testContext())).mesh.positions];

    expect(positions[0]).toBeCloseTo(-1e-6, 12);
    expect(positions[1]).toBeCloseTo(-2e-6, 12);
  });
});

/* ------------------------------------------------------------ hostile in -- */

describe('hostile and malformed input', () => {
  it('rejects an empty file', async () => {
    await expectAppError(
      () => readStl(new Uint8Array(0), testContext()),
      AppErrorCode.MalformedFile,
    );
  });

  it.each([1, 2, 40, 79, 80, 83])('rejects a %d-byte file', async (size) => {
    await expectAppError(
      () => readStl(new Uint8Array(size), testContext()),
      AppErrorCode.MalformedFile,
    );
  });

  it('rejects an 84-byte file that declares zero triangles', async () => {
    await expectAppError(
      () => readStl(new Uint8Array(84), testContext()),
      AppErrorCode.MalformedFile,
    );
  });

  it('rejects a declared count larger than the file can hold', async () => {
    const bytes = buildBinaryStl([UNIT_TRIANGLE], { declaredCount: 5000 });

    try {
      await readStl(bytes, testContext());
      expect.unreachable('expected truncation to be rejected');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.MalformedFile);
      expect(caught.details.declaredTriangles).toBe(5000);
      expect(caught.details.actualBytes).toBe(bytes.byteLength);
    }
  });

  it('rejects a maximum uint32 facet count without allocating', async () => {
    const bytes = buildBinaryStl([UNIT_TRIANGLE], { declaredCount: 0xffffffff });

    // The important property is that this returns a typed error promptly rather
    // than attempting a 214 GB allocation.
    await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.UnsupportedFile);
  });

  it('rejects a file whose last facet is truncated', async () => {
    const full = buildBinaryStl([UNIT_TRIANGLE, UNIT_TRIANGLE]);
    const clipped = full.slice(0, full.byteLength - 20);

    await expectAppError(() => readStl(clipped, testContext()), AppErrorCode.MalformedFile);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects a binary file containing a %s coordinate', async (_label, value) => {
    const bad: Triangle = {
      normal: [0, 0, 1],
      vertices: [
        [0, 0, 0],
        [value, 0, 0],
        [0, 1, 0],
      ],
    };

    await expectAppError(
      () => readStl(buildBinaryStl([bad]), testContext()),
      AppErrorCode.MalformedFile,
    );
  });

  it.each(['nan', 'NaN', 'inf', 'Infinity', '-inf', '-Infinity'])(
    'rejects an ASCII file containing the coordinate literal %s',
    async (literal) => {
      const bytes = asciiToBytes(
        `solid n\nfacet normal 0 0 1\nouter loop\nvertex ${literal} 0 0\n` +
          'vertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid n\n',
      );

      await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
    },
  );

  it('rejects random text saved with an .stl name', async () => {
    const bytes = asciiToBytes(
      'Dear team,\n\nPlease find the vertex coordinates attached. The normal procedure applies.\n'.repeat(
        20,
      ),
    );

    await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.UnsupportedFile);
  });

  it('rejects an ASCII facet with only two vertices', async () => {
    const bytes = asciiToBytes(
      'solid n\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\n' +
        'endloop\nendfacet\nendsolid n\n',
    );

    await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
  });

  it('rejects an ASCII facet with four vertices instead of triangulating it', async () => {
    // STL has no polygon facets. Silently triangulating would be inventing
    // geometry the file does not contain.
    const bytes = asciiToBytes(
      'solid n\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\n' +
        'vertex 1 1 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid n\n',
    );

    await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
  });

  it('rejects an ASCII facet missing its endloop', async () => {
    const bytes = asciiToBytes(
      'solid n\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\n' +
        'endfacet\nendsolid n\n',
    );

    await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
  });

  it('rejects an ASCII vertex with a missing coordinate', async () => {
    const bytes = asciiToBytes(
      'solid n\nfacet normal 0 0 1\nouter loop\nvertex 0 0\nvertex 1 0 0\nvertex 0 1 0\n' +
        'endloop\nendfacet\nendsolid n\n',
    );

    await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
  });

  it('rejects an absurdly long token instead of reading it', async () => {
    const monster = 'x'.repeat(500_000);
    const bytes = asciiToBytes(
      `solid n\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\n` +
        `endloop\nendfacet\n${monster}\nendsolid n\n`,
    );

    await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
  });

  it('parses a many-thousand-facet ASCII file without stalling or mis-counting', async () => {
    // RENAMED, deliberately. This was called "parses a long ASCII file in
    // linear time" and measured no time at all — it would have passed against a
    // quadratic scanner or a backtracking regex at this size, so the name
    // promised a guarantee the assertions never checked.
    //
    // What it actually verifies is that a large, well-formed ASCII input parses
    // to completion with the right facet count. That is worth having. The
    // linear-time property is established structurally instead: the scanner has
    // a single monotonically advancing cursor and there is no regular
    // expression anywhere in the parse path. Complexity is measured, not
    // asserted, by `npm run bench:stl` — see docs/PERFORMANCE_BASELINE.md, where
    // the ASCII throughput figures across 1/10/50 MiB inputs would expose
    // super-linear behaviour immediately.
    const many = Array.from({ length: 4000 }, (_unused, index) => triangleAt(index));
    const bytes = buildAsciiStl(many);

    const result = await readStl(bytes, testContext());

    expect(triangleCount(result.mesh)).toBe(4000);
  });
});

/* ------------------------------------------------------------ regressions -- */

describe('regressions', () => {
  it('parses an ASCII STL whose solid is named "facet"', async () => {
    // The counting pass skipped the name after `solid` but not after
    // `endsolid`, so the trailing name was tokenised. A solid called "facet"
    // inflated the count, the two passes disagreed, and a perfectly ordinary
    // file was refused with an INTERNAL error.
    const bytes = asciiToBytes(
      'solid facet\nfacet normal 0 0 1\nouter loop\n' +
        'vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid facet\n',
    );

    const result = await readStl(bytes, testContext());

    expect(result.encoding).toBe(StlEncoding.Ascii);
    expect(triangleCount(result.mesh)).toBe(1);
  });

  it.each(['my facet part', 'vertex holder', 'outer loop bracket', 'endloop test'])(
    'parses an ASCII STL whose solid name contains the keyword %j',
    async (name) => {
      const bytes = asciiToBytes(
        `solid ${name}\nfacet normal 0 0 1\nouter loop\n` +
          `vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid ${name}\n`,
      );

      expect(triangleCount((await readStl(bytes, testContext())).mesh)).toBe(1);
    },
  );

  it('reports a structurally inconsistent ASCII file as malformed, not internal', async () => {
    // A disagreement between two passes over the same untrusted bytes is a
    // property of the file. Telling the user CAD Fixer has an internal defect
    // would be both wrong and alarming.
    const bytes = asciiToBytes('solid a\nendsolid a\nfacet normal 0 0 1\n');

    await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
  });

  it.each(['1e39', '-1e39', '3.5e38'])(
    'rejects the ASCII coordinate %s, which overflows float32',
    async (literal) => {
      // These are finite doubles that become Infinity the moment they are
      // narrowed into the Float32Array. Checking only double finiteness let an
      // infinity into the canonical mesh through the ASCII path.
      const bytes = asciiToBytes(
        `solid n\nfacet normal 0 0 1\nouter loop\nvertex ${literal} 0 0\n` +
          'vertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid n\n',
      );

      await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
    },
  );

  it('accepts a coordinate at the top of the float32 range', async () => {
    // The boundary the check above must not overshoot.
    const bytes = asciiToBytes(
      'solid n\nfacet normal 0 0 1\nouter loop\nvertex 3.4e38 0 0\n' +
        'vertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid n\n',
    );

    const result = await readStl(bytes, testContext());

    expect(Number.isFinite(result.mesh.positions[0])).toBe(true);
  });

  it.each(['0x41', '0b101', '0o17', '1_000', '1d5', '--1'])(
    'rejects the non-decimal coordinate literal %s',
    async (literal) => {
      // `Number('0x41')` is 65. Handing tokens straight to it would silently
      // reinterpret a file that should have been refused.
      const bytes = asciiToBytes(
        `solid n\nfacet normal 0 0 1\nouter loop\nvertex ${literal} 0 0\n` +
          'vertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid n\n',
      );

      await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
    },
  );

  it('does not allocate from a run of bare "facet" tokens', async () => {
    // Counting bare `facet` keywords let a file of repeated tokens drive an
    // allocation roughly eight times its own size before pass two rejected it.
    const preamble =
      'solid n\nfacet normal 0 0 1\nouter loop\n' +
      'vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n';
    const bytes = asciiToBytes(preamble + 'facet '.repeat(200_000));

    // Rejected, and rejected without first committing memory for 200,000
    // facets that do not exist.
    await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
  });

  it('refuses a facet count larger than the file has room to contain', async () => {
    const preamble =
      'solid n\nfacet normal 0 0 1\nouter loop\n' +
      'vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n';
    // `facet normal` pairs with nothing else: counted, but far too dense to be
    // real facets.
    const bytes = asciiToBytes(preamble + 'facet normal '.repeat(50_000));

    await expectAppError(() => readStl(bytes, testContext()), AppErrorCode.MalformedFile);
  });

  it('keeps the offending coordinate literal out of the error details', async () => {
    // `details` is the field that would be transmitted if telemetry were ever
    // added, so it must carry no content from the user's file.
    const bytes = asciiToBytes(
      'solid n\nfacet normal 0 0 1\nouter loop\nvertex NaN 0 0\n' +
        'vertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid n\n',
    );

    const caught = await readStl(bytes, testContext()).then(
      () => undefined,
      (error: unknown) => (isAppError(error) ? error : undefined),
    );

    expect(caught?.code).toBe(AppErrorCode.MalformedFile);
    expect(JSON.stringify(caught?.details)).not.toContain('NaN');
    expect(caught?.details.axis).toBe('x');
  });
});

/* ---------------------------------------------------------------- budget -- */

describe('resource budget', () => {
  const tinyBudget = (overrides: Partial<ImportBudget> = {}): ImportBudget => ({
    ...DEFAULT_IMPORT_BUDGET,
    ...overrides,
  });

  it('rejects an input larger than the byte budget before parsing', async () => {
    const bytes = buildBinaryStl([UNIT_TRIANGLE, UNIT_TRIANGLE]);
    const context = testContext({ budget: tinyBudget({ maxInputBytes: 50 }) });

    try {
      await readStl(bytes, context);
      expect.unreachable('expected the input to be rejected');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.ResourceLimitExceeded);
      expect(caught.details.limit).toBe(50);
      expect(caught.details.requested).toBe(bytes.byteLength);
    }
  });

  it('rejects a binary file exceeding the triangle budget', async () => {
    const bytes = buildBinaryStl([UNIT_TRIANGLE, UNIT_TRIANGLE, UNIT_TRIANGLE]);
    const context = testContext({ budget: tinyBudget({ maxTriangles: 2 }) });

    try {
      await readStl(bytes, context);
      expect.unreachable('expected the triangle budget to reject this');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.ResourceLimitExceeded);
      expect(caught.details.operation).toBe('stl/import/binary');
      expect(caught.details.triangleCount).toBe(3);
    }
  });

  it('rejects a binary file exceeding the output byte budget', async () => {
    const bytes = buildBinaryStl([UNIT_TRIANGLE, UNIT_TRIANGLE]);
    const context = testContext({ budget: tinyBudget({ maxOutputBytes: 16 }) });

    await expectAppError(() => readStl(bytes, context), AppErrorCode.ResourceLimitExceeded);
  });

  it('rejects an ASCII file exceeding the triangle budget while counting', async () => {
    // The ASCII path measures rather than trusts a declared count, so the
    // budget has to bite during the counting pass.
    const bytes = buildAsciiStl([UNIT_TRIANGLE, UNIT_TRIANGLE, UNIT_TRIANGLE, UNIT_TRIANGLE]);
    const context = testContext({ budget: tinyBudget({ maxTriangles: 2 }) });

    try {
      await readStl(bytes, context);
      expect.unreachable('expected the triangle budget to reject this');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.ResourceLimitExceeded);
      expect(caught.details.operation).toBe('stl/import/ascii');
    }
  });

  it('never puts file contents into a rejection', async () => {
    const bytes = buildBinaryStl([UNIT_TRIANGLE], { header: 'secret-client-project-name' });
    const context = testContext({ budget: tinyBudget({ maxInputBytes: 10 }) });

    // Routed through the shared helper. Written inline, an `isAppError` guard
    // that returned early would also swallow `expect.unreachable`, and the test
    // would pass even if the rejection never happened.
    await expectAppError(() => readStl(bytes, context), AppErrorCode.ResourceLimitExceeded);

    const caught = await readStl(bytes, context).then(
      () => undefined,
      (error: unknown) => (isAppError(error) ? error : undefined),
    );
    expect(caught).toBeDefined();
    expect(JSON.stringify(caught?.toSerializable())).not.toContain('secret-client-project-name');
  });
});

/* ---------------------------------------------------- progress and cancel -- */

describe('progress reporting', () => {
  it('reports monotonic progress ending at 1 for binary input', async () => {
    const context = testContext();

    await readStl(buildBinaryStl([UNIT_TRIANGLE, UNIT_TRIANGLE]), context);

    expect(context.fractions.length).toBeGreaterThan(0);
    expect(context.fractions.at(-1)).toBe(1);
    for (let index = 1; index < context.fractions.length; index += 1) {
      expect(context.fractions[index]).toBeGreaterThanOrEqual(context.fractions[index - 1] ?? 0);
    }
  });

  it('reports monotonic progress across both ASCII passes', async () => {
    const many = Array.from({ length: 2000 }, (_unused, index) => triangleAt(index));
    const context = testContext();

    await readStl(buildAsciiStl(many), context);

    expect(context.fractions.at(-1)).toBe(1);
    for (let index = 1; index < context.fractions.length; index += 1) {
      expect(context.fractions[index]).toBeGreaterThanOrEqual(context.fractions[index - 1] ?? 0);
    }
  });

  it('keeps every reported fraction within 0..1', async () => {
    const context = testContext();
    await readStl(buildBinaryStl([UNIT_TRIANGLE]), context);

    for (const fraction of context.fractions) {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
  });
});

describe('cancellation', () => {
  function cancellingContext(source: CancellationSource, cancelAfter: number): FormatReadContext {
    let reports = 0;
    return {
      cancellation: source.token,
      budget: DEFAULT_IMPORT_BUDGET,
      yieldToEventLoop: (): Promise<void> => Promise.resolve(),
      progress: {
        report(): void {
          reports += 1;
          if (reports >= cancelAfter) source.cancel();
        },
      },
    };
  }

  it('aborts a binary parse with OPERATION_CANCELLED', async () => {
    const many = Array.from({ length: 200_000 }, (_unused, index) => triangleAt(index % 100));
    const source = new CancellationSource();

    await expectAppError(
      () => readStl(buildBinaryStl(many), cancellingContext(source, 1)),
      AppErrorCode.OperationCancelled,
    );
  });

  it('aborts an ASCII parse with OPERATION_CANCELLED', async () => {
    const many = Array.from({ length: 60_000 }, (_unused, index) => triangleAt(index % 100));
    const source = new CancellationSource();

    await expectAppError(
      () => readStl(buildAsciiStl(many), cancellingContext(source, 1)),
      AppErrorCode.OperationCancelled,
    );
  });

  it('observes a cancel that arrives while the parser is yielded', async () => {
    // This models what actually happens in production. The cancel arrives as a
    // message and can only be delivered when the handler returns to the event
    // loop, so the flag flips during `yieldToEventLoop` — not during the
    // parsing loop. A parser that never yielded could not see it at all, which
    // was a real defect this test now guards.
    const source = new CancellationSource();
    const many = Array.from({ length: 200_000 }, (_unused, index) => triangleAt(index % 100));
    let yields = 0;

    const context: FormatReadContext = {
      cancellation: source.token,
      budget: DEFAULT_IMPORT_BUDGET,
      progress: { report: (): void => undefined },
      yieldToEventLoop: (): Promise<void> => {
        yields += 1;
        if (yields >= 2) source.cancel();
        return Promise.resolve();
      },
    };

    await expectAppError(
      () => readStl(buildBinaryStl(many), context),
      AppErrorCode.OperationCancelled,
    );
    expect(yields).toBeGreaterThan(0);
  });

  it('yields periodically so a queued cancel can be delivered at all', async () => {
    // Guards the yielding itself. Without it, cancellation silently becomes a
    // no-op for every synchronous parse.
    const many = Array.from({ length: 300_000 }, (_unused, index) => triangleAt(index % 100));
    let yields = 0;
    const context: FormatReadContext = {
      cancellation: uncancellable,
      budget: DEFAULT_IMPORT_BUDGET,
      progress: { report: (): void => undefined },
      yieldToEventLoop: (): Promise<void> => {
        yields += 1;
        return Promise.resolve();
      },
    };

    await readStl(buildBinaryStl(many), context);

    expect(yields).toBeGreaterThanOrEqual(4);
  });

  it('completes normally when cancellation is never requested', async () => {
    const source = new CancellationSource();
    const context: FormatReadContext = {
      cancellation: source.token,
      budget: DEFAULT_IMPORT_BUDGET,
      yieldToEventLoop: (): Promise<void> => Promise.resolve(),
      progress: { report: (): void => undefined },
    };

    expect(triangleCount((await readStl(buildBinaryStl([UNIT_TRIANGLE]), context)).mesh)).toBe(1);
  });
});

/* ----------------------------------------------------------------- helper -- */

function asciiSolid(name: string, triangles: readonly Triangle[]): string {
  const lines = [`solid ${name}`];
  for (const triangle of triangles) {
    lines.push(`facet normal ${triangle.normal.join(' ')}`);
    lines.push('outer loop');
    for (const vertex of triangle.vertices) lines.push(`vertex ${vertex.join(' ')}`);
    lines.push('endloop');
    lines.push('endfacet');
  }
  lines.push(`endsolid ${name}`);
  return `${lines.join('\n')}\n`;
}
