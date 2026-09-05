/**
 * THE NUMERIC CONTRACT FOR TEXT FORMATS, in one place.
 *
 * OBJ and 3MF both write numbers as decimal text, and both have to be able to
 * read them back as the same number. Two different kinds of number need two
 * different answers:
 *
 *   - MESH COORDINATES are Float32 and must return bit-identical. Stage 4A
 *     measured this across 200,019 finite Float32 values: `toFixed(6)` failed
 *     to round-trip 101,435 of them — 50.7% — and `toPrecision(8)` failed
 *     3,021. Nine significant digits failed exactly one, negative zero, which
 *     is handled explicitly below.
 *
 *   - TRANSFORMS are Float64, read from text and written back to text.
 *     Narrowing them on the way through would add an error the source never
 *     had, so they get the shortest exactly-reparsable form the engine emits,
 *     which is what `String(value)` already is.
 *
 * `toFixed(6)` is named here because it is the obvious choice and it is the
 * mistake this contract most exists to prevent. See ADR 0013.
 */

/**
 * A Float32 as decimal text that parses back to the same bits.
 *
 * NEGATIVE ZERO IS WRITTEN OUT. `(-0).toPrecision(9)` is `"0.00000000"`, which
 * returns `+0` — and `-0` is observable through `Object.is` and through
 * division, so losing it is a real change to the user's data rather than a
 * formatting detail.
 */
export function writeFloat32Text(value: number): string {
  if (Object.is(value, -0)) return '-0';
  return Number(value.toPrecision(9)).toString();
}

/** A Float64 as decimal text that parses back to the same bits. */
export function writeFloat64Text(value: number): string {
  if (Object.is(value, -0)) return '-0';
  return String(value);
}
