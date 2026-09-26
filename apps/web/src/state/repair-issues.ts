import type { TopologyDetail, TopologyReport } from '@cadfixer/geometry-runtime';
import type { SelfIntersectionReport } from '@cadfixer/mesh-self-intersection';
import { DEFECT_EXPLANATIONS, TOPOLOGY_QUALIFIER } from './topology-presentation';

/**
 * The Repair workspace's issue list, derived — never stored.
 *
 * PURE: scalars and typed arrays in, a small list out. The rows, their
 * severities, their counts, the health summary and every occurrence's location
 * come from here and nowhere else, so the Mesh analysis list, the viewport HUD,
 * the inspector and the status bar cannot disagree about any of them.
 *
 * EVERY ROW IS A CHECK CAD FIXER ACTUALLY RUNS. The reference design also lists
 * thin walls and gaps between shells; CAD Fixer computes neither, so neither
 * row exists. A row whose check has not run says "Not checked" rather than
 * showing a zero.
 *
 * THE VOCABULARY IS THE ENGINE'S. "Winding conflicts", not "flipped normals":
 * winding is compared with neighbouring triangles only, so nothing here can
 * say a face points the wrong way. "Open boundaries", not holes: a boundary may
 * be an intended opening. See DEFECT_EXPLANATIONS and FORBIDDEN_TERMS.
 */

export const RepairIssueId = {
  OpenBoundaries: 'open-boundaries',
  NonManifoldEdges: 'non-manifold-edges',
  NonManifoldVertices: 'non-manifold-vertices',
  WindingConflicts: 'winding-conflicts',
  SelfIntersections: 'self-intersections',
  DegenerateFaces: 'degenerate-faces',
  DuplicateFaces: 'duplicate-faces',
  Components: 'components',
} as const;

export type RepairIssueId = (typeof RepairIssueId)[keyof typeof RepairIssueId];

/** The display order: the reference design's order, over the checks that exist. */
export const REPAIR_ISSUE_ORDER: readonly RepairIssueId[] = [
  RepairIssueId.OpenBoundaries,
  RepairIssueId.NonManifoldEdges,
  RepairIssueId.NonManifoldVertices,
  RepairIssueId.WindingConflicts,
  RepairIssueId.SelfIntersections,
  RepairIssueId.DegenerateFaces,
  RepairIssueId.DuplicateFaces,
  RepairIssueId.Components,
];

/**
 * How a finding is presented.
 *
 * - `error`: the surface is structurally ambiguous — more than two triangles on
 *   an edge, a pinched vertex, or triangles passing through each other. No
 *   slicer can resolve these without guessing.
 * - `warning`: something to review that may be intended or is recoverable —
 *   an open boundary, a winding disagreement, degenerate or duplicate faces,
 *   more than one connected component.
 * - `ok`: the check ran and found nothing.
 * - `unchecked`: the check exists but has not produced a result for this
 *   revision. Never presented as a pass.
 */
export const IssueSeverity = {
  Error: 'error',
  Warning: 'warning',
  Ok: 'ok',
  Unchecked: 'unchecked',
} as const;

export type IssueSeverity = (typeof IssueSeverity)[keyof typeof IssueSeverity];

/** Where individual occurrences come from, when a check exposes them. */
export const OccurrenceSource = {
  /** Boundary components from the openings inventory, one per row. */
  BoundaryLoops: 'boundary-loops',
  /** Sampled edges: vertex-id pairs resolved through the detail's sample table. */
  SampledEdges: 'sampled-edges',
  /** Sampled face ids, located from the part's render snapshot. */
  SampledFaces: 'sampled-faces',
  /** Sampled intersecting face pairs. */
  FacePairs: 'face-pairs',
  None: 'none',
} as const;

export type OccurrenceSource = (typeof OccurrenceSource)[keyof typeof OccurrenceSource];

export interface RepairIssue {
  readonly id: RepairIssueId;
  readonly label: string;
  readonly help: string;
  readonly severity: IssueSeverity;
  /** Exact count from the check, or `undefined` when it has not run. */
  readonly count: number | undefined;
  /** Singular and plural nouns for `count`. */
  readonly unit: readonly [string, string];
  readonly occurrenceSource: OccurrenceSource;
  /**
   * How many occurrences can be navigated. May be LESS than `count`: samples
   * are bounded, and the openings list is capped. Zero means there is nothing
   * to step through, and no navigator is offered.
   */
  readonly occurrenceCount: number;
  /** True when `occurrenceCount < count` because of a sample or list cap. */
  readonly occurrencesPartial: boolean;
}

