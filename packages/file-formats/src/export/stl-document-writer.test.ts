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
  IDENTITY_PART_TRANSFORM,
  partId,
  type CanonicalMesh,
  type GeometryDocument,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { readStl } from '../stl/stl-reader';
import { MeshFormatId } from '../formats';
import {
  DEFAULT_EXPORT_LIMITS,
  ExportObservation,
  expectedStlRoundTrip,
  exportSnapshotOf,
  type ExportDocumentSnapshot,
  type ExportLimits,
  type WrittenDocument,
} from './export-contract';
import { ExportRefusal, exportRefusalOf } from './export-errors';
import { exportDocument } from './export-document';
import {
  maxStlDocumentTriangles,
  stlDocumentByteLength,
  writeStlDocument,
} from './stl-document-writer';
import { MAX_BINARY_STL_TRIANGLES } from './stl-layout';
import { testExportReadContext, testWriteContext } from './test-context';
import { checkBinaryStlStructure, inspectBinaryStl } from './stl-oracle';

/**
 * STL-WD01 – STL-WD16: WHOLE-DOCUMENT STL, through the PRODUCTION writer and
 * the PRODUCTION reader.
 *
 * WHY THIS SUITE IS SEPARATE FROM `stl-writer.test.ts`. That file tests writing
 * ONE `CanonicalMesh`, which is what the active-part export does. This tests
 * flattening a whole `GeometryDocument` — a different operation whose entire
 * risk is in the flattening: a placement applied twice, a placement not applied
 * at all, or parts concatenated in the wrong order all produce a perfectly
 * well-formed file full of geometry in the wrong place.
 *
 * EVERY CASE VALIDATES BY PARSE-BACK, against `expectedStlRoundTrip`, which
 * states STL's losses precisely rather than pretending there are none. An
 * INDEPENDENT oracle (`stl-oracle.ts`) checks the container structurally
 * alongside, because our reader agreeing with our writer proves only that they
 * agree.
 */

/* ------------------------------------------------------------- fixtures -- */

function mesh(positions: readonly number[], indices: readonly number[]): CanonicalMesh {
  const p = createPositionArray(positions.length);
  for (const [at, value] of positions.entries()) p[at] = value;
  const i = createIndexArray(indices.length);
  for (const [at, value] of indices.entries()) i[at] = value;
  return { positions: p, indices: i, metadata: { sourceFormat: MeshFormatId.Stl } };
}

/** A single triangle in the XY plane, wound counter-clockwise seen from +Z. */
const TRIANGLE = mesh([0, 0, 0, 10, 0, 0, 0, 10, 0], [0, 1, 2]);

