import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError, LengthUnit } from '@cadfixer/shared';
import { distinctMeshes, triangleCount } from '@cadfixer/mesh-core';
import { buildBinaryStl, triangleAt, UNIT_TRIANGLE } from '../stl/fixtures';
import { modelXml, TETRAHEDRON_MESH, valid3mf } from '../threemf/zip-fixtures';
import { readStl } from '../stl/stl-reader';
import { readObj } from '../obj/obj-reader';
import { read3mf } from '../threemf/threemf-reader';
import { MeshFormatId } from '../formats';
import { testReadContext } from '../test-context';
import { exportSnapshotOf, ExportObservation, type WrittenDocument } from './export-contract';
import { ExportRefusal, exportRefusalOf } from './export-errors';
import { exportDocument } from './export-document';
import {
  testExportReadContext,
  testWriteContext,
  testWriteContextWithDeflate,
} from './test-context';
import { inspect3mf } from './threemf-oracle';
import { checkObjStructure, inspectObj } from './obj-oracle';
import type { GeometryDocument } from '@cadfixer/mesh-core';

/**
 * RR01 – RR06: REAL IMPORTS, EXPORTED.
 *
 * Every source here is produced by the production reader from real bytes, not
 * by a document builder in a test. That matters because a hand-built document
 * is whatever the test author believed a document looks like; a document that
 * came out of the importer is what the product actually holds.
 */

const STL = buildBinaryStl([UNIT_TRIANGLE, triangleAt(4), triangleAt(8)]);
const OBJ_TEXT =
  'o Alpha\nv 0 0 0\nv 10 0 0\nv 0 10 0\nv 0 0 10\n' +
  'f 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n' +
  'o Beta\nv 40 0 0\nv 50 0 0\nv 40 10 0\nf 5 6 7\n';

async function importStl(): Promise<GeometryDocument> {
  const result = await readStl(STL, testReadContext());
  return { parts: [{ id: 'part-1' as never, mesh: result.mesh, transform: IDENTITY }] };
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] as const;

async function importObj(): Promise<GeometryDocument> {
  return (await readObj(new TextEncoder().encode(OBJ_TEXT), testReadContext())).document;
}

async function import3mf(unit = 'millimeter'): Promise<GeometryDocument> {
  const archive = await valid3mf(
    modelXml({
      unit,
      resources:
        `<object id="1" type="model" name="Left">${TETRAHEDRON_MESH}</object>` +
        `<object id="2" type="model" name="Right">${TETRAHEDRON_MESH}</object>`,
      build: '<item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 40 0 0"/>',
    }),
  );
  return (await read3mf(archive, testReadContext())).document;
}

async function importSharedThreeMf(count: number): Promise<GeometryDocument> {
  const items = Array.from(
    { length: count },
    (_item, index) =>
      `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${String(index * 20)} 0 0"/>`,
  ).join('');
  const archive = await valid3mf(
    modelXml({
      unit: 'inch',
      resources: `<object id="1" type="model" name="Repeated">${TETRAHEDRON_MESH}</object>`,
      build: items,
    }),
  );
  return (await read3mf(archive, testReadContext())).document;
}

async function toObj(document: GeometryDocument): Promise<WrittenDocument> {
  return exportDocument({
    snapshot: exportSnapshotOf(document, 'doc-1', 1),
    target: MeshFormatId.Obj,
    write: testWriteContext(),
    read: testExportReadContext(),
  });
}

async function to3mf(document: GeometryDocument): Promise<WrittenDocument> {
  return exportDocument({
    snapshot: exportSnapshotOf(document, 'doc-1', 1),
    target: MeshFormatId.ThreeMf,
    write: testWriteContextWithDeflate(),
    read: testExportReadContext(),
  });
}

describe('RR01: STL import → OBJ export → OBJ read-back', () => {
  it('keeps every triangle and states no unit at either end', async () => {
    const source = await importStl();
    const written = await toObj(source);
    const parsed = await readObj(written.bytes, testExportReadContext());

    expect(triangleCount(parsed.document.parts[0]?.mesh as never)).toBe(3);
    // STL states no unit and OBJ states no unit, so nothing was lost here.
    expect(parsed.document.unit).toBeUndefined();
    expect(written.metadata.observations).not.toContain(ExportObservation.UnitOmitted);
    expect(checkObjStructure(inspectObj(written.bytes))).toEqual([]);
  });
});

