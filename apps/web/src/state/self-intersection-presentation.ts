import {
  SelfIntersectionBand,
  SelfIntersectionPhase,
  SelfIntersectionStatus,
  SELF_INTERSECTION_MAX_FACES,
  AUTO_ELIGIBLE_MAX_FACES,
  type SelfIntersectionReport,
} from '@cadfixer/mesh-self-intersection';

/**
 * EVERY SENTENCE THE SELF-INTERSECTION DIAGNOSTIC CAN SAY, DECIDED HERE.
 *
 * Same rule as `repair-presentation.ts`, for the same reason: a status string
 * written inline in a component is a bug waiting to happen. Two screens drift,
 * and a new status reaches one of them and not the other. The switches below
 * are exhaustive with no `default` on purpose — adding a status without
 * deciding what it SAYS should fail to compile.
 *
 * THE CLAIM THIS FILE EXISTS TO POLICE. Five of the six statuses carry a zero
 * intersection count, and exactly one of them means the mesh has none. A test
 * asserts that no string reachable from here can say a model is clean unless
 * the check actually completed.
 */

/**
 * Words no self-intersection string may contain, in any status.
 *
 * A complete, clean self-intersection check establishes ONE thing: that the
 * exact stored mesh does not intersect itself under the qualified classifier.
 * It says nothing about wall thickness, minimum feature size, supports, or
 * whether a slicer will succeed — so the vocabulary that implies those remains
 * banned here exactly as it is in the topology and repair panels.
 */
export const SELF_INTERSECTION_FORBIDDEN_TERMS: readonly string[] = [
  'printable',
  'print ready',
  'print-ready',
  'ready to print',
  'safe to print',
  'watertight',
  'error free',
  'error-free',
  'valid mesh',
  'guaranteed',
  'manifold guaranteed',
];

export const SELF_INTERSECTION_TITLE = 'Self-intersections';

/**
 * The qualifier that follows a completed check.
 *
 * Required rather than optional, because "no self-intersections found" is the
 * one sentence here a reader is most likely to over-generalise into "this model
 * is fine".
 */
export const SELF_INTERSECTION_QUALIFIER =
  'This checks only whether the mesh intersects itself. Wall thickness and minimum feature size are still not checked.';

export interface SelfIntersectionHeadline {
  readonly headline: string;
  readonly detail: string | undefined;
  /** True when the interface may present this as a completed, clean result. */
  readonly clean: boolean;
}

const plural = (count: number, one: string, many: string): string =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** What to say while no terminal report exists. */
export function describePhase(
  phase: SelfIntersectionPhase,
  band: SelfIntersectionBand,
): SelfIntersectionHeadline | undefined {
  switch (phase) {
    case SelfIntersectionPhase.Idle:
      if (band === SelfIntersectionBand.SizeLimit) {
        return {
          headline: 'Not checked for this model size',
          detail: `CAD Fixer runs this check on models up to ${SELF_INTERSECTION_MAX_FACES.toLocaleString()} triangles. This model is larger, so the check was not started.`,
          clean: false,
        };
      }
      return {
        headline: 'Not checked',
        detail:
          band === SelfIntersectionBand.ExplicitCheck
            ? `Models above ${AUTO_ELIGIBLE_MAX_FACES.toLocaleString()} triangles are not checked automatically because it can take several seconds. Start it when you want it.`
            : undefined,
        clean: false,
      };
    case SelfIntersectionPhase.Scheduled:
      return { headline: 'Checking…', detail: 'Starting the check.', clean: false };
    case SelfIntersectionPhase.Running:
      return { headline: 'Checking…', detail: undefined, clean: false };
    case SelfIntersectionPhase.Cancelling:
      return {
        headline: 'Cancelling…',
        detail: 'Stopping the check. Your model has not been changed.',
        clean: false,
      };
    case SelfIntersectionPhase.Complete:
      return undefined;
  }
}

/**
 * What to say about a terminal report.
 *
 * Note what is NOT here: no branch produces a clean-sounding headline for
 * anything except a completed check with nothing found.
 */
export function describeReport(report: SelfIntersectionReport): SelfIntersectionHeadline {
  const found = report.intersectingPairCount;

  switch (report.status) {
    case SelfIntersectionStatus.Checked:
      if (found === 0) {
        return {
          headline: 'None found',
          detail: `Checked all ${plural(report.faceCount, 'triangle', 'triangles')}.`,
          clean: true,
        };
      }
      return {
        headline: plural(found, 'intersecting face pair', 'intersecting face pairs'),
        detail: `${plural(report.affectedFaceCount, 'triangle is', 'triangles are')} involved.`,
        clean: false,
      };

    case SelfIntersectionStatus.Partial:
      return {
        headline:
          found > 0
            ? `${plural(found, 'intersection', 'intersections')} found — check incomplete`
            : 'Check incomplete',
        detail: describeIncompleteness(report),
        clean: false,
      };

    case SelfIntersectionStatus.ResourceLimit:
      return {
        headline:
          found > 0
            ? `${plural(found, 'intersection', 'intersections')} found — check stopped early`
            : 'Check stopped at its resource limit',
        detail:
          'The check reached its work limit before examining every pair, so this is a lower bound rather than a full result.',
        clean: false,
      };

    case SelfIntersectionStatus.Cancelled:
      return {
        headline: 'Check cancelled',
        detail: 'Nothing was changed. You can run it again.',
        clean: false,
      };

    case SelfIntersectionStatus.InternalFailure:
      return {
        headline: 'Check failed',
        detail: 'The check could not complete. Your model is unchanged and can be checked again.',
        clean: false,
      };

    case SelfIntersectionStatus.NotRunSizePolicy:
      return {
        headline: 'Not checked for this model size',
        detail: `CAD Fixer runs this check on models up to ${SELF_INTERSECTION_MAX_FACES.toLocaleString()} triangles.`,
        clean: false,
      };
  }
}

/** Why a `PARTIAL` result is partial, in the user's terms. */
function describeIncompleteness(report: SelfIntersectionReport): string {
  const reasons: string[] = [];
  if (report.skippedDegenerateFaceCount > 0) {
    reasons.push(
      `${plural(report.skippedDegenerateFaceCount, 'triangle', 'triangles')} could not be tested because ${report.skippedDegenerateFaceCount === 1 ? 'it has' : 'they have'} no area`,
    );
  }
  if (report.unclassifiedPairCount > 0) {
    reasons.push(
      `${plural(report.unclassifiedPairCount, 'pair', 'pairs')} could not be classified`,
    );
  }
  if (reasons.length === 0) return 'Some pairs were not examined, so this is a lower bound.';
  return `${reasons.join(' and ')}, so this is a lower bound rather than a full result.`;
}

/** Human labels for the category breakdown. */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  properCrossing: 'Triangles passing through each other',
  coplanarOverlap: 'Overlapping triangles in the same plane',
  nonAdjacentPointTouch: 'Unconnected triangles touching at a point',
  nonAdjacentEdgeTouch: 'Unconnected triangles touching along an edge',
  adjacentOverlapBeyondShared:
    'Neighbouring triangles overlapping beyond the edge or corner they share',
  duplicateTopologyDefect: 'Duplicate triangles (reported by Mesh Health separately)',
});
