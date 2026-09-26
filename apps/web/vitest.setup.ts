import '@testing-library/jest-dom/vitest';

/**
 * jsdom implements neither WebGL, `ResizeObserver`, nor `Worker`, all of which
 * the shell touches on mount. They are stubbed so component tests can mount the
 * real application rather than a trimmed-down copy of it.
 *
 * This is a deliberate, declared limitation. These tests verify the shell's
 * structure and behaviour; they do NOT verify rendering or worker execution.
 * Those are covered by the Playwright suite, which runs a real browser against
 * the production build.
 */

class ResizeObserverStub implements ResizeObserver {
  public observe(): void {
    // Inert: jsdom performs no layout, so there is nothing to observe.
  }

  public unobserve(): void {
    // Inert, as above.
  }

  public disconnect(): void {
    // Inert, as above.
  }
}

globalThis.ResizeObserver = ResizeObserverStub;

/*
 * jsdom has no `matchMedia` either. The stub answers "does not match" for
 * every query, which is the desktop layout: no panel is a drawer, so nothing
 * is modal and nothing is inert — the layout every component test assumes.
 * Drawer behaviour is layout, and is proven in a real browser in
 * e2e/ui-shell.spec.ts.
 */
if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    addListener: (): void => undefined,
    removeListener: (): void => undefined,
    dispatchEvent: (): boolean => false,
  });
}

/**
 * Inert worker. It never replies, so a component test that depended on a worker
 * result would hang rather than pass against a fake — which is intended: worker
 * results are proven end to end, never simulated.
 */
class WorkerStub extends EventTarget {
  public postMessage(): void {
    // Inert: messages are intentionally dropped.
  }

  public terminate(): void {
    // Inert: there is no thread to stop.
  }
}

globalThis.Worker = WorkerStub as unknown as typeof Worker;

// Three.js throws when it cannot acquire a WebGL context. Returning null makes
// that deterministic in jsdom, and the viewport surfaces it as a visible error
// instead of crashing the application.
HTMLCanvasElement.prototype.getContext = (): null => null;
