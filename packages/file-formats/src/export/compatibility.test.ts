import { describe, expect, it } from 'vitest';
import { LengthUnit } from '@cadfixer/shared';
import { MeshFormatId } from '../formats';
import { UnsupportedFeature } from '../document-reader';
import { DEFAULT_EXPORT_LIMITS, type ExportLimits } from './export-contract';
import {
  analyseConversion,
  CompatibilityDisposition,
  CompatibilityFeature,
  ConversionVerdict,
  EXPORT_FORMATS,
  ExportFormat,
  isExportFormat,
  sharedPlacementCount,
  strongerVerdict,
  type CompatibilityFact,
  type ConversionCompatibilityReport,
  type DocumentFeatureProfile,
} from './compatibility';
import { maxStlDocumentTriangles } from './stl-document-writer';

/**
 * THE CONVERSION POLICY, TESTED EXHAUSTIVELY AND WITHOUT A BROWSER.
 *
 * `analyseConversion` is a pure function, which is the whole reason it is one:
 * policy correctness has to be established here, where every combination can be
 * enumerated cheaply. An end-to-end test can only ever sample this space, and
 * sampling a policy is how a wrong answer for one combination ships.
 *
 * WHAT THESE TESTS ARE ABOUT: that the report describes the DOCUMENT rather
 * than the target's reputation. "OBJ loses units" is a fact about OBJ; whether
 * THIS conversion loses a unit depends on whether this document has one, and
 * every case below is built to tell those two apart.
 */

/* ------------------------------------------------------------- profiles -- */

const EMPTY_PROFILE: DocumentFeatureProfile = {
  partCount: 1,
  meshResourceCount: 1,
  threeMfObjectCount: 1,
  triangleCount: 12,
  unit: undefined,
  nonIdentityTransformCount: 0,
  namedPartCount: 0,
  unnamedPartCount: 1,
  groupCount: 0,
  groupMaterialRefCount: 0,
  partMaterialRefCount: 0,
  meshesWithNormals: 0,
  meshesWithUvs: 0,
  sourceUnsupported: [],
  namesUnwritableAsObj: 0,
  namesUnwritableAsXml: 0,
};

function profile(overrides: Partial<DocumentFeatureProfile> = {}): DocumentFeatureProfile {
  return { ...EMPTY_PROFILE, ...overrides };
}

/** The simplest thing an STL import produces: one part, no unit, no names. */
function stlLike(overrides: Partial<DocumentFeatureProfile> = {}): DocumentFeatureProfile {
  return profile({ sourceFormat: MeshFormatId.Stl, ...overrides });
}

/** A plain OBJ: named objects, no unit. */
function objLike(overrides: Partial<DocumentFeatureProfile> = {}): DocumentFeatureProfile {
  return profile({
    sourceFormat: MeshFormatId.Obj,
    namedPartCount: 1,
    unnamedPartCount: 0,
    ...overrides,
  });
}

/** A plain 3MF: a stated unit and named parts. */
function threeMfLike(overrides: Partial<DocumentFeatureProfile> = {}): DocumentFeatureProfile {
  return profile({
    sourceFormat: MeshFormatId.ThreeMf,
    unit: LengthUnit.Millimeter,
    namedPartCount: 1,
    unnamedPartCount: 0,
    ...overrides,
  });
}

function featuresIn(facts: readonly CompatibilityFact[]): readonly CompatibilityFeature[] {
  return facts.map((fact) => fact.feature);
}

function factFor(
  report: ConversionCompatibilityReport,
  feature: CompatibilityFeature,
): CompatibilityFact | undefined {
  for (const bucket of [
    report.blockers,
    report.losses,
    report.transformations,
    report.assumptions,
    report.preserved,
    report.sourceImportWarnings,
  ]) {
    for (const fact of bucket) if (fact.feature === feature) return fact;
  }
  return undefined;
}

/* -------------------------------------------------------- the vocabulary -- */

describe('the target vocabulary', () => {
  it('offers exactly the three formats that have writers', () => {
    expect([...EXPORT_FORMATS]).toEqual([MeshFormatId.Stl, MeshFormatId.Obj, MeshFormatId.ThreeMf]);
  });

  it('recognises those three and nothing else', () => {
    for (const format of EXPORT_FORMATS) expect(isExportFormat(format)).toBe(true);
    expect(isExportFormat('step')).toBe(false);
    expect(isExportFormat('STL')).toBe(false);
    expect(isExportFormat('')).toBe(false);
  });
});