/** A closed tetrahedron: four faces, four vertices. */
const TETRAHEDRON = mesh(
  [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
  [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
);

function translation(x: number, y = 0, z = 0): PartTransform {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z];
}

/** A quarter turn about Z, then a translation. Rotation AND offset in one. */
function rotateZThenMove(x: number, y: number): PartTransform {
  return [0, 1, 0, -1, 0, 0, 0, 0, 1, x, y, 0];
}

/** Non-uniform scale: 2 in X, 3 in Y, 1 in Z. */
const NON_UNIFORM_SCALE: PartTransform = [2, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0];

/** A reflection through the YZ plane. Reverses geometric orientation. */
const REFLECTION: PartTransform = [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

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

async function exportStl(
  document: GeometryDocument,
  limits: ExportLimits = DEFAULT_EXPORT_LIMITS,
): Promise<WrittenDocument> {
  return exportDocument({
    snapshot: exportSnapshotOf(document, 'doc-1', 1),
    target: MeshFormatId.Stl,
    write: testWriteContext({ limits }),
    read: testExportReadContext(),
  });
}

/** The corner stream the file is expected to contain, in file order. */
function expectedCorners(document: GeometryDocument): number[] {
  const expected = expectedStlRoundTrip(exportSnapshotOf(document, 'doc-1', 1));
  const part = expected.parts[0];
  return part === undefined ? [] : [...part.mesh.positions];
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

/* ------------------------------------------------------------ STL-WD01 -- */

describe('STL-WD01 — one identity part', () => {
  it('writes a well-formed binary STL that reads back as the same triangles', async () => {
    const document = documentOf([{ mesh: TETRAHEDRON }]);
    const written = await exportStl(document);

    const inspection = checkBinaryStlStructure(written.bytes);
    expect(inspection.declaredTriangles).toBe(4);
    expect(inspection.byteLength).toBe(stlDocumentByteLength(4));

    const parsed = await readStl(written.bytes, testExportReadContext());
    expect([...parsed.mesh.positions]).toEqual(expectedCorners(document));
  });

  it('reports no structural loss for a document that has no structure to lose', async () => {
    /*
     * THE FACT LIST IS CONDITIONED ON THE DOCUMENT, not on the target's name.
     * A one-part, identity-placed, unnamed, unit-less document loses nothing
     * an STL could have carried, and says so by recording nothing.
     */
    const written = await exportStl(documentOf([{ mesh: TRIANGLE }]));
    expect(written.metadata.observations).toEqual([]);
  });

  it('writes no user text into the fixed 80-byte header', async () => {
    const written = await exportStl(documentOf([{ mesh: TRIANGLE, name: 'secret/project/path' }]));
    const inspection = inspectBinaryStl(written.bytes);
    expect(inspection.header).toBe('CAD Fixer binary STL');
    expect(inspection.header).not.toContain('secret');
  });
});

/* ------------------------------------------------------------ STL-WD02 -- */

describe('STL-WD02 — two parts', () => {
  it('concatenates every part in document order into one triangle stream', async () => {
    const document = documentOf([{ mesh: TETRAHEDRON }, { mesh: TRIANGLE }]);
    const written = await exportStl(document);

    expect(written.metadata.triangleCount).toBe(5);
    expect(checkBinaryStlStructure(written.bytes).declaredTriangles).toBe(5);

    const parsed = await readStl(written.bytes, testExportReadContext());
    expect([...parsed.mesh.positions]).toEqual(expectedCorners(document));
  });

  it('records that the part structure was flattened', async () => {
    const written = await exportStl(documentOf([{ mesh: TRIANGLE }, { mesh: TRIANGLE }]));
    expect(written.metadata.observations).toContain(ExportObservation.PartStructureFlattened);
  });

  it('comes back as ONE part, because STL has one implicit object', async () => {
    const written = await exportStl(documentOf([{ mesh: TETRAHEDRON }, { mesh: TRIANGLE }]));
    const parsed = await readStl(written.bytes, testExportReadContext());
    // The reader produces one mesh; the document wrapper around it is one part.
    expect(parsed.mesh.indices.length / 3).toBe(5);
  });
});

/* ------------------------------------------------------------ STL-WD03 -- */

describe('STL-WD03 — a translated part', () => {
  it('bakes the translation into the written coordinates', async () => {
    const document = documentOf([{ mesh: TRIANGLE, transform: translation(100, 200, 300) }]);
    const written = await exportStl(document);
    const parsed = await readStl(written.bytes, testExportReadContext());

    // The first corner was the local origin, so it lands exactly on the offset.
    expect([...parsed.mesh.positions].slice(0, 3)).toEqual([100, 200, 300]);
    expect([...parsed.mesh.positions]).toEqual(expectedCorners(document));
    expect(written.metadata.observations).toContain(ExportObservation.TransformsBaked);
  });

  it('applies the placement EXACTLY ONCE', async () => {
    /*
     * THE FAILURE THIS CATCHES is a bake applied both when building the corner
     * and again when writing it. A doubled translation produces a perfectly
     * valid file with the model in the wrong place, which no structural check
     * would notice.
     */
    const written = await exportStl(
      documentOf([{ mesh: TRIANGLE, transform: translation(7, 0, 0) }]),
    );
    const parsed = await readStl(written.bytes, testExportReadContext());
    expect(parsed.mesh.positions[0]).toBe(7);
    expect(parsed.mesh.positions[3]).toBe(17);
  });

  it('leaves the coordinates of an identity-placed part untouched', async () => {
    const written = await exportStl(documentOf([{ mesh: TRIANGLE }]));
    const parsed = await readStl(written.bytes, testExportReadContext());
    expect([...parsed.mesh.positions].slice(0, 9)).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    expect(written.metadata.observations).not.toContain(ExportObservation.TransformsBaked);
  });
});

/* ------------------------------------------------------------ STL-WD04 -- */

describe('STL-WD04 — a rotated and scaled part', () => {
  it('writes world coordinates for a rotation composed with a translation', async () => {
    const document = documentOf([{ mesh: TRIANGLE, transform: rotateZThenMove(5, -5) }]);
    const written = await exportStl(document);
    const parsed = await readStl(written.bytes, testExportReadContext());
    expect([...parsed.mesh.positions]).toEqual(expectedCorners(document));
  });

  it('writes world coordinates under a non-uniform scale', async () => {
    const document = documentOf([{ mesh: TETRAHEDRON, transform: NON_UNIFORM_SCALE }]);
    const written = await exportStl(document);
    const parsed = await readStl(written.bytes, testExportReadContext());
    expect([...parsed.mesh.positions]).toEqual(expectedCorners(document));
  });

  it('recomputes the facet normal from the TRANSFORMED triangle, not the local one', async () => {
    /*
     * A NON-UNIFORM SCALE IS THE CASE THAT EXPOSES A COPIED NORMAL. Scaling Y
     * by three tilts every face that is not axis-aligned, so a normal carried
     * over from the local geometry would point somewhere the surface does not.
     */
    const local = await exportStl(documentOf([{ mesh: TETRAHEDRON }]));
    const scaled = await exportStl(
      documentOf([{ mesh: TETRAHEDRON, transform: NON_UNIFORM_SCALE }]),
    );

    const localFacets = inspectBinaryStl(local.bytes).facets;
    const scaledFacets = inspectBinaryStl(scaled.bytes).facets;

    // The slanted face is the one whose normal must move.
    expect(scaledFacets[3]?.normal).not.toEqual(localFacets[3]?.normal);

    // And it must be a genuine unit normal of the transformed triangle.
    const facet = scaledFacets[3];
    expect(facet).toBeDefined();
    if (facet === undefined) return;
    const length = Math.hypot(...facet.normal);
    expect(length).toBeCloseTo(1, 5);
  });
});

/* ------------------------------------------------------------ STL-WD05 -- */

describe('STL-WD05 — a reflection transform', () => {
  it('writes reflected world coordinates', async () => {
    const document = documentOf([{ mesh: TETRAHEDRON, transform: REFLECTION }]);
    const written = await exportStl(document);
    const parsed = await readStl(written.bytes, testExportReadContext());
    expect([...parsed.mesh.positions]).toEqual(expectedCorners(document));
  });

  it('derives the facet normal from the reflected triangle, so it does not point inwards', async () => {
    /*
     * A REFLECTION REVERSES A TRIANGLE'S GEOMETRIC ORIENTATION. A normal copied
     * from the unreflected geometry would point into the solid — the file would
     * be self-consistent and every consumer would shade it inside out.
     *
     * This asserts the normal is the cross product of the WRITTEN corners, which
     * is the only definition that survives a reflection.
     */
    const written = await exportStl(documentOf([{ mesh: TETRAHEDRON, transform: REFLECTION }]));
    for (const facet of inspectBinaryStl(written.bytes).facets) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = facet.corners as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const e1 = [bx - ax, by - ay, bz - az] as const;
      const e2 = [cx - ax, cy - ay, cz - az] as const;
      const n: [number, number, number] = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const length = Math.hypot(...n);
      if (length === 0) continue;
      expect(facet.normal[0]).toBeCloseTo(n[0] / length, 5);
      expect(facet.normal[1]).toBeCloseTo(n[1] / length, 5);
      expect(facet.normal[2]).toBeCloseTo(n[2] / length, 5);
    }
  });
});

/* ------------------------------------------------------------ STL-WD06 -- */

describe('STL-WD06 — one shared mesh, two placements', () => {
  it('writes the shared geometry twice, in two places, and says so', async () => {
    const shared = TETRAHEDRON;
    const document = documentOf([{ mesh: shared }, { mesh: shared, transform: translation(1000) }]);
    const written = await exportStl(document);

    expect(written.metadata.triangleCount).toBe(8);
    expect(written.metadata.meshResourceCount).toBe(1);
    expect(written.metadata.observations).toContain(ExportObservation.SharingFlattened);

    const parsed = await readStl(written.bytes, testExportReadContext());
    expect([...parsed.mesh.positions]).toEqual(expectedCorners(document));
    /*
     * The second placement really is a thousand units away, not a duplicate.
     * The tetrahedron is four triangles — twelve corners, thirty-six floats —
     * so the second part's first corner is at float index 36.
     */
    expect(parsed.mesh.positions[36]).toBe(1000);
  });
});

/* ------------------------------------------------------------ STL-WD07 -- */

describe('STL-WD07 — a hundred placements', () => {
  it('writes every placement once, in order, from one copied mesh', async () => {
    const shared = TRIANGLE;
    const document = documentOf(
      Array.from({ length: 100 }, (_unused, index) => ({
        mesh: shared,
        transform: translation(index * 50),
      })),
    );
    const snapshot = exportSnapshotOf(document, 'doc-1', 1);
    // ONE COPY OF THE MESH IN THE SNAPSHOT, a hundred placements beside it.
    expect(snapshot.meshes).toHaveLength(1);
    expect(snapshot.parts).toHaveLength(100);

    const written = await exportStl(document);
    expect(written.metadata.triangleCount).toBe(100);
    expect(written.bytes.byteLength).toBe(stlDocumentByteLength(100));

    const parsed = await readStl(written.bytes, testExportReadContext());
    expect([...parsed.mesh.positions]).toEqual(expectedCorners(document));
    // The last placement is where document order says it should be.
    expect(parsed.mesh.positions[99 * 9]).toBe(99 * 50);
  });
});

/* --------------------------------------------------- STL-WD08 / STL-WD09 -- */

describe('STL-WD08 and STL-WD09 — the unit', () => {
  it('drops a KNOWN unit and says so, without rescaling anything', async () => {
    const document = documentOf([{ mesh: TRIANGLE }], LengthUnit.Inch);
    const written = await exportStl(document);

    expect(written.metadata.observations).toContain(ExportObservation.UnitOmitted);

    const parsed = await readStl(written.bytes, testExportReadContext());
    // THE NUMBERS ARE UNCHANGED. Rescaling to preserve a label the format
    // cannot hold would be inventing data.
    expect([...parsed.mesh.positions].slice(0, 9)).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0]);
  });

  it('says nothing about the unit when the source stated none', async () => {
    const written = await exportStl(documentOf([{ mesh: TRIANGLE }]));
    expect(written.metadata.observations).not.toContain(ExportObservation.UnitOmitted);
  });

  it('never writes a unit, so a unit-less document loses nothing', async () => {
    /*
     * THE READ-BACK STATES NO UNIT EITHER WAY, which is why the observation is
     * about the SOURCE having had one rather than about the file lacking one.
     */
    const written = await exportStl(documentOf([{ mesh: TRIANGLE }], LengthUnit.Meter));
    const parsed = await readStl(written.bytes, testExportReadContext());
    expect(parsed.unit).toBeUndefined();
  });
});

