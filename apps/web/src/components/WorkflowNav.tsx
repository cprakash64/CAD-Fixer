import type { ReactNode } from 'react';
import { WORKFLOWS, WorkflowId } from '../state/workflows';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { useDocumentConversion } from '../state/use-document-conversion';

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
 *
 * Selecting Convert opens the Export / Convert dialog, for the same reason.
 * It is disabled with an explicit reason when no model is loaded: a workflow
 * that exists but has nothing to act on must say so, rather than opening onto
 * an empty panel — which is the same failure as a control that does nothing.
 */
export function WorkflowNav(): ReactNode {
  const { selectedWorkflow, model } = useWorkspaceState();
  const store = useWorkspaceStore();
  const { open: openConversion } = useDocumentConversion();

  return (
    <nav className="workflow-nav" aria-label="Workflows">
      <h2 className="workflow-nav__heading" id="workflow-nav-heading">
        Workflows
      </h2>
      <ul className="workflow-nav__list" aria-labelledby="workflow-nav-heading">
        {WORKFLOWS.map((workflow) => {
          const needsModel = workflow.id === WorkflowId.Convert && model === undefined;
          return (
            <li key={workflow.id}>
              <button
                type="button"
                className="workflow-nav__item"
                data-testid={`workflow-${workflow.id}`}
                disabled={!workflow.implemented || needsModel}
                aria-current={selectedWorkflow === workflow.id ? 'page' : undefined}
                aria-describedby={`workflow-${workflow.id}-summary`}
                onClick={() => {
                  store.selectWorkflow(workflow.id);
                  if (workflow.id === WorkflowId.Convert) openConversion();
                }}
              >
                <span className="workflow-nav__label">{workflow.label}</span>
                {workflow.implemented ? null : (
                  <span className="workflow-nav__badge">Not implemented</span>
                )}
                {needsModel ? (
                  <span className="workflow-nav__badge">Open a model first</span>
                ) : null}
              </button>
              <p className="workflow-nav__summary" id={`workflow-${workflow.id}-summary`}>
                {workflow.summary}
              </p>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
