import type { ReactNode } from 'react';
import { FileIntakeProvider } from './components/FileIntake';
import { ImportDropZone } from './components/ImportDropZone';
import { Inspector } from './components/Inspector';
import { StatusBar } from './components/StatusBar';
import { ToolPanel } from './components/ToolPanel';
import { TopBar } from './components/TopBar';
import { ViewportPanel } from './components/ViewportPanel';
import { ShellLayoutProvider, useShellLayout } from './components/shell/shell-layout';
import { WorkflowControllersProvider } from './state/workflow-controllers';

/**
 * Application shell.
 *
 * Layout only. No geometry, no file parsing, and no data transformation happens
 * at this level or anywhere below it in the component tree — the UI layer
 * dispatches to the geometry runtime and renders what comes back.
 *
 *   ┌──────────────────────── top bar (48) ────────────────────────┐
 *   │ tool panel (300) │        viewport (flex)        │ inspector │
 *   │                  │                               │   (280)   │
 *   └─────────────────────── status bar (30) ──────────────────────┘
 *
 * THE VIEWPORT IS THE ONLY FLEXIBLE REGION, and it is sized by layout alone:
 * the renderer observes its own container, so opening, closing or collapsing a
 * panel resizes the canvas through the same `ResizeObserver` as a window
 * resize. Below the docked widths the panels become drawers laid OVER the
 * viewport, which then does not resize at all.
 */
export function App(): ReactNode {
  return (
    <ShellLayoutProvider>
      <FileIntakeProvider>
        <WorkflowControllersProvider>
          <Shell />
        </WorkflowControllersProvider>
      </FileIntakeProvider>
    </ShellLayoutProvider>
  );
}

function Shell(): ReactNode {
  const layout = useShellLayout();
  const drawerOpen = layout.toolDrawerOpen || layout.inspectorDrawerOpen;
  // While a drawer is a modal, everything outside it is inert: not focusable,
  // not clickable, and absent from the accessibility tree. Docked panels are
  // never modal, so at desktop widths nothing is ever made inert.
  const modal = layout.modalDrawer;

  return (
    <div
      className="app"
      data-tool-drawer={layout.toolDrawerOpen ? 'open' : 'closed'}
      data-inspector-drawer={layout.inspectorDrawerOpen ? 'open' : 'closed'}
    >
      <div className="app__contents" inert={modal !== undefined}>
        <TopBar />
      </div>
      <div className="app__body">
        <ToolPanel inert={modal === 'inspector'} />
        <main className="app__main" inert={modal !== undefined}>
          <ImportDropZone>
            <ViewportPanel />
          </ImportDropZone>
        </main>
        <Inspector inert={modal === 'tool'} />
        {/* The scrim exists only while a drawer is open, and only drawers
            below the docked widths are ever open, so it never covers a docked
            layout. Clicking it is the pointer equivalent of Esc. */}
        {drawerOpen ? (
          <div
            className="app__scrim"
            aria-hidden="true"
            onClick={layout.closeDrawers}
            data-testid="drawer-scrim"
          />
        ) : null}
      </div>
      <div className="app__contents" inert={modal !== undefined}>
        <StatusBar />
      </div>
    </div>
  );
}