/* ------------------------------------------------------------ STL-WD10 -- */

describe('STL-WD10 — names, groups and material references', () => {
  it('records every metadata loss the document actually has', async () => {
    const withGroups: CanonicalMesh = {
      ...TETRAHEDRON,
      groups: [
        { name: 'shell', indexOffset: 0, indexCount: 6, materialRef: 'steel' },
        { name: 'base', indexOffset: 6, indexCount: 6 },
      ],
    };
    const written = await exportStl(
      documentOf([{ mesh: withGroups, name: 'Bracket', materialRef: 'steel' }]),
    );

    expect(written.metadata.observations).toContain(ExportObservation.NamesDropped);
    expect(written.metadata.observations).toContain(ExportObservation.GroupsDropped);
    expect(written.metadata.observations).toContain(ExportObservation.MaterialReferencesOmitted);
  });

  it('records nothing about metadata the document does not have', async () => {
    const written = await exportStl(documentOf([{ mesh: TETRAHEDRON }]));
    expect(written.metadata.observations).not.toContain(ExportObservation.NamesDropped);
    expect(written.metadata.observations).not.toContain(ExportObservation.GroupsDropped);
    expect(written.metadata.observations).not.toContain(
      ExportObservation.MaterialReferencesOmitted,
    );
  });

  it('writes no part name into the file, in any field', async () => {
    const written = await exportStl(documentOf([{ mesh: TRIANGLE, name: 'Bracket' }]));
    const text = new TextDecoder('utf-8', { fatal: false }).decode(written.bytes);
    expect(text).not.toContain('Bracket');
  });
});

