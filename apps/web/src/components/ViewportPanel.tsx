import { useEffect, useRef, type ReactNode } from 'react';
import { createViewport } from '../viewport/create-viewport';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { StatusSeverity } from '../state/workspace-store';

/**
 * React owns the container element; `createViewport` owns everything inside it.
 *
 * Failures are written to the workspace store rather than to component state,
 * so a machine without WebGL gets a visible explanation in both the viewport
 * and the status log instead of a blank panel.
 */
export function ViewportPanel(): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const store = useWorkspaceStore();
  const { viewportFailure, hasModel } = useWorkspaceState();

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
      store.setViewportFailure(undefined);
      return (): void => {
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

  return (
    <section className="viewport" aria-label="3D workspace">
      <div className="viewport__canvas" ref={containerRef} data-testid="viewport-canvas" />
      {viewportFailure !== undefined ? (
        <p className="viewport__error" role="alert" data-testid="viewport-error">
          {viewportFailure}
        </p>
      ) : hasModel ? null : (
        <p className="viewport__empty" data-testid="viewport-empty">
          Empty workspace — model import is not implemented yet.
        </p>
      )}
    </section>
  );
}
