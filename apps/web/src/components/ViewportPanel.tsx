import { useEffect, useRef, type ReactNode } from 'react';
import { createViewport, type ViewportHandle } from '../viewport/create-viewport';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { StatusSeverity } from '../state/workspace-store';

/**
 * React owns the container element; `createViewport` owns everything inside it.
 *
 * The viewport instance is created once and kept in a ref. Model changes are
 * pushed into it imperatively rather than by recreating it, so switching models
 * does not tear down and rebuild the WebGL context.
 */
export function ViewportPanel(): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<ViewportHandle | undefined>(undefined);
  const store = useWorkspaceStore();
  const { viewportFailure, model } = useWorkspaceState();

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    try {
      const viewport = createViewport(container, {
        onContextLost: () => {
          store.setViewportFailure(
            'The graphics context was lost. Reload the page to restore the viewport.',
          );
          store.pushStatus(StatusSeverity.Error, 'The 3D viewport lost its graphics context.');
        },
      });
      viewportRef.current = viewport;
      store.setViewportFailure(undefined);
      return (): void => {
        viewportRef.current = undefined;
        viewport.dispose();
      };
    } catch (cause) {
      // Surfaced, not swallowed: without WebGL the viewport genuinely cannot run.
      const message =
        cause instanceof Error
          ? `The 3D viewport could not start: ${cause.message}`
          : 'The 3D viewport could not start.';
      store.setViewportFailure(message);
      store.pushStatus(StatusSeverity.Error, message);
      return undefined;
    }
  }, [store]);

  // Depends on the model object itself, which is safe precisely because the
  // store replaces it only on a successful import — unrelated updates such as a
  // status message keep the same reference, so this does not rebuild GPU
  // buffers every time something else in the workspace changes.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;

    if (model === undefined) {
      viewport.setModel(undefined);
      return;
    }

    viewport.setModel({
      positions: model.mesh.positions,
      indices: model.mesh.indices,
      normals: model.renderNormals,
      center: model.bounds?.center ?? [0, 0, 0],
      radius: model.bounds?.radius ?? 1,
      revision: model.revision,
    });
  }, [model]);

  return (
    <section className="viewport" aria-label="3D workspace">
      <div className="viewport__canvas" ref={containerRef} data-testid="viewport-canvas" />

      {viewportFailure !== undefined ? (
        <p className="viewport__error" role="alert" data-testid="viewport-error">
          {viewportFailure}
        </p>
      ) : model === undefined ? (
        <p className="viewport__empty" data-testid="viewport-empty">
          Empty workspace — open an STL file to view it.
        </p>
      ) : (
        <div className="viewport__toolbar">
          <button
            type="button"
            className="viewport__action"
            data-testid="fit-view"
            onClick={() => viewportRef.current?.fitView()}
          >
            Fit view
          </button>
        </div>
      )}
    </section>
  );
}
