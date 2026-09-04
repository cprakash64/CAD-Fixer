import { afterEach, describe, expect, it } from 'vitest';
import {
  IMPLEMENTED_FORMATS,
  isFormatImplemented,
  isFormatWritable,
  WRITABLE_FORMATS,
} from './capabilities';
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
    /*
     * READING AND WRITING ARE DECLARED SEPARATELY as of Stage 4A-2B1, and this
     * is the assertion that keeps them honest. OBJ and 3MF can be read and
     * cannot be written; a single list would make the interface offer a Save As
     * for a format that has no writer.
     */
    registerBuiltInFormats();

    const actuallyWritable = Object.values(MeshFormatId).filter((formatId) => canWrite(formatId));

    expect([...WRITABLE_FORMATS].sort()).toEqual(actuallyWritable.sort());
  });

  it.each([MeshFormatId.Stl, MeshFormatId.Obj, MeshFormatId.ThreeMf])(
    'reports %s as readable',
    (formatId) => {
      expect(isFormatImplemented(formatId)).toBe(true);
    },
  );

  it('reports STL as the only writable format', () => {
    // Export for OBJ and 3MF is Stage 4A-2B2. Until it exists the interface
    // must not suggest otherwise.
    expect(isFormatWritable(MeshFormatId.Stl)).toBe(true);
    expect(isFormatWritable(MeshFormatId.Obj)).toBe(false);
    expect(isFormatWritable(MeshFormatId.ThreeMf)).toBe(false);
  });

  it('is answerable without registering anything, because the UI thread never does', () => {
    // No `registerBuiltInFormats()` call here on purpose: this mirrors the main
    // thread, where the registry is empty and the answer must still be correct.
    expect(canRead(MeshFormatId.Stl)).toBe(false);
    expect(isFormatImplemented(MeshFormatId.Stl)).toBe(true);
  });
});
