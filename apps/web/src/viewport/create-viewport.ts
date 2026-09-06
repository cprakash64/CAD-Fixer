import {
  AmbientLight,
  AxesHelper,
  BufferAttribute,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  Mesh,
  Matrix4,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { BufferGeometry } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildPartGeometry, partMatrix, SharedPartGeometry } from './part-geometry';
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
import {
  createHoleFillOverlays,
  type HoleFillOverlayData,
  type HoleFillOverlayHandle,
} from './create-hole-fill-overlays';

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

/**
 * One part of the document, as the viewport draws it.
 *
 * THE PLACEMENT IS AN OBJECT TRANSFORM, NEVER BAKED INTO THE BUFFERS. Baking
 * would give two placements of one component two different position arrays and
 * destroy the sharing that makes a thousand-placement document affordable — and
 * it would be a display concern rewriting geometry, which is the thing this
 * module exists not to do.
 */
export interface ViewportPart {
  readonly partId: string;
  /** Row-major 3x4, twelve values. See `PartTransform`. */
  readonly transform: readonly number[];
  /**
   * Render-snapshot positions, three vertices per triangle, drawn NON-INDEXED.
   *
   * These are display buffers owned by the main thread, not the authoritative
   * geometry — that stays in the worker. No index buffer is supplied because
   * STL soup indices are 0,1,2,3,… and a non-indexed draw assumes exactly that.
   *
   * Two parts may hold the SAME array. The viewport gives them one
   * `BufferGeometry` and two object transforms rather than uploading the
   * geometry twice.
   */
  readonly positions: Float32Array;
  /** Normals derived from geometry in the worker. Display data. */
  readonly normals: Float32Array;
  /** Bounding box centre in PART-LOCAL coordinates. */
  readonly center: readonly [number, number, number];
  /** Radius of the enclosing sphere about `center`, in part-local coordinates. */
  readonly radius: number;
}

export interface ViewportModel {
  /** Ordered as the document orders its parts. Never empty for a loaded model. */
  readonly parts: readonly ViewportPart[];
  /** Bounding box centre of the whole document, in world coordinates. */
  readonly center: readonly [number, number, number];
  /** Radius of the enclosing sphere about `center`, in world coordinates. */
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

/**
 * The selected opening and the proposed patch for the ACTIVE part.
 *
 * `revision` names the model these belong to, and is checked for the same
 * reason every other overlay's is: a rim computed for geometry the user has
 * moved off would mark an opening where there is none.
 */
export type ViewportHoleFillData = HoleFillOverlayData;

export interface ViewportHandle {
  /** Replaces the displayed model, disposing whatever was there. */
  setModel(model: ViewportModel | undefined): void;
  /**
   * Points the overlay, preview and change-overlay frame at a different part.
   *
   * DELIBERATELY NOT `setModel`. Selecting a part changes which mesh the
   * workflows address; it changes nothing about what is on screen or what the
   * GPU holds. Routing it through `setModel` disposed and re-uploaded every
   * part's geometry on a click — measured at four uploads for a two-part
   * document where two were correct, and it would have been two thousand for a
   * thousand-placement document.
   *
   * The parts themselves are untouched: all of them stay drawn, because a
   * selector that hid the rest of the model would make a multi-part document
   * unusable.
   */
  setActivePart(partId: string | undefined): void;
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
  /**
   * Installs or clears the selected opening and its proposed patch.
   *
   * DOES NOT REFRAME, and does not touch the model. The source part stays drawn
   * exactly as it was: the patch is added beside it, never in place of it, so
   * the user can see how the two meet.
   */
  setHoleFillOverlays(data: ViewportHoleFillData | undefined): void;
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
  /** Rim and patch objects currently in the scene. For leak tests. */
  readonly holeFillOverlayObjectCount: number;
  /** Cumulative rim/patch uploads and disposals. For double-dispose tests. */
  readonly holeFillOverlayLifecycle: { readonly created: number; readonly disposed: number };
  /** Distinct GPU geometries currently uploaded. For sharing and leak tests. */
  readonly sharedGeometryCount: number;
  /** Cumulative uploads and disposals. For double-dispose and leak tests. */
  readonly geometryLifecycle: { readonly created: number; readonly disposed: number };
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
  /**
   * The frame diagnostics, previews and change overlays are drawn in.
   *
   * WHY A GROUP AND NOT THE MODEL GROUP. Those three all describe ONE part's
   * mesh, and a part may be placed anywhere by its transform. Adding them to
   * `modelGroup` drew them at the document origin, which for any part with a
   * non-identity placement put the defect markers somewhere the defect is not.
   * One group carrying the active part's matrix keeps all three in agreement by
   * construction rather than by three call sites remembering to compose it.
   */
  const activePartGroup = new Group();
  activePartGroup.matrixAutoUpdate = false;
  modelGroup.add(activePartGroup);

