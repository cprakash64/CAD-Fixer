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
  describePhase,
  describeReport,
} from '../state/self-intersection-presentation';

/**
 * The self-intersection check, rendered inside its own issue row.
 *
 * REPAIR-UX-01: one status line and, when the check can run, one button. The
 * detail, the qualifier, the work summary and the per-cause breakdown are in
 * `SelfIntersectionDetails`, behind the row's ⓘ — never deleted.
 *
 * THE ONE OWNER OF `useSelfIntersection`. The hook starts the automatic check
 * and cancels it on unmount, so exactly one component may call it; this one
 * stays mounted for as long as there is a report, because the issue list is
 * hidden rather than unmounted outside the Repair workspace.
 *
 * PRESENTATION AND DISPATCH ONLY. Every sentence comes from
 * `self-intersection-presentation.ts`, every decision from the store, and the
 * geometry never comes here at all. A reader must be able to tell "we looked
 * and found nothing" apart from "we did not look", "we stopped early" and "you
 * stopped us", so the component branches on the presentation layer's decision,
 * never on the count.
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
    <div className="issue-check" data-testid="self-intersection">
      <div className="issue-check__line">
        <p
          className={
            described.clean ? 'issue-check__headline validity--ok' : 'issue-check__headline'
          }
          data-testid="self-intersection-headline"
        >
          {described.headline}
        </p>
        {controls.isBusy ? (
          <button
            type="button"
            className="issue-check__action"
            onClick={controls.cancelCheck}
            // Disabled once cancellation is under way: the worker is already
            // being torn down and a second press cannot make it faster.
            disabled={phase === SelfIntersectionPhase.Cancelling}
            data-testid="cancel-self-intersection"
          >
            {phase === SelfIntersectionPhase.Cancelling ? 'Cancelling…' : 'Cancel check'}
          </button>
        ) : /*
            NO BUTTON ABOVE THE CEILING. Not a disabled one either: offering a
            control that cannot be honoured invites the reader to believe the
            check is merely unavailable right now.
          */
        band !== SelfIntersectionBand.SizeLimit ? (
          <button
            type="button"
            className="issue-check__action"
            onClick={controls.runCheck}
            data-testid="run-self-intersection"
          >
            {report === undefined ? 'Check now' : 'Check again'}
          </button>
        ) : null}
      </div>

      {controls.isBusy ? (
        <p className="issue-check__work" role="status" data-testid="self-intersection-progress">
          {selfIntersection.faceCount === undefined ? (
            'Starting the check…'
          ) : (
            <span data-testid="self-intersection-work">
              {`Examining ${selfIntersection.faceCount.toLocaleString()} triangles.`}
            </span>
          )}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the check examined and how sure it is: the detail, the qualifier, the
 * per-cause breakdown and the work summary. Rendered inside the issue row's ⓘ;
 * reads the store only, so it starts nothing.
 */
export function SelfIntersectionDetails(): ReactNode {
  const { selfIntersection } = useWorkspaceState();
  const { phase, band, report } = selfIntersection;
  const described =
    report !== undefined && phase === SelfIntersectionPhase.Complete
      ? describeReport(report)
      : describePhase(phase, band);
  return (
    <>
      {described?.detail === undefined ? null : (
        <p className="info-panel__text" data-testid="self-intersection-detail">
          {described.detail}
        </p>
      )}
      {/* The qualifier is shown only once a check has actually finished: it
          qualifies a RESULT, and printing it beside "Not checked" would imply
          one exists. */}
      {phase === SelfIntersectionPhase.Complete ? (
        <p className="info-panel__text" data-testid="self-intersection-qualifier">
          {SELF_INTERSECTION_QUALIFIER}
        </p>
      ) : null}
      {report !== undefined && report.intersectingPairCount > 0 ? (
        <CategoryBreakdown report={report} />
      ) : null}
      {/* How much work the check actually did: the honest answer to "did it
          really look at everything?" */}
      {report !== undefined && report.candidatePairCount > 0 ? (
        <p className="info-panel__text" data-testid="self-intersection-work-summary">
          {`Examined ${report.testedPairCount.toLocaleString()} of ${report.candidatePairCount.toLocaleString()} candidate triangle pairs.`}
        </p>
      ) : null}
    </>
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
