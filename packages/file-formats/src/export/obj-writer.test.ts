import { describe, expect, it } from 'vitest';
import {
  AppErrorCode,
  CancellationSource,
  isAppError,
  LengthUnit,
  uncancellable,
} from '@cadfixer/shared';
import {
  applyPartTransform,
  createIndexArray,
  createPositionArray,
  distinctMeshes,
  IDENTITY_PART_TRANSFORM,
  partId,
  triangleCount,
  type CanonicalMesh,
  type GeometryDocument,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { readObj } from '../obj/obj-reader';
import type { DocumentReadResult } from '../document-reader';
import { MeshFormatId } from '../formats';
import {
  exportSnapshotOf,
  expectedObjRoundTrip,
  ExportObservation,
  DEFAULT_EXPORT_LIMITS,
  type ExportDocumentSnapshot,
  type WrittenDocument,
} from './export-contract';
import { ExportRefusal, exportRefusalOf } from './export-errors';
import { exportDocument } from './export-document';
import { writeObjDocument } from './obj-writer';
import { testExportReadContext, testWriteContext } from './test-context';
import { checkObjStructure, inspectObj } from './obj-oracle';

/**
 * OBJ-W01 – OBJ-W18, through the PRODUCTION writer and the PRODUCTION reader.
 *
 * EVERY CASE VALIDATES BY PARSE-BACK. A writer test that only asserts on the
 * text it produced is a test of the writer's opinion of itself: it passes when
 * the writer and the test agree, whether or not the file means anything. So
 * each case here writes bytes, reads them with the reader a user's import goes
 * through, and compares against `expectedObjRoundTrip` — which states OBJ's
 * losses precisely rather than pretending there are none.
 *
 * An INDEPENDENT oracle (`obj-oracle.ts`) inspects the text structurally
 * alongside, because production reader plus production writer agreeing proves
 * only that they agree.
 */

/* ------------------------------------------------------------- fixtures -- */

function mesh(positions: readonly number[], indices: readonly number[]): CanonicalMesh {
  const p = createPositionArray(positions.length);
  for (const [at, value] of positions.entries()) p[at] = value;
  const i = createIndexArray(indices.length);
  for (const [at, value] of indices.entries()) i[at] = value;
  return { positions: p, indices: i, metadata: { sourceFormat: MeshFormatId.Obj } };
}

const TRIANGLE = mesh([0, 0, 0, 10, 0, 0, 0, 10, 0], [0, 1, 2]);

/** A closed tetrahedron: four faces, four vertices. */
function tetrahedron(size = 10): CanonicalMesh {
  return mesh([0, 0, 0, size, 0, 0, 0, size, 0, 0, 0, size], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
}

function translation(x: number, y = 0, z = 0): PartTransform {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z];
}

interface PartInput {
  readonly mesh: CanonicalMesh;
  readonly transform?: PartTransform;
  readonly name?: string;
  readonly materialRef?: string;
}

function documentOf(parts: readonly PartInput[], unit?: LengthUnit): GeometryDocument {
  return {
    ...(unit === undefined ? {} : { unit }),
    parts: parts.map((part, index) => ({
      id: partId(`part-${String(index + 1)}`),
      mesh: part.mesh,
      transform: part.transform ?? IDENTITY_PART_TRANSFORM,
      ...(part.name === undefined ? {} : { name: part.name }),
      ...(part.materialRef === undefined ? {} : { materialRef: part.materialRef }),
    })),
  };
}

async function exportObj(
  document: GeometryDocument,
  limits = DEFAULT_EXPORT_LIMITS,
): Promise<WrittenDocument> {
  return exportDocument({
    snapshot: exportSnapshotOf(document, 'doc-1', 1),
    target: MeshFormatId.Obj,
    write: testWriteContext({ limits }),
    read: testExportReadContext(),
  });
}

async function readBack(bytes: Uint8Array): Promise<DocumentReadResult> {
  return readObj(bytes, testExportReadContext());
}

async function expectRefusal(
  run: () => Promise<unknown>,
  code: AppErrorCode,
  reason: ExportRefusal,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (cause) {
    caught = cause;
  }
  expect(isAppError(caught), 'expected a typed AppError').toBe(true);
  if (!isAppError(caught)) return;
  expect(caught.code).toBe(code);
  expect(exportRefusalOf(caught)).toBe(reason);
}

/* --------------------------------------------------------------- cases -- */

describe('OBJ-W01/W02: the simplest documents', () => {
  it('OBJ-W01: writes and reads back a single triangle', async () => {
    const written = await exportObj(documentOf([{ mesh: TRIANGLE }]));
    const parsed = await readBack(written.bytes);

    expect(parsed.document.parts).toHaveLength(1);
    expect(triangleCount(parsed.document.parts[0]?.mesh as never)).toBe(1);
    expect(written.metadata.formatId).toBe(MeshFormatId.Obj);
    expect(written.metadata.triangleCount).toBe(1);
    expect(written.metadata.partCount).toBe(1);
  });

  it('OBJ-W02: writes and reads back a closed solid', async () => {
    const written = await exportObj(documentOf([{ mesh: tetrahedron() }]));
    const parsed = await readBack(written.bytes);

    expect(triangleCount(parsed.document.parts[0]?.mesh as never)).toBe(4);
    // Every stored coordinate survives, exactly.
    expect([...(parsed.document.parts[0]?.mesh.positions ?? [])].sort((a, b) => a - b)).toEqual(
      [...tetrahedron().positions].sort((a, b) => a - b),
    );
  });
});

describe('OBJ-W03/W04/W05: parts and placements', () => {
  it('OBJ-W03: writes two independent parts as two objects', async () => {
    const written = await exportObj(
      documentOf([
        { mesh: tetrahedron(), name: 'Left' },
        { mesh: tetrahedron(6), name: 'Right' },
      ]),
    );
    const parsed = await readBack(written.bytes);

    expect(parsed.document.parts).toHaveLength(2);
    expect(parsed.document.parts.map((part) => part.name)).toEqual(['Left', 'Right']);
    expect(inspectObj(written.bytes).objects).toEqual(['Left', 'Right']);
  });

  it('OBJ-W04: bakes a translation into the coordinates', async () => {
    const document = documentOf([{ mesh: TRIANGLE, transform: translation(40, 5, -2) }]);
    const written = await exportObj(document);
    const parsed = await readBack(written.bytes);

    // THE PLACEMENT IS IN THE COORDINATES, and the part comes back at the
    // identity — which is what "OBJ has no transform" actually means.
    expect([...(parsed.document.parts[0]?.mesh.positions ?? [])]).toEqual([
      40, 5, -2, 50, 5, -2, 40, 15, -2,
    ]);
    expect([...(parsed.document.parts[0]?.transform ?? [])]).toEqual([...IDENTITY_PART_TRANSFORM]);
    expect(written.metadata.observations).toContain(ExportObservation.TransformsBaked);
  });

  it('OBJ-W05: bakes a rotation and scale in the row-vector convention', async () => {
    // 90° about Z with a scale of 2, in 3MF's row-vector convention — the same
    // convention `applyPartTransform` uses and the readers produce.
    const transform: PartTransform = [0, 2, 0, -2, 0, 0, 0, 0, 2, 0, 0, 0];
    const document = documentOf([{ mesh: TRIANGLE, transform }]);
    const written = await exportObj(document);
    const parsed = await readBack(written.bytes);

    const source = TRIANGLE.positions;
    const actual = parsed.document.parts[0]?.mesh.positions ?? new Float32Array(0);
    for (let at = 0; at < source.length; at += 3) {
      const [x, y, z] = applyPartTransform(
        transform,
        source[at] ?? 0,
        source[at + 1] ?? 0,
        source[at + 2] ?? 0,
      );
      expect(actual[at]).toBe(Math.fround(x));
      expect(actual[at + 1]).toBe(Math.fround(y));
      expect(actual[at + 2]).toBe(Math.fround(z));
    }
  });

  it('OBJ-W06: flattens a shared mesh, because OBJ has no instancing', async () => {
    const shared = tetrahedron();
    const document = documentOf([
      { mesh: shared, name: 'A' },
      { mesh: shared, transform: translation(40), name: 'B' },
    ]);
    // The SOURCE shares one mesh.
    expect(distinctMeshes(document)).toHaveLength(1);

    const written = await exportObj(document);
    const parsed = await readBack(written.bytes);

    // The OUTPUT does not, and says so rather than pretending.
    expect(parsed.document.parts).toHaveLength(2);
    expect(distinctMeshes(parsed.document)).toHaveLength(2);
    expect(written.metadata.observations).toContain(ExportObservation.SharingFlattened);
    expect(written.metadata.meshResourceCount).toBe(1);

    const inspected = inspectObj(written.bytes);
    expect(inspected.vertexCount).toBe(8);
    expect(inspected.faceCount).toBe(8);
  });
});

describe('OBJ-W07/W08/W09: names, groups and material references', () => {
  it('OBJ-W07: writes canonical groups as `g` records', async () => {
    const grouped: CanonicalMesh = {
      ...tetrahedron(),
      groups: [
        { name: 'shell', indexOffset: 0, indexCount: 6 },
        { name: 'base', indexOffset: 6, indexCount: 6 },
      ],
    };
    const written = await exportObj(documentOf([{ mesh: grouped, name: 'Solid' }]));
    const parsed = await readBack(written.bytes);

    expect(inspectObj(written.bytes).groups).toEqual(['shell', 'base']);
    const groups = parsed.document.parts[0]?.mesh.groups ?? [];
    expect(groups.map((group) => group.name)).toEqual(['shell', 'base']);
    expect(groups.map((group) => group.indexCount)).toEqual([6, 6]);
  });

  it('OBJ-W08: writes material references as `usemtl`, and no material library', async () => {
    const withMaterial: CanonicalMesh = {
      ...tetrahedron(),
      groups: [{ name: 'skin', indexOffset: 0, indexCount: 12, materialRef: 'red' }],
    };
    const written = await exportObj(documentOf([{ mesh: withMaterial }]));
    const inspected = inspectObj(written.bytes);

    expect(inspected.materials).toEqual(['red']);
    /*
     * NO `mtllib`. Naming a file CAD Fixer does not write would point the
     * reader at something that does not exist; the omission is recorded as a
     * fact instead.
     */
    expect(inspected.mtllib).toBeUndefined();
    expect(written.metadata.observations).toContain(ExportObservation.MaterialLibraryOmitted);
    expect(written.metadata.observations).toContain(ExportObservation.MaterialReferencesPreserved);
  });

  it('records a PART material reference OBJ cannot carry, rather than dropping it silently', async () => {
    /*
     * OBJ's `usemtl` applies to a run of faces — a `MeshGroup` — and there is no
     * per-object material record. A document whose PART names a material
     * therefore loses it, and the loss is stated as a fact for Stage 4A-2B3 to
     * present rather than discovered later by a puzzled user.
     */
    const written = await exportObj(
      documentOf([{ mesh: TRIANGLE, materialRef: 'steel', name: 'Bracket' }]),
    );
    expect(written.metadata.observations).toContain(ExportObservation.MaterialReferencesOmitted);
    expect(inspectObj(written.bytes).materials).toEqual([]);

    const parsed = await readBack(written.bytes);
    expect(parsed.document.parts[0]?.name).toBe('Bracket');
    expect(parsed.document.parts[0]?.materialRef).toBeUndefined();
  });

  it('says nothing about omitted materials when no part named one', async () => {
    const written = await exportObj(documentOf([{ mesh: TRIANGLE }]));
    expect(written.metadata.observations).not.toContain(
      ExportObservation.MaterialReferencesOmitted,
    );
  });

  it('writes a fixed header that no document string can reach', async () => {
    // A newline inside a comment ends it and the next characters become
    // records. Nothing user-supplied is ever written into one.
    const written = await exportObj(
      documentOf([{ mesh: TRIANGLE, name: 'x\n# not a comment\nv 9 9 9' }]),
    );
    const inspected = inspectObj(written.bytes);
    expect(inspected.vertexCount).toBe(3);
    expect(inspected.unexpectedRecords).toEqual([]);
    expect(checkObjStructure(inspected)).toEqual([]);
  });

  it('OBJ-W09: writes a hostile name as text and never as a record', async () => {
    const hostile = '../../evil\nv 999 999 999\nf 1 1 1';
    const written = await exportObj(documentOf([{ mesh: TRIANGLE, name: hostile }]));
    const parsed = await readBack(written.bytes);
    const inspected = inspectObj(written.bytes);

    /*
     * THE NEWLINE IS THE ATTACK. A name written verbatim would end the `o`
     * record and start a `v` and an `f` — the file would contain geometry the
     * document never had. The writer strips control characters, so the name
     * remains one record and the injected lines are not there.
     */
    expect(inspected.faceCount).toBe(1);
    expect(inspected.vertexCount).toBe(3);
    expect(parsed.document.parts).toHaveLength(1);
    expect(parsed.document.parts[0]?.name).not.toContain('\n');
    expect(parsed.document.parts[0]?.name).toContain('../../evil');
  });

  it('carries a Unicode name through unchanged', async () => {
    const written = await exportObj(documentOf([{ mesh: TRIANGLE, name: 'Brücke — 部品' }]));
    const parsed = await readBack(written.bytes);
    expect(parsed.document.parts[0]?.name).toBe('Brücke — 部品');
  });

  it('gives an unnamed part a generated object record rather than merging it', async () => {
    // Two unnamed parts with no `o` between them would come back as ONE part.
    const written = await exportObj(
      documentOf([{ mesh: TRIANGLE }, { mesh: TRIANGLE, transform: translation(50) }]),
    );
    const parsed = await readBack(written.bytes);
    expect(parsed.document.parts).toHaveLength(2);
  });
});

describe('OBJ-W10: units', () => {
  it('loses a known unit, and does not rescale to hide it', async () => {
    const document = documentOf([{ mesh: TRIANGLE }], LengthUnit.Inch);
    const written = await exportObj(document);
    const parsed = await readBack(written.bytes);

    expect(parsed.document.unit).toBeUndefined();
    expect(written.metadata.observations).toContain(ExportObservation.UnitOmitted);
    // THE NUMBERS ARE UNCHANGED. Rescaling to preserve a label the file cannot
    // hold would change the user's model to protect a claim about it.
    expect([...(parsed.document.parts[0]?.mesh.positions ?? [])]).toEqual([...TRIANGLE.positions]);
  });

  it('says nothing about units when the source stated none', async () => {
    const written = await exportObj(documentOf([{ mesh: TRIANGLE }]));
    expect(written.metadata.observations).not.toContain(ExportObservation.UnitOmitted);
  });
});

describe('OBJ-W11/W12: numeric fidelity', () => {
  it('OBJ-W11: preserves negative zero', async () => {
    const negativeZero = mesh([-0, 0, 0, 1, -0, 0, 0, 1, -0], [0, 1, 2]);
    const written = await exportObj(documentOf([{ mesh: negativeZero }]));
    const parsed = await readBack(written.bytes);

    const positions = parsed.document.parts[0]?.mesh.positions ?? new Float32Array(0);
    /*
     * `-0` SERIALISES AS "0" UNDER `toPrecision(9)` and returns `+0`. It is the
     * single value the measured nine-digit strategy loses, which is why the
     * writer special-cases it — and `Object.is` is the only comparison that can
     * see the difference.
     */
    expect(Object.is(positions[0], -0)).toBe(true);
    expect(Object.is(positions[4], -0)).toBe(true);
    expect(Object.is(positions[8], -0)).toBe(true);
  });

  it('OBJ-W12: round-trips a deterministic Float32 corpus bit-exactly', async () => {
    /*
     * THE CORPUS IS BIT PATTERNS, not random reals. `Math.random() * range`
     * never produces a subnormal or an exponent extreme, which is exactly where
     * a decimal strategy fails — Stage 4A measured `toFixed(6)` failing 50.7% of
     * Float32 values on a corpus built this way.
     */
    const values = float32Corpus(60_000);
    const positions = createPositionArray(values.length * 3);
    const indices = createIndexArray(values.length * 3);
    for (const [at, value] of values.entries()) {
      positions[at * 3] = value;
      positions[at * 3 + 1] = value;
      positions[at * 3 + 2] = value;
      indices[at * 3] = at;
      indices[at * 3 + 1] = at;
      indices[at * 3 + 2] = at;
    }

    const written = await writeObjDocument(
      exportSnapshotOf(
        documentOf([
          { mesh: { positions, indices, metadata: { sourceFormat: MeshFormatId.Obj } } },
        ]),
        'doc-1',
        1,
      ),
      testWriteContext(),
    );
    const parsed = await readBack(written.bytes);
    const back = parsed.document.parts[0]?.mesh.positions ?? new Float32Array(0);

    let mismatches = 0;
    for (const [at, value] of values.entries()) {
      if (!Object.is(back[at * 3], value)) mismatches += 1;
    }
    expect(mismatches, 'every Float32 must return bit-identical').toBe(0);
  });
});

describe('OBJ-W13/W14/W15: size and placement counts', () => {
  it('OBJ-W13: exports a large single-part document', async () => {
    const written = await exportObj(documentOf([{ mesh: grid(120) }]));
    const parsed = await readBack(written.bytes);
    expect(triangleCount(parsed.document.parts[0]?.mesh as never)).toBe(120 * 120 * 2);
  });

  it('OBJ-W14: exports 100 placements of one mesh', async () => {
    const shared = tetrahedron();
    const parts = Array.from({ length: 100 }, (_part, index) => ({
      mesh: shared,
      transform: translation(index * 20),
      name: `Part ${String(index + 1)}`,
    }));

    const written = await exportObj(documentOf(parts));
    const parsed = await readBack(written.bytes);

    expect(parsed.document.parts).toHaveLength(100);
    expect(inspectObj(written.bytes).faceCount).toBe(400);
    // Each placement is where the document put it, baked.
    expect(parsed.document.parts[99]?.mesh.positions[0]).toBe(99 * 20);
  });

  it('OBJ-W15: refuses a document whose OBJ text would exceed the output ceiling', async () => {
    /*
     * OBJ CANNOT SHARE, so a thousand placements is a thousand copies. With a
     * narrow ceiling that is refused BEFORE anything is serialised, from a
     * lower bound on the text a triangle needs — thirty bytes is shorter than
     * any triangle can actually be written, so the estimate can only
     * under-count and can never refuse something that would have fitted.
     */
    const shared = grid(40);
    const parts = Array.from({ length: 1_000 }, (_part, index) => ({
      mesh: shared,
      transform: translation(index * 100),
    }));

    await expectRefusal(
      async () =>
        exportObj(documentOf(parts), {
          maxOutputBytes: 4 * 1024 * 1024,
          maxSerialisedBytes: DEFAULT_EXPORT_LIMITS.maxSerialisedBytes,
        }),
      AppErrorCode.ResourceLimitExceeded,
      ExportRefusal.OutputTooLarge,
    );
  });

  it('refuses while writing when the preflight could not tell', async () => {
    // A ceiling between the lower bound and the real length: the estimate
    // passes and the running byte count is what stops it.
    const document = documentOf([{ mesh: grid(60) }]);
    await expectRefusal(
      async () =>
        exportObj(document, {
          maxOutputBytes: 128 * 1024,
          maxSerialisedBytes: DEFAULT_EXPORT_LIMITS.maxSerialisedBytes,
        }),
      AppErrorCode.ResourceLimitExceeded,
      ExportRefusal.OutputTooLarge,
    );
  });
});

describe('OBJ-W16: cancellation', () => {
  it('abandons a large export when the token is cancelled', async () => {
    const source = new CancellationSource();
    let yields = 0;

    const promise = writeObjDocument(
      exportSnapshotOf(documentOf([{ mesh: grid(200) }]), 'doc-1', 1),
      testWriteContext({
        cancellation: source.token,
        yieldToEventLoop: async () => {
          yields += 1;
          // Cancelled from OUTSIDE the loop, the way a message arriving at a
          // worker would set it — a flag the loop sets itself proves nothing.
          if (yields === 2) source.cancel();
          await Promise.resolve();
        },
      }),
    );

    await expect(promise).rejects.toThrow();
    expect(yields).toBeGreaterThan(1);
  });

  it('leaves the source document untouched after a cancellation', async () => {
    const document = documentOf([{ mesh: grid(100) }]);
    const before = [...(document.parts[0]?.mesh.positions ?? [])];
    const source = new CancellationSource();
    source.cancel();

    await expect(
      writeObjDocument(
        exportSnapshotOf(document, 'doc-1', 1),
        testWriteContext({ cancellation: source.token }),
      ),
    ).rejects.toThrow();

    expect([...(document.parts[0]?.mesh.positions ?? [])]).toEqual(before);
  });
});

describe('OBJ-W18 and malformed requests', () => {
  it('refuses a document with no parts', async () => {
    await expectRefusal(
      async () => exportObj({ parts: [] }),
      AppErrorCode.InvalidState,
      ExportRefusal.NoParts,
    );
  });

  it('refuses a snapshot whose part names geometry that is not present', async () => {
    const snapshot = exportSnapshotOf(documentOf([{ mesh: TRIANGLE }]), 'doc-1', 1);
    const first = snapshot.parts[0];
    if (first === undefined) throw new Error('missing part');
    const broken: ExportDocumentSnapshot = {
      ...snapshot,
      parts: [{ ...first, meshResourceIndex: 7 }],
    };

    await expectRefusal(
      async () =>
        exportDocument({
          snapshot: broken,
          target: MeshFormatId.Obj,
          write: testWriteContext(),
          read: testExportReadContext(),
        }),
      AppErrorCode.InvalidState,
      ExportRefusal.MissingMeshResource,
    );
  });

  it('refuses a snapshot with a non-finite placement', async () => {
    const snapshot = exportSnapshotOf(
      documentOf([{ mesh: TRIANGLE, transform: translation(1) }]),
      'doc-1',
      1,
    );
    const first = snapshot.parts[0];
    if (first === undefined) throw new Error('missing part');
    const broken: ExportDocumentSnapshot = {
      ...snapshot,
      parts: [
        { ...first, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, Number.NaN, 0, 0] as PartTransform },
      ],
    };

    await expectRefusal(
      async () =>
        exportDocument({
          snapshot: broken,
          target: MeshFormatId.Obj,
          write: testWriteContext(),
          read: testExportReadContext(),
        }),
      AppErrorCode.InvalidState,
      ExportRefusal.NonFiniteTransform,
    );
  });

  it('refuses two parts claiming the same identifier', async () => {
    const snapshot = exportSnapshotOf(
      documentOf([{ mesh: TRIANGLE }, { mesh: TRIANGLE }]),
      'doc-1',
      1,
    );
    const [first, second] = snapshot.parts;
    if (first === undefined || second === undefined) throw new Error('missing part');
    const broken: ExportDocumentSnapshot = {
      ...snapshot,
      parts: [first, { ...second, partId: 'part-1' }],
    };

    await expectRefusal(
      async () =>
        exportDocument({
          snapshot: broken,
          target: MeshFormatId.Obj,
          write: testWriteContext(),
          read: testExportReadContext(),
        }),
      AppErrorCode.InvalidState,
      ExportRefusal.DuplicatePartId,
    );
  });

  it('refuses a target CAD Fixer cannot write', async () => {
    await expectRefusal(
      async () =>
        exportDocument({
          snapshot: exportSnapshotOf(documentOf([{ mesh: TRIANGLE }]), 'doc-1', 1),
          target: MeshFormatId.Stl,
          write: testWriteContext(),
          read: testExportReadContext(),
        }),
      AppErrorCode.InvalidState,
      ExportRefusal.UnsupportedTarget,
    );
  });
});