  const overlays: OverlayHandle = createOverlays();
  activePartGroup.add(overlays.group);

  // Change overlays join the same group for the same reason: the display-only
  // centring offset must apply to the model, its diagnostics and a repair's
  // proposed changes identically, and one transform is the only way to guarantee
  // that without two places having to agree.
  const changeOverlays: ChangeOverlayHandle = createChangeOverlays();
  activePartGroup.add(changeOverlays.group);

  // The rim and the patch join the same group for exactly the same reason: they
  // describe the ACTIVE part's mesh in part-local coordinates, so they have to
  // ride on the active part's placement composed with the display-centring
  // offset. One transform, applied once, rather than three call sites that have
  // to agree.
  const holeFillOverlays: HoleFillOverlayHandle = createHoleFillOverlays();
  activePartGroup.add(holeFillOverlays.group);

  /**
   * One mesh per part, keyed by part id.
   *
   * A map rather than a single reference, because a document has one or many
   * parts and the preview has to be able to hide exactly one of them.
   */
  const partMeshes = new Map<string, Mesh<BufferGeometry, MeshStandardMaterial>>();

  /**
   * GPU geometry, shared between parts that share a render buffer.
   *
   * See `part-geometry.ts` for why sharing is reference counted rather than
   * simply cached.
   */
  const sharedGeometry = new SharedPartGeometry();

  /**
   * ONE MATERIAL FOR EVERY PART.
   *
   * Parts differ in placement and geometry, never in appearance, so a material
   * per part would allocate and leak N shader programs to draw one look. It is
   * created once with the viewport and disposed with it.
   */
  const surfaceMaterial = new MeshStandardMaterial({
    color: MODEL_COLOR,
    metalness: 0.05,
    roughness: 0.75,
    // Both faces are drawn. STL winding is frequently inconsistent, and
    // rendering parts of a model invisible would be a worse answer than
    // showing the user their whole file.
    side: DoubleSide,
    flatShading: false,
  });

  let currentModel: ViewportModel | undefined;
  /**
   * Held beside the model rather than inside it, because it changes far more
   * often than the model does and on a completely different cadence.
   */
  let activePartId: string | undefined;
  let previewMesh: Mesh<BufferGeometry, MeshStandardMaterial> | undefined;
  let currentPreview: ViewportPreview | undefined;
  let disposed = false;

  /** The mesh the preview replaces, or `undefined` when no part is active. */
  const activePartMesh = (): Mesh<BufferGeometry, MeshStandardMaterial> | undefined => {
    return activePartId === undefined ? undefined : partMeshes.get(activePartId);
  };

