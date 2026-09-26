import type { ReactNode } from 'react';
import type { TopologyReport } from '@cadfixer/geometry-runtime';
import { describeUnit } from '../state/model';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { TOPOLOGY_QUALIFIER, totalDefectCount } from '../state/topology-presentation';
import { WorkflowId } from '../state/workflows';
import { AnalysisState, ImportState } from '../state/workspace-store';
import { describePhase } from './ImportDropZone';
import { Icon, type IconName } from './shell/Icon';

/**
 * The status bar: what the application is doing, and the loaded model's size.
 *
 * EVERY VALUE IS READ FROM THE STORE. Triangle and vertex counts are the ones
 * the worker measured at import; the unit is the document's own statement,
 * worded by the same `describeUnit` the Model panel uses; the topology entry
 * reflects an analysis that actually ran. Nothing here is estimated, and
 * nothing is shown for a model that is not loaded.
 *
 * THE UNIT IS A STATUS, NOT A SWITCH. CAD Fixer never converts or rescales
 * units, so a control that looked as though it could would be a false promise.
 *
 * THE TOPOLOGY ENTRY NEVER SAYS THE MODEL IS SOUND. A clean analysis is
 * reported as "Topology checked", with the unchecked qualifier as its tooltip:
 * the verdict "No topological defects detected" is shown, with its mandatory
 * qualifier, in Mesh Health, and nowhere is it allowed to stand alone.
 */
export function StatusBar(): ReactNode {
  const { model, activePartId, importProgress, analysis } = useWorkspaceState();
  const store = useWorkspaceStore();

  const importing =
    importProgress.state === ImportState.Screening ||
    importProgress.state === ImportState.Reading ||
    importProgress.state === ImportState.Parsing ||
    importProgress.state === ImportState.Validating;
  const analysing = analysis.state === AnalysisState.Analyzing;
  // THE STALE-REPORT GUARD, as the viewport applies it: a report counts only
  // for the model revision and the part it was computed from.
  const reportIsCurrent =
    model !== undefined &&
    analysis.handle?.documentId === model.handle.documentId &&
    analysis.handle.revision === model.handle.revision &&
    analysis.partId === activePartId;
  const health =
    model === undefined
      ? undefined
      : describeHealth(analysis.state, reportIsCurrent ? analysis.report : undefined);

  return (
    <footer className="statusbar" data-testid="status-bar">
      <div className="statusbar__job" role="status" data-testid="status-bar-job">
        {importing ? (
          <>
            <span className="statusbar__spinner" aria-hidden="true">
              <Icon name="loader" size={13} />
            </span>
            <span className="statusbar__job-label">{describePhase(importProgress.state)}</span>
            <span className="statusbar__mono">{Math.round(importProgress.fraction * 100)}%</span>
          </>
        ) : analysing ? (
          <>
            <span className="statusbar__spinner" aria-hidden="true">
              <Icon name="loader" size={13} />
            </span>
            <span className="statusbar__job-label">Analysing topology</span>
          </>
        ) : (
          <>
            <span className="statusbar__dot" aria-hidden="true" />
            <span>Ready</span>
          </>
        )}
      </div>

      <p className="statusbar__privacy" data-testid="privacy-badge">
        <Icon name="lock" size={12} />
        <span>Models are processed locally in your browser</span>
      </p>

      <span className="statusbar__spacer" />

      {model === undefined ? null : (
        <>
          <span className="statusbar__stat">
            Triangles{' '}
            <b className="statusbar__mono" data-testid="status-triangles">
              {model.triangleCount.toLocaleString()}
            </b>
          </span>
          <span className="statusbar__stat statusbar__stat--vertices">
            Vertices{' '}
            <b className="statusbar__mono" data-testid="status-vertices">
              {model.vertexCount.toLocaleString()}
            </b>
          </span>
          <span
            className="statusbar__unit"
            data-testid="status-unit"
            title="Unit stated by the file"
          >
            {describeUnit(model.source)}
          </span>
          {health === undefined ? null : (
            <button
              type="button"
              className={`statusbar__health statusbar__health--${health.tone}`}
              data-tooltip={health.tooltip}
              data-tooltip-side="above"
              aria-label={`${health.text}. ${health.tooltip} Open the Repair workspace.`}
              onClick={() => {
                store.selectWorkflow(WorkflowId.Repair);
              }}
              data-testid="status-health"
            >
              <Icon name={health.icon} size={12} />
              {health.text}
            </button>
          )}
        </>
      )}

      <span className="statusbar__release" data-testid="release-stage">
        v0.4.0 Technical Preview
      </span>
    </footer>
  );
}

interface HealthEntry {
  readonly text: string;
  readonly tooltip: string;
  readonly tone: 'neutral' | 'warning' | 'success';
  readonly icon: IconName;
}

function describeHealth(
  state: AnalysisState,
  report: TopologyReport | undefined,
): HealthEntry | undefined {
  if (state === AnalysisState.Unavailable) return undefined;
  if (report === undefined) {
    if (state === AnalysisState.Analyzing)
      return {
        text: 'Checking topology',
        tooltip: TOPOLOGY_QUALIFIER,
        tone: 'neutral',
        icon: 'info',
      };
    return {
      text: 'Topology not checked',
      tooltip: TOPOLOGY_QUALIFIER,
      tone: 'neutral',
      icon: 'info',
    };
  }
  const issues = totalDefectCount(report);
  if (issues === 0)
    return { text: 'Topology checked', tooltip: TOPOLOGY_QUALIFIER, tone: 'success', icon: 'ok' };
  return {
    text: `${issues.toLocaleString()} topology ${issues === 1 ? 'issue' : 'issues'}`,
    tooltip: TOPOLOGY_QUALIFIER,
    tone: 'warning',
    icon: 'alert',
  };
}
