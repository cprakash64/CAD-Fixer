import {
  DoubleSide,
  Matrix3,
  Raycaster,
  Vector2,
  type Vector3,
  type Camera,
  type Mesh,
} from 'three';

/** A disposable render triangle, never a canonical-mesh reference. */
export interface PartPick {
  readonly partId: string;
  readonly triangleIndex: number;
  readonly point: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
}

/** Nearest visible hit, with stable part-id tie breaking for coincident instances. */
export function pickPartTriangle(
  camera: Camera,
  pointNdc: readonly [number, number],
  parts: ReadonlyMap<string, Mesh>,
): PartPick | undefined {
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(pointNdc[0], pointNdc[1]), camera);
  const hits: {
    partId: string;
    faceIndex: number;
    distance: number;
    point: Vector3;
    normal: Vector3;
  }[] = [];
  for (const [partId, mesh] of parts) {
    if (!mesh.visible) continue;
    mesh.updateWorldMatrix(true, false);
    // The viewport's material is DoubleSide; raycast honors that and can pick
    // both sides. The source face index survives the non-indexed render snapshot.
    for (const hit of raycaster.intersectObject(mesh, false)) {
      if (
        hit.faceIndex === undefined ||
        hit.faceIndex === null ||
        hit.face === undefined ||
        hit.face === null
      )
        continue;
      const normal = hit.face.normal
        .clone()
        .applyMatrix3(new Matrix3().getNormalMatrix(mesh.matrixWorld))
        .normalize();
      hits.push({
        partId,
        faceIndex: hit.faceIndex,
        distance: hit.distance,
        point: hit.point,
        normal,
      });
    }
  }
  hits.sort(
    (a, b) =>
      a.distance - b.distance || a.partId.localeCompare(b.partId) || a.faceIndex - b.faceIndex,
  );
  const hit = hits[0];
  if (hit === undefined) return undefined;
  return {
    partId: hit.partId,
    triangleIndex: hit.faceIndex,
    point: [hit.point.x, hit.point.y, hit.point.z],
    normal: [hit.normal.x, hit.normal.y, hit.normal.z],
  };
}

// Keep the supported face policy explicit so a future material change cannot
// silently turn back-face selection into a different feature.
export const PICK_FACE_SIDE = DoubleSide;
