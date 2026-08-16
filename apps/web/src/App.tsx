import type { ReactNode } from 'react';
import { AppHeader } from './components/AppHeader';
import { ImportDropZone } from './components/ImportDropZone';
import { MeshHealthPanel } from './components/MeshHealthPanel';
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
        {/* Diagnostics get their own column rather than sharing the sidebar:
            the report is long, and burying it under the model facts would make
            the numbers a user opens this tool for the hardest thing to reach.
            The viewport keeps the middle and stays the working area. */}
        <aside className="app__diagnostics">
          <MeshHealthPanel />
        </aside>
      </div>
      <StatusPanel />
    </div>
  );
}
