import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import { ImportRefusal, refusalOf } from '../import-errors';
import { testReadContext } from '../test-context';
import { modelPartKeyOfEntry, type ModelPartKey } from './package-path';
import { ModelPartRole, PackageModelGraph, type PackageGraphFailure } from './package-graph';
import { createInflationBudget, type ZipEntry } from './zip';
import { buildZip, CONTENT_TYPES, modelXml, RELS, TETRAHEDRON_MESH } from './zip-fixtures';
import { parseModelXml, read3mf } from './threemf-reader';

/**
 * A1-I04, A1-R01 – A1-R04 — THE GRAPH'S OWNERSHIP RULES.
 *
 * Stage 6D-A1 adds no production capability. What it adds is a place where
 * three rules can be enforced by a type instead of by remembering them, and
 * these are the tests that make each rule fail loudly if A2 breaks it:
 *
 *   parse-once, reachability-only loading, and one budget per package.
 *
 * The graph is generic over the parse result, so these exercise the ownership
 * contract without needing a parser — which is the point: the contract is about
 * WHO loads and HOW OFTEN, not about what a model part contains.
 */

function entry(name: string): ZipEntry {
  return { name, method: 8, compressedSize: 10, uncompressedSize: 100, localOffset: 0 };
}

const ROOT = entry('3D/3dmodel.model');
const CHILD_A = entry('3D/Objects/object_1.model');
const CHILD_B = entry('3D/Objects/object_2.model');
const UNREFERENCED = entry('3D/Objects/never_referenced.model');
const ENTRIES: readonly ZipEntry[] = [ROOT, CHILD_A, CHILD_B, UNREFERENCED];

const rootKey = modelPartKeyOfEntry(ROOT);
const childAKey = modelPartKeyOfEntry(CHILD_A);
const childBKey = modelPartKeyOfEntry(CHILD_B);

const ROOT_XML = modelXml({
  resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
});
/** A conformant referenced part: resources, and an empty build section. */
const CHILD_XML = modelXml({
  resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
  build: '',
});

function refuse(failure: PackageGraphFailure): never {
  throw new Error(
    `graph refused: ${failure.reason} ${String(failure.loaded)}/${String(failure.limit)}`,
  );
}

/** A graph whose loader records every entry it was asked to read. */
function countingGraph(options: { maxModelParts?: number } = {}): {
  graph: PackageModelGraph<{ from: string }>;
  loads: string[];
} {
  const loads: string[] = [];
  const graph = new PackageModelGraph<{ from: string }>({
    rootKey,
    entries: ENTRIES,
    budget: createInflationBudget(),
    load: (loaded, key): Promise<{ parsed: { from: string }; unit: string }> => {
      loads.push(loaded.name);
      return Promise.resolve({ parsed: { from: key }, unit: 'millimeter' });
    },
    ...(options.maxModelParts === undefined ? {} : { maxModelParts: options.maxModelParts }),
  });
  return { graph, loads };
}

describe('A1-I04: a canonical model part is parsed at most once', () => {
  it('returns the same part object for a repeated request, without reloading', async () => {
    const { graph, loads } = countingGraph();

    const first = await graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse);
    const second = await graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse);

    /*
     * THE RULE THAT MAKES SHARING POSSIBLE. A package may place one referenced
     * object fifty times; parsing its part fifty times would cost fifty inflate
     * and scan passes and produce fifty copies of one mesh.
     */
    expect(second).toBe(first);
    expect(loads).toEqual(['3D/Objects/object_1.model']);
    expect(graph.loadedCount).toBe(1);
  });

  it('collapses CONCURRENT requests into one parse', async () => {
    /*
     * Parse-once has to hold for callers that do not await each other, or it is
     * only a property of sequential code. Two references to one part resolved
     * in parallel is the ordinary shape of a build walk.
     */
    const { graph, loads } = countingGraph();

    const [one, two, three] = await Promise.all([
      graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse),
      graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse),
      graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse),
    ]);

    expect(loads).toHaveLength(1);
    expect(two).toBe(one);
    expect(three).toBe(one);
  });

  it('treats two spellings of one part as one part', async () => {
    const { graph, loads } = countingGraph();
    await graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse);
    await graph.ensurePart(
      '3d/objects/object_1.model' as ModelPartKey,
      ModelPartRole.Referenced,
      refuse,
    );
    expect(loads).toHaveLength(1);
  });
});

