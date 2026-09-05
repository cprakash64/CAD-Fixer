import { MeshFormatId } from '../formats';
import { UnsupportedFeature } from '../document-reader';
import { DEFAULT_EXPORT_LIMITS, type ExportLimits } from './export-contract';
/*
 * THE LEAF MODULES, AND THE REASON THIS FILE NAMES THEM DIRECTLY.
 *
 * This policy runs on the MAIN THREAD. Importing the same constants from the
 * STL writer and the 3MF reader let the bundler follow THEIR imports — ASCII
 * keyword tables, the XML scanner, the ZIP reader — into the application
 * bundle, so a dialog that multiplies by fifty shipped a parser to every user.
 * `stl-layout.ts` and `threemf/units.ts` import nothing, so nothing arrives
 * with them, and there is still exactly one definition of each number.
 */
import { maxStlDocumentTriangles, binaryStlByteLength } from './stl-layout';
import { THREE_MF_UNITS } from '../threemf/units';

/**
 * CAN THIS DOCUMENT BE SAVED AS THIS FORMAT, AND WHAT WILL CHANGE?
 *
 * That is the whole question, and this file answers it as FACTS rather than as
 * sentences. `conversion-presentation.ts` in the application turns each fact
 * into exactly one approved wording; deciding the wording here would put the
 * same copy in two places, which is the drift `repair-presentation.ts` exists
 * to prevent.
 *
 * THE ANSWER COMES FROM THE DOCUMENT, NEVER FROM THE TARGET'S NAME. "OBJ loses
 * units" is a fact about OBJ; whether THIS conversion loses a unit depends on
 * whether this document has one. A report that warned about flattened parts on
 * a one-part model, or about dropped names on a document with no names, would
 * teach a user that the list is noise — and the one time it mattered they would
 * not read it.
 *
 * PURE, AND DELIBERATELY SO. It takes scalars and returns a value. There is no
 * geometry here, no worker, no clock and no randomness, so the entire policy
 * can be tested exhaustively without a browser — which is where policy
 * correctness has to be established, because an end-to-end test can only ever
 * sample it.
 */

/* ---------------------------------------------------------------- targets -- */

/** The formats CAD Fixer can write. Not a wish list: each one has a writer. */
export const ExportFormat = {
  Stl: MeshFormatId.Stl,
  Obj: MeshFormatId.Obj,
  ThreeMf: MeshFormatId.ThreeMf,
} as const;

export type ExportFormat = (typeof ExportFormat)[keyof typeof ExportFormat];

export const EXPORT_FORMATS: readonly ExportFormat[] = Object.freeze([
  ExportFormat.Stl,
  ExportFormat.Obj,
  ExportFormat.ThreeMf,
]);

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------- profile -- */

/**
 * SCALAR FACTS ABOUT A DOCUMENT. No geometry, and none needed.
 *
 * Every field is a count, a flag or a short token, so the whole profile costs a
 * few dozen bytes for a thousand-part document and the main thread can hold one
 * without owning anything it must not own (ADR 0008). It is derived from part
 * descriptors the page already has — which is what makes the report recompute
 * for free when the model changes, rather than being fetched and then going
 * stale while a dialog is open.
 */
