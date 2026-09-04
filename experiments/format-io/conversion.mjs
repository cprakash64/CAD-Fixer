/**
 * Stage 4A-1-R1 — executable conversion compatibility report. RESEARCH ONLY.
 *
 * The report is computed BEFORE a conversion runs, from what the document holds
 * and what the target format can express. That ordering matters: a user is
 * entitled to know what they are about to lose while they can still decline.
 */

export const ConversionVerdict = {
  Lossless: 'LOSSLESS_FOR_SUPPORTED_FEATURES',
  LossyMetadata: 'LOSSY_METADATA',
  LossyStructure: 'LOSSY_STRUCTURE',
  UnsupportedInput: 'UNSUPPORTED_INPUT_FEATURE',
  Blocked: 'BLOCKED',
};

/** What each target format can carry, as an explicit capability statement. */
const TARGETS = {
  stl: { parts: 1, units: false, names: false, materials: false, transforms: false },
  obj: { parts: Infinity, units: false, names: true, materials: 'reference', transforms: false },
  '3mf': {
    parts: Infinity,
    units: 'required',
    names: true,
    materials: 'reference',
    transforms: true,
  },
};

const isIdentity = (t) =>
  t === undefined || t.every((v, i) => v === [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0][i]);

/**
 * Describes what converting `document` to `target` would cost.
 *
 * Returns every applicable finding, not just the worst one: "you will lose the
 * unit" and "you will lose three of four parts" are different facts and a user
 * needs both.
 */
export function analyseConversion(document, target, options = {}) {
  const capability = TARGETS[target];
  if (capability === undefined) {
    return {
      verdict: ConversionVerdict.Blocked,
      findings: [{ code: 'UNKNOWN_TARGET', detail: target }],
    };
  }

  const findings = [];

  // BLOCKING comes first: a conversion that cannot honestly be performed is not
  // a lossy conversion, it is one that must not start.
  if (capability.units === 'required' && document.unit === undefined) {
    findings.push({
      code: 'UNIT_REQUIRED',
      detail: `${target} requires a declared unit and the source states none`,
    });
    if (options.unitOverride === undefined) {
      return { verdict: ConversionVerdict.Blocked, findings };
    }
    // An explicit user choice turns a block into a recorded added claim.
    findings.push({
      code: 'UNIT_ASSERTED_BY_USER',
      detail: `unit "${String(options.unitOverride)}" was chosen, not read from the source`,
    });
  }

  if (document.unsupported !== undefined && document.unsupported.length > 0) {
    findings.push({ code: 'UNSUPPORTED_SOURCE_FEATURE', detail: document.unsupported.join(', ') });
  }

  if (capability.parts !== Infinity && document.parts.length > capability.parts) {
    findings.push({
      code: 'PARTS_FLATTENED',
      detail: `${String(document.parts.length)} parts become ${String(capability.parts)}`,
    });
  }

  if (capability.transforms === false && document.parts.some((p) => !isIdentity(p.transform))) {
    findings.push({
      code: 'TRANSFORMS_BAKED',
      detail: 'placements must be applied to coordinates because the target cannot express them',
    });
  }

  if (capability.units === false && document.unit !== undefined) {
    findings.push({
      code: 'UNIT_LOST',
      detail: `source unit "${document.unit}" is not representable`,
    });
  }

  if (capability.names === false && document.parts.some((p) => p.name !== undefined)) {
    findings.push({ code: 'NAMES_LOST', detail: 'the target has no place for part names' });
  }

  if (capability.materials === false && document.parts.some((p) => p.materialRef !== undefined)) {
    findings.push({ code: 'MATERIALS_LOST', detail: 'material references are not representable' });
  }

  const has = (code) => findings.some((f) => f.code === code);
  const verdict = has('UNSUPPORTED_SOURCE_FEATURE')
    ? ConversionVerdict.UnsupportedInput
    : has('PARTS_FLATTENED') || has('TRANSFORMS_BAKED')
      ? ConversionVerdict.LossyStructure
      : findings.length > 0
        ? ConversionVerdict.LossyMetadata
        : ConversionVerdict.Lossless;

  return { verdict, findings };
}
