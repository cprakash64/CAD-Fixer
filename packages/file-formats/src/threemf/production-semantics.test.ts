import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import { DEFAULT_DOCUMENT_LIMITS, distinctMeshes } from '@cadfixer/mesh-core';
import { UnsupportedFeature } from '../document-reader';
import { ImportRefusal, refusalOf } from '../import-errors';
import { testReadContext } from '../test-context';
import { DEFAULT_3MF_LIMITS, read3mf, type ThreeMfExpansionStats } from './threemf-reader';
import { createInflationBudget, DEFAULT_ZIP_LIMITS, readZipDirectory, type ZipLimits } from './zip';
import { buildZip, CONTENT_TYPES } from './zip-fixtures';

/**
 * A3 — PRODUCTION EXTENSION SEMANTICS, AGAINST THE NORMATIVE TEXT.
 *
 * Stage 6D-A2 made a production-extension package import. This suite is the one
 * that checks the semantics are the SPECIFICATION'S rather than the ones that
 * happened to make A2's fixtures pass, and it is organised around normative
 * sentences rather than around code paths.
 *
 * THE RULES IT PINS, quoted from the production extension and 3MF core:
 *
 *   - "The use of the path attribute in a component element is ONLY valid in
 *     the root model file... Any consumer of a 3MF package that contains path
 *     attributes in components in a non-root model file MUST generate an error"
 *   - "Other model streams SHOULD contain empty build sections. Every consumer
 *     MUST ignore the build section entries of all referenced child model
 *     files"
 *   - "All of the resources associated with the referenced object... MUST come
 *     from the referenced object file"
 *   - core: "Consumers MUST ignore all XML nodes and attributes from namespaces
 *     it does not explicitely support"
 *   - core: `requiredextensions` is a "space-delimited list of namespace
 *     prefixes", and a consumer "MUST NOT process this model-file if they do
 *     not support the required extensions"
 *   - core: the root model part is the target of the OPC relationship of type
 *     `http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel`
 *   - core: `unit` is one of micron, millimeter, centimeter, inch, foot, meter,
 *     defaulting to millimeter
 *   - core: resource ids are `xs:positiveInteger` below 2^31
 *   - core: `transform` is a row-major affine 3x4, twelve values
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: that a refusal happened. Almost every case
 * below either states the geometry that arrives or names the construct that was
 * refused, because a wrong successful import is worse than a refusal and only
 * the first kind of assertion can tell them apart.
 */

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const ALTERNATIVES_NS =
  'http://schemas.microsoft.com/3dmanufacturing/production/alternatives/2021/04';
const MODEL_REL_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

/** A root `.rels` naming `target` as the package's 3D model part. */
function relsNaming(target: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rel0" Target="${target}" Type="${MODEL_REL_TYPE}"/>` +
    '</Relationships>'
  );
}

const RELS = relsNaming('/3D/3dmodel.model');

/** A one-triangle mesh whose every vertex x is `marker`. Identifies its source. */
function markerMesh(marker: number): string {
  return (
    '<mesh><vertices>' +
    `<vertex x="${String(marker)}" y="0" z="0"/>` +
    `<vertex x="${String(marker)}" y="1" z="0"/>` +
    `<vertex x="${String(marker)}" y="0" z="1"/>` +
    '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>'
  );
}

function markerOf(positions: ArrayLike<number>): number {
  return positions[0] ?? Number.NaN;
}

/** `count` unshared triangles, for the counting-boundary cases. */
function bulkMesh(count: number): string {
  const vertices: string[] = [];
  const triangles: string[] = [];
  for (let n = 0; n < count; n += 1) {
    vertices.push(
      `<vertex x="${String(n)}" y="0" z="0"/>` +
        `<vertex x="${String(n)}" y="1" z="0"/>` +
        `<vertex x="${String(n)}" y="0" z="1"/>`,
    );
    const base = n * 3;
    triangles.push(
      `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`,
    );
  }
  return `<mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh>`;
}

interface ModelSource {
  readonly attrs?: string;
  readonly resources?: string;
  readonly build?: string;
  readonly unit?: string | undefined;
  /** Namespace declarations, so a test can choose its own prefixes. */
  readonly xmlns?: string;
}

function model(source: ModelSource = {}): string {
  const unit = source.unit === undefined ? '' : ` unit="${source.unit}"`;
  const ns = source.xmlns ?? ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}"`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<model${unit}${ns}${source.attrs ?? ''}>` +
    `<resources>${source.resources ?? ''}</resources>` +
    `<build>${source.build ?? ''}</build>` +
    '</model>'
  );
}

interface PackageSource {
  readonly root?: string;
  readonly parts?: Readonly<Record<string, string>>;
  /** Replaces the root `.rels`, or omits it entirely when `null`. */
  readonly rels?: string | null;
  /** Replaces `[Content_Types].xml`, or omits it when `null`. */
  readonly contentTypes?: string | null;
  /** Entry name for the root model. Defaults to the conventional path. */
  readonly rootAt?: string;
}

async function packageOf(source: PackageSource): Promise<Uint8Array> {
  const entries: { name: string; method: 8; content: string }[] = [];
  if (source.contentTypes !== null) {
    entries.push({
      name: '[Content_Types].xml',
      method: 8,
      content: source.contentTypes ?? CONTENT_TYPES,
    });
  }
  if (source.rels !== null) {
    entries.push({ name: '_rels/.rels', method: 8, content: source.rels ?? RELS });
  }
  if (source.root !== undefined) {
    entries.push({ name: source.rootAt ?? '3D/3dmodel.model', method: 8, content: source.root });
  }
  for (const [name, content] of Object.entries(source.parts ?? {})) {
    entries.push({ name, method: 8, content });
  }
  return buildZip(entries);
}

interface Captured {
  readonly code: string;
  readonly reason: unknown;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

async function refusalFrom(
  source: PackageSource,
  options?: { limits?: typeof DEFAULT_3MF_LIMITS; zipLimits?: ZipLimits; budget?: unknown },
): Promise<Captured> {
  try {
    await read3mf(await packageOf(source), testReadContext(), {
      ...(options?.limits === undefined ? {} : { limits: options.limits }),
      ...(options?.zipLimits === undefined ? {} : { zipLimits: options.zipLimits }),
      ...(options?.budget === undefined
        ? {}
        : { budget: options.budget as ReturnType<typeof createInflationBudget> }),
    });
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      code: error.code,
      reason: refusalOf(error),
      message: error.message,
      details: { ...error.details },
    };
  }
  throw new Error('expected a refusal');
}

function stats(): ThreeMfExpansionStats {
  return { leafPlacementsVisited: 0, partsEmitted: 0, meshResourcesMaterialised: 0 };
}

/** The single-child package most cases below are a variation of. */
function childPackage(overrides: PackageSource = {}): PackageSource {
  return {
    root: model({
      build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
    }),
    parts: {
      '3D/Objects/a.model': model({
        resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
      }),
    },
    ...overrides,
  };
}

/* ================================================= namespaces and prefixes */

