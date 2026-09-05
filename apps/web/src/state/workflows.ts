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
    /*
     * FLIPPED IN STAGE 4A-2B3, and the summary was rewritten with it for the
     * same reason Repair's was: the old line promised translation between three
     * formats while the product could write exactly one of them.
     *
     * It says WHOLE DOCUMENT because that is the distinguishing fact — the
     * active-part STL export in the Model panel is a different, smaller thing —
     * and it promises a report rather than fidelity, because what survives
     * depends on the model and on the target and is answered per conversion.
     */
    id: WorkflowId.Convert,
    label: 'Convert',
    summary:
      'Save the whole document as STL, OBJ or 3MF, after reading what the chosen format keeps and what it cannot.',
    implemented: true,
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
