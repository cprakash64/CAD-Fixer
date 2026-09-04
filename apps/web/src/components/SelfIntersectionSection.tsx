import type { ReactNode } from 'react';
import {
  SelfIntersectionBand,
  SelfIntersectionPhase,
  type SelfIntersectionReport,
} from '@cadfixer/mesh-self-intersection';
import { useSelfIntersection } from '../state/use-self-intersection';
import { useWorkspaceState } from '../state/store-context';
import {
  CATEGORY_LABELS,
  SELF_INTERSECTION_QUALIFIER,
  SELF_INTERSECTION_TITLE,
  describePhase,
  describeReport,
} from '../state/self-intersection-presentation';

/**
 * The self-intersection section of Mesh Health.
 *
 * PRESENTATION AND DISPATCH ONLY. Every sentence comes from
 * `self-intersection-presentation.ts`, every decision from the store, and the
 * geometry never comes here at all — the page holds a handle, some counters and
 * at most a bounded list of face ids.
 *
 * WHAT THE STATES ARE FOR. A reader must be able to tell "we looked and found
 * nothing" apart from "we did not look", "we stopped early" and "you stopped
 * us". Five of those carry a zero intersection count, so the component never
 * branches on the count: it branches on the decision the presentation layer
 * already made.
 */
export function SelfIntersectionSection(): ReactNode {
  const { model, selfIntersection } = useWorkspaceState();
  const controls = useSelfIntersection();

  if (model === undefined) return null;

  const { phase, band, report } = selfIntersection;
  const described =
    report !== undefined && phase === SelfIntersectionPhase.Complete
      ? describeReport(report)
      : describePhase(phase, band);

  if (described === undefined) return null;

  return (
    <section data-testid="self-intersection">
      <h3 className="panel__subtitle">{SELF_INTERSECTION_TITLE}</h3>

      <p
        className={described.clean ? 'validity validity--ok' : 'validity validity--bad'}
        data-testid="self-intersection-headline"
      >
        {described.headline}
      </p>

      {described.detail === undefined ? null : (
        <p className="panel__note" data-testid="self-intersection-detail">
          {described.detail}
        </p>
      )}

      {/* The qualifier is shown only once a check has actually finished: it
          qualifies a RESULT, and printing it beside "Not checked" would imply
          one exists. */}
      {phase === SelfIntersectionPhase.Complete ? (
        <p className="panel__note" data-testid="self-intersection-qualifier">
          {SELF_INTERSECTION_QUALIFIER}
        </p>
      ) : null}

      {report !== undefined && report.intersectingPairCount > 0 ? (
        <CategoryBreakdown report={report} />
      ) : null}

      {/* How much work the check actually did. Bounded scalars, and the honest
          answer to "did it really look at everything?" — a reader comparing
          tested against candidate pairs can see for themselves when a result
          was capped. */}
      {report !== undefined && report.candidatePairCount > 0 ? (
        <p className="panel__note" data-testid="self-intersection-work-summary">
          {`Examined ${report.testedPairCount.toLocaleString()} of ${report.candidatePairCount.toLocaleString()} candidate triangle pairs.`}
        </p>
      ) : null}

      {controls.isBusy ? (
        <div className="repair__progress" data-testid="self-intersection-progress">
          {selfIntersection.faceCount === undefined ? null : (
            <p className="panel__note" data-testid="self-intersection-work">
              {`Examining ${selfIntersection.faceCount.toLocaleString()} triangles.`}
            </p>
          )}
          <button
            type="button"
            className="import__cancel"
            onClick={controls.cancelCheck}
            // Disabled once cancellation is under way: the worker is already
            // being torn down and a second press cannot make it faster.
            disabled={phase === SelfIntersectionPhase.Cancelling}
            data-testid="cancel-self-intersection"
          >
            {phase === SelfIntersectionPhase.Cancelling ? 'Cancelling…' : 'Cancel check'}
          </button>
        </div>
      ) : null}

      {/*
        NO BUTTON ABOVE THE CEILING. Not a disabled one either: offering a
        control that cannot be honoured invites the reader to believe the check
        is merely unavailable right now.
      */}
      {!controls.isBusy && band !== SelfIntersectionBand.SizeLimit ? (
        <button
          type="button"
          className="action"
          onClick={controls.runCheck}
          data-testid="run-self-intersection"
        >
          {report === undefined ? 'Check self-intersections' : 'Check again'}
        </button>
      ) : null}
    </section>
  );
}

/** The per-cause breakdown, shown only when something was actually found. */
function CategoryBreakdown({ report }: { report: SelfIntersectionReport }): ReactNode {
  const rows = (
    [
      ['properCrossing', report.categories.properCrossing],
      ['coplanarOverlap', report.categories.coplanarOverlap],
      ['nonAdjacentPointTouch', report.categories.nonAdjacentPointTouch],
      ['nonAdjacentEdgeTouch', report.categories.nonAdjacentEdgeTouch],
      ['adjacentOverlapBeyondShared', report.categories.adjacentOverlapBeyondShared],
      ['duplicateTopologyDefect', report.categories.duplicateTopologyDefect],
    ] as const
  ).filter(([, count]) => count > 0);

  if (rows.length === 0) return null;

  return (
    <dl className="facts" data-testid="self-intersection-categories">
      {rows.map(([key, count]) => (
        <div className="facts__row" key={key}>
          <dt className="facts__label">{CATEGORY_LABELS[key] ?? key}</dt>
          <dd className="facts__value" data-testid={`self-intersection-${key}`}>
            {count.toLocaleString()}
          </dd>
        </div>
      ))}
    </dl>
  );
}
