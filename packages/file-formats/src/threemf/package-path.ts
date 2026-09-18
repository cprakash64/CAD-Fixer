import { ImportRefusal, importMalformed, importUnsupported } from '../import-errors';
import { DEFAULT_ZIP_LIMITS, type ZipEntry, type ZipLimits } from './zip';

/**
 * PACKAGE-ABSOLUTE MODEL REFERENCES — Stage 6D-A1 foundation.
 *
 * A 3MF production-extension `path` and a ZIP entry name are two different
 * grammars, and the single most dangerous thing this module could do is treat
 * them as one. `describeUnsafePath` exists to decide whether an ENTRY NAME is
 * safe, and it refuses a leading `/` as an absolute path — correctly, because a
 * ZIP entry name is relative to the archive root and an absolute one is a
 * traversal attempt. The production extension says the opposite: a `path` is
 * "an absolute path to the target model file inside the 3MF container", so the
 * leading `/` is REQUIRED and its absence is the malformed case.
 *
 * Reusing one helper for both would mean a rule change made for one grammar
 * silently changing the other, in a direction nobody reviewed. So this is a
 * separate resolver with a separate contract, and it says so here rather than
 * leaving the next reader to discover it.
 *
 * NOTHING IN PRODUCTION CALLS THIS YET. Stage 6D-A1 is foundation only: the
 * reader still opens exactly one model part and still refuses every
 * production-extension package. A2 is the stage that crosses that boundary.
 */

declare const modelPartKeyBrand: unique symbol;

/**
 * The canonical identity of one model part inside a package.
 *
 * A PACKAGE IDENTITY, NOT A FILE PATH. It carries no drive, no host, no
 * filesystem semantics and no URL semantics; it is the archive entry's own name
 * reduced to a single canonical spelling so that two references that name the
 * same part produce the same key and can therefore share one parse.
 *
 * Branded so a bare string cannot be passed where a resolved, validated
 * identity is required — the same reason `PartId` and `OperationId` are
 * branded. The brand is the whole point: an unvalidated attacker-supplied
 * string must not be able to reach a `Map` lookup that decides which bytes get
 * parsed.
 */
export type ModelPartKey = string & { readonly [modelPartKeyBrand]: true };

/**
 * The identity of one object, qualified by the part that declares it.
 *
 * TWO MODEL PARTS MAY EACH DECLARE `id="1"`, legally, and the specification
 * expects it — ids are unique within a model part, not within a package. A bare
 * `objectId` therefore cannot say which mesh a reference means, and resolving
 * `B.model:1` against `A.model`'s table is exactly the defect this type exists
 * to make hard to write.
 *
 * The same lesson as the document invariant THE PART IS PART OF THE IDENTITY,
 * one level further out.
 */
export interface ObjectKey {
  readonly part: ModelPartKey;
  readonly objectId: string;
}

/** Canonical, comparable text for one object identity. For `Map` keys and messages. */
export function objectKeyToString(key: ObjectKey): string {
  return `${key.part}#${key.objectId}`;
}

export function objectKeyEquals(left: ObjectKey, right: ObjectKey): boolean {
  return left.part === right.part && left.objectId === right.objectId;
}

/** The extension a production-extension reference is permitted to name. */
const MODEL_EXTENSION = '.model';

/**
 * Why a package reference cannot become a `ModelPartKey`.
 *
 * SEPARATE FROM "THE ENTRY IS NOT THERE", deliberately. A path that is
 * malformed is a statement about the reference; a well-formed path naming an
 * absent entry is a statement about the package. Collapsing them would leave A2
 * unable to tell a hostile reference from an incomplete archive, and would give
 * the user one message for two different problems.
 */