describe('verdict precedence is frozen and total', () => {
  /*
   * THE ORDER IS PART OF THE CONTRACT. A user comparing three targets reads
   * these five words before anything else, so the ranking cannot drift with a
   * refactor. Stated as a list and asserted pairwise rather than restated in
   * prose.
   */
  const ORDER: readonly ConversionVerdict[] = [
    ConversionVerdict.Lossless,
    ConversionVerdict.LossyMetadata,
    ConversionVerdict.LossyStructure,
    ConversionVerdict.UnsupportedInputFeature,
    ConversionVerdict.Blocked,
  ];

  it('ranks every pair the same way, in both argument orders', () => {
    for (const [lowIndex, low] of ORDER.entries()) {
      for (const high of ORDER.slice(lowIndex)) {
        expect(strongerVerdict(low, high)).toBe(high);
        expect(strongerVerdict(high, low)).toBe(high);
      }
    }
  });

  it('covers every verdict the union declares', () => {
    expect(new Set(ORDER).size).toBe(Object.keys(ConversionVerdict).length);
  });
});

/* -------------------------------------------- the nine-way format matrix -- */

describe('the nine-way source/target matrix', () => {
  /*
   * REPRESENTATIVE DOCUMENTS, NOT EXTENSIONS. Each source is the document its
   * reader actually produces — an STL has one unnamed part and no unit, an OBJ
   * has named parts and no unit, a 3MF has a unit and names — because the report
   * answers a question about the document, and testing by extension alone would
   * pass whatever the policy did with the contents.
   */
  const SOURCES: readonly (readonly [string, DocumentFeatureProfile])[] = [
    ['STL', stlLike()],
    ['OBJ', objLike()],
    ['3MF', threeMfLike()],
  ];

  const EXPECTED: Readonly<Record<string, Readonly<Record<ExportFormat, ConversionVerdict>>>> = {
    // An STL document holds nothing STL or OBJ cannot express; 3MF needs a unit.
    STL: {
      [ExportFormat.Stl]: ConversionVerdict.Lossless,
      [ExportFormat.Obj]: ConversionVerdict.Lossless,
      [ExportFormat.ThreeMf]: ConversionVerdict.Blocked,
    },
    // An OBJ document has names, which STL cannot hold. 3MF still needs a unit.
    OBJ: {
      [ExportFormat.Stl]: ConversionVerdict.LossyMetadata,
      [ExportFormat.Obj]: ConversionVerdict.Lossless,
      [ExportFormat.ThreeMf]: ConversionVerdict.Blocked,
    },
    // A 3MF document has a unit AND names; only 3MF keeps both.
    '3MF': {
      [ExportFormat.Stl]: ConversionVerdict.LossyMetadata,
      [ExportFormat.Obj]: ConversionVerdict.LossyMetadata,
      [ExportFormat.ThreeMf]: ConversionVerdict.Lossless,
    },
  };

  for (const [name, source] of SOURCES) {
    for (const target of EXPORT_FORMATS) {
      it(`${name} → ${target} is ${EXPECTED[name]?.[target] ?? '?'}`, () => {
        const report = analyseConversion({ profile: source, target });
        expect(report.verdict).toBe(EXPECTED[name]?.[target]);
        expect(report.sourceFormat).toBe(source.sourceFormat);
        expect(report.targetFormat).toBe(target);
      });
    }
  }

  it('covers all nine combinations', () => {
    expect(SOURCES.length * EXPORT_FORMATS.length).toBe(9);
  });
});

/* ------------------------------------------------ the document-feature matrix -- */

