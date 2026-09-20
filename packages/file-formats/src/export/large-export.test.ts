import { describe, expect, it } from 'vitest';
import { LengthUnit, isAppError } from '@cadfixer/shared';
import {
  createIndexArray,
  createPositionArray,
  documentTriangleCount,
  type CanonicalMesh,
  type GeometryDocument,
  type PartId,
} from '@cadfixer/mesh-core';
import { MeshFormatId } from '../formats';
import { read3mf, ThreeMfIngestion } from '../threemf/threemf-reader';
import { THREEMF_STREAMING_THRESHOLD_BYTES } from '../threemf/ingestion-route';
import { MAX_THREEMF_MODEL_ENTRY_BYTES } from '../threemf/size-limits';
import { exportSnapshotOf } from './export-contract';
import { ExportRefusal, exportRefusalOf } from './export-errors';
import { exportDocument } from './export-document';
import { testExportReadContext, testWriteContextWithDeflate } from './test-context';
import { testReadContext } from '../test-context';

/**
 * STAGE 6E-A4 — LARGE EXPORT, AND THE DEFECT THAT MADE IT FAIL.
 *
 * WHAT WAS WRONG. The 3MF writer bounded its model XML by `maxSerialisedBytes`
 * (512 MiB) while the reader refused a model entry over 256 MiB. Every
 * validated export reads its own artifact back with the production reader, so a
 * document landing between those two numbers was serialised in full,
 * compressed, and THEN refused at parse-back — surfacing as
 * `EXPORT_VALIDATION_UNREADABLE`, an INTERNAL error, after all the work. It was
 * reachable from any document of roughly 1.4 M triangles or more, which is an
 * ordinary multi-part package.
 *
 * WHAT THESE PROVE. That such a document now round-trips; that validation
 * routes the way an import does, so a large artifact is streamed rather than
 * held twice over; and that a document genuinely too large is refused by the
 * WRITER, cleanly and before the work, rather than by the validator afterwards.
 *
 * THEY ARE DELIBERATELY BIG. The defect only exists above a hundred-odd
 * megabytes of XML, so a small fixture cannot reach it; these are sized from
 * the constants rather than from a guess, and carry their own timeouts.
 */

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] as const;

/** Unshared triangles, the densest shape the writer can be handed. */
function soup(triangles: number): CanonicalMesh {
  const positions = createPositionArray(triangles * 9);
  const indices = createIndexArray(triangles * 3);
  for (let n = 0; n < triangles; n += 1) {
    const x = (n % 512) * 0.5;
    const y = Math.floor(n / 512) * 0.5;
    const at = n * 9;
    positions[at] = x;
    positions[at + 1] = y;
    positions[at + 2] = 0;
    positions[at + 3] = x + 0.4;
    positions[at + 4] = y;
    positions[at + 5] = 0;
    positions[at + 6] = x;
    positions[at + 7] = y + 0.4;
    positions[at + 8] = 0;
    indices[n * 3] = n * 3;
    indices[n * 3 + 1] = n * 3 + 1;
    indices[n * 3 + 2] = n * 3 + 2;
  }
  return { positions, indices, metadata: { sourceFormat: MeshFormatId.ThreeMf } };
}

function documentOf(mesh: CanonicalMesh): GeometryDocument {
  return {
    unit: LengthUnit.Millimeter,
    parts: [{ id: 'part-1' as PartId, mesh, transform: IDENTITY }],
  };
}

/** About 185 bytes of 3MF XML per unshared triangle, as the writer emits it. */
const BYTES_PER_TRIANGLE = 185;
const trianglesForXmlBytes = (bytes: number): number => Math.floor(bytes / BYTES_PER_TRIANGLE);

async function exportThreeMf(document: GeometryDocument): Promise<Uint8Array> {
  const written = await exportDocument({
    snapshot: exportSnapshotOf(document, 'doc-a4', 1),
    target: MeshFormatId.ThreeMf,
    write: testWriteContextWithDeflate(),
    read: testExportReadContext(),
  });
  return written.bytes;
}

describe('6E-A4: a large 3MF export is written, validated and re-openable', () => {
  it('A4-L26: a document whose XML exceeds the OLD 256 MiB ceiling round-trips', async () => {
    /*
     * THE REGRESSION, AT THE SIZE IT ACTUALLY OCCURRED. ~1.5 M triangles
     * serialises to roughly 277 MiB of model XML: over the old per-entry
     * ceiling, under the new one. Before Stage 6E-A4 this call rejected with
     * `EXPORT_VALIDATION_UNREADABLE` after writing the whole archive.
     */
    const triangles = 1_500_000;
    const xmlBytes = triangles * BYTES_PER_TRIANGLE;
    expect(xmlBytes).toBeGreaterThan(256 * 1024 * 1024);
    expect(xmlBytes).toBeLessThan(MAX_THREEMF_MODEL_ENTRY_BYTES);

    const bytes = await exportThreeMf(documentOf(soup(triangles)));
    expect(bytes.byteLength).toBeGreaterThan(0);

    // Validated by `exportDocument` already; read once more here so the
    // assertion is about the geometry rather than about the export not throwing.
    const parsed = await read3mf(bytes, testReadContext());
    expect(documentTriangleCount(parsed.document)).toBe(triangles);
    expect(parsed.document.unit).toBe(LengthUnit.Millimeter);
  }, 600_000);

  it('A4-L25: validation ROUTES — a generated entry past the threshold is streamed', async () => {
    /*
     * Export validation reads with `auto`, so an artifact whose model entry
     * crosses `THREEMF_STREAMING_THRESHOLD_BYTES` is validated by the streamed
     * path. Proven by reading the SAME artifact three ways and requiring the
     * documents to agree: if validation were pinned to one mode, the other two
     * would be untested against real generated output.
     */
    const triangles = trianglesForXmlBytes(THREEMF_STREAMING_THRESHOLD_BYTES) + 200_000;
    const bytes = await exportThreeMf(documentOf(soup(triangles)));

    const counts: number[] = [];
    for (const ingestion of [
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
      ThreeMfIngestion.Auto,
    ]) {
      const parsed = await read3mf(bytes, testReadContext(), { ingestion });
      counts.push(documentTriangleCount(parsed.document));
    }
    expect(counts).toEqual([triangles, triangles, triangles]);
  }, 600_000);

  it('A4-L27: a document past the entry ceiling is refused by the WRITER, not the validator', async () => {
    /*
     * THE POINT IS WHICH LAYER REFUSES. A resource refusal from the writer is a
     * decision CAD Fixer can explain; a refusal from parse-back is CAD Fixer
     * saying it wrote a file it cannot read, which is an internal failure. The
     * writer's ceiling is now the reader's, so the first one fires.
     */
    const triangles = trianglesForXmlBytes(MAX_THREEMF_MODEL_ENTRY_BYTES) + 500_000;
    let code = 'EXPORTED';
    let reason: unknown = undefined;
    try {
      await exportThreeMf(documentOf(soup(triangles)));
    } catch (error) {
      if (!isAppError(error)) throw error;
      code = error.code;
      reason = exportRefusalOf(error);
    }
    expect(code).toBe('RESOURCE_LIMIT_EXCEEDED');
    expect(reason).toBe(ExportRefusal.SerialisedTooLarge);
  }, 900_000);
});