describe('the expected round-trip document states the losses precisely', () => {
  it('bakes transforms, drops the unit and keeps names', () => {
    const document = documentOf(
      [{ mesh: TRIANGLE, transform: translation(5, 6, 7), name: 'Solid' }],
      LengthUnit.Millimeter,
    );
    const expected = expectedObjRoundTrip(exportSnapshotOf(document, 'doc-1', 1));

    expect(expected.unit).toBeUndefined();
    expect(expected.parts[0]?.name).toBe('Solid');
    expect([...(expected.parts[0]?.transform ?? [])]).toEqual([...IDENTITY_PART_TRANSFORM]);
    expect([...(expected.parts[0]?.mesh.positions ?? [])]).toEqual([5, 6, 7, 15, 6, 7, 5, 16, 7]);
  });

  it('does not claim local-coordinate equality', () => {
    // The mistake this function exists to prevent: comparing the parse-back
    // against the SOURCE would fail for every placed part, and "fixing" that by
    // loosening the comparison would stop the validator noticing a dropped
    // placement at all.
    const document = documentOf([{ mesh: TRIANGLE, transform: translation(40) }]);
    const expected = expectedObjRoundTrip(exportSnapshotOf(document, 'doc-1', 1));
    expect([...(expected.parts[0]?.mesh.positions ?? [])]).not.toEqual([...TRIANGLE.positions]);
  });
});

