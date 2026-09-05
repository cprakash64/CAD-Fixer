import { describe, expect, it } from 'vitest';
import {
  analyseConversion,
  CompatibilityDisposition,
  CompatibilityFeature,
  EXPORT_FORMATS,
  ExportFormat,
  normaliseObjName,
  objNameChangesOnWrite,
  xmlTextChangesOnWrite,
  type CompatibilityFact,
} from '@cadfixer/file-formats';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type { DocumentHandle, PartDescriptor } from '@cadfixer/geometry-runtime';
import { LengthUnit } from '@cadfixer/shared';
import { documentFeatureProfile } from './document-profile';
import { describeFact } from './conversion-presentation';
import type { LoadedModel, ModelSource } from './model';

/**
 * NS01 - NS07: NAME-SANITIZATION DISCLOSURE.
 *
 * THE GAP THIS CLOSES. OBJ has no escape mechanism and XML cannot carry most
 * control characters, so a name containing one comes back from an export
 * CHANGED. Both writers already handled it correctly; neither told the user it
 * was going to happen, and Stage 4A-2B3 recorded that as a known limitation
 * because the compatibility profile deliberately holds no names.
 *
 * THE CONSTRAINT THAT SHAPED THE FIX. The disclosure may not carry the names. A
 * compatibility fact holding untrusted text is one render away from markup, and
 * it would create a second place display copy lived. So the profile counts them
 * and the fact is a number.
 *
 * The predicates are the WRITERS OWN functions, imported from leaf modules
 * rather than reimplemented, so the count cannot disagree with what the file
 * ends up containing.
 */

/*
 * Built rather than typed, so no literal control character appears in this
 * source. A stray one in a test file is invisible in review and survives copy
 * and paste into places it must never go.
 */
const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const VERTICAL_TAB = String.fromCharCode(11);
const DELETE = String.fromCharCode(127);

function descriptor(name: string | undefined, partId = 'part-1'): PartDescriptor {
  return {
    partId,
    ...(name === undefined ? {} : { name }),
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount: 4,
    vertexCount: 4,
    bounds: undefined,
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
  };
}

function modelWith(names: readonly (string | undefined)[]): LoadedModel {
  const parts = names.map((name, index) => descriptor(name, `part-${String(index + 1)}`));
  const source: ModelSource = {
    fileName: 'model.3mf',
    fileBytes: 100,
    formatId: '3mf',
    encoding: '3mf',
    unit: LengthUnit.Millimeter,
    unsupportedFeatures: [],
    externalReferences: [],
    importedAt: 0,
  };
  return {
    handle: { documentId: 'doc-1', revision: 1 } as DocumentHandle,
    parts,
    render: { parts: [] },
    source,
    bounds: undefined,
    triangleCount: parts.length * 4,
    vertexCount: parts.length * 4,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 0,
    revision: 1,
  };
}

function nameFactFor(
  names: readonly (string | undefined)[],
  target: ExportFormat,
): CompatibilityFact | undefined {
  const report = analyseConversion({ profile: documentFeatureProfile(modelWith(names)), target });
  return report.transformations.find(
    (fact) => fact.feature === CompatibilityFeature.NameCharacters,
  );
}

/* ------------------------------------------------------------------ NS01 -- */

describe('NS01 - an ordinary ASCII name', () => {
  it('warns about nothing, in any target', () => {
    for (const target of EXPORT_FORMATS) {
      expect(nameFactFor(['Bracket'], target), `target ${target}`).toBeUndefined();
    }
  });

  it('is written unchanged by both name-writing targets', () => {
    expect(objNameChangesOnWrite('Bracket')).toBe(false);
    expect(xmlTextChangesOnWrite('Bracket')).toBe(false);
  });
});

/* ------------------------------------------------------------------ NS02 -- */

describe('NS02 - a normal Unicode name', () => {
  /*
   * A NAME IS NOT SUSPICIOUS FOR BEING NON-ASCII. Warning about a name with an
   * umlaut in it would be noise, and noise is what teaches people to stop
   * reading the panel.
   */
  it.each([
    ['an umlaut', 'Brücke'],
    ['CJK', '部品'],
    ['emoji', 'Bracket 🧩'],
    ['right-to-left script', 'قطعة'],
    ['combining marks', 'étage'],
    ['an ampersand', 'Bolt & Nut'],
    ['angle brackets', '<not-markup>'],
    ['a quote', 'say "hello"'],
  ])('does not warn for %s', (_label, name) => {
    for (const target of EXPORT_FORMATS) {
      expect(nameFactFor([name], target), `${name} / ${target}`).toBeUndefined();
    }
    expect(objNameChangesOnWrite(name)).toBe(false);
    expect(xmlTextChangesOnWrite(name)).toBe(false);
  });
});

/* ------------------------------------------------------------------ NS03 -- */

