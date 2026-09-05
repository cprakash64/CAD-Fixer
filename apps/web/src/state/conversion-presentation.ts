import {
  CompatibilityDisposition,
  CompatibilityFeature,
  ConversionVerdict,
  ExportFormat,
  ExportStatus,
  type CompatibilityFact,
  type ConversionCompatibilityReport,
} from '@cadfixer/file-formats';
import { LengthUnit } from '@cadfixer/shared';

/**
 * HOW A FORMAT CONVERSION IS WORDED FOR A USER, decided once.
 *
 * FRAMEWORK-FREE, exactly like `repair-presentation.ts` and
 * `topology-presentation.ts`, and for the same reason: wording is a correctness
 * concern here. `analyseConversion` produces machine-readable facts and says
 * nothing about them; this file is the ONE place a fact becomes a sentence.
 *
 * WHY THAT MATTERS MORE THAN USUAL. The engine can emit `UNIT_METADATA_DROPPED`
 * while one screen says "Scale preserved" and another says "Units converted" —
 * three statements, one truth, two of them false. A component that wrote its
 * own copy would be one screen away from exactly that. One fact, one approved
 * meaning, asserted by test.
 *
 * THE DISTINCTION THIS FILE IS MOST CAREFUL ABOUT: "the coordinates are
 * unchanged" and "the scale is preserved" are NOT the same statement. The first
 * is true and is what CAD Fixer knows; the second implies the file still says
 * how big the model is, which after an OBJ or STL export it does not.
 */

/**
 * Terms that must never appear in conversion-derived interface text.
 *
 * The first group is inherited from the topology and repair vocabularies — an
 * export screen has no more standing to promise printability than a repair
 * screen does. The rest are the specific claims a conversion screen is tempted
 * to make and cannot support.
 */
export const CONVERSION_FORBIDDEN_TERMS: readonly string[] = Object.freeze([
  'printable',
  'watertight',
  'ready to print',
  'error free',
  'lossless conversion', // true of no conversion in this product without qualification
  'scale preserved', // the numbers are unchanged; the SIZE is not recorded
  'units converted', // nothing is ever rescaled
  'preserves all materials',
  'preserves all textures',
  'nothing is lost',
]);

/* ---------------------------------------------------------------- targets -- */

export interface TargetDescription {
  readonly id: ExportFormat;
  readonly label: string;
  /** One line. What the format holds, not what it is famous for. */
  readonly summary: string;
}

/**
 * The three targets, described by what CAD Fixer actually writes.
 *
 * Not by what the format can express in principle: 3MF supports textures and
 * this writer emits none, so "Parts, placements and units" is the honest
 * summary and "Rich 3D printing format" would not be.
 */
export const TARGET_DESCRIPTIONS: readonly TargetDescription[] = Object.freeze([
  {
    id: ExportFormat.Stl,
    label: 'STL',
    summary: 'One triangle mesh. No parts, no placements, no units.',
  },
  {
    id: ExportFormat.Obj,
    label: 'OBJ',
    summary: 'Named objects and groups. No units; placements are applied to the coordinates.',
  },
  {
    id: ExportFormat.ThreeMf,
    label: '3MF',
    summary: 'Parts, placements, shared geometry and a stated unit.',
  },
]);

export function describeTarget(target: ExportFormat): TargetDescription {
  for (const description of TARGET_DESCRIPTIONS) {
    if (description.id === target) return description;
  }
  // Unreachable while `ExportFormat` and the table agree, and a test pins that.
  return { id: target, label: target, summary: '' };
}

/* ------------------------------------------------------------------ units -- */

export interface UnitChoice {
  readonly value: LengthUnit;
  readonly label: string;
}

/**
 * The six units 3MF can state, and no others.
 *
 * ORDERED SMALLEST TO LARGEST rather than alphabetically or by likelihood.
 * Ordering by likelihood would be a soft default — the first item in a list is
 * the one people pick — and this stage's whole point is that CAD Fixer does not
 * choose a unit on anyone's behalf.
 */
export const UNIT_CHOICES: readonly UnitChoice[] = Object.freeze([
  { value: LengthUnit.Micron, label: 'Microns (µm)' },
  { value: LengthUnit.Millimeter, label: 'Millimetres (mm)' },
  { value: LengthUnit.Centimeter, label: 'Centimetres (cm)' },
  { value: LengthUnit.Inch, label: 'Inches (in)' },
  { value: LengthUnit.Foot, label: 'Feet (ft)' },
  { value: LengthUnit.Meter, label: 'Metres (m)' },
]);

/** A unit token as a reader should see it. Falls back to the token itself. */
export function describeUnitToken(unit: string): string {
  for (const choice of UNIT_CHOICES) {
    if (choice.value === unit) return choice.label;
  }
  return unit;
}

