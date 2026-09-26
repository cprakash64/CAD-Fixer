import { describe, expect, it } from 'vitest';
import { EXPORT_FORMATS, ExportFormat } from '@cadfixer/file-formats';
import { LengthUnit } from '@cadfixer/shared';
import {
  BEFORE_CONVERTING_NOTE,
  CONVERSION_FORBIDDEN_TERMS,
  CONVERT_WORKSPACE_COPY,
  DOWNLOAD_DESTINATION,
  EXPORT_SUMMARY_COPY,
  NO_MODEL_NOTE,
  OUTPUT_FORMATS_NOTE,
  OUTPUT_SIZE_HEADING,
  OUTPUT_VARIANTS,
  OutputSizeKind,
  PENDING_PREVIEW_NOTE,
  REVIEW_IN_REPAIR,
  SOURCE_SUFFIX,
  TRANSFORMATIONS_HEADLINE,
  UNIT_CHOICES,
  describeConvertAction,
  describeConvertUnavailable,
  describeOutput,
  describeOutputSizeBadge,
  describeOutputSizeKind,
  describeOutputUnit,
  describePartCount,
  describeSaved,
  describeSizeDifference,
  describeSourceKind,
  describeSourceUnit,
  describeStatedUnit,
  describeStructure,
  describeUnknownSize,
  describeUnrecordedUnit,
  outputVariantFor,
} from './conversion-presentation';

/**
 * UI-03: the Convert workspace's wording.
 *
 * The same discipline as the dialog's copy it replaced: one module decides
 * every sentence, nothing it can emit makes a claim CAD Fixer cannot support,
 * and nothing promises a capability — a format, a batch, a folder — the product
 * does not have.
 */

function everyWorkspaceString(): readonly string[] {
  const strings: string[] = [
    BEFORE_CONVERTING_NOTE,
    DOWNLOAD_DESTINATION,
    NO_MODEL_NOTE,
    OUTPUT_FORMATS_NOTE,
    OUTPUT_SIZE_HEADING,
    PENDING_PREVIEW_NOTE,
    REVIEW_IN_REPAIR,
    SOURCE_SUFFIX,
    TRANSFORMATIONS_HEADLINE,
    describeUnknownSize(),
    describePartCount(1),
    describePartCount(3),
    describeSourceUnit(undefined),
    describeSourceUnit(LengthUnit.Inch),
    describeSaved('part.3mf', 2048, 12),
    ...Object.values(CONVERT_WORKSPACE_COPY),
    ...Object.values(EXPORT_SUMMARY_COPY),
  ];
  for (const variant of OUTPUT_VARIANTS) {
    strings.push(variant.name, variant.variant, variant.accessibleName);
    if (variant.unavailableReason !== undefined) strings.push(variant.unavailableReason);
  }
  for (const kind of Object.values(OutputSizeKind)) {
    strings.push(describeOutputSizeKind(kind), describeOutputSizeBadge(kind));
  }
  for (const format of EXPORT_FORMATS) {
    strings.push(describeOutput(format), describeUnrecordedUnit(format));
    for (const parts of [1, 4]) strings.push(describeStructure(format, parts));
    for (const unit of [undefined, LengthUnit.Inch]) {
      for (const assertion of [undefined, LengthUnit.Foot]) {
        strings.push(describeOutputUnit(format, unit, assertion));
      }
    }
    for (const working of [false, true]) {
      strings.push(describeConvertAction('stl', format, working));
    }
  }
  strings.push(describeConvertAction('stl', undefined, false));
  for (const choice of UNIT_CHOICES) strings.push(describeStatedUnit(choice.value), choice.symbol);
  for (const hasModel of [false, true]) {
    for (const hasTarget of [false, true]) {
      for (const exportable of [false, true]) {
        const text = describeConvertUnavailable(hasModel, hasTarget, exportable);
        if (text !== undefined) strings.push(text);
      }
    }
  }
  return strings;
}

