import type { ReactNode } from 'react';
import type { WorkflowId } from '../state/workflows';
import { useFileIntake } from './FileIntake';
import { Icon } from './shell/Icon';
import { WORKSPACE_PRESENTATION } from './shell/workspaces';

/**
 * What an implemented workspace shows at the top of its panel while no model
 * is open (UI-07A).
 *
 * ONE COMPONENT FOR EVERY WORKSPACE, so four workspaces cannot grow four
 * visual systems: the sentence is the workspace's own, from
 * `WORKSPACE_PRESENTATION`, and everything else is shared. It is deliberately
 * compact — the viewport keeps the large drop target, and this is guidance
 * beside it, not a second one.
 *
 * Open goes through the ONE file intake every import uses. The workspace's own
 * commands below it stay disabled by their own guards; nothing here enables
 * anything.
 */
export function WorkspaceEmptyState({ workflow }: { readonly workflow: WorkflowId }): ReactNode {
  const { openPicker, isImporting } = useFileIntake();
  return (
    <div className="workspace-empty" data-testid="workspace-empty" data-workflow={workflow}>
      <p className="workspace-empty__title">No model loaded</p>
      <p className="workspace-empty__message">{WORKSPACE_PRESENTATION[workflow].emptyMessage}</p>
      <button
        type="button"
        className="secondary-action workspace-empty__open"
        onClick={openPicker}
        disabled={isImporting}
        data-testid={`workspace-empty-open-${workflow}`}
      >
        <Icon name="open" size={14} />
        Open model
      </button>
    </div>
  );
}
