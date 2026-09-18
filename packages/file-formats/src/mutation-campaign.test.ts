import { describe, expect, it } from 'vitest';
import { AppErrorCode, CancellationSource, isAppError } from '@cadfixer/shared';
import {
  assertGeometryDocument,
  assertMeshStructure,
  distinctMeshes,
  documentTriangleCount,
} from '@cadfixer/mesh-core';
import { identifyFormat } from './identify';
import { ImportRefusal, refusalOf } from './import-errors';
import { registerBuiltInFormats } from './register';
import { requireReader } from './registry';
import { testReadContext } from './test-context';
import { buildAsciiStl, buildBinaryStl, triangleAt, UNIT_TRIANGLE } from './stl/fixtures';
import { buildZip, CONTENT_TYPES, RELS, TETRAHEDRON_MESH } from './threemf/zip-fixtures';

/**
 * A4-M — THE DETERMINISTIC MUTATION CAMPAIGN. Stage 6D-A4.
 *
 * Small VALID seeds — a core 3MF, a production-extension 3MF with a child model
 * part, the same package in Zip64 form, a binary STL, an ASCII STL and an OBJ —
 * each mutated in bounded, named, reproducible ways. No randomness: a failure
 * names the seed and the mutation, and re-running it reproduces it exactly.
 *
 * THE INVARIANT, for every case, is the one Stage 6D-A4 is qualifying:
 *
 *   ALLOWED    a correct import (which must then pass `assertMeshStructure` per
 *              distinct mesh and `assertGeometryDocument`), or a TYPED refusal —
 *              MALFORMED_FILE, UNSUPPORTED_FILE, RESOURCE_LIMIT_EXCEEDED,
 *              OPERATION_CANCELLED.
 *   FORBIDDEN  any untyped throw (a crash), INTERNAL_ERROR for bad data, a hang,
 *              and a document that fails its own validation.
 *
 * Where the correct outcome is KNOWN, the case also pins the exact code and
 * refusal reason; tests assert the CODE, never the sentence. A case whose
 * right answer is "either outcome is legitimate" — deleting `[Content_Types]`
 * from a package that is otherwise complete, say — pins only the invariant, and
 * says so.
 *
 * Transactionality and state poisoning are properties of the WORKER, which
 * owns the resident document; they are proved in the browser by
 * `e2e/interop-recovery.spec.ts`. Readers are pure, so here the question is
 * only what each one returns.
 */

registerBuiltInFormats();

const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const ALTERNATIVES = 'http://schemas.microsoft.com/3dmanufacturing/production/alternatives/2021/04';

type Outcome =
  | { readonly kind: 'imported'; readonly parts: number; readonly triangles: number }
  | { readonly kind: 'refused'; readonly code: string; readonly reason: string | undefined };

const TYPED_REFUSALS: readonly string[] = [
  AppErrorCode.MalformedFile,
  AppErrorCode.UnsupportedFile,
  AppErrorCode.ResourceLimitExceeded,
  AppErrorCode.OperationCancelled,
];

/** Identify, read, and apply the same structural gates the worker does. */
async function outcomeOf(bytes: Uint8Array, fileName: string, cancelled = false): Promise<Outcome> {
  const source = new CancellationSource();
  if (cancelled) source.cancel();
  try {
    const identified = identifyFormat(bytes, fileName);
    const parsed = await requireReader(identified.formatId).read(
      bytes,
      testReadContext({ cancellation: source.token }),
    );
    for (const mesh of distinctMeshes(parsed.document)) assertMeshStructure(mesh, 'mutation');
    assertGeometryDocument(parsed.document, 'mutation', { validateMeshes: false });
    return {
      kind: 'imported',
      parts: parsed.document.parts.length,
      triangles: documentTriangleCount(parsed.document),
    };
  } catch (error) {
    // AN UNTYPED THROW IS A CRASH, whatever the input was. Rethrown so the
    // test fails with the original stack rather than a summary.
    if (!isAppError(error)) throw error;
    return { kind: 'refused', code: error.code, reason: refusalOf(error) };
  }
}

function expectInvariant(outcome: Outcome): void {
  if (outcome.kind === 'refused') {
    expect(TYPED_REFUSALS).toContain(outcome.code);
  } else {
    expect(outcome.parts).toBeGreaterThan(0);
  }
}

/* ------------------------------------------------------------ 3MF seeds -- */