  /** The render buffer of the part overlays and change markers index. */
  const activePartPositions = (): Float32Array | undefined => {
    return currentModel?.parts.find((part) => part.partId === activePartId)?.positions;
  };

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
    canvas.dataset.modelObjects = String(partMeshes.size);
    /*
     * SHARED GPU GEOMETRY, published for the same reason `modelObjects` is.
     * `sharedGeometries` is what proves a thousand placements uploaded ONE
     * buffer; the cumulative pair is what proves the reference count released it
     * exactly once rather than never or twice. Reading React state would prove
     * only that a number was stored.
     */
    /*
     * WHICH MODEL IS ON SCREEN RIGHT NOW.
     *
     * The workspace's monotonic model revision, echoed by the layer that
     * actually drew it. Without it there is no way to tell "the new document is
     * rendered" from "the old document is still rendered and happens to have the
     * same part count" — and a test that cannot tell those apart will
     * occasionally measure the wrong scene.
     */
    canvas.dataset.modelRevision = String(currentModel?.revision ?? 0);
    canvas.dataset.sharedGeometries = String(sharedGeometry.size);
    canvas.dataset.geometriesCreated = String(sharedGeometry.lifecycle.created);
    canvas.dataset.geometriesDisposed = String(sharedGeometry.lifecycle.disposed);
    canvas.dataset.partTransforms = describePartPlacements();
    canvas.dataset.previewObjects = String(previewMesh === undefined ? 0 : 1);
    canvas.dataset.overlayObjects = String(overlays.objectCount);
    canvas.dataset.changeOverlayObjects = String(changeOverlays.objectCount);
    /*
     * THE RIM AND PATCH COUNTERS — Stage 4B-1B2. Published for the same reason
     * the geometry lifecycle counters are: a leaked preview costs as much as a
     * leaked model, and "it looks fine" is not a measurement. Cumulative
     * create/dispose totals rather than only a live count, because a leak that
     * grows and shrinks in step is indistinguishable from correctness without
     * them.
     */
    canvas.dataset.holeFillOverlayObjects = String(holeFillOverlays.objectCount);
    canvas.dataset.holeFillOverlaysCreated = String(holeFillOverlays.lifecycle.created);
    canvas.dataset.holeFillOverlaysDisposed = String(holeFillOverlays.lifecycle.disposed);
  };

