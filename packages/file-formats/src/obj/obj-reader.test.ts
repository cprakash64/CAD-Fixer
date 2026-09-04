import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError, CancellationSource } from '@cadfixer/shared';
import {
  assertGeometryDocument,
  DEFAULT_DOCUMENT_LIMITS,
  distinctMeshes,
  triangleCount,
  vertexCount,
} from '@cadfixer/mesh-core';
import type { FormatReadContext } from '../context';
import type { DocumentReadResult } from '../document-reader';
import { testReadContext } from '../test-context';
import { ImportRefusal, refusalOf } from '../import-errors';
import { UnsupportedFeature } from '../document-reader';
import { readObj } from './obj-reader';
import { DEFAULT_OBJ_LIMITS } from './limits';

/**
 * OBJ-P01 – OBJ-P18, at the parser.
 *
 * Every refusal case asserts the TYPED REASON rather than message wording:
 * prose is allowed to improve, and a test that pins it would make improving it
 * a chore. The reason is the contract.
 */

function encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 4);
  let at = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) {
      out[at++] = code;
    } else if (code < 0x800) {
      out[at++] = 0xc0 | (code >> 6);
      out[at++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[at++] = 0xe0 | (code >> 12);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
    } else {
      out[at++] = 0xf0 | (code >> 18);
      out[at++] = 0x80 | ((code >> 12) & 0x3f);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
    }
  }
  return out.subarray(0, at);
}

async function read(
  text: string,
  context: FormatReadContext = testReadContext(),
): Promise<DocumentReadResult> {
  return readObj(encode(text), context);
}

/** Asserts a refusal's category AND its typed reason. */
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

const TRIANGLE = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

/* ------------------------------------------------------- accepted files -- */

