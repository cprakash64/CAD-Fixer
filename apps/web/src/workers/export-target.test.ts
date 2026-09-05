import { describe, expect, it } from 'vitest';
import { MeshFormatId } from '@cadfixer/file-formats';
import { EXPORT_TARGETS, resolveExportTarget } from './export-protocol';

/**
 * THE BOUNDARY AN UNTRUSTED TARGET STRING ARRIVES THROUGH.
 *
 * `exportDocument` takes a `MeshFormatId`, and every member of that enum now
 * has a writer — so the type system proves there is no unwritable target left
 * inside the engine. That makes THIS the only place an unknown target can be
 * caught: a string on a message, mapped onto the enum.
 *
 * The tests below are the ones that were removed from `obj-writer.test.ts` when
 * STL became a document target, in the place the check actually lives now.
 */
describe('the export target table', () => {
  it('maps exactly the three formats CAD Fixer can write', () => {
    expect(Object.keys(EXPORT_TARGETS).sort()).toEqual(['3mf', 'obj', 'stl']);
    expect(resolveExportTarget('stl')).toBe(MeshFormatId.Stl);
    expect(resolveExportTarget('obj')).toBe(MeshFormatId.Obj);
    expect(resolveExportTarget('3mf')).toBe(MeshFormatId.ThreeMf);
  });

  it('refuses a target it does not recognise rather than defaulting', () => {
    /*
     * `undefined`, NOT A FALLBACK. Defaulting an unrecognised target to STL
     * would hand the user a file in a format they did not ask for and call it a
     * success — the silent-substitution failure this project forbids.
     */
    expect(resolveExportTarget('step')).toBeUndefined();
    expect(resolveExportTarget('STL')).toBeUndefined();
    expect(resolveExportTarget('')).toBeUndefined();
  });

  it('is not fooled by inherited object properties', () => {
    /*
     * A PROTOTYPE LOOKUP IS AN UNTRUSTED-INPUT BUG. A plain `TARGETS[target]`
     * resolves `constructor`, `toString` and `__proto__` to values that are not
     * formats, so a message carrying one of those names would reach the engine
     * with something that is not a `MeshFormatId`. `hasOwnProperty` is what
     * makes the table a whitelist rather than a prototype walk.
     */
    expect(resolveExportTarget('constructor')).toBeUndefined();
    expect(resolveExportTarget('toString')).toBeUndefined();
    expect(resolveExportTarget('__proto__')).toBeUndefined();
  });
});