describe('A1: loading follows reachability, never the directory', () => {
  it('opens nothing until a part is asked for', async () => {
    const { graph, loads } = countingGraph();
    expect(loads).toEqual([]);
    expect(graph.loadedCount).toBe(0);
    await graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse);
    expect(loads).toEqual(['3D/Objects/object_1.model']);
  });

  it('leaves an unreferenced model entry unopened', async () => {
    /*
     * THE RESOURCE PROPERTY, not a tidiness one. A `.model` nothing references
     * is never inflated and never charged against the budget — which is also
     * what keeps a slicer project's spare parts from costing anything.
     */
    const { graph, loads } = countingGraph();
    await graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse);
    await graph.ensurePart(childBKey, ModelPartRole.Referenced, refuse);

    expect(loads).not.toContain(UNREFERENCED.name);
    expect(graph.has(modelPartKeyOfEntry(UNREFERENCED))).toBe(false);
    expect(graph.loadedCount).toBe(2);
  });

  it('has no way to load everything at once', () => {
    // Pinned as an API property: an enumerate-and-parse entry point is exactly
    // how lazy reachability would be lost without anyone noticing.
    const surface = Object.getOwnPropertyNames(PackageModelGraph.prototype);
    expect(surface).not.toContain('loadAll');
    expect(surface).not.toContain('loadEveryModelPart');
    expect(surface.filter((name) => name.startsWith('ensure'))).toEqual(['ensurePart']);
  });
});

describe('A1: one budget belongs to the package', () => {
  it('exposes the archive budget and never mints another', async () => {
    /*
     * A PER-PART BUDGET IS A PER-PART FULL ALLOWANCE, which is how a package
     * with twenty parts would extract twenty times the ceiling. The graph holds
     * the one budget so a part cannot be handed a fresh one.
     */
    const budget = createInflationBudget();
    const graph = new PackageModelGraph<number>({
      rootKey,
      entries: ENTRIES,
      budget,
      load: (): Promise<{ parsed: number; unit: undefined }> =>
        Promise.resolve({ parsed: 1, unit: undefined }),
    });

    expect(graph.inflationBudget).toBe(budget);
    await graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse);
    await graph.ensurePart(childBKey, ModelPartRole.Referenced, refuse);
    expect(graph.inflationBudget).toBe(budget);
  });

  it('refuses beyond a stated part ceiling BEFORE parsing the part that crosses', async () => {
    const { graph, loads } = countingGraph({ maxModelParts: 1 });
    await graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse);

    await expect(graph.ensurePart(childBKey, ModelPartRole.Referenced, refuse)).rejects.toThrow(
      /too-many-model-parts/,
    );
    // The refused part was never read.
    expect(loads).toEqual(['3D/Objects/object_1.model']);
  });

  it('applies no ceiling when none is stated, because A1 does not invent one', async () => {
    // Stage 6D-B3 established that a resource value without measurement behind
    // it is not a policy. The plumbing exists; the number is A2's to justify.
    const { graph } = countingGraph();
    await graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse);
    await graph.ensurePart(childBKey, ModelPartRole.Referenced, refuse);
    expect(graph.loadedCount).toBe(2);
  });
});

