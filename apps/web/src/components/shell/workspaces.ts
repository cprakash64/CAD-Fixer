import { WorkflowId, type WorkflowDescriptor } from '../../state/workflows';
import type { IconName } from './Icon';

/**
 * How each workflow is presented as a workspace: its display name, its icon,
 * and what its empty state says when no model is open.
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
  /**
   * What the workspace offers once a model is open, shown inside it while none
   * is. Only an implemented workspace can be entered, so Hollow's is never
   * drawn; it is written anyway so the record stays total.
   */
  readonly emptyMessage: string;
}

export const WORKSPACE_PRESENTATION: Readonly<Record<WorkflowId, WorkspacePresentation>> = {
  [WorkflowId.Repair]: {
    name: 'Repair',
    icon: 'repair',
    emptyMessage: 'Open a 3D model to analyze and repair mesh issues.',
  },
  [WorkflowId.Convert]: {
    name: 'Convert',
    icon: 'convert',
    emptyMessage: 'Open a 3D model to convert or export it.',
  },
  [WorkflowId.Split]: {
    name: 'Split & Connect',
    icon: 'split',
    emptyMessage: 'Open a 3D model to split it into parts.',
  },
  [WorkflowId.Texture]: {
    name: 'Surface Texture',
    icon: 'texture',
    emptyMessage: 'Open a 3D model to add surface texture.',
  },
  [WorkflowId.Hollow]: {
    name: 'Hollow',
    icon: 'hollow',
    emptyMessage: 'Hollow is coming soon.',
  },
};

/**
 * The one word the navigation uses for a workflow that does not exist yet.
 * Both switchers read it, so the desktop tabs and the compact menu cannot say
 * different things about the same workspace.
 */
export const COMING_SOON = 'Coming soon';

/**
 * Whether a workspace can be ENTERED — which is a statement about the product,
 * never about the model on screen.
 *
 * NAVIGATION AVAILABILITY IS NOT OPERATION AVAILABILITY. Every implemented
 * workspace opens with or without a model, and says inside itself what it
 * needs; the commands in it keep their own guards. UI-07A removed the old
 * "Open a model first" state from navigation because a workflow drawn disabled
 * on an empty workspace reads as a workflow CAD Fixer does not have.
 */
export function isWorkspaceAvailable(workflow: WorkflowDescriptor): boolean {
  return workflow.implemented;
}

/**
 * The workspace the shell shows when the user has not chosen one.
 *
 * Repair, because it is the one whose panels were always on screen before
 * workspaces existed.
 */
export const DEFAULT_WORKSPACE: WorkflowId = WorkflowId.Repair;
