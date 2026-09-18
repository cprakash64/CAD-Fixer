import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import { DEFAULT_DOCUMENT_LIMITS, distinctMeshes } from '@cadfixer/mesh-core';
import { ImportRefusal, refusalOf } from '../import-errors';
import { testReadContext } from '../test-context';
import { DEFAULT_3MF_LIMITS, read3mf, type ThreeMfExpansionStats } from './threemf-reader';
import { createInflationBudget, DEFAULT_ZIP_LIMITS } from './zip';
import { buildZip, CONTENT_TYPES, TETRAHEDRON_MESH } from './zip-fixtures';

/**
 * A2-X01 – A2-X27 — REACHABLE MULTI-MODEL-PART 3MF IMPORT.
 *
 * Stage 6D-A2 is the first stage in which a production-extension package can
 * IMPORT rather than be refused, and the risk profile changes completely with
 * it. Until now the whole extension was one refusal, and the only way to be
 * wrong was to be wrong about the category. Now every reference is a decision
 * about WHICH BYTES BECOME THE USER'S MODEL, and the ways to be wrong are
 * silent: resolving an id against the wrong part's table, following a reference
 * the specification forbids, skipping one that fails and importing the rest,
 * letting each part spend the package's budget again, or losing a placement's
 * transform.
 *
 * So these are weighted towards what the package PRODUCES, not towards which
 * error it returns. A test that only asserts a refusal code cannot tell a
 * correct import from one that quietly dropped half the geometry.
 *
 * EVERY FIXTURE IS SYNTHETIC AND BUILT HERE. None is a vendored producer file,
 * and none is shaped around one slicer: the structures are the specification's
 * — a manifest root, a component path, a repeated reference, a chain — so that
 * passing means the semantics work rather than that one exporter was matched.
 */

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/** A distinguishable mesh: a single triangle whose first vertex names it. */
function markerMesh(marker: number): string {
  return `<mesh><vertices>
   <vertex x="${String(marker)}" y="0" z="0"/>
   <vertex x="${String(marker)}" y="1" z="0"/>
   <vertex x="${String(marker)}" y="0" z="1"/>
  </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>`;
}

/** The x coordinate every vertex of a marker mesh carries. Identifies the source. */
function markerOf(positions: ArrayLike<number>): number {
  return positions[0] ?? Number.NaN;
}

interface ModelSource {
  readonly declares?: string;
  readonly resources: string;
  readonly build?: string;
  readonly unit?: string;
}

function model(source: ModelSource): string {
  const unit = source.unit === undefined ? '' : ` unit="${source.unit}"`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<model${unit} xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}"${source.declares ?? ''}>` +
    `<resources>${source.resources}</resources>` +
    `<build>${source.build ?? ''}</build>` +
    '</model>'
  );
}

interface PackageSource {
  readonly root: string;
  /** Extra model parts, keyed by the package path that names them. */
  readonly parts?: Readonly<Record<string, string>>;
}

async function packageOf(source: PackageSource): Promise<Uint8Array> {
  return buildZip([
    { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
    { name: '_rels/.rels', method: 8, content: RELS },
    { name: '3D/3dmodel.model', method: 8, content: source.root },
    ...Object.entries(source.parts ?? {}).map(([name, content]) => ({
      name,
      method: 8 as const,
      content,
    })),
  ]);
}

async function refusalFrom(
  source: PackageSource,
): Promise<{ code: string; reason: unknown; message: string; details: Record<string, unknown> }> {
  try {
    await read3mf(await packageOf(source), testReadContext());
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

/* ======================================================= the supported subset */

describe('A2-X01: a root build item that names an object in another model part', () => {
  it('imports that object, with the item transform applied', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources: '',
          build:
            '<item objectid="7" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 5 6 7"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="7" type="model">${markerMesh(11)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    // THE GEOMETRY CAME FROM THE CHILD. The root declares no object at all.
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(11);
    expect(result.document.parts[0]?.transform).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7]);
  });
});

describe('A2-X02: a root component that names an object in another model part', () => {
  it('imports that object, with both transforms composed', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            '<object id="1" type="model"><components>' +
            '<component objectid="7" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 100 0 0"/>' +
            '</components></object>',
          build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 20 0"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="7" type="model">${markerMesh(11)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(11);
    // ITEM THEN COMPONENT, in the specification's order: the component's
    // translation is expressed in the item's frame.
    expect(result.document.parts[0]?.transform).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 20, 0]);
  });
});

