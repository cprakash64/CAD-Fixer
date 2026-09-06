import type { ReactNode } from 'react';
import { AppHeader } from './components/AppHeader';
import { ConvertDialog } from './components/ConvertDialog';
import { ImportDropZone } from './components/ImportDropZone';
import { MeshHealthPanel } from './components/MeshHealthPanel';
import { ModelPanel } from './components/ModelPanel';
import { OpenBoundaryPanel } from './components/OpenBoundaryPanel';
import { PartSelector } from './components/PartSelector';
import { RepairPanel } from './components/RepairPanel';
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
          {/* Above the model facts because it decides what those workflows act
              on. Renders nothing at all for a single-part document, so the STL
              sidebar is unchanged. */}
          <PartSelector />
          <ModelPanel />
          <RuntimePanel />
        </aside>
        <main className="app__main">
          <ViewportPanel />
          <ImportDropZone />
        </main>
        {/* Diagnostics and repair share the right-hand column, in that order of
            action: what CAD Fixer proposes to change comes first, and the full
            report it derived that from sits beneath it. Burying either under the
            model facts would make the things a user opens this tool for the
            hardest to reach. The viewport keeps the middle and stays the working
            area at every width. */}
        <aside className="app__diagnostics">
          <RepairPanel />
          {/* Beneath conservative repair, and that order is deliberate: several
              openings are only fillable AFTER neighbouring triangles have been
              made to agree on their winding, so the workflow that can unblock
              this one comes first. */}
          <OpenBoundaryPanel />
          <MeshHealthPanel />
        </aside>
      </div>
      <StatusPanel />
      {/* Rendered at the shell so it overlays the workspace rather than being
          trapped inside a sidebar panel's scroll region. It renders nothing at
          all until the user opens it. */}
      <ConvertDialog />
    </div>
  );
}