interface PackageSpec {
  readonly entries: readonly { readonly name: string; readonly content: string }[];
  readonly zip64?: boolean;
}

function coreModel(
  options: {
    readonly resources?: string;
    readonly build?: string;
    readonly unit?: string;
    readonly attrs?: string;
  } = {},
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<model unit="${options.unit ?? 'millimeter'}" xmlns="${CORE}" xmlns:p="${PRODUCTION}"${options.attrs ?? ''}>` +
    `<resources>${
      options.resources ??
      `<object id="1" type="model">${TETRAHEDRON_MESH}</object>` +
        '<object id="2" type="model"><components>' +
        '<component objectid="1" transform="1 0 0 0 1 0 0 0 1 20 0 0"/></components></object>'
    }</resources>` +
    `<build>${options.build ?? '<item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 30 0"/>'}</build>` +
    '</model>'
  );
}

const CHILD_PATH = '/3D/Objects/child.model';
const CHILD_ENTRY = '3D/Objects/child.model';

function childModel(options: { readonly unit?: string; readonly resources?: string } = {}): string {
  return coreModel({
    resources: options.resources ?? `<object id="7" type="model">${TETRAHEDRON_MESH}</object>`,
    build: '',
    ...(options.unit === undefined ? {} : { unit: options.unit }),
  });
}

function productionRoot(
  options: { readonly build?: string; readonly attrs?: string } = {},
): string {
  return coreModel({
    attrs: options.attrs ?? ' requiredextensions="p"',
    resources:
      '<object id="1" type="model"><components>' +
      `<component objectid="7" p:path="${CHILD_PATH}" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>` +
      '</components></object>',
    build:
      options.build ??
      `<item objectid="1"/><item objectid="7" p:path="${CHILD_PATH}" transform="1 0 0 0 1 0 0 0 1 0 0 40"/>`,
  });
}

function corePackage(model = coreModel()): PackageSpec {
  return {
    entries: [
      { name: '[Content_Types].xml', content: CONTENT_TYPES },
      { name: '_rels/.rels', content: RELS },
      { name: '3D/3dmodel.model', content: model },
    ],
  };
}

function productionPackage(
  root = productionRoot(),
  child = childModel(),
  zip64 = false,
): PackageSpec {
  return {
    entries: [
      { name: '[Content_Types].xml', content: CONTENT_TYPES },
      { name: '_rels/.rels', content: RELS },
      { name: '3D/3dmodel.model', content: root },
      { name: CHILD_ENTRY, content: child },
    ],
    zip64,
  };
}

async function packageBytes(spec: PackageSpec): Promise<Uint8Array> {
  return buildZip(
    spec.entries.map((entry) => ({ ...entry, method: 8 })),
    spec.zip64 === true ? { zip64: true } : {},
  );
}

function withoutEntry(spec: PackageSpec, name: string): PackageSpec {
  return { ...spec, entries: spec.entries.filter((entry) => entry.name !== name) };
}

function renamed(spec: PackageSpec, from: string, to: string): PackageSpec {
  return {
    ...spec,
    entries: spec.entries.map((entry) => (entry.name === from ? { ...entry, name: to } : entry)),
  };
}

function replaced(spec: PackageSpec, name: string, content: string): PackageSpec {
  return {
    ...spec,
    entries: spec.entries.map((entry) => (entry.name === name ? { ...entry, content } : entry)),
  };
}

function flipByte(bytes: Uint8Array, at: number): Uint8Array {
  const copy = bytes.slice();
  copy[at] = (copy[at] ?? 0) ^ 0xff;
  return copy;
}

/** The offset of an entry's compressed data, found through its local header. */
function dataOffsetOf(archive: Uint8Array, name: string): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();
  let at = 0;
  while (at + 30 <= archive.byteLength && view.getUint32(at, true) === 0x04034b50) {
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const compressed = view.getUint32(at + 18, true);
    const entryName = decoder.decode(archive.subarray(at + 30, at + 30 + nameLength));
    const data = at + 30 + nameLength + extra;
    if (entryName === name) return data;
    at = data + compressed;
  }
  throw new Error(`fixture has no entry ${name}`);
}

interface ArchiveCase {
  readonly name: string;
  readonly build: () => Promise<Uint8Array>;
  /** When the right answer is known: the exact code and reason. */
  readonly expect?:
    | { readonly imported: true; readonly parts?: number; readonly triangles?: number }
    | { readonly code: string; readonly reason?: string };
}

const MALFORMED = AppErrorCode.MalformedFile;
const UNSUPPORTED = AppErrorCode.UnsupportedFile;
const RESOURCE = AppErrorCode.ResourceLimitExceeded;

const THREEMF_CASES: readonly ArchiveCase[] = [
  /* ----------------------------------------------------------- controls -- */
  {
    name: 'core seed imports: two placements, one component',
    build: () => packageBytes(corePackage()),
    expect: { imported: true, parts: 2, triangles: 8 },
  },
  {
    name: 'production seed imports: component and item across the part boundary',
    build: () => packageBytes(productionPackage()),
    expect: { imported: true, parts: 2, triangles: 8 },
  },
  {
    name: 'Zip64 production seed imports identically',
    build: () => packageBytes(productionPackage(undefined, undefined, true)),
    expect: { imported: true, parts: 2, triangles: 8 },
  },

  /* -------------------------------------------------- entry deletion -- */
  {
    name: 'delete the root model part',
    build: () => packageBytes(withoutEntry(corePackage(), '3D/3dmodel.model')),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfNoModelPart },
  },
  {
    name: 'delete the child model part',
    build: () => packageBytes(withoutEntry(productionPackage(), CHILD_ENTRY)),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfModelPartNotFound },
  },
  {
    // Neither is a geometry gate (Stage 6D-A3): the package still names its
    // root by convention, and content types are packaging metadata.
    name: 'delete the root relationships',
    build: () => packageBytes(withoutEntry(productionPackage(), '_rels/.rels')),
    expect: { imported: true, parts: 2, triangles: 8 },
  },
  {
    name: 'delete the content types',
    build: () => packageBytes(withoutEntry(corePackage(), '[Content_Types].xml')),
    expect: { imported: true, parts: 2, triangles: 8 },
  },

  /* --------------------------------------------------- entry renaming -- */
  {
    name: 'rename the root away from the relationship target, with a child present',
    build: () => packageBytes(renamed(productionPackage(), '3D/3dmodel.model', '3D/renamed.model')),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfAmbiguousRootModelPart },
  },
  {
    name: 'rename the only model part: the single-part fallback still finds it',
    build: () => packageBytes(renamed(corePackage(), '3D/3dmodel.model', 'model/only.model')),
    expect: { imported: true, parts: 2 },
  },
  {
    name: 'rename the child so the path no longer names it',
    build: () => packageBytes(renamed(productionPackage(), CHILD_ENTRY, '3D/Objects/other.model')),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfModelPartNotFound },
  },
  {
    name: 'rename an entry to a traversal path',
    build: () => packageBytes(renamed(productionPackage(), CHILD_ENTRY, '../escape.model')),
    expect: { code: MALFORMED, reason: ImportRefusal.ZipUnsafePath },
  },
  {
    name: 'rename an entry to a backslash path',
    build: () =>
      packageBytes(renamed(productionPackage(), CHILD_ENTRY, '3D\\Objects\\child.model')),
    expect: { code: MALFORMED, reason: ImportRefusal.ZipUnsafePath },
  },
  {
    name: 'two entries differing only in case',
    build: () =>
      packageBytes({
        entries: [...corePackage().entries, { name: '3D/3DMODEL.model', content: coreModel() }],
      }),
    expect: { code: MALFORMED, reason: ImportRefusal.ZipDuplicatePath },
  },

  /* ----------------------------------------------------- path mutation -- */
  {
    name: 'path with a parent segment',
    build: () =>
      packageBytes(
        productionPackage(
          productionRoot({ build: '<item objectid="7" p:path="/3D/../3D/Objects/child.model"/>' }),
        ),
      ),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfMalformedModelPartPath },
  },
  {
    name: 'path with percent-encoded traversal',
    build: () =>
      packageBytes(
        productionPackage(
          productionRoot({ build: '<item objectid="7" p:path="/3D/%2e%2e/x.model"/>' }),
        ),
      ),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfMalformedModelPartPath },
  },
  {
    name: 'path that is a URL',
    build: () =>
      packageBytes(
        productionPackage(
          productionRoot({
            build: '<item objectid="7" p:path="https://example.invalid/a.model"/>',
          }),
        ),
      ),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfMalformedModelPartPath },
  },
  {
    name: 'path naming a part that is not a model',
    build: () =>
      packageBytes(
        productionPackage(
          productionRoot({ build: '<item objectid="7" p:path="/3D/texture.png"/>' }),
        ),
      ),
    expect: { code: UNSUPPORTED, reason: ImportRefusal.ThreeMfModelPartNotAModel },
  },
  {
    name: 'path in a child part (only the root may carry one)',
    build: () =>
      packageBytes(
        productionPackage(
          undefined,
          childModel({
            resources:
              `<object id="7" type="model">${TETRAHEDRON_MESH}</object>` +
              `<object id="8" type="model"><components><component objectid="7" p:path="${CHILD_PATH}"/></components></object>`,
          }),
        ),
      ),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfNonRootModelPartPath },
  },

  /* ------------------------------------------------- object-id mutation -- */
  {
    name: 'item names an object the child does not declare',
    build: () =>
      packageBytes(
        productionPackage(
          productionRoot({ build: `<item objectid="99" p:path="${CHILD_PATH}"/>` }),
        ),
      ),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfMissingModelPartObject },
  },
  {
    name: 'item names an object the root does not declare',
    build: () => packageBytes(corePackage(coreModel({ build: '<item objectid="99"/>' }))),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfMissingObject },
  },
  {
    name: 'duplicate object id',
    build: () =>
      packageBytes(
        corePackage(
          coreModel({
            resources:
              `<object id="1" type="model">${TETRAHEDRON_MESH}</object>` +
              `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
            build: '<item objectid="1"/>',
          }),
        ),
      ),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfDuplicateObjectId },
  },
  {
    name: 'component cycle',
    build: () =>
      packageBytes(
        corePackage(
          coreModel({
            resources:
              '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
              '<object id="2" type="model"><components><component objectid="1"/></components></object>',
            build: '<item objectid="1"/>',
          }),
        ),
      ),
    expect: { code: MALFORMED },
  },
  {
    name: 'dangling component',
    build: () =>
      packageBytes(
        corePackage(
          coreModel({
            resources:
              '<object id="2" type="model"><components><component objectid="5"/></components></object>',
            build: '<item objectid="2"/>',
          }),
        ),
      ),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfMissingObject },
  },

  /* ------------------------------------------------- namespace mutation -- */
  {
    name: 'production namespace URI altered: `path` is no longer the production attribute',
    build: () =>
      packageBytes(
        productionPackage(
          productionRoot({ attrs: '' }).replace(
            PRODUCTION,
            'http://example.invalid/not-production',
          ),
        ),
      ),
    // Ignored per must-ignore, so object 7 is looked up in the ROOT, which
    // does not declare it — never silently resolved somewhere else.
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfMissingObject },
  },
  {
    name: 'required extension unknown to CAD Fixer',
    build: () =>
      packageBytes(
        corePackage(
          coreModel({ attrs: ' xmlns:q="http://example.invalid/q" requiredextensions="q"' }),
        ),
      ),
    expect: { code: UNSUPPORTED, reason: ImportRefusal.ThreeMfUnsupportedExtension },
  },
  {
    name: 'required prefix that resolves to nothing',
    build: () => packageBytes(corePackage(coreModel({ attrs: ' requiredextensions="zz"' }))),
    expect: { code: UNSUPPORTED, reason: ImportRefusal.ThreeMfUnsupportedExtension },
  },
  {
    name: 'alternatives used without being declared required',
    build: () =>
      packageBytes(
        corePackage(
          coreModel({
            attrs: ` xmlns:pa="${ALTERNATIVES}"`,
            resources:
              `<object id="1" type="model">${TETRAHEDRON_MESH}` +
              '<pa:alternatives><pa:alternative objectid="1" modelresolution="lowres"/></pa:alternatives></object>',
            build: '<item objectid="1"/>',
          }),
        ),
      ),
    expect: { code: UNSUPPORTED, reason: ImportRefusal.ThreeMfModelResolutionUnsupported },
  },
  {
    name: 'optional unknown namespace with unknown nodes: ignored, imports',
    build: () =>
      packageBytes(
        corePackage(
          coreModel({
            attrs: ' xmlns:v="http://example.invalid/vendor" v:flavour="x"',
            resources: `<v:note v:colour="red"/><object id="1" type="model" v:tag="a">${TETRAHEDRON_MESH}</object>`,
            build: '<item objectid="1" v:weight="3"/>',
          }),
        ),
      ),
    expect: { imported: true, parts: 1, triangles: 4 },
  },

  /* ------------------------------------------------- transform mutation -- */
  ...['0x10', 'Infinity', 'NaN', '1e400', '1,0'].map((token): ArchiveCase => ({
    name: `transform token ${token}`,
    build: () =>
      packageBytes(
        corePackage(
          coreModel({ build: `<item objectid="1" transform="${token} 0 0 0 1 0 0 0 1 0 0 0"/>` }),
        ),
      ),
    expect: { code: MALFORMED },
  })),
  {
    name: 'transform with eleven values',
    build: () =>
      packageBytes(
        corePackage(coreModel({ build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0"/>' })),
      ),
    expect: { code: MALFORMED },
  },

  /* ------------------------------------------------------ unit mutation -- */
  {
    name: 'unit spelled with a capital',
    build: () => packageBytes(corePackage(coreModel({ unit: 'Millimeter' }))),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfUnsupportedUnit },
  },
  {
    name: 'child part disagrees about the unit',
    build: () => packageBytes(productionPackage(undefined, childModel({ unit: 'inch' }))),
    expect: { code: UNSUPPORTED, reason: ImportRefusal.ThreeMfInconsistentModelPartUnits },
  },

  /* ---------------------------------------------------------- XML level -- */
  {
    name: 'DOCTYPE injected into the child part',
    build: () =>
      packageBytes(
        productionPackage(
          undefined,
          childModel().replace('<model', '<!DOCTYPE m [<!ENTITY e "x">]><model'),
        ),
      ),
    expect: { code: MALFORMED, reason: ImportRefusal.XmlDoctypeRefused },
  },
  {
    name: 'root XML truncated mid-element',
    build: () =>
      packageBytes(replaced(corePackage(), '3D/3dmodel.model', coreModel().slice(0, 300))),
    expect: { code: MALFORMED },
  },
  {
    name: 'child XML truncated mid-element',
    build: () => packageBytes(productionPackage(undefined, childModel().slice(0, 250))),
    expect: { code: MALFORMED },
  },
  {
    name: 'triangle index out of range',
    build: () =>
      packageBytes(
        corePackage(
          coreModel({
            resources: `<object id="1" type="model">${TETRAHEDRON_MESH.replace('v3="1"', 'v3="9"')}</object>`,
            build: '<item objectid="1"/>',
          }),
        ),
      ),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfBadVertexIndex },
  },
  {
    name: 'non-finite vertex coordinate',
    build: () =>
      packageBytes(
        corePackage(
          coreModel({
            resources: `<object id="1" type="model">${TETRAHEDRON_MESH.replace('x="10"', 'x="NaN"')}</object>`,
            build: '<item objectid="1"/>',
          }),
        ),
      ),
    expect: { code: MALFORMED, reason: ImportRefusal.ThreeMfNonFinite },
  },
  {
    name: 'root replaced by bytes that are not XML',
    build: () => packageBytes(replaced(corePackage(), '3D/3dmodel.model', '  not xml')),
    expect: { code: MALFORMED },
  },

  /* ----------------------------------------------------- archive bytes -- */
  ...[0.05, 0.3, 0.6, 0.9, 0.999].map((fraction): ArchiveCase => ({
    name: `production archive truncated to ${String(fraction * 100)}%`,
    build: async (): Promise<Uint8Array> => {
      const archive = await packageBytes(productionPackage());
      return archive.subarray(0, Math.floor(archive.byteLength * fraction));
    },
  })),
  ...[false, true].map((zip64): ArchiveCase => ({
    name: `corrupt deflate stream in the child part${zip64 ? ' (Zip64)' : ''}`,
    build: async (): Promise<Uint8Array> => {
      const archive = await packageBytes(productionPackage(undefined, undefined, zip64));
      const at = dataOffsetOf(archive, CHILD_ENTRY);
      return flipByte(flipByte(archive, at), at + 1);
    },
    // Before Stage 6D-A4 the decompressor's own TypeError escaped untyped.
    expect: { code: MALFORMED, reason: ImportRefusal.ZipMalformed },
  })),
  {
    name: 'central directory signature destroyed',
    build: async (): Promise<Uint8Array> => {
      const archive = await packageBytes(corePackage());
      const view = new DataView(archive.buffer);
      const central = view.getUint32(archive.byteLength - 22 + 16, true);
      return flipByte(archive, central);
    },
    expect: { code: MALFORMED, reason: ImportRefusal.ZipMalformed },
  },
  {
    name: 'EOCD entry count raised past the directory',
    build: async (): Promise<Uint8Array> => {
      const archive = await packageBytes(corePackage());
      const view = new DataView(archive.buffer);
      view.setUint16(archive.byteLength - 22 + 8, 9, true);
      view.setUint16(archive.byteLength - 22 + 10, 9, true);
      return archive;
    },
    expect: { code: MALFORMED, reason: ImportRefusal.ZipMalformed },
  },
  {
    name: 'Zip64 record signature destroyed',
    build: async (): Promise<Uint8Array> => {
      const archive = await packageBytes(productionPackage(undefined, undefined, true));
      return flipByte(archive, archive.byteLength - 98);
    },
    expect: { code: MALFORMED, reason: ImportRefusal.ZipMalformed },
  },
  {
    name: 'Zip64 locator pointing into the local data',
    build: async (): Promise<Uint8Array> => {
      const archive = await packageBytes(productionPackage(undefined, undefined, true));
      new DataView(archive.buffer).setUint32(archive.byteLength - 42 + 8, 10, true);
      return archive;
    },
    expect: { code: MALFORMED, reason: ImportRefusal.ZipMalformed },
  },
  {
    name: 'Zip64 central directory offset past the archive',
    build: async (): Promise<Uint8Array> => {
      const archive = await packageBytes(productionPackage(undefined, undefined, true));
      new DataView(archive.buffer).setUint32(
        archive.byteLength - 98 + 48,
        archive.byteLength,
        true,
      );
      return archive;
    },
    expect: { code: MALFORMED, reason: ImportRefusal.ZipMalformed },
  },
  {
    name: 'entry flagged as encrypted',
    build: async (): Promise<Uint8Array> => {
      const archive = await packageBytes(corePackage());
      const view = new DataView(archive.buffer);
      const central = view.getUint32(archive.byteLength - 22 + 16, true);
      view.setUint16(central + 8, 1, true);
      return archive;
    },
    expect: { code: MALFORMED, reason: ImportRefusal.ZipEncrypted },
  },
  {
    name: 'unsupported compression method',
    build: async (): Promise<Uint8Array> => {
      const archive = await packageBytes(corePackage());
      const view = new DataView(archive.buffer);
      const central = view.getUint32(archive.byteLength - 22 + 16, true);
      view.setUint16(central + 10, 12, true);
      return archive;
    },
    expect: { code: MALFORMED, reason: ImportRefusal.ZipUnsupportedMethod },
  },
  {
    name: 'declared size smaller than the stream (overrun)',
    build: () =>
      buildZip([
        ...corePackage()
          .entries.slice(0, 2)
          .map((entry) => ({ ...entry, method: 8 })),
        {
          name: '3D/3dmodel.model',
          content: coreModel(),
          method: 8,
          declaredUncompressedSize: 64,
        },
      ]),
    expect: { code: MALFORMED, reason: ImportRefusal.ZipDeclaredSizeOverrun },
  },
  {
    name: 'declared size larger than the stream (shortfall)',
    build: () =>
      buildZip([
        ...corePackage()
          .entries.slice(0, 2)
          .map((entry) => ({ ...entry, method: 8 })),
        {
          name: '3D/3dmodel.model',
          content: coreModel(),
          method: 8,
          declaredUncompressedSize: coreModel().length + 10,
        },
      ]),
    expect: { code: MALFORMED, reason: ImportRefusal.ZipDeclaredSizeShortfall },
  },
  {
    name: 'huge declared size (a claim, not an allocation)',
    build: () =>
      buildZip([
        {
          name: '3D/3dmodel.model',
          content: coreModel(),
          method: 8,
          declaredUncompressedSize: 0xfffffff0,
        },
      ]),
    expect: { code: RESOURCE },
  },
  {
    name: 'ratio bomb declared honestly',
    build: () =>
      buildZip([{ name: '3D/3dmodel.model', content: new Uint8Array(4 * 1024 * 1024), method: 8 }]),
    expect: { code: RESOURCE, reason: ImportRefusal.ZipRatioExceeded },
  },
];

