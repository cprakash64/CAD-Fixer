/**
 * Length units relevant to 3D printing interchange formats.
 *
 * Unit handling is a correctness concern, not a display concern: STL carries no
 * unit at all, OBJ is unitless by convention, and 3MF records one explicitly.
 * Guessing a unit silently would violate the data integrity principle, so the
 * canonical mesh records the unit it was told and marks unknown separately.
 */
export const LengthUnit = {
  Millimeter: 'millimeter',
  Centimeter: 'centimeter',
  Meter: 'meter',
  Micron: 'micron',
  Inch: 'inch',
  Foot: 'foot',
} as const;

export type LengthUnit = (typeof LengthUnit)[keyof typeof LengthUnit];

/** Exact millimetre value of one of each unit. Inch-derived values are exact by definition. */
const MILLIMETRES_PER_UNIT: Readonly<Record<LengthUnit, number>> = {
  [LengthUnit.Micron]: 0.001,
  [LengthUnit.Millimeter]: 1,
  [LengthUnit.Centimeter]: 10,
  [LengthUnit.Meter]: 1000,
  [LengthUnit.Inch]: 25.4,
  [LengthUnit.Foot]: 304.8,
};

export function millimetresPerUnit(unit: LengthUnit): number {
  return MILLIMETRES_PER_UNIT[unit];
}

/**
 * Returns the scale factor to convert a length expressed in `from` into `to`.
 *
 * Callers must apply this deliberately. Nothing in CAD Fixer rescales a user's
 * mesh implicitly.
 */
export function unitConversionFactor(from: LengthUnit, to: LengthUnit): number {
  return MILLIMETRES_PER_UNIT[from] / MILLIMETRES_PER_UNIT[to];
}

export function isLengthUnit(value: string): value is LengthUnit {
  return Object.prototype.hasOwnProperty.call(MILLIMETRES_PER_UNIT, value);
}