describe('A3-NS: meaning comes from the namespace URI, never from the prefix', () => {
  for (const prefix of ['p', 'prod', 'x', 'production', 'ns0']) {
    it(`follows a path bound to the namespace through prefix "${prefix}"`, async () => {
      const result = await read3mf(
        await packageOf({
          root: model({
            xmlns: ` xmlns="${CORE_NS}" xmlns:${prefix}="${PRODUCTION_NS}"`,
            build: `<item objectid="1" ${prefix}:path="/3D/Objects/a.model"/>`,
          }),
          parts: {
            '3D/Objects/a.model': model({
              resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
            }),
          },
        }),
        testReadContext(),
      );

      expect(result.document.parts).toHaveLength(1);
      expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(7);
    });
  }

  it('does NOT treat a bare `path` attribute as a production reference', async () => {
    /*
     * A `path` in no namespace is not this extension's attribute. Treating it as
     * one would let any file redirect a build item, and core requires a consumer
     * to ignore what it does not recognise — so the object resolves LOCALLY.
     */
    const result = await read3mf(
      await packageOf({
        root: model({
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          build: '<item objectid="1" path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    // THE ROOT'S mesh, not the child's: the attribute named no extension.
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(1);
  });

  it('does NOT treat a path from some other namespace as a production reference', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          xmlns: ` xmlns="${CORE_NS}" xmlns:q="http://example.invalid/other/2099"`,
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          build: '<item objectid="1" q:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(1);
  });

  it('carries no literal prefix text in the semantic logic', async () => {
    // Two packages identical but for the prefix must produce identical geometry.
    const withP = await read3mf(await packageOf(childPackage()), testReadContext());
    const withZ = await read3mf(
      await packageOf({
        root: model({
          xmlns: ` xmlns="${CORE_NS}" xmlns:zz="${PRODUCTION_NS}"`,
          build: '<item objectid="1" zz:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(markerOf(withZ.document.parts[0]?.mesh.positions ?? [])).toBe(
      markerOf(withP.document.parts[0]?.mesh.positions ?? []),
    );
  });
});

/* ============================================== requiredextensions tokens */

describe('A3-RX: requiredextensions is a list of PREFIXES, resolved through the map', () => {
  const cases: readonly {
    name: string;
    xmlns: string;
    required: string;
    imports: boolean;
    extension?: string;
  }[] = [
    {
      name: 'the production prefix alone',
      xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}"`,
      required: 'p',
      imports: true,
    },
    {
      name: 'production plus the core namespace',
      xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" xmlns:c="${CORE_NS}"`,
      required: 'p c',
      imports: true,
    },
    {
      name: 'production with runs of whitespace between tokens',
      xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" xmlns:c="${CORE_NS}"`,
      required: '  p \t\n c  ',
      imports: true,
    },
    {
      name: 'the same prefix listed twice',
      xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}"`,
      required: 'p p',
      imports: true,
    },
    {
      name: 'production plus an unknown extension',
      xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" xmlns:z="http://example.invalid/z/2099"`,
      required: 'p z',
      imports: false,
      extension: 'http://example.invalid/z/2099',
    },
    {
      name: 'a prefix that resolves to nothing',
      xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}"`,
      required: 'p ghost',
      imports: false,
      extension: 'ghost',
    },
    {
      name: 'the alternatives extension, which is a different extension',
      xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" xmlns:pa="${ALTERNATIVES_NS}"`,
      required: 'p pa',
      imports: false,
      extension: ALTERNATIVES_NS,
    },
  ];

  for (const entry of cases) {
    it(`${entry.imports ? 'accepts' : 'refuses'}: ${entry.name}`, async () => {
      const source: PackageSource = {
        root: model({
          xmlns: entry.xmlns,
          attrs: ` requiredextensions="${entry.required}"`,
          build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      };

      if (entry.imports) {
        const result = await read3mf(await packageOf(source), testReadContext());
        expect(result.document.parts).toHaveLength(1);
        return;
      }

      const refusal = await refusalFrom(source);
      expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
      expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
      if (entry.extension !== undefined) expect(refusal.details.extension).toBe(entry.extension);
    });
  }

  it('does not refuse an extension that is merely DECLARED and not required', async () => {
    /*
     * CORE: "Consumers MUST ignore all XML nodes and attributes from namespaces
     * it does not explicitely support." A declaration is not a use, and
     * refusing one would reject files every conforming reader opens — producers
     * routinely declare namespaces they do not populate.
     */
    const result = await read3mf(
      await packageOf({
        root: model({
          xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" xmlns:z="http://example.invalid/z/2099"`,
          build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
  });

  it('ignores an unknown element from a declared, unrequired namespace', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" xmlns:z="http://example.invalid/z/2099"`,
          resources: `<object id="1" type="model">${markerMesh(1)}<z:hint kind="whatever"/></object>`,
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(1);
  });

  it('refuses a required extension declared by a REFERENCED part', async () => {
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model': model({
          xmlns: ` xmlns="${CORE_NS}" xmlns:z="http://example.invalid/z/2099"`,
          attrs: ' requiredextensions="z"',
          resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
        }),
      },
    });

    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
  });
});

/* ======================================================= root model part == */

describe('A3-ROOT: the root model part is the one the package names', () => {
  it('follows the OPC relationship even when the path is unconventional', async () => {
    /*
     * CORE identifies the root model part by the relationship of type
     * `.../2013/01/3dmodel`, and the production extension adds that non-root
     * model files MUST NOT be referenced from the root `.rels` — so whatever it
     * names is the root and nothing else can be.
     *
     * THE DEFECT THIS FIXES was silent and only reachable after A2. The reader
     * used to take the first `.model` the ZIP DIRECTORY listed when the
     * conventional path was absent, which in a package like this one is a CHILD
     * part. It would then walk that child's build — which a consumer is
     * normatively required to ignore — and report its geometry as the model.
     */
    const result = await read3mf(
      await packageOf({
        rels: relsNaming('/3D/main.model'),
        rootAt: '3D/main.model',
        root: model({
          build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          // DELIBERATELY FIRST IN THE DIRECTORY and carrying its own build, so
          // the old fallback would have chosen it.
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
            build: '<item objectid="1"/>',
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(7);
  });

  it('accepts a relationship target written without a leading slash', async () => {
    // OPC permits a relative target; the extension's own examples write an
    // absolute one. Both must reach the same entry.
    const result = await read3mf(
      await packageOf({ ...childPackage(), rels: relsNaming('3D/3dmodel.model') }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });

  it('falls back to the conventional path when the relationship is absent', async () => {
    const result = await read3mf(
      await packageOf({ ...childPackage(), rels: null }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });

  it('falls back to the conventional path when the relationship names nothing real', async () => {
    // A broken `.rels` must not take away a root the package plainly has.
    const result = await read3mf(
      await packageOf({ ...childPackage(), rels: relsNaming('/3D/absent.model') }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });

  it('never FOLLOWS an unsafe relationship target', async () => {
    const result = await read3mf(
      await packageOf({ ...childPackage(), rels: relsNaming('/../../etc/passwd.model') }),
      testReadContext(),
    );
    // Ignored, and the conventional root used instead.
    expect(result.document.parts).toHaveLength(1);
  });

  it('accepts a single model part whatever it is called', async () => {
    const result = await read3mf(
      await packageOf({
        rels: null,
        rootAt: 'model/only.model',
        root: model({
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });

  it('refuses rather than guessing between several model parts', async () => {
    const refusal = await refusalFrom({
      rels: null,
      rootAt: '3D/one.model',
      root: model({
        resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        build: '<item objectid="1"/>',
      }),
      parts: {
        '3D/two.model': model({
          resources: `<object id="1" type="model">${markerMesh(2)}</object>`,
          build: '<item objectid="1"/>',
        }),
      },
    });

    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfAmbiguousRootModelPart);
    expect(refusal.details.modelParts).toBe(2);
  });

  /*
   * A4-ROOT — the 3MF Consortium's own POSITIVE conformance cases
   * (`P_XXX_0101_02`, `P_XXX_0102_01/02`, `P_XXX_0325_01`, `P_XXX_2202_01` and
   * their production-suite twins) name the root `/3D/3dmodel`,
   * `/3D/3dmodel.moodel` and `/3D/3dmodel.part`. The relationship TYPE is what
   * makes a part the 3D model; OPC does not constrain its extension. CAD Fixer
   * refused all of them as "not a 3MF file" before Stage 6D-A4.
   */
  for (const rootAt of ['3D/3dmodel', '3D/3dmodel.moodel', '3D/3dmodel.part']) {
    it(`A4-ROOT: follows the relationship to a root named ${rootAt}`, async () => {
      const result = await read3mf(
        await packageOf({
          rels: relsNaming(`/${rootAt}`),
          rootAt,
          root: model({
            resources: `<object id="1" type="model">${markerMesh(5)}</object>`,
            build: '<item objectid="1"/>',
          }),
        }),
        testReadContext(),
      );
      expect(result.document.parts).toHaveLength(1);
      expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(5);
    });
  }

  it('A4-ROOT: a non-.model root still reaches its production children', async () => {
    const result = await read3mf(
      await packageOf({
        rels: relsNaming('/3D/3dmodel.part'),
        rootAt: '3D/3dmodel.part',
        root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(9)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(9);
  });

  it('A4-ROOT: the relaxation is the ROOT relationship only — a production path keeps the .model rule', async () => {
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.part"/>' }),
      parts: {
        '3D/Objects/a.part': model({
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        }),
      },
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfModelPartNotAModel);
  });

  it('A4-ROOT: an unsafe non-.model relationship target is still never followed', async () => {
    const refusal = await refusalFrom({
      rels: relsNaming('/3D/../3D/3dmodel.part'),
      rootAt: '3D/3dmodel.part',
      root: model({
        resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        build: '<item objectid="1"/>',
      }),
    });
    // Not followed, and with no `.model` entry there is nothing else to use.
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfNoModelPart);
  });

  it('refuses an archive with no model part at all', async () => {
    const refusal = await refusalFrom({ rels: null });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfNoModelPart);
  });

  it('reads the relationships under the package’s one inflation budget', async () => {
    // The `.rels` is an entry like any other. A budget too small for the
    // package must refuse rather than treat relationships as free.
    const tiny = createInflationBudget({ ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 80 });
    await expect(
      read3mf(await packageOf(childPackage()), testReadContext(), { budget: tiny }),
    ).rejects.toBeDefined();
  });
});

/* ============================================= content types, deliberately */

describe('A3-CT: the content-types part is not a geometry gate', () => {
  it('imports a package whose content types are missing entirely', async () => {
    /*
     * DELIBERATE, AND DOCUMENTED RATHER THAN OVERLOOKED. A model part's content
     * type is packaging metadata; what decides whether CAD Fixer reads an entry
     * as geometry is that a production `path` names it, that the path ends in
     * `.model`, and that the bytes parse as a 3MF model through a fail-closed
     * scanner. Requiring a content type would add no protection — a non-model
     * entry still fails to parse — and would refuse packages whose declarations
     * differ only in form.
     */
    const result = await read3mf(
      await packageOf({ ...childPackage(), contentTypes: null }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });

  it('still refuses an entry that is named .model and is not one', async () => {
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: { '3D/Objects/a.model': 'this is not xml at all' },
    });
    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
  });
});

/* ========================================== referenced part validation === */

describe('A3-REF: a referenced part must itself be a 3MF model', () => {
  const badParts: readonly { name: string; xml: string; reason: unknown }[] = [
    {
      name: 'the wrong root element',
      xml: `<?xml version="1.0" encoding="UTF-8"?><catalogue xmlns="${CORE_NS}"><thing/></catalogue>`,
      reason: ImportRefusal.ThreeMfMalformedStructure,
    },
    {
      name: 'empty content',
      xml: '',
      reason: ImportRefusal.ThreeMfMalformedStructure,
    },
    {
      name: 'a truncated element',
      xml: `<?xml version="1.0" encoding="UTF-8"?><model xmlns="${CORE_NS}"><resources><object id="1"`,
      reason: ImportRefusal.ThreeMfMalformedStructure,
    },
  ];

  for (const entry of badParts) {
    it(`refuses a referenced part with ${entry.name}`, async () => {
      const refusal = await refusalFrom({
        root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: { '3D/Objects/a.model': entry.xml },
      });
      expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    });
  }

  it('accepts a referenced part that declares only the objects it is asked for', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model':
            `<?xml version="1.0" encoding="UTF-8"?><model xmlns="${CORE_NS}">` +
            `<resources><object id="1" type="model">${markerMesh(7)}</object></resources>` +
            '</model>',
        },
      }),
      testReadContext(),
    );
    // NO `<build>` ELEMENT AT ALL, which a referenced part is entitled to omit.
    expect(result.document.parts).toHaveLength(1);
  });

  it('refuses a referenced part whose XML carries a DOCTYPE', async () => {
    // FAIL-CLOSED BEFORE IT IS PARSED, for a child exactly as for the root.
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model':
          '<?xml version="1.0"?><!DOCTYPE model [<!ENTITY x "y">]>' +
          `<model xmlns="${CORE_NS}"><resources/><build/></model>`,
      },
    });
    expect(refusal.reason).toBe(ImportRefusal.XmlDoctypeRefused);
  });
});

/* ================================================= child build, ignored == */

describe('A3-CB: a referenced part’s build section is ignored', () => {
  it('A3-CB1: accepts an empty child build', async () => {
    const result = await read3mf(await packageOf(childPackage()), testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });

  it('A3-CB2/CB4: ignores a non-empty child build rather than placing it', async () => {
    /*
     * CORE-ADJACENT NORMATIVE TEXT: "Every consumer MUST ignore the build
     * section entries of all referenced child model files." A child's build
     * describes how that part looks ON ITS OWN, so importing it would add
     * placements the package never asked for and silently double the model.
     */
    const result = await read3mf(
      await packageOf({
        root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources:
              `<object id="1" type="model">${markerMesh(7)}</object>` +
              `<object id="2" type="model">${markerMesh(8)}</object>`,
            build:
              '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 999 0 0"/>' +
              '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 999 0"/>',
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(7);
    // AND THE IGNORED TRANSFORMS DID NOT LEAK IN.
    expect(result.document.parts[0]?.transform).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('A3-CB3: does not validate a child build it is required to ignore', async () => {
    /*
     * A CHILD BUILD NAMING A MISSING OBJECT MUST NOT REFUSE THE PACKAGE. The
     * consumer is required to ignore those entries, so validating them would
     * refuse files every conforming reader accepts — a false refusal bought
     * with no safety at all.
     */
    const result = await read3mf(
      await packageOf({
        root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
            build: '<item objectid="404"/>',
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(7);
  });

  it('still refuses a ROOT build that names a missing object', async () => {
    // The root's build IS authoritative, so it is still validated.
    const refusal = await refusalFrom({
      root: model({
        resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        build: '<item objectid="404"/>',
      }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfMissingObject);
  });
});

/* =============================================== non-root path, an error = */

describe('A3-NR: a path outside the root model file MUST generate an error', () => {
  it('refuses a chained component path, whatever prefix it uses', async () => {
    for (const prefix of ['p', 'other']) {
      const refusal = await refusalFrom({
        root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            xmlns: ` xmlns="${CORE_NS}" xmlns:${prefix}="${PRODUCTION_NS}"`,
            resources:
              '<object id="1" type="model"><components>' +
              `<component objectid="1" ${prefix}:path="/3D/Objects/b.model"/>` +
              '</components></object>',
          }),
          '3D/Objects/b.model': model({
            resources: `<object id="1" type="model">${markerMesh(9)}</object>`,
          }),
        },
      });

      expect(refusal.code).toBe(AppErrorCode.MalformedFile);
      expect(refusal.reason).toBe(ImportRefusal.ThreeMfNonRootModelPartPath);
    }
  });

  it('refuses it even when nested inside the child’s own components', async () => {
    // The rule is about the PART, not about depth. A chained path buried two
    // levels into a child's component graph must not slip past.
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model': model({
          resources:
            '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
            '<object id="2" type="model"><components>' +
            '<component objectid="1" p:path="/3D/Objects/b.model"/>' +
            '</components></object>',
        }),
        '3D/Objects/b.model': model({
          resources: `<object id="1" type="model">${markerMesh(9)}</object>`,
        }),
      },
    });

    expect(refusal.reason).toBe(ImportRefusal.ThreeMfNonRootModelPartPath);
  });

  it('refuses before resolving it locally', async () => {
    // The child ALSO declares the object the chained reference names. Falling
    // back to that would import plausible geometry for a package the
    // specification says must error.
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model': model({
          resources:
            `<object id="5" type="model">${markerMesh(5)}</object>` +
            '<object id="1" type="model"><components>' +
            '<component objectid="5" p:path="/3D/Objects/b.model"/>' +
            '</components></object>',
        }),
        '3D/Objects/b.model': model({
          resources: `<object id="5" type="model">${markerMesh(9)}</object>`,
        }),
      },
    });

    expect(refusal.reason).toBe(ImportRefusal.ThreeMfNonRootModelPartPath);
  });

  it('allows a path on a component in the ROOT part', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            '<object id="1" type="model"><components>' +
            '<component objectid="1" p:path="/3D/Objects/a.model"/>' +
            '</components></object>',
          build: '<item objectid="1"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(7);
  });
});

/* ==================================================== object id scoping == */

describe('A3-ID: an object id is scoped to the model part that declares it', () => {
  it('resolves three identical ids in three parts to three different meshes', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          build:
            '<item objectid="1"/>' +
            '<item objectid="1" p:path="/3D/Objects/a.model"/>' +
            '<item objectid="1" p:path="/3D/Objects/b.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(2)}</object>`,
          }),
          '3D/Objects/b.model': model({
            resources: `<object id="1" type="model">${markerMesh(3)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts.map((part) => markerOf(part.mesh.positions))).toEqual([1, 2, 3]);
    expect(distinctMeshes(result.document)).toHaveLength(3);
  });

  it('does not let a child resolve an object that only the root declares', async () => {
    /*
     * "All of the resources associated with the referenced object... MUST come
     * from the referenced object file." A child component naming an id only the
     * ROOT has is a broken child, not an invitation to look upwards.
     */
    const refusal = await refusalFrom({
      root: model({
        resources: `<object id="55" type="model">${markerMesh(1)}</object>`,
        build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources:
            '<object id="1" type="model"><components><component objectid="55"/></components></object>',
        }),
      },
    });

    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    // A LOCAL reference that did not resolve — not a package-level lookup.
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfMissingObject);
    expect(refusal.reason).not.toBe(ImportRefusal.ThreeMfMissingModelPartObject);
  });

  it('prefers the target part even when the root declares the same id', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );
    // The PATH scopes the lookup. The root's object 1 is irrelevant here.
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(7);
  });
});

describe('A3-IDV: resource ids are xs:positiveInteger below 2^31', () => {
  const illegal = ['0', '-1', '+1', '1.0', ' 1', '0x10', '1e3', 'steel', '', '2147483648'];
  for (const id of illegal) {
    it(`refuses a property reference of ${JSON.stringify(id)}`, async () => {
      const refusal = await refusalFrom({
        root: model({
          resources: `<object id="1" type="model" pid="${id}">${markerMesh(1)}</object>`,
          build: '<item objectid="1"/>',
        }),
      });
      // Either the shape is wrong or it names nothing. Both are malformed, and
      // neither silently carries a non-id through as one.
      expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    });
  }

  it('accepts the maximum legal resource id', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            '<basematerials id="2147483647"><base name="x" displaycolor="#FFFFFF"/></basematerials>' +
            `<object id="1" type="model" pid="2147483647">${markerMesh(1)}</object>`,
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });

  it('refuses two objects sharing an id inside one model part', async () => {
    const refusal = await refusalFrom({
      root: model({
        resources:
          `<object id="1" type="model">${markerMesh(1)}</object>` +
          `<object id="1" type="model">${markerMesh(2)}</object>`,
        build: '<item objectid="1"/>',
      }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfDuplicateObjectId);
  });

  it('accepts the same id in two different model parts', async () => {
    const result = await read3mf(await packageOf(childPackage()), testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });
});

/* ================================================= forward declarations == */

describe('A3-FWD: a reference may precede the resource it names', () => {
  it('resolves a component declared before its target object', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
            `<object id="2" type="model">${markerMesh(4)}</object>`,
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(4);
  });

  it('resolves a build item declared before its object, and across a part', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({ build: '<item objectid="9" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources:
              '<object id="9" type="model"><components><component objectid="8"/></components></object>' +
              `<object id="8" type="model">${markerMesh(6)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(6);
  });

  it('resolves a property reference declared before its resource', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            `<object id="1" type="model" pid="5">${markerMesh(1)}</object>` +
            '<basematerials id="5"><base name="x" displaycolor="#FFFFFF"/></basematerials>',
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });
});

/* ======================================================= transforms ====== */

describe('A3-TX: the transform is a row-major affine 3x4', () => {
  it('composes item, root component and child component in the spec’s order', async () => {
    /*
     * CHOSEN SO AN INCORRECT MULTIPLICATION ORDER CANNOT PASS. The outer
     * transform is a 90-degree rotation about Z and the inner one a pure
     * translation along X. Under the correct row-vector order the inner
     * translation is EXPRESSED IN the outer frame and lands on +Y; reversed, it
     * would stay on +X.
     */
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            '<object id="1" type="model"><components>' +
            '<component objectid="1" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>' +
            '</components></object>',
          build: '<item objectid="1" transform="0 1 0 -1 0 0 0 0 1 0 0 0"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(0)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    const transform = result.document.parts[0]?.transform ?? [];
    // Rotation preserved...
    expect([...transform].slice(0, 9)).toEqual([0, 1, 0, -1, 0, 0, 0, 0, 1]);
    // ...and the inner +10 along X arrives at +10 along Y.
    expect([...transform].slice(9)).toEqual([0, 10, 0]);
  });

  it('keeps a non-uniform scale, a reflection and a rotation exactly', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources: `<object id="1" type="model">${markerMesh(0)}</object>`,
          build: '<item objectid="1" transform="2 0 0 0 -3 0 0 0 0.5 1.5 -2.5 0"/>',
        }),
      }),
      testReadContext(),
    );
    expect(result.document.parts[0]?.transform).toEqual([
      2, 0, 0, 0, -3, 0, 0, 0, 0.5, 1.5, -2.5, 0,
    ]);
  });

  it('defaults an ABSENT transform to identity', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources: `<object id="1" type="model">${markerMesh(0)}</object>`,
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );
    expect(result.document.parts[0]?.transform).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });
});

describe('A3-TXV: a malformed transform is never defaulted to identity', () => {
  const bad: readonly { name: string; value: string }[] = [
    { name: 'eleven values', value: '1 0 0 0 1 0 0 0 1 0 0' },
    { name: 'thirteen values', value: '1 0 0 0 1 0 0 0 1 0 0 0 0' },
    { name: 'a NaN token', value: '1 0 0 0 1 0 0 0 1 NaN 0 0' },
    { name: 'an infinity token', value: '1 0 0 0 1 0 0 0 1 Infinity 0 0' },
    { name: 'a hexadecimal token', value: '1 0 0 0 1 0 0 0 1 0x10 0 0' },
    { name: 'a word', value: '1 0 0 0 1 0 0 0 1 ten 0 0' },
    { name: 'an overflowing exponent', value: '1 0 0 0 1 0 0 0 1 1e400 0 0' },
    { name: 'a trailing comma', value: '1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0' },
  ];

  for (const entry of bad) {
    it(`refuses ${entry.name}`, async () => {
      const refusal = await refusalFrom({
        root: model({
          resources: `<object id="1" type="model">${markerMesh(0)}</object>`,
          build: `<item objectid="1" transform="${entry.value}"/>`,
        }),
      });
      expect(refusal.code).toBe(AppErrorCode.MalformedFile);
      expect(refusal.reason).toBe(ImportRefusal.ThreeMfBadTransform);
    });
  }

  it('accepts an EMPTY transform as identity, which is not the same thing', async () => {
    // An absent or empty attribute states nothing; a present but unusable one
    // states something wrong. Only the second is a refusal.
    const result = await read3mf(
      await packageOf({
        root: model({
          resources: `<object id="1" type="model">${markerMesh(0)}</object>`,
          build: '<item objectid="1" transform=""/>',
        }),
      }),
      testReadContext(),
    );
    expect(result.document.parts[0]?.transform).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('accepts every valid xs:double spelling', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources: `<object id="1" type="model">${markerMesh(0)}</object>`,
          build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 +1.5 -2. .25"/>',
        }),
      }),
      testReadContext(),
    );
    expect([...(result.document.parts[0]?.transform ?? [])].slice(9)).toEqual([1.5, -2, 0.25]);
  });
});

