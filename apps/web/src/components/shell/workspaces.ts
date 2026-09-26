import { WorkflowId, type WorkflowDescriptor } from '../../state/workflows';
import type { IconName } from './Icon';

/**
 * How each workflow is presented as a workspace: its display name and icon.
 *
 * `WORKFLOWS` stays the single source of truth for WHETHER a workflow exists
 * and what it does; this adds only what the shell draws. Presentation lives
 * beside the components rather than in `state/workflows.ts`, which has no
 * reason to know about icons.
 *
 * THE NAMES MAY NOT PROMISE MORE THAN THE WORKFLOW DOES. The reference design
 * calls the first workspace "Repair & Optimize"; CAD Fixer's repair is the
 * conservative repair and nothing reduces a triangle count, so it is "Repair".
 * "Split & Connect" and "Surface Texture" describe what those workflows
 * genuinely do — cutting with connectors, and patterning selected surfaces.
 */
export interface WorkspacePresentation {
  readonly name: string;
  readonly icon: IconName;
}

export const WORKSPACE_PRESENTATION: Readonly<Record<WorkflowId, WorkspacePresentation>> = {
  [WorkflowId.Repair]: { name: 'Repair', icon: 'repair' },
  [WorkflowId.Convert]: { name: 'Convert', icon: 'convert' },
  [WorkflowId.Split]: { name: 'Split & Connect', icon: 'split' },
  [WorkflowId.Texture]: { name: 'Surface Texture', icon: 'texture' },
  [WorkflowId.Hollow]: { name: 'Hollow', icon: 'hollow' },
};

/** Which workflows have nothing to act on until a model is open. */
function workflowNeedsModel(workflow: WorkflowId): boolean {
  return (
    workflow === WorkflowId.Convert ||
    workflow === WorkflowId.Split ||
    workflow === WorkflowId.Texture
  );
}

/**
 * Why a workflow cannot be entered right now, or `undefined` when it can.
 *
 * THREE STATES, and they are kept apart: a workflow that does not exist says
 * so, and one that exists but has nothing to act on says THAT instead. Both
 * switchers read this one function, so they cannot give different reasons.
 */
export function workflowUnavailableReason(
  workflow: WorkflowDescriptor,
  hasModel: boolean,
): 'Not implemented' | 'Open a model first' | undefined {
  if (!workflow.implemented) return 'Not implemented';
  if (workflowNeedsModel(workflow.id) && !hasModel) return 'Open a model first';
  return undefined;
}

/**
 * The workspace the shell shows when the user has not chosen one.
 *
 * Repair, because it is the one workflow available on an empty workspace and
 * the one whose panels were always on screen before workspaces existed.
 */
export const DEFAULT_WORKSPACE: WorkflowId = WorkflowId.Repair;