describe('the report responds to document FEATURES, not to the source format', () => {
  it('says nothing about parts when there is one part', () => {
    for (const target of EXPORT_FORMATS) {
      const report = analyseConversion({
        profile: stlLike({ unit: LengthUnit.Millimeter }),
        target,
        unitAssertion: LengthUnit.Millimeter,
      });
      expect(featuresIn([...report.losses, ...report.preserved])).not.toContain(
        CompatibilityFeature.PartStructure,
      );
    }
  });

  it('reports flattened parts for STL and preserved parts for OBJ and 3MF', () => {
    const many = profile({
      partCount: 3,
      meshResourceCount: 3,
      threeMfObjectCount: 3,
      unit: LengthUnit.Millimeter,
    });

    const toStl = analyseConversion({ profile: many, target: ExportFormat.Stl });
    expect(featuresIn(toStl.losses)).toContain(CompatibilityFeature.PartStructure);
    expect(toStl.verdict).toBe(ConversionVerdict.LossyStructure);

    for (const target of [ExportFormat.Obj, ExportFormat.ThreeMf]) {
      const report = analyseConversion({ profile: many, target });
      expect(featuresIn(report.preserved)).toContain(CompatibilityFeature.PartStructure);
      expect(featuresIn(report.losses)).not.toContain(CompatibilityFeature.PartStructure);
    }
  });

  it('reports baked transforms for STL and OBJ, and preserved ones for 3MF', () => {
    const placed = profile({
      partCount: 2,
      meshResourceCount: 2,
      threeMfObjectCount: 2,
      nonIdentityTransformCount: 2,
    });

    for (const target of [ExportFormat.Stl, ExportFormat.Obj]) {
      const report = analyseConversion({ profile: placed, target });
      const fact = factFor(report, CompatibilityFeature.Transforms);
      expect(fact?.disposition).toBe(CompatibilityDisposition.Baked);
      expect(fact?.count).toBe(2);
      expect(featuresIn(report.transformations)).toContain(CompatibilityFeature.Transforms);
    }

    const toThreeMf = analyseConversion({
      profile: { ...placed, unit: LengthUnit.Millimeter },
      target: ExportFormat.ThreeMf,
    });
    expect(factFor(toThreeMf, CompatibilityFeature.Transforms)?.disposition).toBe(
      CompatibilityDisposition.Preserved,
    );
  });

  it('says nothing about transforms when every placement is the identity', () => {
    for (const target of EXPORT_FORMATS) {
      const report = analyseConversion({
        profile: threeMfLike(),
        target,
      });
      expect(factFor(report, CompatibilityFeature.Transforms)).toBeUndefined();
    }
  });

  it('reports expanded sharing for STL and OBJ, and preserved sharing for 3MF', () => {
    const shared = profile({
      partCount: 5,
      meshResourceCount: 1,
      // Five placements of one mesh, all agreeing: 3MF writes ONE object.
      threeMfObjectCount: 1,
      unit: LengthUnit.Millimeter,
    });
    expect(sharedPlacementCount(shared)).toBe(4);

    for (const target of [ExportFormat.Stl, ExportFormat.Obj]) {
      const report = analyseConversion({ profile: shared, target });
      const fact = factFor(report, CompatibilityFeature.MeshSharing);
      expect(fact?.disposition).toBe(CompatibilityDisposition.Dropped);
      expect(fact?.count).toBe(4);
      expect(report.verdict).toBe(ConversionVerdict.LossyStructure);
    }

    const toThreeMf = analyseConversion({ profile: shared, target: ExportFormat.ThreeMf });
    const preserved = factFor(toThreeMf, CompatibilityFeature.MeshSharing);
    expect(preserved?.disposition).toBe(CompatibilityDisposition.Preserved);
    // Four of the five placements reuse the one object.
    expect(preserved?.count).toBe(4);
  });

  it('reports the COPIES 3MF must write when sharing parts disagree about a name', () => {
    /*
     * THE FALSE-LOSSLESS CASE THIS EXISTS TO CATCH. 3MF puts the name and the
     * material reference on the `<object>`, not on the `<item>` that places it,
     * so five placements of one mesh under five different names are five
     * objects — the geometry is written five times. A report that said "sharing
     * is preserved" here would be promising something the writer cannot do, on
     * the largest file the product can produce.
     */
    const disagreeing = profile({
      partCount: 5,
      meshResourceCount: 1,
      threeMfObjectCount: 5,
      namedPartCount: 5,
      unnamedPartCount: 0,
      unit: LengthUnit.Millimeter,
    });

    const report = analyseConversion({ profile: disagreeing, target: ExportFormat.ThreeMf });
    const fact0 = factFor(report, CompatibilityFeature.MeshSharing);
    expect(fact0?.disposition).toBe(CompatibilityDisposition.Dropped);
    expect(fact0?.count).toBe(4);
    expect(report.verdict).toBe(ConversionVerdict.LossyStructure);
    // And nothing claims the geometry was reused.
    expect(
      report.preserved.some((entry) => entry.feature === CompatibilityFeature.MeshSharing),
    ).toBe(false);
  });

  it('reports both halves when some sharing parts agree and others do not', () => {
    // Four placements of one mesh: three agree and become one object, one
    // disagrees and becomes a second. Three reuse; one copy is written.
    const mixed = profile({
      partCount: 4,
      meshResourceCount: 1,
      threeMfObjectCount: 2,
      namedPartCount: 1,
      unnamedPartCount: 3,
      unit: LengthUnit.Millimeter,
    });

    const report = analyseConversion({ profile: mixed, target: ExportFormat.ThreeMf });
    expect(
      report.preserved.find((entry) => entry.feature === CompatibilityFeature.MeshSharing)?.count,
    ).toBe(2);
    expect(
      report.losses.find((entry) => entry.feature === CompatibilityFeature.MeshSharing)?.count,
    ).toBe(1);
  });

  it('says nothing about sharing when nothing is shared', () => {
    const unshared = profile({ partCount: 3, meshResourceCount: 3, threeMfObjectCount: 3 });
    for (const target of EXPORT_FORMATS) {
      const report = analyseConversion({
        profile: unshared,
        target,
        unitAssertion: LengthUnit.Millimeter,
      });
      expect(factFor(report, CompatibilityFeature.MeshSharing)).toBeUndefined();
    }
  });

  it('reports dropped names for STL and preserved names for OBJ and 3MF', () => {
    const named = profile({
      namedPartCount: 2,
      unnamedPartCount: 0,
      partCount: 2,
      meshResourceCount: 2,
    });

    const toStl = analyseConversion({ profile: named, target: ExportFormat.Stl });
    expect(factFor(toStl, CompatibilityFeature.PartNames)?.disposition).toBe(
      CompatibilityDisposition.Dropped,
    );

    const toObj = analyseConversion({ profile: named, target: ExportFormat.Obj });
    expect(factFor(toObj, CompatibilityFeature.PartNames)?.disposition).toBe(
      CompatibilityDisposition.Preserved,
    );
  });

  it('reports generated names as an ADDITION, not a loss, and only for OBJ', () => {
    /*
     * `o part-1` IS SOMETHING THE FILE SAYS AND THE MODEL DOES NOT. Nothing was
     * lost — the part had no name — so it belongs with the asserted unit under
     * "what the file will state", and it must not drag the verdict off lossless.
     */
    const anonymous = profile({
      partCount: 2,
      meshResourceCount: 2,
      threeMfObjectCount: 2,
      unnamedPartCount: 2,
    });

    const toObj = analyseConversion({ profile: anonymous, target: ExportFormat.Obj });
    const generated = toObj.assumptions.find(
      (fact) => fact.feature === CompatibilityFeature.PartNames,
    );
    expect(generated?.disposition).toBe(CompatibilityDisposition.Canonicalized);
    expect(generated?.count).toBe(2);
    expect(featuresIn(toObj.losses)).not.toContain(CompatibilityFeature.PartNames);

    // Nothing generates a name for a document whose parts are all named.
    const named = profile({
      partCount: 2,
      meshResourceCount: 2,
      namedPartCount: 2,
      unnamedPartCount: 0,
    });
    expect(analyseConversion({ profile: named, target: ExportFormat.Obj }).assumptions).toEqual([]);

    // And no other target generates one, because no other target needs one.
    for (const target of [ExportFormat.Stl, ExportFormat.ThreeMf]) {
      const report = analyseConversion({
        profile: anonymous,
        target,
        unitAssertion: LengthUnit.Millimeter,
      });
      expect(
        report.assumptions.some((fact) => fact.feature === CompatibilityFeature.PartNames),
      ).toBe(false);
    }
  });

  it('reports groups as preserved only by OBJ', () => {
    /*
     * 3MF DROPS THEM TOO, and that is a fact about THIS writer rather than about
     * the format. Claiming "3MF keeps everything" here would be exactly the
     * false lossless claim the report exists to prevent.
     */
    const grouped = profile({ groupCount: 4, unit: LengthUnit.Millimeter });

    expect(
      factFor(
        analyseConversion({ profile: grouped, target: ExportFormat.Obj }),
        CompatibilityFeature.Groups,
      )?.disposition,
    ).toBe(CompatibilityDisposition.Preserved);

    for (const target of [ExportFormat.Stl, ExportFormat.ThreeMf]) {
      expect(
        factFor(analyseConversion({ profile: grouped, target }), CompatibilityFeature.Groups)
          ?.disposition,
      ).toBe(CompatibilityDisposition.Dropped);
    }
  });

  it('tells a PART material reference apart from a GROUP one', () => {
    /*
     * THE TWO ARE DIFFERENT FEATURES AND MUST NOT BE COLLAPSED. OBJ's `usemtl`
     * applies to a run of faces, so a GROUP reference survives there; a
     * PART-level reference has nowhere to go in any target CAD Fixer writes.
     *
     * PART REFERENCES USED TO BE REPORTED AS PRESERVED FOR 3MF. That was the
     * property-reference defect: the writer expressed it as an `object@pid`
     * pointing at a resource it never emitted. All three targets now drop it.
     */
    const both = profile({
      partMaterialRefCount: 2,
      groupCount: 2,
      groupMaterialRefCount: 2,
      unit: LengthUnit.Millimeter,
    });

    for (const target of EXPORT_FORMATS) {
      expect(
        factFor(
          analyseConversion({ profile: both, target }),
          CompatibilityFeature.PartMaterialReferences,
        )?.disposition,
        `${target} must drop a part material reference`,
      ).toBe(CompatibilityDisposition.Dropped);
    }

    const toObj = analyseConversion({ profile: both, target: ExportFormat.Obj });
    expect(factFor(toObj, CompatibilityFeature.GroupMaterialReferences)?.disposition).toBe(
      CompatibilityDisposition.Preserved,
    );

    const toThreeMf = analyseConversion({ profile: both, target: ExportFormat.ThreeMf });
    expect(factFor(toThreeMf, CompatibilityFeature.GroupMaterialReferences)?.disposition).toBe(
      CompatibilityDisposition.Dropped,
    );
  });

  it('never claims any target preserves a part material reference', () => {
    /*
     * THE REGRESSION GUARD FOR THE PROPERTY-REFERENCE DEFECT. Whatever else a
     * document contains, no target may report a part material reference as
     * preserved while CAD Fixer writes no material resources.
     */
    for (const overrides of [
      { partMaterialRefCount: 1 },
      { partMaterialRefCount: 5, partCount: 5, meshResourceCount: 1, threeMfObjectCount: 1 },
      { partMaterialRefCount: 2, unit: LengthUnit.Inch, namedPartCount: 2, unnamedPartCount: 0 },
    ]) {
      for (const target of EXPORT_FORMATS) {
        const report = analyseConversion({
          profile: profile(overrides),
          target,
          unitAssertion: LengthUnit.Millimeter,
        });
        expect(
          report.preserved.some(
            (entry) => entry.feature === CompatibilityFeature.PartMaterialReferences,
          ),
          `${target} claimed a part material reference is preserved`,
        ).toBe(false);
        expect(featuresIn(report.losses)).toContain(CompatibilityFeature.PartMaterialReferences);
      }
    }
  });

  it('warns about normals and UVs only when the document actually carries them', () => {
    for (const target of EXPORT_FORMATS) {
      const clean = analyseConversion({
        profile: threeMfLike(),
        target,
        unitAssertion: LengthUnit.Millimeter,
      });
      expect(factFor(clean, CompatibilityFeature.Normals)).toBeUndefined();
      expect(factFor(clean, CompatibilityFeature.TextureCoordinates)).toBeUndefined();
    }

    const rich = threeMfLike({ meshesWithNormals: 1, meshesWithUvs: 1 });
    for (const target of EXPORT_FORMATS) {
      const report = analyseConversion({ profile: rich, target });
      expect(factFor(report, CompatibilityFeature.Normals)?.disposition).toBe(
        CompatibilityDisposition.Unsupported,
      );
      expect(factFor(report, CompatibilityFeature.TextureCoordinates)?.disposition).toBe(
        CompatibilityDisposition.Unsupported,
      );
      expect(report.verdict).toBe(ConversionVerdict.UnsupportedInputFeature);
    }
  });
});

