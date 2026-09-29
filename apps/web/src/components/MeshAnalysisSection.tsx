import type { ReactNode } from 'react';
import {
  describeCount,
  describeSeverity,
  IssueSeverity,
  RepairIssueId,
  type RepairIssue,
} from '../state/repair-issues';
import { Fixability, ISSUE_INFO, type IssueStatus } from '../state/repair-workspace-presentation';
import { useWorkspaceState } from '../state/store-context';
import type { IssueNavigation } from '../state/use-issue-navigation';
import { useRepairWorkspace } from '../state/use-repair-workspace';
import { AnalysisState } from '../state/workspace-store';
import { SelfIntersectionDetails, SelfIntersectionSection } from './SelfIntersectionSection';
import { Icon, type IconName } from './shell/Icon';
import { InfoButton, InfoPanel, useInfoDisclosure } from './shell/info';
import { PanelSection } from './shell/primitives';

/**
 * DETECTED ISSUES — the Repair workspace's answer to "what's wrong?".
 *
 * One compact row per check: the issue, its exact count, and one line saying
 * what Pybrix can do about it. The explanation behind each row is one ⓘ away
 * and the full report is in Advanced diagnostics; neither is on screen by
 * default (REPAIR-UX-01).
 *
 * Every row, count and severity comes from `deriveRepairIssues` through the
 * shared navigation hook, and every fixability line from
 * `deriveIssueStatus`; this component decides only how they look. Rows exist
 * only for checks Pybrix runs, and a check that has not produced a result for
 * this revision says so rather than showing zero.
 *
 * Selecting a row highlights its overlay and opens the occurrence navigator,
 * exactly as before; nothing here is needed to repair a model.
 */
export function MeshAnalysisSection(): ReactNode {
  const { model, analysis } = useWorkspaceState();
  const { navigation, statuses } = useRepairWorkspace();
  const { issues, selection } = navigation;

  if (model === undefined) return null;

  return (
    <PanelSection title="Detected issues" testId="mesh-analysis">
      {issues.length === 0 ? (
        analysis.state === AnalysisState.Failed ? (
          <p className="panel__note" role="alert" data-testid="mesh-analysis-failed">
            The analysis did not complete, so no findings are shown.
          </p>
        ) : (
          <p className="panel__note" role="status" data-testid="mesh-analysis-pending">
            {analysis.state === AnalysisState.Analyzing
              ? 'Checking the mesh…'
              : 'No analysis for this version yet.'}
          </p>
        )
      ) : (
        <ul className="issue-list" aria-label="Detected issues" data-testid="issue-list">
          {issues.map((issue) => (
            <IssueItem
              key={issue.id}
              issue={issue}
              status={statuses.get(issue.id)}
              selected={selection?.issue.id === issue.id}
              onSelect={() => {
                if (selection?.issue.id === issue.id) navigation.dismiss();
                else navigation.select(issue.id);
              }}
            />
          ))}
        </ul>
      )}

      {selection?.occurrence === undefined ? null : <OccurrenceNavigator navigation={navigation} />}
    </PanelSection>
  );
}

const SEVERITY_ICON: Readonly<Record<IssueSeverity, IconName>> = {
  [IssueSeverity.Error]: 'error',
  [IssueSeverity.Warning]: 'alert',
  [IssueSeverity.Ok]: 'ok',
  [IssueSeverity.Unchecked]: 'info',
};

