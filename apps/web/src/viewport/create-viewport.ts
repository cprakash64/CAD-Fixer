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
import {
  createOverlays,
  type OverlayHandle,
  type OverlaySamples,
  type OverlayVisibility,
} from './create-overlays';
import {
  createChangeOverlays,
  type ChangeOverlayHandle,
  type ChangeOverlaySamples,
  type ChangeOverlayView,
  type ChangeOverlayVisibility,
} from './create-change-overlays';

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
  /**
   * Render-snapshot positions, three vertices per triangle, drawn NON-INDEXED.
   *
   * These are display buffers owned by the main thread, not the authoritative
   * geometry — that stays in the worker. No index buffer is supplied because
   * STL soup indices are 0,1,2,3,… and a non-indexed draw assumes exactly that.
   */
  readonly positions: Float32Array;
  /** Normals derived from geometry in the worker. Display data. */
  readonly normals: Float32Array;
  /** Bounding box centre in model coordinates. */
  readonly center: readonly [number, number, number];
  /** Radius of the enclosing sphere about `center`. */
  readonly radius: number;
  /** Changes when a different model is loaded. */
  readonly revision: number;
}

/**
 * Diagnostic samples to draw over the model.
 *
 * `revision` names the model these belong to. The viewport refuses samples
 * whose revision does not match the model it is currently showing — an analysis
 * that finishes after the user has already imported a different file must not
 * decorate the new model with the old one's defects.
 */
export interface ViewportOverlayData {
  readonly samples: OverlaySamples;
  readonly visibility: OverlayVisibility;
  readonly revision: number;
}

/**
 * Proposed geometry, shown BESIDE the authoritative model rather than instead of
 * it.
 *
 * THE AUTHORITY SEPARATION. This is a second render snapshot for a candidate the
 * worker has not committed. The viewport draws one or the other, but the
 * authoritative model's buffers stay loaded and untouched throughout, and no
 * handle anywhere is swapped. Switching views is a `visible` flag, which is why
 * it cannot move the camera or change what export resolves.
 */
export interface ViewportPreview {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Candidate bounds, so frustum culling never walks the buffer on the UI thread. */
  readonly center: readonly [number, number, number];
  readonly radius: number;
  /** Which of the two the user is looking at. */
  readonly showing: ChangeOverlayView;
  /** Names the model this candidate was computed from. */
  readonly revision: number;
  /** Distinguishes one candidate from the next for the same model. */
  readonly generation: number;
}

/**
 * Repair change samples to draw over whichever mesh is being shown.
 *
 * `revision` names the model these belong to, exactly as diagnostic overlays do,
 * and is checked for the same reason: a preview the user has discarded must not
 * leave its markers on the model that replaced it.
 */
export interface ViewportChangeData {
  readonly samples: ChangeOverlaySamples;
  readonly visibility: ChangeOverlayVisibility;
  readonly view: ChangeOverlayView;
  readonly revision: number;
  readonly generation: number;
}

export interface ViewportHandle {
  /** Replaces the displayed model, disposing whatever was there. */
  setModel(model: ViewportModel | undefined): void;
  /** Replaces the diagnostic overlays. `undefined` clears them. */
  setOverlays(data: ViewportOverlayData | undefined): void;
  /**
   * Installs or clears a repair preview.
   *
   * DOES NOT REFRAME. The camera, the orbit target, the zoom and the display
   * offset all stay exactly as they are, so Before and After are the same view
   * of two meshes rather than two views. Reframing here would make every switch
   * a jump and would make comparison impossible.
   */
  setPreview(preview: ViewportPreview | undefined): void;
  /** Replaces the repair change overlays. `undefined` clears them. */
  setChangeOverlays(data: ViewportChangeData | undefined): void;
  /** Frames the current model. No-op when the workspace is empty. */
  fitView(): void;
  /** Number of GPU-backed model objects in the scene. For leak tests. */
  readonly renderedObjectCount: number;
  /** Diagnostic overlay objects currently in the scene. For leak tests. */
  readonly overlayObjectCount: number;
  /** Preview mesh objects currently in the scene. For leak tests. */
  readonly previewObjectCount: number;
  /** Repair change overlay objects currently in the scene. For leak tests. */
  readonly changeOverlayObjectCount: number;
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

/**
 * Length of a winding-direction indicator, as a fraction of the model radius.
 *
 * Relative rather than absolute so the marker reads the same on a 0.1 mm part
 * and a 3 m one — the same reason the near and far planes are derived from the
 * model's own scale.
 */
const INDICATOR_SCALE = 0.06;

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