/* ---------------------------------------------------------------- units -- */

describe('the unit', () => {
  it('blocks 3MF when the document states none and the user has not said', () => {
    const report = analyseConversion({ profile: stlLike(), target: ExportFormat.ThreeMf });
    expect(report.verdict).toBe(ConversionVerdict.Blocked);
    expect(report.exportable).toBe(false);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]?.feature).toBe(CompatibilityFeature.PhysicalUnit);
    expect(report.blockers[0]?.disposition).toBe(CompatibilityDisposition.RequiresUserAssertion);
  });

  it('never defaults to millimetres, and never infers from the source format', () => {
    for (const source of [MeshFormatId.Stl, MeshFormatId.Obj]) {
      const report = analyseConversion({
        profile: profile({ sourceFormat: source }),
        target: ExportFormat.ThreeMf,
      });
      expect(report.exportable).toBe(false);
      expect(factFor(report, CompatibilityFeature.PhysicalUnit)?.unit).toBeUndefined();
    }
  });

  it('unblocks 3MF once the user states a unit, and records it as an assumption', () => {
    const report = analyseConversion({
      profile: stlLike(),
      target: ExportFormat.ThreeMf,
      unitAssertion: LengthUnit.Inch,
    });
    expect(report.exportable).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.assumptions).toHaveLength(1);
    expect(report.assumptions[0]?.feature).toBe(CompatibilityFeature.PhysicalUnit);
    expect(report.assumptions[0]?.unit).toBe(LengthUnit.Inch);
  });

  it('accepts each of the six units 3MF can state', () => {
    for (const unit of [
      LengthUnit.Micron,
      LengthUnit.Millimeter,
      LengthUnit.Centimeter,
      LengthUnit.Inch,
      LengthUnit.Foot,
      LengthUnit.Meter,
    ]) {
      const report = analyseConversion({
        profile: stlLike(),
        target: ExportFormat.ThreeMf,
        unitAssertion: unit,
      });
      expect(report.exportable, `${unit} should be acceptable`).toBe(true);
      expect(report.assumptions[0]?.unit).toBe(unit);
    }
  });

  it('treats a unit 3MF cannot express as an unmade choice, not a substitution', () => {
    const report = analyseConversion({
      profile: stlLike(),
      target: ExportFormat.ThreeMf,
      unitAssertion: 'furlong',
    });
    expect(report.exportable).toBe(false);
    expect(report.blockers[0]?.disposition).toBe(CompatibilityDisposition.RequiresUserAssertion);
  });

  it('IGNORES an assertion when the document already states a unit', () => {
    /*
     * A DOCUMENT'S OWN UNIT WINS. Its assertion came from a file; a conversion-
     * time choice came from a person about a document that stated nothing.
     * Letting the second overwrite the first would silently relabel a known
     * model — so the report shows the document's unit, and `exportSnapshotOf`
     * applies the same precedence where it actually matters.
     */
    const report = analyseConversion({
      profile: threeMfLike({ unit: LengthUnit.Inch }),
      target: ExportFormat.ThreeMf,
      unitAssertion: LengthUnit.Meter,
    });
    expect(report.assumptions).toEqual([]);
    expect(factFor(report, CompatibilityFeature.PhysicalUnit)?.unit).toBe(LengthUnit.Inch);
  });

  it('reports a known unit as dropped by STL and OBJ, and carries the token', () => {
    for (const target of [ExportFormat.Stl, ExportFormat.Obj]) {
      const report = analyseConversion({
        profile: threeMfLike({ unit: LengthUnit.Inch, namedPartCount: 0, unnamedPartCount: 1 }),
        target,
      });
      const fact = factFor(report, CompatibilityFeature.PhysicalUnit);
      expect(fact?.disposition).toBe(CompatibilityDisposition.Dropped);
      expect(fact?.unit).toBe(LengthUnit.Inch);
      expect(report.verdict).toBe(ConversionVerdict.LossyMetadata);
    }
  });

  it('says nothing about the unit when neither the document nor the target has one', () => {
    for (const target of [ExportFormat.Stl, ExportFormat.Obj]) {
      const report = analyseConversion({ profile: stlLike(), target });
      expect(factFor(report, CompatibilityFeature.PhysicalUnit)).toBeUndefined();
      expect(report.verdict).toBe(ConversionVerdict.Lossless);
    }
  });
});