export interface RepairIssueSources {
  /** The CURRENT report for the active part, or `undefined`. */
  readonly report: TopologyReport | undefined;
  readonly detail: TopologyDetail | undefined;
  /** The CURRENT self-intersection report for the active part, or `undefined`. */
  readonly selfIntersection: SelfIntersectionReport | undefined;
  /** Rows of the openings inventory, when it is current and ready. */
  readonly boundaryRows: readonly { readonly boundaryLoopId: string }[] | undefined;
}

const pairs = (samples: Uint32Array | undefined): number =>
  samples === undefined ? 0 : Math.floor(samples.length / 2);

/**
 * The rows, in display order. Empty when there is no current report: a model
 * that has not been analysed has no findings, and showing zeros would read as
 * a clean result.
 */
export function deriveRepairIssues(sources: RepairIssueSources): readonly RepairIssue[] {
  const { report, detail, selfIntersection, boundaryRows } = sources;
  if (report === undefined) return [];

  const withSeverity = (
    count: number,
    whenPresent: typeof IssueSeverity.Error | typeof IssueSeverity.Warning,
  ): IssueSeverity => (count > 0 ? whenPresent : IssueSeverity.Ok);

  const boundaryComponents =
    report.simpleBoundaryLoopCount + report.openBoundaryChainCount + report.branchedBoundaryCount;
  const boundaryNavigable = boundaryRows?.length ?? 0;

  const degenerate = report.repeatedPositionFaceCount + report.zeroAreaFaceCount;
  const duplicates =
    report.sameOrientationDuplicateCount + report.reversedOrientationDuplicateCount;

  const selfCount = selfIntersection === undefined ? undefined : selfIntersection.affectedFaceCount;

  const rows: RepairIssue[] = [
    {
      id: RepairIssueId.OpenBoundaries,
      label: 'Open boundaries',
      help:
        'Edges that belong to only one triangle, grouped into boundaries. ' +
        DEFECT_EXPLANATIONS.simpleBoundaryLoop.help,
      severity: withSeverity(boundaryComponents, IssueSeverity.Warning),
      count: boundaryComponents,
      unit: ['boundary', 'boundaries'],
      occurrenceSource: OccurrenceSource.BoundaryLoops,
      occurrenceCount: boundaryComponents === 0 ? 0 : boundaryNavigable,
      occurrencesPartial: boundaryNavigable < boundaryComponents,
    },
    {
      id: RepairIssueId.NonManifoldEdges,
      label: DEFECT_EXPLANATIONS.nonManifoldEdge.label,
      help: `${DEFECT_EXPLANATIONS.nonManifoldEdge.help} Which side is inside becomes ambiguous.`,
      severity: withSeverity(report.nonManifoldEdgeCount, IssueSeverity.Error),
      count: report.nonManifoldEdgeCount,
      unit: ['edge', 'edges'],
      occurrenceSource: OccurrenceSource.SampledEdges,
      occurrenceCount: pairs(detail?.nonManifoldEdges),
      occurrencesPartial: pairs(detail?.nonManifoldEdges) < report.nonManifoldEdgeCount,
    },
    {
      id: RepairIssueId.NonManifoldVertices,
      label: DEFECT_EXPLANATIONS.nonManifoldVertex.label,
      help: DEFECT_EXPLANATIONS.nonManifoldVertex.help,
      severity: withSeverity(report.nonManifoldVertexCount, IssueSeverity.Error),
      count: report.nonManifoldVertexCount,
      unit: ['vertex', 'vertices'],
      // The analysis samples no vertex locations, so there is nothing to step
      // through — and nothing is invented.
      occurrenceSource: OccurrenceSource.None,
      occurrenceCount: 0,
      occurrencesPartial: report.nonManifoldVertexCount > 0,
    },
    {
      id: RepairIssueId.WindingConflicts,
      label: DEFECT_EXPLANATIONS.windingConflict.label,
      help:
        `${DEFECT_EXPLANATIONS.windingConflict.help} ` +
        'Orientation is compared with neighbours only; nothing here decides which way is outward.',
      severity: withSeverity(report.windingConflictEdgeCount, IssueSeverity.Warning),
      count: report.windingConflictEdgeCount,
      unit: ['edge', 'edges'],
      occurrenceSource: OccurrenceSource.SampledEdges,
      occurrenceCount: pairs(detail?.windingConflictEdges),
      occurrencesPartial: pairs(detail?.windingConflictEdges) < report.windingConflictEdgeCount,
    },
    {
      id: RepairIssueId.SelfIntersections,
      label: 'Self-intersections',
      help: 'Triangles of this part that pass through other triangles of the same part. Other parts are not compared.',
      severity:
        selfCount === undefined
          ? IssueSeverity.Unchecked
          : withSeverity(selfCount, IssueSeverity.Error),
      count: selfCount,
      unit: ['face', 'faces'],
      occurrenceSource:
        selfIntersection === undefined ? OccurrenceSource.None : OccurrenceSource.FacePairs,
      occurrenceCount: selfIntersection?.samplePairCount ?? 0,
      occurrencesPartial:
        selfIntersection !== undefined &&
        selfIntersection.samplePairCount < selfIntersection.intersectingPairCount,
    },
    {
      id: RepairIssueId.DegenerateFaces,
      label: 'Degenerate faces',
      help: 'Triangles with no usable surface area: two corners at the same point, or all three exactly collinear.',
      severity: withSeverity(degenerate, IssueSeverity.Warning),
      count: degenerate,
      unit: ['face', 'faces'],
      occurrenceSource: OccurrenceSource.SampledFaces,
      occurrenceCount: detail?.degenerateFaces.length ?? 0,
      occurrencesPartial: (detail?.degenerateFaces.length ?? 0) < degenerate,
    },
    {
      id: RepairIssueId.DuplicateFaces,
      label: DEFECT_EXPLANATIONS.duplicateFace.label,
      help:
        `${DEFECT_EXPLANATIONS.duplicateFace.help} Counts exact and reversed duplicates; ` +
        'reversed ones are reported but never removed, because they may describe a zero-thickness feature.',
      severity: withSeverity(duplicates, IssueSeverity.Warning),
      count: duplicates,
      unit: ['face', 'faces'],
      occurrenceSource: OccurrenceSource.None,
      occurrenceCount: 0,
      occurrencesPartial: duplicates > 0,
    },
    {
      id: RepairIssueId.Components,
      label: 'Separate components',
      help: 'Groups of triangles not connected to each other. An assembly of separate pieces is normal; a stray fragment may not be.',
      severity: report.componentCount > 1 ? IssueSeverity.Warning : IssueSeverity.Ok,
      count: report.componentCount,
      unit: ['component', 'components'],
      occurrenceSource: OccurrenceSource.None,
      occurrenceCount: 0,
      occurrencesPartial: false,
    },
  ];
  return rows;
}