describe('the workspace wording makes no claim CAD Fixer cannot support', () => {
  it('emits none of the forbidden conversion terms', () => {
    for (const text of everyWorkspaceString()) {
      const lower = text.toLowerCase();
      for (const term of CONVERSION_FORBIDDEN_TERMS) {
        expect(lower.includes(term), `"${term}" appears in: ${text}`).toBe(false);
      }
    }
  });

  it('promises no batch, no multi-file operation and no folder it cannot see', () => {
    for (const text of everyWorkspaceString()) {
      expect(text, text).not.toMatch(/\bbatch\b|\bfiles\b|~\/|Downloads\//i);
    }
  });

  it('never describes a unit as converted or a size as preserved', () => {
    for (const text of everyWorkspaceString()) {
      expect(text.toLowerCase(), text).not.toMatch(/convert(ed|s)? (to|the) (mm|inch|unit)/);
      expect(text.toLowerCase(), text).not.toMatch(/scale (is )?(kept|preserved)/);
    }
  });
});

describe('the output cards are the writers', () => {
  it('has exactly one writable card per export format, and no other writable card', () => {
    const writable = OUTPUT_VARIANTS.flatMap((variant) =>
      variant.format === undefined ? [] : [variant.format],
    );
    expect([...writable].sort()).toEqual([...EXPORT_FORMATS].sort());
  });

  it('names a card by the format it writes, so its test id is the target', () => {
    for (const format of EXPORT_FORMATS) {
      expect(outputVariantFor(format).id).toBe(format);
    }
  });

  it('gives every unavailable card a reason, and no available card one', () => {
    for (const variant of OUTPUT_VARIANTS) {
      expect(variant.unavailableReason !== undefined, variant.id).toBe(
        variant.format === undefined,
      );
    }
  });

  it('shows no card for a format with no writer', () => {
    const names = OUTPUT_VARIANTS.map((variant) => variant.name);
    for (const absent of ['PLY', 'AMF', 'GLB', 'FBX', 'glTF']) expect(names).not.toContain(absent);
  });

  it('does not describe OBJ as carrying a material file it does not write', () => {
    const obj = outputVariantFor(ExportFormat.Obj);
    expect(obj.variant).toBe('No MTL');
    expect(obj.variant).not.toContain('+ MTL');
  });
});

describe('size differences', () => {
  it('is a signed whole percentage against the source', () => {
    expect(describeSizeDifference(1_430, 1_280)).toBe('+12%');
    expect(describeSizeDifference(492, 1_280)).toBe('−62%');
    expect(describeSizeDifference(1_280, 1_280)).toBe('±0%');
  });

  it('says nothing when there is no source size to compare against', () => {
    expect(describeSizeDifference(100, 0)).toBeUndefined();
  });
});

describe('the primary action', () => {
  it('is "Export" when the format does not change and "Convert to" when it does', () => {
    expect(describeConvertAction('stl', ExportFormat.Stl, false)).toBe('Export STL');
    expect(describeConvertAction('stl', ExportFormat.ThreeMf, false)).toBe('Convert to 3MF');
    expect(describeConvertAction('3mf', ExportFormat.Obj, false)).toBe('Convert to OBJ');
  });

  it('says why it is unavailable, in order of what to do first', () => {
    expect(describeConvertUnavailable(false, false, false)).toBe(NO_MODEL_NOTE);
    expect(describeConvertUnavailable(true, false, false)).toMatch(/Choose an output format/);
    expect(describeConvertUnavailable(true, true, false)).toMatch(/Format options/);
    expect(describeConvertUnavailable(true, true, true)).toBeUndefined();
  });
});

describe('units are labelled, never converted', () => {
  it('says STL and OBJ record no unit, and the numbers are unchanged', () => {
    for (const format of [ExportFormat.Stl, ExportFormat.Obj]) {
      expect(describeOutputUnit(format, LengthUnit.Inch, undefined)).toMatch(/Not recorded/);
      expect(describeUnrecordedUnit(format)).toMatch(/written unchanged/);
    }
  });

  it('prefers the model’s own unit to an assertion, as the worker does', () => {
    expect(describeOutputUnit(ExportFormat.ThreeMf, LengthUnit.Millimeter, LengthUnit.Inch)).toBe(
      'Millimetres (mm), from the model',
    );
    expect(describeOutputUnit(ExportFormat.ThreeMf, undefined, LengthUnit.Inch)).toBe(
      'Inches (in), stated for this file',
    );
    expect(describeOutputUnit(ExportFormat.ThreeMf, undefined, undefined)).toBe('Not chosen yet');
  });

  it('names the STL encoding and nothing for formats with one encoding', () => {
    expect(describeSourceKind('STL', 'stl', 'binary')).toBe('STL · Binary');
    expect(describeSourceKind('STL', 'stl', 'ascii')).toBe('STL · ASCII');
    expect(describeSourceKind('3MF', '3mf', '3mf')).toBe('3MF');
  });
});
