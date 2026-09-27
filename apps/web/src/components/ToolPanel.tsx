import { useRef, type ReactNode } from 'react';
import { WORKFLOWS, WorkflowId } from '../state/workflows';
import { useWorkspaceState } from '../state/store-context';
import { ConvertWorkspace } from './ConvertWorkspace';
import { MeshAnalysisSection } from './MeshAnalysisSection';
import { MeshHealthPanel } from './MeshHealthPanel';
import { OpenBoundaryPanel } from './OpenBoundaryPanel';
import { RepairPanel } from './RepairPanel';
import { SplitWorkspace } from './SplitWorkspace';
import { StatusPanel } from './StatusPanel';
import { TexturePanel } from './TexturePanel';
import { keepTabWithin } from './shell/focus-trap';
import { IconButton, PanelSection, WorkspaceHeader } from './shell/primitives';
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
 * The Convert and Split & Connect workspaces are hidden rather than unmounted
 * for the same reason. Texture decides its own visibility, as it always has,
 * and renders nothing outside its workspace.
 *
 * The footer is the activity log. It stays visible in every workspace because
 * it is where every workflow reports what it did.
 */
export function ToolPanel({ inert = false }: { readonly inert?: boolean }): ReactNode {
  const { selectedWorkflow, repair } = useWorkspaceState();
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
          {/* What the checks found comes first, then what CAD Fixer can do
              about it, then the per-boundary workflow, then the full report
              every row above was derived from. */}
          <MeshAnalysisSection />
          <PanelSection
            title="Auto repair"
            testId="auto-repair"
            meta={`${String(repair.selection.length)} of 4 selected`}
          >
            <RepairPanel />
          </PanelSection>
          {/* Beneath conservative repair, and that order is deliberate: several
              openings are only fillable AFTER neighbouring triangles have been
              made to agree on their winding, so the workflow that can unblock
              this one comes first. */}
          <OpenBoundaryPanel />
          {/* Last, because it is the full report the two workflows above were
              derived from: what CAD Fixer proposes to change comes first. */}
          <MeshHealthPanel />
        </div>
        {/* Hidden, never unmounted, for the Repair panels' reason: its hook
            cancels the export it started when it unmounts, and looking at
            another workspace is not a reason to throw a file away. */}
        <div className="tool-panel__group" hidden={current !== WorkflowId.Convert}>
          <ConvertWorkspace active={current === WorkflowId.Convert} />
        </div>
        <div className="tool-panel__group" hidden={current !== WorkflowId.Split}>
          <SplitWorkspace />
        </div>
        <TexturePanel />
      </div>

      <div className="tool-panel__footer">
        <StatusPanel />
      </div>
    </aside>
  );
}
