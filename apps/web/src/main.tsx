import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WorkspaceProvider } from './state/store-context';
import { WorkspaceStore } from './state/workspace-store';
import './styles/app.css';

const container = document.getElementById('root');
if (container === null) {
  // Thrown rather than logged: without a mount point there is no application,
  // and a silent failure would leave a blank page with no explanation.
  throw new Error('Root container #root is missing from the document.');
}

const store = new WorkspaceStore();

createRoot(container).render(
  <StrictMode>
    <WorkspaceProvider store={store}>
      <App />
    </WorkspaceProvider>
  </StrictMode>,
);