describe('A2-X03: identical object ids in different model parts', () => {
  it('resolves each reference in the part that its path names', async () => {
    /*
     * THE DEFECT THIS EXISTS TO CATCH IS SILENT. Object ids are unique within a
     * model part, not within a package, so `id="1"` in two parts is ordinary
     * 3MF — and a bare-id lookup produces a document that is the right SHAPE
     * with the wrong geometry in it. Only the markers can tell.
     */
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

    expect(result.document.parts).toHaveLength(3);
    expect(result.document.parts.map((part) => markerOf(part.mesh.positions))).toEqual([1, 2, 3]);
    // Three DISTINCT meshes: nothing was shared that should not have been.
    expect(distinctMeshes(result.document)).toHaveLength(3);
  });
});

describe('A2-X04: the same model part referenced more than once', () => {
  it('parses it once, stores one mesh and emits a placement per reference', async () => {
    const recorded = stats();
    const result = await read3mf(
      await packageOf({
        root: model({
          resources: '',
          build:
            '<item objectid="7" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>' +
            '<item objectid="7" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>' +
            '<item objectid="7" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="7" type="model">${markerMesh(11)}</object>`,
          }),
        },
      }),
      testReadContext(),
      { stats: recorded },
    );

    expect(result.document.parts).toHaveLength(3);
    /*
     * ONE PARSE AND ONE MESH. `meshResourcesMaterialised` counts a mesh built
     * per PARSED OBJECT, so three here would mean the part was read three times
     * — which is what the graph's get-or-parse exists to prevent, and what a
     * package placing one referenced object fifty times would otherwise cost.
     */
    expect(recorded.meshResourcesMaterialised).toBe(1);
    expect(distinctMeshes(result.document)).toHaveLength(1);
    // STRUCTURAL SHARING, by reference: three placements of one buffer.
    expect(result.document.parts[0]?.mesh).toBe(result.document.parts[1]?.mesh);
    expect(result.document.parts[1]?.mesh).toBe(result.document.parts[2]?.mesh);
    // And the transforms stay independent.
    expect(result.document.parts.map((part) => part.transform[9])).toEqual([10, 20, 30]);
  });
});

