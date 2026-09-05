import {
  applyPartTransform,
  IDENTITY_PART_TRANSFORM,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { throwIfCancelled } from '@cadfixer/shared';
import { MeshFormatId } from '../formats';
import { createByteSink } from './byte-sink';
import {
  ExportObservation,
  objRoundTripName,
  snapshotTriangleCount,
  type ExportDocumentSnapshot,
  type FormatWriteDocumentContext,
  type WrittenDocument,
} from './export-contract';
import { ExportRefusal, exportBlocked, exportTooLarge } from './export-errors';
import { writeFloat32Text } from './numeric';

/**
 * THE PRODUCTION OBJ WRITER.
 *
 * It serialises a WHOLE document. `o` per part, `g` per canonical group,
 * `usemtl` per material reference, `f` per triangle, in document order.
 *
 * WHAT OBJ CANNOT CARRY, and is therefore not pretended:
 *
 *   - A STRUCTURAL TRANSFORM. There is no `<item transform>` equivalent, so a
 *     placement survives only by being applied to the coordinates. Every part
 *     is baked, and the result reads back with identity transforms. Writing the
 *     local coordinates and quietly dropping the placement would move the
 *     user's geometry without saying so.
 *   - A UNIT. Nothing in an OBJ states one, so a document with a known unit
 *     loses it. The coordinates are NOT rescaled to compensate: changing the
 *     numbers to preserve a label the file cannot hold would be inventing data.
 *   - STRUCTURAL SHARING. A thousand placements of one mesh become a thousand
 *     copies of its vertices, because OBJ has no instancing. That is a real
 *     cost and it is what the output budget bounds.
 *   - MATERIAL DEFINITIONS. `usemtl` names are written as the opaque strings
 *     they are; no `mtllib` is emitted, because naming a file we do not write
 *     would point the reader at something that does not exist.
 *   - NORMALS AND TEXTURE COORDINATES. See `ExportObservation`.
 */

/** Yield every this many triangles. Matches the reader's batch. */
const TRIANGLES_PER_BATCH = 32_768;

function isIdentity(transform: PartTransform): boolean {
  for (let index = 0; index < 12; index += 1) {
    if (transform[index] !== IDENTITY_PART_TRANSFORM[index]) return false;
  }
  return true;
}

/** The groups that fall inside one mesh, keyed by their first face. */
function groupStarts(
  groups: readonly { name: string; indexOffset: number; materialRef?: string }[] | undefined,
): Map<number, { name: string; materialRef?: string }> {
  const starts = new Map<number, { name: string; materialRef?: string }>();
  if (groups === undefined) return starts;
  for (const group of groups) {
    // A later group starting at the same face replaces an earlier one: the last
    // declaration before a face is the one OBJ considers active.
    starts.set(group.indexOffset / 3, {
      name: group.name,
      ...(group.materialRef === undefined ? {} : { materialRef: group.materialRef }),
    });
  }
  return starts;
}

export async function writeObjDocument(
  snapshot: ExportDocumentSnapshot,
  context: FormatWriteDocumentContext,
): Promise<WrittenDocument> {
  if (snapshot.parts.length === 0) {
    throw exportBlocked(
      ExportRefusal.NoParts,
      'This document has no parts, so there is nothing to write.',
    );
  }

  const totalTriangles = snapshotTriangleCount(snapshot);
  /*
   * A PREFLIGHT, AND ONLY A PREFLIGHT.
   *
   * A triangle costs at least three vertex lines and one face line, and even
   * the shortest possible spelling of those — single-digit coordinates and
   * indices — is about thirty bytes. That makes this a genuine LOWER bound, so
   * an obvious impossibility is refused before anything is built. It is not a
   * prediction: the real length depends on how long each number's decimal
   * spelling turns out to be, and the running count in the sink stays
   * authoritative.
   */
  const floorBytes = totalTriangles * 30;
  if (floorBytes > context.limits.maxOutputBytes) {
    throw exportTooLarge(
      ExportRefusal.OutputTooLarge,
      'This document is too large to write as an OBJ file.',
      { triangles: totalTriangles, atLeast: floorBytes, limit: context.limits.maxOutputBytes },
    );
  }

  const sink = createByteSink(
    context.encodeText,
    context.limits.maxOutputBytes,
    ExportRefusal.OutputTooLarge,
  );

  /*
   * A FIXED HEADER. It contains no document string and never will: a newline
   * inside a comment ends it, and the next characters become records — so
   * anything user-supplied that reached a comment could write geometry into the
   * file. Every string that DOES come from the document goes through
   * `objRoundTripName`, which strips exactly that.
   */
  sink.write('# Written by CAD Fixer. Geometry only: no materials, no textures.\n');

  let anyBaked = false;
  let anyGroups = false;
  let anyMaterial = false;
  let anyName = false;
  let anyGeneratedName = false;
  let sharedFlattened = false;
  let partMaterialDropped = false;
  const seenMesh = new Set<number>();

  /*
   * OBJ VERTEX INDICES ARE FILE-GLOBAL AND ONE-BASED, and they only ever
   * increase. Negative relative indices are legal and our reader accepts them;
   * they are not used, because a file whose meaning depends on where the reader
   * currently is has no benefit here and one more way to be wrong.
   */
  let vertexBase = 1;
  let written = 0;

  for (const [partIndex, part] of snapshot.parts.entries()) {
    const mesh = snapshot.meshes[part.meshResourceIndex];
    if (mesh === undefined) {
      throw exportBlocked(
        ExportRefusal.MissingMeshResource,
        'A part in this document refers to geometry that is not present.',
        { partIndex },
      );
    }
    if (seenMesh.has(part.meshResourceIndex)) sharedFlattened = true;
    seenMesh.add(part.meshResourceIndex);
    /*
     * A PART-LEVEL MATERIAL REFERENCE HAS NOWHERE TO GO. OBJ's `usemtl` applies
     * to a run of faces — a `MeshGroup` — and there is no per-object material
     * record. Recorded rather than dropped in silence.
     */
    if (part.materialRef !== undefined) partMaterialDropped = true;

    const name = part.name === undefined ? '' : objRoundTripName(part.name);
    if (name.length > 0) anyName = true;
    else anyGeneratedName = true;
    // A part with no usable name still gets an `o`: without one, two parts'
    // faces would merge into a single object on the way back in.
    sink.write(`o ${name.length > 0 ? name : `part-${String(partIndex + 1)}`}\n`);

    const identity = isIdentity(part.transform);
    if (!identity) anyBaked = true;

    const { positions, indices } = mesh;
    for (let at = 0; at < positions.length; at += 3) {
      const x = positions[at] ?? 0;
      const y = positions[at + 1] ?? 0;
      const z = positions[at + 2] ?? 0;

      if (identity) {
        sink.write(`v ${writeFloat32Text(x)} ${writeFloat32Text(y)} ${writeFloat32Text(z)}\n`);
        continue;
      }

      /*
       * BAKED IN FLOAT64, THEN NARROWED ONCE.
       *
       * `applyPartTransform` works in Float64 because the placement is Float64;
       * `Math.fround` is then the SAME single narrowing that assigning to a
       * Float32Array performs, which is what the reader will do to the decimal
       * text below. Emitting nine significant digits of the already-narrowed
       * value is what makes the round trip bit-exact rather than approximately
       * right.
       *
       * Nothing here touches the snapshot's arrays: baking is a property of the
       * OUTPUT, and the authoritative mesh is not even in this worker.
       */
      const [wx, wy, wz] = applyPartTransform(part.transform, x, y, z);
      sink.write(
        `v ${writeFloat32Text(Math.fround(wx))} ${writeFloat32Text(Math.fround(wy))} ${writeFloat32Text(Math.fround(wz))}\n`,
      );
    }

    const starts = groupStarts(mesh.groups);
    let activeMaterial: string | undefined;

    for (let at = 0; at < indices.length; at += 3) {
      const face = at / 3;
      const group = starts.get(face);
      if (group !== undefined) {
        /*
         * `usemtl` FIRST, THEN `g`, and the order is load-bearing.
         *
         * OBJ treats them as two different axes: `usemtl` sets the material in
         * force, `g` names the run of faces. Our `MeshGroup` flattens both into
         * one record, so on the way back in a reader sees two run-starts at the
         * same face and keeps the LAST. Writing `g` first would therefore make
         * the material's name the surviving group name and lose the real one.
         */
        if (group.materialRef !== undefined && group.materialRef !== activeMaterial) {
          activeMaterial = group.materialRef;
          sink.write(`usemtl ${objRoundTripName(group.materialRef)}\n`);
          anyMaterial = true;
        }
        const groupName = objRoundTripName(group.name);
        if (groupName.length > 0) {
          sink.write(`g ${groupName}\n`);
          anyGroups = true;
        }
      }

      const a = vertexBase + (indices[at] ?? 0);
      const b = vertexBase + (indices[at + 1] ?? 0);
      const c = vertexBase + (indices[at + 2] ?? 0);
      sink.write(`f ${String(a)} ${String(b)} ${String(c)}\n`);

      written += 1;
      if (written % TRIANGLES_PER_BATCH === 0) {
        throwIfCancelled(context.cancellation);
        await context.yieldToEventLoop();
        throwIfCancelled(context.cancellation);
        context.progress.report(totalTriangles === 0 ? 1 : written / totalTriangles, 'writing');
      }
    }

    vertexBase += positions.length / 3;
    throwIfCancelled(context.cancellation);
  }

  const bytes = sink.finish();

  const observations: ExportObservation[] = [
    ExportObservation.NormalsOmitted,
    ExportObservation.TextureCoordinatesOmitted,
  ];
  if (anyBaked) observations.push(ExportObservation.TransformsBaked);
  if (snapshot.unit !== undefined) observations.push(ExportObservation.UnitOmitted);
  if (sharedFlattened) observations.push(ExportObservation.SharingFlattened);
  if (anyName) observations.push(ExportObservation.NamesPreserved);
  if (anyGeneratedName) observations.push(ExportObservation.NamesGenerated);
  if (anyGroups || anyMaterial) {
    observations.push(ExportObservation.MaterialLibraryOmitted);
  }
  if (anyMaterial) observations.push(ExportObservation.MaterialReferencesPreserved);
  if (partMaterialDropped) observations.push(ExportObservation.MaterialReferencesOmitted);

  return {
    bytes,
    metadata: {
      formatId: MeshFormatId.Obj,
      outputBytes: bytes.byteLength,
      triangleCount: totalTriangles,
      partCount: snapshot.parts.length,
      meshResourceCount: snapshot.meshes.length,
      observations,
    },
  };
}