export const UNIT_REQUIRED_HEADLINE = 'Choose what this model’s measurements mean';

/**
 * What choosing a unit does, and — just as importantly — what it does not.
 *
 * The second sentence is the one that has to be there. Users reasonably expect
 * a unit control to resize things, and this one never does: it labels the
 * numbers that are already in the file.
 */
export const UNIT_ASSERTION_EXPLANATION =
  'A 3MF file records what its numbers mean, and this model does not say. Choosing a unit ' +
  'labels the measurements it already has — it does not resize anything. If the model is ' +
  '25 wide, choosing millimetres records 25 mm and choosing inches records 25 in.';

export const UNIT_ASSERTION_SCOPE =
  'This applies to the exported file only. The model in CAD Fixer keeps saying nothing about ' +
  'its units.';

/* ------------------------------------------------------------- severities -- */

/**
 * How strongly a section is presented.
 *
 * FOUR LEVELS, USED SPARINGLY. A conversion that drops a unit is not a danger;
 * turning every expected format limitation into a red alert teaches people to
 * dismiss the panel, and then the one genuinely blocking case is dismissed too.
 */
export const ConversionSeverity = {
  /** Nothing supported is lost. */
  Clear: 'clear',
  /** Labels are lost. Worth knowing, not worth alarm. */
  Note: 'note',
  /** Structure changes shape. Worth reading before proceeding. */
  Caution: 'caution',
  /** Nothing can be written until the user does something. */
  Action: 'action',
} as const;

export type ConversionSeverity = (typeof ConversionSeverity)[keyof typeof ConversionSeverity];

export function verdictSeverity(verdict: ConversionVerdict): ConversionSeverity {
  switch (verdict) {
    case ConversionVerdict.Lossless:
      return ConversionSeverity.Clear;
    case ConversionVerdict.LossyMetadata:
      return ConversionSeverity.Note;
    case ConversionVerdict.LossyStructure:
    case ConversionVerdict.UnsupportedInputFeature:
      return ConversionSeverity.Caution;
    case ConversionVerdict.Blocked:
      return ConversionSeverity.Action;
  }
}

/**
 * The one-line summary of a verdict.
 *
 * `LOSSLESS_FOR_SUPPORTED_FEATURES` becomes "Nothing CAD Fixer holds for this
 * model will be lost" rather than "Lossless": the qualifier is the honest part,
 * because the claim is about what this build supports rather than about the
 * file the user originally had.
 */
export function describeVerdict(verdict: ConversionVerdict): string {
  switch (verdict) {
    case ConversionVerdict.Lossless:
      return 'Nothing CAD Fixer holds for this model will be left out.';
    case ConversionVerdict.LossyMetadata:
      return 'The shape is written exactly. Some labels this format cannot store are left out.';
    case ConversionVerdict.LossyStructure:
      return 'The shape is written exactly. How the model is put together changes to fit this format.';
    case ConversionVerdict.UnsupportedInputFeature:
      return 'This model holds data this format cannot carry. The triangles are written exactly.';
    case ConversionVerdict.Blocked:
      return 'This file cannot be written yet.';
  }
}

/* ------------------------------------------------------------------ facts -- */

/**
 * ONE FACT, ONE SENTENCE. The exhaustive switch has no `default` on purpose.
 *
 * A new `CompatibilityFeature` therefore fails to compile until it is worded
 * here, which is the whole mechanism: the alternative is a fallback string that
 * silently ships as the wording for something nobody described.
 */
