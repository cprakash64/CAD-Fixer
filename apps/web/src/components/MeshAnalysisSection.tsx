import type { ReactNode } from 'react';
import {
  describeCount,
  describeSeverity,
  IssueSeverity,
  type RepairIssue,
} from '../state/repair-issues';
import { useWorkspaceState } from '../state/store-context';
import { useIssueNavigation } from '../state/use-issue-navigation';
import { useAnalysisControls } from '../state/workflow-controllers';
import { AnalysisState } from '../state/workspace-store';
import { Icon, type IconName } from './shell/Icon';
import { PanelSection } from './shell/primitives';

/**
 * The Repair workspace's first section: what the checks found, one row per
 * check, with the selected issue's occurrence navigator beneath.
 *
 * Every row, count and severity comes from `deriveRepairIssues` through the
 * shared navigation hook; this component decides only how they look. Rows
 * exist only for checks CAD Fixer runs, and a check that has not produced a
 * result for this revision says so rather than showing zero.
 */
export function MeshAnalysisSection(): ReactNode {
  const { model, analysis } = useWorkspaceState();
  const { runAnalysis, isAnalyzing, canRetry } = useAnalysisControls();
  const navigation = useIssueNavigation();
  const { issues, summary, selection } = navigation;

  return (
    <PanelSection
      title="Mesh analysis"
      testId="mesh-analysis"
      meta={
        model === undefined ? undefined : (
          <span
            className={`health-summary health-summary--${summary.tone}`}
            data-testid="health-summary"
          >
            {summary.text}
          </span>
        )
      }
    >
      {model === undefined ? (
        <p className="panel__empty" data-testid="mesh-analysis-empty">
          Open a model to analyze its mesh.
        </p>
      ) : (
        <>
          <button
            type="button"
            className="secondary-action"
            onClick={runAnalysis}
            disabled={isAnalyzing || !canRetry}
            aria-busy={isAnalyzing}
            data-testid="analyze-mesh"
          >
            {isAnalyzing ? (
              <Icon name="loader" size={15} className="spin" />
            ) : (
              <Icon name="scan" size={15} />
            )}
            <span>{isAnalyzing ? 'Analyzing…' : 'Analyze mesh'}</span>
          </button>

          {analysis.state === AnalysisState.Failed ? (
            <p
              className="panel__note mesh-analysis__failed"
              role="alert"
              data-testid="mesh-analysis-failed"
            >
              The analysis did not complete, so no findings are shown. The reason is in Mesh Health
              below{canRetry ? '; Analyze mesh tries again.' : '.'}
            </p>
          ) : null}

          {issues.length === 0 ? (
            analysis.state === AnalysisState.Failed ? null : (
              <p className="panel__note" role="status" data-testid="mesh-analysis-pending">
                {isAnalyzing ? 'Checking the mesh…' : 'No analysis for this revision yet.'}
              </p>
            )
          ) : (
            <>
              <ul className="issue-list" aria-label="Findings" data-testid="issue-list">
                {issues.map((issue) => (
                  <li key={issue.id}>
                    <IssueRow
                      issue={issue}
                      selected={selection?.issue.id === issue.id}
                      onSelect={() => {
                        if (selection?.issue.id === issue.id) navigation.dismiss();
                        else navigation.select(issue.id);
                      }}
                    />
                  </li>
                ))}
              </ul>
              <p
                className="panel__note mesh-analysis__qualifier"
                data-testid="mesh-analysis-qualifier"
              >
                {summary.qualifier}
              </p>
            </>
          )}

          {selection?.occurrence === undefined ? null : (
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
                  Stepping through {selection.issue.occurrenceCount.toLocaleString()} sampled
                  locations of {describeCount(selection.issue)}.
                </p>
              ) : null}
            </div>
          )}
        </>
      )}
    </PanelSection>
  );
}

const SEVERITY_ICON: Readonly<Record<IssueSeverity, IconName>> = {
  [IssueSeverity.Error]: 'error',
  [IssueSeverity.Warning]: 'alert',
  [IssueSeverity.Ok]: 'ok',
  [IssueSeverity.Unchecked]: 'info',
};

function IssueRow({
  issue,
  selected,
  onSelect,
}: {
  readonly issue: RepairIssue;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={`issue-row issue-row--${issue.severity}`}
      aria-pressed={selected}
      onClick={onSelect}
      data-testid={`issue-row-${issue.id}`}
      data-severity={issue.severity}
    >
      <Icon name={SEVERITY_ICON[issue.severity]} size={14} className="issue-row__icon" />
      <span className="issue-row__label">{issue.label}</span>
      <span className="visually-hidden">
        {' — '}
        {describeSeverity(issue.severity)}, {describeCount(issue)}
      </span>
      <span className="issue-row__count" aria-hidden="true" data-testid={`issue-count-${issue.id}`}>
        {issue.count === undefined ? '—' : issue.count.toLocaleString()}
      </span>
    </button>
  );
}
