import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_INTAKE_BYTES,
  extractExtension,
  FileRejectionReason,
  screenFile,
} from './screening';

/**
 * These tests cover UI-BOUNDARY FILENAME SCREENING ONLY.
 *
 * Nothing here asserts anything about file contents, and passing screening
 * confers no trust: a `.stl` extension is an unverified claim. Parser hardening
 * — magic bytes, declared counts against real buffer length, bounded
 * allocation — is a separate concern with its own tests, written when parsers
 * exist.
 */

describe('extractExtension', () => {
  it('lower-cases the extension', () => {
    expect(extractExtension('Bracket.STL')).toBe('.stl');
  });

  it('takes only the final extension', () => {
    expect(extractExtension('archive.stl.zip')).toBe('.zip');
  });

  it('strips directory components from dropped paths', () => {
    expect(extractExtension('models/parts/gear.obj')).toBe('.obj');
    expect(extractExtension('C:\\models\\gear.3mf')).toBe('.3mf');
  });

  it('returns undefined when there is no extension', () => {
    expect(extractExtension('README')).toBeUndefined();
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(extractExtension('.stl')).toBeUndefined();
  });

  it('returns undefined for a trailing dot', () => {
    expect(extractExtension('model.')).toBeUndefined();
  });
});

describe('screenFile', () => {
  it.each(['part.stl', 'part.STL', 'part.obj', 'part.3mf'])('accepts %s', (name) => {
    const result = screenFile({ name, size: 2048 });
    expect(result.accepted).toBe(true);
  });

  it('reports the claimed format without asserting the contents match it', () => {
    const result = screenFile({ name: 'gear.3mf', size: 2048 });

    expect(result).toEqual({ accepted: true, claimedFormat: '3mf', extension: '.3mf' });
  });

  it.each(['drawing.zip', 'sliced.gcode', 'notes.txt', 'model.step', 'photo.png'])(
    'rejects unsupported extension %s',
    (name) => {
      const result = screenFile({ name, size: 2048 });

      expect(result.accepted).toBe(false);
      if (result.accepted) return;
      expect(result.reason).toBe(FileRejectionReason.UnsupportedExtension);
    },
  );

  it('rejects a file with no extension', () => {
    const result = screenFile({ name: 'model', size: 2048 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe(FileRejectionReason.MissingExtension);
  });

  it('rejects an empty file before anything tries to parse it', () => {
    const result = screenFile({ name: 'empty.stl', size: 0 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe(FileRejectionReason.Empty);
  });

  it('rejects a file above the intake limit', () => {
    const result = screenFile({ name: 'huge.stl', size: DEFAULT_MAX_INTAKE_BYTES + 1 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe(FileRejectionReason.TooLarge);
  });

  it('accepts a file exactly at the limit', () => {
    expect(screenFile({ name: 'edge.stl', size: DEFAULT_MAX_INTAKE_BYTES }).accepted).toBe(true);
  });

  it('honours a caller-supplied limit', () => {
    const result = screenFile({ name: 'small.stl', size: 4096 }, { maxBytes: 1024 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe(FileRejectionReason.TooLarge);
  });

  it('checks the extension before the size, so the clearer message wins', () => {
    const result = screenFile({ name: 'huge.zip', size: DEFAULT_MAX_INTAKE_BYTES * 4 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe(FileRejectionReason.UnsupportedExtension);
  });

  it('never includes file contents in a rejection message', () => {
    const result = screenFile({ name: 'secret-design-v3.zip', size: 10 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.message).not.toContain('secret-design-v3');
  });
});
