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
    'still reports %s as unsupported, because no codec exists',
    (formatId) => {
      registerBuiltInFormats();

      expect(canRead(formatId)).toBe(false);
      expect(canWrite(formatId)).toBe(false);
    },
  );

  it.each([MeshFormatId.Obj, MeshFormatId.ThreeMf])(
    'fails loudly rather than returning a stub reader for %s',
    (formatId) => {
      registerBuiltInFormats();

      try {
        requireReader(formatId);
        expect.unreachable('requireReader should have thrown');
      } catch (caught) {
        expect(isAppError(caught)).toBe(true);
        if (!isAppError(caught)) return;
        expect(caught.code).toBe(AppErrorCode.UnsupportedFile);
        expect(caught.message).toContain('not implemented');
      }
    },
  );

  it('is idempotent', () => {
    registerBuiltInFormats();
    registerBuiltInFormats();

    expect(canRead(MeshFormatId.Stl)).toBe(true);
  });
});