/* ------------------------------------------------------- source warnings -- */

describe('source import warnings', () => {
  const WITH_TEXTURES = threeMfLike({ sourceUnsupported: [UnsupportedFeature.Textures] });

  it('are carried into every target unchanged', () => {
    for (const target of EXPORT_FORMATS) {
      const report = analyseConversion({ profile: WITH_TEXTURES, target });
      expect(featuresIn(report.sourceImportWarnings)).toEqual([
        CompatibilityFeature.SourceTextures,
      ]);
    }
  });

  it('do NOT change the verdict', () => {
    /*
     * A texture that was never imported is not something this conversion is
     * doing. Letting it push a 3MF-to-3MF save out of "lossless" would blame the
     * target for a loss that happened when the file was opened.
     */
    const withWarning = analyseConversion({
      profile: WITH_TEXTURES,
      target: ExportFormat.ThreeMf,
    });
    const without = analyseConversion({ profile: threeMfLike(), target: ExportFormat.ThreeMf });
    expect(withWarning.verdict).toBe(without.verdict);
    expect(withWarning.verdict).toBe(ConversionVerdict.Lossless);
  });

  it('do not appear in the loss or blocker lists', () => {
    const report = analyseConversion({ profile: WITH_TEXTURES, target: ExportFormat.Obj });
    expect(featuresIn(report.losses)).not.toContain(CompatibilityFeature.SourceTextures);
    expect(featuresIn(report.blockers)).not.toContain(CompatibilityFeature.SourceTextures);
  });

  it('translates every UnsupportedFeature the readers can produce', () => {
    const all = Object.values(UnsupportedFeature);
    const report = analyseConversion({
      profile: threeMfLike({ sourceUnsupported: all }),
      target: ExportFormat.ThreeMf,
    });
    expect(report.sourceImportWarnings).toHaveLength(all.length);
  });

  it('ignores a token this build does not recognise rather than failing', () => {
    /*
     * THESE VALUES CROSSED A WORKER BOUNDARY. A token from a newer build must be
     * REPRESENTABLE and then dropped, not asserted into an enum it may not
     * belong to — a version skew must not break the dialog.
     */
    const report = analyseConversion({
      profile: threeMfLike({ sourceUnsupported: ['SOMETHING_NEW', UnsupportedFeature.Textures] }),
      target: ExportFormat.ThreeMf,
    });
    expect(featuresIn(report.sourceImportWarnings)).toEqual([CompatibilityFeature.SourceTextures]);
  });

  it('reports a flattened component hierarchy as a canonicalization, not a loss', () => {
    const report = analyseConversion({
      profile: threeMfLike({ sourceUnsupported: [UnsupportedFeature.ComponentHierarchy] }),
      target: ExportFormat.ThreeMf,
    });
    expect(report.sourceImportWarnings[0]?.feature).toBe(
      CompatibilityFeature.SourceComponentHierarchy,
    );
    expect(report.sourceImportWarnings[0]?.disposition).toBe(
      CompatibilityDisposition.Canonicalized,
    );
  });

  it('does not fabricate a hierarchy warning for a file that had none', () => {
    const report = analyseConversion({ profile: threeMfLike(), target: ExportFormat.ThreeMf });
    expect(featuresIn(report.sourceImportWarnings)).not.toContain(
      CompatibilityFeature.SourceComponentHierarchy,
    );
  });
});