export interface DocumentFeatureProfile {
  readonly partCount: number;
  /** Distinct meshes. Fewer than `partCount` means parts share geometry. */
  readonly meshResourceCount: number;
  /**
   * How many `<object>` records a 3MF export would write.
   *
   * MIRRORS `planThreeMfObjects`, which groups by (mesh, NAME) — the metadata
   * the `<object>` element actually carries. Two placements of one mesh under
   * two different names are, in 3MF's own model, two objects; two under two
   * different MATERIAL references are one, because no material reference is
   * written.
   *
   * WHY THE POLICY NEEDS IT. Without this the report could only say "sharing is
   * preserved" and hope — and for parts that disagree about their name it would
   * have been saying something false, which is exactly the kind of unearned
   * lossless claim this report exists to prevent. The page can compute it
   * exactly from part descriptors, so it does.
   */
  readonly threeMfObjectCount: number;
  readonly triangleCount: number;
  /** The DOCUMENT's unit. `undefined` means unknown and is never defaulted. */
  readonly unit: string | undefined;
  readonly nonIdentityTransformCount: number;
  readonly namedPartCount: number;
  readonly unnamedPartCount: number;
  /** Canonical groups, summed over DISTINCT meshes. */
  readonly groupCount: number;
  /** Groups that name a material. A subset of `groupCount`. */
  readonly groupMaterialRefCount: number;
  /** Parts that name a material. 3MF puts this on the object; OBJ cannot. */
  readonly partMaterialRefCount: number;
  /** Distinct meshes carrying stored per-vertex normals. */
  readonly meshesWithNormals: number;
  /** Distinct meshes carrying stored per-vertex texture coordinates. */
  readonly meshesWithUvs: number;
  /**
   * Part names that OBJ cannot spell as written.
   *
   * OBJ has no escape mechanism: a control character in a name would end the
   * record and turn the rest into geometry, and runs of whitespace cannot be
   * distinguished from a single space. Both are small, real losses, and until
   * this stage they happened silently — Stage 4A-2B3 recorded them as a known
   * limitation because the profile deliberately holds no names.
   *
   * A COUNT IS ENOUGH, and a count is all this may ever hold. Putting the names
   * themselves in a compatibility fact would put untrusted text one render away
   * from markup, and would create a second place display copy lived.
   */
  readonly namesUnwritableAsObj: number;
  /** Part names containing characters XML cannot carry at all. See above. */
  readonly namesUnwritableAsXml: number;
  /**
   * What the source file contained and the import did not carry across.
   *
   * TYPED AS STRINGS, not as `UnsupportedFeature`, because these values crossed
   * a worker boundary: a token this build does not recognise must be
   * REPRESENTABLE and then ignored, rather than being asserted into an enum it
   * may not belong to. `sourceFacts` matches the ones it knows and drops the
   * rest, which is the behaviour a version skew needs.
   */
  readonly sourceUnsupported: readonly string[];
  /** The format the document was read from, when one is known. */
  readonly sourceFormat?: string;
}

/** Placements beyond the first of each shared mesh. Zero when nothing is shared. */
export function sharedPlacementCount(profile: DocumentFeatureProfile): number {
  return Math.max(0, profile.partCount - profile.meshResourceCount);
}

/* ------------------------------------------------------------------ facts -- */

/**
 * The document capabilities a conversion has to answer for.
 *
 * A FEATURE IS SOMETHING A DOCUMENT CAN HAVE, not something a format lacks.
 * That orientation is what keeps the report about the user's model.
 */
export const CompatibilityFeature = {
  PhysicalUnit: 'PHYSICAL_UNIT',
  PartStructure: 'PART_STRUCTURE',
  Transforms: 'TRANSFORMS',
  PartNames: 'PART_NAMES',
  Groups: 'GROUPS',
  PartMaterialReferences: 'PART_MATERIAL_REFERENCES',
  GroupMaterialReferences: 'GROUP_MATERIAL_REFERENCES',
  MeshSharing: 'MESH_SHARING',
  /**
   * Names that cannot be written exactly as the document holds them.
   *
   * SEPARATE FROM `PartNames`, which is about a name being kept or dropped.
   * This is about a name being kept in a CHANGED form, which is a different
   * thing to tell someone and applies only to targets that write names at all.
   */
  NameCharacters: 'NAME_CHARACTERS',
  Normals: 'NORMALS',
  TextureCoordinates: 'TEXTURE_COORDINATES',
  /*
   * THERE IS NO TARGET-SIDE `ComponentHierarchy` FEATURE, deliberately.
   *
   * A `GeometryDocument` holds flat placements: the nesting an imported 3MF may
   * have had was not retained on the way IN, so no export can be said to lose
   * it. The honest place for that fact is `SourceComponentHierarchy` below,
   * beside the other things that went when the file was opened. A second,
   * target-side name for the same loss would report it twice and imply the
   * chosen format caused it.
   */
  /** The size of the artifact this conversion would produce. */
  OutputSize: 'OUTPUT_SIZE',

  /* --- SOURCE facts. About the FILE that was opened, not about the target. --- */
  SourceTextures: 'SOURCE_TEXTURES',
  SourceMaterials: 'SOURCE_MATERIALS',
  SourceMaterialLibrary: 'SOURCE_MATERIAL_LIBRARY',
  SourceUnreferencedObjects: 'SOURCE_UNREFERENCED_OBJECTS',
  SourceComponentHierarchy: 'SOURCE_COMPONENT_HIERARCHY',
} as const;