describe('OBJ-P01: a single triangle', () => {
  it('imports as a one-part document with the file’s exact coordinates', async () => {
    const result = await read(TRIANGLE);

    expect(result.document.parts).toHaveLength(1);
    const part = result.document.parts[0];
    expect(triangleCount(part?.mesh as never)).toBe(1);
    expect(vertexCount(part?.mesh as never)).toBe(3);
    expect([...(part?.mesh.positions ?? [])]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(result.encoding).toBe('text');
  });

  it('states no unit, because OBJ has none', async () => {
    // Defaulting to millimetres would invent information about the model.
    const result = await read(TRIANGLE);
    expect(result.document.unit).toBeUndefined();
    expect('unit' in result.document).toBe(false);
  });

  it('applies no placement and reports nothing unsupported', async () => {
    const result = await read(TRIANGLE);
    expect(result.document.parts[0]?.transform).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    expect(result.compatibility.unsupported).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('OBJ-P02: a cube of triangles', () => {
  it('imports twelve triangles as one part', async () => {
    const corners = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ];
    const faces = [
      [1, 2, 3],
      [1, 3, 4],
      [5, 7, 6],
      [5, 8, 7],
      [1, 5, 6],
      [1, 6, 2],
      [2, 6, 7],
      [2, 7, 3],
      [3, 7, 8],
      [3, 8, 4],
      [4, 8, 5],
      [4, 5, 1],
    ];
    const text =
      corners.map((c) => `v ${c.join(' ')}`).join('\n') +
      '\n' +
      faces.map((f) => `f ${f.join(' ')}`).join('\n') +
      '\n';

    const result = await read(text);

    expect(result.document.parts).toHaveLength(1);
    expect(triangleCount(result.document.parts[0]?.mesh as never)).toBe(12);
    expect(vertexCount(result.document.parts[0]?.mesh as never)).toBe(8);
  });
});

describe('OBJ-P03: negative indices', () => {
  it('resolves them against the vertices seen SO FAR', async () => {
    /*
     * The property that makes a second pass impossible: `-1` means a different
     * vertex on every line it appears. Two triangles from six vertices, each
     * using -3/-2/-1, must reference DIFFERENT vertices.
     */
    const text =
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n' + 'v 5 0 0\nv 6 0 0\nv 5 1 0\nf -3 -2 -1\n';

    const result = await read(text);

    expect(result.document.parts).toHaveLength(1);
    const positions = [...(result.document.parts[0]?.mesh.positions ?? [])];
    // Six distinct vertices, and the second triangle used the later three.
    expect(vertexCount(result.document.parts[0]?.mesh as never)).toBe(6);
    expect(positions).toContain(5);
    expect(positions).toContain(6);
  });

  it('mixes positive and negative indices in one face', async () => {
    const result = await read('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 -2 -1\n');
    expect(triangleCount(result.document.parts[0]?.mesh as never)).toBe(1);
  });
});

describe('OBJ-P04: multiple objects become multiple parts', () => {
  it('maps each `o` record to its own part with its own vertices', async () => {
    const text =
      'o Alpha\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' +
      'o Beta\nv 5 0 0\nv 6 0 0\nv 5 1 0\nf 4 5 6\n';

    const result = await read(text);

    expect(result.document.parts).toHaveLength(2);
    expect(result.document.parts.map((part) => part.name)).toEqual(['Alpha', 'Beta']);
    // PART-LOCAL VERTEX POOLS. OBJ shares one pool across the file; carrying
    // the whole pool into every part would make each part report the file's
    // vertex count and the file's bounding box.
    expect(vertexCount(result.document.parts[0]?.mesh as never)).toBe(3);
    expect(vertexCount(result.document.parts[1]?.mesh as never)).toBe(3);
    expect([...(result.document.parts[1]?.mesh.positions ?? [])]).toEqual([
      5, 0, 0, 6, 0, 0, 5, 1, 0,
    ]);
  });

  it('gives faces before the first `o` their own unnamed part', async () => {
    // Attaching them to the first named object would put geometry under a name
    // the file never gave it.
    const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' + 'o Named\nf 1 2 3\n';

    const result = await read(text);

    expect(result.document.parts).toHaveLength(2);
    expect(result.document.parts[0]?.name).toBeUndefined();
    expect(result.document.parts[1]?.name).toBe('Named');
  });

  it('produces no part for an `o` record that contains no faces', async () => {
    // A part with nothing in it would be selectable and have nothing to show.
    const text = 'o Empty\no Real\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

    const result = await read(text);

    expect(result.document.parts).toHaveLength(1);
    expect(result.document.parts[0]?.name).toBe('Real');
  });

  it('gives every part a unique generated id, never the file’s name', async () => {
    const result = await read('o Same\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' + 'o Same\nf 1 2 3\n');

    const ids = result.document.parts.map((part) => part.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('Same');
  });
});

describe('OBJ-P05: groups become mesh groups inside a part', () => {
  it('records each `g` run as a group range', async () => {
    const text =
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 2 0 0\n' + 'g lower\nf 1 2 3\n' + 'g upper\nf 1 2 4\n';

    const result = await read(text);

    const groups = result.document.parts[0]?.mesh.groups ?? [];
    expect(groups.map((group) => group.name)).toEqual(['lower', 'upper']);
    expect(groups[0]).toMatchObject({ indexOffset: 0, indexCount: 3 });
    expect(groups[1]).toMatchObject({ indexOffset: 3, indexCount: 3 });
  });

  it('records a `usemtl` run as a group carrying the material reference', async () => {
    const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl steel\nf 1 2 3\n';

    const result = await read(text);

    expect(result.document.parts[0]?.mesh.groups?.[0]).toMatchObject({
      materialRef: 'steel',
    });
  });
});

describe('OBJ-P06: all four face corner spellings', () => {
  it.each([
    ['v', 'f 1 2 3'],
    ['v/vt', 'f 1/1 2/2 3/3'],
    ['v//vn', 'f 1//1 2//1 3//1'],
    ['v/vt/vn', 'f 1/1/1 2/2/1 3/3/1'],
  ])('reads %s', async (_label, faceLine) => {
    const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\n' + faceLine + '\n';

    const result = await read(text);

    expect(triangleCount(result.document.parts[0]?.mesh as never)).toBe(1);
    // Normals and UVs are parsed for validity and not retained: they are not
    // authoritative and are recomputed. See ADR 0013.
    expect(result.document.parts[0]?.mesh.normals).toBeUndefined();
    expect(result.document.parts[0]?.mesh.uvs).toBeUndefined();
  });

  it('refuses a file whose normal is not finite, rather than ignoring it', async () => {
    await expectRefusal(
      () => read('v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 NaN\nf 1 2 3\n'),
      AppErrorCode.MalformedFile,
      ImportRefusal.ObjNonFinite,
    );
  });
});

/* -------------------------------------------------------------- refusals -- */

describe('OBJ-P07/P08: polygons are refused, never triangulated', () => {
  it('refuses a quad', async () => {
    await expectRefusal(
      () => read('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n'),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.ObjPolygonUnsupported,
    );
  });

  it('refuses a concave pentagon rather than fanning it', async () => {
    /*
     * THE MEASURED CASE. For the research's concave pentagon the true area by
     * shoelace is 10.00, while a naive fan produces triangles with signs + − +
     * — one of the opposite orientation, i.e. geometry OUTSIDE the polygon.
     * Fanning would invent faces the file never described.
     */
    const text = 'v 0 0 0\nv 4 0 0\nv 4 4 0\nv 2 1 0\nv 0 4 0\n' + 'f 1 2 3 4 5\n';

    await expectRefusal(
      () => read(text),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.ObjPolygonUnsupported,
    );
  });

  it('says what it will not do, and why, in the message', async () => {
    let caught: unknown;
    try {
      await read('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
    } catch (cause) {
      caught = cause;
    }
    if (!isAppError(caught)) throw new Error('expected an AppError');
    expect(caught.message).toMatch(/triangle faces/i);
    expect(caught.message).toMatch(/invent/i);
  });

  it('refuses a face with fewer than three corners', async () => {
    await expectRefusal(
      () => read('v 0 0 0\nv 1 0 0\nf 1 2\n'),
      AppErrorCode.MalformedFile,
      ImportRefusal.ObjTooFewFaceVertices,
    );
  });

  it('costs a bounded number of tokens for a hostile many-corner face', async () => {
    // Reading stops at the FIRST corner past the limit rather than collecting
    // every one of them first. Ten thousand corners stays under the line cap,
    // so this exercises the polygon refusal rather than the length one.
    const corners = Array.from({ length: 10_000 }, () => '1').join(' ');
    await expectRefusal(
      () => read(`v 0 0 0\nv 1 0 0\nv 0 1 0\nf ${corners}\n`),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.ObjPolygonUnsupported,
    );
  });

  it('refuses an absurdly long face record on LENGTH before it counts corners', async () => {
    // The cheaper ceiling fires first, which is the right order: a line that
    // cannot be read does not need its tokens counted.
    const corners = Array.from({ length: 200_000 }, () => '1').join(' ');
    await expectRefusal(
      () => read(`v 0 0 0\nv 1 0 0\nv 0 1 0\nf ${corners}\n`),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ObjLineTooLong,
    );
  });
});

describe('OBJ-P09/P10/P11: invalid indices and numbers', () => {
  it('refuses index zero, because OBJ indices start at one', async () => {
    await expectRefusal(
      () => read('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n'),
      AppErrorCode.MalformedFile,
      ImportRefusal.ObjZeroIndex,
    );
  });

  it('names a MISSING position index as its own mistake, not as index zero', async () => {
    /*
     * `f /1/1` gives a texture and a normal and no position. `Number('')` is 0,
     * so this used to be reported as "uses vertex index 0" — a description of a
     * file that says something the user's file does not say.
     */
    await expectRefusal(
      () => read('v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nf /1/1 /1/1 /1/1\n'),
      AppErrorCode.MalformedFile,
      ImportRefusal.ObjMissingPositionIndex,
    );
  });

  it('still accepts the three legal corner spellings that DO give a position', async () => {
    // v, v/vt and v//vn all begin with the position index, and the tightened
    // check must not have made any of them unreadable.
    for (const face of ['f 1 2 3', 'f 1/1 2/1 3/1', 'f 1//1 2//1 3//1', 'f 1/1/1 2/1/1 3/1/1']) {
      const result = await read(`v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\n${face}\n`);
      expect(triangleCount(result.document.parts[0]?.mesh as never)).toBe(1);
    }
  });

  it('refuses an out-of-range positive index rather than clamping it', async () => {
    await expectRefusal(
      () => read('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n'),
      AppErrorCode.MalformedFile,
      ImportRefusal.ObjBadIndex,
    );
  });

  it('refuses a negative index that underflows the vertices seen so far', async () => {
    await expectRefusal(
      () => read('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -9 -2 -1\n'),
      AppErrorCode.MalformedFile,
      ImportRefusal.ObjBadIndex,
    );
  });

  it.each(['NaN', 'Infinity', '-Infinity'])('refuses %s as a coordinate', async (token) => {
    await expectRefusal(
      () => read(`v 0 0 0\nv 1 0 0\nv ${token} 1 0\nf 1 2 3\n`),
      AppErrorCode.MalformedFile,
      ImportRefusal.ObjNonFinite,
    );
  });

  it('refuses a corrupt numeric token instead of reading its prefix', async () => {
    // `parseFloat('1abc')` is 1, which would silently accept corruption.
    await expectRefusal(
      () => read('v 0 0 0\nv 1abc 0 0\nv 0 1 0\nf 1 2 3\n'),
      AppErrorCode.MalformedFile,
      ImportRefusal.ObjNonFinite,
    );
  });

  it('refuses a missing coordinate rather than defaulting it to zero', async () => {
    await expectRefusal(
      () => read('v 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'),
      AppErrorCode.MalformedFile,
      ImportRefusal.ObjMalformedNumber,
    );
  });

  it('refuses a file with no faces at all', async () => {
    await expectRefusal(
      () => read('v 0 0 0\nv 1 0 0\nv 0 1 0\n'),
      AppErrorCode.MalformedFile,
      ImportRefusal.ObjNoGeometry,
    );
  });
});

describe('OBJ-P12: resource ceilings', () => {
  it('refuses a line longer than the cap', async () => {
    const long = `# ${'x'.repeat(DEFAULT_OBJ_LIMITS.maxLineLength + 10)}`;
    await expectRefusal(
      () => read(`${long}\n${TRIANGLE}`),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ObjLineTooLong,
    );
  });

  it('accepts a line exactly at the cap', async () => {
    // Just below and just above: the boundary itself is the thing being pinned.
    const exact = `#${'x'.repeat(DEFAULT_OBJ_LIMITS.maxLineLength - 1)}`;
    const result = await read(`${exact}\n${TRIANGLE}`);
    expect(result.document.parts).toHaveLength(1);
  });

  it('refuses a file larger than the byte ceiling before decoding it', async () => {
    await expectRefusal(
      () =>
        readObj(new Uint8Array(16), testReadContext(), {
          ...DEFAULT_OBJ_LIMITS,
          maxBytes: 8,
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.InputTooLarge,
    );
  });

  it('refuses more vertices than the ceiling allows', async () => {
    await expectRefusal(
      () =>
        readObj(encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), testReadContext(), {
          ...DEFAULT_OBJ_LIMITS,
          maxVertices: 2,
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ObjTooManyVertices,
    );
  });

  it('refuses more objects than the ceiling allows', async () => {
    await expectRefusal(
      () =>
        readObj(encode('o a\no b\no c\n' + TRIANGLE), testReadContext(), {
          ...DEFAULT_OBJ_LIMITS,
          maxObjects: 2,
        }),
      AppErrorCode.ResourceLimitExceeded,
      ImportRefusal.ObjTooManyObjects,
    );
  });
});

describe('OBJ-P13/P14: names', () => {
  it('keeps repeated object names as written, because identity is the part id', async () => {
    const result = await read('o Cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' + 'o Cube\nf 1 2 3\n');

    expect(result.document.parts.map((part) => part.name)).toEqual(['Cube', 'Cube']);
    expect(result.document.parts[0]?.id).not.toBe(result.document.parts[1]?.id);
  });

  it('carries a Unicode name through unchanged', async () => {
    const result = await read(`o Brücke — 部品\n${TRIANGLE}`);
    expect(result.document.parts[0]?.name).toBe('Brücke — 部品');
  });

  it('truncates a hostile name rather than refusing the model', async () => {
    const huge = 'A'.repeat(DEFAULT_OBJ_LIMITS.maxNameLength * 3);
    const result = await read(`o ${huge}\n${TRIANGLE}`);
    expect((result.document.parts[0]?.name ?? '').length).toBeLessThanOrEqual(
      DEFAULT_OBJ_LIMITS.maxNameLength,
    );
  });

  it('truncates to the DOCUMENT’s cap, so a long name does not make a model unopenable', async () => {
    /*
     * THE BUG THIS PINS. The reader truncated at 1,024 while
     * `DocumentLimits.maxNameLength` was 512, so a 600-character object name
     * passed the reader and was refused by `assertGeometryDocument` — the whole
     * model unimportable because of a display string, which is the opposite of
     * what "truncate rather than refuse" is for. Truncating above the ceiling
     * that will be enforced is not truncating.
     */
    expect(DEFAULT_OBJ_LIMITS.maxNameLength).toBe(DEFAULT_DOCUMENT_LIMITS.maxNameLength);

    const result = await read(`o ${'n'.repeat(600)}\n${TRIANGLE}`);
    expect(result.document.parts[0]?.name).toHaveLength(DEFAULT_DOCUMENT_LIMITS.maxNameLength);
    expect(() => {
      assertGeometryDocument(result.document, 'OBJ import');
    }).not.toThrow();
  });

  it('caps faces at the DOCUMENT’s triangle total, which is the same number', () => {
    // Every face belongs to exactly one part, so the file's face count IS the
    // document's triangle count. The reader can enforce the real ceiling
    // instead of building a model the gate will refuse.
    expect(DEFAULT_OBJ_LIMITS.maxFaces).toBe(DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles);
  });

  it('keeps markup in a name as text, never as markup', async () => {
    const result = await read(`o <img src=x onerror=alert(1)>\n${TRIANGLE}`);
    // Stored verbatim; it is React's job to render it as text, and a browser
    // test asserts it does.
    expect(result.document.parts[0]?.name).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('OBJ-P15: material libraries are never opened', () => {
  it('records `mtllib` as text and reports that it was not loaded', async () => {
    const result = await read(`mtllib https://evil.test/materials.mtl\n${TRIANGLE}`);

    expect(result.compatibility.unsupported).toContain(UnsupportedFeature.ExternalMaterialLibrary);
    expect(result.compatibility.externalReferences).toEqual(['https://evil.test/materials.mtl']);
    expect(result.warnings.map((warning) => warning.code)).toContain('OBJ_MTLLIB_NOT_LOADED');
    // The geometry still imported: an unopened material library is not a fault.
    expect(result.document.parts).toHaveLength(1);
  });

  it('reports material references with no library as unsupported material data', async () => {
    const result = await read(`usemtl steel\n${TRIANGLE}`);
    expect(result.compatibility.unsupported).toContain(UnsupportedFeature.Materials);
  });

  it('says nothing about materials for a file that has none', async () => {
    // An ordinary file must not be decorated with warnings about things it
    // never contained.
    const result = await read(TRIANGLE);
    expect(result.compatibility.unsupported).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('OBJ-P17: cancellation', () => {
  it('stops at a poll point rather than finishing the file', async () => {
    const vertices = Array.from({ length: 60_000 }, (_v, i) => `v ${String(i)} 0 0`).join('\n');
    const faces = Array.from(
      { length: 60_000 },
      (_f, i) =>
        `f ${String((i % 3) + 1)} ${String(((i + 1) % 3) + 1)} ${String(((i + 2) % 3) + 1)}`,
    ).join('\n');

    const source = new CancellationSource();
    let yields = 0;
    const context = testReadContext({
      cancellation: source.token,
      yieldToEventLoop: (): Promise<void> => {
        yields += 1;
        source.cancel();
        return Promise.resolve();
      },
    });

    let caught: unknown;
    try {
      await readObj(encode(`${vertices}\n${faces}\n`), context);
    } catch (cause) {
      caught = cause;
    }

    // CANCELLATION IS NOT A REFUSAL OF THE FILE, so it carries no import
    // reason — only the cancelled code. Rendering it as a failure would make
    // the Cancel button read as an error.
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(caught.code).toBe(AppErrorCode.OperationCancelled);
    expect(yields).toBeGreaterThan(0);
  });

  it('yields periodically so a queued cancel can be delivered at all', async () => {
    const faces = Array.from({ length: 100_000 }, () => 'f 1 2 3').join('\n');
    let yields = 0;
    const context = testReadContext({
      yieldToEventLoop: (): Promise<void> => {
        yields += 1;
        return Promise.resolve();
      },
    });

    await readObj(encode(`v 0 0 0\nv 1 0 0\nv 0 1 0\n${faces}\n`), context);

    // Without yielding, a polled flag can never change and cancellation is a
    // no-op that merely looks like one.
    expect(yields).toBeGreaterThan(0);
  });
});

describe('structural sharing and document shape', () => {
  it('gives each part its own mesh, since OBJ has no instancing', async () => {
    const result = await read('o A\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' + 'o B\nf 1 2 3\n');

    expect(distinctMeshes(result.document)).toHaveLength(2);
  });

  it('skips records it does not model rather than refusing the file', async () => {
    // OBJ is extensible; `s`, `l` and vendor records say nothing about
    // triangles, and refusing a valid model over one would help nobody.
    const result = await read(`s off\nl 1 2\nmg 0 0\n${TRIANGLE}`);
    expect(result.document.parts).toHaveLength(1);
  });

  it('handles CRLF line endings and a missing final newline', async () => {
    const result = await read('v 0 0 0\r\nv 1 0 0\r\nv 0 1 0\r\nf 1 2 3');
    expect(triangleCount(result.document.parts[0]?.mesh as never)).toBe(1);
  });
});
