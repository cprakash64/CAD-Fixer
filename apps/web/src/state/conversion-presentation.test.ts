import { describe, expect, it } from 'vitest';
import {
  analyseConversion,
  CompatibilityDisposition,
  CompatibilityFeature,
  ConversionVerdict,
  EXPORT_FORMATS,
  ExportFormat,
  ExportStatus,
  type CompatibilityFact,
  type DocumentFeatureProfile,
} from '@cadfixer/file-formats';
import { LengthUnit } from '@cadfixer/shared';
import {
  ASSUMPTIONS_HEADLINE,
  BLOCKED_HEADLINE,
  CONVERSION_FORBIDDEN_TERMS,
  CONVERSION_QUALIFIER,
  ConversionSeverity,
  LOSSLESS_HEADLINE,
  METADATA_LOSS_HEADLINE,
  PRESERVED_HEADLINE,
  SOURCE_WARNINGS_HEADLINE,
  STRUCTURE_LOSS_HEADLINE,
  TARGET_DESCRIPTIONS,
  UNIT_ASSERTION_EXPLANATION,
  UNIT_ASSERTION_SCOPE,
  UNIT_CHOICES,
  UNIT_REQUIRED_HEADLINE,
  describeExportFailure,
  describeFact,
  describePhase,
  describeTarget,
  describeUnitToken,
  describeVerdict,
  metadataLosses,
  structuralLosses,
  verdictSeverity,
} from './conversion-presentation';

/**
 * THE CONVERSION VOCABULARY, tested without a DOM.
 *
 * Wording is a correctness concern in this product. The engine can emit
 * `UNIT_METADATA_DROPPED` while one screen says "Scale preserved" and another
 * says "Units converted" — three statements, one truth, two of them false. This
 * file is the only place a fact becomes a sentence, so this is the only place
 * that has to be checked.
 */

/* ------------------------------------------------- every fact has a wording -- */

/** Every (feature, disposition) pair the policy can actually produce. */
function everyFactThePolicyCanProduce(): readonly CompatibilityFact[] {
  const base: DocumentFeatureProfile = {
    partCount: 3,
    meshResourceCount: 1,
    // Two of the three placements agree, so 3MF writes two objects: one reused
    // placement and one copy written to keep a name. Both sharing facts appear.
    threeMfObjectCount: 2,
    triangleCount: 100,
    unit: LengthUnit.Inch,
    nonIdentityTransformCount: 2,
    namedPartCount: 2,
    unnamedPartCount: 1,
    groupCount: 2,
    groupMaterialRefCount: 1,
    partMaterialRefCount: 1,
    meshesWithNormals: 1,
    meshesWithUvs: 1,
    namesUnwritableAsObj: 0,
    namesUnwritableAsXml: 0,
    sourceUnsupported: [
      'TEXTURES',
      'MATERIALS',
      'EXTERNAL_MATERIAL_LIBRARY',
      'UNREFERENCED_OBJECT',
      'COMPONENT_HIERARCHY',
    ],
    sourceFormat: 'obj',
  };

  const collected: CompatibilityFact[] = [];
  /*
   * ENUMERATED ACROSS THE WHOLE SPACE, not spot-checked. Each variation flips
   * one thing the policy branches on, so between them they reach every fact the
   * report can hold — including the two BLOCKED shapes, which a single
   * well-formed document would never produce.
   */
  const variations: readonly Partial<DocumentFeatureProfile>[] = [
    {},
    { unit: undefined },
    { partCount: 1, meshResourceCount: 1, threeMfObjectCount: 1, nonIdentityTransformCount: 0 },
    { partCount: 3, meshResourceCount: 1, threeMfObjectCount: 1 },
    { meshesWithNormals: 0, meshesWithUvs: 0 },
    { triangleCount: 100_000_000 },
    { sourceUnsupported: [] },
    // Reaches NAME_CHARACTERS for both name-writing targets.
    { namesUnwritableAsObj: 2, namesUnwritableAsXml: 1, namedPartCount: 3, unnamedPartCount: 0 },
  ];

  for (const overrides of variations) {
    for (const target of EXPORT_FORMATS) {
      for (const assertion of [undefined, LengthUnit.Millimeter]) {
        const report = analyseConversion({
          profile: { ...base, ...overrides },
          target,
          ...(assertion === undefined ? {} : { unitAssertion: assertion }),
        });
        collected.push(
          ...report.blockers,
          ...report.losses,
          ...report.transformations,
          ...report.assumptions,
          ...report.preserved,
          ...report.sourceImportWarnings,
        );
      }
    }
  }
  return collected;
}

