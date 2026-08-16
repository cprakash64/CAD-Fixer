import { BoundaryKind, VolumeStatus, type TopologyReport } from '@cadfixer/geometry-runtime';

/**
 * How topology findings are worded for a user.
 *
 * FRAMEWORK-FREE ON PURPOSE. Every phrase the interface shows about topology is
 * decided here and tested here, without a DOM. Wording is a correctness concern
 * in this product, not decoration: the difference between "hole" and "boundary
 * loop", or between "valid" and "no topological defects detected", is the
 * difference between a claim the engine supports and one it does not.
 *
 * THE RULE THIS FILE ENFORCES: never turn diagnostic uncertainty into interface
 * certainty. Stage 2 checks exact-coordinate topology and nothing else. It does
 * not test triangle intersections and does not measure wall thickness, so no
 * string here may say printable, watertight, valid, or error free.
 */

/**
 * Terms that must never appear in topology-derived interface text.
 *
 * Enforced by test against the strings this module produces. It is a guard
 * against drift, not a substitute for thinking: the reason each one is banned is
 * that the engine cannot support it.
 */
export const FORBIDDEN_TERMS: readonly string[] = [
  'hole', // a boundary loop may be an intended opening
  'printable', // needs self-intersection and thickness, neither checked
  'watertight', // implies a verified closed solid
  'valid mesh', // structural validity is a different, narrower claim
  'error free', // nothing here can establish that
];

export interface DefectExplanation {
  readonly label: string;
  readonly help: string;
}

/**
 * One concise explanation per category, in the engine's own vocabulary.
 *
 * Kept short deliberately. A user staring at "non-manifold vertex: 1" needs one
 * sentence telling them what the machine found, not a topology lecture.
 */
export const DEFECT_EXPLANATIONS = {
  boundaryEdge: {
    label: 'Boundary edges',
    help: 'This edge belongs to only one triangle. A closed surface normally has two incident triangles per edge.',
  },
  simpleBoundaryLoop: {
    label: 'Simple boundary loops',
    help: 'A closed chain of boundary edges. It may be an intentional opening or a defect.',
  },
  openBoundaryChain: {
    label: 'Open boundary chains',
    help: 'Boundary edges form an open chain rather than a closed loop.',
  },
  branchedBoundary: {
    label: 'Branched boundaries',
    help: 'The boundary branches or intersects in a way that cannot be represented as one simple loop.',
  },
  nonManifoldEdge: {
    label: 'Non-manifold edges',
    help: 'More than two triangles share this edge.',
  },
  nonManifoldVertex: {
    label: 'Non-manifold vertices',
    help: 'Triangles around this vertex do not form one continuous surface fan.',
  },
  windingConflict: {
    label: 'Winding conflicts',
    help: 'Adjacent triangles traverse their shared edge in the same direction.',
  },
  duplicateFace: {
    label: 'Duplicate faces',
    help: 'Another triangle occupies the same three recovered vertices.',
  },
  reversedDuplicateFace: {
    label: 'Reversed duplicate faces',
    help: 'Another triangle occupies the same location with opposite orientation.',
  },
  repeatedPositionFace: {
    label: 'Repeated-position faces',
    help: 'This triangle has no usable surface area: two or more of its corners are the same point.',
  },
  zeroAreaFace: {
    label: 'Zero-area faces',
    help: 'This triangle has no usable surface area: its three corners are exactly collinear.',
  },
} as const satisfies Readonly<Record<string, DefectExplanation>>;

export type DefectCategory = keyof typeof DEFECT_EXPLANATIONS;

export interface TopologySummary {
  /** The one-line verdict. */
  readonly headline: string;
  /** Always shown immediately after the headline. Never optional. */
  readonly qualifier: string;
  readonly hasDefects: boolean;
}

/**
 * The overall verdict, which is never allowed to stand alone.
 *
 * `qualifier` is a separate REQUIRED field rather than a suffix a caller may
 * forget: "No topological defects detected" on its own reads as a clean bill of
 * health, and the engine has not earned that. Anything rendering the headline
 * must render the qualifier.
 */
export function summariseTopology(report: TopologyReport): TopologySummary {
  const hasDefects = totalDefectCount(report) > 0;
  return {
    headline: hasDefects ? 'Topological issues detected' : 'No topological defects detected',
    qualifier: 'Self-intersections and wall thickness have not yet been checked.',
    hasDefects,
  };
}

