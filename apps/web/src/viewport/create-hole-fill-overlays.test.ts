import { describe, expect, it } from 'vitest';
import { LineSegments, Mesh } from 'three';
import { createHoleFillOverlays, type HoleFillOverlayData } from './create-hole-fill-overlays';

/**
 * HR01–HR10: THE RIM AND THE PATCH, tested without a renderer.
 *
 * Nothing here needs WebGL. The module builds `BufferGeometry` and scene-graph
 * objects, and every property worth asserting — how many GPU objects exist, what
 * coordinates they carry, whether they were disposed and how many times — is
 * observable from the objects themselves. A viewport concern that can only be
 * checked by looking at pixels is a viewport concern nobody checks.
 *
 * WHAT THESE PROTECT:
 *   - the rim and the patch are DISPOSED when they stop applying, not left on
 *     screen decorating geometry they do not describe;
 *   - nothing is re-uploaded when nothing changed, because the whole reason the
 *     rim is fetched separately from the listing is to keep the GPU work
 *     proportional to what the user selected;
 *   - repeated preview and discard cycles do not grow the scene, and dispose
 *     exactly as many objects as they created;
 *   - coordinates are uploaded EXACTLY as the worker produced them. A viewport
 *     that nudged a rim to avoid z-fighting would be drawing a position that is
 *     not the reported position.
 */

function rim(offset = 0): Float32Array {
  // Two segments: a square's worth of rim would be four, and two is enough to
  // tell "uploaded verbatim" from "recomputed".
  return new Float32Array([offset, 0, 0, offset + 1, 0, 0, offset + 1, 0, 0, offset + 1, 1, 0]);
}

function patch(): { positions: Float32Array; normals: Float32Array } {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  };
}

function data(overrides: Partial<HoleFillOverlayData> = {}): HoleFillOverlayData {
  return {
    boundaryPositions: undefined,
    patchPositions: undefined,
    patchNormals: undefined,
    revision: 1,
    generation: 1,
    ...overrides,
  };
}

function positionsOf(object: LineSegments | Mesh): Float32Array {
  const attribute = object.geometry.getAttribute('position');
  return attribute.array as Float32Array;
}

describe('HR01, HR03: the overlays appear when they apply', () => {
  it('draws the selected rim as ONE batched line object', () => {
    const overlays = createHoleFillOverlays();
    const positions = rim();
    overlays.setData(data({ boundaryPositions: positions }));

    expect(overlays.objectCount).toBe(1);
    const object = overlays.group.children[0];
    expect(object).toBeInstanceOf(LineSegments);
    // ONE OBJECT, NOT ONE PER EDGE. A 512-vertex rim would otherwise be 512
    // scene-graph nodes and 512 draw calls to outline one opening.
    expect(overlays.objectCount).toBe(1);
    // UPLOADED VERBATIM. Not nudged, not offset, not recomputed.
    expect(positionsOf(object as LineSegments)).toBe(positions);
    overlays.dispose();
  });

  it('draws the patch as a shaded surface beside the rim, not instead of it', () => {
    const overlays = createHoleFillOverlays();
    const { positions, normals } = patch();
    overlays.setData(
      data({ boundaryPositions: rim(), patchPositions: positions, patchNormals: normals }),
    );

    expect(overlays.objectCount).toBe(2);
    const meshes = overlays.group.children.filter((child) => child instanceof Mesh);
    expect(meshes).toHaveLength(1);
    const patchMesh = meshes[0] as Mesh;
    expect(positionsOf(patchMesh)).toBe(positions);
    expect(patchMesh.geometry.getAttribute('normal').array).toBe(normals);
    overlays.dispose();
  });

  it('draws nothing for a rim or patch with no geometry', () => {
    const overlays = createHoleFillOverlays();
    // A refused component has an EMPTY vertex list — `extractBoundaryLoops`
    // returns no ordering for one rather than a partial walk — so there is
    // nothing to draw and an empty buffer would still be a GPU resource.
    overlays.setData(
      data({ boundaryPositions: new Float32Array(0), patchPositions: new Float32Array(0) }),
    );
    expect(overlays.objectCount).toBe(0);
    overlays.dispose();
  });
});