/* ------------------------------------------------------------ STL-WD11 -- */

describe('STL-WD11 — negative zero', () => {
  it('preserves a stored negative zero through the write and the read', async () => {
    /*
     * `-0` IS OBSERVABLE and is a stored value like any other. The binary path
     * writes IEEE bits directly, so this is a statement that nothing normalises
     * it away — and `Object.is` is the only comparison that can tell.
     */
    const negativeZero = mesh([-0, 0, 0, 10, -0, 0, 0, 10, -0], [0, 1, 2]);
    const written = await exportStl(documentOf([{ mesh: negativeZero }]));
    const parsed = await readStl(written.bytes, testExportReadContext());

    expect(Object.is(parsed.mesh.positions[0], -0)).toBe(true);
    expect(Object.is(parsed.mesh.positions[4], -0)).toBe(true);
    expect(Object.is(parsed.mesh.positions[8], -0)).toBe(true);
  });

  it('treats a negative-zero translation as a real placement, not the identity', async () => {
    /*
     * A TRANSFORM OF `-0` IS NOT THE IDENTITY under `Object.is`, and the writer
     * must not conflate them: baking `-0` onto `0` yields `-0`, and skipping the
     * bake yields `+0`. The two are different stored values.
     */
    const document = documentOf([
      { mesh: mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]), transform: translation(-0) },
    ]);
    const written = await exportStl(document);
    const parsed = await readStl(written.bytes, testExportReadContext());
    expect([...parsed.mesh.positions]).toEqual(expectedCorners(document));
  });
});

