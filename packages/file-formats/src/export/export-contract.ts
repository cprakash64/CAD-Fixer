import {
  applyPartTransform,
  createIndexArray,
  createPositionArray,
  DEFAULT_DOCUMENT_LIMITS,
  distinctMeshes,
  IDENTITY_PART_TRANSFORM,
  partId,
  type CanonicalMesh,
  type GeometryDocument,
  type MeshGroup,
  type PartTransform,
} from '@cadfixer/mesh-core';
import type { CancellationToken } from '@cadfixer/shared';
import { MeshFormatId } from '../formats';
import { normaliseObjName } from './obj-name';

/**
 * WHAT A WRITER IS GIVEN, AND WHAT IT PROMISES BACK.
 *
 * The authoritative `GeometryDocument` never leaves the geometry worker, so a
 * writer is handed a SNAPSHOT: the same numbers, in a form that can cross a
 * `postMessage` boundary and be thrown away afterwards. The snapshot is
 * deliberately not a `GeometryDocument` — a writer that could name one would be
 * one refactor away from being given the real one.
 *
 * THE SHARING IS THE POINT. A document with a thousand placements of one mesh
 * holds ONE mesh; its snapshot holds one mesh resource and a thousand
 * placements. Copying per placement would make the snapshot a thousand times
 * larger than the document it describes, before a single byte was serialised.
 */

