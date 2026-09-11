import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GeometryClientProvider } from './runtime/client-context';
import { GeometryClient } from './runtime/geometry-client';
import { WorkspaceProvider } from './state/store-context';
import { StatusSeverity, WorkspaceStore } from './state/workspace-store';
import './styles/app.css';

const container = document.getElementById('root');
if (container === null) {
  // Thrown rather than logged: without a mount point there is no application,
  // and a silent failure would leave a blank page with no explanation.
  throw new Error('Root container #root is missing from the document.');
}

const store = new WorkspaceStore();

/**
 * The geometry worker is created here, outside React, because its lifetime is
 * the application's lifetime rather than any component's. Constructing it inside
 * a component would mean `StrictMode` builds two of them.
 */
const geometryClient = new GeometryClient({
  onDiagnostic: (message, details): void => {
    store.pushStatus(StatusSeverity.Warning, `${message} (${JSON.stringify(details)})`);
  },
  onWorkerLost: (reason): void => {
    // The worker held the ONLY copy of the authoritative geometry. Nothing is
    // reconstructed from the render snapshot, so the model is discarded rather
    // than left on screen looking operable.
    store.loseGeometrySession(reason);
    store.pushStatus(
      StatusSeverity.Error,
      `${reason} The loaded model was held in that worker and is gone. Re-import the file to continue.`,
    );
  },
});

/*
 * THE BOUNDARY IS OUTSIDE THE PROVIDERS, deliberately.
 *
 * A throw inside a provider's own render would otherwise be outside anything
 * that could catch it, which is the blank-page case this exists to prevent. It
 * renders no geometry and reads no store, so it cannot itself be the thing that
 * fails.
 */
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <WorkspaceProvider store={store}>
        <GeometryClientProvider client={geometryClient}>
          <App />
        </GeometryClientProvider>
      </WorkspaceProvider>
    </ErrorBoundary>
  </StrictMode>,
);
