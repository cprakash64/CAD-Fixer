import { describe, expect, it } from 'vitest';
import {
  describeEncoding,
  describeImport,
  describeSourceFormat,
  describeUnit,
  type ModelSource,
} from './model';

function source(overrides: Partial<ModelSource> = {}): ModelSource {
  return {
    fileName: 'part.stl',
    fileBytes: 1024,
    formatId: 'stl',
    encoding: 'binary',
    unit: undefined,
    importedAt: 0,
    ...overrides,
  };
}

describe('describeSourceFormat', () => {
  it('names each format CAD Fixer can read', () => {
    expect(describeSourceFormat(source({ formatId: 'stl' }))).toBe('STL');
    expect(describeSourceFormat(source({ formatId: 'obj' }))).toBe('OBJ');
    expect(describeSourceFormat(source({ formatId: '3mf' }))).toBe('3MF');
  });

  it('reports what was IDENTIFIED, never what the name suggested', () => {
    // A `.stl` that actually holds an OBJ is refused on the mismatch, but if a
    // future rule ever admits one, the panel must not repeat the lie.
    expect(describeSourceFormat(source({ fileName: 'part.stl', formatId: 'obj' }))).toBe('OBJ');
  });

  it('shows an unrecognised identifier verbatim rather than guessing', () => {
    // The worker producing a format this build does not know is a bug. Showing
    // it as-is makes the bug visible; falling back to "STL" would hide it.
    expect(describeSourceFormat(source({ formatId: 'step' }))).toBe('step');
  });
});

describe('describeEncoding', () => {
  it("keeps STL's two encodings in the reader's own words", () => {
    expect(describeEncoding(source({ encoding: 'binary' }))).toBe('binary');
    expect(describeEncoding(source({ encoding: 'ascii' }))).toBe('ascii');
  });

  it('states the other encodings plainly instead of echoing an internal tag', () => {
    // "3mf" under a heading that already says 3MF tells the reader nothing.
    expect(describeEncoding(source({ formatId: '3mf', encoding: '3mf' }))).toBe(
      'Compressed package',
    );
    expect(describeEncoding(source({ formatId: 'obj', encoding: 'text' }))).toBe('Text');
  });
});

describe('describeUnit', () => {
  it('carries a stated unit through unchanged', () => {
    expect(describeUnit(source({ formatId: '3mf', unit: 'inch' }))).toBe('inch');
  });

  it('says WHY an STL has no unit, and never invents one', () => {
    expect(describeUnit(source({ formatId: 'stl', unit: undefined }))).toBe('Unspecified by STL');
  });

  it('does not blame STL for an OBJ that stated no unit', () => {
    expect(describeUnit(source({ formatId: 'obj', unit: undefined }))).toBe('Unspecified');
  });
});

describe('describeImport', () => {
  it("names STL's encoding, because binary and ASCII are different files", () => {
    expect(describeImport(source({ formatId: 'stl', encoding: 'binary' }), 64, 1)).toBe(
      '64 triangles (binary STL).',
    );
    expect(describeImport(source({ formatId: 'stl', encoding: 'ascii' }), 2, 1)).toBe(
      '2 triangles (ascii STL).',
    );
  });

  it('never calls another format an STL', () => {
    // The regression this exists for: the line read "(3mf STL)" for every 3MF
    // for as long as STL was the only readable format.
    const summary = describeImport(source({ formatId: '3mf', encoding: '3mf' }), 4, 1);
    expect(summary).toBe('4 triangles (3MF).');
    expect(summary).not.toMatch(/STL/);
  });

  it('states the part count only when there is more than one part', () => {
    expect(describeImport(source({ formatId: 'obj', encoding: 'text' }), 12, 3)).toBe(
      '3 parts, 12 triangles (OBJ).',
    );
    expect(describeImport(source({ formatId: 'obj', encoding: 'text' }), 4, 1)).toBe(
      '4 triangles (OBJ).',
    );
  });
});
