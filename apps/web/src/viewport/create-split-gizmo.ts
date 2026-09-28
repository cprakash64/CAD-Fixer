import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type Object3D,
} from 'three';

/**
 * THE SPLIT PLANE, ITS ARROW AND THE CUT OUTLINE — presentation only.
 *
 * NOTHING HERE OWNS THE PLANE. `setPlane` draws whatever the application
 * publishes, and dragging the arrow does not move anything: it reports a
 * signed distance along the plane's normal through `onDrag`, the application
 * turns that into its one `offset` setting, and the moved plane comes back
 * through `setPlane` like every other change. A slider, a number field and the
 * arrow therefore cannot disagree, because only one of the three is state.
 *
 * THE ARROW TAKES THE POINTER ONLY WHEN IT IS HIT. Its `pointerdown` listener
 * runs in the capture phase, before the orbit controls; a press that misses the
 * arrow is left alone and orbits as always. A press that hits it stops there,
 * captures the pointer for the drag and releases it on up or cancel.
 *
 * Everything is in the ACTIVE PART's local frame — the group this is added to —
 * so the plane, the arrow and the outline ride on the part's placement exactly
 * as the engine's part-local plane does.
 */

export type SplitGizmoDragPhase = 'start' | 'move' | 'end';

export interface SplitGizmoOptions {
  readonly camera: Camera;
  readonly canvas: HTMLCanvasElement;
  readonly onDrag?: (phase: SplitGizmoDragPhase, distanceAlongNormal: number) => void;
}

export interface SplitGizmo {
  readonly root: Group;
  setPlane(
    plane:
      | {
          readonly origin: readonly [number, number, number];
          readonly normal: readonly [number, number, number];
        }
      | undefined,
    size: number,
  ): void;
  /** Pairs of part-local points, or undefined to clear. */
  setOutline(segments: Float32Array | undefined): void;
  /**
   * The arrow's base and tip in CSS pixels relative to the canvas, or undefined
   * when no plane is shown. A diagnostic, published so a test can grab the
   * arrow where it is actually drawn.
   */
  arrowOnScreen(
    width: number,
    height: number,
  ): readonly [number, number, number, number] | undefined;
  readonly planeVisible: boolean;
  readonly outlineEdges: number;
  readonly dragging: boolean;
  dispose(): void;
}

/**
 * Warm red-orange: a workspace colour, not the brand accent. The split pieces
 * are drawn blue and coral (`.piece-swatch--a/b`), and a brand-blue plane would
 * sink into piece A, so the plane stays warm through the Pybrix rebrand.
 */
const PLANE_COLOR = 0xff7457;
const BORDER_COLOR = 0xff9a82;
const OUTLINE_COLOR = 0xffe2d8;
const UP = new Vector3(0, 1, 0);

