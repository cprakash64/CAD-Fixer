import type { ReactNode } from 'react';
import { WORKFLOWS } from '../state/workflows';
import { useWorkspaceState } from '../state/store-context';
import { Icon } from './shell/Icon';
import { useEnterWorkspace } from './shell/open-convert';
import {
  COMING_SOON,
  DEFAULT_WORKSPACE,
  WORKSPACE_PRESENTATION,
  isWorkspaceAvailable,
} from './shell/workspaces';

/**
 * The workspace navigation: the ONE place a desktop user changes workspace.
 *
 * A `<nav>` of ordinary buttons, with `aria-current="page"` on the current one.
 * Not a tablist: the workspaces are not panels of one widget — each keeps its
 * own mounted state and the inspector and viewport change with it — and a
 * tablist would promise arrow-key roving that plain navigation does not need.
 *
 * AN IMPLEMENTED WORKSPACE IS ALWAYS ENTERABLE, model or no model. What it
 * needs to do its work it says inside itself, and its commands keep their own
 * guards (UI-07A).
 *
 * A WORKSPACE THAT DOES NOT EXIST YET STAYS VISIBLE AND FOCUSABLE, and does
 * nothing. It is `aria-disabled` rather than `disabled` so keyboard focus can
 * reach it and reveal the same "coming soon" tooltip a pointer gets; the word
 * travels in its accessible name and in a visible badge, so the state is never
 * carried by colour alone. Activation goes through `useEnterWorkspace`, which
 * refuses it before the store is touched.
 *
 * Below the desktop tier the tabs do not fit and `WorkspaceSwitcher` replaces
 * them; CSS shows exactly one of the two at any width.
 */
export function WorkflowNav(): ReactNode {
  const { selectedWorkflow } = useWorkspaceState();
  const enter = useEnterWorkspace();
  const current = selectedWorkflow ?? DEFAULT_WORKSPACE;

  return (
    <nav className="workspace-tabs" aria-label="Workspaces" data-testid="workspace-nav">
      {WORKFLOWS.map((workflow) => {
        const presentation = WORKSPACE_PRESENTATION[workflow.id];
        const available = isWorkspaceAvailable(workflow);
        const active = available && current === workflow.id;
        return (
          <button
            key={workflow.id}
            type="button"
            className="workspace-tabs__tab"
            data-testid={`workflow-${workflow.id}`}
            data-tooltip={
              available ? workflow.summary : `${presentation.name} — ${COMING_SOON.toLowerCase()}`
            }
            data-tooltip-side="below"
            aria-disabled={available ? undefined : true}
            // The badge is decorative; the name says it in words.
            aria-label={
              available ? undefined : `${presentation.name} — ${COMING_SOON.toLowerCase()}`
            }
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              enter(workflow.id);
            }}
          >
            <Icon name={presentation.icon} size={15} className="workspace-tabs__icon" />
            <span className="workspace-tabs__label">{presentation.name}</span>
            {available ? null : (
              <span className="workspace-tabs__soon" aria-hidden="true">
                Soon
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