export function describeCount(issue: RepairIssue): string {
  if (issue.count === undefined) return 'Not checked';
  return `${issue.count.toLocaleString()} ${issue.count === 1 ? issue.unit[0] : issue.unit[1]}`;
}

/** Severity in words, so it never depends on colour alone. */
export function describeSeverity(severity: IssueSeverity): string {
  switch (severity) {
    case IssueSeverity.Error:
      return 'Error';
    case IssueSeverity.Warning:
      return 'Warning';
    case IssueSeverity.Ok:
      return 'None found';
    case IssueSeverity.Unchecked:
      return 'Not checked';
  }
}

export interface HealthSummary {
  readonly errors: number;
  readonly warnings: number;
  /** `error` / `warning` / `ok`, or `neutral` when there is no analysis. */
  readonly tone: 'error' | 'warning' | 'ok' | 'neutral';
  readonly text: string;
  /** Always shown with the text: what the checks above do not examine. */
  readonly qualifier: string;
}

/**
 * The one-line health summary: how many CATEGORIES are errors and warnings.
 *
 * Categories, not occurrences — "2 errors" means two kinds of structural
 * problem, however many edges each involves. With nothing found it says only
 * that no issues were found, and the qualifier always travels with it: the
 * absence of findings here is not a statement about wall thickness or about
 * checks that did not run.
 */