describe('A4-M: 3MF mutations — every outcome is a correct import or a typed refusal', () => {
  it('runs dozens of cases', () => {
    expect(THREEMF_CASES.length).toBeGreaterThanOrEqual(50);
  });

  for (const testCase of THREEMF_CASES) {
    it(testCase.name, async () => {
      const outcome = await outcomeOf(await testCase.build(), 'mutated.3mf');
      expectInvariant(outcome);
      const expected = testCase.expect;
      if (expected === undefined) return;
      if ('imported' in expected) {
        expect(outcome.kind).toBe('imported');
        if (outcome.kind !== 'imported') return;
        if (expected.parts !== undefined) expect(outcome.parts).toBe(expected.parts);
        if (expected.triangles !== undefined) expect(outcome.triangles).toBe(expected.triangles);
        return;
      }
      expect(outcome).toMatchObject({ kind: 'refused', code: expected.code });
      if (expected.reason !== undefined && outcome.kind === 'refused') {
        expect(outcome.reason).toBe(expected.reason);
      }
    });
  }

  it('a cancelled read of every seed is OPERATION_CANCELLED, never partial', async () => {
    for (const spec of [
      corePackage(),
      productionPackage(),
      productionPackage(undefined, undefined, true),
    ]) {
      const outcome = await outcomeOf(await packageBytes(spec), 'seed.3mf', true);
      expect(outcome).toMatchObject({ kind: 'refused', code: AppErrorCode.OperationCancelled });
    }
  });
});

