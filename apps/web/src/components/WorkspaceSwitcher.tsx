import { useId, type ReactNode } from 'react';
import { WORKFLOWS, WorkflowId } from '../state/workflows';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { useDocumentConversion } from '../state/use-document-conversion';
import { Icon } from './shell/Icon';
import { useDismissableMenu } from './shell/shell-layout';
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_PRESENTATION,
  workflowUnavailableReason,
} from './shell/workspaces';

/**
 * The workspace dropdown.
 *
 * The same five workflows as the tab strip, with the same rules, in a menu that
 * has room to say more: each entry carries its one-line summary and, when it is
 * unavailable, a visible badge naming why. On narrow screens it is the only
 * switcher, because the tabs do not fit.
 *
 * It calls exactly what the tabs call — `selectWorkflow`, and `open` for
 * Convert — so the two switchers cannot drift into different behaviour.
 */
export function WorkspaceSwitcher(): ReactNode {
  const { selectedWorkflow, model } = useWorkspaceState();
  const store = useWorkspaceStore();
  const { open: openConversion } = useDocumentConversion();
  const { open, toggle, close, containerRef } = useDismissableMenu();
  const menuId = useId();
  const current = selectedWorkflow ?? DEFAULT_WORKSPACE;
  const presentation = WORKSPACE_PRESENTATION[current];

  return (
    <div className="workspace-switcher" ref={containerRef}>
      <button
        type="button"
        className="workspace-switcher__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Workspace: ${presentation.name}. Change workspace`}
        onClick={toggle}
        data-testid="workspace-switcher"
      >
        <Icon name={presentation.icon} size={15} className="workspace-switcher__icon" />
        <span className="workspace-switcher__name">{presentation.name}</span>
        <Icon name="chev-down" size={14} className="workspace-switcher__chevron" />
      </button>

      {open ? (
        <div className="menu workspace-switcher__menu" id={menuId}>
          <p className="menu__eyebrow">Workspace</p>
          <ul className="menu__list">
            {WORKFLOWS.map((workflow) => {
              const option = WORKSPACE_PRESENTATION[workflow.id];
              const reason = workflowUnavailableReason(workflow, model !== undefined);
              const active = workflow.implemented && current === workflow.id;
              return (
                <li key={workflow.id}>
                  <button
                    type="button"
                    className="menu__item workspace-switcher__option"
                    aria-current={active ? 'page' : undefined}
                    disabled={reason !== undefined}
                    data-testid={`workspace-option-${workflow.id}`}
                    onClick={() => {
                      close();
                      store.selectWorkflow(workflow.id);
                      if (workflow.id === WorkflowId.Convert) openConversion();
                    }}
                  >
                    <Icon name={option.icon} size={16} className="menu__item-icon" />
                    <span className="menu__item-text">
                      <span className="menu__item-title">{option.name}</span>
                      <span className="menu__item-detail">{workflow.summary}</span>
                    </span>
                    {reason === undefined ? null : <span className="menu__badge">{reason}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