describe('every fact the policy can produce has a wording', () => {
  const facts = everyFactThePolicyCanProduce();

  it('reaches every compatibility feature', () => {
    /*
     * THE COVERAGE ASSERTION IS THE POINT. Without it this file could describe
     * six features perfectly and leave the seventh untested — and an untested
     * `describeFact` branch is a sentence nobody read before it shipped.
     */
    const reached = new Set(facts.map((fact) => fact.feature));
    for (const feature of Object.values(CompatibilityFeature)) {
      expect(reached.has(feature), `no case produced ${feature}`).toBe(true);
    }
  });

  it('reaches every disposition the report can carry', () => {
    const reached = new Set(facts.map((fact) => fact.disposition));
    for (const disposition of Object.values(CompatibilityDisposition)) {
      expect(reached.has(disposition), `no case produced ${disposition}`).toBe(true);
    }
  });

  it('produces a non-empty, punctuated sentence for each one', () => {
    for (const fact of facts) {
      const sentence = describeFact(fact);
      expect(
        sentence.length,
        `${fact.feature}/${fact.disposition} produced nothing`,
      ).toBeGreaterThan(10);
      expect(sentence.trim().endsWith('.'), `${fact.feature} is not a sentence`).toBe(true);
    }
  });

  it('never leaks a machine-readable token into the wording', () => {
    /*
     * ENUM NAMES ARE NOT COPY. A user reading `STRUCTURAL_SHARING_FLATTENED`
     * learns nothing, and a sentence that contains one is a sentence nobody
     * wrote.
     */
    for (const fact of facts) {
      const sentence = describeFact(fact);
      expect(sentence, `${fact.feature} leaked a token`).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
    }
  });
});

/* ------------------------------------------------------- forbidden claims -- */

describe('no conversion wording makes a claim CAD Fixer cannot support', () => {
  function everyString(): readonly string[] {
    const strings: string[] = [
      CONVERSION_QUALIFIER,
      UNIT_REQUIRED_HEADLINE,
      UNIT_ASSERTION_EXPLANATION,
      UNIT_ASSERTION_SCOPE,
      LOSSLESS_HEADLINE,
      METADATA_LOSS_HEADLINE,
      STRUCTURE_LOSS_HEADLINE,
      BLOCKED_HEADLINE,
      ASSUMPTIONS_HEADLINE,
      SOURCE_WARNINGS_HEADLINE,
      PRESERVED_HEADLINE,
    ];
    for (const description of TARGET_DESCRIPTIONS) {
      strings.push(description.label, description.summary);
    }
    for (const choice of UNIT_CHOICES) strings.push(choice.label);
    for (const verdict of Object.values(ConversionVerdict)) strings.push(describeVerdict(verdict));
    for (const status of Object.values(ExportStatus)) {
      strings.push(describeExportFailure(status, undefined));
    }
    for (const fact of everyFactThePolicyCanProduce()) strings.push(describeFact(fact));
    for (const note of ['writing', 'writing model', 'compressing', 'validating', 'complete', 'x']) {
      strings.push(describePhase(note));
    }
    strings.push(describePhase(undefined));
    return strings;
  }

  it('emits none of the forbidden terms', () => {
    for (const text of everyString()) {
      const lower = text.toLowerCase();
      for (const term of CONVERSION_FORBIDDEN_TERMS) {
        expect(lower.includes(term), `"${term}" appears in: ${text}`).toBe(false);
      }
    }
  });

  it('bans the specific phrase that confuses coordinates with size', () => {
    /*
     * "SCALE PRESERVED" AND "THE NUMBERS ARE UNCHANGED" ARE NOT THE SAME
     * STATEMENT. The first implies the file still records how big the model is,
     * which after an OBJ or STL export it does not. This is the single most
     * likely piece of wrong copy on this screen, so it is banned by name.
     */
    expect(CONVERSION_FORBIDDEN_TERMS).toContain('scale preserved');
    expect(CONVERSION_FORBIDDEN_TERMS).toContain('units converted');
  });

  it('says both halves of the unit-loss truth in one sentence', () => {
    const sentence = describeFact({
      feature: CompatibilityFeature.PhysicalUnit,
      disposition: CompatibilityDisposition.Dropped,
      unit: LengthUnit.Inch,
    });
    // The file will not record the unit...
    expect(sentence.toLowerCase()).toContain('stores no unit');
    // ...and nothing was resized.
    expect(sentence.toLowerCase()).toContain('unchanged');
    expect(sentence.toLowerCase()).toContain('nothing is resized');
  });

  it('never promises printability, in any wording it can emit', () => {
    for (const text of everyString()) {
      expect(text.toLowerCase()).not.toContain('will print');
      expect(text.toLowerCase()).not.toContain('safe to print');
    }
  });

  it('keeps the unchecked qualifier attached to the workflow', () => {
    expect(CONVERSION_QUALIFIER).toContain('self-intersections');
    expect(CONVERSION_QUALIFIER).toContain('wall thickness');
  });
});

