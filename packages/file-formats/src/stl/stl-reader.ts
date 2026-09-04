import { malformedFile, throwIfCancelled, unsupportedFile } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { checkInputSize } from '../budget';
import type { FormatReadContext, MeshReadResult } from '../context';
import { MeshFormatId } from '../formats';
import { readAsciiStl } from './ascii-reader';
import { readBinaryStl } from './binary-reader';
import { detectStlEncoding, StlDetectionFailure, StlEncoding } from './detect';

/**
 * The STL entry point: detect the encoding, parse, and assemble a
 * `CanonicalMesh`.
 *
 * Structural validation is deliberately NOT performed here. The caller runs
 * `assertMeshStructure` on the result, so the gate between "a parser returned
 * something" and "the import succeeded" stays visible at the call site instead
 * of being buried inside the codec.
 */
export async function readStl(
  bytes: Uint8Array,
  context: FormatReadContext,
): Promise<MeshReadResult> {
  const oversized = checkInputSize(bytes.byteLength, context.budget, 'stl/import');
  if (oversized) throw oversized;

  context.progress.report(0, 'detecting');
  const detection = detectStlEncoding(bytes, context.budget);

  if (detection.encoding === undefined) {
    throw describeDetectionFailure(detection.failure, detection);
  }

  throwIfCancelled(context.cancellation);

  const raw =
    detection.encoding === StlEncoding.Binary
      ? await readBinaryStl(bytes, detection, context)
      : await readAsciiStl(bytes, context);

  const mesh: CanonicalMesh = {
    positions: raw.positions,
    indices: raw.indices,
    // No normals are stored. STL facet normals are advisory and frequently
    // disagree with winding order; shading is derived from the geometry
    // instead. See docs/adr/0007-stl-preservation-policy.md.
    ...(raw.groups.length > 0 ? { groups: raw.groups } : {}),
    metadata: {
      sourceFormat: MeshFormatId.Stl,
    },
  };

  /*
   * `unit` is deliberately ABSENT from the result, not set to a value.
   *
   * STL has no standardised model-unit field, so the honest statement is "the
   * source did not say". Defaulting to millimetres — which most STL consumers
   * quietly do — would invent information about the user's model, and the
   * interface would then display a unit the file never contained. The document
   * layer carries the absence through and the UI shows "Unspecified by STL".
   *
   * No transform is applied on import either: the file's coordinates are the
   * model's coordinates. Placement belongs to the part that holds this mesh.
   */
  return { mesh, encoding: detection.encoding, warnings: raw.warnings };
}

function describeDetectionFailure(
  failure: StlDetectionFailure,
  detection: { actualBytes: number; declaredTriangles?: number; requiredBytes?: number },
): Error {
  switch (failure) {
    case StlDetectionFailure.Empty:
      return malformedFile('This file is empty.', { actualBytes: 0 });

    case StlDetectionFailure.TooShort:
      return malformedFile('This file is too small to be an STL file.', {
        actualBytes: detection.actualBytes,
      });

    case StlDetectionFailure.BinaryTruncated:
      return malformedFile(
        'This STL file is truncated: it declares more triangles than it actually contains.',
        {
          declaredTriangles: detection.declaredTriangles ?? 0,
          requiredBytes: detection.requiredBytes ?? 0,
          actualBytes: detection.actualBytes,
        },
      );

    case StlDetectionFailure.Unrecognized:
    default:
      return unsupportedFile(
        'This file could not be recognised as either a binary or an ASCII STL file.',
        { actualBytes: detection.actualBytes },
      );
  }
}