/* ------------------------------------------------------------ STL-WD12 -- */

describe('STL-WD12 — the resource preflight', () => {
  it('computes the artifact size EXACTLY, because binary STL is fixed width', () => {
    expect(stlDocumentByteLength(0)).toBe(84);
    expect(stlDocumentByteLength(1)).toBe(134);
    expect(stlDocumentByteLength(1_000_000)).toBe(84 + 50_000_000);
  });

  it('derives the triangle ceiling from the output limit', () => {
    const ceiling = maxStlDocumentTriangles(DEFAULT_EXPORT_LIMITS);
    expect(ceiling).toBe(Math.floor((256 * 1024 * 1024 - 84) / 50));
    // And the ceiling really does fit.
    expect(stlDocumentByteLength(ceiling)).toBeLessThanOrEqual(
      DEFAULT_EXPORT_LIMITS.maxOutputBytes,
    );
    expect(stlDocumentByteLength(ceiling + 1)).toBeGreaterThan(
      DEFAULT_EXPORT_LIMITS.maxOutputBytes,
    );
  });

  it('never exceeds what the format itself can declare', () => {
    // A `uint32` triangle count is a real ceiling even when bytes are not.
    const enormous: ExportLimits = {
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
      maxSerialisedBytes: Number.MAX_SAFE_INTEGER,
    };
    expect(maxStlDocumentTriangles(enormous)).toBe(MAX_BINARY_STL_TRIANGLES);
  });

  it('refuses BEFORE allocating the artifact', async () => {
    /*
     * THE ALLOCATION IS THE WHOLE FILE. Discovering afterwards that 300 MiB was
     * too much would mean having already held 300 MiB to find out — so the
     * refusal has to come from the exact preflight, not from a running total.
     */
    const tiny: ExportLimits = { maxOutputBytes: 200, maxSerialisedBytes: 200 };
    await expectRefusal(
      async () => exportStl(documentOf([{ mesh: TETRAHEDRON }]), tiny),
      AppErrorCode.ResourceLimitExceeded,
      ExportRefusal.OutputTooLarge,
    );
  });

  it('accepts a document that fits the ceiling exactly', async () => {
    // Four triangles need 84 + 200 = 284 bytes.
    const exact: ExportLimits = { maxOutputBytes: 284, maxSerialisedBytes: 284 };
    const written = await exportStl(documentOf([{ mesh: TETRAHEDRON }]), exact);
    expect(written.bytes.byteLength).toBe(284);
  });
});