/* ---------------------------------------------------------------- units -- */

describe('the unit vocabulary', () => {
  it('offers exactly the six units 3MF can state', () => {
    expect(UNIT_CHOICES.map((choice) => choice.value)).toEqual([
      LengthUnit.Micron,
      LengthUnit.Millimeter,
      LengthUnit.Centimeter,
      LengthUnit.Inch,
      LengthUnit.Foot,
      LengthUnit.Meter,
    ]);
    expect(UNIT_CHOICES).toHaveLength(6);
  });

  it('covers every unit the shared vocabulary defines', () => {
    const offered = new Set(UNIT_CHOICES.map((choice) => choice.value));
    for (const unit of Object.values(LengthUnit)) expect(offered.has(unit)).toBe(true);
  });

  it('gives every unit a human label that still names the token', () => {
    for (const choice of UNIT_CHOICES) {
      expect(describeUnitToken(choice.value)).toBe(choice.label);
      expect(choice.label.length).toBeGreaterThan(choice.value.length - 4);
    }
  });

  it('shows an unrecognised token verbatim rather than inventing a label', () => {
    expect(describeUnitToken('furlong')).toBe('furlong');
  });

  it('explains that choosing a unit labels rather than resizes', () => {
    const text = UNIT_ASSERTION_EXPLANATION.toLowerCase();
    expect(text).toContain('does not resize');
    expect(text).toContain('25 mm');
    expect(text).toContain('25 in');
  });

  it('says the choice applies to the exported file only', () => {
    expect(UNIT_ASSERTION_SCOPE.toLowerCase()).toContain('exported file only');
  });
});

/* -------------------------------------------------------------- targets -- */

describe('the target descriptions', () => {
  it('describes exactly the formats that can be written', () => {
    expect(TARGET_DESCRIPTIONS.map((description) => description.id)).toEqual([...EXPORT_FORMATS]);
  });

  it('resolves every target to a real description', () => {
    for (const format of EXPORT_FORMATS) {
      const description = describeTarget(format);
      expect(description.label.length).toBeGreaterThan(0);
      expect(description.summary.length).toBeGreaterThan(0);
    }
  });

  it('describes what CAD Fixer writes, not what the format can express', () => {
    /*
     * 3MF SUPPORTS TEXTURES AND THIS WRITER EMITS NONE. A summary describing the
     * format's capabilities rather than ours would be an advertisement for
     * something the product does not do.
     */
    const threeMf = describeTarget(ExportFormat.ThreeMf);
    expect(threeMf.summary.toLowerCase()).not.toContain('texture');
    expect(threeMf.summary.toLowerCase()).not.toContain('colour');

    const stl = describeTarget(ExportFormat.Stl);
    expect(stl.summary.toLowerCase()).toContain('no parts');
  });
});

/* ------------------------------------------------------------ severities -- */

describe('severity is proportionate', () => {
  it('maps each verdict to exactly one register', () => {
    expect(verdictSeverity(ConversionVerdict.Lossless)).toBe(ConversionSeverity.Clear);
    expect(verdictSeverity(ConversionVerdict.LossyMetadata)).toBe(ConversionSeverity.Note);
    expect(verdictSeverity(ConversionVerdict.LossyStructure)).toBe(ConversionSeverity.Caution);
    expect(verdictSeverity(ConversionVerdict.UnsupportedInputFeature)).toBe(
      ConversionSeverity.Caution,
    );
    expect(verdictSeverity(ConversionVerdict.Blocked)).toBe(ConversionSeverity.Action);
  });

  it('reserves the strongest register for the case the user must act on', () => {
    /*
     * NO FEAR-BASED UI. Only a blocker gets the action register; rendering every
     * expected format limitation as an alarm teaches people to dismiss the panel
     * unread, and then the one case that mattered is dismissed too.
     */
    const action = Object.values(ConversionVerdict).filter(
      (verdict) => verdictSeverity(verdict) === ConversionSeverity.Action,
    );
    expect(action).toEqual([ConversionVerdict.Blocked]);
  });

  it('gives a lossless conversion no warning wording at all', () => {
    const sentence = describeVerdict(ConversionVerdict.Lossless).toLowerCase();
    expect(sentence).not.toContain('warning');
    expect(sentence).not.toContain('cannot');
    expect(sentence).toContain('nothing');
  });
});