  // Overlays are added to the SAME group as the model, so the display-only
  // centring offset applies to both by construction. Registering them any other
  // way — a sibling group with its own copy of the offset, or coordinates
  // adjusted at build time — would leave two places that have to agree, and they
  // would eventually not.
  const overlays: OverlayHandle = createOverlays();
  modelGroup.add(overlays.group);

  // Change overlays join the same group for the same reason: the display-only
  // centring offset must apply to the model, its diagnostics and a repair's
  // proposed changes identically, and one transform is the only way to guarantee
  // that without two places having to agree.
  const changeOverlays: ChangeOverlayHandle = createChangeOverlays();
  modelGroup.add(changeOverlays.group);

  let currentMesh: Mesh<BufferGeometry, MeshStandardMaterial> | undefined;
  let currentModel: ViewportModel | undefined;
  let previewMesh: Mesh<BufferGeometry, MeshStandardMaterial> | undefined;
  let currentPreview: ViewportPreview | undefined;
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
    // Counted from the meshes themselves rather than from the group's child
    // count. The group also holds two permanent overlay groups and, while a
    // repair is being previewed, a candidate mesh — deriving this by arithmetic
    // on `children.length` would silently start counting those the moment
    // anything was added, and this number exists precisely to make GPU-resource
    // leaks observable.
    canvas.dataset.modelObjects = String(currentMesh === undefined ? 0 : 1);
    canvas.dataset.previewObjects = String(previewMesh === undefined ? 0 : 1);
    canvas.dataset.overlayObjects = String(overlays.objectCount);
    canvas.dataset.changeOverlayObjects = String(changeOverlays.objectCount);
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

  /**
   * Releases the preview's GPU resources.
   *
   * A preview is the same size as the model, so leaking one costs as much as
   * leaking a model. Called on discard, on replacement, on commit, on model
   * change, and on teardown.
   */
  const disposePreviewMesh = (): void => {
    if (previewMesh === undefined) return;
    modelGroup.remove(previewMesh);
    previewMesh.geometry.dispose();
    previewMesh.material.dispose();
    previewMesh = undefined;
    currentPreview = undefined;
  };

