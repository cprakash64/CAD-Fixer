import type { ReactNode } from 'react';
import { WORKFLOWS } from '../state/workflows';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';

/**
 * Workflow navigation.
 *
 * Every item renders from `WORKFLOWS[].implemented`. Items are real `<button>`
 * elements with `disabled` and an explicit status label, so assistive technology
 * reports the same thing the visual design does: the unimplemented ones do not
 * work yet.
 *
 * Selecting Repair moves attention to the repair panel, which is always on
 * screen. The button therefore does something real — it focuses the panel's
 * heading — rather than only highlighting itself, which would be a control that
 * appears to work and does not.
 */
export function WorkflowNav(): ReactNode {
  const { selectedWorkflow } = useWorkspaceState();
  const store = useWorkspaceStore();

  return (
    <nav className="workflow-nav" aria-label="Workflows">
      <h2 className="workflow-nav__heading" id="workflow-nav-heading">
        Workflows
      </h2>
      <ul className="workflow-nav__list" aria-labelledby="workflow-nav-heading">
        {WORKFLOWS.map((workflow) => (
          <li key={workflow.id}>
            <button
              type="button"
              className="workflow-nav__item"
              data-testid={`workflow-${workflow.id}`}
              disabled={!workflow.implemented}
              aria-current={selectedWorkflow === workflow.id ? 'page' : undefined}
              aria-describedby={`workflow-${workflow.id}-summary`}
              onClick={() => {
                store.selectWorkflow(workflow.id);
              }}
            >
              <span className="workflow-nav__label">{workflow.label}</span>
              {workflow.implemented ? null : (
                <span className="workflow-nav__badge">Not implemented</span>
              )}
            </button>
            <p className="workflow-nav__summary" id={`workflow-${workflow.id}-summary`}>
              {workflow.summary}
            </p>
          </li>
        ))}
      </ul>
    </nav>
  );
}