  /**
   * Each part's WORLD placement, as the renderer actually resolved it.
   *
   * Published so a browser test can read the matrix Three.js is drawing with
   * rather than inferring placement from pixels. It reads `matrixWorld`, which
   * composes the display-centring offset with the part's own transform — so it
   * catches a transposed convention, a placement applied to the wrong object,
   * and a transform silently dropped, none of which a screenshot distinguishes
   * reliably.
   *
   * Bounded by part count and made of numbers, never coordinates.
   */
  const describePartPlacements = (): string => {
    const entries: string[] = [];
    for (const [partId, mesh] of partMeshes) {
      mesh.updateWorldMatrix(true, false);
      const t = mesh.matrixWorld.elements;
      // Column-major storage: the translation is elements 12, 13, 14.
      entries.push(`${partId}:${t[12].toFixed(4)},${t[13].toFixed(4)},${t[14].toFixed(4)}`);
    }
    return entries.join('|');
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

  /**
   * Removes every part mesh and releases its GPU buffers.
   *
   * Without this, loading twenty models in a session leaks twenty sets of GPU
   * buffers. The material is NOT disposed here: it is shared by every part and
   * every model, and belongs to the viewport's own lifetime.
   */
  const disposePartMeshes = (): void => {
    for (const mesh of partMeshes.values()) {
      modelGroup.remove(mesh);
      const positions = mesh.geometry.getAttribute('position');
      if (positions instanceof BufferAttribute && positions.array instanceof Float32Array) {
        sharedGeometry.release(positions.array);
      }
    }
    partMeshes.clear();
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
    activePartGroup.remove(previewMesh);
    // The geometry is the preview's own — a candidate never shares a buffer
    // with a part — so it is disposed directly rather than released by count.
    previewMesh.geometry.dispose();
    previewMesh = undefined;
    currentPreview = undefined;
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
    disposePartMeshes();
    // A preview describes a repair of the model being replaced. It goes with it:
    // there is no frame in which one model's geometry is drawn beside another
    // model's proposed repair.
    disposePreviewMesh();
    // Overlays describe the model being replaced. Clearing them here rather
    // than waiting for the next report means there is no frame in which one
    // model's geometry is drawn under another model's defects.
    overlays.setSamples(undefined, undefined);
    changeOverlays.setSamples(undefined);
    // The rim and the patch describe ONE part of ONE revision. Neither survives
    // a model change or a part change; carrying either across would draw the
    // previous selection's opening on geometry that does not have it.
    holeFillOverlays.setData(undefined);
    currentModel = model;

    if (model === undefined) {
      grid.visible = true;
      canvas.setAttribute('aria-label', 'Empty 3D workspace. No model is loaded.');
      fitView();
      return;
    }

    /*
     * ONE OBJECT PER PART, sharing geometry where the worker shared it.
     *
     * The placement goes on the object's matrix. Nothing here writes to a
     * position buffer, so two placements of one component draw in two places
     * from a single upload.
     */
    for (const part of model.parts) {
      const geometry = sharedGeometry.acquire(
        part.positions,
        part.normals,
        part.center,
        part.radius,
      );
      const mesh = new Mesh(geometry, surfaceMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(partMatrix(part.transform));
      modelGroup.add(mesh);
      partMeshes.set(part.partId, mesh);
    }

    /*
     * NO ACTIVE PART YET. Installing a model says nothing about which part the
     * workflows target — `setActivePart` does, and the application calls it
     * immediately afterwards. Keeping selection out of `setModel` is what stops
     * a click from disposing and re-uploading every part's geometry.
     */
    activePartId = undefined;
    placeActivePartGroup();

    // DISPLAY-ONLY centring. The offset lives on the object's transform; the
    // vertex data is untouched.
    modelGroup.position.set(-model.center[0], -model.center[1], -model.center[2]);

    // The reference grid is sized for a print bed and becomes meaningless
    // beside a model of arbitrary scale.
    grid.visible = false;
    canvas.setAttribute('aria-label', 'Loaded 3D model. Drag to orbit, scroll to zoom.');

    fitView();
  };

  /** Moves the overlay/preview frame onto the active part. Touches no geometry. */
  const placeActivePartGroup = (): void => {
    const active = currentModel?.parts.find((part) => part.partId === activePartId);
    activePartGroup.matrix.copy(
      active === undefined ? new Matrix4() : partMatrix(active.transform),
    );
  };

  const setActivePart = (partId: string | undefined): void => {
    if (activePartId === partId) return;
    activePartId = partId;

    /*
     * Overlays, the preview and the change markers all describe the PREVIOUS
     * part. Clearing them here rather than waiting for the store's next push
     * means there is no frame in which one part's geometry wears another part's
     * defect markers — the same reason `setModel` clears them.
     */
    disposePreviewMesh();
    overlays.setSamples(undefined, undefined);
    changeOverlays.setSamples(undefined);
    // The rim and the patch describe ONE part of ONE revision. Neither survives
    // a model change or a part change; carrying either across would draw the
    // previous selection's opening on geometry that does not have it.
    holeFillOverlays.setData(undefined);

    // A preview may have hidden the previously active part. Every part is drawn
    // once no candidate is on screen.
    for (const mesh of partMeshes.values()) mesh.visible = true;

    placeActivePartGroup();
    render();
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

    /*
     * SAMPLES INDEX THE ACTIVE PART. Vertex ids in a topology report are local
     * to the mesh that was analysed, so resolving them against another part's
     * buffer would place markers at unrelated coordinates.
     */
    const activePositions = activePartPositions();
    if (activePositions === undefined) {
      overlays.setSamples(undefined, undefined);
      render();
      return;
    }

    overlays.setSamples(data.samples, activePositions);
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
    const sourceMesh = activePartMesh();
    if (preview === undefined || currentModel === undefined) {
      disposePreviewMesh();
      if (sourceMesh !== undefined) sourceMesh.visible = true;
      render();
      return;
    }
    if (preview.revision !== currentModel.revision || sourceMesh === undefined) {
      disposePreviewMesh();
      if (sourceMesh !== undefined) sourceMesh.visible = true;
      render();
      return;
    }

    // Rebuilt only when the candidate itself changed. Switching Before/After on
    // the same candidate must not reupload a second copy of the model to the
    // GPU — that would make a view toggle as expensive as a load.
    if (currentPreview?.generation !== preview.generation) {
      disposePreviewMesh();
      const geometry = buildPartGeometry(
        preview.positions,
        preview.normals,
        preview.center,
        preview.radius,
      );
      const mesh = new Mesh(geometry, surfaceMaterial);
      // Drawn in the ACTIVE PART'S frame: a candidate replaces one part's mesh,
      // so it stands exactly where that part stands.
      activePartGroup.add(mesh);
      previewMesh = mesh;
    }
    currentPreview = preview;

    const showingAfter = preview.showing === 'after';
    if (previewMesh !== undefined) previewMesh.visible = showingAfter;
    // Only the repaired part is swapped. Every other part stays drawn, because
    // a repair of one part does not propose anything about the others.
    sourceMesh.visible = !showingAfter;
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

    const activePositions = activePartPositions();
    if (activePositions === undefined) {
      changeOverlays.setSamples(undefined);
      render();
      return;
    }

    changeOverlays.setSamples({
      samples: data.samples,
      // SOURCE FACE INDICES INDEX THE ACTIVE PART, which is the mesh the repair
      // was computed from. Indexing the document would be meaningless: face
      // numbering restarts in every part.
      sourcePositions: activePositions,
      // Sized from the model itself so a marker is readable at any scale. A
      // fixed length would be invisible on a 3 m part and would swamp a 0.1 mm
      // one.
      indicatorLength: (currentModel.radius > 0 ? currentModel.radius : 1) * INDICATOR_SCALE,
    });
    changeOverlays.setVisibility(data.visibility, data.view);
    render();
  };

  const setHoleFillOverlays = (data: ViewportHoleFillData | undefined): void => {
    if (data === undefined || currentModel === undefined) {
      holeFillOverlays.setData(undefined);
      render();
      return;
    }
    /*
     * THE STALE GUARD, repeated here rather than trusted from the caller. The
     * panel checks it too; neither layer relies on the other, for the same
     * reason the diagnostic overlays check twice.
     */
    if (data.revision !== currentModel.revision) {
      holeFillOverlays.setData(undefined);
      render();
      return;
    }
    holeFillOverlays.setData(data);
    render();
  };

  return {
    setModel,
    setActivePart,
    setOverlays,
    setPreview,
    setChangeOverlays,
    setHoleFillOverlays,
    fitView,
    get renderedObjectCount(): number {
      return partMeshes.size;
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
    get holeFillOverlayObjectCount(): number {
      return holeFillOverlays.objectCount;
    },
    get holeFillOverlayLifecycle(): { readonly created: number; readonly disposed: number } {
      return holeFillOverlays.lifecycle;
    },
    get sharedGeometryCount(): number {
      return sharedGeometry.size;
    },
    get geometryLifecycle(): { readonly created: number; readonly disposed: number } {
      return sharedGeometry.lifecycle;
    },
    dispose(): void {
      disposed = true;
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      controls.removeEventListener('change', render);
      controls.dispose();
      disposePartMeshes();
      disposePreviewMesh();
      // Shared by every part and every model that was ever loaded, so it is
      // released with the viewport rather than with any one mesh.
      surfaceMaterial.dispose();
      overlays.dispose();
      changeOverlays.dispose();
      holeFillOverlays.dispose();
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