export const PackagePathRefusal = {
  NotAbsolute: 'not-absolute',
  TooLong: 'too-long',
  ControlCharacter: 'control-character',
  Backslash: 'backslash',
  DriveLetter: 'drive-letter',
  UrlLike: 'url-like',
  ParentSegment: 'parent-segment',
  CurrentSegment: 'current-segment',
  EmptySegment: 'empty-segment',
  EncodedTraversal: 'encoded-traversal',
  NotAModelPart: 'not-a-model-part',
} as const;

export type PackagePathRefusal = (typeof PackagePathRefusal)[keyof typeof PackagePathRefusal];

/**
 * Validates a production-extension `path` and reduces it to canonical text.
 *
 * SHAPE ONLY. It decides whether the reference is well formed and what it
 * canonically spells; whether an entry of that name EXISTS is a different
 * question, answered by `resolvePackageModelPath`. Keeping them apart is what
 * lets the two refusals stay distinguishable.
 *
 * Canonical form is the entry-name spelling — no leading slash, lower-cased —
 * because `readZipDirectory` already refuses two entries whose names differ
 * only in case, so exactly one entry can correspond to a given canonical form
 * and the platform cannot be the thing that decides which.
 */
export function canonicalisePackagePath(
  raw: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): { readonly key: ModelPartKey } | { readonly refusal: PackagePathRefusal } {
  const canonical = canonicalisePackagePartName(raw, limits);
  if ('refusal' in canonical) return canonical;
  if (!canonical.key.endsWith(MODEL_EXTENSION)) {
    /*
     * A GEOMETRY REFERENCE MAY ONLY NAME A MODEL PART. A `path` pointing at a
     * thumbnail, a texture or a directory is not a model part that happens to
     * be the wrong type — following it would be opening an entry for a reason
     * the package never stated, which is the same rule that keeps `mtllib`
     * unopened.
     */
    return { refusal: PackagePathRefusal.NotAModelPart };
  }
  return canonical;
}

/**
 * Validates an absolute package part name and reduces it to canonical text,
 * WITHOUT asking what kind of part it names — Stage 6D-A4.
 *
 * Every shape rule of `canonicalisePackagePath` applies here unchanged: no
 * traversal, no encoded traversal, no drive letter, no URL, no backslash, no
 * control character, no empty or dot segment, a leading slash required. What
 * is NOT applied is the `.model` suffix, and that is the only difference.
 *
 * WHY THE ROOT NEEDS THIS. 3MF core identifies the root model part by the TYPE
 * of the OPC relationship that names it, and OPC puts no constraint on a part's
 * extension. The 3MF Consortium's own positive conformance cases name the root
 * `/3D/3dmodel`, `/3D/3dmodel.moodel` and `/3D/3dmodel.part`, and a consumer
 * must read them. Requiring `.model` there refused them as "not a 3MF file".
 * A production `path` keeps the suffix rule, because it is a reference an
 * untrusted file asks CAD Fixer to follow — the root relationship's TYPE is the
 * package saying what the part is.
 */