describe('NS03 - a name XML cannot carry', () => {
  it.each([
    ['a null', `Brack${NUL}et`],
    ['a bell', `Brack${BELL}et`],
    ['a vertical tab', `Brack${VERTICAL_TAB}et`],
    ['a delete', `Brack${DELETE}et`],
  ])('warns for the 3MF target when the name contains %s', (_label, name) => {
    const fact = nameFactFor([name], ExportFormat.ThreeMf);
    expect(fact?.disposition).toBe(CompatibilityDisposition.Canonicalized);
    expect(fact?.count).toBe(1);
    expect(xmlTextChangesOnWrite(name)).toBe(true);
  });

  it('does NOT warn for the three characters XML can carry', () => {
    for (const name of ['a\tb', 'a\nb', 'a\rb']) {
      expect(xmlTextChangesOnWrite(name)).toBe(false);
      expect(nameFactFor([name], ExportFormat.ThreeMf)).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ NS04 -- */

describe('NS04 - a name OBJ cannot carry', () => {
  it.each([
    ['a newline', 'Brack\net'],
    ['a carriage return', 'Brack\ret'],
    ['a tab', 'Brack\tet'],
    ['a null', `Brack${NUL}et`],
    ['a double space', 'Left  Bracket'],
  ])('warns for the OBJ target when the name contains %s', (_label, name) => {
    /*
     * OBJ IS STRICTER THAN XML HERE, and for a reason worth stating: a newline
     * inside an `o` record would END the record, and the rest of the name would
     * be read as geometry - the file would contain triangles the document never
     * had. There is no escape to fall back on, so the characters are removed.
     */
    const fact = nameFactFor([name], ExportFormat.Obj);
    expect(fact?.disposition).toBe(CompatibilityDisposition.Canonicalized);
    expect(fact?.count).toBe(1);
    expect(objNameChangesOnWrite(name)).toBe(true);
  });

  it('reports the two targets independently, because their rules differ', () => {
    // A tab survives XML and does not survive OBJ.
    const name = 'Left\tBracket';
    expect(nameFactFor([name], ExportFormat.Obj)?.count).toBe(1);
    expect(nameFactFor([name], ExportFormat.ThreeMf)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ NS05 -- */

describe('NS05 - the STL target', () => {
  it('never adds a sanitization warning, because it drops names entirely', () => {
    /*
     * NO WARNING INSIDE A LARGER LOSS. STL writes no names at all and already
     * says so; adding "and some would have been adjusted" describes a change to
     * something that is not written.
     */
    const report = analyseConversion({
      profile: documentFeatureProfile(modelWith([`Brack${NUL}et`, 'Left  Bracket'])),
      target: ExportFormat.Stl,
    });

    expect(
      report.transformations.some((fact) => fact.feature === CompatibilityFeature.NameCharacters),
    ).toBe(false);
    // The names-dropped fact is there instead, and is sufficient.
    expect(report.losses.some((fact) => fact.feature === CompatibilityFeature.PartNames)).toBe(
      true,
    );
  });
});

/* ------------------------------------------------------------------ NS06 -- */

describe('NS06 - the count is the number of AFFECTED names', () => {
  it('counts two when two names are affected', () => {
    expect(nameFactFor([`Brack${NUL}et`, `Cl${BELL}amp`], ExportFormat.ThreeMf)?.count).toBe(2);
  });

  it('counts only the affected ones in a mixed document', () => {
    const names = ['Bracket', `Brack${NUL}et`, 'Clamp', `Cl${BELL}amp`, 'Plate'];
    expect(nameFactFor(names, ExportFormat.ThreeMf)?.count).toBe(2);
  });

  it('ignores parts with no name at all', () => {
    expect(nameFactFor([undefined, undefined], ExportFormat.Obj)).toBeUndefined();
    expect(nameFactFor(['', ''], ExportFormat.Obj)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ NS07 -- */

describe('NS07 - the report contains no source names', () => {
  it('carries a count and nothing else', () => {
    const secret = `Brack${NUL}et-CONFIDENTIAL-PROJECT`;
    const report = analyseConversion({
      profile: documentFeatureProfile(modelWith([secret])),
      target: ExportFormat.ThreeMf,
    });

    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('CONFIDENTIAL');
    expect(serialised).not.toContain('Brack');

    const fact = report.transformations.find(
      (entry) => entry.feature === CompatibilityFeature.NameCharacters,
    );
    expect(fact?.count).toBe(1);
  });

  it('produces a sentence that names no part', () => {
    const sentence = describeFact({
      feature: CompatibilityFeature.NameCharacters,
      disposition: CompatibilityDisposition.Canonicalized,
      count: 2,
    });
    expect(sentence).toContain('2 part names');
    expect(sentence.toLowerCase()).toContain('adjusted');
    // The shape is untouched, and the sentence says so rather than alarming.
    expect(sentence.toLowerCase()).toContain('shape is unaffected');
  });

  it('keeps the profile itself free of names', () => {
    /*
     * THE STRUCTURAL GUARANTEE, not just the fact one. The profile is what
     * crosses into the policy, so a name reaching it would be a name one
     * refactor away from a rendered string.
     */
    const profile = documentFeatureProfile(modelWith([`Brack${NUL}et-SECRET`]));
    expect(JSON.stringify(profile)).not.toContain('SECRET');
    expect(profile.namesUnwritableAsObj).toBe(1);
    expect(profile.namesUnwritableAsXml).toBe(1);
  });
});

/* ------------------------------------------------ the predicates are honest -- */

describe('the disclosure agrees with what the writers actually do', () => {
  it('flags exactly the names OBJ normalisation changes', () => {
    /*
     * THE PREDICATE IS THE TRANSFORM. `objNameChangesOnWrite` is defined as
     * "normalisation is not the identity", so a disclosure can only disagree
     * with the file if the writer stops using `normaliseObjName` - which the
     * writer own round-trip tests would catch.
     */
    for (const name of [
      'Bracket',
      'Left  Bracket',
      'Brack\net',
      `Br${NUL}ucke`,
      '部品',
      ' leading',
      'trailing ',
    ]) {
      expect(objNameChangesOnWrite(name)).toBe(normaliseObjName(name) !== name);
    }
  });

  it('treats leading and trailing whitespace as a change, because OBJ drops it', () => {
    expect(normaliseObjName('  Bracket  ')).toBe('Bracket');
    expect(objNameChangesOnWrite('  Bracket  ')).toBe(true);
  });
});