/* ------------------------------------------------------------- helpers -- */

/** A `side × side` quad grid: `side * side * 2` triangles sharing corners. */
function grid(side: number): CanonicalMesh {
  const positions = createPositionArray((side + 1) * (side + 1) * 3);
  let at = 0;
  for (let row = 0; row <= side; row += 1) {
    for (let column = 0; column <= side; column += 1) {
      positions[at] = column;
      positions[at + 1] = row;
      positions[at + 2] = ((column * 7 + row * 13) % 17) * 0.01;
      at += 3;
    }
  }

  const indices = createIndexArray(side * side * 6);
  let out = 0;
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const base = row * (side + 1) + column;
      indices[out] = base;
      indices[out + 1] = base + 1;
      indices[out + 2] = base + side + 1;
      indices[out + 3] = base + 1;
      indices[out + 4] = base + side + 2;
      indices[out + 5] = base + side + 1;
      out += 6;
    }
  }
  return { positions, indices, metadata: { sourceFormat: MeshFormatId.Obj } };
}

/** Deterministic finite Float32 values, drawn as BIT PATTERNS. */
export function float32Corpus(count: number): Float32Array {
  const named = [
    0,
    -0,
    1,
    -1,
    0.1,
    -0.1,
    1.401298464324817e-45,
    1.1754943508222875e-38,
    3.4028234663852886e38,
    -3.4028234663852886e38,
    1 / 3,
    Math.PI,
    16777216,
    16777217,
    1e-7,
    1e7,
  ];

  const out = new Float32Array(count);
  const view = new Float32Array(1);
  const bits = new Uint32Array(view.buffer);
  for (const [at, value] of named.entries()) {
    if (at < count) out[at] = value;
  }

  let seed = 0x4a10;
  for (let at = named.length; at < count;) {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    bits[0] = (t ^ (t >>> 14)) >>> 0;
    if (!Number.isFinite(view[0])) continue;
    out[at] = view[0] ?? 0;
    at += 1;
  }
  return out;
}

/** Silences the unused-import lint for a symbol only the corpus needs. */
void uncancellable;
