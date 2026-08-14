import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_BUDGET } from '../budget';
import {
  binaryStlByteLength,
  detectStlEncoding,
  MAX_TRAILING_BYTES,
  StlDetectionFailure,
  StlEncoding,
} from './detect';
import { asciiToBytes, buildAsciiStl, buildBinaryStl, UNIT_TRIANGLE } from './fixtures';

describe('binaryStlByteLength', () => {
  it('is exact for the largest possible uint32 facet count', () => {
    // 84 + (2^32 - 1) * 50 is about 2.1e11, four orders of magnitude below the
    // 2^53 limit where doubles stop representing integers exactly. This is the
    // property that makes the truncation comparison sound against a hostile
    // facet count, so it is asserted rather than assumed.
    const maxUint32 = 4_294_967_295;
    const length = binaryStlByteLength(maxUint32);

    expect(length).toBe(214_748_364_834);
    expect(Number.isSafeInteger(length)).toBe(true);
  });

  it('never wraps around for any power-of-two count', () => {
    for (let power = 0; power <= 32; power += 1) {
      const count = 2 ** power;
      expect(binaryStlByteLength(count)).toBeGreaterThan(count);
    }
  });
});

describe('binary detection', () => {
  it('accepts a file whose declared body exactly fills it', () => {
    const detection = detectStlEncoding(buildBinaryStl([UNIT_TRIANGLE, UNIT_TRIANGLE]));

    expect(detection).toEqual({ encoding: StlEncoding.Binary, triangleCount: 2, trailingBytes: 0 });
  });

  it('does not rely on the header, even when the header says "solid"', () => {
    // The single most common detection bug: a binary STL whose 80-byte header
    // begins with the word "solid" is still binary.
    const bytes = buildBinaryStl([UNIT_TRIANGLE], {
      header: 'solid this is a binary file with a misleading header',
    });

    const detection = detectStlEncoding(bytes);

    expect(detection.encoding).toBe(StlEncoding.Binary);
  });

  it('accepts a small trailer and reports it', () => {
    const detection = detectStlEncoding(buildBinaryStl([UNIT_TRIANGLE], { trailingBytes: 16 }));

    expect(detection).toEqual({
      encoding: StlEncoding.Binary,
      triangleCount: 1,
      trailingBytes: 16,
    });
  });

  it('refuses a trailer larger than the allowance', () => {
    // Without a bound, any large file whose bytes 80-83 happen to be small
    // would be "detected" as a binary STL with a handful of triangles.
    const detection = detectStlEncoding(
      buildBinaryStl([UNIT_TRIANGLE], { trailingBytes: MAX_TRAILING_BYTES + 1 }),
    );

    expect(detection.encoding).toBeUndefined();
  });

  it('reports truncation when the declared body runs past the end', () => {
    const bytes = buildBinaryStl([UNIT_TRIANGLE], { declaredCount: 100 });

    const detection = detectStlEncoding(bytes);

    expect(detection).toMatchObject({
      encoding: undefined,
      failure: StlDetectionFailure.BinaryTruncated,
      declaredTriangles: 100,
      requiredBytes: binaryStlByteLength(100),
    });
  });

  it('treats an implausible facet count as unrecognised rather than truncated', () => {
    // 0xFFFFFFFF is not a truncated STL, it is not an STL. Reporting "this file
    // declares 4.29 billion triangles" would be technically true and useless.
    const bytes = buildBinaryStl([UNIT_TRIANGLE], { declaredCount: 0xffffffff });

    expect(detectStlEncoding(bytes)).toMatchObject({
      encoding: undefined,
      failure: StlDetectionFailure.Unrecognized,
    });
  });

  it('accepts a declared count of zero as binary', () => {
    const detection = detectStlEncoding(buildBinaryStl([]));

    // Detection's job is the encoding; the reader rejects it for having no
    // triangles, with a message that says so.
    expect(detection).toEqual({ encoding: StlEncoding.Binary, triangleCount: 0, trailingBytes: 0 });
  });
});

describe('ascii detection', () => {
  it('accepts a well-formed ASCII STL', () => {
    expect(detectStlEncoding(buildAsciiStl([UNIT_TRIANGLE])).encoding).toBe(StlEncoding.Ascii);
  });

  it('accepts CRLF line endings', () => {
    const bytes = buildAsciiStl([UNIT_TRIANGLE], { lineEnding: '\r\n' });
    expect(detectStlEncoding(bytes).encoding).toBe(StlEncoding.Ascii);
  });

  it('accepts an empty solid', () => {
    const bytes = asciiToBytes('solid empty\nendsolid empty\n');
    expect(detectStlEncoding(bytes).encoding).toBe(StlEncoding.Ascii);
  });

  it('is case-insensitive about keywords', () => {
    const bytes = asciiToBytes(
      'SOLID x\nFACET NORMAL 0 0 1\nOUTER LOOP\nVERTEX 0 0 0\nVERTEX 1 0 0\nVERTEX 0 1 0\nENDLOOP\nENDFACET\nENDSOLID x\n',
    );
    expect(detectStlEncoding(bytes).encoding).toBe(StlEncoding.Ascii);
  });

  it('rejects arbitrary text that merely contains STL words', () => {
    // The grammar check exists precisely so this does not get routed to the
    // ASCII parser and produce a confusing mid-file error.
    const bytes = asciiToBytes(
      'solid state physics\nthe vertex of a parabola is a facet of its normal form\n',
    );

    expect(detectStlEncoding(bytes).encoding).toBeUndefined();
  });

  it('rejects a file that starts with "solid" but has no facet structure', () => {
    expect(detectStlEncoding(asciiToBytes('solid\n'.padEnd(200, 'x'))).encoding).toBeUndefined();
  });
});

describe('indeterminate inputs', () => {
  it('reports an empty file', () => {
    expect(detectStlEncoding(new Uint8Array(0))).toMatchObject({
      failure: StlDetectionFailure.Empty,
    });
  });

  it.each([1, 2, 79, 80, 83])('reports a %d-byte file as too short', (size) => {
    expect(detectStlEncoding(new Uint8Array(size))).toMatchObject({
      failure: StlDetectionFailure.TooShort,
      actualBytes: size,
    });
  });

  it('treats exactly 84 zero bytes as an empty binary STL', () => {
    // 84 bytes with a zero count is a structurally valid, empty binary STL.
    expect(detectStlEncoding(new Uint8Array(84))).toEqual({
      encoding: StlEncoding.Binary,
      triangleCount: 0,
      trailingBytes: 0,
    });
  });

  it('rejects random binary noise', () => {
    const bytes = new Uint8Array(5000);
    for (let index = 0; index < bytes.length; index += 1) {
      // Deterministic pseudo-noise; no randomness, so failures reproduce.
      bytes[index] = (index * 37 + 11) & 0xff;
    }

    expect(detectStlEncoding(bytes).encoding).toBeUndefined();
  });

  it('honours a caller-supplied budget when judging plausibility', () => {
    const bytes = buildBinaryStl([UNIT_TRIANGLE], { declaredCount: 5000 });
    const tightBudget = { ...DEFAULT_IMPORT_BUDGET, maxTriangles: 10 };

    expect(detectStlEncoding(bytes, tightBudget)).toMatchObject({
      failure: StlDetectionFailure.Unrecognized,
    });
    expect(detectStlEncoding(bytes)).toMatchObject({
      failure: StlDetectionFailure.BinaryTruncated,
    });
  });
});
