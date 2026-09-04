import { afterEach, describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import { MeshFormatId } from './formats';
import { registerBuiltInFormats } from './register';
import {
  canRead,
  canWrite,
  clearRegistryForTesting,
  requireReader,
  requireWriter,
} from './registry';

afterEach(() => {
  clearRegistryForTesting();
});

/**
 * The registry is the single place that answers "which formats does this build
 * actually support?". These tests guard the honesty of that answer in both
 * directions: STL must really be there, and the formats that are not
 * implemented must fail loudly rather than return a stub that makes the
 * application look more capable than it is.
 */
describe('before registration', () => {
  it('reports no formats at all', () => {
    for (const formatId of Object.values(MeshFormatId)) {
      expect(canRead(formatId)).toBe(false);
      expect(canWrite(formatId)).toBe(false);
    }
  });
});

describe('after registering the built-in formats', () => {
  it('reports STL as readable and writable', () => {
    registerBuiltInFormats();

    expect(canRead(MeshFormatId.Stl)).toBe(true);
    expect(canWrite(MeshFormatId.Stl)).toBe(true);
  });

  it('offers both STL encodings, binary first', () => {
    registerBuiltInFormats();

    expect(requireWriter(MeshFormatId.Stl).encodings).toEqual(['binary', 'ascii']);
  });

  it.each([MeshFormatId.Obj, MeshFormatId.ThreeMf])(
    'reads %s and does not claim to write it',
    (formatId) => {
      // Stage 4A-2B1 added import. Export is 4A-2B2, and until then a writer
      // lookup must fail rather than return something that pretends to work.
      registerBuiltInFormats();

      expect(canRead(formatId)).toBe(true);
      expect(canWrite(formatId)).toBe(false);
    },
  );

  it.each([MeshFormatId.Obj, MeshFormatId.ThreeMf])(
    'fails loudly rather than returning a stub writer for %s',
    (formatId) => {
      registerBuiltInFormats();

      try {
        requireWriter(formatId);
        expect.unreachable('requireWriter should have thrown');
      } catch (caught) {
        expect(isAppError(caught)).toBe(true);
        if (!isAppError(caught)) return;
        expect(caught.code).toBe(AppErrorCode.UnsupportedFile);
        expect(caught.message).toContain('not implemented');
      }
    },
  );

  it.each([MeshFormatId.Obj, MeshFormatId.ThreeMf])(
    'returns a real reader for %s, bound to that format',
    (formatId) => {
      registerBuiltInFormats();

      expect(requireReader(formatId).formatId).toBe(formatId);
    },
  );

  it('is idempotent', () => {
    registerBuiltInFormats();
    registerBuiltInFormats();

    expect(canRead(MeshFormatId.Stl)).toBe(true);
  });
});
