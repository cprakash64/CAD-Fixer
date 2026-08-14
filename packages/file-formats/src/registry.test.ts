import { afterEach, describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import { MeshFormatId, SUPPORTED_FORMATS } from './formats';
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
 * This suite is a guard against the most likely way Stage 0 could be
 * misrepresented: a stub codec landing in the registry and making the
 * application appear to import models when it cannot.
 */
describe('format registry in Stage 0', () => {
  it.each(SUPPORTED_FORMATS.map((format) => format.id))(
    'has no reader registered for %s',
    (formatId) => {
      expect(canRead(formatId)).toBe(false);
    },
  );

  it.each(SUPPORTED_FORMATS.map((format) => format.id))(
    'has no writer registered for %s',
    (formatId) => {
      expect(canWrite(formatId)).toBe(false);
    },
  );

  it('fails loudly rather than returning a stub reader', () => {
    try {
      requireReader(MeshFormatId.Stl);
      expect.unreachable('requireReader should have thrown');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.UnsupportedFile);
      expect(caught.message).toContain('not implemented');
    }
  });

  it('fails loudly rather than returning a stub writer', () => {
    try {
      requireWriter(MeshFormatId.ThreeMf);
      expect.unreachable('requireWriter should have thrown');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.UnsupportedFile);
    }
  });
});