/* ------------------------------------------------------------ STL-WD13 -- */

describe('STL-WD13 — cancellation', () => {
  /**
   * A mesh with many triangles and three vertices.
   *
   * Cheap to build and to hold, and it crosses the writer's 32,768-triangle
   * batch boundary — which is the only place a long write yields, and therefore
   * the only place a cancellation can be observed mid-file.
   */
  function repeatedTriangles(count: number): CanonicalMesh {
    const indices = createIndexArray(count * 3);
    for (let at = 0; at < count; at += 1) {
      indices[at * 3] = 0;
      indices[at * 3 + 1] = 1;
      indices[at * 3 + 2] = 2;
    }
    const positions = createPositionArray(9);
    positions.set([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    return { positions, indices, metadata: { sourceFormat: MeshFormatId.Stl } };
  }

  it('stops mid-write rather than returning a partial file', async () => {
    const source = new CancellationSource();
    const document = documentOf([{ mesh: repeatedTriangles(40_000) }]);

    let yields = 0;
    let caught: unknown;
    try {
      await writeStlDocument(exportSnapshotOf(document, 'doc-1', 1), {
        ...testWriteContext({ cancellation: source.token }),
        // Cancel on the first yield, which happens between triangle batches.
        yieldToEventLoop: (): Promise<void> => {
          yields += 1;
          source.cancel();
          return Promise.resolve();
        },
      });
    } catch (cause) {
      caught = cause;
    }

    // The write really did reach a batch boundary, so this is a mid-file stop.
    expect(yields).toBeGreaterThan(0);
    /*
     * A CANCELLED WRITE PRODUCES NOTHING, never a truncated artifact. A partial
     * STL is worse than no STL: it is a valid-looking file with part of a model
     * in it and no indication that anything is missing.
     */
    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) expect(caught.code).toBe(AppErrorCode.OperationCancelled);
  });

  it('stops between parts when the token is already cancelled', async () => {
    const source = new CancellationSource();
    source.cancel();

    let caught: unknown;
    try {
      await writeStlDocument(
        exportSnapshotOf(documentOf([{ mesh: TETRAHEDRON }, { mesh: TRIANGLE }]), 'doc-1', 1),
        testWriteContext({ cancellation: source.token }),
      );
    } catch (cause) {
      caught = cause;
    }
    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) expect(caught.code).toBe(AppErrorCode.OperationCancelled);
  });

  it('completes when the token is never cancelled', async () => {
    const written = await writeStlDocument(
      exportSnapshotOf(documentOf([{ mesh: TETRAHEDRON }]), 'doc-1', 1),
      testWriteContext({ cancellation: uncancellable }),
    );
    expect(written.metadata.triangleCount).toBe(4);
  });
});