export type CompatibilityFeature = (typeof CompatibilityFeature)[keyof typeof CompatibilityFeature];

/** What happens to a feature in this conversion. */
export const CompatibilityDisposition = {
  /** Written into the file and readable back. */
  Preserved: 'PRESERVED',
  /** Expressed by changing coordinates, because the target has no other way. */
  Baked: 'BAKED',
  /** Not written. The information is not in the file. */
  Dropped: 'DROPPED',
  /** Written, but in a normalised shape rather than the source's. */
  Canonicalized: 'CANONICALIZED',
  /** The user has to state something before the file can be written at all. */
  RequiresUserAssertion: 'REQUIRES_USER_ASSERTION',
  /** The target cannot hold this and the document has it. Nothing to be done. */
  Unsupported: 'UNSUPPORTED',
  /** Refused before it starts, on a ceiling known without writing anything. */
  ResourceLimit: 'RESOURCE_LIMIT',
} as const;

export type CompatibilityDisposition =
  (typeof CompatibilityDisposition)[keyof typeof CompatibilityDisposition];

/**
 * ONE FACT. Machine-readable, with scalar detail and no prose.
 *
 * `count` and `unit` exist so the copy layer can say "3 parts" and "inch"
 * without this file deciding a sentence. Nothing else is carried: a fact that
 * held a filename or a part name would be a fact that could carry hostile text
 * into markup, and it would be a second place display copy lived.
 */
export interface CompatibilityFact {
  readonly feature: CompatibilityFeature;
  readonly disposition: CompatibilityDisposition;
  /** How many of the thing this fact is about, when the number is meaningful. */
  readonly count?: number;
  /** A unit token, for the unit facts only. Always one of `THREE_MF_UNITS`. */
  readonly unit?: string;
  /** Bytes, for `OutputSize` only. */
  readonly bytes?: number;
  readonly limitBytes?: number;
}

/* --------------------------------------------------------------- verdicts -- */

/**
 * THE SUMMARY. The facts are the truth; this is what fits on one line.
 *
 * PRECEDENCE IS FROZEN AND TOTAL, in this order:
 *
 *   BLOCKED > UNSUPPORTED_INPUT_FEATURE > LOSSY_STRUCTURE > LOSSY_METADATA
 *   > LOSSLESS_FOR_SUPPORTED_FEATURES
 *
 * Deterministic because two documents that produce the same facts must produce
 * the same verdict, and because a user comparing three targets is comparing
 * these five words before anything else.
 */
export const ConversionVerdict = {
  /** Nothing this document holds and this build supports is lost. */
  Lossless: 'LOSSLESS_FOR_SUPPORTED_FEATURES',
  /** Labels are lost; the geometry and the structure survive. */
  LossyMetadata: 'LOSSY_METADATA',
  /** Parts, placements or sharing change shape to fit the target. */
  LossyStructure: 'LOSSY_STRUCTURE',
  /**
   * The document holds geometry data the target cannot express at all.
   *
   * DELIBERATELY NARROW. This is NOT where a source-import warning goes: a
   * texture that was never imported is not something this conversion is doing,
   * and putting it here would make every 3MF-with-textures conversion look
   * worse than it is. It is for per-vertex attributes the current document
   * genuinely carries and no writer can write.
   */
  UnsupportedInputFeature: 'UNSUPPORTED_INPUT_FEATURE',
  /** The file cannot be written until something changes. */
  Blocked: 'BLOCKED',
} as const;

