import { afterEach, describe, expect, it } from 'vitest';
import { IMPLEMENTED_FORMATS, isFormatImplemented } from './capabilities';
import { MeshFormatId } from './formats';
import { registerBuiltInFormats } from './register';
import { canRead, canWrite, clearRegistryForTesting } from './registry';

afterEach(() => {
  clearRegistryForTesting();
});

/**
 * The capability declaration is what the user interface believes. If it ever
 * disagrees with what is actually registered, the application either offers a
 * format it cannot open or hides one it can — both of which are the kind of
 * dishonesty this project's rules exist to prevent.
 */
describe('declared capabilities match the real registry', () => {
  it('declares exactly the formats that register a reader', () => {
    registerBuiltInFormats();

    const actuallyReadable = Object.values(MeshFormatId).filter((formatId) => canRead(formatId));

    expect([...IMPLEMENTED_FORMATS].sort()).toEqual(actuallyReadable.sort());
  });

  it('declares exactly the formats that register a writer', () => {
    registerBuiltInFormats();

    const actuallyWritable = Object.values(MeshFormatId).filter((formatId) => canWrite(formatId));

    expect([...IMPLEMENTED_FORMATS].sort()).toEqual(actuallyWritable.sort());
  });

  it('reports STL as implemented', () => {
    expect(isFormatImplemented(MeshFormatId.Stl)).toBe(true);
  });

  it.each([MeshFormatId.Obj, MeshFormatId.ThreeMf])('reports %s as unimplemented', (formatId) => {
    expect(isFormatImplemented(formatId)).toBe(false);
  });

  it('is answerable without registering anything, because the UI thread never does', () => {
    // No `registerBuiltInFormats()` call here on purpose: this mirrors the main
    // thread, where the registry is empty and the answer must still be correct.
    expect(canRead(MeshFormatId.Stl)).toBe(false);
    expect(isFormatImplemented(MeshFormatId.Stl)).toBe(true);
  });
});
