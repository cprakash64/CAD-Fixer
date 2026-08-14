import { resourceLimitExceeded, throwIfCancelled } from '@cadfixer/shared';
import { triangleCount, triangleNormal, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  BINARY_FACET_BYTES,
  BINARY_HEADER_BYTES,
  BINARY_PREFIX_BYTES,
  binaryStlByteLength,
} from './detect';
import type { FormatWriteContext } from '../context';

/**
 * STL writers.
 *
 * Both are pure with respect to the input: the mesh is read, never mutated.
 * Facet normals are computed from the current geometry rather than carried over
 * from whatever the source file claimed, because the source normals are
 * advisory and may contradict the winding order.
 *
 * A degenerate triangle yields a ZERO normal, never `NaN`. Zero normals are
 * common in real STL files and every consumer tolerates them; `NaN` would
 * produce a file other tools cannot read.
 */

const TRIANGLES_PER_BATCH = 65_536;

/**
 * Fixed 80-byte header.
 *
 * Deliberately does NOT include the source filename or any other user-supplied
 * text. The header is a fixed-width binary field that many tools display
 * verbatim; putting unsanitised user data there is an easy way to leak a
 * filename into a file the user then shares.
 */
const BINARY_HEADER_TEXT = 'CAD Fixer binary STL';

/** Solid name used by the ASCII writer, for the same reason. */
const ASCII_SOLID_NAME = 'cadfixer';

/**
 * Significant digits used by the ASCII writer.
 *
 * Nine significant decimal digits uniquely identify any float32 value, and
 * canonical positions are float32 today, so ASCII export round-trips exactly
 * rather than approximately. If canonical positions ever become float64 this
 * must rise to 17 — see docs/adr/0004-canonical-mesh-model.md.
 */
const ASCII_FRACTION_DIGITS = 8;

export async function writeBinaryStl(
  mesh: CanonicalMesh,
  context: FormatWriteContext,
): Promise<Uint8Array> {
  const budget = context.budget;
  const triangles = triangleCount(mesh);
  const byteLength = binaryStlByteLength(triangles);

  // Computed in doubles, exact for any plausible triangle count, and checked
  // before a single byte is allocated.
  if (byteLength > budget.maxOutputBytes) {
    throw resourceLimitExceeded('This model is too large to export as a binary STL file.', {
      operation: 'stl/export/binary',
      requested: byteLength,
      limit: budget.maxOutputBytes,
      triangleCount: triangles,
    });
  }

  const output = new Uint8Array(byteLength);
  const view = new DataView(output.buffer);

  for (
    let index = 0;
    index < BINARY_HEADER_TEXT.length && index < BINARY_HEADER_BYTES;
    index += 1
  ) {
    output[index] = BINARY_HEADER_TEXT.charCodeAt(index);
  }
  view.setUint32(BINARY_HEADER_BYTES, triangles, true);

  const normal = new Float64Array(3);

  for (let triangle = 0; triangle < triangles; triangle += 1) {
    if (triangle % TRIANGLES_PER_BATCH === 0) {
      throwIfCancelled(context.cancellation);
      context.progress.report(triangles === 0 ? 1 : triangle / triangles, 'writing');
      await context.yieldToEventLoop();
      throwIfCancelled(context.cancellation);
    }

    triangleNormal(mesh, triangle, normal);
    const offset = BINARY_PREFIX_BYTES + triangle * BINARY_FACET_BYTES;

    view.setFloat32(offset, normal[0] ?? 0, true);
    view.setFloat32(offset + 4, normal[1] ?? 0, true);
    view.setFloat32(offset + 8, normal[2] ?? 0, true);

    const base = triangle * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = (mesh.indices[base + corner] ?? 0) * 3;
      const cornerOffset = offset + 12 + corner * 12;
      view.setFloat32(cornerOffset, mesh.positions[vertex] ?? 0, true);
      view.setFloat32(cornerOffset + 4, mesh.positions[vertex + 1] ?? 0, true);
      view.setFloat32(cornerOffset + 8, mesh.positions[vertex + 2] ?? 0, true);
    }

    // Attribute byte count. The field is vendor-specific and has no portable
    // meaning; some tools abuse it for colour. Documented policy: always write
    // zero, so we never emit something a consumer might misinterpret.
    view.setUint16(offset + 48, 0, true);
  }

  throwIfCancelled(context.cancellation);
  context.progress.report(1, 'writing');
  return output;
}