export type ConversionVerdict = (typeof ConversionVerdict)[keyof typeof ConversionVerdict];

const VERDICT_RANK: Readonly<Record<ConversionVerdict, number>> = {
  [ConversionVerdict.Lossless]: 0,
  [ConversionVerdict.LossyMetadata]: 1,
  [ConversionVerdict.LossyStructure]: 2,
  [ConversionVerdict.UnsupportedInputFeature]: 3,
  [ConversionVerdict.Blocked]: 4,
};

/** Ranks two verdicts by the frozen precedence. Exported so a test can pin it. */
export function strongerVerdict(a: ConversionVerdict, b: ConversionVerdict): ConversionVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

/* ----------------------------------------------------------------- report -- */

export interface ConversionCompatibilityReport {
  readonly sourceFormat: string | undefined;
  readonly targetFormat: ExportFormat;
  readonly verdict: ConversionVerdict;
  /** Nothing can be written until every one of these is resolved. */
  readonly blockers: readonly CompatibilityFact[];
  /** Information the file will not contain. */
  readonly losses: readonly CompatibilityFact[];
  /** Information that survives in a changed form. */
  readonly transformations: readonly CompatibilityFact[];
  /** Things the file will state that the document did not. */
  readonly assumptions: readonly CompatibilityFact[];
  /** What was already lost when the file was OPENED. Not caused by this target. */
  readonly sourceImportWarnings: readonly CompatibilityFact[];
  /** Everything the target does keep. Shown to justify a lossless verdict. */
  readonly preserved: readonly CompatibilityFact[];
  /** True when this target can be written as things stand. */
  readonly exportable: boolean;
}

export interface ConversionRequest {
  readonly profile: DocumentFeatureProfile;
  readonly target: ExportFormat;
  /**
   * What the user says the document's numbers mean, for this export only.
   *
   * IGNORED when the document already states a unit — the same precedence
   * `exportSnapshotOf` applies, stated in both places because both are reached
   * independently and a disagreement between them would show one thing and
   * write another.
   */
  readonly unitAssertion?: string;
  readonly limits?: ExportLimits;
}

/* ------------------------------------------------------------ the policy -- */

function fact(
  feature: CompatibilityFeature,
  disposition: CompatibilityDisposition,
  extra: Omit<CompatibilityFact, 'feature' | 'disposition'> = {},
): CompatibilityFact {
  return { feature, disposition, ...extra };
}

/**
 * A lower bound on the OBJ text one triangle produces.
 *
 * The same constant the OBJ writer preflights against, restated here rather
 * than guessed: three vertex records and a face record cannot be spelled in
 * fewer than about thirty bytes even with single-digit numbers. A LOWER bound
 * is the only honest kind here, because the real length depends on how long
 * each coordinate's decimal spelling turns out to be — so this refuses the
 * clearly impossible and leaves everything else to the writer's running count.
 */
const OBJ_MINIMUM_BYTES_PER_TRIANGLE = 30;

/**
 * Whether this conversion is already known to be too large, before writing.
 *
 * STL IS EXACT. Binary STL is fixed-width, so `84 + n * 50` is the artifact's
 * real size and a refusal here is a certainty rather than an estimate.
 *
 * OBJ IS A LOWER BOUND, so it catches the obviously impossible and nothing
 * more. 3MF gets no preflight at all: its size depends on how well the XML
 * compresses, and a made-up bound would either refuse files that would have
 * fitted or promise ones that will not. The writers' own incremental ceilings
 * stay authoritative in every case — this only ever moves a refusal EARLIER.
 */
