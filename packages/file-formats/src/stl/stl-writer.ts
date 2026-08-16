import {
  diagnostic,
  internalError,
  resourceLimitExceeded,
  throwIfCancelled,
  type Diagnostic,
} from '@cadfixer/shared';
import { triangleCount, triangleNormal, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  BINARY_FACET_BYTES,
  BINARY_HEADER_BYTES,
  BINARY_PREFIX_BYTES,
  binaryStlByteLength,
} from './detect';
import type { FormatWriteContext, MeshWriteResult } from '../context';
import { StlWarningCode } from './warnings';

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

/**
 * Upper bound on the bytes one ASCII facet can occupy — derived, not guessed.
 *
 * `toExponential(8)` produces at most sign + "d.dddddddd" + "e" + sign + two
 * exponent digits = 15 characters for any float32 (the widest float32 exponent
 * is e+38 / e-45). A facet is then:
 *
 *   "  facet normal " + 3 numbers + 2 spaces + newline     = 15 + 47 + 1 = 63
 *   "    outer loop\n"                                                   = 15
 *   3 x ("      vertex " + 3 numbers + 2 spaces + newline) = 3 x 61      = 183
 *   "    endloop\n" + "  endfacet\n"                       = 12 + 11     = 23
 *
 * 284 in total. The constant rounds up, and a test pins that real output never
 * exceeds it — so the pre-flight estimate is provably conservative rather than
 * merely believed to be.
 */
const MAX_ASCII_BYTES_PER_FACET = 300;

/** Generous allowance for one `solid`/`endsolid` pair. */
const ASCII_SOLID_OVERHEAD_BYTES = 128;

/**
 * Conservative upper bound on the ASCII output for a mesh.
 *
 * Exported so the application can decide — and tell the user — before starting
 * an export it would refuse.
 */
export function estimateAsciiStlBytes(triangleCount: number, groupCount = 0): number {
  const solids = Math.max(1, groupCount);
  return solids * ASCII_SOLID_OVERHEAD_BYTES + triangleCount * MAX_ASCII_BYTES_PER_FACET;
}

export async function writeBinaryStl(
  mesh: CanonicalMesh,
  context: FormatWriteContext,
): Promise<MeshWriteResult> {
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

  // METADATA LOSS, STATED. Binary STL has no multi-solid construct at all, so
  // grouping that survived import cannot survive this export. Saying so is the
  // difference between a documented loss and a silent one — the user may well
  // prefer ASCII once they know.
  const warnings: Diagnostic[] = [];
  if ((mesh.groups?.length ?? 0) > 1) {
    warnings.push(
      diagnostic(
        StlWarningCode.GroupsFlattened,
        'Binary STL cannot store separate solids, so this model\u2019s groups were merged into one. Export as ASCII STL to keep them.',
        { groupCount: mesh.groups?.length ?? 0 },
      ),
    );
  }

  return { bytes: output, warnings };
}

export async function writeAsciiStl(
  mesh: CanonicalMesh,
  context: FormatWriteContext,
): Promise<MeshWriteResult> {
  const budget = context.budget;
  const triangles = triangleCount(mesh);

  // SELF-ROUND-TRIP POLICY.
  //
  // ASCII STL runs about 5x the size of the same model in binary, so a model
  // near the top of the supported range produces an ASCII file this application
  // would then refuse to open. Emitting output that violates our own import
  // contract is a trap: the user only finds out when they try to load it back.
  //
  // The estimate is therefore compared against the RE-IMPORT budget rather than
  // the output budget, and it is a proven upper bound (see
  // MAX_ASCII_BYTES_PER_FACET) — under-estimating here would let through
  // precisely the file the policy exists to prevent.
  const groupCount = mesh.groups?.length ?? 0;
  const estimatedBytes = estimateAsciiStlBytes(triangles, groupCount);
  const reimportLimit = Math.min(budget.maxInputBytes, budget.maxOutputBytes);
  if (estimatedBytes > reimportLimit) {
    throw resourceLimitExceeded(
      'This model is too large to export as ASCII STL. Export it as binary STL instead — the same geometry, about a fifth of the size.',
      {
        operation: 'stl/export/ascii',
        requested: estimatedBytes,
        limit: reimportLimit,
        triangleCount: triangles,
        recommendedEncoding: 'binary',
      },
    );
  }

  // Encoded incrementally rather than by building one enormous string and
  // joining it. A ten-million-triangle ASCII export is well over a gigabyte of
  // text; holding it as UTF-16 string fragments AND a joined string AND the
  // encoded bytes would triple peak memory at the worst moment.
  const byteChunks: Uint8Array[] = [];
  let totalBytes = 0;
  let pending = '';

  const flush = (): void => {
    if (pending.length === 0) return;
    const encoded = encodeAscii(pending);
    byteChunks.push(encoded);
    totalBytes += encoded.byteLength;
    pending = '';
  };

  // GROUP PRESERVATION. A file that arrived as several `solid` blocks is written
  // back as several `solid` blocks, so the structure survives the round trip
  // instead of being silently flattened into one.
  //
  // Names are GENERATED, never copied from the source. A solid name is
  // user-controlled text that routinely carries a filesystem path or a project
  // name, and writing it into an exported file would leak it to whoever that
  // file is shared with.
  const groups = mesh.groups ?? [];
  const solids =
    groups.length > 0
      ? groups.map((group, index) => ({
          name: `${ASCII_SOLID_NAME}_solid_${String(index + 1).padStart(4, '0')}`,
          firstTriangle: Math.floor(group.indexOffset / 3),
          triangleCount: Math.floor(group.indexCount / 3),
        }))
      : [{ name: ASCII_SOLID_NAME, firstTriangle: 0, triangleCount: triangles }];

  const normal = new Float64Array(3);
  let written = 0;

  for (const solid of solids) {
    pending += `solid ${solid.name}\n`;
    const lastTriangle = solid.firstTriangle + solid.triangleCount;

    for (let triangle = solid.firstTriangle; triangle < lastTriangle; triangle += 1) {
      if (written % TRIANGLES_PER_BATCH === 0) {
        throwIfCancelled(context.cancellation);
        context.progress.report(triangles === 0 ? 1 : written / triangles, 'writing');
        flush();
        await context.yieldToEventLoop();
        throwIfCancelled(context.cancellation);
      }
      written += 1;

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

    pending += `endsolid ${solid.name}\n`;
  }

  flush();

  throwIfCancelled(context.cancellation);
  context.progress.report(1, 'writing');

  // The estimate above is a proven upper bound, so this cannot fire in normal
  // operation. It is kept as an assertion rather than deleted because the
  // failure it guards — output that silently exceeds the limit it was checked
  // against — is exactly what the policy exists to prevent. If the formatting
  // ever changes without MAX_ASCII_BYTES_PER_FACET changing with it, this stops
  // the file before it reaches the user instead of after.
  if (totalBytes > estimatedBytes) {
    throw internalError('ASCII STL output exceeded its own conservative size estimate.', {
      details: { produced: totalBytes, estimated: estimatedBytes, triangleCount: triangles },
    });
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of byteChunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const warnings: Diagnostic[] = [];
  if (solids.length > 1) {
    warnings.push(
      diagnostic(
        StlWarningCode.GroupsRenamed,
        `Exported ${String(solids.length)} solids with generated names. Original solid names are not written into exported files.`,
        { solidCount: solids.length },
      ),
    );
  }

  return { bytes: output, warnings };
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