/** Every Stage 2 defect category summed. Used only for the headline branch. */
export function totalDefectCount(report: TopologyReport): number {
  return (
    report.boundaryEdgeCount +
    report.nonManifoldEdgeCount +
    report.nonManifoldVertexCount +
    report.windingConflictEdgeCount +
    report.repeatedPositionFaceCount +
    report.zeroAreaFaceCount +
    report.sameOrientationDuplicateCount +
    report.reversedOrientationDuplicateCount
  );
}

/**
 * Area and volume, in the model's own unspecified unit.
 *
 * STL carries no unit. Writing "mm²" would put an invented fact on screen beside
 * a real measurement, which is worse than writing nothing — the number looks
 * authoritative either way, so the label has to carry the uncertainty.
 */
export function formatArea(value: number, unit: string | undefined): string {
  return `${formatMagnitude(value)} ${unit ?? 'unit'}²`;
}

export function formatVolume(value: number, unit: string | undefined): string {
  return `${formatMagnitude(value)} ${unit ?? 'unit'}³`;
}

export function formatMagnitude(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e9 || magnitude < 1e-3) return value.toExponential(3);
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export interface VolumePresentation {
  readonly label: string;
  /** `undefined` when a volume number would mislead more than it informs. */
  readonly value: string | undefined;
  readonly help: string;
}

/**
 * How to present one component's signed volume.
 *
 * THE NEGATIVE-VOLUME PROBLEM. A consistently wound but inward-facing shell has
 * a negative algebraic volume. Showing "−30 unit³" as though it were a physical
 * measurement suggests the object contains negative matter. The magnitude is the
 * enclosed volume and the sign is an orientation fact, so they are reported as
 * two different things rather than one confusing one.
 *
 * When the surface is open or non-manifold the sum is not a volume at all, and
 * no number is offered — a figure the user could copy into a quote is worse than
 * an explanation of why there isn't one.
 */
export function presentVolume(
  signedVolume: number,
  status: VolumeStatus,
  unit: string | undefined,
): VolumePresentation {
  if (status === VolumeStatus.OpenSurface) {
    return {
      label: 'Enclosed volume',
      value: undefined,
      help: 'This component has boundary edges, so it does not enclose a region. No volume can be derived from it.',
    };
  }

  if (status === VolumeStatus.NotInterpretable) {
    return {
      label: 'Enclosed volume',
      value: undefined,
      help: 'This component is closed but not a manifold surface, or its triangles are not consistently wound, so the algebraic sum is not a physical volume.',
    };
  }

  const inverted = signedVolume < 0;
  return {
    label: 'Algebraic enclosed volume',
    value: formatVolume(Math.abs(signedVolume), unit),
    help: inverted
      ? 'Computed from a closed, consistently wound surface. The signed value is negative, which indicates the triangles face inward rather than that the volume is negative. Self-intersections are not tested, so a surface can meet every topological condition and still pass through itself.'
      : 'Computed from a closed, consistently wound surface. Self-intersections are not tested, so a surface can meet every topological condition and still pass through itself.',
  };
}

/** Human wording for a boundary component's shape. */
export function describeBoundaryKind(kind: BoundaryKind): string {
  switch (kind) {
    case BoundaryKind.SimpleLoop:
      return 'Simple loop';
    case BoundaryKind.OpenChain:
      return 'Open chain';
    case BoundaryKind.Branched:
      return 'Branched';
  }
}

/** Human wording for a component's volume status. */
export function describeVolumeStatus(status: VolumeStatus): string {
  switch (status) {
    case VolumeStatus.ClosedManifold:
      return 'Closed manifold surface';
    case VolumeStatus.OpenSurface:
      return 'Open surface';
    case VolumeStatus.NotInterpretable:
      return 'Not interpretable';
  }
}

/**
 * Truncation wording for a bounded list.
 *
 * Says how many are being shown AND how many exist. "Showing first 1,000" alone
 * leaves the user to guess whether that is all of them.
 */
export function describeTruncation(shown: number, total: number): string | undefined {
  if (shown >= total) return undefined;
  return `Showing first ${shown.toLocaleString()} of ${total.toLocaleString()} components.`;
}

/**
 * Overlay sampling wording.
 *
 * The viewport draws at most `sampleLimit` items per category while the count
 * may be in the millions. Saying so is the difference between a representative
 * picture and a false one.
 */
export function describeOverlaySampling(drawn: number, exact: number): string | undefined {
  if (drawn >= exact) return undefined;
  return `Showing ${drawn.toLocaleString()} of ${exact.toLocaleString()} in the viewport.`;
}
