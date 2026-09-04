import { describe, expect, it } from 'vitest';
import { describeMalformedGeometry } from './self-intersection-validation';

/**
 * THE MALFORMED-REQUEST MATRIX.
 *
 * Each case is constructed deliberately at the runtime boundary, because
 * TypeScript cannot produce most of them — and a message arriving on a port is
 * a runtime value whatever its declared type says. Everything downstream indexes
 * raw WebAssembly memory, so the failure mode being prevented is an
 * out-of-bounds read, not a wrong number.
 */

const wellFormed = {
  kind: 'geometry' as const,
  operationId: 'op-1',
  documentId: 'model-1',
  partId: 'part-1',
  documentRevision: 1,
  positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  triangles: Uint32Array.from([0, 1, 2]),
  limits: { maxCandidatePairs: 10, maxTestedPairs: 10, maxSamples: 4 },
};

describe('a well-formed request is accepted', () => {
  it('returns no reason', () => {
    expect(describeMalformedGeometry(wellFormed)).toBeUndefined();
  });

  it('accepts an empty mesh, which is legal and trivially checked', () => {
    expect(
      describeMalformedGeometry({
        ...wellFormed,
        positions: new Float64Array(0),
        triangles: new Uint32Array(0),
      }),
    ).toBeUndefined();
  });
});

describe('malformed requests are refused with a reason', () => {
  const cases: readonly (readonly [string, unknown, RegExp])[] = [
    ['null payload', null, /not an object/],
    ['a string instead of a message', 'geometry', /not an object/],
    ['missing operationId', { ...wellFormed, operationId: 42 }, /operationId/],
    ['missing documentId', { ...wellFormed, documentId: undefined }, /documentId/],
    ['fractional revision', { ...wellFormed, documentRevision: 1.5 }, /documentRevision/],
    [
      'wrong typed-array kind for positions',
      { ...wellFormed, positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
      /Float64Array/,
    ],
    [
      'wrong typed-array kind for triangles',
      { ...wellFormed, triangles: Int32Array.from([0, 1, 2]) },
      /Uint32Array/,
    ],
    [
      'a plain array instead of a typed array',
      { ...wellFormed, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
      /Float64Array/,
    ],
    [
      'position length not divisible by 3',
      { ...wellFormed, positions: Float64Array.from([0, 0, 0, 1]) },
      /multiple of 3/,
    ],
    [
      'index length not divisible by 3',
      { ...wellFormed, triangles: Uint32Array.from([0, 1]) },
      /multiple of 3/,
    ],
    [
      'an index past the end of the vertices',
      { ...wellFormed, triangles: Uint32Array.from([0, 1, 99]) },
      /addresses no vertex/,
    ],
    [
      'too few vertices for a face',
      {
        ...wellFormed,
        positions: Float64Array.from([0, 0, 0]),
        triangles: Uint32Array.from([0, 0, 0]),
      },
      /at least three vertices/,
    ],
    [
      'a non-finite coordinate',
      { ...wellFormed, positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, Number.NaN, 0]) },
      /finite/,
    ],
    [
      'an infinite coordinate',
      {
        ...wellFormed,
        positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, Number.POSITIVE_INFINITY, 0]),
      },
      /finite/,
    ],
    ['missing limits', { ...wellFormed, limits: null }, /limits/],
    [
      'a negative cap',
      { ...wellFormed, limits: { ...wellFormed.limits, maxTestedPairs: -1 } },
      /maxTestedPairs/,
    ],
    [
      'a NaN cap',
      { ...wellFormed, limits: { ...wellFormed.limits, maxSamples: Number.NaN } },
      /maxSamples/,
    ],
    [
      'a non-numeric cap',
      { ...wellFormed, limits: { ...wellFormed.limits, maxCandidatePairs: '10' } },
      /maxCandidatePairs/,
    ],
  ];

  for (const [name, payload, expected] of cases) {
    it(`refuses ${name}`, () => {
      const reason = describeMalformedGeometry(payload);
      expect(reason, `${name} must be refused`).toBeDefined();
      expect(reason ?? '').toMatch(expected);
    });
  }
});