/* ------------------------------------------------------------- resources -- */

describe('the resource preflight', () => {
  const TINY: ExportLimits = { maxOutputBytes: 1024, maxSerialisedBytes: 4096 };

  it('blocks an STL that provably cannot fit, using the exact size', () => {
    const report = analyseConversion({
      profile: stlLike({ triangleCount: 1000 }),
      target: ExportFormat.Stl,
      limits: TINY,
    });
    expect(report.verdict).toBe(ConversionVerdict.Blocked);
    expect(report.blockers[0]?.feature).toBe(CompatibilityFeature.OutputSize);
    expect(report.blockers[0]?.bytes).toBe(84 + 1000 * 50);
    expect(report.blockers[0]?.limitBytes).toBe(1024);
  });

  it('does not block an STL that fits exactly', () => {
    const ceiling = maxStlDocumentTriangles(DEFAULT_EXPORT_LIMITS);
    const report = analyseConversion({
      profile: stlLike({ triangleCount: ceiling }),
      target: ExportFormat.Stl,
    });
    expect(report.exportable).toBe(true);
  });

  it('blocks an OBJ only on a genuine LOWER bound', () => {
    /*
     * A LOWER BOUND CAN ONLY REFUSE THE IMPOSSIBLE. The real length depends on
     * how long each coordinate's decimal spelling turns out to be, so an
     * estimate that pretended to be exact would either refuse files that would
     * have fitted or promise ones that will not. The writer's running count
     * stays authoritative.
     */
    const blocked = analyseConversion({
      profile: stlLike({ triangleCount: 1000 }),
      target: ExportFormat.Obj,
      limits: TINY,
    });
    expect(blocked.verdict).toBe(ConversionVerdict.Blocked);

    const allowed = analyseConversion({
      profile: stlLike({ triangleCount: 30 }),
      target: ExportFormat.Obj,
      limits: TINY,
    });
    expect(allowed.exportable).toBe(true);
  });

  it('leaves 3MF to the writer, because its size depends on compression', () => {
    const report = analyseConversion({
      profile: threeMfLike({ triangleCount: 10_000_000 }),
      target: ExportFormat.ThreeMf,
      limits: TINY,
    });
    expect(featuresIn(report.blockers)).not.toContain(CompatibilityFeature.OutputSize);
  });

  it('does not disable the other targets when one hits its ceiling', () => {
    /*
     * ONE TARGET'S RESOURCE LIMIT IS NOT A PROPERTY OF THE DOCUMENT. A user
     * whose model is too large as OBJ can still write a 3MF, and the workflow
     * must not present the whole export as impossible.
     */
    const large = threeMfLike({ triangleCount: 1000 });
    expect(
      analyseConversion({ profile: large, target: ExportFormat.Obj, limits: TINY }).exportable,
    ).toBe(false);
    expect(
      analyseConversion({ profile: large, target: ExportFormat.ThreeMf, limits: TINY }).exportable,
    ).toBe(true);
  });
});

