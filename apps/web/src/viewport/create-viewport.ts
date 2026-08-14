import {
  AmbientLight,
  AxesHelper,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * The 3D workspace viewport.
 *
 * Owns the renderer, scene, camera, and controls. Knows nothing about the
 * canonical mesh contract beyond the buffers it is handed, and never mutates
 * them.
 *
 * THE CENTRAL RULE HERE: display transforms never touch stored geometry. A
 * model exported from CAD 40 metres from the origin is displayed centred, by
 * translating the OBJECT that holds it — the position buffer keeps the exact
 * coordinates the file contained. Baking a centring offset into the vertices
 * would silently move the user's model, and would then be exported back out
 * that way.
 *
 * Rendering is driven by change, not by a permanent animation loop: the scene
 * is static between interactions, so an idle `requestAnimationFrame` loop would
 * burn battery to redraw identical pixels.
 */

export interface ViewportModel {
  /** Canonical positions. Referenced, never copied or modified. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Normals derived from geometry in the worker. Display data. */
  readonly normals: Float32Array;
  /** Bounding box centre in model coordinates. */
  readonly center: readonly [number, number, number];
  /** Radius of the enclosing sphere about `center`. */
  readonly radius: number;
  /** Changes when a different model is loaded. */
  readonly revision: number;
}

export interface ViewportHandle {
  /** Replaces the displayed model, disposing whatever was there. */
  setModel(model: ViewportModel | undefined): void;
  /** Frames the current model. No-op when the workspace is empty. */
  fitView(): void;
  /** Number of GPU-backed objects currently in the scene. For leak tests. */
  readonly renderedObjectCount: number;
  dispose(): void;
}

export interface ViewportOptions {
  readonly onContextLost?: () => void;
}

const MAX_PIXEL_RATIO = 2;
const BACKGROUND = new Color('#12161c');
const GRID_MAJOR = new Color('#2c3542');
const GRID_MINOR = new Color('#1d232c');
const MODEL_COLOR = new Color('#b9c4d0');

/** Camera direction used when framing, in the model's own axes. */
const VIEW_DIRECTION = new Vector3(1, 0.75, 1).normalize();

/** Padding factor so the model does not touch the viewport edges. */
const FIT_PADDING = 1.35;

export function createViewport(
  container: HTMLElement,
  options: ViewportOptions = {},
): ViewportHandle {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, MAX_PIXEL_RATIO));

  const scene = new Scene();
  scene.background = BACKGROUND;

  const grid = new GridHelper(200, 20, GRID_MAJOR, GRID_MINOR);
  const axes = new AxesHelper(40);
  scene.add(grid, axes);

  // Hemisphere-ish fill plus two directionals: enough to read surface shape
  // from any angle without a light rig the user has to think about.
  const ambient = new AmbientLight(0xffffff, 1.6);
  const keyLight = new DirectionalLight(0xffffff, 2.2);
  keyLight.position.set(1, 1.5, 1);
  const fillLight = new DirectionalLight(0xffffff, 0.8);
  fillLight.position.set(-1, -0.5, -1);
  scene.add(ambient, keyLight, fillLight);

  const camera = new PerspectiveCamera(45, 1, 0.1, 5000);
  camera.position.set(180, 140, 180);
  camera.lookAt(0, 0, 0);

  const canvas = renderer.domElement;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Empty 3D workspace. No model is loaded.');
  container.appendChild(canvas);

  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.enableRotate = true;
  // No damping: damping needs a continuous animation loop, and this scene is
  // static between interactions.
  controls.enableDamping = false;

  /** Holds the model and carries the display-only centring offset. */
  const modelGroup = new Group();
  scene.add(modelGroup);

  let currentMesh: Mesh<BufferGeometry, MeshStandardMaterial> | undefined;
  let currentModel: ViewportModel | undefined;
  let disposed = false;

  /**
   * Publishes what the renderer actually drew onto the canvas element.
   *
   * This is a diagnostic surface, not decoration. It is the only way to assert
   * from outside that geometry reached the GPU — checking React state proves
   * only that a number was stored, and a viewport that silently drew nothing
   * would pass that. `modelObjects` makes GPU-resource leaks observable: it must
   * stay at one no matter how many models have been loaded.
   */
  const publishRenderStats = (): void => {
    canvas.dataset.drawCalls = String(renderer.info.render.calls);
    canvas.dataset.renderedTriangles = String(renderer.info.render.triangles);
    canvas.dataset.modelObjects = String(modelGroup.children.length);
  };

  const render = (): void => {
    if (disposed) return;
    renderer.render(scene, camera);
    publishRenderStats();
  };

  controls.addEventListener('change', render);

  const resize = (): void => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    // `updateStyle` stays at its default of true so the canvas CSS size tracks
    // the drawing buffer; skipping it renders at devicePixelRatio scale and
    // overflows the layout on high-DPI displays.
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };

  const disposeCurrentMesh = (): void => {
    if (currentMesh === undefined) return;
    modelGroup.remove(currentMesh);
    // Both are owned by this module, so both are released here. Without this,
    // loading twenty models in a session leaks twenty sets of GPU buffers.
    currentMesh.geometry.dispose();
    currentMesh.material.dispose();
    currentMesh = undefined;
  };

  const fitView = (): void => {
    if (currentModel === undefined) {
      camera.position.set(180, 140, 180);
      controls.target.set(0, 0, 0);
      controls.update();
      render();
      return;
    }

    // The model group is offset by -centre, so the model occupies a sphere of
    // `radius` about the world origin regardless of where it sat in the file.
    // Fitting therefore never assumes the source coordinates were near zero.
    const radius = currentModel.radius > 0 ? currentModel.radius : 1;
    const halfFov = (camera.fov * Math.PI) / 180 / 2;
    const distance = (radius / Math.sin(halfFov)) * FIT_PADDING;

    camera.position.copy(VIEW_DIRECTION).multiplyScalar(distance);
    // Clip planes are derived from the model's own scale, so a 0.1 mm part and
    // a 3 m part are both drawn without z-fighting or clipping.
    camera.near = Math.max(distance / 10_000, radius / 10_000);
    camera.far = distance + radius * 10;
    camera.updateProjectionMatrix();

    controls.target.set(0, 0, 0);
    controls.update();
    render();
  };

  const setModel = (model: ViewportModel | undefined): void => {
    disposeCurrentMesh();
    currentModel = model;

    if (model === undefined) {
      grid.visible = true;
      canvas.setAttribute('aria-label', 'Empty 3D workspace. No model is loaded.');
      fitView();
      return;
    }

    const geometry = new BufferGeometry();
    // The canonical position buffer is REFERENCED, not copied: one Float32Array
    // backs both the workspace's canonical mesh and the GPU attribute. Three.js
    // uploads it and does not write to it, and nothing here calls a geometry
    // transform, so the canonical coordinates stay exactly as parsed.
    geometry.setAttribute('position', new BufferAttribute(model.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(model.normals, 3));
    geometry.setIndex(new BufferAttribute(model.indices, 1));

    // ASSIGNED, NOT COMPUTED — do not delete this.
    //
    // Three.js computes a bounding sphere lazily during frustum culling
    // (Frustum.intersectsObject -> `if (geometry.boundingSphere === null)
    // geometry.computeBoundingSphere()`). That makes two full passes over the
    // position buffer ON THE UI THREAD, on the first frame after a model
    // loads — 6.3 million vertices walked twice for a 100 MiB model, which is
    // exactly the whole-mesh main-thread work this project forbids.
    //
    // The worker already measured this sphere during import, so it is handed
    // over instead. The radius is in geometry-local coordinates and the centre
    // is the model's own centre, because the display offset lives on
    // `modelGroup.position`, not in the vertex data.
    geometry.boundingSphere = new Sphere(
      new Vector3(model.center[0], model.center[1], model.center[2]),
      model.radius > 0 ? model.radius : 1,
    );

    const material = new MeshStandardMaterial({
      color: MODEL_COLOR,
      metalness: 0.05,
      roughness: 0.75,
      // Both faces are drawn. STL winding is frequently inconsistent, and until
      // orientation diagnostics exist it is more honest to let the user see
      // their whole model than to render parts of it invisible.
      side: DoubleSide,
      flatShading: false,
    });

    const mesh = new Mesh(geometry, material);
    // DISPLAY-ONLY centring. The offset lives on the object's transform; the
    // vertex data is untouched.
    modelGroup.position.set(-model.center[0], -model.center[1], -model.center[2]);
    modelGroup.add(mesh);
    currentMesh = mesh;

    // The reference grid is sized for a print bed and becomes meaningless
    // beside a model of arbitrary scale.
    grid.visible = false;
    canvas.setAttribute('aria-label', 'Loaded 3D model. Drag to orbit, scroll to zoom.');

    fitView();
  };

  const handleContextLost = (event: Event): void => {
    event.preventDefault();
    options.onContextLost?.();
  };

  canvas.addEventListener('webglcontextlost', handleContextLost);

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  return {
    setModel,
    fitView,
    get renderedObjectCount(): number {
      return modelGroup.children.length;
    },
    dispose(): void {
      disposed = true;
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      controls.removeEventListener('change', render);
      controls.dispose();
      disposeCurrentMesh();
      grid.geometry.dispose();
      disposeMaterial(grid);
      axes.geometry.dispose();
      disposeMaterial(axes);
      scene.clear();
      renderer.dispose();
      canvas.remove();
    },
  };
}

/** Helpers may carry either a single material or an array of them. */
function disposeMaterial(object: GridHelper | AxesHelper): void {
  const material = object.material;
  if (Array.isArray(material)) {
    for (const entry of material) entry.dispose();
    return;
  }
  material.dispose();
}