describe('A2-X05: several referenced model parts', () => {
  it('loads each lazily and keeps every placement', async () => {
    const recorded = stats();
    const result = await read3mf(
      await packageOf({
        root: model({
          resources: '',
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
          // NEVER REFERENCED. Reachability decides what is read.
          '3D/Objects/unused.model': model({
            resources: `<object id="1" type="model">${markerMesh(9)}</object>`,
          }),
        },
      }),
      testReadContext(),
      { stats: recorded },
    );

    expect(result.document.parts).toHaveLength(3);
    expect(result.document.parts.map((part) => markerOf(part.mesh.positions))).toEqual([1, 2, 3]);
    // Three meshes, not four: the unreferenced part was never opened.
    expect(recorded.meshResourcesMaterialised).toBe(3);
  });
});

/* ======================================================= package consistency */

describe('A2-X06: a reference to a model part the package does not contain', () => {
  it('is MALFORMED and says the part is missing, never that the feature is unsupported', async () => {
    const refusal = await refusalFrom({
      root: model({
        resources: '',
        build: '<item objectid="1" p:path="/3D/Objects/missing.model"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        }),
      },
    });

    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfModelPartNotFound);
    // AN INCOMPLETE PACKAGE IS NOT AN UNSUPPORTED FEATURE. The user can act on
    // one of those and not the other.
    expect(refusal.code).not.toBe(AppErrorCode.UnsupportedFile);
  });
});

describe('A2-X07: a reference to an object the target part does not declare', () => {
  it('is MALFORMED, names the part, and never falls back to the referring part', async () => {
    const refusal = await refusalFrom({
      root: model({
        // The root DOES declare an object 1. A fallback would find it and
        // import the wrong geometry as a success.
        resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="42" type="model">${markerMesh(2)}</object>`,
        }),
      },
    });

    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfMissingModelPartObject);
    expect(refusal.details.part).toBe('3d/objects/a.model');
    expect(refusal.details.objectId).toBe('1');
  });
});

describe('A2-X08: a path on a reference inside a part that is not the root', () => {
  it('is refused, not followed and not ignored', async () => {
    const refusal = await refusalFrom({
      root: model({ resources: '', build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model': model({
          resources:
            '<object id="1" type="model"><components>' +
            '<component objectid="1" p:path="/3D/Objects/b.model"/>' +
            '</components></object>',
        }),
        '3D/Objects/b.model': model({
          resources: `<object id="1" type="model">${markerMesh(2)}</object>`,
        }),
      },
    });

    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfNonRootModelPartPath);
  });

  it('refuses rather than silently importing the rest of the package', async () => {
    // The chaining part also holds a perfectly good mesh. Importing that and
    // dropping the chained reference would be a truncated model reported as a
    // success — the single worst outcome available here.
    await expect(
      read3mf(
        await packageOf({
          root: model({
            resources: '',
            build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
          }),
          parts: {
            '3D/Objects/a.model': model({
              resources:
                `<object id="1" type="model">${markerMesh(1)}<components>` +
                '<component objectid="1" p:path="/3D/Objects/b.model"/>' +
                '</components></object>',
            }),
            '3D/Objects/b.model': model({
              resources: `<object id="1" type="model">${markerMesh(2)}</object>`,
            }),
          },
        }),
        testReadContext(),
      ),
    ).rejects.toBeDefined();
  });
});

describe('A2-X09: reachable model parts that declare different units', () => {
  it('is UNSUPPORTED, because reconciling them would mean rescaling', async () => {
    const refusal = await refusalFrom({
      root: model({
        unit: 'millimeter',
        resources: '',
        build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
      }),
      parts: {
        '3D/Objects/a.model':
          `<?xml version="1.0" encoding="UTF-8"?><model unit="inch" xmlns="${CORE_NS}">` +
          `<resources><object id="1" type="model">${markerMesh(1)}</object></resources><build/></model>`,
      },
    });

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfInconsistentModelPartUnits);
    expect(refusal.details.rootUnit).toBe('millimeter');
    expect(refusal.details.partUnit).toBe('inch');
  });

  it('treats an absent unit as millimetre, because the specification does', async () => {
    // A root that says `millimeter` and a child that says nothing AGREE. The
    // attribute is defaulted by the format, so refusing them would be misreading
    // the specification rather than being careful.
    const result = await read3mf(
      await packageOf({
        root: model({
          unit: 'millimeter',
          resources: '',
          build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model':
            `<?xml version="1.0" encoding="UTF-8"?><model xmlns="${CORE_NS}">` +
            `<resources><object id="1" type="model">${markerMesh(1)}</object></resources><build/></model>`,
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(result.document.unit).toBe('millimeter');
  });

  it('does not care what an UNREACHABLE model part declares', async () => {
    // It is never opened, so its unit is not a fact about this document.
    const result = await read3mf(
      await packageOf({
        root: model({
          unit: 'millimeter',
          resources: '',
          build: '<item objectid="1" p:path="/3D/Objects/a.model"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            unit: 'millimeter',
            resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          }),
          '3D/Objects/micron.model':
            `<?xml version="1.0" encoding="UTF-8"?><model unit="micron" xmlns="${CORE_NS}">` +
            `<resources><object id="1" type="model">${markerMesh(2)}</object></resources><build/></model>`,
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(result.document.unit).toBe('millimeter');
  });
});

/* ============================================================= composition == */

describe('A2-X10: transforms compose across a part boundary', () => {
  it('applies item, then root component, then the child part\u2019s own component', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            '<object id="1" type="model"><components>' +
            '<component objectid="7" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 0 100 0"/>' +
            '</components></object>',
          build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 1000 0 0"/>',
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources:
              `<object id="8" type="model">${markerMesh(11)}</object>` +
              '<object id="7" type="model"><components>' +
              '<component objectid="8" transform="1 0 0 0 1 0 0 0 1 0 0 10"/>' +
              '</components></object>',
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(11);
    // Three translations, each expressed in its parent's frame, all preserved.
    expect(result.document.parts[0]?.transform).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 1000, 100, 10]);
  });
});

describe('A2-X11: same-part components inside a referenced part', () => {
  it('expands them under core rules, with no path involved', async () => {
    const result = await read3mf(
      await packageOf({
        root: model({ resources: '', build: '<item objectid="9" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources:
              `<object id="1" type="model">${markerMesh(1)}</object>` +
              `<object id="2" type="model">${markerMesh(2)}</object>` +
              '<object id="9" type="model"><components>' +
              '<component objectid="1"/><component objectid="2"/>' +
              '</components></object>',
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(2);
    expect(result.document.parts.map((part) => markerOf(part.mesh.positions))).toEqual([1, 2]);
  });
});

/* ======================================================= package-wide bounds */

/** Two model parts, each holding one four-triangle tetrahedron, both placed. */
async function twoTetrahedronParts(): Promise<Uint8Array> {
  return packageOf({
    root: model({
      resources: '',
      build:
        '<item objectid="1" p:path="/3D/Objects/a.model"/>' +
        '<item objectid="1" p:path="/3D/Objects/b.model"/>',
    }),
    parts: {
      '3D/Objects/a.model': model({
        resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
      }),
      '3D/Objects/b.model': model({
        resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
      }),
    },
  });
}

describe('A2-X12: the triangle ceiling is the PACKAGE’S', () => {
  /*
   * STAGE 6D-R1 RECORDED THIS AS THE DEFECT A2 HAD TO FIX. The running totals
   * lived in one model's expansion and reset per part, so a package of two
   * parts each just inside the ceiling would pass while producing twice it.
   * There is now ONE walk over the package and therefore one of each total.
   *
   * NARROWED RATHER THAN SATURATED. Proving it at the shipped twenty million
   * would need twenty million triangles of fixture; proving it at seven proves
   * the same property, which is that the second part is charged what the first
   * already spent.
   */
  it('refuses when two parts together cross a ceiling neither crosses alone', async () => {
    const archive = await twoTetrahedronParts();

    // Four triangles per part: either alone fits under seven, both do not.
    await expect(
      read3mf(archive, testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxTotalTriangles: 8 },
      }),
    ).resolves.toBeDefined();

    let caught: unknown;
    try {
      await read3mf(archive, testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxTotalTriangles: 7 },
      });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(refusalOf(caught)).toBe(ImportRefusal.ThreeMfTooManyTriangles);
    // THE PACKAGE'S TOTAL, not one part's: eight, reached by two fours.
    expect(caught.details.produced).toBe(8);
    expect(caught.details.limit).toBe(7);
  });

  it('keeps the shipped ceiling equal to the document’s', () => {
    expect(DEFAULT_3MF_LIMITS.maxTotalTriangles).toBe(DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles);
  });
});

describe('A2-X13: the vertex ceiling is the PACKAGE’S', () => {
  it('refuses when two parts together cross a ceiling neither crosses alone', async () => {
    const archive = await twoTetrahedronParts();

    // Four vertices per part.
    await expect(
      read3mf(archive, testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxTotalVertices: 8 },
      }),
    ).resolves.toBeDefined();

    let caught: unknown;
    try {
      await read3mf(archive, testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxTotalVertices: 7 },
      });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(refusalOf(caught)).toBe(ImportRefusal.ThreeMfTooManyVertices);
    expect(caught.details.produced).toBe(8);
  });

  it('keeps the shipped ceiling equal to the document’s', () => {
    expect(DEFAULT_3MF_LIMITS.maxTotalVertices).toBe(DEFAULT_DOCUMENT_LIMITS.maxTotalVertices);
  });
});

describe('A2-X14: the part ceiling is the PACKAGE’S', () => {
  it('does not grant each model part an allowance of its own', async () => {
    const archive = await packageOf({
      root: model({
        resources: '',
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

    await expect(
      read3mf(archive, testReadContext(), { limits: { ...DEFAULT_3MF_LIMITS, maxParts: 3 } }),
    ).resolves.toBeDefined();

    let caught: unknown;
    try {
      await read3mf(archive, testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxParts: 2 },
      });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(refusalOf(caught)).toBe(ImportRefusal.ThreeMfTooManyParts);
  });
});

describe('A2-X15: one inflation budget for the whole package', () => {
  it('charges every reachable part against the same total', async () => {
    /*
     * THE RULE THE GRAPH EXISTS FOR. A per-part budget is a per-part FULL
     * allowance, which is how a package with twenty parts extracts twenty times
     * the ceiling. Proven by handing the read a budget too small for the SUM of
     * two parts but large enough for either alone.
     */
    const archive = await packageOf({
      root: model({
        resources: '',
        build:
          '<item objectid="1" p:path="/3D/Objects/a.model"/>' +
          '<item objectid="1" p:path="/3D/Objects/b.model"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
        }),
        '3D/Objects/b.model': model({
          resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
        }),
      },
    });

    // A generous budget reads the whole package.
    await expect(
      read3mf(archive, testReadContext(), { budget: createInflationBudget(DEFAULT_ZIP_LIMITS) }),
    ).resolves.toBeDefined();

    // A budget sized to roughly one model part refuses, because the second part
    // charges the SAME total rather than starting again.
    const tight = createInflationBudget({ ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 900 });
    await expect(read3mf(archive, testReadContext(), { budget: tight })).rejects.toBeDefined();
  });
});

/* ================================================================= safety == */

describe('A2-X24: package paths cannot escape the archive', () => {
  const HOSTILE: readonly string[] = [
    '/../secrets.model',
    '/3D/../../etc/passwd.model',
    '3D/Objects/a.model',
    'C:\\\\windows\\\\a.model',
    'file:///3D/Objects/a.model',
    'http://example.invalid/a.model',
    '/3D/%2e%2e/a.model',
    '/3D/Objects/a.model\u0000',
    '/3D/Objects//a.model',
  ];

  for (const path of HOSTILE) {
    it(`refuses ${JSON.stringify(path)} without opening anything`, async () => {
      const refusal = await refusalFrom({
        root: model({
          resources: '',
          build: `<item objectid="1" p:path="${path.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}"/>`,
        }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          }),
        },
      });

      // Malformed reference, never a followed one, and never a filesystem read.
      expect(refusal.code).toBe(AppErrorCode.MalformedFile);
      expect(refusal.reason).toBe(ImportRefusal.ThreeMfMalformedModelPartPath);
    });
  }

  it('refuses a path naming a package part that is not a model', async () => {
    const refusal = await refusalFrom({
      root: model({
        resources: '',
        build: '<item objectid="1" p:path="/Metadata/thumbnail.png"/>',
      }),
      parts: { 'Metadata/thumbnail.png': 'not a model' },
    });

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfModelPartNotAModel);
  });
});

describe('A2-X23: a package path resolves case-normalised, and unambiguously', () => {
  it('follows a reference whose spelling differs from the entry name in case only', async () => {
    /*
     * `readZipDirectory` already refuses two entries whose names differ only in
     * case, so exactly one entry can correspond to a canonical key and the
     * platform cannot be what decides which. That is what makes normalising safe
     * rather than ambiguous.
     */
    const result = await read3mf(
      await packageOf({
        root: model({ resources: '', build: '<item objectid="1" p:path="/3D/OBJECTS/A.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(1);
  });
});

/* ============================================================ lifecycle ==== */

describe('A2-X16: cancelling part way through a package', () => {
  /**
   * A context that cancels once `decodeText` has been called `after` times.
   *
   * KEYED ON THE DECODE, because that is one per MODEL PART and nothing else in
   * a 3MF read calls it. Cancelling on the second decode therefore lands the
   * flip precisely where A2 needed a new cancellation site: the first child is
   * fully parsed and materialised, and the second is about to be.
   */
  function cancellingAfterDecodes(after: number): {
    context: ReturnType<typeof testReadContext>;
    decodes: () => number;
  } {
    let decodes = 0;
    let cancelled = false;
    const base = testReadContext();
    return {
      decodes: () => decodes,
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
        decodeText: (bytes: Uint8Array): string => {
          decodes += 1;
          if (decodes >= after) cancelled = true;
          return base.decodeText(bytes);
        },
      },
    };
  }

  it('stops with OPERATION_CANCELLED and produces no document', async () => {
    const archive = await packageOf({
      root: model({
        resources: '',
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

    // Root, then child A, then child B: cancel as the second child decodes.
    const { context, decodes } = cancellingAfterDecodes(3);
    const recorded = stats();

    let caught: unknown;
    try {
      await read3mf(archive, context, { stats: recorded });
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    /*
     * A CANCEL IS NOT DAMAGE. Reporting a cancelled multi-part read as a
     * malformed package would tell a user their file is broken because they
     * pressed Cancel — and with several parts in play that accusation is even
     * harder for them to check.
     */
    expect(caught.code).toBe(AppErrorCode.OperationCancelled);
    expect(caught.code).not.toBe(AppErrorCode.MalformedFile);
    // IT STOPPED WHERE IT WAS TOLD TO. The third child was never opened.
    expect(decodes()).toBeLessThan(4);
  });

  it('leaves the reader usable: the very next package imports', async () => {
    const archive = await packageOf({
      root: model({
        resources: '',
        build:
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
    });

    const { context } = cancellingAfterDecodes(2);
    await expect(read3mf(archive, context)).rejects.toBeDefined();

    const good = await read3mf(archive, testReadContext());
    expect(good.document.parts).toHaveLength(2);
  });

  it('shares one cancellation token across every model part', async () => {
    /*
     * ONE TOKEN, NOT ONE PER PART. A token scoped to a part would mean a cancel
     * requested while the third child parsed was observed only by that child —
     * and the walk would carry on with the next one, which is a Cancel button
     * that stops a thing the user cannot see and not the thing they asked for.
     *
     * Proven by cancelling during the ROOT's decode and observing that no child
     * is ever opened.
     */
    const archive = await packageOf({
      root: model({
        resources: '',
        build:
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
    });

    const { context, decodes } = cancellingAfterDecodes(1);
    await expect(read3mf(archive, context)).rejects.toBeDefined();
    expect(decodes()).toBe(1);
  });
});

describe('A2-X17, A2-X18: a multi-part import is all or nothing', () => {
  it('produces no document when one reachable part of many is malformed', async () => {
    /*
     * THE CENTRAL TRANSACTIONAL CLAIM. Two children are perfectly good and the
     * third is not; the outcome is a refusal and NOT two parts' worth of
     * geometry. `read3mf` returns a document or throws, and nothing becomes
     * authoritative until the worker's `commitImportedDocument` accepts one — so
     * partial success is not a state this layer can even represent.
     */
    const archive = await packageOf({
      root: model({
        resources: '',
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
        // Malformed: a triangle pointing past its own vertex list.
        '3D/Objects/c.model': model({
          resources:
            '<object id="1" type="model"><mesh><vertices>' +
            '<vertex x="0" y="0" z="0"/></vertices><triangles>' +
            '<triangle v1="0" v2="7" v3="9"/></triangles></mesh></object>',
        }),
      },
    });

    const failure = await read3mf(archive, testReadContext()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isAppError(failure)).toBe(true);
    if (!isAppError(failure)) return;
    expect(failure.code).toBe(AppErrorCode.MalformedFile);
    expect(refusalOf(failure)).toBe(ImportRefusal.ThreeMfBadVertexIndex);
  });

  it('reads a good package immediately after a failed multi-part one', async () => {
    const broken = await packageOf({
      root: model({
        resources: '',
        build: '<item objectid="1" p:path="/3D/Objects/missing.model"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        }),
      },
    });
    await expect(read3mf(broken, testReadContext())).rejects.toBeDefined();

    const good = await packageOf({
      root: model({ resources: '', build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        }),
      },
    });
    const result = await read3mf(good, testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });

  it('produces no document when a resource ceiling is crossed mid-package', async () => {
    // §35: the most important shape. Two parts fit; the third crosses. Nothing
    // that was already materialised reaches a document.
    const archive = await packageOf({
      root: model({
        resources: '',
        build:
          '<item objectid="1" p:path="/3D/Objects/a.model"/>' +
          '<item objectid="1" p:path="/3D/Objects/b.model"/>' +
          '<item objectid="1" p:path="/3D/Objects/c.model"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
        }),
        '3D/Objects/b.model': model({
          resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
        }),
        '3D/Objects/c.model': model({
          resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
        }),
      },
    });

    let caught: unknown;
    try {
      await read3mf(archive, testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxTotalTriangles: 11 },
      });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(caught.code).toBe(AppErrorCode.ResourceLimitExceeded);
    expect(refusalOf(caught)).toBe(ImportRefusal.ThreeMfTooManyTriangles);
    // THE PACKAGE-WIDE OBSERVED METRIC, which is what makes the refusal act on.
    expect(caught.details.produced).toBe(12);
    expect(caught.details.limit).toBe(11);
  });
});

/* ======================================== unsupported production constructs */

describe('A2-X19, A2-X20: what a production package still cannot do', () => {
  it('refuses an unknown required extension even alongside production', async () => {
    const refusal = await refusalFrom({
      root:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" ` +
        'xmlns:z="http://example.invalid/secure/2099" requiredextensions="p z">' +
        '<resources/>' +
        '<build><item objectid="1" p:path="/3D/Objects/a.model"/></build></model>',
      parts: {
        '3D/Objects/a.model': model({
          resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
        }),
      },
    });

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
    expect(refusal.details.extension).toBe('http://example.invalid/secure/2099');
    /*
     * IT NO LONGER SAYS THE WHOLE EXTENSION IS UNSUPPORTED. That sentence
     * stopped being true when A2 implemented the reachable subset, and leaving
     * it in place would send a user to re-export a file that would import.
     */
    expect(refusal.message.toLowerCase()).not.toContain('production extension');
  });

  it('refuses an unknown required extension declared by a REFERENCED part', async () => {
    // A child part's own declaration is as binding as the root's. Reading its
    // geometry anyway would import the recognisable half of a file that says it
    // cannot be understood that way.
    const refusal = await refusalFrom({
      root: model({ resources: '', build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model':
          '<?xml version="1.0" encoding="UTF-8"?>' +
          `<model unit="millimeter" xmlns="${CORE_NS}" ` +
          'xmlns:z="http://example.invalid/secure/2099" requiredextensions="z">' +
          `<resources><object id="1" type="model">${markerMesh(1)}</object></resources>` +
          '<build/></model>',
      },
    });

    expect(refusal.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
  });
});

describe('A2-X21: a model part nothing references is never opened', () => {
  it('parses only what the root build can reach', async () => {
    const recorded = stats();
    const result = await read3mf(
      await packageOf({
        root: model({ resources: '', build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          }),
          // Two spares, one of which is MALFORMED. If reachability were not the
          // rule, this package would be refused rather than imported — which
          // makes the spare a far stronger probe than an unused valid part.
          '3D/Objects/spare.model': model({
            resources: `<object id="1" type="model">${markerMesh(8)}</object>`,
          }),
          '3D/Objects/broken.model': '<not-even-xml',
        },
      }),
      testReadContext(),
      { stats: recorded },
    );

    expect(result.document.parts).toHaveLength(1);
    expect(recorded.meshResourcesMaterialised).toBe(1);
  });
});

describe('A2-X22: the document’s part order is the file’s traversal order', () => {
  it('follows root build order, then component order, across part boundaries', async () => {
    /*
     * NOT `Map` INSERTION, NOT ZIP DIRECTORY ORDER, NOT COMPLETION TIMING. The
     * walk is depth-first and strictly sequential — every `await` is awaited
     * before the next branch starts — so the order below is the order the file
     * spells out. The markers make a reshuffle visible rather than plausible.
     */
    const result = await read3mf(
      await packageOf({
        root: model({
          resources:
            '<object id="50" type="model"><components>' +
            '<component objectid="1" p:path="/3D/Objects/b.model"/>' +
            '<component objectid="1" p:path="/3D/Objects/a.model"/>' +
            '</components></object>',
          build:
            '<item objectid="1" p:path="/3D/Objects/c.model"/>' +
            '<item objectid="50"/>' +
            '<item objectid="1" p:path="/3D/Objects/a.model"/>',
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
      }),
      testReadContext(),
    );

    expect(result.document.parts.map((part) => markerOf(part.mesh.positions))).toEqual([
      3, 2, 1, 1,
    ]);
    // Part ids are expansion order, and unique across model parts.
    expect(result.document.parts.map((part) => part.id)).toEqual([
      'part-1',
      'part-2',
      'part-3',
      'part-4',
    ]);
  });

  it('produces the same document every time', async () => {
    const archive = await packageOf({
      root: model({
        resources: '',
        build:
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
    });

    const first = await read3mf(archive, testReadContext());
    const second = await read3mf(archive, testReadContext());
    expect(first.document.parts.map((part) => markerOf(part.mesh.positions))).toEqual(
      second.document.parts.map((part) => markerOf(part.mesh.positions)),
    );
  });
});

/* =============================================================== cycles ==== */

describe('A2-X26: cycles and depth are bounded across part boundaries', () => {
  it('refuses a cycle that passes through another model part', async () => {
    /*
     * A.model:1 -> B.model:1 -> A.model:1. Neither part is cyclic on its own,
     * which is exactly why the path set has to be keyed on (part, object): a
     * per-part check would see nothing wrong and the walk would not terminate.
     *
     * The chained reference is refused before the cycle can close, because a
     * non-root part may not carry a path at all — so this is proof of the
     * stronger rule. The single-part cycle below proves the path set itself.
     */
    const refusal = await refusalFrom({
      root: model({ resources: '', build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
      parts: {
        '3D/Objects/a.model': model({
          resources:
            '<object id="1" type="model"><components>' +
            '<component objectid="1" p:path="/3D/3dmodel.model"/>' +
            '</components></object>',
        }),
      },
    });

    expect(refusal.code).toBe(AppErrorCode.MalformedFile);
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfNonRootModelPartPath);
  });

  it('still refuses an ordinary same-part cycle', async () => {
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

  it('does not treat the same object id in two parts as a cycle', async () => {
    // The inverse mistake, and the silent one: a bare-id path set would refuse
    // this ordinary package.
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
            resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(1);
  });

  it('spends one depth budget across the whole package', async () => {
    // A root component into a child, then the child's own component: two levels
    // that a per-part depth counter would call one each.
    const deep = await packageOf({
      root: model({
        resources:
          '<object id="1" type="model"><components>' +
          '<component objectid="7" p:path="/3D/Objects/a.model"/>' +
          '</components></object>',
        build: '<item objectid="1"/>',
      }),
      parts: {
        '3D/Objects/a.model': model({
          resources:
            `<object id="8" type="model">${markerMesh(1)}</object>` +
            '<object id="7" type="model"><components><component objectid="8"/></components></object>',
        }),
      },
    });

    await expect(
      read3mf(deep, testReadContext(), { limits: { ...DEFAULT_3MF_LIMITS, maxComponentDepth: 2 } }),
    ).resolves.toBeDefined();

    let caught: unknown;
    try {
      await read3mf(deep, testReadContext(), {
        limits: { ...DEFAULT_3MF_LIMITS, maxComponentDepth: 1 },
      });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(refusalOf(caught)).toBe(ImportRefusal.ThreeMfComponentTooDeep);
  });
});

/* =========================================== child build sections, ignored = */

describe('A2-X27: a referenced part’s own build section', () => {
  it('is ignored rather than turned into placements', async () => {
    /*
     * THE SPECIFICATION REQUIRES CONSUMERS TO IGNORE IT, and the alternative is
     * worse than it sounds: a child's build describes how that part looks ON ITS
     * OWN, so importing it would add placements the package never asked for and
     * silently double the model.
     */
    const result = await read3mf(
      await packageOf({
        root: model({ resources: '', build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources:
              `<object id="1" type="model">${markerMesh(1)}</object>` +
              `<object id="2" type="model">${markerMesh(2)}</object>`,
            build: '<item objectid="1"/><item objectid="2"/>',
          }),
        },
      }),
      testReadContext(),
    );

    // ONE part: the root's single item. Not three.
    expect(result.document.parts).toHaveLength(1);
    expect(markerOf(result.document.parts[0]?.mesh.positions ?? [])).toBe(1);
  });

  it('accepts a referenced part whose build is empty', async () => {
    // Which is what a conformant producer writes, and what the root-only
    // "no build items" refusal must not fire on.
    const result = await read3mf(
      await packageOf({
        root: model({ resources: '', build: '<item objectid="1" p:path="/3D/Objects/a.model"/>' }),
        parts: {
          '3D/Objects/a.model': model({
            resources: `<object id="1" type="model">${markerMesh(1)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );
    expect(result.document.parts).toHaveLength(1);
  });

  it('still refuses a ROOT with no build items', async () => {
    const refusal = await refusalFrom({
      root: model({ resources: `<object id="1" type="model">${markerMesh(1)}</object>` }),
    });
    expect(refusal.reason).toBe(ImportRefusal.ThreeMfNoBuildItems);
  });
});

describe('A2-X25: the producer shape BETA-001 reported', () => {
  /**
   * A MANIFEST ROOT WITH PER-OBJECT MODEL PARTS, which is what PrusaSlicer and
   * other production-extension producers actually emit: an empty
   * `<resources/>`, one build item per object, each naming its own `.model`.
   *
   * SYNTHETIC, NOT VENDORED. It is built here from the specification's
   * structure rather than copied from a producer file, so that passing means the
   * semantics are right rather than that one exporter's bytes were matched. The
   * real producer-authored corpus is exercised separately.
   */
  it('imports every object, in build order, with each transform applied', async () => {
    const result = await read3mf(
      await packageOf({
        root:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" requiredextensions="p">` +
          '<metadata name="Application">SomeSlicer 1.0</metadata>' +
          '<resources/>' +
          '<build>' +
          '<item objectid="1" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>' +
          '<item objectid="1" p:path="/3D/Objects/object_2.model" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>' +
          '<item objectid="1" p:path="/3D/Objects/object_3.model" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>' +
          '</build></model>',
        parts: {
          '3D/Objects/object_1.model': model({
            unit: 'millimeter',
            resources: `<object id="1" type="model" name="Body">${markerMesh(1)}</object>`,
          }),
          '3D/Objects/object_2.model': model({
            unit: 'millimeter',
            resources: `<object id="1" type="model" name="Lid">${markerMesh(2)}</object>`,
          }),
          '3D/Objects/object_3.model': model({
            unit: 'millimeter',
            resources: `<object id="1" type="model" name="Pin">${markerMesh(3)}</object>`,
          }),
        },
      }),
      testReadContext(),
    );

    expect(result.document.parts).toHaveLength(3);
    expect(result.document.unit).toBe('millimeter');
    expect(result.document.parts.map((part) => markerOf(part.mesh.positions))).toEqual([1, 2, 3]);
    expect(result.document.parts.map((part) => part.name)).toEqual(['Body', 'Lid', 'Pin']);
    expect(result.document.parts.map((part) => part.transform[9])).toEqual([10, 20, 30]);
    // NO WARNING ABOUT THE EXTENSION. Ordinary supported use is not a loss.
    expect(result.warnings).toEqual([]);
    expect(result.compatibility.unsupported).toEqual([]);
  });
});