/* ------------------------------------------------------- STL and OBJ -- */

interface TextCase {
  readonly name: string;
  readonly fileName: string;
  readonly bytes: () => Uint8Array;
  readonly expect?:
    | { readonly imported: true; readonly triangles: number }
    | { readonly code: string; readonly reason?: string };
}

const BINARY = buildBinaryStl([UNIT_TRIANGLE, triangleAt(3), triangleAt(6)]);
const ASCII = buildAsciiStl([UNIT_TRIANGLE, triangleAt(3)]);
const OBJ = 'o A\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 2 4\nf 1 3 4\nf 2 3 4\n';
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const STL_OBJ_CASES: readonly TextCase[] = [
  {
    name: 'binary STL seed',
    fileName: 'a.stl',
    bytes: () => BINARY,
    expect: { imported: true, triangles: 3 },
  },
  {
    name: 'ASCII STL seed',
    fileName: 'a.stl',
    bytes: () => ASCII,
    expect: { imported: true, triangles: 2 },
  },
  {
    name: 'OBJ seed',
    fileName: 'a.obj',
    bytes: () => text(OBJ),
    expect: { imported: true, triangles: 4 },
  },

  ...[1, 49, 50, 83, 100, 133].map((cut): TextCase => ({
    name: `binary STL with ${String(cut)} bytes cut from the end`,
    fileName: 'a.stl',
    bytes: () => BINARY.subarray(0, BINARY.byteLength - cut),
  })),
  {
    name: 'binary STL declaring more triangles than it holds',
    fileName: 'a.stl',
    bytes: (): Uint8Array => {
      const copy = BINARY.slice();
      new DataView(copy.buffer).setUint32(80, 9, true);
      return copy;
    },
    expect: { code: MALFORMED },
  },
  {
    name: 'binary STL declaring 2^32-1 triangles',
    fileName: 'a.stl',
    bytes: (): Uint8Array => {
      const copy = BINARY.slice();
      new DataView(copy.buffer).setUint32(80, 0xffffffff, true);
      return copy;
    },
  },
  {
    name: 'binary STL with a NaN coordinate',
    fileName: 'a.stl',
    bytes: (): Uint8Array => {
      const copy = BINARY.slice();
      new DataView(copy.buffer).setFloat32(84 + 12, Number.NaN, true);
      return copy;
    },
    expect: { code: MALFORMED },
  },
  {
    name: 'ASCII STL cut mid-facet',
    fileName: 'a.stl',
    bytes: () => ASCII.subarray(0, Math.floor(ASCII.byteLength * 0.6)),
  },
  {
    name: 'ASCII STL with a word where a coordinate belongs',
    fileName: 'a.stl',
    bytes: () => text(new TextDecoder().decode(ASCII).replace('vertex 1', 'vertex one')),
    expect: { code: MALFORMED },
  },
  {
    name: 'ASCII STL with an unbounded token',
    fileName: 'a.stl',
    bytes: () =>
      text(`solid a\nfacet normal 0 0 1\nouter loop\nvertex ${'9'.repeat(100_000)} 0 0\n`),
    expect: { code: MALFORMED },
  },
  {
    name: 'ASCII STL with classic-Mac line endings',
    fileName: 'a.stl',
    bytes: () => buildAsciiStl([UNIT_TRIANGLE], { lineEnding: '\r' }),
    expect: { imported: true, triangles: 1 },
  },
  {
    name: 'OBJ forward reference',
    fileName: 'a.obj',
    bytes: () => text('v 0 0 0\nv 1 0 0\nf 1 2 3\nv 0 1 0\n'),
    expect: { code: MALFORMED, reason: ImportRefusal.ObjBadIndex },
  },
  {
    name: 'OBJ index zero',
    fileName: 'a.obj',
    bytes: () => text(OBJ.replace('f 1 2 3', 'f 0 2 3')),
    expect: { code: MALFORMED, reason: ImportRefusal.ObjZeroIndex },
  },
  {
    name: 'OBJ negative index past the start',
    fileName: 'a.obj',
    bytes: () => text(OBJ.replace('f 1 2 3', 'f -9 -2 -1')),
    expect: { code: MALFORMED, reason: ImportRefusal.ObjBadIndex },
  },
  {
    name: 'OBJ valid negative indices',
    fileName: 'a.obj',
    bytes: () => text('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n'),
    expect: { imported: true, triangles: 1 },
  },
  // Before Stage 6D-A4 every one of these imported: `Number` coerced the
  // position index and the texture/normal components were never looked at.
  ...['1/x', '0x2', '1e0', '1.0', '1/2/3/4', '1/2x'].map((corner): TextCase => ({
    name: `OBJ malformed face corner ${corner}`,
    fileName: 'a.obj',
    bytes: () => text(OBJ.replace('f 1 2 3', `f ${corner} 2 3`)),
    expect: { code: MALFORMED, reason: ImportRefusal.ObjBadIndex },
  })),
  ...['1/', '1//', '1/2', '1//3', '1/2/3', '+1'].map((corner): TextCase => ({
    name: `OBJ face corner shape ${corner} still imports`,
    fileName: 'a.obj',
    bytes: () => text(OBJ.replace('f 1 2 3', `f ${corner} 2 3`)),
    expect: { imported: true, triangles: 4 },
  })),
  {
    name: 'OBJ quad',
    fileName: 'a.obj',
    bytes: () => text(OBJ.replace('f 1 2 3', 'f 1 2 3 4')),
    expect: { code: UNSUPPORTED, reason: ImportRefusal.ObjPolygonUnsupported },
  },
  {
    name: 'OBJ non-finite coordinate',
    fileName: 'a.obj',
    bytes: () => text(OBJ.replace('v 1 0 0', 'v 1e999 0 0')),
    expect: { code: MALFORMED, reason: ImportRefusal.ObjNonFinite },
  },
  {
    name: 'OBJ with only points and lines',
    fileName: 'a.obj',
    bytes: () => text('v 0 0 0\nv 1 0 0\np 1\nl 1 2\n'),
    expect: { code: MALFORMED, reason: ImportRefusal.ObjNoGeometry },
  },
  {
    name: 'OBJ with CRLF, comments, smoothing, groups and an unread material library',
    fileName: 'a.obj',
    bytes: () =>
      text(
        '# comment\r\nmtllib absent.mtl\r\no A\r\nv 0 0 0\r\nv 1 0 0\r\nv 0 1 0\r\nv 0 0 1\r\n' +
          's 1\r\ng top\r\nusemtl red\r\nf 1 2 3\r\ns off\r\nf 1 2 4\r\n',
      ),
    expect: { imported: true, triangles: 2 },
  },
  {
    name: 'OBJ scientific notation',
    fileName: 'a.obj',
    bytes: () => text('v 0 0 0\nv 1e1 0 0\nv 0 -2.5E-1 0\nf 1 2 3\n'),
    expect: { imported: true, triangles: 1 },
  },
];

describe('A4-M: STL and OBJ mutations — every outcome is a correct import or a typed refusal', () => {
  for (const testCase of STL_OBJ_CASES) {
    it(testCase.name, async () => {
      const outcome = await outcomeOf(testCase.bytes(), testCase.fileName);
      expectInvariant(outcome);
      const expected = testCase.expect;
      if (expected === undefined) return;
      if ('imported' in expected) {
        expect(outcome).toMatchObject({ kind: 'imported', triangles: expected.triangles });
        return;
      }
      expect(outcome).toMatchObject({ kind: 'refused', code: expected.code });
      if (expected.reason !== undefined && outcome.kind === 'refused') {
        expect(outcome.reason).toBe(expected.reason);
      }
    });
  }
});