/** One distinct mesh, copied once however many parts point at it. */
export interface ExportMeshResource {
  /** Interleaved XYZ, canonical Float32. A COPY: the authoritative array is not transferred. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly groups?: readonly MeshGroup[];
}

/** One placement. Scalars and twelve numbers — never geometry. */
export interface ExportPartSnapshot {
  readonly partId: string;
  /** Index into `ExportDocumentSnapshot.meshes`. Equal indices mean one mesh. */
  readonly meshResourceIndex: number;
  readonly transform: PartTransform;
  readonly name?: string;
  readonly materialRef?: string;
}

export interface ExportDocumentSnapshot {
  readonly documentId: string;
  /**
   * The revision this snapshot describes.
   *
   * Carried so a result can be rejected when the document has moved on. A
   * writer never checks it; the controller does, and it has to be IN the
   * snapshot rather than beside it so the two cannot be paired wrongly.
   */
  readonly revision: number;
  /**
   * The unit this export is written under. NOT necessarily the document's.
   *
   * A document that states a unit supplies it, and nothing can override that. A
   * document that states NONE may have one supplied for this export by the
   * user — see `unitAsserted` — because 3MF has to declare a unit and CAD Fixer
   * will not choose one on someone's behalf.
   *
   * EXPORT-LOCAL EITHER WAY. This field lives on a disposable snapshot; the
   * authoritative `GeometryDocument.unit` is untouched and its revision does not
   * move. Nothing is rescaled: a unit says what the numbers mean, never what
   * they are.
   */
  readonly unit: string | undefined;
  /**
   * True when `unit` came from the USER rather than from the document.
   *
   * Carried so a writer can record `UNIT_ASSERTED_BY_USER` and the workflow can
   * say, truthfully, that the file states something the model did not.
   */
  readonly unitAsserted: boolean;
  readonly meshes: readonly ExportMeshResource[];
  readonly parts: readonly ExportPartSnapshot[];
}

/* --------------------------------------------------------------- limits -- */

export interface ExportLimits {
  /** The finished artifact handed back to the page. */
  readonly maxOutputBytes: number;
  /**
   * Serialised text before compression, for formats that compress.
   *
   * Separate because a 3MF's archive can be an order of magnitude smaller than
   * the XML inside it, and it is the XML that has to be held.
   */
  readonly maxSerialisedBytes: number;
}

/**
 * WHERE THESE NUMBERS COME FROM, and they are derived rather than chosen.
 *
 * `maxSerialisedBytes` is `DEFAULT_ZIP_LIMITS.maxTotalUncompressedBytes` and
 * `DEFAULT_OBJ_LIMITS.maxBytes` — both 512 MiB. An export that our own reader
 * would refuse to open is not an export: parse-back validation runs the
 * production reader over the bytes, so anything past the reader's intake
 * ceiling could never be validated and must not be produced.
 *
 * `maxOutputBytes` is half of that. During a validated export the artifact, the
 * snapshot and the parsed-back document are all live at once — for OBJ that is
 * roughly 190 bytes of text, 48 bytes of snapshot and 48 bytes of parsed
 * geometry per triangle — so the artifact is given half the intake ceiling and
 * the rest is headroom for the two documents beside it. 256 MiB of OBJ is
 * around 1.4 million triangles, which is a large but genuine print file.
 *
 * These are MVP values derived from current evidence, stated so they can be
 * argued with. They are NOT a claim about what a browser tab can survive.
 */
export const DEFAULT_EXPORT_LIMITS: ExportLimits = Object.freeze({
  maxOutputBytes: 256 * 1024 * 1024,
  maxSerialisedBytes: 512 * 1024 * 1024,
});

/* --------------------------------------------------------------- context -- */

export interface ExportProgressReporter {
  report(fraction: number, note?: string): void;
}

export interface FormatWriteDocumentContext {
  readonly cancellation: CancellationToken;
  readonly progress: ExportProgressReporter;
  readonly limits: ExportLimits;
  /** See `FormatReadContext.yieldToEventLoop`. Serialisation loops must yield. */
  readonly yieldToEventLoop: () => Promise<void>;
  /** UTF-8. Injected for the same reason `decodeText` is. */
  readonly encodeText: (text: string) => Uint8Array;
  /** Raw DEFLATE, chunked. Only the 3MF writer needs one. */
  readonly deflateRaw?: (bytes: Uint8Array) => AsyncIterable<Uint8Array>;
}

/* ------------------------------------------------- feature observations -- */

/**
 * MACHINE-READABLE FACTS ABOUT WHAT A WRITER DID, not sentences about it.
 *
 * Stage 4A-2B3 turns these into a compatibility report a user reads before
 * deciding. Deciding the wording here would put the same copy in two places and
 * guarantee they drift, which is the mistake `repair-presentation.ts` exists to
 * prevent. So this stage records the facts and says nothing about them.
 */
export const ExportObservation = {
  /** Placements were applied to coordinates because the target cannot express them. */
  TransformsBaked: 'TRANSFORMS_BAKED',
  /** The source stated a unit and the target has nowhere to put it. */
  UnitOmitted: 'UNIT_OMITTED',
  /** The source's unit token was written into the file unchanged. */
  UnitPreserved: 'UNIT_PRESERVED',
  /** Two parts sharing one mesh became two copies of its geometry. */
  SharingFlattened: 'STRUCTURAL_SHARING_FLATTENED',
  /** Two parts sharing one mesh reference one serialised resource. */
  SharingPreserved: 'STRUCTURAL_SHARING_PRESERVED',
  /**
   * Parts sharing one mesh were written as separate objects because their
   * NAMES differ.
   *
   * 3MF puts the name on the `<object>`, not on the `<item>` that places it —
   * so two placements of one mesh under two different names are, in 3MF's own
   * model, two objects. Sharing survives whenever the sharing parts agree;
   * where they do not, the name is kept and the geometry is written twice,
   * because dropping a name the user gave is the larger loss.
   *
   * A DIFFERING MATERIAL REFERENCE NO LONGER SPLITS ANYTHING. The writer emits
   * no `pid`, so the distinction reaches the file nowhere and duplicating
   * geometry for it would cost megabytes to preserve nothing.
   */
  SharingSplitByMetadata: 'STRUCTURAL_SHARING_SPLIT_BY_METADATA',
  /** Placements were written as placements, not baked. */
  TransformsPreserved: 'TRANSFORMS_PRESERVED',
  /** Normals were not written. CAD Fixer recomputes them and stores none it trusts. */
  NormalsOmitted: 'NORMALS_OMITTED',
  /** Texture coordinates were not written. */
  TextureCoordinatesOmitted: 'TEXTURE_COORDINATES_OMITTED',
  /** Part names survived into the file. */
  NamesPreserved: 'NAMES_PRESERVED',
  /**
   * A part with no name was given a generated one.
   *
   * OBJ separates objects with an `o` record, and `o` takes a name. A bare `o`
   * would preserve "this part had no name" and produce a record most other
   * tools have never seen; omitting the record entirely would merge the part
   * into its neighbour, which loses far more. So an unnamed part is written as
   * `o part-N` — a name the document did not contain, which is a fact worth
   * recording rather than hiding.
   */
  NamesGenerated: 'NAMES_GENERATED',
  /** Material references survived as opaque strings. No material was defined. */
  MaterialReferencesPreserved: 'MATERIAL_REFERENCES_PRESERVED',
  /** No material library was written, so `usemtl` names resolve to nothing. */
  MaterialLibraryOmitted: 'MATERIAL_LIBRARY_OMITTED',
  /**
   * A PART carried a material reference and the target has nowhere to put it.
   *
   * OBJ's `usemtl` applies to a run of faces, which is what a `MeshGroup` is —
   * there is no per-object material record. A document whose PART names a
   * material therefore loses it, and losing it silently is exactly the kind of
   * omission this list exists to prevent.
   */
  MaterialReferencesOmitted: 'MATERIAL_REFERENCES_OMITTED',
  /** The imported nested component graph is not reconstructed; parts are flat. */
  ComponentHierarchyNotReconstructed: 'COMPONENT_HIERARCHY_NOT_RECONSTRUCTED',

  /* ----------------------------------------------- whole-document STL -- */
  /**
   * Every part became one triangle stream, because STL has one implicit object.
   *
   * DISTINCT FROM `STRUCTURAL_SHARING_FLATTENED`. Sharing being flattened is
   * about geometry being written more than once; this is about the boundary
   * between parts ceasing to exist at all. A two-part document with no shared
   * mesh loses its structure without duplicating a single vertex.
   */
  PartStructureFlattened: 'PART_STRUCTURE_FLATTENED',
  /** Part names were not written, because the target has nowhere to put one. */
  NamesDropped: 'NAMES_DROPPED',
  /** Canonical groups were not written. */
  GroupsDropped: 'GROUPS_DROPPED',

  /* ------------------------------------------------------ the unit -- */
  /**
   * The document stated no unit and the USER stated one for this export.
   *
   * Recorded because it is the one fact in this list that did not come from the
   * document: someone asserted what the numbers mean. The authoritative
   * document is unchanged and still states nothing — see ADR 0017.
   */
  UnitAssertedByUser: 'UNIT_ASSERTED_BY_USER',
} as const;

export type ExportObservation = (typeof ExportObservation)[keyof typeof ExportObservation];

/* ------------------------------------------------------------- results -- */

export const ExportStatus = {
  Success: 'SUCCESS',
  /** 3MF needs a unit and the document states none. Never defaulted. */
  BlockedUnitRequired: 'BLOCKED_UNIT_REQUIRED',
  ResourceLimit: 'RESOURCE_LIMIT',
  Cancelled: 'CANCELLED',
  /** The bytes did not read back as the document they were written from. */
  ValidationFailed: 'VALIDATION_FAILED',
  InternalFailure: 'INTERNAL_FAILURE',
  /** The document moved while the export was running. */
  StaleRevision: 'STALE_REVISION',
} as const;

export type ExportStatus = (typeof ExportStatus)[keyof typeof ExportStatus];

/** Scalars only. Never geometry, never a filename, never prose. */
export interface ExportMetadata {
  readonly formatId: MeshFormatId;
  readonly outputBytes: number;
  readonly triangleCount: number;
  readonly partCount: number;
  readonly meshResourceCount: number;
  readonly observations: readonly ExportObservation[];
}

export interface WrittenDocument {
  readonly bytes: Uint8Array;
  readonly metadata: ExportMetadata;
}

/* ------------------------------------------- snapshots from a document -- */

/**
 * Builds the snapshot for a document, copying each DISTINCT mesh once.
 *
 * The copy is deliberate and is the same decision `model/send-for-diagnostic`
 * made: transferring the authoritative arrays would detach them, leaving the
 * worker holding empty buffers and making a terminated export worker take the
 * user's model with it.
 */
export interface ExportSnapshotOptions {
  /**
   * What the user says this document's numbers mean, for THIS export only.
   *
   * IGNORED when the document already states a unit. A document's own
   * assertion is evidence that came from a file; a conversion-time choice is
   * evidence that came from a person about a document that stated nothing, and
   * letting the second overwrite the first would silently relabel a known
   * model. Fail-safe in the direction that matters: the worst an out-of-date
   * page can do is offer a choice that is then not used.
   */
  readonly unitAssertion?: string;
}

export function exportSnapshotOf(
  document: GeometryDocument,
  documentId: string,
  revision: number,
  options: ExportSnapshotOptions = {},
): ExportDocumentSnapshot {
  const distinct = distinctMeshes(document);
  const indexOf = new Map<CanonicalMesh, number>();
  for (const [index, mesh] of distinct.entries()) indexOf.set(mesh, index);

  const meshes: ExportMeshResource[] = distinct.map((mesh) => ({
    positions: new Float32Array(mesh.positions),
    indices: new Uint32Array(mesh.indices),
    ...(mesh.groups === undefined ? {} : { groups: mesh.groups.map((group) => ({ ...group })) }),
  }));

  const parts: ExportPartSnapshot[] = document.parts.map((part) => ({
    partId: part.id,
    meshResourceIndex: indexOf.get(part.mesh) ?? 0,
    transform: part.transform,
    ...(part.name === undefined ? {} : { name: part.name }),
    ...(part.materialRef === undefined ? {} : { materialRef: part.materialRef }),
  }));

  const asserted = document.unit === undefined ? options.unitAssertion : undefined;

  return {
    documentId,
    revision,
    unit: document.unit ?? asserted,
    unitAsserted: asserted !== undefined,
    meshes,
    parts,
  };
}

/** Every `ArrayBuffer` in a snapshot, for `postMessage`'s transfer list. */
export function snapshotTransferables(snapshot: ExportDocumentSnapshot): ArrayBufferLike[] {
  const buffers: ArrayBufferLike[] = [];
  for (const mesh of snapshot.meshes) {
    buffers.push(mesh.positions.buffer, mesh.indices.buffer);
  }
  return buffers;
}

export function snapshotTriangleCount(snapshot: ExportDocumentSnapshot): number {
  let total = 0;
  for (const part of snapshot.parts) {
    total += (snapshot.meshes[part.meshResourceIndex]?.indices.length ?? 0) / 3;
  }
  return total;
}

/* ------------------------------------------- OBJ round-trip normalisation -- */

/**
 * WHAT AN OBJ NAME BECOMES, decided ONCE.
 *
 * A name travels through three transformations on its way out and back, and
 * every one of them is lossy in a small way:
 *
 *   1. THE WRITER strips control characters. A newline inside a name would end
 *      the `o` record and turn the rest of the name into geometry records — the
 *      file would contain triangles the document never had. This is not
 *      escaping, because OBJ has no escape: the character cannot be written at
 *      all.
 *   2. OBJ ITSELF has no way to distinguish runs of whitespace, so a reader
 *      splitting on whitespace collapses them.
 *   3. THE READER truncates at the document's name ceiling.
 *
 * Both the writer and the expected round-trip go through here, so the two
 * cannot disagree about what a name survives as — and a test asserting on the
 * result is asserting on one definition rather than on a coincidence.
 */
export function objRoundTripName(
  name: string,
  maxLength = DEFAULT_DOCUMENT_LIMITS.maxNameLength,
): string {
  /*
   * THE CHARACTER RULES LIVE IN `obj-name.ts`, a leaf module with no imports.
   *
   * The conversion policy runs on the MAIN THREAD and has to be able to ask
   * "would writing this name change it?" so the user can be told before they
   * export. Asking it here would pull this module — and the document layer it
   * imports — along with the answer.
   */
  return normaliseObjName(name).slice(0, maxLength);
}

const IDENTITY = IDENTITY_PART_TRANSFORM;

function isIdentityTransform(transform: PartTransform): boolean {
  for (let index = 0; index < 12; index += 1) {
    if (transform[index] !== IDENTITY[index]) return false;
  }
  return true;
}

/**
 * WHAT AN OBJ EXPORT IS EXPECTED TO READ BACK AS.
 *
 * OBJ has no structural transform, so a placement can only survive by being
 * applied to the coordinates. That means the parsed-back document is NOT the
 * source document, and asserting local-coordinate equality would be asserting
 * something false. This states the transformation precisely instead:
 *
 *   - every placement is baked into world coordinates, then narrowed to Float32
 *     exactly as the reader will narrow the decimal text it is given;
 *   - every part's transform comes back as the identity;
 *   - the unit is unknown, because OBJ states none — even when the source did;
 *   - names survive, groups and material references survive;
 *   - parts keep document order, and a part's own vertex pool is renumbered by
 *     the reader, which is why the comparison is on VALUES rather than indices.
 *
 * The Float32 narrowing here is the same single assignment the reader performs,
 * so this is a statement about the pipeline rather than an approximation of it.
 */
export function expectedObjRoundTrip(snapshot: ExportDocumentSnapshot): GeometryDocument {
  const parts = snapshot.parts.map((part, index) => {
    const mesh = snapshot.meshes[part.meshResourceIndex];
    const positions = mesh?.positions ?? new Float32Array(0);
    const indices = mesh?.indices ?? new Uint32Array(0);

    const baked = createPositionArray(positions.length);
    const identity = isIdentityTransform(part.transform);
    for (let at = 0; at < positions.length; at += 3) {
      const x = positions[at] ?? 0;
      const y = positions[at + 1] ?? 0;
      const z = positions[at + 2] ?? 0;
      if (identity) {
        baked[at] = x;
        baked[at + 1] = y;
        baked[at + 2] = z;
        continue;
      }
      // Float64 arithmetic, then ONE narrowing on assignment — the same and
      // only conversion the writer's decimal text and the reader's `Number`
      // will perform.
      const [wx, wy, wz] = applyPartTransform(part.transform, x, y, z);
      baked[at] = wx;
      baked[at + 1] = wy;
      baked[at + 2] = wz;
    }

    const copiedIndices = createIndexArray(indices.length);
    for (let at = 0; at < indices.length; at += 1) copiedIndices[at] = indices[at] ?? 0;

    return {
      id: partId(`part-${String(index + 1)}`),
      mesh: {
        positions: baked,
        indices: copiedIndices,
        /*
         * A GROUP WITH NO NAME COMES BACK NAMED AFTER ITS MATERIAL. The writer
         * emits `usemtl` for the material and `g` only for a non-empty name, so
         * an unnamed run has just the `usemtl` record — and a reader names that
         * run after the material, because that is the only name it has.
         */
        ...(mesh?.groups === undefined || mesh.groups.length === 0
          ? {}
          : {
              groups: mesh.groups.map((group) => ({
                ...group,
                name:
                  objRoundTripName(group.name).length > 0
                    ? objRoundTripName(group.name)
                    : objRoundTripName(group.materialRef ?? ''),
                ...(group.materialRef === undefined
                  ? {}
                  : { materialRef: objRoundTripName(group.materialRef) }),
              })),
            }),
        metadata: { sourceFormat: MeshFormatId.Obj },
      } satisfies CanonicalMesh,
      transform: IDENTITY_PART_TRANSFORM,
      /*
       * A GENERATED NAME IS STILL A NAME. The writer gives an unnamed part
       * `o part-N` so it does not merge into its neighbour, so that is what
       * comes back — and the expectation says so rather than leaving the
       * validator to discover a difference it would report as a bug.
       */
      name:
        part.name === undefined || objRoundTripName(part.name).length === 0
          ? `part-${String(index + 1)}`
          : objRoundTripName(part.name),
    };
  });

  // OBJ STATES NO UNIT, so the expectation states none either. Rescaling to
  // hide the loss would change the numbers to preserve a label.
  return { parts };
}

/* ---------------------------------------- STL round-trip normalisation -- */

/**
 * WHAT A WHOLE-DOCUMENT STL EXPORT IS EXPECTED TO READ BACK AS.
 *
 * STL is the most lossy of the three targets and this states the loss exactly
 * rather than approximating it:
 *
 *   - ONE PART. Every part's triangles are concatenated in document order into
 *     a single soup, because the format has one implicit object.
 *   - EVERY PLACEMENT BAKED, in Float64 and narrowed once by `Math.fround` —
 *     the same single narrowing `DataView.setFloat32` performs, so the
 *     prediction is bit-exact rather than nearly right.
 *   - NO UNIT, even when the document stated one and even when the user
 *     asserted one. STL has no field to put it in.
 *   - NO NAME, NO GROUPS, NO MATERIAL REFERENCE, NO SHARING.
 *   - VERTICES NOT SHARED. A binary STL stores three vertices per facet and our
 *     reader preserves exactly that, so the expected mesh is non-indexed too.
 *
 * The comparison this feeds is on triangle CORNERS, so the fact that a reader
 * numbers vertices its own way never enters into it.
 */
export function expectedStlRoundTrip(snapshot: ExportDocumentSnapshot): GeometryDocument {
  let totalCorners = 0;
  for (const part of snapshot.parts) {
    totalCorners += snapshot.meshes[part.meshResourceIndex]?.indices.length ?? 0;
  }

  const positions = createPositionArray(totalCorners * 3);
  const indices = createIndexArray(totalCorners);
  let at = 0;

  for (const part of snapshot.parts) {
    const mesh = snapshot.meshes[part.meshResourceIndex];
    if (mesh === undefined) continue;
    const identity = isIdentityTransform(part.transform);

    for (const index of mesh.indices) {
      const vertex = index * 3;
      const x = mesh.positions[vertex] ?? 0;
      const y = mesh.positions[vertex + 1] ?? 0;
      const z = mesh.positions[vertex + 2] ?? 0;
      if (identity) {
        positions[at * 3] = x;
        positions[at * 3 + 1] = y;
        positions[at * 3 + 2] = z;
      } else {
        const [wx, wy, wz] = applyPartTransform(part.transform, x, y, z);
        positions[at * 3] = wx;
        positions[at * 3 + 1] = wy;
        positions[at * 3 + 2] = wz;
      }
      indices[at] = at;
      at += 1;
    }
  }

  return {
    parts: [
      {
        id: partId('part-1'),
        mesh: { positions, indices, metadata: { sourceFormat: MeshFormatId.Stl } },
        transform: IDENTITY_PART_TRANSFORM,
      },
    ],
  };
}

/* --------------------------------------------- 3MF object planning -- */

/** One `<object>` in the written model, and the parts that place it. */
export interface ThreeMfObjectPlan {
  readonly meshResourceIndex: number;
  readonly name: string | undefined;
  /** Indices into `snapshot.parts`, in document order. */
  readonly partIndices: readonly number[];
}

/**
 * DECIDES WHICH PARTS CAN SHARE ONE `<object>`, in one place.
 *
 * The writer serialises this and the validator predicts from it, so the
 * expected number of distinct meshes after a round trip is derived from the
 * same rule that produced them rather than restated beside it.
 *
 * THE KEY IS (MESH, NAME) — and, since the property-reference fix, NOT the
 * material reference.
 *
 * It used to include one. That was correct while the writer emitted
 * `object@pid`: two placements of one mesh under two different material
 * references were two objects in 3MF's own model, so keeping both meant writing
 * the geometry twice. The writer no longer emits `pid` at all — it has no
 * property resource to point at — so splitting on a value that reaches the file
 * NOWHERE would duplicate megabytes of geometry to preserve a distinction the
 * output cannot express.
 *
 * The rule is now exactly: the key contains what the `<object>` element will
 * actually carry. A thousand unnamed placements of one mesh are one object;
 * two placements under two NAMES are two, because a name is written.
 */
export function planThreeMfObjects(snapshot: ExportDocumentSnapshot): readonly ThreeMfObjectPlan[] {
  const byKey = new Map<string, { plan: ThreeMfObjectPlan; parts: number[] }>();
  const order: string[] = [];

  for (const [index, part] of snapshot.parts.entries()) {
    const key = `${String(part.meshResourceIndex)}\u0000${part.name ?? ''}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      const parts: number[] = [index];
      byKey.set(key, {
        plan: {
          meshResourceIndex: part.meshResourceIndex,
          name: part.name,
          partIndices: parts,
        },
        parts,
      });
      order.push(key);
      continue;
    }
    existing.parts.push(index);
  }

  return order.map((key) => byKey.get(key)?.plan).filter((plan) => plan !== undefined);
}
