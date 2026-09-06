import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
} from 'three';

/**
 * THE HOLE-FILL OVERLAYS: a selected rim, and a proposed patch.
 *
 * TWO OBJECTS, ONE OWNER. Both describe the ACTIVE PART and both are disposable
 * display copies of data the worker computed. They are grouped together because
 * they share a lifetime exactly: a rim without a selection is meaningless, and a
 * patch without the rim it closes has nothing to sit in.
 *
 * NEITHER IS GEOMETRY. Neither can be exported, analysed, committed or turned
 * back into a candidate — no operation in the protocol accepts a render buffer.
 * What Apply commits is named by a candidate handle, and the worker resolves
 * that handle against the mesh it has been holding all along.
 *
 * THE PATCH IS DRAWN BESIDE THE MODEL, NOT INSTEAD OF IT. The source part stays
 * exactly where it was, at full opacity, and the patch is added on top in its
 * own colour. Hiding the model to show the patch would answer a question nobody
 * asked — the point of the preview is to see how the patch meets the surface.
 *
 * COORDINATES ARE NEVER TOUCHED. Both buffers arrive in PART-LOCAL coordinates
 * and are uploaded exactly as the worker produced them; the part's placement and
 * the display-centring offset are carried by the group this is added to. That is
 * why a translated, rotated, scaled or reflected part gets a rim and a patch
 * that land on its surface without anyone rewriting a number.
 */

/** Amber, matching the boundary-edge diagnostic: the same thing, selected. */
const RIM_COLOR = new Color('#ffd24a');
/** Green, distinct from every diagnostic colour and from the grey surface. */
const PATCH_COLOR = new Color('#4ade80');

export interface HoleFillOverlayData {
  /**
   * Flattened line-segment endpoints for the selected rim, or `undefined`.
   *
   * Six floats per edge, part-local. `undefined` when nothing is selected or the
   * selected component has no ordering to draw.
   */
  readonly boundaryPositions: Float32Array | undefined;
  /** Non-indexed patch triangles, nine floats per face, part-local. */
  readonly patchPositions: Float32Array | undefined;
  /** Flat normals aligned with `patchPositions`. */
  readonly patchNormals: Float32Array | undefined;
  /**
   * The model revision these describe.
   *
   * Checked before anything is drawn, exactly as the diagnostic overlays are: a
   * rim computed for the geometry the user has moved off would mark an opening
   * that is not where it says.
   */
  readonly revision: number;
  /** Distinguishes one candidate's patch from the next for the same model. */
  readonly generation: number;
}

export interface HoleFillOverlayHandle {
  readonly group: Group;
  /** Replaces the overlay data. `undefined` clears both objects. */
  setData(data: HoleFillOverlayData | undefined): void;
  /** Objects currently in the group. For leak tests. */
  readonly objectCount: number;
  /** Cumulative uploads and disposals. For double-dispose and leak tests. */
  readonly lifecycle: { readonly created: number; readonly disposed: number };
  dispose(): void;
}

export function createHoleFillOverlays(): HoleFillOverlayHandle {
  const group = new Group();
  // Drawn after the surface, before nothing: the depth policy below decides
  // what is visible through what.
  group.renderOrder = 3;

  let rim: LineSegments | undefined;
  let patch: Mesh | undefined;
  let created = 0;
  let disposed = 0;
  /**
   * What is currently uploaded.
   *
   * Compared before a rebuild so that an unrelated re-render — a status message,
   * a resize — does not dispose and re-upload buffers that have not changed.
   * Identity comparison on the arrays themselves, because the store replaces
   * them wholesale and never mutates one in place.
   */
  let currentBoundary: Float32Array | undefined;
  let currentPatch: Float32Array | undefined;
  let currentRevision = -1;
  let currentGeneration = -1;

  const disposeRim = (): void => {
    if (rim === undefined) return;
    group.remove(rim);
    rim.geometry.dispose();
    const material = rim.material;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material.dispose();
    rim = undefined;
    disposed += 1;
  };

  const disposePatch = (): void => {
    if (patch === undefined) return;
    group.remove(patch);
    patch.geometry.dispose();
    const material = patch.material;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material.dispose();
    patch = undefined;
    disposed += 1;
  };

  const buildRim = (positions: Float32Array): void => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const material = new LineBasicMaterial({
      color: RIM_COLOR,
      /*
       * DEPTH POLICY — a view concern, never a geometry one, and the same trade
       * the diagnostic overlays make. The rim lies exactly on the surface it
       * bounds, so with normal depth testing it z-fights and vanishes at most
       * angles. Drawing it through the model means an opening on the far side is
       * still findable, which is the entire purpose of highlighting it.
       * `depthWrite` stays off so the rim never occludes the surface.
       */
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const lines = new LineSegments(geometry, material);
    lines.renderOrder = 4;
    group.add(lines);
    rim = lines;
    created += 1;
  };

  const buildPatch = (positions: Float32Array, normals: Float32Array): void => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    const material = new MeshStandardMaterial({
      color: PATCH_COLOR,
      metalness: 0.05,
      roughness: 0.6,
      // Both faces, for the same reason the model material draws both: a user
      // looking at a patch from the inside of a shell must still see it.
      side: DoubleSide,
      /*
       * DEPTH-TESTED, UNLIKE THE RIM. The patch is a SURFACE occupying real
       * space, and drawing it through the model would show it floating in front
       * of geometry that is genuinely in front of it — which would misrepresent
       * where the patch sits. Slightly transparent so the rim and the
       * surrounding surface stay readable underneath it.
       */
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new Mesh(geometry, material);
    mesh.renderOrder = 4;
    group.add(mesh);
    patch = mesh;
    created += 1;
  };

  return {
    group,
    setData(data): void {
      if (data === undefined) {
        disposeRim();
        disposePatch();
        currentBoundary = undefined;
        currentPatch = undefined;
        currentRevision = -1;
        currentGeneration = -1;
        return;
      }

      // A NEW REVISION INVALIDATES BOTH. The rim and the patch are part-local
      // buffers computed against one revision's geometry; carrying either
      // across a revision change would draw the previous model's opening on the
      // current one.
      const revisionChanged = data.revision !== currentRevision;
      const generationChanged = data.generation !== currentGeneration;

      if (revisionChanged || data.boundaryPositions !== currentBoundary) {
        disposeRim();
        currentBoundary = data.boundaryPositions;
        if (data.boundaryPositions !== undefined && data.boundaryPositions.length >= 6) {
          buildRim(data.boundaryPositions);
        }
      }

      if (revisionChanged || generationChanged || data.patchPositions !== currentPatch) {
        disposePatch();
        currentPatch = data.patchPositions;
        if (
          data.patchPositions !== undefined &&
          data.patchNormals !== undefined &&
          data.patchPositions.length >= 9
        ) {
          buildPatch(data.patchPositions, data.patchNormals);
        }
      }

      currentRevision = data.revision;
      currentGeneration = data.generation;
    },
    get objectCount(): number {
      return group.children.length;
    },
    get lifecycle(): { readonly created: number; readonly disposed: number } {
      return { created, disposed };
    },
    dispose(): void {
      disposeRim();
      disposePatch();
      group.removeFromParent();
    },
  };
}
