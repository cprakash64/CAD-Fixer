/**
 * The five workflows CAD Fixer will offer.
 *
 * `implemented` is the single source of truth for whether a workflow can be
 * entered. Every entry is `false` in Stage 0 and the navigation renders from
 * this list, so a workflow cannot appear enabled until it genuinely exists.
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
    summary: 'Close holes, fix normals, and resolve non-manifold geometry.',
    implemented: false,
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
