/**
 * SCORING MODEL AND HARD GATES — frozen before Stage 3A-2 runs.
 *
 * Written down now, deliberately, while no benchmark numbers exist. Weights
 * chosen after seeing results are not weights; they are a rationalisation of a
 * decision already made. If a weight turns out to be wrong, changing it is a
 * decision to record and justify, not a quiet edit.
 *
 * THE DOMINANCE RULE: correctness outweighs everything else combined. A fast,
 * small, permissively licensed kernel that silently corrupts geometry is worse
 * than no kernel, because it moves the failure from "we cannot do this yet" to
 * "we damaged the user's model".
 */

export interface ScoringDimension {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly rationale: string;
  readonly measures: readonly string[];
}

/** Weights sum to 100. Correctness alone is more than half. */
export const SCORING_MODEL: readonly ScoringDimension[] = [
  {
    id: 'correctness',
    label: 'Correctness and reliability',
    weight: 55,
    rationale:
      'A repair tool that returns wrong geometry is worse than one that refuses. This weight is set so no combination of the other dimensions can outvote it.',
    measures: [
      'fixes the defect the fixture contains',
      'introduces no new topological defect',
      'passes our independent structural and topology validation',
      'deterministic across repeated identical runs',
      'idempotent where the operation class requires it',
      'control fixtures come back unchanged',
    ],
  },
  {
    id: 'preservation',
    label: 'Geometry preservation',
    weight: 15,
    rationale:
      'The user asked for their model repaired, not replaced. A kernel that reaches a clean result by rebuilding the surface has solved a different problem, and the metrics must be able to tell.',
    measures: [
      'minimal unnecessary vertex movement',
      'thin features survive (R22)',
      'intentional openings survive (R09)',
      'disjoint shells stay disjoint (R15, R21)',
      'area and volume change only as the operation requires',
    ],
  },
  {
    id: 'coverage',
    label: 'Defect coverage',
    weight: 10,
    rationale:
      'Breadth matters, but only after correctness. Scored per ROLE: a boolean kernel is not penalised for lacking hole filling, because it is not competing for that role.',
    measures: ['defect classes handled within the role being scored'],
  },
  {
    id: 'browser',
    label: 'Browser suitability',
    weight: 10,
    rationale:
      'CAD Fixer is local-first and runs in a tab. A kernel that cannot be cancelled, or that grows memory without bound, is unusable here regardless of its geometry quality — several of these are also hard gates.',
    measures: [
      'WASM artifact builds and runs',
      'initialisation cost',
      'peak heap and whether disposal returns it',
      'worker integration',
      'cancellation feasibility',
    ],
  },
  {
    id: 'performance',
    label: 'Performance',
    weight: 5,
    rationale:
      'Deliberately small. Analysis at 100 MiB already takes ~1.3 s and nobody has complained; correctness problems at that size would be fatal. Speed is a tiebreaker, not a selector.',
    measures: ['runtime per operation', 'scaling with model size'],
  },
  {
    id: 'productFit',
    label: 'Product fit',
    weight: 5,
    rationale:
      'Licence, maintenance, bundle cost, integration complexity. Low weight because the disqualifying part of licensing is a hard gate rather than a score.',
    measures: ['licence compatibility', 'upstream activity', 'artifact size', 'binding effort'],
  },
];

export const TOTAL_WEIGHT = SCORING_MODEL.reduce((sum, entry) => sum + entry.weight, 0);

/**
 * Failures that disqualify a candidate for a ROLE regardless of weighted score.
 *
 * Defined before any benchmark output exists, so a gate cannot be softened
 * because a favourite candidate tripped it.
 */
export interface HardGate {
  readonly id: string;
  readonly statement: string;
  readonly rationale: string;
}

export const HARD_GATES: readonly HardGate[] = [
  {
    id: 'licence-incompatible',
    statement:
      'The candidate, or any component that survives into our linked artifact, carries a licence incompatible with a proprietary product.',
    rationale:
      'Project rule 17. Applies transitively: Geogram bundles AGPL tetgen and non-free Triangle, and a build that links either fails this gate however well it scores.',
  },
  {
    id: 'cannot-run-in-browser',
    statement: 'The candidate cannot execute locally in a browser tab.',
    rationale:
      'Local-first is the product. A kernel needing a server is not a slower option; it is a different product.',
  },
  {
    id: 'corrupt-output',
    statement:
      'The candidate emits non-finite coordinates, structurally invalid meshes, or output our own codec cannot re-import.',
    rationale: 'Output we cannot validate or write back is not a result.',
  },
  {
    id: 'crashes-on-ordinary-malformed-input',
    statement: 'The candidate traps, hangs, or aborts on input a user would plausibly open.',
    rationale:
      'Malformed input is the normal case for a repair tool. R29 exists to test this, and a clean refusal passes — only a crash or hang fails.',
  },
  {
    id: 'unbounded-memory',
    statement: 'Memory grows without bound, or disposal does not return it.',
    rationale:
      'A tab has one heap shared with the resident model and render buffers. A leak here takes the whole session down.',
  },
  {
    id: 'no-cancellation-path',
    statement:
      'No cooperative cancellation, no chunking, AND no safe termination in a disposable worker.',
    rationale:
      'Cancellability is an existing product guarantee. The disposable-worker fallback is nearly always available, so failing all three is a strong signal.',
  },
  {
    id: 'unacceptable-geometry-loss',
    statement:
      'The candidate cannot preserve geometry on control fixtures — it changes clean input, merges disjoint shells, fills intentional openings, or removes thin features.',
    rationale:
      'These are silent data loss. A user cannot detect them by looking, which is precisely what makes them disqualifying rather than merely bad.',
  },
];

/**
 * Roles a candidate can be scored for.
 *
 * Scoring per role, not overall, so a boolean kernel is not marked down for
 * lacking hole filling and a hole-filler is not marked down for lacking
 * booleans. Forcing one library to win categories it was never designed for
 * produces a bad decision dressed up as a fair comparison.
 */
export const KernelRole = {
  Diagnostics: 'diagnostics',
  ExactCleanup: 'exact-cleanup',
  SeamHealing: 'seam-healing',
  OrientationRepair: 'orientation-repair',
  HoleFilling: 'hole-filling',
  SelfIntersectionResolution: 'self-intersection-resolution',
  SolidReconstruction: 'solid-reconstruction',
  BooleanOperations: 'boolean-operations',
  Offsetting: 'offsetting',
} as const;

export type KernelRole = (typeof KernelRole)[keyof typeof KernelRole];
