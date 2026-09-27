import { useId, type ReactNode } from 'react';
import { WORKFLOWS } from '../state/workflows';
import { useWorkspaceState } from '../state/store-context';
import { Icon } from './shell/Icon';
import { useEnterWorkspace } from './shell/open-convert';
import { useDismissableMenu } from './shell/shell-layout';
import {
  COMING_SOON,
  DEFAULT_WORKSPACE,
  WORKSPACE_PRESENTATION,
  isWorkspaceAvailable,
} from './shell/workspaces';

/**
 * The COMPACT workspace switcher, for widths where the centred workspace
 * navigation does not fit.
 *
 * NEVER A SECOND DESKTOP NAVIGATION. Until UI-07A this dropdown sat beside the
 * tabs at every desktop width and listed the same five choices; now CSS shows
 * it only below the desktop tier, where it REPLACES `WorkflowNav`, so exactly
 * one workspace selector is on screen at any width.
 *
 * Same rules as the tabs, through the same `useEnterWorkspace`: every
 * implemented workspace is selectable with or without a model, and a
 * workspace that does not exist yet is shown, announced unavailable, badged
 * "Coming soon" in text and does nothing when chosen. Its menu has room for
 * the one-line summary the tabs carry only as a tooltip — which matters here,
 * because a touch screen has no hover.
 */
export function WorkspaceSwitcher(): ReactNode {
  const { selectedWorkflow } = useWorkspaceState();
  const enter = useEnterWorkspace();
  const { open, toggle, close, containerRef } = useDismissableMenu();
  const menuId = useId();
  const current = selectedWorkflow ?? DEFAULT_WORKSPACE;
  const presentation = WORKSPACE_PRESENTATION[current];

  return (
    <div className="workspace-switcher" ref={containerRef}>
      <button
        type="button"
        className="workspace-switcher__trigger"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
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
              const available = isWorkspaceAvailable(workflow);
              const active = available && current === workflow.id;
              return (
                <li key={workflow.id}>
                  <button
                    type="button"
                    className="menu__item workspace-switcher__option"
                    aria-current={active ? 'page' : undefined}
                    aria-disabled={available ? undefined : true}
                    data-testid={`workspace-option-${workflow.id}`}
                    onClick={() => {
                      // Choosing what does not exist leaves the menu open on
                      // its "Coming soon" badge rather than closing on nothing.
                      if (!available) return;
                      close();
                      enter(workflow.id);
                    }}
                  >
                    <Icon name={option.icon} size={16} className="menu__item-icon" />
                    <span className="menu__item-text">
                      <span className="menu__item-title">{option.name}</span>
                      <span className="menu__item-detail">{workflow.summary}</span>
                    </span>
                    {available ? null : <span className="menu__badge">{COMING_SOON}</span>}
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
