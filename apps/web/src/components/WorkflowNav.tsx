import type { ReactNode } from 'react';
import { WORKFLOWS, WorkflowId } from '../state/workflows';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { Icon } from './shell/Icon';
import { useOpenConvertWorkspace } from './shell/open-convert';
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_PRESENTATION,
  workflowUnavailableReason,
} from './shell/workspaces';

/**
 * Workflow navigation, drawn as the top bar's workspace tabs.
 *
 * Every item renders from `WORKFLOWS[].implemented`. Items are real `<button>`
 * elements with `disabled`, so assistive technology reports the same thing the
 * visual design does: the unavailable ones do not work yet.
 *
 * EVERY DISABLED TAB SAYS WHY, in its own text. A disabled button with no
 * reason is indistinguishable from a broken one. The reason is part of the
 * button's accessible name and its tooltip, and is set visually hidden so the
 * tab strip keeps the reference's density; the workspace menu beside it shows
 * the same reasons as visible badges.
 *
 * Selecting a workspace shows its panels in the tool panel; Convert goes
 * through the same route as every Export button, so it also reveals the tool
 * drawer on a narrow screen. Convert is disabled with an explicit reason when
 * no model is loaded: a workflow that exists but has nothing to act on must
 * say so.
 */
export function WorkflowNav(): ReactNode {
  const { selectedWorkflow, model } = useWorkspaceState();
  const store = useWorkspaceStore();
  const openConvert = useOpenConvertWorkspace();
  const current = selectedWorkflow ?? DEFAULT_WORKSPACE;

  return (
    <nav className="workspace-tabs" aria-label="Workflows">
      {WORKFLOWS.map((workflow) => {
        const presentation = WORKSPACE_PRESENTATION[workflow.id];
        const reason = workflowUnavailableReason(workflow, model !== undefined);
        const active = workflow.implemented && current === workflow.id;
        return (
          <button
            key={workflow.id}
            type="button"
            className="workspace-tabs__tab"
            data-testid={`workflow-${workflow.id}`}
            data-tooltip={
              reason === undefined ? workflow.summary : `${presentation.name} — ${reason}`
            }
            data-tooltip-side="below"
            disabled={reason !== undefined}
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              if (workflow.id === WorkflowId.Convert) openConvert();
              else store.selectWorkflow(workflow.id);
            }}
          >
            <Icon name={presentation.icon} size={15} className="workspace-tabs__icon" />
            {presentation.name}
            {reason === undefined ? null : <span className="visually-hidden"> — {reason}</span>}
          </button>
        );
      })}
    </nav>
  );
}
