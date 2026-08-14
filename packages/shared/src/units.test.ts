import { describe, expect, it } from 'vitest';
import { isLengthUnit, LengthUnit, millimetresPerUnit, unitConversionFactor } from './units';

/**
 * Unit handling is a correctness concern for a printing tool: a model scaled by
 * 25.4 in the wrong direction is a ruined print, not a cosmetic bug.
 */
describe('millimetresPerUnit', () => {
  it.each([
    [LengthUnit.Micron, 0.001],
    [LengthUnit.Millimeter, 1],
    [LengthUnit.Centimeter, 10],
    [LengthUnit.Meter, 1000],
    [LengthUnit.Inch, 25.4],
    [LengthUnit.Foot, 304.8],
  ])('reports %s as %d mm', (unit, expected) => {
    expect(millimetresPerUnit(unit)).toBeCloseTo(expected, 10);
  });
});

describe('unitConversionFactor', () => {
  it('is 1 when the units match', () => {
    for (const unit of Object.values(LengthUnit)) {
      expect(unitConversionFactor(unit, unit)).toBe(1);
    }
  });

  it('converts inches to millimetres', () => {
    expect(unitConversionFactor(LengthUnit.Inch, LengthUnit.Millimeter)).toBeCloseTo(25.4, 10);
  });

  it('converts millimetres to inches', () => {
    expect(unitConversionFactor(LengthUnit.Millimeter, LengthUnit.Inch)).toBeCloseTo(1 / 25.4, 10);
  });

  it('is the reciprocal in the opposite direction', () => {
    const forward = unitConversionFactor(LengthUnit.Meter, LengthUnit.Inch);
    const backward = unitConversionFactor(LengthUnit.Inch, LengthUnit.Meter);

    expect(forward * backward).toBeCloseTo(1, 10);
  });

  it('composes across an intermediate unit', () => {
    const direct = unitConversionFactor(LengthUnit.Foot, LengthUnit.Millimeter);
    const viaInch =
      unitConversionFactor(LengthUnit.Foot, LengthUnit.Inch) *
      unitConversionFactor(LengthUnit.Inch, LengthUnit.Millimeter);

    expect(viaInch).toBeCloseTo(direct, 10);
  });
});

describe('isLengthUnit', () => {
  it('accepts every declared unit', () => {
    for (const unit of Object.values(LengthUnit)) {
      expect(isLengthUnit(unit)).toBe(true);
    }
  });

  it.each(['', 'inches', 'MM', 'furlong', 'toString', 'constructor'])('rejects %s', (candidate) => {
    // `toString` and `constructor` are included deliberately: a naive
    // implementation using `in` or a plain property read would accept
    // inherited members from Object.prototype.
    expect(isLengthUnit(candidate)).toBe(false);
  });
});
