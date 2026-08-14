import { diagnostic, malformedFile, throwIfCancelled, type Diagnostic } from '@cadfixer/shared';
import { checkAllocation, planAllocation } from '../budget';
import type { FormatReadContext } from '../context';
import {
  BINARY_FACET_BYTES,
  BINARY_PREFIX_BYTES,
  binaryStlByteLength,
  type StlBinaryDetected,
} from './detect';
import { StlWarningCode, type StlRawGeometry } from './warnings';

/**
 * Binary STL reader.
 *
 * Layout: 80-byte header, uint32 facet count, then 50 bytes per facet — a
 * 3-float normal, three 3-float vertices, and a uint16 attribute byte count.
 * All numeric fields are little-endian, which `DataView` is told explicitly
 * rather than inherited from the host's byte order.
 *
 * Written against `DataView` and typed arrays only. No per-triangle objects are
 * created, so parsing a ten-million-triangle model does not put ten million
 * short-lived objects through the garbage collector.
 *
 * DATA INTEGRITY: this reader preserves what the file says. It does not weld
 * coincident vertices, drop degenerate or duplicate triangles, reorient
 * winding, or rescale anything. Those are repair operations and belong to a
 * later stage; a parser that quietly performed them would be changing the
 * user's model without being asked.
 */

/** Cancellation and progress are checked once per batch, not per triangle. */
const TRIANGLES_PER_BATCH = 65_536;

export async function readBinaryStl(
  bytes: Uint8Array,
  detection: StlBinaryDetected,
  context: FormatReadContext,
): Promise<StlRawGeometry> {
  const budget = context.budget;
  const triangleCount = detection.triangleCount;

  if (triangleCount === 0) {
    throw malformedFile('This STL file declares no triangles, so there is no model to load.', {
      inputBytes: bytes.byteLength,
    });
  }

  // Preflight. The declared count is attacker-controlled, so nothing is
  // allocated until it has been checked against both the engine's array limits
  // and our own budget.
  const plan = planAllocation(triangleCount, bytes.byteLength);
  const rejection = checkAllocation(plan, budget, 'stl/import/binary', bytes.byteLength);
  if (rejection) throw rejection;

  // Detection already proved the body fits, but the invariant is re-asserted
  // here so this function is safe to call directly, including from tests.
  const requiredBytes = binaryStlByteLength(triangleCount);
  if (requiredBytes > bytes.byteLength) {
    throw malformedFile('This STL file is truncated: it ends before its last triangle.', {
      declaredTriangles: triangleCount,
      requiredBytes,
      actualBytes: bytes.byteLength,
    });
  }

  // The Uint8Array may be a window onto a larger buffer, so the view is built
  // from its own offset and length rather than the whole underlying buffer.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const positions = new Float32Array(plan.vertices * 3);
  const indices = new Uint32Array(plan.vertices);

  let invalidStoredNormals = 0;
  let zeroStoredNormals = 0;

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (triangle % TRIANGLES_PER_BATCH === 0) {
      throwIfCancelled(context.cancellation);
      context.progress.report(triangle / triangleCount, 'parsing');
      // Returning to the event loop is what allows a queued cancel message to
      // be delivered; without it the check above could never see one.
      await context.yieldToEventLoop();
      throwIfCancelled(context.cancellation);
    }

    const facetOffset = BINARY_PREFIX_BYTES + triangle * BINARY_FACET_BYTES;

    // The stored facet normal is advisory. It is inspected for diagnostics but
    // never used as geometry: winding order is what actually carries
    // orientation, and a great many exporters write normals that disagree with
    // it or are simply zero.
    const normalX = view.getFloat32(facetOffset, true);
    const normalY = view.getFloat32(facetOffset + 4, true);
    const normalZ = view.getFloat32(facetOffset + 8, true);
    if (!Number.isFinite(normalX) || !Number.isFinite(normalY) || !Number.isFinite(normalZ)) {
      invalidStoredNormals += 1;
    } else if (normalX === 0 && normalY === 0 && normalZ === 0) {
      zeroStoredNormals += 1;
    }

    const positionBase = triangle * 9;
    const vertexBase = triangle * 3;

    for (let corner = 0; corner < 3; corner += 1) {
      const cornerOffset = facetOffset + 12 + corner * 12;
      const x = view.getFloat32(cornerOffset, true);
      const y = view.getFloat32(cornerOffset + 4, true);
      const z = view.getFloat32(cornerOffset + 8, true);

      // Non-finite coordinates cannot describe a position. Substituting zero
      // would silently move the user's geometry, so the file is rejected.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw malformedFile(
          'This STL file contains a vertex coordinate that is not a finite number.',
          {
            triangleIndex: triangle,
            cornerIndex: corner,
            byteOffset: cornerOffset,
          },
        );
      }

      const slot = positionBase + corner * 3;
      positions[slot] = x;
      positions[slot + 1] = y;
      positions[slot + 2] = z;
      indices[vertexBase + corner] = vertexBase + corner;
    }
  }

  throwIfCancelled(context.cancellation);
  context.progress.report(1, 'parsing');

  const warnings: Diagnostic[] = [];
  if (invalidStoredNormals > 0) {
    warnings.push(
      diagnostic(
        StlWarningCode.InvalidStoredNormals,
        'Some facet normals stored in this file are not finite numbers. They have been ignored; shading is computed from the geometry itself.',
        { count: invalidStoredNormals },
      ),
    );
  }
  if (zeroStoredNormals > 0) {
    warnings.push(
      diagnostic(
        StlWarningCode.ZeroStoredNormals,
        'Some facet normals stored in this file are zero. They have been ignored; shading is computed from the geometry itself.',
        { count: zeroStoredNormals },
      ),
    );
  }
  if (detection.trailingBytes > 0) {
    warnings.push(
      diagnostic(
        StlWarningCode.TrailingBytes,
        'This file has extra bytes after its last triangle. They were ignored.',
        { trailingBytes: detection.trailingBytes },
      ),
    );
  }

  return { positions, indices, triangleCount, warnings, groups: [] };
}