export function deriveHealthSummary(issues: readonly RepairIssue[]): HealthSummary {
  if (issues.length === 0) {
    return {
      errors: 0,
      warnings: 0,
      tone: 'neutral',
      text: 'Not analysed',
      qualifier: TOPOLOGY_QUALIFIER,
    };
  }
  const errors = issues.filter((issue) => issue.severity === IssueSeverity.Error).length;
  const warnings = issues.filter((issue) => issue.severity === IssueSeverity.Warning).length;
  const plural = (n: number, word: string): string =>
    `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const text =
    errors === 0 && warnings === 0
      ? 'No issues found'
      : `${plural(errors, 'error')} · ${plural(warnings, 'warning')}`;
  return {
    errors,
    warnings,
    tone: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok',
    text,
    qualifier: TOPOLOGY_QUALIFIER,
  };
}

/* ----------------------------------------------------------- locations -- */

/** A place in PART-LOCAL coordinates, with a radius that encloses it. */
export interface OccurrenceLocation {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

export interface LocationSources {
  readonly detail: TopologyDetail | undefined;
  /** The active part's render snapshot: non-indexed, nine floats per face. */
  readonly renderPositions: Float32Array | undefined;
  readonly selfIntersection: SelfIntersectionReport | undefined;
  /** The fetched rim of the SELECTED boundary loop, when it has arrived. */
  readonly rim: Float32Array | undefined;
}

/**
 * Where one occurrence is. `undefined` when the location is not known — a
 * rim that has not arrived yet, a sample index out of range — never a guess.
 */
export function locateOccurrence(
  issue: RepairIssue,
  index: number,
  sources: LocationSources,
): OccurrenceLocation | undefined {
  if (index < 0 || index >= issue.occurrenceCount) return undefined;
  switch (issue.occurrenceSource) {
    case OccurrenceSource.BoundaryLoops:
      return sources.rim === undefined ? undefined : enclose(sources.rim);
    case OccurrenceSource.SampledEdges: {
      const detail = sources.detail;
      if (detail === undefined) return undefined;
      const edges =
        issue.id === RepairIssueId.NonManifoldEdges
          ? detail.nonManifoldEdges
          : detail.windingConflictEdges;
      const a = vertexPosition(detail, edges[index * 2]);
      const b = vertexPosition(detail, edges[index * 2 + 1]);
      return a === undefined || b === undefined
        ? undefined
        : enclose(new Float32Array([...a, ...b]));
    }
    case OccurrenceSource.SampledFaces: {
      const face = sources.detail?.degenerateFaces[index];
      return face === undefined ? undefined : faceRegion(sources.renderPositions, [face]);
    }
    case OccurrenceSource.FacePairs: {
      const samples = sources.selfIntersection?.samples;
      const first = samples?.[index * 3];
      const second = samples?.[index * 3 + 1];
      return first === undefined || second === undefined
        ? undefined
        : faceRegion(sources.renderPositions, [first, second]);
    }
    case OccurrenceSource.None:
      return undefined;
  }
}

/** Binary search: `sampleVertexIds` is ascending and unique by contract. */
function vertexPosition(
  detail: TopologyDetail,
  vertexId: number | undefined,
): [number, number, number] | undefined {
  if (vertexId === undefined) return undefined;
  const ids = detail.sampleVertexIds;
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = ids[mid] ?? 0;
    if (value === vertexId) {
      const p = detail.sampleVertexPositions;
      const x = p[mid * 3];
      const y = p[mid * 3 + 1];
      const z = p[mid * 3 + 2];
      return x === undefined || y === undefined || z === undefined ? undefined : [x, y, z];
    }
    if (value < vertexId) low = mid + 1;
    else high = mid - 1;
  }
  return undefined;
}

function faceRegion(
  positions: Float32Array | undefined,
  faces: readonly number[],
): OccurrenceLocation | undefined {
  if (positions === undefined) return undefined;
  const corners = new Float32Array(faces.length * 9);
  let offset = 0;
  for (const face of faces) {
    const start = face * 9;
    if (start + 9 > positions.length) return undefined;
    corners.set(positions.subarray(start, start + 9), offset);
    offset += 9;
  }
  return enclose(corners);
}

/** The bounding box's centre, and half its diagonal. */
function enclose(points: Float32Array): OccurrenceLocation | undefined {
  if (points.length < 3) return undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < points.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = points[i + axis] ?? 0;
      if (value < (min[axis] ?? 0)) min[axis] = value;
      if (value > (max[axis] ?? 0)) max[axis] = value;
    }
  }
  const [x0 = 0, y0 = 0, z0 = 0] = min;
  const [x1 = 0, y1 = 0, z1 = 0] = max;
  return {
    center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
    radius: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2,
  };
}

/** The overlay category that draws an issue's occurrences, if any. */
export function overlayForIssue(
  id: RepairIssueId,
): 'boundaryEdges' | 'nonManifoldEdges' | 'windingConflictEdges' | 'degenerateFaces' | undefined {
  switch (id) {
    case RepairIssueId.OpenBoundaries:
      return 'boundaryEdges';
    case RepairIssueId.NonManifoldEdges:
      return 'nonManifoldEdges';
    case RepairIssueId.WindingConflicts:
      return 'windingConflictEdges';
    case RepairIssueId.DegenerateFaces:
      return 'degenerateFaces';
    case RepairIssueId.NonManifoldVertices:
    case RepairIssueId.SelfIntersections:
    case RepairIssueId.DuplicateFaces:
    case RepairIssueId.Components:
      return undefined;
  }
}
