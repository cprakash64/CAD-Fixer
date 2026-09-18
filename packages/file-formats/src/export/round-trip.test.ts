import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError, LengthUnit } from '@cadfixer/shared';
import { distinctMeshes, triangleCount } from '@cadfixer/mesh-core';
import { buildBinaryStl, triangleAt, UNIT_TRIANGLE } from '../stl/fixtures';
import {
  buildZip,
  CONTENT_TYPES,
  modelXml,
  TETRAHEDRON_MESH,
  valid3mf,
} from '../threemf/zip-fixtures';
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

/* ============================== RR07 – RR09: multi-model-part 3MF sources */

/**
 * A production-extension package: a manifest root and two referenced model
 * parts, each object placed with its own transform.
 *
 * BUILT HERE RATHER THAN IMPORTED FROM THE 3MF SUITE so this file keeps its
 * property — every source is produced by the production reader from real bytes.
 */
async function importProductionPackage(): Promise<GeometryDocument> {
  const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
  const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  const child = (name: string): string =>
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<model unit="millimeter" xmlns="${CORE}">` +
    `<resources><object id="1" type="model" name="${name}">${TETRAHEDRON_MESH}</object></resources>` +
    '<build/></model>';

  const archive = await buildZip([
    { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
    {
      name: '_rels/.rels',
      method: 8,
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rel0" Target="/3D/3dmodel.model" ' +
        'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    },
    {
      name: '3D/3dmodel.model',
      method: 8,
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<model unit="millimeter" xmlns="${CORE}" xmlns:p="${PRODUCTION}" requiredextensions="p">` +
        '<resources/><build>' +
        '<item objectid="1" p:path="/3D/Objects/left.model"/>' +
        '<item objectid="1" p:path="/3D/Objects/right.model" transform="1 0 0 0 1 0 0 0 1 40 0 0"/>' +
        '</build></model>',
    },
    { name: '3D/Objects/left.model', method: 8, content: child('Left') },
    { name: '3D/Objects/right.model', method: 8, content: child('Right') },
  ]);

  return (await read3mf(archive, testReadContext())).document;
}

describe('RR07: multi-model-part 3MF import → 3MF export → 3MF read-back', () => {
  it('keeps both placements and writes a flat, single-model-part package', async () => {
    const source = await importProductionPackage();
    expect(source.parts).toHaveLength(2);
    expect(distinctMeshes(source)).toHaveLength(2);

    const written = await to3mf(source);
    const parsed = await read3mf(written.bytes, testExportReadContext());

    expect(parsed.document.parts).toHaveLength(2);
    expect(parsed.document.unit).toBe(LengthUnit.Millimeter);
    expect(parsed.document.parts.map((part) => part.transform[9])).toEqual([0, 40]);
    expect(parsed.document.parts.map((part) => triangleCount(part.mesh))).toEqual([4, 4]);
  });

  it('writes ONE model part and no production references at all', async () => {
    /*
     * THE CONVERSION THIS PERFORMS, STATED. CAD Fixer's writer emits core 3MF:
     * one `3D/3dmodel.model`, every object inline, no `p:path` and no
     * `requiredextensions`. The input's package structure is not reconstructed,
     * and — the part that would be a defect rather than a documented loss —
     * none of the input's production metadata is copied out. A stale `p:path`
     * or a required-extension declaration in a file with one model part would
     * be an unreadable package of CAD Fixer's own making.
     */
    const written = await to3mf(await importProductionPackage());
    const inspected = await inspect3mf(written.bytes);
    expect(inspected.problems).toEqual([]);

    const models = inspected.entries
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase().endsWith('.model'));
    expect(models).toEqual(['3D/3dmodel.model']);

    // READ FROM THE ENTRY, not from the archive bytes: the part is deflated,
    // so scanning the container would prove nothing either way.
    const modelXmlText = inspected.modelXml ?? '';
    expect(modelXmlText).not.toContain('path=');
    expect(modelXmlText).not.toContain('requiredextensions');
    expect(modelXmlText).not.toContain('production/2015/06');
    // And what it DOES contain is both objects, inline.
    expect(modelXmlText.match(/<object /g) ?? []).toHaveLength(2);
  });
});

describe('RR08: multi-model-part 3MF import → OBJ export → OBJ read-back', () => {
  it('bakes each placement and keeps every triangle', async () => {
    const source = await importProductionPackage();
    const written = await toObj(source);
    const parsed = await readObj(written.bytes, testExportReadContext());

    expect(parsed.document.parts).toHaveLength(2);
    expect(parsed.document.parts.map((part) => triangleCount(part.mesh))).toEqual([4, 4]);
    expect(checkObjStructure(inspectObj(written.bytes))).toEqual([]);

    // The second placement's translation is BAKED, which is what OBJ can hold.
    const right = parsed.document.parts[1]?.mesh.positions ?? [];
    expect(Math.min(...Array.from(right).filter((_value, index) => index % 3 === 0))).toBe(40);
  });
});

describe('RR09: multi-model-part 3MF import → STL export → STL read-back', () => {
  it('flattens every placement into one solid', async () => {
    const source = await importProductionPackage();
    const written = await exportDocument({
      snapshot: exportSnapshotOf(source, 'doc-1', 1),
      target: MeshFormatId.Stl,
      write: testWriteContext(),
      read: testExportReadContext(),
    });
    const parsed = await readStl(written.bytes, testExportReadContext());

    // Two tetrahedra, flattened: STL holds one thing and says so.
    expect(triangleCount(parsed.mesh)).toBe(8);
  });
});