export async function writeAsciiStl(
  mesh: CanonicalMesh,
  context: FormatWriteContext,
): Promise<Uint8Array> {
  const budget = context.budget;
  const triangles = triangleCount(mesh);

  // ASCII output size is not known exactly in advance, but it is bounded: each
  // facet is at most this many bytes with 9-significant-digit exponential
  // coordinates. Checked before building the output.
  const maxBytesPerFacet = 320;
  const estimatedBytes = 64 + triangles * maxBytesPerFacet;
  if (estimatedBytes > budget.maxOutputBytes) {
    throw resourceLimitExceeded('This model is too large to export as an ASCII STL file.', {
      operation: 'stl/export/ascii',
      requested: estimatedBytes,
      limit: budget.maxOutputBytes,
      triangleCount: triangles,
    });
  }

  // Encoded incrementally rather than by building one enormous string and
  // joining it. A ten-million-triangle ASCII export is well over a gigabyte of
  // text; holding it as UTF-16 string fragments AND a joined string AND the
  // encoded bytes would triple peak memory at the worst moment.
  const byteChunks: Uint8Array[] = [];
  let totalBytes = 0;
  let pending = `solid ${ASCII_SOLID_NAME}\n`;

  const flush = (): void => {
    if (pending.length === 0) return;
    const encoded = encodeAscii(pending);
    byteChunks.push(encoded);
    totalBytes += encoded.byteLength;
    pending = '';
  };

  const normal = new Float64Array(3);

  for (let triangle = 0; triangle < triangles; triangle += 1) {
    if (triangle % TRIANGLES_PER_BATCH === 0) {
      throwIfCancelled(context.cancellation);
      context.progress.report(triangles === 0 ? 1 : triangle / triangles, 'writing');
      flush();
      await context.yieldToEventLoop();
      throwIfCancelled(context.cancellation);
    }

    triangleNormal(mesh, triangle, normal);
    pending += `  facet normal ${formatNumber(normal[0] ?? 0)} ${formatNumber(
      normal[1] ?? 0,
    )} ${formatNumber(normal[2] ?? 0)}\n    outer loop\n`;

    const base = triangle * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = (mesh.indices[base + corner] ?? 0) * 3;
      pending += `      vertex ${formatNumber(mesh.positions[vertex] ?? 0)} ${formatNumber(
        mesh.positions[vertex + 1] ?? 0,
      )} ${formatNumber(mesh.positions[vertex + 2] ?? 0)}\n`;
    }

    pending += '    endloop\n  endfacet\n';
  }

  pending += `endsolid ${ASCII_SOLID_NAME}\n`;
  flush();

  throwIfCancelled(context.cancellation);
  context.progress.report(1, 'writing');

  if (totalBytes > budget.maxOutputBytes) {
    throw resourceLimitExceeded('This model is too large to export as an ASCII STL file.', {
      operation: 'stl/export/ascii',
      requested: totalBytes,
      limit: budget.maxOutputBytes,
      triangleCount: triangles,
    });
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of byteChunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Formats a coordinate deterministically and independently of locale.
 *
 * `toExponential` always emits a `.` decimal separator regardless of the host
 * locale, unlike `toLocaleString`, which would produce `1,5` in much of Europe
 * and silently corrupt every exported file. Non-finite values cannot reach a
 * writer — the parser rejects them on import and `triangleNormal` returns zero
 * for degenerate triangles — but the guard is kept so a future caller cannot
 * introduce `NaN` into an output file.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return (0).toExponential(ASCII_FRACTION_DIGITS);
  return value.toExponential(ASCII_FRACTION_DIGITS);
}

/**
 * Encodes ASCII text to bytes.
 *
 * `TextEncoder` is not used because it belongs to the DOM/Node type libraries,
 * and this package is deliberately compiled without either so it stays runnable
 * anywhere. That costs nothing here: every byte this writer emits comes from a
 * fixed alphabet — the solid name, STL keywords, and `toExponential` output —
 * so the text is ASCII by construction and encoding is a direct copy.
 *
 * Any character outside ASCII would indicate a defect elsewhere, so it is
 * replaced with `?` rather than silently truncating a multi-byte sequence.
 */
function encodeAscii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[index] = code < 128 ? code : 63;
  }
  return bytes;
}