export function describeFact(fact: CompatibilityFact): string {
  const count = fact.count ?? 0;
  const plural = count === 1 ? '' : 's';

  switch (fact.feature) {
    case CompatibilityFeature.PhysicalUnit:
      if (fact.disposition === CompatibilityDisposition.RequiresUserAssertion) {
        return 'This format records what the measurements mean, and this model does not say.';
      }
      if (fact.disposition === CompatibilityDisposition.Preserved) {
        return `The file will record that the measurements are in ${describeUnitToken(fact.unit ?? '')}.`;
      }
      /*
       * THE MOST IMPORTANT SENTENCE IN THIS FILE.
       *
       * It says the numbers do not change AND that the file will not say what
       * they mean. Either half alone is misleading: "the unit is not stored"
       * invites the fear that something was rescaled, and "the coordinates are
       * unchanged" invites the belief that the size survived.
       */
      return (
        `This format stores no unit, so the file will not say that the measurements are in ` +
        `${describeUnitToken(fact.unit ?? '')}. The numbers themselves are written unchanged — ` +
        'nothing is resized.'
      );

    case CompatibilityFeature.PartStructure:
      return fact.disposition === CompatibilityDisposition.Preserved
        ? `All ${count.toLocaleString()} parts are written as separate objects.`
        : `All ${count.toLocaleString()} parts are merged into one mesh. The file will not say where one part ends and the next begins.`;

    case CompatibilityFeature.Transforms:
      return fact.disposition === CompatibilityDisposition.Preserved
        ? `${count.toLocaleString()} part placement${plural} are written as placements, so they can still be moved.`
        : `${count.toLocaleString()} part placement${plural} are applied to the coordinates. Everything ends up where you see it, but the placement is no longer a separate thing the file records.`;

    case CompatibilityFeature.PartNames:
      if (fact.disposition === CompatibilityDisposition.Preserved) {
        return `${count.toLocaleString()} part name${plural} are written into the file.`;
      }
      if (fact.disposition === CompatibilityDisposition.Canonicalized) {
        return `${count.toLocaleString()} part${plural} without a name are given a generated one, so they stay separate objects.`;
      }
      return `${count.toLocaleString()} part name${plural} are not written. This format has nowhere to put a name.`;

    case CompatibilityFeature.Groups:
      return fact.disposition === CompatibilityDisposition.Preserved
        ? `${count.toLocaleString()} face group${plural} are written into the file.`
        : `${count.toLocaleString()} face group${plural} are not written.`;

    case CompatibilityFeature.PartMaterialReferences:
      /*
       * THE QUALIFIER IS NOT OPTIONAL. CAD Fixer writes no material resource for
       * the reference to point at, in any format — so "keeps the material" would
       * promise a colour that will not appear. The name survives; the material
       * does not exist.
       */
      return fact.disposition === CompatibilityDisposition.Preserved
        ? `${count.toLocaleString()} part${plural} keep the material name they refer to. CAD Fixer writes no material definitions, so the name is carried without anything to define it.`
        : `${count.toLocaleString()} part${plural} refer to a material by name, and this format has nowhere to record that on a part.`;

    case CompatibilityFeature.GroupMaterialReferences:
      return fact.disposition === CompatibilityDisposition.Preserved
        ? `${count.toLocaleString()} face group${plural} keep the material name they refer to. CAD Fixer writes no material library, so the names point at nothing.`
        : `${count.toLocaleString()} face group${plural} refer to a material by name, and that name is not written.`;

    case CompatibilityFeature.MeshSharing:
      /*
       * THE PRESERVED COUNT IS THE NUMBER OF PLACEMENTS THAT REUSE GEOMETRY, and
       * the dropped one is the number of copies written because the parts
       * sharing a shape disagreed about their name or material. 3MF puts both on
       * the object rather than on the placement, so keeping the names costs a
       * copy — and saying "sharing is preserved" without that would be a
       * promise the writer cannot keep for every document.
       */
      return fact.disposition === CompatibilityDisposition.Preserved
        ? `${count.toLocaleString()} repeated placement${plural} reuse one copy of the geometry in the file.`
        : `${count.toLocaleString()} repeated shape${plural} are written out in full, one copy each. The file will be larger, and it will not record that they were the same shape.`;

    case CompatibilityFeature.Normals:
      return `${count.toLocaleString()} mesh${count === 1 ? '' : 'es'} carry stored vertex normals. CAD Fixer does not write them; shading is recalculated from the triangles.`;

    case CompatibilityFeature.TextureCoordinates:
      return `${count.toLocaleString()} mesh${count === 1 ? '' : 'es'} carry texture coordinates. CAD Fixer does not write them.`;

    case CompatibilityFeature.OutputSize:
      /*
       * "AT LEAST", NOT "ABOUT". For STL the number is exact; for OBJ it is a
       * proven lower bound, and describing a lower bound as an estimate would
       * understate how far past the limit the file is.
       */
      return (
        'This model is too large to write as this format here. ' +
        `It would need at least ${formatBytes(fact.bytes ?? 0)}, and the limit is ${formatBytes(fact.limitBytes ?? 0)}.`
      );

    /* --- SOURCE facts. About the file that was OPENED. --- */
    case CompatibilityFeature.SourceTextures:
      return 'The original file contained texture information that CAD Fixer did not import. Exporting cannot put it back.';
    case CompatibilityFeature.SourceMaterials:
      return 'The original file contained colour or material definitions that CAD Fixer did not import. Exporting cannot put them back.';
    case CompatibilityFeature.SourceMaterialLibrary:
      return 'The original file referred to a separate material library. CAD Fixer never opens it, so its contents were never available to export.';
    case CompatibilityFeature.SourceUnreferencedObjects:
      return 'The original file defined shapes its build never placed. They were not imported, so they are not in the export either.';
    case CompatibilityFeature.SourceComponentHierarchy:
      return 'The original file nested its objects inside components. Every placement was imported in the right position, but the nesting itself was not kept and cannot be rebuilt on export.';
  }
}