/* ------------------------------------------------------------ STL-WD14 -- */

describe('STL-WD14 — the revision travels with the snapshot', () => {
  it('carries the revision it was built from, so a stale artifact can be rejected', () => {
    /*
     * THE WRITER NEVER CHECKS THIS, and that is the design: the controller does,
     * against the handle the caller asked for. What matters here is that the
     * revision is IN the snapshot rather than beside it, so the two cannot be
     * paired wrongly.
     */
    const snapshot = exportSnapshotOf(documentOf([{ mesh: TRIANGLE }]), 'doc-7', 42);
    expect(snapshot.documentId).toBe('doc-7');
    expect(snapshot.revision).toBe(42);
  });
});

/* ------------------------------------------------------------ STL-WD15 -- */

describe('STL-WD15 — parse-back validation is mandatory', () => {
  it('refuses when the bytes do not read back as the document they came from', async () => {
    /*
     * VALIDATION IS PROVEN BY BREAKING IT. A suite in which validation never
     * fires proves only that the happy path is happy; this asserts the gate
     * actually rejects, by comparing a read-back against an expectation built
     * from a DIFFERENT document.
     */
    const written = await exportStl(documentOf([{ mesh: TRIANGLE }]));
    const parsed = await readStl(written.bytes, testExportReadContext());

    const { validateStlRoundTrip } = await import('./validate');
    const wrong = expectedStlRoundTrip(
      exportSnapshotOf(documentOf([{ mesh: TRIANGLE, transform: translation(1) }]), 'doc-1', 1),
    );

    let caught: unknown;
    try {
      const { singlePartDocument } = await import('@cadfixer/mesh-core');
      validateStlRoundTrip(wrong, singlePartDocument(parsed.mesh));
    } catch (cause) {
      caught = cause;
    }
    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) {
      expect(exportRefusalOf(caught)).toBe(ExportRefusal.ValidationFailed);
    }
  });

  it('predicts the world coordinates the reader will produce, bit for bit', async () => {
    /*
     * THE NARROWING IS THE POINT. A Float32 local coordinate goes through a
     * Float64 placement and is narrowed ONCE — `Math.fround` in the writer,
     * assignment to a Float32Array in the prediction, `setFloat32` in the file.
     * Values that are not representable are exactly where an approximate
     * prediction would drift.
     */
    const awkward = mesh([0.1, 0.2, 0.3, 1.7, -2.9, 0.0001, -5.5, 6.25, 7.125], [0, 1, 2]);
    const document = documentOf([{ mesh: awkward, transform: rotateZThenMove(0.3, -0.7) }]);
    const written = await exportStl(document);
    const parsed = await readStl(written.bytes, testExportReadContext());

    const expected = expectedCorners(document);
    for (const [at, value] of [...parsed.mesh.positions].entries()) {
      expect(Object.is(value, expected[at])).toBe(true);
    }
  });

  it('agrees with a hand-computed world coordinate', async () => {
    /*
     * AN INDEPENDENT ARITHMETIC CHECK, not a comparison of our prediction with
     * our writer. `applyPartTransform` is the document layer's own definition of
     * a placement, applied here directly.
     */
    const transform = rotateZThenMove(5, -5);
    const written = await exportStl(documentOf([{ mesh: TRIANGLE, transform }]));
    const parsed = await readStl(written.bytes, testExportReadContext());

    const [x, y, z] = applyPartTransform(transform, 10, 0, 0);
    expect(parsed.mesh.positions[3]).toBe(Math.fround(x));
    expect(parsed.mesh.positions[4]).toBe(Math.fround(y));
    expect(parsed.mesh.positions[5]).toBe(Math.fround(z));
  });
});