describe('HR02, HR04: the overlays go when they stop applying', () => {
  it('disposes the old rim when the selection changes', () => {
    const overlays = createHoleFillOverlays();
    overlays.setData(data({ boundaryPositions: rim(0) }));
    const first = overlays.group.children[0] as LineSegments;

    overlays.setData(data({ boundaryPositions: rim(50) }));

    expect(overlays.objectCount).toBe(1);
    expect(overlays.group.children[0]).not.toBe(first);
    expect(overlays.lifecycle).toEqual({ created: 2, disposed: 1 });
    overlays.dispose();
  });

  it('HR04: disposes the patch when the preview is discarded', () => {
    const overlays = createHoleFillOverlays();
    const { positions, normals } = patch();
    overlays.setData(
      data({ boundaryPositions: rim(), patchPositions: positions, patchNormals: normals }),
    );
    expect(overlays.objectCount).toBe(2);

    // Discard keeps the SELECTION and drops the proposal, which is exactly the
    // shape of this update.
    overlays.setData(data({ boundaryPositions: rim() }));

    expect(overlays.objectCount).toBe(1);
    expect(overlays.group.children[0]).toBeInstanceOf(LineSegments);
    overlays.dispose();
  });

  it('clears both on `undefined`', () => {
    const overlays = createHoleFillOverlays();
    const { positions, normals } = patch();
    overlays.setData(
      data({ boundaryPositions: rim(), patchPositions: positions, patchNormals: normals }),
    );

    overlays.setData(undefined);

    expect(overlays.objectCount).toBe(0);
    expect(overlays.lifecycle.created).toBe(overlays.lifecycle.disposed);
    overlays.dispose();
  });

  it('HR05, HR06: a new revision invalidates both, even with identical buffers', () => {
    /*
     * THE APPLY AND UNDO CASE. After a commit the patch is ordinary source
     * geometry drawn by the model itself, and the rim describes an opening that
     * is gone. Carrying either across because the arrays happened to be the same
     * objects would leave the previous revision's markings on the new one.
     */
    const overlays = createHoleFillOverlays();
    const positions = rim();
    overlays.setData(data({ boundaryPositions: positions, revision: 1 }));
    const first = overlays.group.children[0];

    overlays.setData(data({ boundaryPositions: positions, revision: 2 }));

    expect(overlays.group.children[0]).not.toBe(first);
    expect(overlays.lifecycle.disposed).toBe(1);
    overlays.dispose();
  });

  it('invalidates the patch when a new candidate supersedes the old one', () => {
    const overlays = createHoleFillOverlays();
    const { positions, normals } = patch();
    overlays.setData(data({ patchPositions: positions, patchNormals: normals, generation: 1 }));
    const first = overlays.group.children[0];

    // Same buffers, different candidate. The generation is what distinguishes
    // one proposal from the next for the same model.
    overlays.setData(data({ patchPositions: positions, patchNormals: normals, generation: 2 }));

    expect(overlays.group.children[0]).not.toBe(first);
    overlays.dispose();
  });
});