/* ------------------------------------------------------- verdict rollup -- */

describe('the verdict summarises the facts', () => {
  it('is BLOCKED whenever there is a blocker, whatever else is true', () => {
    const report = analyseConversion({
      profile: profile({
        partCount: 4,
        meshResourceCount: 1,
        threeMfObjectCount: 1,
        nonIdentityTransformCount: 3,
        meshesWithUvs: 1,
      }),
      target: ExportFormat.ThreeMf,
    });
    expect(report.verdict).toBe(ConversionVerdict.Blocked);
    expect(report.exportable).toBe(false);
  });

  it('prefers structure over metadata when both are lost', () => {
    const report = analyseConversion({
      profile: threeMfLike({
        partCount: 3,
        meshResourceCount: 3,
        threeMfObjectCount: 3,
        namedPartCount: 3,
      }),
      target: ExportFormat.Stl,
    });
    // Names are metadata and parts are structure; the summary reports the worse.
    expect(featuresIn(report.losses)).toContain(CompatibilityFeature.PartNames);
    expect(featuresIn(report.losses)).toContain(CompatibilityFeature.PartStructure);
    expect(report.verdict).toBe(ConversionVerdict.LossyStructure);
  });

  it('treats a bake as structural rather than as a label change', () => {
    const report = analyseConversion({
      profile: stlLike({ nonIdentityTransformCount: 1 }),
      target: ExportFormat.Obj,
    });
    expect(report.verdict).toBe(ConversionVerdict.LossyStructure);
  });

  it('is lossless only when nothing at all is lost or transformed', () => {
    const report = analyseConversion({ profile: stlLike(), target: ExportFormat.Stl });
    expect(report.verdict).toBe(ConversionVerdict.Lossless);
    expect(report.losses).toEqual([]);
    expect(report.transformations).toEqual([]);
    expect(report.blockers).toEqual([]);
    expect(report.exportable).toBe(true);
  });

  it('is exportable exactly when there are no blockers', () => {
    /*
     * ENUMERATED ACROSS THE WHOLE FEATURE SPACE rather than spot-checked, because
     * `exportable` is what enables the button and a single combination in which
     * it disagrees with `blockers` is a button that lies.
     */
    const variations: readonly Partial<DocumentFeatureProfile>[] = [
      {},
      { unit: LengthUnit.Inch },
      { partCount: 3, meshResourceCount: 1, threeMfObjectCount: 1 },
      { partCount: 3, meshResourceCount: 1, threeMfObjectCount: 3, namedPartCount: 3 },
      { nonIdentityTransformCount: 2 },
      { namedPartCount: 2, unnamedPartCount: 0 },
      { groupCount: 3, groupMaterialRefCount: 1 },
      { partMaterialRefCount: 2 },
      { meshesWithNormals: 1 },
      { meshesWithUvs: 1 },
      { sourceUnsupported: [UnsupportedFeature.Textures] },
      { triangleCount: 0 },
    ];

    for (const overrides of variations) {
      for (const target of EXPORT_FORMATS) {
        for (const assertion of [undefined, LengthUnit.Millimeter]) {
          const report = analyseConversion({
            profile: profile(overrides),
            target,
            ...(assertion === undefined ? {} : { unitAssertion: assertion }),
          });
          expect(report.exportable).toBe(report.blockers.length === 0);
          expect(report.exportable).toBe(report.verdict !== ConversionVerdict.Blocked);
        }
      }
    }
  });

  it('is deterministic: the same profile and target give the same report', () => {
    const source = threeMfLike({
      partCount: 4,
      meshResourceCount: 2,
      nonIdentityTransformCount: 3,
    });
    const first = analyseConversion({ profile: source, target: ExportFormat.Obj });
    const second = analyseConversion({ profile: source, target: ExportFormat.Obj });
    expect(second).toEqual(first);
  });
});
