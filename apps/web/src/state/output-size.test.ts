import { describe, expect, it } from 'vitest';
import { ExportFormat } from '@cadfixer/file-formats';
import type { DocumentHandle } from '@cadfixer/geometry-runtime';
import { LengthUnit } from '@cadfixer/shared';
import { OutputSizeKind } from './conversion-presentation';
import type { LoadedModel } from './model';
import { measurementUnitKey, outputSize } from './output-size';
import type { MeasuredExport } from './workspace-store';

/**
 * UI-03: what the Convert workspace may say about an output's size.
 *
 * The rule under test is that every number has something behind it — an exact
 * format rule or a real export of this very revision — and that everything else
 * is reported as unknown rather than estimated.
 */

const HANDLE = { documentId: 'doc-1', revision: 3 } as DocumentHandle;

function model(triangleCount: number, unit?: string): LoadedModel {
  return {
    handle: HANDLE,
    triangleCount,
    source: { unit },
  } as unknown as LoadedModel;
}

function measured(
  target: string,
  byteLength: number,
  overrides: Partial<MeasuredExport> = {},
): MeasuredExport {
  return {
    documentId: HANDLE.documentId,
    revision: HANDLE.revision,
    target,
    unitAssertion: undefined,
    byteLength,
    ...overrides,
  };
}

describe('binary STL is exact', () => {
  it('is 84 bytes plus 50 per triangle, before anything is written', () => {
    expect(outputSize(model(0), ExportFormat.Stl, undefined, [])).toEqual({
      kind: OutputSizeKind.Exact,
      bytes: 84,
    });
    expect(outputSize(model(25_600), ExportFormat.Stl, undefined, [])).toEqual({
      kind: OutputSizeKind.Exact,
      bytes: 84 + 50 * 25_600,
    });
  });

  it('ignores a measurement, because the rule is already exact', () => {
    const size = outputSize(model(4), ExportFormat.Stl, undefined, [measured('stl', 1)]);
    expect(size).toEqual({ kind: OutputSizeKind.Exact, bytes: 284 });
  });
});

describe('OBJ and 3MF are measured or unknown', () => {
  it('is unknown before any export', () => {
    expect(outputSize(model(4), ExportFormat.Obj, undefined, [])).toEqual({
      kind: OutputSizeKind.Unknown,
    });
    expect(outputSize(model(4), ExportFormat.ThreeMf, undefined, [])).toEqual({
      kind: OutputSizeKind.Unknown,
    });
  });

  it('uses a measurement of exactly this revision and target', () => {
    expect(outputSize(model(4), ExportFormat.Obj, undefined, [measured('obj', 900)])).toEqual({
      kind: OutputSizeKind.Measured,
      bytes: 900,
    });
  });

  it('refuses a measurement from another revision, document or target', () => {
    const entries = [
      measured('obj', 900, { revision: 2 }),
      measured('obj', 900, { documentId: 'doc-0' }),
      measured('3mf', 900),
    ];
    expect(outputSize(model(4), ExportFormat.Obj, undefined, entries).kind).toBe(
      OutputSizeKind.Unknown,
    );
  });

  it('keys a unit-less 3MF by the unit stated for it', () => {
    const entries = [measured('3mf', 700, { unitAssertion: LengthUnit.Inch })];
    expect(outputSize(model(4), ExportFormat.ThreeMf, LengthUnit.Inch, entries)).toEqual({
      kind: OutputSizeKind.Measured,
      bytes: 700,
    });
    expect(outputSize(model(4), ExportFormat.ThreeMf, LengthUnit.Meter, entries).kind).toBe(
      OutputSizeKind.Unknown,
    );
  });

  it('ignores the assertion where the worker ignores it, so the key matches the file', () => {
    // A document with its own unit writes the same 3MF whatever is asserted.
    const withUnit = model(4, LengthUnit.Millimeter);
    const key = measurementUnitKey(withUnit, ExportFormat.ThreeMf, LengthUnit.Inch);
    expect(key).toBeUndefined();
    const entries = [measured('3mf', 700, { unitAssertion: key })];
    expect(outputSize(withUnit, ExportFormat.ThreeMf, LengthUnit.Foot, entries).kind).toBe(
      OutputSizeKind.Measured,
    );
    // And OBJ never records a unit, so an assertion never splits its entries.
    expect(measurementUnitKey(model(4), ExportFormat.Obj, LengthUnit.Inch)).toBeUndefined();
  });
});