  /** Builds a surface mesh from a render snapshot's buffers. */
  const buildSurface = (
    positions: Float32Array,
    normals: Float32Array,
    center: readonly [number, number, number],
    radius: number,
  ): Mesh<BufferGeometry, MeshStandardMaterial> => {
    const geometry = new BufferGeometry();
    // The render snapshot's buffers are REFERENCED, not copied again: they were
    // transferred here from the worker and belong to the main thread now.
    // Three.js uploads them and does not write to them.
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));

    // ASSIGNED, NOT COMPUTED — do not delete this.
    //
    // Three.js computes a bounding sphere lazily during frustum culling
    // (Frustum.intersectsObject -> `if (geometry.boundingSphere === null)
    // geometry.computeBoundingSphere()`). That makes two full passes over the
    // position buffer ON THE UI THREAD, on the first frame after a model
    // loads — 6.3 million vertices walked twice for a 100 MiB model, which is
    // exactly the whole-mesh main-thread work this project forbids.
    //
    // The worker already measured this sphere, so it is handed over instead. The
    // radius is in geometry-local coordinates and the centre is the mesh's own
    // centre, because the display offset lives on `modelGroup.position`, not in
    // the vertex data.
    geometry.boundingSphere = new Sphere(
      new Vector3(center[0], center[1], center[2]),
      radius > 0 ? radius : 1,
    );

    const material = new MeshStandardMaterial({
      color: MODEL_COLOR,
      metalness: 0.05,
      roughness: 0.75,
      // Both faces are drawn. STL winding is frequently inconsistent, and
      // rendering parts of a model invisible would be a worse answer than
      // showing the user their whole file.
      side: DoubleSide,
      flatShading: false,
    });

    return new Mesh(geometry, material);
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
    // A preview describes a repair of the model being replaced. It goes with it:
    // there is no frame in which one model's geometry is drawn beside another
    // model's proposed repair.
    disposePreviewMesh();
    // Overlays describe the model being replaced. Clearing them here rather
    // than waiting for the next report means there is no frame in which one
    // model's geometry is drawn under another model's defects.
    overlays.setSamples(undefined, undefined);
    changeOverlays.setSamples(undefined);
    currentModel = model;

    if (model === undefined) {
      grid.visible = true;
      canvas.setAttribute('aria-label', 'Empty 3D workspace. No model is loaded.');
      fitView();
      return;
    }

    const mesh = buildSurface(model.positions, model.normals, model.center, model.radius);
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

  /**
   * Installs diagnostic overlays for the CURRENT model only.
   *
   * The revision check is the last line of defence against a stale report. The
   * application already gates on handles, but this is the layer that would
   * actually put the wrong lines on screen, so it verifies rather than trusting
   * that everything upstream got it right.
   */
  const setOverlays = (data: ViewportOverlayData | undefined): void => {
    if (data === undefined || currentModel === undefined) {
      overlays.setSamples(undefined, undefined);
      render();
      return;
    }
    if (data.revision !== currentModel.revision) {
      overlays.setSamples(undefined, undefined);
      render();
      return;
    }

    overlays.setSamples(data.samples, currentModel.positions);
    overlays.setVisibility(data.visibility);
    render();
  };

  /**
   * Installs or clears the repair preview.
   *
   * NO REFRAMING ANYWHERE IN HERE, deliberately. `fitView` is not called, the
   * controls are not updated, and `modelGroup.position` is left at the offset
   * the authoritative model established. Before and After are therefore the same
   * camera looking at two meshes, which is the only arrangement in which a
   * user can actually compare them.
   *
   * The revision check is the last line of defence against a stale candidate.
   * The application already gates on handles, but this is the layer that would
   * put the wrong surface on screen, so it verifies rather than trusting.
   */
  const setPreview = (preview: ViewportPreview | undefined): void => {
    if (preview === undefined || currentModel === undefined) {
      disposePreviewMesh();
      if (currentMesh !== undefined) currentMesh.visible = true;
      render();
      return;
    }
    if (preview.revision !== currentModel.revision) {
      disposePreviewMesh();
      if (currentMesh !== undefined) currentMesh.visible = true;
      render();
      return;
    }

    // Rebuilt only when the candidate itself changed. Switching Before/After on
    // the same candidate must not reupload a second copy of the model to the
    // GPU — that would make a view toggle as expensive as a load.
    if (currentPreview?.generation !== preview.generation) {
      disposePreviewMesh();
      const mesh = buildSurface(preview.positions, preview.normals, preview.center, preview.radius);
      modelGroup.add(mesh);
      previewMesh = mesh;
    }
    currentPreview = preview;

    const showingAfter = preview.showing === 'after';
    if (previewMesh !== undefined) previewMesh.visible = showingAfter;
    if (currentMesh !== undefined) currentMesh.visible = !showingAfter;
    canvas.setAttribute(
      'aria-label',
      showingAfter
        ? 'Preview of the proposed repair result. Not applied. Drag to orbit, scroll to zoom.'
        : 'Loaded 3D model. Drag to orbit, scroll to zoom.',
    );
    render();
  };

  const setChangeOverlays = (data: ViewportChangeData | undefined): void => {
    if (data === undefined || currentModel === undefined) {
      changeOverlays.setSamples(undefined);
      render();
      return;
    }
    if (data.revision !== currentModel.revision) {
      changeOverlays.setSamples(undefined);
      render();
      return;
    }

    changeOverlays.setSamples({
      samples: data.samples,
      sourcePositions: currentModel.positions,
      // Sized from the model itself so a marker is readable at any scale. A
      // fixed length would be invisible on a 3 m part and would swamp a 0.1 mm
      // one.
      indicatorLength: (currentModel.radius > 0 ? currentModel.radius : 1) * INDICATOR_SCALE,
    });
    changeOverlays.setVisibility(data.visibility, data.view);
    render();
  };

  return {
    setModel,
    setOverlays,
    setPreview,
    setChangeOverlays,
    fitView,
    get renderedObjectCount(): number {
      return currentMesh === undefined ? 0 : 1;
    },
    get overlayObjectCount(): number {
      return overlays.objectCount;
    },
    get previewObjectCount(): number {
      return previewMesh === undefined ? 0 : 1;
    },
    get changeOverlayObjectCount(): number {
      return changeOverlays.objectCount;
    },
    dispose(): void {
      disposed = true;
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      controls.removeEventListener('change', render);
      controls.dispose();
      disposeCurrentMesh();
      disposePreviewMesh();
      overlays.dispose();
      changeOverlays.dispose();
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