/* ----------------------------------------------------------- loss grouping -- */

describe('losses are grouped into the two registers the interface shows', () => {
  const structuralProfile: DocumentFeatureProfile = {
    partCount: 3,
    meshResourceCount: 1,
    threeMfObjectCount: 3,
    triangleCount: 10,
    unit: LengthUnit.Inch,
    nonIdentityTransformCount: 0,
    namedPartCount: 3,
    unnamedPartCount: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    partMaterialRefCount: 0,
    meshesWithNormals: 0,
    meshesWithUvs: 0,
    sourceUnsupported: [],
    namesUnwritableAsObj: 0,
    namesUnwritableAsXml: 0,
  };

  it('separates a merged part list from a dropped label', () => {
    const report = analyseConversion({ profile: structuralProfile, target: ExportFormat.Stl });

    expect(structuralLosses(report).map((fact) => fact.feature)).toEqual([
      CompatibilityFeature.PartStructure,
      CompatibilityFeature.MeshSharing,
    ]);
    expect(metadataLosses(report).map((fact) => fact.feature)).toEqual([
      CompatibilityFeature.PhysicalUnit,
      CompatibilityFeature.PartNames,
    ]);
  });

  it('partitions the losses exactly, losing none and duplicating none', () => {
    for (const target of EXPORT_FORMATS) {
      const report = analyseConversion({
        profile: structuralProfile,
        target,
        unitAssertion: LengthUnit.Millimeter,
      });
      expect(metadataLosses(report).length + structuralLosses(report).length).toBe(
        report.losses.length,
      );
    }
  });
});

/* ---------------------------------------------------------- export outcomes -- */

describe('export outcomes', () => {
  it('gives every export status its own actionable sentence', () => {
    const sentences = Object.values(ExportStatus).map((status) =>
      describeExportFailure(status, undefined),
    );
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
  });

  it('tells the user what to do about a missing unit', () => {
    const sentence = describeExportFailure(ExportStatus.BlockedUnitRequired, undefined);
    expect(sentence.toLowerCase()).toContain('choose a unit');
  });

  it('blames CAD Fixer, not the model, when validation fails', () => {
    /*
     * A VALIDATION FAILURE IS OURS. It means our writer and our reader disagree;
     * telling someone their model is at fault for that would be a lie with their
     * name on it.
     */
    const sentence = describeExportFailure(ExportStatus.ValidationFailed, undefined).toLowerCase();
    expect(sentence).toContain('problem with cad fixer');
    expect(sentence).toContain('not with your model');
  });

  it('says nothing was saved for every non-success outcome', () => {
    for (const status of Object.values(ExportStatus)) {
      if (status === ExportStatus.Success) continue;
      const sentence = describeExportFailure(status, undefined).toLowerCase();
      expect(
        sentence.includes('nothing was saved') ||
          sentence.includes('no file was saved') ||
          sentence.includes('was not saved') ||
          sentence.includes('try again'),
        `${status}: ${sentence}`,
      ).toBe(true);
    }
  });

  it('states that a cancelled export left the model alone', () => {
    expect(describeExportFailure(ExportStatus.Cancelled, undefined).toLowerCase()).toContain(
      'model is unchanged',
    );
  });
});

/* -------------------------------------------------------------- progress -- */

describe('progress phases are the writers own', () => {
  it('names each phase the export engine actually reports', () => {
    expect(describePhase('writing')).toBe('Writing');
    expect(describePhase('writing model')).toBe('Writing');
    expect(describePhase('compressing')).toBe('Compressing');
    expect(describePhase('validating')).toBe('Checking the file reads back correctly');
    expect(describePhase('complete')).toBe('Ready');
  });

  it('falls back to a truthful label rather than inventing a phase', () => {
    /*
     * A NOTE THIS BUILD DOES NOT KNOW MUST NOT BECOME A CONFIDENT LABEL. Saying
     * "Preparing" is true of any unrecognised moment; echoing the raw token
     * would put an internal string on screen.
     */
    expect(describePhase(undefined)).toBe('Preparing');
    expect(describePhase('something-new')).toBe('Preparing');
  });
});
