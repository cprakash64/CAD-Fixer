import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import { ImportRefusal, refusalOf } from '../import-errors';
import {
  canonicalisePackagePartName,
  canonicalisePackagePath,
  modelPartKeyOfEntry,
  objectKeyEquals,
  objectKeyToString,
  PackagePathRefusal,
  resolvePackageModelPath,
  type ModelPartKey,
} from './package-path';
import { productionPathValueOf } from './threemf-reader';
import { DEFAULT_ZIP_LIMITS, describeUnsafePath, type ZipEntry } from './zip';

/**
 * A1-P01 – A1-P14, A1-I01 – A1-I03 — PACKAGE REFERENCE RESOLUTION.
 *
 * THE RULE THIS FILE EXISTS TO PIN. A production-extension `path` and a ZIP
 * entry name are different grammars that differ on the single most
 * security-relevant character: the leading `/`. `describeUnsafePath` refuses
 * one, the specification requires the other. Sharing a helper between them
 * would mean a rule tightened for entry names silently loosening package
 * references, or the reverse, with nobody reviewing the second effect.
 *
 * NOTHING HERE IS REACHABLE FROM PRODUCTION IN STAGE 6D-A1. The resolver is
 * tested directly; `read3mf` still opens one model part and still refuses every
 * production-extension package.
 */

function entry(name: string): ZipEntry {
  return { name, method: 8, compressedSize: 10, uncompressedSize: 100, localOffset: 0 };
}

const ARCHIVE: readonly ZipEntry[] = [
  entry('[Content_Types].xml'),
  entry('_rels/.rels'),
  entry('3D/3dmodel.model'),
  entry('3D/Objects/object_1.model'),
  entry('Metadata/thumbnail.png'),
];

function refusalOfPath(raw: string): PackagePathRefusal | undefined {
  const result = canonicalisePackagePath(raw);
  return 'refusal' in result ? result.refusal : undefined;
}

function keyOfPath(raw: string): ModelPartKey | undefined {
  const result = canonicalisePackagePath(raw);
  return 'key' in result ? result.key : undefined;
}