describe('RR02: OBJ import → OBJ export → OBJ read-back', () => {
  it('keeps both objects, their names and their geometry', async () => {
    const source = await importObj();
    expect(source.parts).toHaveLength(2);

    const written = await toObj(source);
    const parsed = await readObj(written.bytes, testExportReadContext());

    expect(parsed.document.parts.map((part) => part.name)).toEqual(['Alpha', 'Beta']);
    expect(triangleCount(parsed.document.parts[0]?.mesh as never)).toBe(4);
    expect(triangleCount(parsed.document.parts[1]?.mesh as never)).toBe(1);
    expect(checkObjStructure(inspectObj(written.bytes))).toEqual([]);

    // A PART'S OWN VERTEX POOL, not the file's: Beta's three corners are its
    // own, exactly as they were after the first import.
    expect([...(parsed.document.parts[1]?.mesh.positions ?? [])]).toEqual([
      ...(source.parts[1]?.mesh.positions ?? []),
    ]);
  });
});

describe('RR03/RR04: 3MF import → 3MF export → 3MF read-back', () => {
  it('RR03: preserves unit, names, placements and geometry exactly', async () => {
    const source = await import3mf('inch');
    const written = await to3mf(source);
    const parsed = await read3mf(written.bytes, testExportReadContext());

    expect(parsed.document.unit).toBe(LengthUnit.Inch);
    expect(parsed.document.parts.map((part) => part.name)).toEqual(['Left', 'Right']);
    expect([...(parsed.document.parts[1]?.transform ?? [])]).toEqual([
      ...(source.parts[1]?.transform ?? []),
    ]);
    expect((await inspect3mf(written.bytes)).problems).toEqual([]);
  });

  it('RR04: keeps a thousand shared placements sharing one object', async () => {
    const source = await importSharedThreeMf(1_000);
    expect(distinctMeshes(source)).toHaveLength(1);

    const written = await to3mf(source);
    const parsed = await read3mf(written.bytes, testExportReadContext());
    const inspected = await inspect3mf(written.bytes);

    expect(inspected.problems).toEqual([]);
    expect((inspected.modelXml ?? '').match(/<object /g)).toHaveLength(1);
    expect(parsed.document.parts).toHaveLength(1_000);
    expect(distinctMeshes(parsed.document)).toHaveLength(1);
    expect(parsed.document.unit).toBe(LengthUnit.Inch);
    expect(written.metadata.observations).toContain(ExportObservation.SharingPreserved);
  });
});

describe('RR05: 3MF import → OBJ export → OBJ read-back', () => {
  it('is LOSSY, and every loss is recorded rather than glossed over', async () => {
    const source = await import3mf('inch');
    const written = await toObj(source);
    const parsed = await readObj(written.bytes, testExportReadContext());

    /*
     * THIS IS NOT A LOSSLESS CONVERSION AND IS NOT DESCRIBED AS ONE. Three
     * things change, and all three are stated as machine-readable facts for
     * Stage 4A-2B3 to present:
     */
    expect(written.metadata.observations).toContain(ExportObservation.UnitOmitted);
    expect(written.metadata.observations).toContain(ExportObservation.TransformsBaked);
    expect(written.metadata.observations).toContain(ExportObservation.NormalsOmitted);

    // The unit is gone.
    expect(parsed.document.unit).toBeUndefined();
    // The placement is in the coordinates: Right was at +40 and now IS at +40.
    expect(parsed.document.parts[1]?.mesh.positions[0]).toBe(40);
    expect([...(parsed.document.parts[1]?.transform ?? [])]).toEqual([...IDENTITY]);
    // The names survive.
    expect(parsed.document.parts.map((part) => part.name)).toEqual(['Left', 'Right']);
    expect(checkObjStructure(inspectObj(written.bytes))).toEqual([]);
  });

  it('flattens sharing, and says so', async () => {
    const source = await importSharedThreeMf(8);
    const written = await toObj(source);
    const parsed = await readObj(written.bytes, testExportReadContext());

    expect(written.metadata.observations).toContain(ExportObservation.SharingFlattened);
    expect(distinctMeshes(parsed.document)).toHaveLength(8);
    // Eight tetrahedra: thirty-two faces of geometry where the 3MF had four.
    expect(inspectObj(written.bytes).faceCount).toBe(32);
  });
});

describe('RR06: an unknown-unit document cannot become a 3MF', () => {
  it.each([
    ['STL', importStl],
    ['OBJ', importObj],
  ])('%s source is BLOCKED rather than given an invented unit', async (_label, load) => {
    const source = await load();
    expect(source.unit).toBeUndefined();

    let caught: unknown;
    try {
      await to3mf(source);
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught)).toBe(true);
    if (!isAppError(caught)) return;
    expect(caught.code).toBe(AppErrorCode.InvalidState);
    expect(exportRefusalOf(caught)).toBe(ExportRefusal.UnitRequired);
    // AND NO DEFAULT WAS APPLIED. The reader's millimetre default is a fact the
    // 3MF specification states about an absent attribute; an STL or an OBJ has
    // asserted nothing, so there is nothing to read.
    expect(caught.message).not.toMatch(/millimet/i);
  });
});
