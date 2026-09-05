/**
 * THE UNIT TOKENS 3MF DEFINES. A LEAF MODULE WITH NO IMPORTS.
 *
 * Separate from `threemf-reader.ts` for the same reason `export/stl-layout.ts`
 * is separate from the STL writer: the conversion policy runs on the MAIN
 * THREAD and needs this list to decide whether a unit a user chose can be
 * written. Importing it from the reader would let a bundler follow the reader's
 * own imports — the XML scanner, the ZIP reader, the whole intake path — into
 * the application bundle, for six strings.
 */

/**
 * The six values 3MF's `unit` attribute may take.
 *
 * Frozen and exhaustive. A value outside this list is not a unit CAD Fixer can
 * write, and is refused rather than substituted.
 */
export const THREE_MF_UNITS: readonly string[] = Object.freeze([
  'micron',
  'millimeter',
  'centimeter',
  'inch',
  'foot',
  'meter',
]);

/**
 * WHAT AN ABSENT `unit` ATTRIBUTE MEANS.
 *
 * The specification defaults it, so a file that omits it HAS stated
 * millimetres. Reading that is not inventing a unit — the value comes from the
 * format's own definition. An STL is the opposite case: it has no unit field at
 * all, so it states nothing, and nothing may be defaulted for it.
 */
export const THREE_MF_DEFAULT_UNIT = 'millimeter';
