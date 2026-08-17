/**
 * The five workflows CAD Fixer will offer.
 *
 * `implemented` is the single source of truth for whether a workflow can be
 * entered. The navigation renders from this list, so a workflow cannot appear
 * enabled until it genuinely exists.
 *
 * REPAIR IS THE FIRST ONE TO FLIP, and its summary was rewritten when it did.
 * The old wording promised closing openings and resolving non-manifold geometry;
 * conservative repair does neither, and a navigation label that describes a
 * capability the screen behind it does not have is the first false claim a user
 * meets. See docs/repair/REPAIR_POLICY.md.
 */

export const WorkflowId = {
  Repair: 'repair',
  Convert: 'convert',
  Split: 'split',
  Texture: 'texture',
  Hollow: 'hollow',
} as const;

export type WorkflowId = (typeof WorkflowId)[keyof typeof WorkflowId];

export interface WorkflowDescriptor {
  readonly id: WorkflowId;
  readonly label: string;
  /** One line describing the eventual capability. Written in the future tense. */
  readonly summary: string;
  readonly implemented: boolean;
}

export const WORKFLOWS: readonly WorkflowDescriptor[] = Object.freeze([
  {
    id: WorkflowId.Repair,
    label: 'Repair',
    summary:
      'Conservative repair: remove exact duplicate and degenerate triangles, and unify relative face winding.',
    implemented: true,
  },
  {
    id: WorkflowId.Convert,
    label: 'Convert',
    summary: 'Translate between STL, OBJ, and 3MF.',
    implemented: false,
  },
  {
    id: WorkflowId.Split,
    label: 'Split',
    summary: 'Cut oversized models into parts and add alignment connectors.',
    implemented: false,
  },
  {
    id: WorkflowId.Texture,
    label: 'Texture',
    summary: 'Apply surface displacement patterns to printable faces.',
    implemented: false,
  },
  {
    id: WorkflowId.Hollow,
    label: 'Hollow',
    summary: 'Hollow solid models and place drainage holes.',
    implemented: false,
  },
]);