describe('A1-P: a production-extension path resolves to a canonical package part', () => {
  it('A1-P01: an absolute package path resolves to its archive entry', () => {
    const resolved = resolvePackageModelPath('/3D/Objects/object_1.model', ARCHIVE);
    expect(resolved.entry.name).toBe('3D/Objects/object_1.model');
    expect(resolved.key).toBe('3d/objects/object_1.model');
  });

  it('A1-P02: the namespace prefix is not part of path semantics', () => {
    /*
     * `p:path`, `prod:path` and `production:path` are the SAME attribute — the
     * prefix is the author's to choose, and matching the spelling rather than
     * the namespace would miss a file that used an unusual one.
     *
     * Driven through the real extraction step rather than by comparing one
     * string with itself: a test that resolves the same literal twice would
     * pass however the prefix were handled, and would prove nothing at all.
     */
    const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
    const path = '/3D/Objects/object_1.model';

    const keys = ['p', 'prod', 'production'].map((prefix) =>
      keyOfPath(
        productionPathValueOf(
          { objectid: '1', [`${prefix}:path`]: path },
          new Map([[prefix, PRODUCTION]]),
        ) ?? '',
      ),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('3d/objects/object_1.model');

    // And a `path` from some OTHER namespace is not a production path at all.
    expect(
      productionPathValueOf(
        { 'other:path': path },
        new Map([['other', 'http://example.invalid/not-production']]),
      ),
    ).toBeUndefined();
    // A bare `path` carries no namespace and must not be mistaken for one.
    expect(productionPathValueOf({ path }, new Map())).toBeUndefined();
  });

  it('A1-P03: a relative path is refused rather than resolved against a guess', () => {
    // The specification defines `path` as absolute within the container, so a
    // relative one has no base. Inventing one would be CAD Fixer deciding what
    // the file meant.
    expect(refusalOfPath('3D/Objects/object_1.model')).toBe(PackagePathRefusal.NotAbsolute);
    expect(refusalOfPath('./3D/Objects/object_1.model')).toBe(PackagePathRefusal.NotAbsolute);
  });

  it('A1-P04: a parent-traversal segment is refused', () => {
    expect(refusalOfPath('/3D/../../etc/passwd.model')).toBe(PackagePathRefusal.ParentSegment);
    expect(refusalOfPath('/../3dmodel.model')).toBe(PackagePathRefusal.ParentSegment);
  });

  it('A1-P05: a current-directory segment is refused, not silently collapsed', () => {
    // Collapsing it would mean the identity validated is not the identity
    // looked up, which is the whole class of bug this resolver avoids.
    expect(refusalOfPath('/3D/./3dmodel.model')).toBe(PackagePathRefusal.CurrentSegment);
  });

  it('A1-P06: a backslash is not a separator and is refused', () => {
    // Treating it as one is how `a\..\..\b` slips past a forward-slash check.
    expect(refusalOfPath('/3D\\Objects\\object_1.model')).toBe(PackagePathRefusal.Backslash);
  });

  it('A1-P07: a drive-letter path is refused', () => {
    expect(refusalOfPath('C:/3D/3dmodel.model')).toBe(PackagePathRefusal.DriveLetter);
    expect(refusalOfPath('C:\\3D\\3dmodel.model')).toBe(PackagePathRefusal.DriveLetter);
  });

  it('A1-P08: a URL-like path is refused', () => {
    // Nothing in an imported file may name a network location, and a resolver
    // that merely failed to FETCH one would still have accepted the reference.
    expect(refusalOfPath('http://example.invalid/3dmodel.model')).toBe(PackagePathRefusal.UrlLike);
    expect(refusalOfPath('file:///3D/3dmodel.model')).toBe(PackagePathRefusal.UrlLike);
  });

  it('A1-P09: a control character is refused, on the characters as written', () => {
    expect(refusalOfPath('/3D/3dmodel\u0000.model')).toBe(PackagePathRefusal.ControlCharacter);
    expect(refusalOfPath('/3D/\u007f/3dmodel.model')).toBe(PackagePathRefusal.ControlCharacter);
  });

  it('A1-P10: percent-encoded traversal is REFUSED, never decoded', () => {
    /*
     * The Stage 6D decision, preserved. Decoding would mean the identity that
     * gets looked up is not the identity that was validated — and it invites
     * the same argument again one encoding layer down.
     */
    expect(refusalOfPath('/3D/%2e%2e/3dmodel.model')).toBe(PackagePathRefusal.EncodedTraversal);
    expect(refusalOfPath('/3D%2f3dmodel.model')).toBe(PackagePathRefusal.EncodedTraversal);
    expect(refusalOfPath('/3D%5c3dmodel.model')).toBe(PackagePathRefusal.EncodedTraversal);
  });

  it('A1-P10b: an empty interior segment is refused', () => {
    expect(refusalOfPath('/3D//3dmodel.model')).toBe(PackagePathRefusal.EmptySegment);
    expect(refusalOfPath('/')).toBe(PackagePathRefusal.EmptySegment);
  });

  it('A1-P10c: an over-long path is refused before anything else looks at it', () => {
    expect(refusalOfPath(`/${'a'.repeat(600)}.model`)).toBe(PackagePathRefusal.TooLong);
  });

  it('A1-P11: lookup is canonical, so spelling differences find the one entry', () => {
    /*
     * PACKAGE RULES, NOT PLATFORM RULES. `readZipDirectory` already refuses two
     * entries whose names differ only in case, so exactly one entry can match a
     * canonical form — and the answer is therefore identical on macOS, Linux
     * and Windows. That is the property being pinned: not "case-insensitive
     * like this filesystem", but "canonical, everywhere".
     */
    const resolved = resolvePackageModelPath('/3d/OBJECTS/Object_1.MODEL', ARCHIVE);
    expect(resolved.entry.name).toBe('3D/Objects/object_1.model');
    expect(resolved.key).toBe('3d/objects/object_1.model');
  });

  it('A1-P12: two spellings of one part are ONE identity, not two', () => {
    // A1-I03. If they produced different keys the graph would parse the same
    // bytes twice and hold two copies of one mesh.
    expect(keyOfPath('/3D/Objects/object_1.model')).toBe(keyOfPath('/3d/objects/OBJECT_1.model'));
  });

  it('A1-P13: a missing entry is distinguished from an unsafe path', () => {
    /*
     * THE DISTINCTION A2 NEEDS. One is a hostile or corrupt reference; the
     * other is an incomplete package. A user can act on the second and not the
     * first, and one message for both would help with neither.
     */
    try {
      resolvePackageModelPath('/3D/Objects/object_9.model', ARCHIVE);
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isAppError(error)) throw error;
      expect(error.code).toBe(AppErrorCode.MalformedFile);
      expect(refusalOf(error)).toBe(ImportRefusal.ThreeMfModelPartNotFound);
    }

    try {
      resolvePackageModelPath('/3D/../object_1.model', ARCHIVE);
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isAppError(error)) throw error;
      expect(error.code).toBe(AppErrorCode.MalformedFile);
      expect(refusalOf(error)).toBe(ImportRefusal.ThreeMfMalformedModelPartPath);
    }
  });

  it('A1-P14: a geometry reference may only name a model part', () => {
    expect(refusalOfPath('/Metadata/thumbnail.png')).toBe(PackagePathRefusal.NotAModelPart);
    expect(refusalOfPath('/3D/Objects')).toBe(PackagePathRefusal.NotAModelPart);

    try {
      resolvePackageModelPath('/Metadata/thumbnail.png', ARCHIVE);
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isAppError(error)) throw error;
      /*
       * UNSUPPORTED, NOT MALFORMED. Referencing a thumbnail is legal in the
       * package; what CAD Fixer cannot do is read one as geometry. Calling the
       * file broken would describe our own limit as the user's damage.
       */
      expect(error.code).toBe(AppErrorCode.UnsupportedFile);
      expect(refusalOf(error)).toBe(ImportRefusal.ThreeMfModelPartNotAModel);
    }
  });

  it('A1-P14b: an existing thumbnail entry is still refused as a model part', () => {
    // The entry EXISTS, so this proves the type check is not a disguised
    // existence check.
    expect(ARCHIVE.some((candidate) => candidate.name === 'Metadata/thumbnail.png')).toBe(true);
    expect(refusalOfPath('/Metadata/thumbnail.png')).toBe(PackagePathRefusal.NotAModelPart);
  });
});