function outputSizeBlocker(
  target: ExportFormat,
  triangleCount: number,
  limits: ExportLimits,
): CompatibilityFact | undefined {
  if (target === ExportFormat.Stl) {
    if (triangleCount > maxStlDocumentTriangles(limits.maxOutputBytes)) {
      return fact(CompatibilityFeature.OutputSize, CompatibilityDisposition.ResourceLimit, {
        bytes: binaryStlByteLength(triangleCount),
        limitBytes: limits.maxOutputBytes,
      });
    }
    return undefined;
  }
  if (target === ExportFormat.Obj) {
    const floor = triangleCount * OBJ_MINIMUM_BYTES_PER_TRIANGLE;
    if (floor > limits.maxOutputBytes) {
      return fact(CompatibilityFeature.OutputSize, CompatibilityDisposition.ResourceLimit, {
        bytes: floor,
        limitBytes: limits.maxOutputBytes,
      });
    }
    return undefined;
  }
  return undefined;
}

/** The source-file facts, which are the same whatever the target is. */
function sourceFacts(profile: DocumentFeatureProfile): readonly CompatibilityFact[] {
  const facts: CompatibilityFact[] = [];
  for (const feature of profile.sourceUnsupported) {
    switch (feature) {
      case UnsupportedFeature.Textures:
        facts.push(fact(CompatibilityFeature.SourceTextures, CompatibilityDisposition.Dropped));
        break;
      case UnsupportedFeature.Materials:
        facts.push(fact(CompatibilityFeature.SourceMaterials, CompatibilityDisposition.Dropped));
        break;
      case UnsupportedFeature.ExternalMaterialLibrary:
        facts.push(
          fact(CompatibilityFeature.SourceMaterialLibrary, CompatibilityDisposition.Dropped),
        );
        break;
      case UnsupportedFeature.UnreferencedObject:
        facts.push(
          fact(CompatibilityFeature.SourceUnreferencedObjects, CompatibilityDisposition.Dropped),
        );
        break;
      case UnsupportedFeature.ComponentHierarchy:
        facts.push(
          fact(
            CompatibilityFeature.SourceComponentHierarchy,
            CompatibilityDisposition.Canonicalized,
          ),
        );
        break;
      default:
        break;
    }
  }
  return facts;
}

/**
 * THE ONE PLACE A CONVERSION IS JUDGED.
 *
 * Everything the workflow shows, enables and disables comes from here, and
 * nothing recomputes any part of it independently.
 */
