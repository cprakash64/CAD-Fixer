import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
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
});

createRoot(container).render(
  <StrictMode>
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={geometryClient}>
        <App />
      </GeometryClientProvider>
    </WorkspaceProvider>
  </StrictMode>,
);