export function canonicalisePackagePartName(
  raw: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): { readonly key: ModelPartKey } | { readonly refusal: PackagePathRefusal } {
  if (raw.length > limits.maxPathLength) return { refusal: PackagePathRefusal.TooLong };

  /*
   * CHECKED ON THE CHARACTERS AS WRITTEN, before anything is stripped or
   * folded. A check that runs after normalisation can never fire on what
   * normalisation removed — which is how a NUL in a path becomes invisible.
   */
  for (let at = 0; at < raw.length; at += 1) {
    const code = raw.charCodeAt(at);
    if (code < 32 || code === 127) return { refusal: PackagePathRefusal.ControlCharacter };
  }

  /*
   * PERCENT-ENCODED TRAVERSAL IS REFUSED, NOT DECODED — the Stage 6D decision,
   * preserved. Decoding an attacker-supplied path would mean the identity that
   * gets looked up is not the identity that was validated, and it invites a
   * second round of exactly the same argument one decoding layer down.
   */
  if (/%2e/i.test(raw) || /%2f/i.test(raw) || /%5c/i.test(raw)) {
    return { refusal: PackagePathRefusal.EncodedTraversal };
  }

  // Before the leading-slash test: `C:\...` and `http://...` are not absolute
  // package paths that happen to be missing a slash, they are other grammars.
  if (/^[A-Za-z]:/.test(raw)) return { refusal: PackagePathRefusal.DriveLetter };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return { refusal: PackagePathRefusal.UrlLike };
  // Not a separator in a package path. Treating it as one is how `a\..\..\b`
  // slips past a forward-slash-only check.
  if (raw.includes('\\')) return { refusal: PackagePathRefusal.Backslash };

  /*
   * THE LEADING SLASH IS REQUIRED, and this is where this module and
   * `describeUnsafePath` deliberately disagree. The specification defines
   * `path` as absolute within the container, so a relative one has no base to
   * resolve against — and inventing one would be CAD Fixer deciding what the
   * file meant.
   */
  if (!raw.startsWith('/')) return { refusal: PackagePathRefusal.NotAbsolute };

  const segments = raw.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '') return { refusal: PackagePathRefusal.EmptySegment };
    if (segment === '.') return { refusal: PackagePathRefusal.CurrentSegment };
    if (segment === '..') return { refusal: PackagePathRefusal.ParentSegment };
  }

  return { key: segments.join('/').toLowerCase() as ModelPartKey };
}

/** The canonical key for an entry already present in the archive directory. */
export function modelPartKeyOfEntry(entry: ZipEntry): ModelPartKey {
  return entry.name.toLowerCase() as ModelPartKey;
}

export interface ResolvedModelPart {
  readonly key: ModelPartKey;
  readonly entry: ZipEntry;
}

/**
 * Resolves a production-extension `path` to a real entry of this archive.
 *
 * TWO FAILURES, KEPT APART. A malformed reference is `MALFORMED_FILE` naming
 * what is wrong with it; a well-formed reference to an entry that is not in the
 * archive is `THREEMF_MODEL_PART_NOT_FOUND`. A2 needs both to stay
 * distinguishable, because one is a hostile or corrupt file and the other is an
 * incomplete package, and the user can act on only one of them.
 *
 * THE LOOKUP IS AGAINST THE DIRECTORY THIS ARCHIVE ALREADY HAS. Nothing here
 * reaches a filesystem or a network; the resolved target is always an entry of
 * the bytes already in memory.
 */
export function resolvePackageModelPath(
  raw: string,
  entries: readonly ZipEntry[],
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): ResolvedModelPart {
  const canonical = canonicalisePackagePath(raw, limits);
  if ('refusal' in canonical) {
    if (canonical.refusal === PackagePathRefusal.NotAModelPart) {
      /*
       * UNSUPPORTED RATHER THAN MALFORMED. A package may legitimately reference
       * a thumbnail or a texture through other extensions; what CAD Fixer
       * cannot do is treat one as geometry. Saying "your file is broken" would
       * be describing our own limit as the user's damage.
       */
      throw importUnsupported(
        ImportRefusal.ThreeMfModelPartNotAModel,
        'This 3MF refers to a part that is not a model, and CAD Fixer reads geometry only.',
        { reasonDetail: canonical.refusal },
      );
    }
    throw importMalformed(
      ImportRefusal.ThreeMfMalformedModelPartPath,
      'This 3MF contains a reference to another part of the package that CAD Fixer will not follow.',
      { reasonDetail: canonical.refusal },
    );
  }

  const entry = entries.find((candidate) => modelPartKeyOfEntry(candidate) === canonical.key);
  if (entry === undefined) {
    throw importMalformed(
      ImportRefusal.ThreeMfModelPartNotFound,
      'This 3MF refers to a model part that the package does not contain.',
      { part: canonical.key.slice(0, 128) },
    );
  }
  return { key: canonical.key, entry };
}