export function analyseConversion(request: ConversionRequest): ConversionCompatibilityReport {
  const { profile, target } = request;
  const limits = request.limits ?? DEFAULT_EXPORT_LIMITS;

  const blockers: CompatibilityFact[] = [];
  const losses: CompatibilityFact[] = [];
  const transformations: CompatibilityFact[] = [];
  const assumptions: CompatibilityFact[] = [];
  const preserved: CompatibilityFact[] = [];

  const shared = sharedPlacementCount(profile);
  const assertion =
    profile.unit === undefined && request.unitAssertion !== undefined
      ? request.unitAssertion
      : undefined;

  /* ---------------------------------------------------------- the unit -- */

  if (target === ExportFormat.ThreeMf) {
    if (profile.unit !== undefined) {
      preserved.push(
        fact(CompatibilityFeature.PhysicalUnit, CompatibilityDisposition.Preserved, {
          unit: profile.unit,
        }),
      );
    } else if (assertion === undefined) {
      /*
       * THE ONE BLOCKER THIS PRODUCT HAS, and it is a requirement rather than a
       * failure. 3MF declares a unit for everything it contains; this document
       * declares none, and CAD Fixer will not pick one. Nothing here defaults
       * to millimetres, and nothing infers a unit from a filename, from the
       * model's dimensions, from the source extension or from what a printer
       * usually expects.
       */
      blockers.push(
        fact(CompatibilityFeature.PhysicalUnit, CompatibilityDisposition.RequiresUserAssertion),
      );
    } else if (!THREE_MF_UNITS.includes(assertion)) {
      // A unit 3MF cannot express is not a choice this can act on. Treated as
      // an unmade choice rather than silently substituted.
      blockers.push(
        fact(CompatibilityFeature.PhysicalUnit, CompatibilityDisposition.RequiresUserAssertion),
      );
    } else {
      assumptions.push(
        fact(CompatibilityFeature.PhysicalUnit, CompatibilityDisposition.Preserved, {
          unit: assertion,
        }),
      );
    }
  } else if (profile.unit !== undefined) {
    /*
     * A KNOWN UNIT, AND NOWHERE TO PUT IT. Neither STL nor OBJ records one.
     * The coordinates are NOT rescaled to compensate: changing the numbers to
     * preserve a label the file cannot hold would be inventing data. This is
     * metadata loss, and the copy layer must say exactly that rather than
     * anything resembling "scale preserved".
     */
    losses.push(
      fact(CompatibilityFeature.PhysicalUnit, CompatibilityDisposition.Dropped, {
        unit: profile.unit,
      }),
    );
  }

  /* ---------------------------------------------------- part structure -- */

  if (profile.partCount > 1) {
    if (target === ExportFormat.Stl) {
      losses.push(
        fact(CompatibilityFeature.PartStructure, CompatibilityDisposition.Dropped, {
          count: profile.partCount,
        }),
      );
    } else {
      preserved.push(
        fact(CompatibilityFeature.PartStructure, CompatibilityDisposition.Preserved, {
          count: profile.partCount,
        }),
      );
    }
  }

  /* --------------------------------------------------------- placements -- */

  if (profile.nonIdentityTransformCount > 0) {
    if (target === ExportFormat.ThreeMf) {
      preserved.push(
        fact(CompatibilityFeature.Transforms, CompatibilityDisposition.Preserved, {
          count: profile.nonIdentityTransformCount,
        }),
      );
    } else {
      /*
       * BAKED, WHICH IS A TRANSFORMATION AND NOT A LOSS. Every part ends up
       * exactly where the document put it; what is gone is the ability to move
       * it again by editing a placement. Calling it a loss would overstate it,
       * and calling it lossless would understate it.
       */
      transformations.push(
        fact(CompatibilityFeature.Transforms, CompatibilityDisposition.Baked, {
          count: profile.nonIdentityTransformCount,
        }),
      );
    }
  }

  /* -------------------------------------------------------------- names -- */

  if (profile.namedPartCount > 0) {
    if (target === ExportFormat.Stl) {
      losses.push(
        fact(CompatibilityFeature.PartNames, CompatibilityDisposition.Dropped, {
          count: profile.namedPartCount,
        }),
      );
    } else {
      preserved.push(
        fact(CompatibilityFeature.PartNames, CompatibilityDisposition.Preserved, {
          count: profile.namedPartCount,
        }),
      );
    }
  }
  /*
   * NAMES THAT CANNOT BE WRITTEN AS THEY STAND.
   *
   * ONLY FOR TARGETS THAT WRITE NAMES. STL drops every name, and it already
   * says so — adding "and some of them would have been adjusted" to a name that
   * is not written at all would be noise about a loss inside a larger loss.
   */
  if (target !== ExportFormat.Stl) {
    const affected =
      target === ExportFormat.Obj ? profile.namesUnwritableAsObj : profile.namesUnwritableAsXml;
    if (affected > 0) {
      transformations.push(
        fact(CompatibilityFeature.NameCharacters, CompatibilityDisposition.Canonicalized, {
          count: affected,
        }),
      );
    }
  }

  if (target === ExportFormat.Obj && profile.unnamedPartCount > 0) {
    /*
     * AN ADDITION, NOT A LOSS, and that is why it is an ASSUMPTION.
     *
     * OBJ separates objects with a named `o` record, so an unnamed part is given
     * a generated name rather than being merged into its neighbour. The document
     * had no name to lose — the FILE will simply state one the model did not,
     * which is the same category as a user-asserted unit and belongs beside it.
     *
     * Ranking it as a loss would make every plain single-part STL-to-OBJ save
     * report as lossy over a name nobody had and nobody wanted, which is exactly
     * the noise that teaches people to stop reading the panel.
     */
    assumptions.push(
      fact(CompatibilityFeature.PartNames, CompatibilityDisposition.Canonicalized, {
        count: profile.unnamedPartCount,
      }),
    );
  }

  /* ------------------------------------------------------------- groups -- */

  if (profile.groupCount > 0) {
    if (target === ExportFormat.Obj) {
      preserved.push(
        fact(CompatibilityFeature.Groups, CompatibilityDisposition.Preserved, {
          count: profile.groupCount,
        }),
      );
    } else {
      /*
       * DROPPED BY 3MF TOO, and that is a fact about THIS writer rather than
       * about the format. 3MF can express per-triangle property groups; CAD
       * Fixer's writer does not, because it writes no material resources for
       * them to point at. Saying "3MF keeps everything" here would be exactly
       * the false lossless claim this report exists to prevent.
       */
      losses.push(
        fact(CompatibilityFeature.Groups, CompatibilityDisposition.Dropped, {
          count: profile.groupCount,
        }),
      );
    }
  }

  /* -------------------------------------------------- material references -- */

  if (profile.partMaterialRefCount > 0) {
    /*
     * DROPPED BY EVERY TARGET, INCLUDING 3MF.
     *
     * This said `Preserved` for 3MF, and it was wrong in the way that matters
     * most: the writer expressed "preservation" as `object@pid`, which 3MF core
     * defines as a reference to a property-group resource that must exist —
     * and CAD Fixer emits no property resources at all. The reference was
     * dangling in every file, and for a reference that did not originate as a
     * number it was not even a lexical resource id.
     *
     * Fabricating a `<basematerials>` to make it resolve is not available
     * either: a `materialRef` is an opaque string carried through import, not a
     * material definition, so any resource invented for it would state a colour
     * and a name the user never gave. So all three targets drop it, and the
     * report says so before the user exports.
     *
     * OBJ's `usemtl` applies to a run of faces rather than to an object, so a
     * PART-level reference has nowhere to go there either. STL has nowhere for
     * anything.
     */
    losses.push(
      fact(CompatibilityFeature.PartMaterialReferences, CompatibilityDisposition.Dropped, {
        count: profile.partMaterialRefCount,
      }),
    );
  }
  if (profile.groupMaterialRefCount > 0) {
    if (target === ExportFormat.Obj) {
      preserved.push(
        fact(CompatibilityFeature.GroupMaterialReferences, CompatibilityDisposition.Preserved, {
          count: profile.groupMaterialRefCount,
        }),
      );
    } else {
      losses.push(
        fact(CompatibilityFeature.GroupMaterialReferences, CompatibilityDisposition.Dropped, {
          count: profile.groupMaterialRefCount,
        }),
      );
    }
  }

  /* ------------------------------------------------------------ sharing -- */

  if (shared > 0) {
    if (target === ExportFormat.ThreeMf) {
      /*
       * SHARING SURVIVES ONLY WHERE THE SHARING PARTS AGREE, and the report says
       * which. 3MF puts the name and the material reference on the `<object>`,
       * so two placements of one mesh under two different names are two objects
       * in 3MF's own model — the geometry is written twice, and the name is kept
       * because dropping a name the user gave is the larger loss.
       *
       * `threeMfObjectCount` mirrors `planThreeMfObjects` exactly, so these two
       * numbers are the writer's own arithmetic rather than an optimistic
       * guess: `partCount - objects` placements really do reuse geometry, and
       * `objects - meshResourceCount` copies really are written because their
       * metadata differs.
       */
      const reused = profile.partCount - profile.threeMfObjectCount;
      const splitByMetadata = profile.threeMfObjectCount - profile.meshResourceCount;

      if (reused > 0) {
        preserved.push(
          fact(CompatibilityFeature.MeshSharing, CompatibilityDisposition.Preserved, {
            count: reused,
          }),
        );
      }
      if (splitByMetadata > 0) {
        losses.push(
          fact(CompatibilityFeature.MeshSharing, CompatibilityDisposition.Dropped, {
            count: splitByMetadata,
          }),
        );
      }
    } else {
      losses.push(
        fact(CompatibilityFeature.MeshSharing, CompatibilityDisposition.Dropped, { count: shared }),
      );
    }
  }

  /* --------------------------------------- per-vertex attributes we hold -- */

  if (profile.meshesWithNormals > 0) {
    losses.push(
      fact(CompatibilityFeature.Normals, CompatibilityDisposition.Unsupported, {
        count: profile.meshesWithNormals,
      }),
    );
  }
  if (profile.meshesWithUvs > 0) {
    losses.push(
      fact(CompatibilityFeature.TextureCoordinates, CompatibilityDisposition.Unsupported, {
        count: profile.meshesWithUvs,
      }),
    );
  }

  /* ---------------------------------------------------------- resources -- */

  const sizeBlocker = outputSizeBlocker(target, profile.triangleCount, limits);
  if (sizeBlocker !== undefined) blockers.push(sizeBlocker);

  /* ------------------------------------------------------------ verdict -- */

  let verdict: ConversionVerdict = ConversionVerdict.Lossless;
  for (const entry of [...losses, ...transformations]) {
    verdict = strongerVerdict(verdict, verdictFor(entry));
  }
  /*
   * A BLOCKER OVERRIDES EVERYTHING, rather than merely ranking above it. There
   * is nothing to summarise about what a file would keep when there is no file.
   */
  if (blockers.length > 0) verdict = ConversionVerdict.Blocked;

  return {
    sourceFormat: profile.sourceFormat,
    targetFormat: target,
    verdict,
    blockers,
    losses,
    transformations,
    assumptions,
    /*
     * SOURCE WARNINGS ARE CARRIED, NEVER FOLDED INTO THE VERDICT.
     *
     * A texture that was not imported is not something this conversion is
     * doing, and letting it push a 3MF-to-3MF save out of "lossless" would
     * blame the target for a loss that happened when the file was opened. It is
     * shown separately, in its own section, and it survives a change of target
     * because it has nothing to do with the target.
     */
    sourceImportWarnings: sourceFacts(profile),
    preserved,
    exportable: blockers.length === 0,
  };
}

