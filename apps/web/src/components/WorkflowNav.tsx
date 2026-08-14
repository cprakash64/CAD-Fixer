import type { ReactNode } from 'react';
import { WORKFLOWS } from '../state/workflows';
import { useWorkspaceState } from '../state/store-context';

/**
 * Workflow navigation.
 *
 * Every item renders from `WORKFLOWS[].implemented`, which is `false` for all
 * five in Stage 0. Items are real `<button>` elements with `disabled` and an
 * explicit status label, so assistive technology reports the same thing the
 * visual design does: these do not work yet.
 */
export function WorkflowNav(): ReactNode {
  const { selectedWorkflow } = useWorkspaceState();

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