describe('A1-I: an object identity carries the part that declares it', () => {
  const root = modelPartKeyOfEntry(entry('3D/3dmodel.model'));
  const child = modelPartKeyOfEntry(entry('3D/Objects/object_1.model'));

  it('A1-I01: the same object id in two parts is two identities', () => {
    /*
     * THE DEFECT THIS TYPE EXISTS TO PREVENT. Object ids are unique within a
     * model part and the specification expects two parts each to declare
     * `id="1"`. Resolving `B.model:1` against `A.model`'s table would silently
     * place the wrong mesh — geometry that is valid, plausible and not what the
     * file said.
     */
    expect(objectKeyEquals({ part: root, objectId: '1' }, { part: child, objectId: '1' })).toBe(
      false,
    );
    expect(objectKeyToString({ part: root, objectId: '1' })).not.toBe(
      objectKeyToString({ part: child, objectId: '1' }),
    );
  });

  it('A1-I02: the same part and id is one identity', () => {
    expect(objectKeyEquals({ part: child, objectId: '7' }, { part: child, objectId: '7' })).toBe(
      true,
    );
    expect(objectKeyToString({ part: child, objectId: '7' })).toBe(
      objectKeyToString({ part: child, objectId: '7' }),
    );
  });

  it('A1-I03: different spellings of one part do not create duplicate identities', () => {
    const spelled = modelPartKeyOfEntry(entry('3D/OBJECTS/Object_1.model'));
    expect(objectKeyEquals({ part: child, objectId: '1' }, { part: spelled, objectId: '1' })).toBe(
      true,
    );
  });
});

