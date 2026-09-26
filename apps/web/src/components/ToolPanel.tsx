import { useRef, type ReactNode } from 'react';
import { WORKFLOWS, WorkflowId } from '../state/workflows';
import { useWorkspaceState } from '../state/store-context';
import { useDocumentConversion } from '../state/use-document-conversion';
import { MeshHealthPanel } from './MeshHealthPanel';
import { OpenBoundaryPanel } from './OpenBoundaryPanel';
import { RepairPanel } from './RepairPanel';
import { SplitPanel } from './SplitPanel';
import { StatusPanel } from './StatusPanel';
import { TexturePanel } from './TexturePanel';
import { keepTabWithin } from './shell/focus-trap';
import { IconButton, PrimaryActionButton, WorkspaceHeader } from './shell/primitives';
import { useShellLayout } from './shell/shell-layout';
import { DEFAULT_WORKSPACE, WORKSPACE_PRESENTATION } from './shell/workspaces';

/**
 * The left tool panel: the current workspace's controls.
 *
 * THE REPAIR PANELS ARE HIDDEN, NEVER UNMOUNTED, outside the Repair workspace.
 * Their hooks start the automatic analysis on import, track running worker
 * operations and release candidates when they unmount. Unmounting them on a
 * tab switch would cancel an analysis or discard a validated repair as a side
 * effect of looking at a different workspace. `hidden` takes them out of
 * layout and out of the accessibility tree and ends nothing.
 *
 * Split and Texture decide their own visibility, as they always have, and
 * render nothing outside their workspace.
 *
 * The footer is the activity log. It stays visible in every workspace because
 * it is where every workflow reports what it did.
 */
export function ToolPanel({ inert = false }: { readonly inert?: boolean }): ReactNode {
  const { selectedWorkflow } = useWorkspaceState();
  const layout = useShellLayout();
  const panelRef = useRef<HTMLElement>(null);
  const modal = layout.modalDrawer === 'tool';
  const current = selectedWorkflow ?? DEFAULT_WORKSPACE;
  const presentation = WORKSPACE_PRESENTATION[current];
  const summary = WORKFLOWS.find((workflow) => workflow.id === current)?.summary ?? '';

  return (
    <aside
      ref={panelRef}
      id="tool-panel"
      className="tool-panel"
      aria-label="Workspace tools"
      data-drawer-open={layout.toolDrawerOpen ? 'true' : 'false'}
      data-testid="tool-panel"
      inert={inert}
      tabIndex={-1}
      {...(modal ? { role: 'dialog', 'aria-modal': true } : {})}
      onKeyDown={(event) => {
        if (modal && panelRef.current !== null) keepTabWithin(event, panelRef.current);
      }}
    >
      <div className="tool-panel__header">
        <WorkspaceHeader icon={presentation.icon} name={presentation.name} description={summary} />
        {/* Shown only when the panel is a drawer; the top bar is inert then,
            so the drawer must be closable from inside itself. */}
        <IconButton
          label="Close workspace tools"
          icon="x"
          tooltip="left"
          iconSize={15}
          className="tool-panel__close"
          onClick={layout.closeDrawers}
          testId="close-tool-panel"
        />
      </div>

      <div className="tool-panel__body">
        <div className="tool-panel__group" hidden={current !== WorkflowId.Repair}>
          <RepairPanel />
          {/* Beneath conservative repair, and that order is deliberate: several
              openings are only fillable AFTER neighbouring triangles have been
              made to agree on their winding, so the workflow that can unblock
              this one comes first. */}
          <OpenBoundaryPanel />
          {/* Last, because it is the full report the two workflows above were
              derived from: what CAD Fixer proposes to change comes first. */}
          <MeshHealthPanel />
        </div>
        {current === WorkflowId.Convert ? <ConvertSection /> : null}
        <SplitPanel />
        <TexturePanel />
      </div>

      <div className="tool-panel__footer">
        <StatusPanel />
      </div>
    </aside>
  );
}

/**
 * The Convert workspace's home.
 *
 * Conversion itself is the Export / Convert dialog, which reports what the
 * chosen format keeps before anything is written. This section is the way back
 * into it once the dialog has been closed.
 */
function ConvertSection(): ReactNode {
  const { model } = useWorkspaceState();
  const { open: openConversion } = useDocumentConversion();
  return (
    <section className="panel" aria-labelledby="convert-workspace-title">
      <h2 className="panel__title" id="convert-workspace-title">
        Export / Convert
      </h2>
      <p className="panel__note">
        Writes the whole document — every part — as STL, OBJ or 3MF, after showing what the format
        you choose will keep and what it cannot. Files are written on this device; nothing is
        uploaded.
      </p>
      <PrimaryActionButton
        icon="convert"
        onClick={openConversion}
        disabled={model === undefined}
        testId="convert-workspace-open"
      >
        Choose a format…
      </PrimaryActionButton>
    </section>
  );
}