/* ---------------------------------------------------------------- headings -- */

export const LOSSLESS_HEADLINE = 'No supported information will be left out';
export const METADATA_LOSS_HEADLINE = 'Labels this format cannot store';
export const STRUCTURE_LOSS_HEADLINE = 'How the model is put together will change';
export const BLOCKED_HEADLINE = 'Something is needed before this can be written';
export const ASSUMPTIONS_HEADLINE = 'What the file will state that the model does not';
export const SOURCE_WARNINGS_HEADLINE = 'Already missing when this file was opened';
export const PRESERVED_HEADLINE = 'Written into the file';

/**
 * The qualifier that follows every conversion result.
 *
 * The same shape as the repair and topology qualifiers, and it is here for the
 * same reason: a validated export is a statement about the FILE, and someone
 * reading "validated" beside a 3D model will hear "checked and fine to print"
 * unless told otherwise.
 */
export const CONVERSION_QUALIFIER =
  'CAD Fixer reads every file it writes back in and checks it describes the same model. That ' +
  'is a check on the file, not on the model: self-intersections and wall thickness are still ' +
  'not examined.';

/* ---------------------------------------------------------- loss grouping -- */

/**
 * Splits the losses into the two registers the interface shows them in.
 *
 * A dropped unit and a merged part list are both "losses" to the engine and are
 * very different things to a person: one is a label, the other changes what the
 * file is. Deciding it here rather than in the component keeps the grouping
 * consistent between the summary and the detail.
 */
export function metadataLosses(
  report: ConversionCompatibilityReport,
): readonly CompatibilityFact[] {
  return report.losses.filter((fact) => !isStructural(fact));
}

export function structuralLosses(
  report: ConversionCompatibilityReport,
): readonly CompatibilityFact[] {
  return report.losses.filter((fact) => isStructural(fact));
}

function isStructural(fact: CompatibilityFact): boolean {
  return (
    fact.feature === CompatibilityFeature.PartStructure ||
    fact.feature === CompatibilityFeature.MeshSharing
  );
}

/* ------------------------------------------------------------- outcomes -- */

/**
 * What an export OUTCOME says, keyed by its machine-readable status.
 *
 * Actionable cases are distinguished from ones the user can only be told about,
 * because "try again" and "this file cannot be made" call for different
 * behaviour and a single "Export failed" hides which one happened.
 */
export function describeExportFailure(status: ExportStatus, reason: string | undefined): string {
  switch (status) {
    case ExportStatus.BlockedUnitRequired:
      return 'A 3MF file has to state what its measurements mean, and this model does not say. Choose a unit and try again.';
    case ExportStatus.ResourceLimit:
      return 'This model is too large to write as this format in a browser, so nothing was saved. A format that stores repeated shapes once may fit where this one does not.';
    case ExportStatus.Cancelled:
      return 'Export cancelled. No file was saved, and the model is unchanged.';
    case ExportStatus.StaleRevision:
      return 'The model changed while the file was being written, so the file was discarded. Nothing was saved. Try again.';
    case ExportStatus.ValidationFailed:
      /*
       * OURS, AND SAID SO. A validation failure means our writer and our reader
       * disagree. Telling someone their model is at fault for that would be a
       * lie with their name on it.
       */
      return 'CAD Fixer wrote a file it could not read back as the same model, so it was not saved. This is a problem with CAD Fixer, not with your model.';
    case ExportStatus.InternalFailure:
    case ExportStatus.Success:
      return reason === undefined
        ? 'The export did not finish. Nothing was saved.'
        : 'The export did not finish. Nothing was saved.';
  }
}

/* -------------------------------------------------------------- progress -- */

/**
 * The phases an export actually has, in the order they happen.
 *
 * DERIVED FROM THE WRITERS' OWN NOTES rather than invented. `exportDocument`
 * reports `writing`, `compressing`, `validating` and `complete`; anything else
 * would be a smooth-looking bar that meant nothing.
 */
export const ExportPhaseLabel: Readonly<Record<string, string>> = Object.freeze({
  writing: 'Writing',
  'writing model': 'Writing',
  compressing: 'Compressing',
  validating: 'Checking the file reads back correctly',
  complete: 'Ready',
});

export function describePhase(note: string | undefined): string {
  if (note === undefined) return 'Preparing';
  return ExportPhaseLabel[note] ?? 'Preparing';
}

/* --------------------------------------------------------------- helpers -- */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export { formatBytes as formatExportBytes };