describe('HR08, HR09: the lifecycle is bounded and never double-disposes', () => {
  it('re-uploads nothing when nothing changed', () => {
    /*
     * The panel re-renders for unrelated reasons — a status message, a resize —
     * and each one pushes the same data. Rebuilding on every push would dispose
     * and re-upload a 512-vertex rim for a toast notification.
     */
    const overlays = createHoleFillOverlays();
    const positions = rim();
    const { positions: patchPositions, normals } = patch();
    const payload = data({
      boundaryPositions: positions,
      patchPositions,
      patchNormals: normals,
    });

    overlays.setData(payload);
    const created = overlays.lifecycle.created;
    const rimObject = overlays.group.children[0];

    for (let i = 0; i < 20; i += 1) overlays.setData(payload);

    expect(overlays.lifecycle.created).toBe(created);
    expect(overlays.lifecycle.disposed).toBe(0);
    expect(overlays.group.children[0]).toBe(rimObject);
    overlays.dispose();
  });

  it('HR09: repeated preview and discard cycles do not grow the scene', () => {
    const overlays = createHoleFillOverlays();
    const positions = rim();

    for (let cycle = 1; cycle <= 25; cycle += 1) {
      const { positions: patchPositions, normals } = patch();
      overlays.setData(
        data({
          boundaryPositions: positions,
          patchPositions,
          patchNormals: normals,
          generation: cycle,
        }),
      );
      expect(overlays.objectCount).toBe(2);
      overlays.setData(data({ boundaryPositions: positions, generation: cycle }));
      expect(overlays.objectCount).toBe(1);
    }

    // BOUNDED, whatever the cycle count. The rim was uploaded once and every
    // patch was released.
    expect(overlays.objectCount).toBe(1);
    overlays.dispose();
    expect(overlays.objectCount).toBe(0);
    expect(overlays.lifecycle.created).toBe(overlays.lifecycle.disposed);
  });

  it('HR08: disposing twice releases nothing twice', () => {
    const overlays = createHoleFillOverlays();
    const { positions, normals } = patch();
    overlays.setData(
      data({ boundaryPositions: rim(), patchPositions: positions, patchNormals: normals }),
    );

    overlays.dispose();
    const afterFirst = overlays.lifecycle.disposed;
    overlays.dispose();

    expect(overlays.lifecycle.disposed).toBe(afterFirst);
    expect(overlays.objectCount).toBe(0);
  });

  it('clearing an already-clear overlay disposes nothing', () => {
    const overlays = createHoleFillOverlays();
    overlays.setData(undefined);
    overlays.setData(undefined);
    expect(overlays.lifecycle).toEqual({ created: 0, disposed: 0 });
    overlays.dispose();
  });
});

describe('HR10: the overlays never carry a transform of their own', () => {
  it('leaves its group at the identity, so the active part frame decides placement', () => {
    /*
     * THE PLACEMENT LIVES ON THE PARENT. Both buffers are PART-LOCAL, and the
     * viewport adds this group to the frame that already carries the active
     * part's matrix composed with the display-centring offset. A transform here
     * would be a second place that has to agree, and it would eventually not —
     * which for a translated, rotated or reflected part means a rim drawn where
     * the opening is not.
     */
    const overlays = createHoleFillOverlays();
    overlays.setData(data({ boundaryPositions: rim() }));

    expect(overlays.group.position.toArray()).toEqual([0, 0, 0]);
    expect(overlays.group.scale.toArray()).toEqual([1, 1, 1]);
    expect(overlays.group.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    for (const child of overlays.group.children) {
      expect(child.position.toArray()).toEqual([0, 0, 0]);
      expect(child.scale.toArray()).toEqual([1, 1, 1]);
    }
    overlays.dispose();
  });

  it('draws the rim through the model and the patch in depth', () => {
    /*
     * A DELIBERATE ASYMMETRY. The rim lies exactly on the surface it bounds, so
     * depth testing makes it z-fight and vanish; drawing it through the model is
     * what makes an opening on the far side findable. The PATCH is a real
     * surface occupying real space, so drawing it through the model would show
     * it in front of geometry that is genuinely in front of it.
     */
    const overlays = createHoleFillOverlays();
    const { positions, normals } = patch();
    overlays.setData(
      data({ boundaryPositions: rim(), patchPositions: positions, patchNormals: normals }),
    );

    const lines = overlays.group.children.find(
      (child) => child instanceof LineSegments,
    ) as LineSegments;
    const mesh = overlays.group.children.find((child) => child instanceof Mesh) as Mesh;
    const lineMaterial = Array.isArray(lines.material) ? lines.material[0] : lines.material;
    const meshMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;

    expect(lineMaterial?.depthTest).toBe(false);
    expect(lineMaterial?.depthWrite).toBe(false);
    expect(meshMaterial?.depthTest).toBe(true);
    overlays.dispose();
  });
});