/* ============================================================ units ====== */

describe('A3-U: units are the six core tokens, and reachable parts must agree', () => {
  const units = ['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter'] as const;

  for (const unit of units) {
    it(`accepts a package that agrees on ${unit}`, async () => {
      const result = await read3mf(
        await packageOf({
          root: model({ unit, build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
          parts: {
            '3D/Objects/a.model': model({
              unit,
              resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
            }),
          },
        }),
        testReadContext(),
      );
      expect(result.document.unit).toBe(unit);
    });
  }

  it('refuses a unit outside the six', async () => {
    const refusal = await refusalFrom({
      root: model({
        unit: 'furlong',
        resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        build: '<item objectid="1"/>',
      }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedUnit);
  });

  it('refuses a unit that differs only in case, because the tokens are case-sensitive', async () => {
    // `Millimeter` is not one of the enumerated values. Normalising it would be
    // inventing a spelling the format does not define.
    const refusal = await refusalFrom({
      root: model({
        unit: 'Millimeter',
        resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        build: '<item objectid="1"/>',
      }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedUnit);
  });

  it('treats an absent unit as millimetre, so root-absent and child-millimetre agree', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            unit: 'millimeter',
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );
    expect(result.document.unit).toBe('millimeter');
  });

  it('refuses root-absent against a child in inches', async () => {
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model': model({
          unit: 'inch',
          resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
        }),
      },
    });
    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfInconsistentModelPartUnits);
    expect(refusal.details.rootUnit).toBe('millimeter');
    expect(refusal.details.partUnit).toBe('inch');
  });

  it('never rescales: the same numbers arrive under either agreed unit', async () => {
    const read = async (unit: string): Promise<readonly number[]> => {
      const result = await read3mf(
        await packageOf({
          root: model({ unit, build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
          parts: {
            '3D/Objects/a.model': model({
              unit,
              resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
            }),
          },
        }),
        testReadContext(),
      );
      return [...(result.document.parts[0]?.mesh.positions ?? [])];
    };
    expect(await read('inch')).toEqual(await read('meter'));
  });

  it('ignores the unit of a model part nothing references', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          unit: 'millimeter',
          build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            unit: 'millimeter',
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
          '3D/Objects/unused.model': model({
            unit: 'micron',
            resources: `<object id="1" type="model">${markerMesh(8)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );
    expect(result.document.unit).toBe('millimeter');
  });
});

/* ============================================ alternatives and unknowns == */

describe('A3-ALT: the alternatives extension is a different, unimplemented extension', () => {
  it('refuses an alternatives element rather than importing the base object', async () => {
    /*
     * IT DECIDES WHICH GEOMETRY THE OBJECT IS — `fullres`, `lowres` or
     * `obfuscated`, the last being "a modified version hiding sensitive zones".
     * Importing whatever the base object holds and calling it the model could
     * hand a user an obscured representation as their part.
     */
    const refusal = await refusalFrom({
      root: model({
        xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" xmlns:pa="${ALTERNATIVES_NS}"`,
        resources:
          `<object id="1" type="model">${markerMesh(1)}` +
          '<pa:alternatives><pa:alternative p:path="/3D/Objects/a.model" objectid="1"/></pa:alternatives>' +
          '</object>',
        build: '<item objectid="1"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
        }),
      },
    });

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfModelResolutionUnsupported);
  });

  it('recognises it whatever prefix binds the namespace', async () => {
    const refusal = await refusalFrom({
      root: model({
        xmlns: ` xmlns="${CORE_NS}" xmlns:alt="${ALTERNATIVES_NS}"`,
        resources: `<object id="1" type="model">${markerMesh(1)}<alt:alternatives/></object>`,
        build: '<item objectid="1"/>',
      }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfModelResolutionUnsupported);
  });

  it('does not refuse an element of that name from some other namespace', async () => {
    // "Contains the word alternatives" is not a namespace. An unrelated
    // extension's element of the same local name is ignored, as core requires.
    const result = await read3mf(
      await packageOf({
        root: model({
          xmlns: ` xmlns="${CORE_NS}" xmlns:q="http://example.invalid/q/2099"`,
          resources: `<object id="1" type="model">${markerMesh(1)}<q:alternatives/></object>`,
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });
});

describe('A3-SEC: Secure Content and unknown extensions cannot slip through', () => {
  const namespaces: readonly string[] = [
    'http://schemas.microsoft.com/3dmanufacturing/securecontent/2019/04',
    'http://schemas.microsoft.com/3dmanufacturing/slice/2015/07',
    'http://example.invalid/future/2099',
  ];

  for (const namespace of namespaces) {
    it(`refuses a package requiring ${namespace.slice(0, 60)}`, async () => {
      const refusal = await refusalFrom({
        root: model({
          xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" xmlns:z="${namespace}"`,
          attrs: ' requiredextensions="p z"',
          build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      });

      expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
      expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
      expect(refusal.details.extension).toBe(namespace);
      // NEVER a generic malformed accusation, and never a decryption attempt.
      expect(refusal.code).not.toBe(AppErrorCode.MalformedFile);
    });
  }

  it('does not treat a URI as production merely because it says production', async () => {
    // A future or unrelated version is not this extension. Assuming semantics
    // from a URI's shape is how a version's changes get silently adopted.
    const refusal = await refusalFrom({
      root: model({
        xmlns: ` xmlns="${CORE_NS}" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2099/01"`,
        attrs: ' requiredextensions="p"',
        resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        build: '<item objectid="1"/>',
      }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
  });
});

/* ================================================================ UUID === */

describe('A3-UUID: p:UUID is producer metadata a geometry consumer may ignore', () => {
  const uuids: readonly { name: string; value: string }[] = [
    { name: 'a well-formed UUID', value: 'b1d4f5a0-1c2e-4a3b-8c9d-0e1f2a3b4c5d' },
    { name: 'a malformed UUID', value: 'not-a-uuid' },
    { name: 'an empty UUID', value: '' },
  ];

  for (const entry of uuids) {
    it(`imports with ${entry.name} on the build, item, object and component`, async () => {
      /*
       * THE SPECIFICATION PUTS UUIDs ON PRODUCERS: "Producers MUST include
       * UUID's for all build items", and it mandates no consumer validation of
       * their format or uniqueness. Refusing a geometry import over a
       * traceability string would reject working files for a field CAD Fixer
       * does not read.
       */
      const result = await read3mf(
        await packageOf({
          root: model({
            resources:
              `<object id="2" type="model" p:UUID="${entry.value}">${markerMesh(1)}</object>` +
              `<object id="1" type="model" p:UUID="${entry.value}"><components>` +
              `<component objectid="2" p:UUID="${entry.value}"/></components></object>`,
            build: `<item objectid="1" p:UUID="${entry.value}"/>`,
          }),
        }),
        testReadContext(),
      );
      expect(result.document.parts).toHaveLength(1);
      expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(1);
    });
  }

  it('imports a package whose build carries no UUID at all', async () => {
    const result = await read3mf(await packageOf(childPackage()), testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });

  it('accepts duplicate UUIDs across objects', async () => {
    const same = 'b1d4f5a0-1c2e-4a3b-8c9d-0e1f2a3b4c5d';
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            `<object id="1" type="model" p:UUID="${same}">${markerMesh(1)}</object>` +
            `<object id="2" type="model" p:UUID="${same}">${markerMesh(2)}</object>`,
          build: '<item objectid="1"/><item objectid="2"/>',
        }),
      }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(2);
  });
});

/* ========================================================= cycles, depth = */

describe('A3-CYC: cycles are refused and depth is bounded, and they are different', () => {
  it('refuses a two-object same-part cycle', async () => {
    const refusal = await refusalFrom({
      root: model({
        resources:
          '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
          '<object id="2" type="model"><components><component objectid="1"/></components></object>',
        build: '<item objectid="1"/>',
      }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfComponentCycle);
  });

  it('refuses a three-object same-part cycle', async () => {
    const refusal = await refusalFrom({
      root: model({
        resources:
          '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
          '<object id="2" type="model"><components><component objectid="3"/></components></object>' +
          '<object id="3" type="model"><components><component objectid="1"/></components></object>',
        build: '<item objectid="1"/>',
      }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfComponentCycle);
  });

  it('refuses a cycle back into the root through a child part', async () => {
    // Structurally this is also a non-root path, which the specification says
    // MUST error — so the refusal names that rule rather than the cycle. Both
    // are refusals; neither expands.
    const refusal = await refusalFrom({
      root: model({
        resources:
          '<object id="1" type="model"><components>' +
          '<component objectid="1" p:path="/3D/Objects/a.model"/></components></object>',
        build: '<item objectid="1"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources:
            '<object id="1" type="model"><components>' +
            '<component objectid="1" p:path="/3D/3dmodel.model"/></components></object>',
        }),
      },
    });
    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfNonRootModelPartPath);
  });

  /**
   * A BUILD ITEM IS LEVEL ZERO, so a chain of `maxComponentDepth` components
   * below it is the deepest that expands. Written as a generator so the
   * boundary is exercised at the shipped number rather than at a convenient one.
   */
  function chain(levels: number): string {
    const objects: string[] = [`<object id="1" type="model">${markerMesh(1)}</object>`];
    for (let level = 1; level <= levels; level += 1) {
      objects.push(
        `<object id="${String(level + 1)}" type="model"><components>` +
          `<component objectid="${String(level)}"/></components></object>`,
      );
    }
    return model({
      resources: objects.join(''),
      build: `<item objectid="${String(levels + 1)}"/>`,
    });
  }

  it('accepts a chain exactly at the depth ceiling', async () => {
    const result = await read3mf(
      await packageOf({ root: chain(DEFAULT_3MF_LIMITS.maxComponentDepth) }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });

  it('refuses one level past it, as a RESOURCE limit and not as a cycle', async () => {
    const refusal = await refusalFrom({
      root: chain(DEFAULT_3MF_LIMITS.maxComponentDepth + 1),
    });
    expect(refusal.code).toBe(AppErrorCode.ResourceLimitExceeded);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfComponentTooDeep);
    expect(refusal.reason).not.toBe(ImportRefusal.ThreeMfComponentCycle);
    expect(refusal.details.limit).toBe(DEFAULT_3MF_LIMITS.maxComponentDepth);
  });

  it('spends one depth budget across a part boundary', async () => {
    // Two levels, one on each side of the boundary: accepted at a ceiling of
    // two and refused at one. A per-part counter would accept both.
    const deep: PackageSource = {
      root: model({
        resources:
          '<object id="1" type="model"><components>' +
          '<component objectid="7" p:path="/3D/Objects/a.model"/></components></object>',
        build: '<item objectid="1"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources:
            `<object id="8" type="model">${markerMesh(1)}</object>` +
            '<object id="7" type="model"><components><component objectid="8"/></components></object>',
        }),
      },
    };

    await expect(
      read3mf(await packageOf(deep), testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxComponentDepth: 2 },
      }),
    ).resolves.toBeDefined();
    const refusal = await refusalFrom(deep, {
      limits: { ...DEFAULT_3MF_LIMITS, maxComponentDepth: 1 },
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfComponentTooDeep);
  });
});

/* ============================================ exact package-wide bounds == */

describe('A3-LIM: every package ceiling is exact at the boundary', () => {
  /** A package of two children carrying `a` and `b` triangles. */
  async function twoChildren(a: number, b: number): Promise<Uint8Array> {
    return packageOf({
      root: model({
        build:
          '<item objectid="1" p:path="/3D/Objects/a.model"/>' +
          '<item objectid="1" p:path="/3D/Objects/b.model"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model">${bulkMesh(a)}</object>`,
        }),
        '3D/Objects/b.model': model({
          resources: `<object id="1" type="model">${bulkMesh(b)}</object>`,
        }),
      },
    });
  }

  it('admits exactly the triangle ceiling and refuses one more', async () => {
    const limits = { ...DEFAULT_3MF_LIMITS, maxTotalTriangles: 8 };
    await expect(
      read3mf(await twoChildren(4, 4), testReadContext(), { limits }),
    ).resolves.toBeDefined();

    let caught: unknown;
    try {
      await read3mf(await twoChildren(4, 5), testReadContext(), { limits });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(refusalOf(caught)).toBe(ImportRefusal.ThreeMfTooManyTriangles);
    expect(caught.details.produced).toBe(9);
    expect(caught.details.limit).toBe(8);
  });

  it('admits exactly the vertex ceiling and refuses one more', async () => {
    // Three vertices per triangle in these fixtures, so 4 + 4 is 24 vertices.
    const limits = { ...DEFAULT_3MF_LIMITS, maxTotalVertices: 24 };
    await expect(
      read3mf(await twoChildren(4, 4), testReadContext(), { limits }),
    ).resolves.toBeDefined();

    let caught: unknown;
    try {
      await read3mf(await twoChildren(4, 5), testReadContext(), { limits });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(refusalOf(caught)).toBe(ImportRefusal.ThreeMfTooManyVertices);
    expect(caught.details.produced).toBe(27);
  });

  it('admits exactly the part ceiling and refuses one more', async () => {
    const build = (count: number): string =>
      Array.from({ length: count }, () => '<item objectid="1" p:path="/3D/Objects/a.model"/>').join(
        '',
      );
    const placements = async (count: number): Promise<Uint8Array> =>
      packageOf({
        root: model({ build: build(count) }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      });

    const limits = { ...DEFAULT_3MF_LIMITS, maxParts: 3 };
    const at = await read3mf(await placements(3), testReadContext(), { limits });
    expect(at.document.parts).toHaveLength(3);

    let caught: unknown;
    try {
      await read3mf(await placements(4), testReadContext(), { limits });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(refusalOf(caught)).toBe(ImportRefusal.ThreeMfTooManyParts);
  });

  it('keeps the shipped ceilings equal to the document\u2019s', () => {
    expect(DEFAULT_3MF_LIMITS.maxTotalTriangles).toBe(DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles);
    expect(DEFAULT_3MF_LIMITS.maxTotalVertices).toBe(DEFAULT_DOCUMENT_LIMITS.maxTotalVertices);
    expect(DEFAULT_3MF_LIMITS.maxParts).toBe(DEFAULT_DOCUMENT_LIMITS.maxParts);
  });
});

describe('A3-ZIP: the archive ceilings are the package\u2019s, and reachable parts pay them', () => {
  it('admits exactly the package expansion budget and refuses one byte less', async () => {
    /*
     * ONE BUDGET, CHARGED BY EVERY ENTRY THE IMPORT READS — the relationships,
     * the root and every reachable child. The exact total is taken from the
     * archive's own directory rather than guessed, so the boundary is the real
     * one.
     */
    const archive = await packageOf(childPackage());
    const entries = readZipDirectory(archive, DEFAULT_ZIP_LIMITS);
    const read = ['_rels/.rels', '3d/3dmodel.model', '3d/objects/a.model'];
    const total = entries
      .filter((entry) => read.includes(entry.name.toLowerCase()))
      .reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    expect(total).toBeGreaterThan(0);

    await expect(
      read3mf(archive, testReadContext(), {
        budget: createInflationBudget({
          ...DEFAULT_ZIP_LIMITS,
          maxTotalUncompressedBytes: total,
        }),
      }),
    ).resolves.toBeDefined();

    await expect(
      read3mf(archive, testReadContext(), {
        budget: createInflationBudget({
          ...DEFAULT_ZIP_LIMITS,
          maxTotalUncompressedBytes: total - 1,
        }),
      }),
    ).rejects.toBeDefined();
  });

  it('applies the per-entry ceiling to a reachable CHILD', async () => {
    const archive = await packageOf(childPackage());
    const entries = readZipDirectory(archive, DEFAULT_ZIP_LIMITS);
    const child = entries.find((entry) => entry.name.toLowerCase() === '3d/objects/a.model');
    expect(child).toBeDefined();
    if (child === undefined) return;

    const zipLimits = (maxEntryBytes: number): ZipLimits => ({
      ...DEFAULT_ZIP_LIMITS,
      maxEntryBytes,
    });
    await expect(
      read3mf(archive, testReadContext(), { zipLimits: zipLimits(child.uncompressedSize) }),
    ).resolves.toBeDefined();
    await expect(
      read3mf(archive, testReadContext(), { zipLimits: zipLimits(child.uncompressedSize - 1) }),
    ).rejects.toBeDefined();
  });

  it('applies the compression-ratio policy to a reachable child', async () => {
    /*
     * PRODUCTION SUPPORT IS NOT A BYPASS. The ratio is enforced when the
     * DIRECTORY is read, so a bomb in a child is refused before any part is
     * opened — earlier than the reference to it is even seen. That is the
     * whole-package policy A3 leaves alone, restated here as a regression.
     */
    const bomb = `${model({
      resources: '<object id="1" type="model"></object>',
    })}${' '.repeat(400_000)}`;
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: { '3D/Objects/a.model': bomb },
    });
    expect(refusal.code).toBe(AppErrorCode.ResourceLimitExceeded);
    expect(refusal.reason).toBe(ImportRefusal.ZipRatioExceeded);
  });

  it('cannot reach more model parts than the archive may hold entries', async () => {
    // No separate model-part ceiling exists, and none is needed: a reachable
    // part is an entry, and entries are capped.
    const refusal = await refusalFrom(childPackage(), {
      zipLimits: { ...DEFAULT_ZIP_LIMITS, maxEntries: 2 },
    });
    expect(refusal.code).toBe(AppErrorCode.ResourceLimitExceeded);
  });
});

/* ====================================================== cancellation ===== */

describe('A3-CAN: a cancel is observed at every stage of a package read', () => {
  /** Cancels once `decodeText` has run `after` times — one call per model part. */
  function cancellingAfterDecodes(after: number): {
    context: ReturnType<typeof testReadContext>;
    decodes: () => number;
  } {
    let decodes = 0;
    let cancelled = false;
    const base = testReadContext();
    return {
      decodes: (): number => decodes,
      context: {
        ...base,
        cancellation: {
          get isCancelled(): boolean {
            return cancelled;
          },
          onCancelled(): () => void {
            return (): void => undefined;
          },
        },
        decodeText: (input: Uint8Array): string => {
          decodes += 1;
          if (decodes >= after) cancelled = true;
          return base.decodeText(input);
        },
      },
    };
  }

  async function threeChildren(): Promise<Uint8Array> {
    return packageOf({
      root: model({
        build:
          '<item objectid="1" p:path="/3D/Objects/a.model"/>' +
          '<item objectid="1" p:path="/3D/Objects/b.model"/>' +
          '<item objectid="1" p:path="/3D/Objects/c.model"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        }),
        '3D/Objects/b.model': model({
          resources: `<object id="1" type="model">${markerMesh(2)}</object>`,
        }),
        '3D/Objects/c.model': model({
          resources: `<object id="1" type="model">${markerMesh(3)}</object>`,
        }),
      },
    });
  }

  /*
   * ONE DECODE PER PART THE READER OPENS, in order: relationships, root, then
   * each child. Cancelling on the Nth therefore lands the flip at a named
   * stage, and the count afterwards says where it stopped.
   */
  for (const [stage, after, ceiling] of [
    ['reading the relationships', 1, 1],
    ['parsing the root', 2, 2],
    ['opening the first child', 3, 3],
    ['between the first and second children', 4, 4],
  ] as const) {
    it(`stops while ${stage}, with no document`, async () => {
      const { context, decodes } = cancellingAfterDecodes(after);
      let caught: unknown;
      try {
        await read3mf(await threeChildren(), context);
      } catch (error) {
        caught = error;
      }
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.OperationCancelled);
      expect(caught.code).not.toBe(AppErrorCode.MalformedFile);
      expect(decodes()).toBeLessThanOrEqual(ceiling);
    });
  }

  it('leaves the reader usable, whichever stage was cancelled', async () => {
    for (const after of [1, 2, 3, 4]) {
      const { context } = cancellingAfterDecodes(after);
      await expect(read3mf(await threeChildren(), context)).rejects.toBeDefined();

      const good = await read3mf(await threeChildren(), testReadContext());
      expect(good.document.parts).toHaveLength(3);
    }
  });
});

/* ======================================================= error ordering == */

describe('A3-ORD: when a package breaks several rules, the answer is deterministic', () => {
  it('an unknown required extension wins over a dangling reference', async () => {
    /*
     * THE FILE SAYS IT CANNOT BE UNDERSTOOD WITHOUT SEMANTICS CAD FIXER DOES NOT
     * HAVE, so interpreting its object graph at all is the wrong move —
     * whatever else is wrong with it might not be wrong under those semantics.
     */
    const refusal = await refusalFrom({
      root: model({
        xmlns: ` xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" xmlns:z="http://example.invalid/z/2099"`,
        attrs: ' requiredextensions="z"',
        resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        build: '<item objectid="404"/>',
      }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
  });

  it('an unsafe path wins over the target being absent', async () => {
    // The reference is refused on its SHAPE, so whether anything is there is
    // never asked — and must not be, because asking means resolving it.
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="1" p:path="/../outside.model"/>' }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfMalformedModelPartPath);
    expect(refusal.reason).not.toBe(ImportRefusal.ThreeMfModelPartNotFound);
  });

  it('an archive-level resource refusal wins over malformed XML inside it', async () => {
    // The directory is read before any entry is opened, so a ratio or size
    // refusal precedes the parse of whatever the entry holds.
    const refusal = await refusalFrom(
      {
        root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: { '3D/Objects/a.model': `<not-xml${' '.repeat(400_000)}` },
      },
      { zipLimits: { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 1_000 } },
    );
    expect(refusal.code).toBe(AppErrorCode.ResourceLimitExceeded);
  });

  it('a non-root path wins over a missing object in the same child', async () => {
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model': model({
          resources:
            '<object id="1" type="model"><components>' +
            '<component objectid="404"/>' +
            '<component objectid="1" p:path="/3D/Objects/b.model"/>' +
            '</components></object>',
        }),
        '3D/Objects/b.model': model({
          resources: `<object id="1" type="model">${markerMesh(9)}</object>`,
        }),
      },
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfNonRootModelPartPath);
  });
});

/* ========================================================== mutations ==== */

describe('A3-MUT: every mutation of a good package fails safely', () => {
  /*
   * DETERMINISTIC AND SMALL, not random. Each mutation takes one valid
   * production package and breaks exactly one thing, so a failure names the
   * semantics that broke rather than "some fuzz case". What every case shares
   * is the property that matters: a typed refusal, no document, and a reader
   * that still works afterwards.
   */
  const base = (): PackageSource => ({
    root: model({
      attrs: ' requiredextensions="p"',
      resources:
        '<object id="2" type="model"><components>' +
        '<component objectid="1" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 3 4 5"/>' +
        '</components></object>',
      build: '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>',
    }),
    parts: {
      '3D/Objects/a.model': model({
        unit: 'millimeter',
        resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
      }),
    },
  });

  it('imports unmutated, so the mutations below mean something', async () => {
    const result = await read3mf(await packageOf(base()), testReadContext());
    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(7);
    expect(result.document.parts[0]?.transform).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 13, 4, 5]);
  });

  const mutations: readonly { name: string; apply: (source: PackageSource) => PackageSource }[] = [
    {
      name: 'the target entry is deleted',
      apply: (source) => ({ ...source, parts: {} }),
    },
    {
      name: 'the target object id is changed',
      apply: (source) => ({
        ...source,
        parts: {
          '3D/Objects/a.model': model({
            unit: 'millimeter',
            resources: `<object id="99" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
    },
    {
      name: 'the child XML is truncated',
      apply: (source) => ({
        ...source,
        parts: { '3D/Objects/a.model': `<?xml version="1.0"?><model xmlns="${CORE_NS}"><resour` },
      }),
    },
    {
      name: 'the child declares the object twice',
      apply: (source) => ({
        ...source,
        parts: {
          '3D/Objects/a.model': model({
            unit: 'millimeter',
            resources:
              `<object id="1" type="model">${markerMesh(7)}</object>` +
              `<object id="1" type="model">${markerMesh(8)}</object>`,
          }),
        },
      }),
    },
    {
      name: 'the production namespace URI is altered',
      apply: (source) => ({
        ...source,
        root: (source.root ?? '').replace(PRODUCTION_NS, `${PRODUCTION_NS}/v2`),
      }),
    },
    {
      name: 'the path is corrupted into a traversal',
      apply: (source) => ({
        ...source,
        root: (source.root ?? '').replace('/3D/Objects/a.model', '/3D/../../a.model'),
      }),
    },
    {
      name: 'a transform token is flipped to a word',
      apply: (source) => ({
        ...source,
        root: (source.root ?? '').replace('1 0 0 0 1 0 0 0 1 3 4 5', '1 0 0 0 1 0 0 0 1 x 4 5'),
      }),
    },
    {
      name: 'the child unit is changed',
      apply: (source) => ({
        ...source,
        parts: {
          '3D/Objects/a.model': model({
            unit: 'inch',
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
    },
    {
      name: 'an unknown required extension is added',
      apply: (source) => ({
        ...source,
        root: (source.root ?? '')
          .replace(
            `xmlns:p="${PRODUCTION_NS}"`,
            `xmlns:p="${PRODUCTION_NS}" xmlns:z="http://example.invalid/z"`,
          )
          .replace('requiredextensions="p"', 'requiredextensions="p z"'),
      }),
    },
    {
      name: 'the child is given a path of its own',
      apply: (source) => ({
        ...source,
        parts: {
          '3D/Objects/a.model': model({
            unit: 'millimeter',
            resources:
              '<object id="1" type="model"><components>' +
              '<component objectid="1" p:path="/3D/Objects/b.model"/></components></object>',
          }),
          '3D/Objects/b.model': model({
            resources: `<object id="1" type="model">${markerMesh(8)}</object>`,
          }),
        },
      }),
    },
  ];

  for (const mutation of mutations) {
    it(`refuses safely when ${mutation.name}`, async () => {
      let caught: unknown;
      try {
        await read3mf(await packageOf(mutation.apply(base())), testReadContext());
      } catch (error) {
        caught = error;
      }

      expect(isAppError(caught), `${mutation.name} produced no typed error`).toBe(true);
      if (!isAppError(caught)) return;

      /*
       * NEVER `INTERNAL_FAILURE`. Every one of these is a bad PACKAGE, and a
       * bad package is malformed, unsupported or over a limit — an internal
       * failure would be CAD Fixer reporting its own defect as the file's.
       */
      expect(
        [
          AppErrorCode.MalformedFile,
          AppErrorCode.UnsupportedFile,
          AppErrorCode.ResourceLimitExceeded,
        ],
        `${mutation.name} produced ${caught.code}`,
      ).toContain(caught.code);
      expect(refusalOf(caught)).toBeDefined();

      // AND THE READER STILL WORKS. No parser state survived the refusal.
      const good = await read3mf(await packageOf(base()), testReadContext());
      expect(good.document.parts).toHaveLength(1);
    });
  }
});

/* ============================================================ privacy ==== */

describe('A3-PRIV: a refusal carries structure, never content', () => {
  it('keeps hostile object ids and paths out of the sentence', async () => {
    const hostile = 'A'.repeat(600);
    const refusal = await refusalFrom({
      root: model({
        resources:
          `<object id="1" type="model">${markerMesh(1)}</object>` +
          `<object id="2" type="model"><components><component objectid="${hostile}"/></components></object>`,
        build: '<item objectid="2"/>',
      }),
    });

    expect(refusal.message).not.toContain('AAA');
    expect(refusal.message.length).toBeLessThan(200);
    expect(String(refusal.details.objectId)).toHaveLength(64);
  });

  it('never carries XML content or a local filesystem path', async () => {
    const secret = 'C:\\Users\\someone\\Secret Project\\part.3mf';
    const refusal = await refusalFrom({
      root: model({
        resources: `<object id="1" type="model" name="${secret}">${markerMesh(1)}</object>`,
        build: '<item objectid="404"/>',
      }),
    });

    const serialised = `${refusal.message} ${JSON.stringify(refusal.details)}`;
    expect(serialised).not.toContain('Secret Project');
    expect(serialised).not.toContain('C:\\');
    expect(serialised).not.toContain('<object');
  });

  it('reports a package part path, which is package structure and not a location', async () => {
    const refusal = await refusalFrom({
      root: model({ build: '<item objectid="404" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
        }),
      },
    });
    // The archive-internal name is safe and is what a user needs to act on; it
    // is not a filesystem path and cannot become one.
    expect(refusal.details.part).toBe('3d/objects/a.model');
    expect(String(refusal.details.part)).not.toContain('..');
  });
});

/* ======================================================== parse-once ===== */

describe('A3-PERF: a model part is parsed once however often it is named', () => {
  it('parses one child once for forty references', async () => {
    const recorded = stats();
    const result = await read3mf(
      await packageOf({
        root: model({
          build: Array.from(
            { length: 40 },
            (_unused, index) =>
              `<item objectid="1" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 ${String(index)} 0 0"/>`,
          ).join(''),
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
      { stats: recorded },
    );

    expect(result.document.parts).toHaveLength(40);
    /*
     * ONE MESH BUILT, NOT FORTY. `meshResourcesMaterialised` counts once per
     * parsed object, so anything above one here means the part was re-read —
     * the `O(references x model-size)` shape the graph exists to prevent.
     */
    expect(recorded.meshResourcesMaterialised).toBe(1);
    expect(distinctMeshes(result.document)).toHaveLength(1);
  });

  it('parses each distinct child exactly once when they interleave', async () => {
    const recorded = stats();
    await read3mf(
      await packageOf({
        root: model({
          build:
            '<item objectid="1" p:path="/3D/Objects/a.model"/>' +
            '<item objectid="1" p:path="/3D/Objects/b.model"/>' +
            '<item objectid="1" p:path="/3D/Objects/a.model"/>' +
            '<item objectid="1" p:path="/3D/Objects/b.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          }),
          '3D/Objects/b.model': model({
            resources: `<object id="1" type="model">${markerMesh(2)}</object>`,
          }),
        },
      }),
      testReadContext(),
      { stats: recorded },
    );

    expect(recorded.meshResourcesMaterialised).toBe(2);
  });
});

/* ==================================================== warning semantics == */

describe('A3-WARN: a supported import warns about nothing it supported', () => {
  it('reports no warning at all for a plain path-based package', async () => {
    const result = await read3mf(await packageOf(childPackage()), testReadContext());
    expect(result.warnings).toEqual([]);
    expect(result.compatibility.unsupported).toEqual([]);
  });

  it('never tells a user the production extension is unsupported', async () => {
    const result = await read3mf(await packageOf(childPackage()), testReadContext());
    for (const warning of result.warnings) {
      const text = warning.message.toLowerCase();
      expect(text).not.toContain('production extension');
      expect(text).not.toContain('several model parts');
      expect(text).not.toContain('does not support');
    }
  });

  it('still reports flattening when the file really did nest components', async () => {
    /*
     * TRUTHFUL EITHER WAY. The nesting is genuinely not retained, so a package
     * that used components gets the note — and one that used only build-item
     * paths does not, because there was no hierarchy to lose.
     */
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            '<object id="1" type="model"><components>' +
            '<component objectid="1" p:path="/3D/Objects/a.model"/></components></object>',
          build: '<item objectid="1"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.warnings.map((warning) => warning.code)).toContain(
      'THREEMF_COMPONENT_HIERARCHY_FLATTENED',
    );
  });

  it('reports a texture declared only in a REFERENCED part', async () => {
    // A loss is a loss wherever it was declared. Saying nothing because the
    // root was clean would be the silent drop this reader exists not to make.
    const result = await read3mf(
      await packageOf({
        root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources:
              '<texture2d id="9" path="/3D/Textures/t.png" contenttype="image/png"/>' +
              `<object id="1" type="model">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.warnings.map((warning) => warning.code)).toContain(
      'THREEMF_TEXTURES_NOT_IMPORTED',
    );
  });

  it('counts an unplaced mesh in a referenced part as unreferenced, and no more', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({ build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources:
              `<object id="1" type="model">${markerMesh(7)}</object>` +
              `<object id="2" type="model">${markerMesh(8)}</object>`,
          }),
          // NEVER OPENED, so its objects are not counted: they belong to a part
          // this import had no reason to read.
          '3D/Objects/spare.model': model({
            resources: `<object id="1" type="model">${markerMesh(9)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    const unreferenced = result.warnings.find(
      (warning) => warning.code === 'THREEMF_UNREFERENCED_OBJECTS',
    );
    expect(unreferenced?.details?.count).toBe(1);
  });
});

/* ======================================== material and property scoping == */

describe('A3-PROP: a part’s property resources are its own', () => {
  it('does not resolve a child’s property reference against the root', async () => {
    /*
     * "All of the resources associated with the referenced object... MUST come
     * from the referenced object file." The ROOT declares resource 5; the child
     * names 5 and declares nothing. Resolving upwards would accept a package
     * whose child is internally inconsistent — and would mean a child's
     * material could silently come from another file.
     */
    const refusal = await refusalFrom({
      root: model({
        resources:
          '<basematerials id="5"><base name="steel" displaycolor="#808080"/></basematerials>',
        build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model" pid="5">${markerMesh(7)}</object>`,
        }),
      },
    });

    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfDanglingPropertyReference);
  });

  it('accepts the same property id declared independently in both parts', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            '<basematerials id="5"><base name="steel" displaycolor="#808080"/></basematerials>',
          build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources:
              '<basematerials id="5"><base name="brass" displaycolor="#B5A642"/></basematerials>' +
              `<object id="1" type="model" pid="5">${markerMesh(7)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(result.compatibility.unsupported).toContain(UnsupportedFeature.Materials);
  });

  it('discards the material without changing which geometry arrives', async () => {
    // CAD Fixer imports geometry and reports the loss. What must not happen is
    // the material influencing WHICH mesh is read.
    const withMaterial = await read3mf(
      await packageOf({
        root: model({
          resources:
            '<basematerials id="5"><base name="steel" displaycolor="#808080"/></basematerials>' +
            `<object id="1" type="model" pid="5">${markerMesh(7)}</object>`,
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );
    const without = await read3mf(
      await packageOf({
        root: model({
          resources: `<object id="1" type="model">${markerMesh(7)}</object>`,
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );

    expect([...(withMaterial.document.parts[0]?.mesh.positions ?? [])]).toEqual([
      ...(without.document.parts[0]?.mesh.positions ?? []),
    ]);
  });
});

/* ============================== namespaces decide core meaning (A4-NS) === */

describe('A4-NS: a core meaning needs a core element — Stage 6D-A4', () => {
  const DISPLACEMENT_NS = 'http://schemas.3mf.io/3dmanufacturing/displacement/2023/10';
  const VENDOR_NS = 'http://example.invalid/vendor';
  const foreignMesh = (prefix: string, marker: number): string =>
    `<${prefix}:displacementmesh><${prefix}:vertices>` +
    `<${prefix}:vertex x="${String(marker)}" y="0" z="0"/>` +
    `<${prefix}:vertex x="${String(marker)}" y="1" z="0"/>` +
    `<${prefix}:vertex x="${String(marker)}" y="0" z="1"/>` +
    `</${prefix}:vertices><${prefix}:triangles><${prefix}:triangle v1="0" v2="1" v3="2"/>` +
    `</${prefix}:triangles></${prefix}:displacementmesh>`;

  it('A4-NS01: an object holding only a foreign mesh is not read as core geometry', async () => {
    /*
     * The shape of the 3MF Consortium's `N_DPX_3314_01`: displacement content,
     * the extension NOT declared required. Core says ignore it, which leaves
     * the object with no core geometry — so there is nothing to import. Before
     * Stage 6D-A4 the `d:` vertices and triangles were read as the core mesh.
     */
    const refusal = await refusalFrom({
      root: model({
        xmlns: ` xmlns="${CORE_NS}" xmlns:d="${DISPLACEMENT_NS}"`,
        resources: `<object id="1" type="model">${foreignMesh('d', 3)}</object>`,
        build: '<item objectid="1"/>',
      }),
    });
    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfNoBuildItems);
  });

  it('A4-NS02: a foreign mesh beside a core mesh contributes nothing', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          xmlns: ` xmlns="${CORE_NS}" xmlns:v="${VENDOR_NS}"`,
          resources: `<object id="1" type="model">${markerMesh(4)}${foreignMesh('v', 99)}</object>`,
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );
    const mesh = result.document.parts[0]?.mesh;
    expect(mesh?.positions.length).toBe(9);
    expect(mesh?.indices.length).toBe(3);
    expect(markerOf(mesh?.positions ?? [])).toBe(4);
  });

  it('A4-NS03: foreign `object`, `item` and `component` elements are ignored, not followed', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          xmlns: ` xmlns="${CORE_NS}" xmlns:v="${VENDOR_NS}"`,
          resources:
            `<object id="1" type="model">${markerMesh(1)}` +
            '<v:component objectid="2"/></object>' +
            `<v:object id="2">${markerMesh(2)}</v:object>`,
          build: '<item objectid="1"/><v:item objectid="2"/>',
        }),
      }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(1);
  });

  it('A4-NS04: core elements under ANY prefix bound to the core namespace are still core', async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<c:model xmlns:c="${CORE_NS}" unit="millimeter"><c:resources>` +
      '<c:object id="1" type="model"><c:mesh><c:vertices>' +
      '<c:vertex x="6" y="0" z="0"/><c:vertex x="6" y="1" z="0"/><c:vertex x="6" y="0" z="1"/>' +
      '</c:vertices><c:triangles><c:triangle v1="0" v2="1" v3="2"/></c:triangles></c:mesh>' +
      '</c:object></c:resources><c:build><c:item objectid="1"/></c:build></c:model>';
    const result = await read3mf(await packageOf({ root: xml }), testReadContext());
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(6);
  });

  it('A4-NS05: unprefixed elements keep their meaning under the legacy 2013/01 default namespace', async () => {
    // lib3mf's v0.9.3 fixtures; imported before Stage 6D-A4 and still imported.
    const result = await read3mf(
      await packageOf({
        root: model({
          xmlns: ' xmlns="http://schemas.microsoft.com/3dmanufacturing/2013/01"',
          resources: `<object id="1" type="model">${markerMesh(8)}</object>`,
          build: '<item objectid="1"/>',
        }),
      }),
      testReadContext(),
    );
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(8);
  });
});