/* ------------------------------------------------------------ STL-WD16 -- */

describe('STL-WD16 — the source is never modified', () => {
  it('leaves the snapshot byte-identical after a whole-document flatten', async () => {
    const shared = TETRAHEDRON;
    const document = documentOf([
      { mesh: shared, transform: translation(3, 4, 5) },
      { mesh: shared, transform: NON_UNIFORM_SCALE },
    ]);
    const snapshot: ExportDocumentSnapshot = exportSnapshotOf(document, 'doc-1', 1);
    const before = snapshot.meshes.map((entry) => [...entry.positions]);
    const transformsBefore = snapshot.parts.map((part) => [...part.transform]);

    await exportDocument({
      snapshot,
      target: MeshFormatId.Stl,
      write: testWriteContext(),
      read: testExportReadContext(),
    });

    /*
     * FLATTENING IS A PROPERTY OF THE OUTPUT. There is no flattened
     * `CanonicalMesh` anywhere — the bake happens into the output buffer and
     * into nothing else, so a second export of the same snapshot produces the
     * same file rather than a doubly-transformed one.
     */
    expect(snapshot.meshes.map((entry) => [...entry.positions])).toEqual(before);
    expect(snapshot.parts.map((part) => [...part.transform])).toEqual(transformsBefore);
  });

  it('is idempotent: exporting twice produces identical bytes', async () => {
    const document = documentOf([{ mesh: TETRAHEDRON, transform: translation(3, 4, 5) }]);
    const snapshot = exportSnapshotOf(document, 'doc-1', 1);

    const first = await writeStlDocument(snapshot, testWriteContext());
    const second = await writeStlDocument(snapshot, testWriteContext());
    expect([...second.bytes]).toEqual([...first.bytes]);
  });

  it('leaves the authoritative document own arrays untouched', async () => {
    const document = documentOf([{ mesh: TETRAHEDRON, transform: translation(9) }]);
    const before = [...(document.parts[0]?.mesh.positions ?? [])];

    await exportStl(document);

    expect([...(document.parts[0]?.mesh.positions ?? [])]).toEqual(before);
  });
});

/* --------------------------------------------- degenerate triangle policy -- */

describe('a degenerate triangle stays a defect', () => {
  it('writes a ZERO normal rather than inventing a plausible direction', async () => {
    /*
     * THE SERIALISER MUST NOT CONCEAL A GEOMETRY DEFECT. A triangle with no area
     * has no plane, so there is no honest normal to write. Zero is what real STL
     * files already contain in abundance and what every consumer tolerates; a
     * fabricated direction would make the defect invisible downstream, and `NaN`
     * would make the file unreadable.
     */
    const degenerate = mesh([0, 0, 0, 1, 1, 1, 2, 2, 2], [0, 1, 2]);
    const written = await exportStl(documentOf([{ mesh: degenerate }]));
    const inspection = checkBinaryStlStructure(written.bytes);
    expect(inspection.facets[0]?.normal).toEqual([0, 0, 0]);
  });

  it('still writes the degenerate triangle, rather than dropping it', async () => {
    // EXPORT IS NOT REPAIR. Dropping the triangle would silently change the
    // user's model, which is a different operation they did not ask for.
    const degenerate = mesh([0, 0, 0, 1, 1, 1, 2, 2, 2], [0, 1, 2]);
    const written = await exportStl(documentOf([{ mesh: degenerate }]));
    expect(written.metadata.triangleCount).toBe(1);
  });

  it('writes a zero attribute byte count on every facet', async () => {
    const written = await exportStl(documentOf([{ mesh: TETRAHEDRON }]));
    for (const facet of inspectBinaryStl(written.bytes).facets) {
      expect(facet.attributeByteCount).toBe(0);
    }
  });
});
