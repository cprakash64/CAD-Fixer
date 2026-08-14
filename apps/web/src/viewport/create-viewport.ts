import { AxesHelper, Color, GridHelper, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

/**
 * The 3D workspace viewport.
 *
 * STAGE 0 SCOPE: an empty, correctly-managed scene — ground grid, axes, and a
 * fixed camera. There is no model, no loader, and no camera interaction,
 * because nothing can be imported yet. What this does establish is the parts
 * that are easy to get wrong later: renderer lifecycle, device-pixel-ratio
 * handling, resize observation, context-loss handling, and complete disposal.
 *
 * Written as plain functions rather than a React component so that Three.js
 * never becomes entangled with render cycles. React owns the container element;
 * this module owns everything inside it.
 */

export interface ViewportHandle {
  /** Releases the WebGL context and every GPU resource this viewport created. */
  dispose(): void;
}

export interface ViewportOptions {
  /** Invoked if the WebGL context is lost, so the shell can tell the user. */
  readonly onContextLost?: () => void;
}

/** Guards against enormous framebuffers on high-DPI displays. */
const MAX_PIXEL_RATIO = 2;

const BACKGROUND = new Color('#12161c');
const GRID_MAJOR = new Color('#2c3542');
const GRID_MINOR = new Color('#1d232c');

export function createViewport(
  container: HTMLElement,
  options: ViewportOptions = {},
): ViewportHandle {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, MAX_PIXEL_RATIO));

  const scene = new Scene();
  scene.background = BACKGROUND;

  // 200 mm grid at 10 mm divisions — a print-bed-sized reference, not a model.
  const grid = new GridHelper(200, 20, GRID_MAJOR, GRID_MINOR);
  const axes = new AxesHelper(40);
  scene.add(grid, axes);

  const camera = new PerspectiveCamera(45, 1, 0.1, 5000);
  camera.position.set(180, 140, 180);
  camera.lookAt(0, 0, 0);

  const canvas = renderer.domElement;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Empty 3D workspace. No model is loaded.');
  container.appendChild(canvas);

  const render = (): void => {
    renderer.render(scene, camera);
  };

  const resize = (): void => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    // `updateStyle` is left at its default of true so the canvas CSS size is set
    // alongside the drawing buffer. Skipping it leaves the element sized by its
    // width/height attributes, which include the device pixel ratio — on a HiDPI
    // display that renders the canvas at twice its intended size, pushing the
    // scene off centre and overflowing the layout.
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };

  const handleContextLost = (event: Event): void => {
    // Preventing the default is what makes restoration possible at all.
    event.preventDefault();
    options.onContextLost?.();
  };

  canvas.addEventListener('webglcontextlost', handleContextLost);

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  return {
    dispose(): void {
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', handleContextLost);
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