describe('A1-R: root and referenced parts are distinguishable', () => {
  it('A1-R01: root parsing is unchanged, including the empty-build refusal', () => {
    const parsed = parseModelXml(ROOT_XML);
    expect(parsed.role).toBe(ModelPartRole.Root);
    expect(parsed.build).toHaveLength(1);

    /*
     * ROOT VALIDATION WAS NOT WEAKENED TO LET A CHILD FIXTURE PASS. A root with
     * no build items is still malformed, and the default role is still Root, so
     * every existing caller behaves exactly as before.
     */
    expect(() => parseModelXml(CHILD_XML)).toThrow();
  });

  it('A1-R02: a referenced part may carry an empty build', () => {
    /*
     * The specification requires a referenced part to carry an EMPTY build and
     * requires consumers to ignore its entries. Before Stage 6D-A1 such a part
     * could not be parsed at all — `THREEMF_NO_BUILD_ITEMS` — which was the
     * first blocker A2 would have hit.
     */
    const parsed = parseModelXml(
      CHILD_XML,
      undefined,
      undefined,
      undefined,
      ModelPartRole.Referenced,
    );
    expect(parsed.role).toBe(ModelPartRole.Referenced);
    expect(parsed.build).toEqual([]);
    expect(parsed.objects.size).toBe(1);
  });

  it('A1-R03: each model part retains its own declared unit', async () => {
    /*
     * NEVER RECONCILED HERE. The specification says nothing about a referenced
     * part declaring a different unit, CAD Fixer holds one unit authority and
     * never rescales — so A3 must be able to see each declaration in order to
     * REFUSE a disagreement. Adopting the root's here would destroy the
     * evidence that one existed.
     */
    const graph = new PackageModelGraph<string>({
      rootKey,
      entries: ENTRIES,
      budget: createInflationBudget(),
      load: (loaded, key): Promise<{ parsed: string; unit: string }> =>
        Promise.resolve({
          parsed: key,
          unit: loaded.name === CHILD_B.name ? 'inch' : 'millimeter',
        }),
    });

    const a = await graph.ensurePart(childAKey, ModelPartRole.Referenced, refuse);
    const b = await graph.ensurePart(childBKey, ModelPartRole.Referenced, refuse);

    expect(a.unit).toBe('millimeter');
    expect(b.unit).toBe('inch');
    // Nothing has reconciled them, and nothing in A1 may.
    expect(a.unit).not.toBe(b.unit);
  });

  it('A1-R04: the parse result carries the role, so build authority cannot be lost', () => {
    const root = parseModelXml(ROOT_XML);
    const child = parseModelXml(
      modelXml({ resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>` }),
      undefined,
      undefined,
      undefined,
      ModelPartRole.Referenced,
    );

    /*
     * A referenced part MAY contain build entries — real producers emit them —
     * and a consumer is required to ignore them. The role travels on the result
     * so a later walk cannot mistake a child's build for the package's.
     */
    expect(child.build).toHaveLength(1);
    expect(child.role).toBe(ModelPartRole.Referenced);
    expect(root.role).toBe(ModelPartRole.Root);
  });
});

describe('A1: the root part still imports exactly as it did', () => {
  it('a single-part 3MF is unaffected by the foundation', async () => {
    const archive = await buildZip([
      { name: '[Content_Types].xml', content: CONTENT_TYPES, method: 8 },
      { name: '_rels/.rels', content: RELS, method: 8 },
      { name: '3D/3dmodel.model', content: ROOT_XML, method: 8 },
    ]);
    const result = await read3mf(archive, testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });
});

describe('A2: the compatibility boundary MOVED, and only where it was meant to', () => {
  /*
   * THIS BLOCK USED TO ASSERT THAT NOTHING NEW IMPORTED.
   *
   * Stage 6D-A1 was foundation only — types, a resolver and a registry — and the
   * specific failure it guarded against was HALF-SUPPORT: foundation code
   * existing, one reference happening to resolve, another being quietly skipped,
   * and an import succeeding with geometry missing. A truncated import reported
   * as a success is worse than the refusal it replaced.
   *
   * Stage 6D-A2 wired the foundation to production, so the assertions invert —
   * but the property they protect does not. Each case below now pins what the
   * package ACTUALLY PRODUCES, so a regression to half-support fails here: an
   * import that silently dropped the referenced geometry would produce the wrong
   * part count or the wrong mesh, not a passing test.
   */
  const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

  async function packageOf(model: string): Promise<Uint8Array> {
    return buildZip([
      { name: '[Content_Types].xml', content: CONTENT_TYPES, method: 8 },
      { name: '_rels/.rels', content: RELS, method: 8 },
      { name: '3D/3dmodel.model', content: model, method: 8 },
      // A REAL SECOND MODEL PART, present and resolvable. It is what the
      // references below actually follow.
      {
        name: '3D/Objects/object_1.model',
        content: modelXml({
          resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
          build: '',
        }),
        method: 8,
      },
    ]);
  }

  async function refusalFrom(model: string): Promise<{ code: string; reason: unknown }> {
    try {
      await read3mf(await packageOf(model), testReadContext());
    } catch (error) {
      if (!isAppError(error)) throw error;
      return { code: error.code, reason: refusalOf(error) };
    }
    throw new Error('expected a refusal');
  }

  it('a component with a production path now imports the referenced object', async () => {
    const model =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="${PRODUCTION_NS}">` +
      '<resources>' +
      '<object id="2" type="model"><components>' +
      '<component objectid="1" p:path="/3D/Objects/object_1.model"/>' +
      '</components></object>' +
      '</resources><build><item objectid="2"/></build></model>';

    const result = await read3mf(await packageOf(model), testReadContext());
    // THE ROOT DECLARES NO MESH. One part here means the child's geometry
    // arrived; zero would mean it was skipped and the import lied.
    expect(result.document.parts).toHaveLength(1);
    expect(result.document.parts[0]?.mesh.positions).toHaveLength(12);
  });

  it('a build item with a production path now imports the referenced object', async () => {
    const model =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="${PRODUCTION_NS}">` +
      '<resources/>' +
      '<build><item objectid="1" p:path="/3D/Objects/object_1.model"/></build></model>';

    const result = await read3mf(await packageOf(model), testReadContext());
    expect(result.document.parts).toHaveLength(1);
    expect(result.document.parts[0]?.mesh.positions).toHaveLength(12);
  });

  it('a declared production requirement no longer refuses, Case C included', async () => {
    const model =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="${PRODUCTION_NS}" requiredextensions="p">` +
      `<resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>` +
      '<build><item objectid="1"/></build></model>';

    const result = await read3mf(await packageOf(model), testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });

  it('an extension that is NOT production is still refused on declaration', async () => {
    // The transition is per extension. Nothing about unknown-extension handling
    // was weakened.
    const model =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
      'xmlns:z="http://example.invalid/unknown/2099" requiredextensions="z">' +
      `<resources><object id="1" type="model">${TETRAHEDRON_MESH}</object></resources>` +
      '<build><item objectid="1"/></build></model>';

    const refused = await refusalFrom(model);
    expect(refused.code).toBe(AppErrorCode.UnsupportedFile);
    expect(refused.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
  });

  it('a same-part dangling component is still MALFORMED, not a package lookup', async () => {
    /*
     * THE DISTINCTION v0.1.1 ESTABLISHED, and the one A2 could most easily
     * break. A component naming a missing object in the SAME part is a broken
     * file; routing it through package-part resolution would turn it into
     * `THREEMF_MODEL_PART_NOT_FOUND` or the cross-part missing-object code and
     * start telling users their archive is incomplete when their model is wrong.
     */
    const model = modelXml({
      resources:
        `<object id="1" type="model">${TETRAHEDRON_MESH}</object>` +
        '<object id="2" type="model"><components><component objectid="99"/></components></object>',
      build: '<item objectid="2"/>',
    });

    const refused = await refusalFrom(model);
    expect(refused.code).toBe(AppErrorCode.MalformedFile);
    expect(refused.reason).toBe(ImportRefusal.ThreeMfMissingObject);
    expect(refused.reason).not.toBe(ImportRefusal.ThreeMfModelPartNotFound);
    expect(refused.reason).not.toBe(ImportRefusal.ThreeMfMissingModelPartObject);
  });

  it('an unreferenced second model part still does not change a valid import', async () => {
    // Reachability decides what is read: the archive holds two `.model`
    // entries and a root that references neither, so the second is never
    // opened, never inflated and never charged.
    const archive = await buildZip([
      { name: '[Content_Types].xml', content: CONTENT_TYPES, method: 8 },
      { name: '_rels/.rels', content: RELS, method: 8 },
      { name: '3D/3dmodel.model', content: ROOT_XML, method: 8 },
      { name: '3D/Objects/spare.model', content: ROOT_XML, method: 8 },
    ]);
    const result = await read3mf(archive, testReadContext());
    expect(result.document.parts).toHaveLength(1);
  });
});
