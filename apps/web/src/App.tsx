import type { ReactNode } from 'react';
import { AppHeader } from './components/AppHeader';
import { ImportDropZone } from './components/ImportDropZone';
import { ModelPanel } from './components/ModelPanel';
import { RuntimePanel } from './components/RuntimePanel';
import { StatusPanel } from './components/StatusPanel';
import { ViewportPanel } from './components/ViewportPanel';
import { WorkflowNav } from './components/WorkflowNav';

/**
 * Application shell.
 *
 * Layout only. No geometry, no file parsing, and no data transformation happens
 * at this level or anywhere below it in the component tree — the UI layer
 * dispatches to the geometry runtime and renders what comes back.
 */
export function App(): ReactNode {
  return (
    <div className="app">
      <AppHeader />
      <div className="app__body">
        <aside className="app__sidebar">
          <WorkflowNav />
          <ModelPanel />
          <RuntimePanel />
        </aside>
        <main className="app__main">
          <ViewportPanel />
          <ImportDropZone />
        </main>
      </div>
      <StatusPanel />
    </div>
  );
}