/** Which lost features are structure rather than labels. */
function structuralFeature(feature: CompatibilityFeature): boolean {
  return (
    feature === CompatibilityFeature.PartStructure || feature === CompatibilityFeature.MeshSharing
  );
}

/**
 * How strongly one fact colours the summary.
 *
 * EXHAUSTIVE OVER THE DISPOSITION, with no `default`, so a new disposition
 * fails to compile until someone decides what it means for the verdict rather
 * than falling silently into the mildest answer.
 *
 * `PRESERVED`, `REQUIRES_USER_ASSERTION` and `RESOURCE_LIMIT` contribute
 * nothing here: the first is not a loss at all, and the other two are blockers,
 * which override the whole summary rather than ranking within it.
 */
function verdictFor(entry: CompatibilityFact): ConversionVerdict {
  switch (entry.disposition) {
    case CompatibilityDisposition.Unsupported:
      return ConversionVerdict.UnsupportedInputFeature;
    case CompatibilityDisposition.Baked:
      // THE PLACEMENT STOPS BEING A PLACEMENT — a change to how the model is put
      // together, not to a label on it.
      return ConversionVerdict.LossyStructure;
    case CompatibilityDisposition.Dropped:
      return structuralFeature(entry.feature)
        ? ConversionVerdict.LossyStructure
        : ConversionVerdict.LossyMetadata;
    case CompatibilityDisposition.Canonicalized:
      return ConversionVerdict.LossyMetadata;
    case CompatibilityDisposition.Preserved:
    case CompatibilityDisposition.RequiresUserAssertion:
    case CompatibilityDisposition.ResourceLimit:
      return ConversionVerdict.Lossless;
  }
}