function IssueItem({
  issue,
  status,
  selected,
  onSelect,
}: {
  readonly issue: RepairIssue;
  readonly status: IssueStatus | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const info = useInfoDisclosure();
  // The self-intersection row carries its own check: its status IS the
  // check's headline, so a second line would say the same thing twice.
  const isSelfIntersection = issue.id === RepairIssueId.SelfIntersections;

  return (
    <li className="issue-item" data-testid={`issue-item-${issue.id}`}>
      <div className="issue-item__row">
        <button
          type="button"
          className={`issue-row issue-row--${issue.severity}`}
          aria-pressed={selected}
          onClick={onSelect}
          data-testid={`issue-row-${issue.id}`}
          data-severity={issue.severity}
        >
          <Icon name={SEVERITY_ICON[issue.severity]} size={14} className="issue-row__icon" />
          <span className="issue-row__text">
            <span className="issue-row__label">{issue.label}</span>
            {status === undefined || isSelfIntersection ? null : (
              <span
                className={`issue-row__status issue-row__status--${status.fixability}`}
                data-testid={`issue-status-${issue.id}`}
                data-fixability={status.fixability}
              >
                {status.text}
              </span>
            )}
            {status?.detail === undefined ? null : (
              <span className="issue-row__detail" data-testid={`issue-detail-${issue.id}`}>
                {status.detail}
              </span>
            )}
          </span>
          <span className="visually-hidden">
            {' — '}
            {describeSeverity(issue.severity)}, {describeCount(issue)}
          </span>
          <span
            className="issue-row__count"
            aria-hidden="true"
            data-testid={`issue-count-${issue.id}`}
          >
            {issue.count === undefined ? '—' : issue.count.toLocaleString()}
          </span>
        </button>
        <InfoButton disclosure={info} label={issue.label} testId={`issue-info-${issue.id}`} />
      </div>
      {isSelfIntersection ? <SelfIntersectionSection /> : null}
      <InfoPanel
        disclosure={info}
        label={issue.label}
        info={ISSUE_INFO[issue.id]}
        testId={`issue-info-panel-${issue.id}`}
      >
        {isSelfIntersection ? <SelfIntersectionDetails /> : null}
        {status?.fixability === Fixability.ResourceLimit ? (
          <p className="info-panel__text">
            Filling is limited by the part’s triangle count, not by the opening. Advanced
            diagnostics lists every boundary Pybrix found.
          </p>
        ) : null}
      </InfoPanel>
    </li>
  );
}

function OccurrenceNavigator({ navigation }: { readonly navigation: IssueNavigation }): ReactNode {
  const selection = navigation.selection;
  if (selection?.occurrence === undefined) return null;
  return (
    <div
      className="occurrence-nav"
      role="group"
      aria-label="Occurrences"
      data-testid="occurrence-nav"
    >
      <span className="occurrence-nav__label">
        <strong>{selection.issue.label}</strong>
        <span className="occurrence-nav__position" data-testid="occurrence-position">
          {' · '}
          {selection.occurrence + 1} / {selection.issue.occurrenceCount}
        </span>
      </span>
      <button
        type="button"
        className="occurrence-nav__step"
        aria-label={`Previous ${selection.issue.unit[0]}`}
        disabled={selection.issue.occurrenceCount < 2}
        onClick={() => {
          navigation.step(-1);
        }}
        data-testid="occurrence-previous"
      >
        <Icon name="chev-left" size={14} />
      </button>
      <button
        type="button"
        className="occurrence-nav__step"
        aria-label={`Next ${selection.issue.unit[0]}`}
        disabled={selection.issue.occurrenceCount < 2}
        onClick={() => {
          navigation.step(1);
        }}
        data-testid="occurrence-next"
      >
        <Icon name="chev-right" size={14} />
      </button>
      <button
        type="button"
        className="occurrence-nav__zoom"
        onClick={navigation.zoom}
        disabled={selection.location === undefined}
        data-testid="occurrence-zoom"
      >
        <Icon name="target" size={13} />
        Zoom
      </button>
      {selection.issue.occurrencesPartial ? (
        <p className="occurrence-nav__note" data-testid="occurrence-partial">
          Stepping through {selection.issue.occurrenceCount.toLocaleString()} sampled locations of{' '}
          {describeCount(selection.issue)}.
        </p>
      ) : null}
    </div>
  );
}