export function createSplitGizmo(options: SplitGizmoOptions): SplitGizmo {
  const { camera, canvas } = options;
  const root = new Group();
  root.name = 'split-gizmo';

  /* The plane: a translucent quad with a brighter border, both drawn after the model. */
  const planeMaterial = new MeshBasicMaterial({
    color: PLANE_COLOR,
    transparent: true,
    opacity: 0.18,
    side: DoubleSide,
    depthWrite: false,
  });
  const plane = new Mesh(new PlaneGeometry(1, 1), planeMaterial);
  plane.renderOrder = 2;
  const borderGeometry = new BufferGeometry();
  borderGeometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0, -0.5, -0.5, 0]),
      3,
    ),
  );
  const borderMaterial = new LineBasicMaterial({
    color: BORDER_COLOR,
    transparent: true,
    opacity: 0.9,
  });
  const border = new Line(borderGeometry, borderMaterial);
  plane.add(border);
  plane.visible = false;
  root.add(plane);

  /* The arrow: a shaft and a head along +normal, always drawn on top. */
  const arrowMaterial = new MeshBasicMaterial({ color: PLANE_COLOR, depthTest: false });
  const shaftGeometry = new CylinderGeometry(0.03, 0.03, 0.75, 12);
  shaftGeometry.translate(0, 0.375, 0);
  const headGeometry = new ConeGeometry(0.09, 0.25, 16);
  headGeometry.translate(0, 0.875, 0);
  const shaft = new Mesh(shaftGeometry, arrowMaterial);
  const head = new Mesh(headGeometry, arrowMaterial);
  shaft.renderOrder = 10;
  head.renderOrder = 10;
  /* A fatter, invisible target so the arrow is easy to grab. Never written to colour. */
  const hitGeometry = new CylinderGeometry(0.14, 0.14, 1, 10);
  hitGeometry.translate(0, 0.5, 0);
  const hitMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });
  const hit = new Mesh(hitGeometry, hitMaterial);
  const arrow = new Group();
  arrow.add(shaft, head, hit);
  arrow.visible = false;
  root.add(arrow);

  /* The cut outline, from the engine's own cap boundary after a preview. */
  const outlineMaterial = new LineBasicMaterial({
    color: OUTLINE_COLOR,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  let outline: LineSegments | undefined;
  let outlineEdges = 0;

  let current: { readonly origin: Vector3; readonly normal: Vector3 } | undefined;
  let drag:
    | {
        readonly pointerId: number;
        readonly origin: Vector3;
        readonly normal: Vector3;
        distance: number;
      }
    | undefined;

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const rayFrom = (event: PointerEvent): boolean => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((event.clientY - rect.top) / rect.height) * 2,
    );
    raycaster.setFromCamera(ndc, camera);
    return true;
  };
  const hitsArrow = (event: PointerEvent): boolean =>
    arrow.visible && rayFrom(event) && raycaster.intersectObject(hit, false).length > 0;

  /**
   * The signed part-local distance along the drag's normal of the point on
   * the normal's line closest to the pointer ray. Undefined when the ray runs
   * parallel to the line, where no such point is meaningful.
   */
  const distanceAlong = (
    event: PointerEvent,
    from: NonNullable<typeof drag>,
  ): number | undefined => {
    const parent: Object3D | null = root.parent;
    if (parent === null || !rayFrom(event)) return undefined;
    parent.updateWorldMatrix(true, false);
    const p = parent.localToWorld(from.origin.clone());
    const n = from.normal.clone().transformDirection(parent.matrixWorld);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    const w = p.clone().sub(o);
    const b = n.dot(d);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-6) return undefined;
    const t = (b * d.dot(w) - n.dot(w)) / denom;
    const local = parent.worldToLocal(p.addScaledVector(n, t));
    return local.sub(from.origin).dot(from.normal);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || current === undefined || !hitsArrow(event)) return;
    // Ours: the orbit controls and part picking never see this press.
    event.stopImmediatePropagation();
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      origin: current.origin.clone(),
      normal: current.normal.clone(),
      distance: 0,
    };
    canvas.style.cursor = 'grabbing';
    options.onDrag?.('start', 0);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (drag === undefined) {
      if (event.buttons === 0 && current !== undefined)
        canvas.style.cursor = hitsArrow(event) ? 'grab' : '';
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    event.stopImmediatePropagation();
    const distance = distanceAlong(event, drag);
    if (distance === undefined || !Number.isFinite(distance)) return;
    drag.distance = distance;
    options.onDrag?.('move', distance);
  };
  const endDrag = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) return;
    event.stopImmediatePropagation();
    const distance = drag.distance;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    drag = undefined;
    canvas.style.cursor = '';
    options.onDrag?.('end', distance);
  };

  canvas.addEventListener('pointerdown', onPointerDown, { capture: true });
  canvas.addEventListener('pointermove', onPointerMove, { capture: true });
  canvas.addEventListener('pointerup', endDrag, { capture: true });
  canvas.addEventListener('pointercancel', endDrag, { capture: true });

  return {
    root,
    setPlane(next, size): void {
      if (next === undefined) {
        current = undefined;
        plane.visible = false;
        arrow.visible = false;
        return;
      }
      const origin = new Vector3(...next.origin);
      const normal = new Vector3(...next.normal);
      if (
        !origin.toArray().every(Number.isFinite) ||
        !normal.toArray().every(Number.isFinite) ||
        normal.lengthSq() < 1e-30
      ) {
        current = undefined;
        plane.visible = false;
        arrow.visible = false;
        return;
      }
      normal.normalize();
      current = { origin, normal };
      plane.position.copy(origin);
      plane.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal);
      plane.scale.set(size, size, 1);
      plane.visible = true;
      arrow.position.copy(origin);
      arrow.quaternion.setFromUnitVectors(UP, normal);
      arrow.scale.setScalar(size * 0.3);
      arrow.visible = true;
    },
    setOutline(segments): void {
      if (outline !== undefined) {
        root.remove(outline);
        outline.geometry.dispose();
        outline = undefined;
        outlineEdges = 0;
      }
      if (segments === undefined || segments.length < 6) return;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(segments, 3));
      outline = new LineSegments(geometry, outlineMaterial);
      outline.renderOrder = 11;
      outlineEdges = segments.length / 6;
      root.add(outline);
    },
    arrowOnScreen(width, height): readonly [number, number, number, number] | undefined {
      if (!arrow.visible) return undefined;
      arrow.updateWorldMatrix(true, false);
      const base = new Vector3(0, 0, 0).applyMatrix4(arrow.matrixWorld).project(camera);
      const tip = new Vector3(0, 1, 0).applyMatrix4(arrow.matrixWorld).project(camera);
      const toX = (ndcX: number): number => ((ndcX + 1) / 2) * width;
      const toY = (ndcY: number): number => ((1 - ndcY) / 2) * height;
      return [toX(base.x), toY(base.y), toX(tip.x), toY(tip.y)];
    },
    get planeVisible(): boolean {
      return plane.visible;
    },
    get outlineEdges(): number {
      return outlineEdges;
    },
    get dragging(): boolean {
      return drag !== undefined;
    },
    dispose(): void {
      canvas.removeEventListener('pointerdown', onPointerDown, { capture: true });
      canvas.removeEventListener('pointermove', onPointerMove, { capture: true });
      canvas.removeEventListener('pointerup', endDrag, { capture: true });
      canvas.removeEventListener('pointercancel', endDrag, { capture: true });
      outline?.geometry.dispose();
      for (const disposable of [
        plane.geometry,
        planeMaterial,
        borderGeometry,
        borderMaterial,
        shaftGeometry,
        headGeometry,
        hitGeometry,
        arrowMaterial,
        hitMaterial,
        outlineMaterial,
      ])
        disposable.dispose();
    },
  };
}