describe('A1: a package reference and a ZIP entry name are different grammars', () => {
  it('the two validators DISAGREE on the leading slash, and must keep disagreeing', () => {
    /*
     * THE REASON THIS MODULE EXISTS, pinned so it cannot be "tidied" away.
     *
     * `describeUnsafePath` decides whether a ZIP ENTRY NAME is safe, and
     * refuses a leading `/` as an absolute path — correctly, because an entry
     * name is relative to the archive root. The production extension defines
     * `path` as "an absolute path to the target model file inside the 3MF
     * container", so for a package REFERENCE the leading `/` is required and
     * its absence is the malformed case.
     *
     * Merging them would mean a rule tightened for one grammar silently
     * changing the other in a direction nobody reviewed. If this test ever
     * fails because someone unified the helpers, the unification is the bug.
     */
    const absolute = '/3D/Objects/object_1.model';
    const relative = '3D/Objects/object_1.model';

    // Entry-name grammar: absolute is unsafe, relative is fine.
    expect(describeUnsafePath(absolute, DEFAULT_ZIP_LIMITS)).toBe('absolute path');
    expect(describeUnsafePath(relative, DEFAULT_ZIP_LIMITS)).toBeUndefined();

    // Package-reference grammar: exactly the other way round.
    expect(refusalOfPath(absolute)).toBeUndefined();
    expect(refusalOfPath(relative)).toBe(PackagePathRefusal.NotAbsolute);
  });

  it('they agree on every traversal and scheme rule, which is why only the slash differs', () => {
    // The disagreement is deliberate and NARROW. Everything genuinely dangerous
    // is refused by both, so the split cannot become a hole.
    for (const hostile of [
      '/3D/../secrets.model',
      '/3D\\Objects\\object_1.model',
      '/3D/%2e%2e/object_1.model',
    ]) {
      expect(refusalOfPath(hostile)).toBeDefined();
      // The entry-name checker refuses the same shapes once the leading slash
      // (its own separate objection) is set aside.
      expect(describeUnsafePath(hostile.slice(1), DEFAULT_ZIP_LIMITS)).toBeDefined();
    }
  });
});

describe('A4-PN: a root part name gets every shape rule except the .model suffix', () => {
  const refusalOfName = (raw: string): PackagePathRefusal | undefined => {
    const result = canonicalisePackagePartName(raw);
    return 'refusal' in result ? result.refusal : undefined;
  };

  it('accepts the names the 3MF Consortium’s positive root cases use', () => {
    for (const raw of ['/3D/3dmodel', '/3D/3dmodel.moodel', '/3D/3dmodel.part']) {
      const result = canonicalisePackagePartName(raw);
      expect('key' in result ? result.key : undefined).toBe(raw.slice(1).toLowerCase());
    }
  });

  it('refuses every unsafe shape exactly as a production path is refused', () => {
    const cases: readonly (readonly [string, PackagePathRefusal])[] = [
      ['3D/3dmodel', PackagePathRefusal.NotAbsolute],
      ['/3D/../3dmodel', PackagePathRefusal.ParentSegment],
      ['/3D/./3dmodel', PackagePathRefusal.CurrentSegment],
      ['/3D//3dmodel', PackagePathRefusal.EmptySegment],
      ['/3D/%2e%2e/3dmodel', PackagePathRefusal.EncodedTraversal],
      ['/3D\\3dmodel', PackagePathRefusal.Backslash],
      ['C:/3D/3dmodel', PackagePathRefusal.DriveLetter],
      ['https://example.com/3dmodel', PackagePathRefusal.UrlLike],
      ['/3D/3d\u0000model', PackagePathRefusal.ControlCharacter],
      [`/${'a'.repeat(DEFAULT_ZIP_LIMITS.maxPathLength)}`, PackagePathRefusal.TooLong],
    ];
    for (const [raw, refusal] of cases) {
      expect(refusalOfName(raw)).toBe(refusal);
      // And the production-path grammar agrees on every one of them.
      expect(refusalOfPath(raw)).toBe(refusal);
    }
  });

  it('leaves the production-path grammar requiring .model', () => {
    expect(refusalOfPath('/3D/3dmodel.part')).toBe(PackagePathRefusal.NotAModelPart);
    expect(refusalOfName('/3D/3dmodel.part')).toBeUndefined();
  });
});
