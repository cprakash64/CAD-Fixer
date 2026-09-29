import { useEffect, useId, useRef, type ReactNode } from 'react';
import {
  REPAIR_ISOLATION_DETAIL,
  describeNoRepairsAvailable,
  presentAcceptance,
} from '../state/repair-presentation';
import {
  ADVANCED_INFO,
  ANALYZE_MODEL_ACTION,
  APPLY_REPAIRS_ACTION,
  CANCEL_PREVIEW_ACTION,
  FILE_STRUCTURE_INFO,
  NO_REPAIRABLE_PROBLEMS,
  NO_SAFE_REPAIRS,
  PREVIEW_READY_LINE,
  REPAIRS_APPLIED_LINE,
  REPAIR_MODEL_ACTION,
  REPAIR_UNAVAILABLE_LINE,
  RepairActionKind,
  SUMMARY_INFO,
  describeFileStructure,
  describeRepairScope,
} from '../state/repair-workspace-presentation';
import { useWorkspaceState } from '../state/store-context';
import { totalDefectCount } from '../state/topology-presentation';
import { useRepairWorkspace, type RepairWorkspaceView } from '../state/use-repair-workspace';
import { useAnalysisControls, useRepairControls } from '../state/workflow-controllers';
import { AnalysisState, RepairCandidateState } from '../state/workspace-store';
import { WorkflowId } from '../state/workflows';
import { MeshAnalysisSection } from './MeshAnalysisSection';
import { MeshHealthPanel } from './MeshHealthPanel';
import { OpenBoundaryPanel, OpenBoundaryLimits } from './OpenBoundaryPanel';
import { RepairExclusions, RepairPanel } from './RepairPanel';
import { Icon } from './shell/Icon';
import { InfoButton, InfoPanel, useInfoDisclosure } from './shell/info';
import { PanelSection } from './shell/primitives';

/**
 * THE REPAIR WORKSPACE — REPAIR-UX-01.
 *
 * Answers three questions by default and nothing else: what is wrong (the
 * health line and Detected issues), what Pybrix can repair (each row's
 * fixability line and Repair options), and what to click (the one primary
 * action in the sticky footer). Explanations sit behind ⓘ buttons; the full
 * report is in Advanced diagnostics, collapsed.
 *
 * THE FOOTER'S PRIMARY ACTION NEVER MOVES. It reads Analyze model, Repair
 * model or Apply repairs depending on the state, and when nothing safe can
 * run it is still there, disabled, with the reason beside it — a hidden
 * button reads as a missing feature.
 *
 * NOTHING HERE COMMITS. Repair model builds and validates a candidate through
 * the existing transactional workflow; Apply repairs asks the worker, which
 * re-checks every guard; Cancel preview discards; Undo restores the retained
 * mesh. The panels stay mounted while hidden, because their hooks own worker
 * operations.
 */
export function RepairWorkspace(): ReactNode {
  const { model } = useWorkspaceState();
  const view = useRepairWorkspace();

  return (
    <div className="convert-workspace repair-workspace" data-testid="repair-workspace">
      <div className="convert-workspace__sections">
        {model === undefined ? null : <RepairOverview view={view} />}
        <MeshAnalysisSection />
        <RepairPanel />
        <OpenBoundaryPanel />
        {model === undefined ? null : (
          <PanelSection
            title="Advanced diagnostics"
            testId="advanced-diagnostics"
            defaultOpen={false}
            info={ADVANCED_INFO}
          >
            <MeshHealthPanel />
            <div className="panel" data-testid="advanced-limits">
              <RepairExclusions />
              <OpenBoundaryLimits />
            </div>
          </PanelSection>
        )}
      </div>
      <RepairFooter view={view} />
    </div>
  );
}

/* ------------------------------------------------------------- overview -- */

/**
 * The health line: how many issue TYPES were found, what the checks do not
 * cover, and that the file itself parsed — stated so that "file structure
 * valid" can never be read as "this mesh has no problems".
 */
function RepairOverview({ view }: { readonly view: RepairWorkspaceView }): ReactNode {
  const { model, selectedWorkflow } = useWorkspaceState();
  const summaryInfo = useInfoDisclosure();
  const fileInfo = useInfoDisclosure();
  const headingRef = useRef<HTMLParagraphElement>(null);
  const { summary } = view.navigation;

  /*
   * Moves focus here when the workspace is chosen from the navigation, so the
   * navigation button does something real for a keyboard or screen-reader user
   * instead of only highlighting itself.
   */
  useEffect(() => {
    if (selectedWorkflow !== WorkflowId.Repair) return;
    headingRef.current?.focus();
  }, [selectedWorkflow]);

  if (model === undefined) return null;

  return (
    <div className="repair-overview" data-testid="repair-overview">
      <div className="repair-overview__line">
        <p
          className="repair-overview__label"
          tabIndex={-1}
          ref={headingRef}
          data-testid="repair-heading"
        >
          Health
        </p>
        <span
          className={`health-summary health-summary--${summary.tone}`}
          data-testid="health-summary"
        >
          {summary.text}
        </span>
        <InfoButton
          disclosure={summaryInfo}
          label="the health summary"
          testId="health-summary-info"
        />
      </div>
      <InfoPanel disclosure={summaryInfo} label="the health summary" info={SUMMARY_INFO} />
      {summary.tone === 'neutral' ? null : (
        <p className="repair-overview__qualifier" data-testid="mesh-analysis-qualifier">
          {summary.qualifier}
        </p>
      )}
      <div className="repair-overview__line">
        <p className="repair-overview__file" data-testid="file-structure">
          <Icon name={model.validation.valid ? 'ok' : 'error'} size={13} />
          {describeFileStructure(model.validation.valid)}
        </p>
        <InfoButton disclosure={fileInfo} label="file structure" testId="file-structure-info" />
      </div>
      <InfoPanel disclosure={fileInfo} label="file structure" info={FILE_STRUCTURE_INFO} />
    </div>
  );
}

/* --------------------------------------------------------------- footer -- */

/**
 * The sticky action area. One primary control, in one place, in every state;
 * progress, outcomes and refusals are stated directly above it.
 */
function RepairFooter({ view }: { readonly view: RepairWorkspaceView }): ReactNode {
  const { analysis, repair } = useWorkspaceState();
  const analysisControls = useAnalysisControls();
  const controls = useRepairControls();
  const reasonInfo = useInfoDisclosure();
  const hintId = useId();
  const { action, scope } = view;

  const analysisPercent = Math.round(analysis.fraction * 100);
  const repairPercent = Math.round(repair.fraction * 100);
  const candidate = repair.candidate;
  const previewable =
    candidate !== undefined &&
    presentAcceptance(candidate.validation.acceptance, candidate.validation.regressions)
      .previewable;
  const report = view.reportIsCurrent ? analysis.report : undefined;

  const status = ((): ReactNode => {
    switch (action) {
      case RepairActionKind.Analyzing:
        return (
          <div className="repair-footer__progress" data-testid="analysis-progress">
            <div className="convert-footer__progress-row">
              <span data-testid="analysis-phase">{analysis.phase ?? 'Analyzing the mesh'}</span>
              <span data-testid="analysis-percent">{analysisPercent}%</span>
            </div>
            <progress
              className="import__bar"
              max={100}
              value={analysisPercent}
              aria-label={`Mesh analysis progress: ${String(analysisPercent)}%`}
            />
          </div>
        );
      case RepairActionKind.Building:
        return (
          <div className="repair-footer__progress" data-testid="repair-progress">
            <div className="convert-footer__progress-row">
              <span data-testid="repair-phase">{repair.phase ?? 'Preparing repair'}</span>
              <span data-testid="repair-percent">{repairPercent}%</span>
            </div>
            <progress
              className="import__bar"
              max={100}
              value={repairPercent}
              aria-label={`Repair preparation progress: ${String(repairPercent)}%`}
            />
            {repair.candidateState === RepairCandidateState.Cancelling ? (
              <p className="convert-footer__hint" data-testid="repair-cancelling">
                Cancelling… nothing has been changed.
              </p>
            ) : null}
          </div>
        );
      case RepairActionKind.Applying:
        return (
          <div className="repair-footer__progress" data-testid="repair-commit-progress">
            <div className="convert-footer__progress-row">
              <span data-testid="repair-commit-phase">{repair.phase ?? 'Applying'}</span>
              <span>{repairPercent}%</span>
            </div>
            <progress
              className="import__bar"
              max={100}
              value={repairPercent}
              aria-label={`Applying repair: ${String(repairPercent)}%`}
            />
          </div>
        );
      case RepairActionKind.Undoing:
        return <p className="repair-footer__line">Undoing repair…</p>;
      case RepairActionKind.Preview:
        return (
          <p className="repair-footer__line" data-testid="repair-preview-ready">
            {PREVIEW_READY_LINE}
          </p>
        );
      case RepairActionKind.Planning:
        return (
          <p className="repair-footer__line" data-testid="repair-planning">
            Working out what Pybrix can repair…
          </p>
        );
      case RepairActionKind.NoModel:
      case RepairActionKind.Unavailable:
      case RepairActionKind.Analyze:
      case RepairActionKind.PlanFailed:
      case RepairActionKind.Ready:
      case RepairActionKind.NothingSafe:
      case RepairActionKind.NothingFound:
        return null;
    }
  })();

  return (
    <div className="convert-footer repair-footer" data-testid="repair-footer">
      <div className="convert-footer__status" aria-live="polite">
        {status}
        {repair.lastApplied !== undefined &&
        (action === RepairActionKind.Ready ||
          action === RepairActionKind.NothingSafe ||
          action === RepairActionKind.NothingFound) ? (
          <p className="convert-footer__saved" data-testid="repair-applied-status">
            <Icon name="ok" size={14} />
            <span>{REPAIRS_APPLIED_LINE}</span>
          </p>
        ) : null}
        {repair.candidateState === RepairCandidateState.Cancelled &&
        action !== RepairActionKind.Building ? (
          <p className="repair-footer__line" data-testid="repair-cancelled">
            Repair was cancelled. Nothing was changed.
          </p>
        ) : null}
      </div>

      {/* Failures, stated beside the action they block. */}
      {analysis.state === AnalysisState.Failed && analysis.error !== undefined ? (
        <p className="convert-footer__failure" role="alert" data-testid="analysis-error">
          {analysis.error.message} The model is still loaded and can be viewed and exported.
        </p>
      ) : null}
      {analysis.state === AnalysisState.Cancelled && action === RepairActionKind.Analyze ? (
        <p className="repair-footer__line" data-testid="analysis-cancelled">
          Analysis was cancelled. No partial results are shown.
        </p>
      ) : null}
      {action === RepairActionKind.PlanFailed && repair.planError !== undefined ? (
        <p className="convert-footer__failure" role="alert" data-testid="repair-plan-error">
          {repair.planError.message} Your model is unchanged.
        </p>
      ) : null}
      {repair.candidateState === RepairCandidateState.Failed &&
      repair.candidateError !== undefined ? (
        <p className="convert-footer__failure" role="alert" data-testid="repair-candidate-error">
          {repair.candidateError.message}
        </p>
      ) : null}
      {repair.commitError !== undefined ? (
        <p className="convert-footer__failure" role="alert" data-testid="repair-commit-error">
          {repair.commitError.message}
        </p>
      ) : null}

      <div className="convert-footer__actions">
        {action === RepairActionKind.Analyzing ? (
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={analysisControls.cancelAnalysis}
            data-testid="cancel-analysis"
          >
            Cancel
          </button>
        ) : null}
        {action === RepairActionKind.Building ? (
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={controls.cancelPreview}
            // Disabled once cancellation is signalled: a second press cannot
            // make the worker unwind sooner.
            disabled={repair.candidateState === RepairCandidateState.Cancelling}
            data-testid="cancel-repair"
          >
            {repair.candidateState === RepairCandidateState.Cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : null}
        {action === RepairActionKind.PlanFailed && repair.planError?.retryable === true ? (
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={controls.replan}
            data-testid="repair-replan"
          >
            Try again
          </button>
        ) : null}
        {action === RepairActionKind.Preview || action === RepairActionKind.Applying ? (
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={controls.discardPreview}
            disabled={action === RepairActionKind.Applying}
            data-testid="discard-preview"
          >
            {CANCEL_PREVIEW_ACTION}
          </button>
        ) : null}
        <PrimaryAction
          view={view}
          previewable={previewable}
          canAnalyze={analysisControls.canRetry}
          onAnalyze={analysisControls.runAnalysis}
          onRepair={controls.previewRepair}
          onApply={controls.applyRepair}
          hintId={hintId}
        />
      </div>

      <FooterHint
        action={action}
        hintId={hintId}
        describeScope={describeRepairScope(scope)}
        hasRemainingDefects={report === undefined ? false : totalDefectCount(report) > 0}
        reasonInfo={reasonInfo}
      />
    </div>
  );
}

function PrimaryAction({
  view,
  previewable,
  canAnalyze,
  onAnalyze,
  onRepair,
  onApply,
  hintId,
}: {
  readonly view: RepairWorkspaceView;
  readonly previewable: boolean;
  readonly canAnalyze: boolean;
  readonly onAnalyze: () => void;
  readonly onRepair: () => void;
  readonly onApply: () => void;
  readonly hintId: string;
}): ReactNode {
  const { action } = view;

  if (action === RepairActionKind.Analyze || action === RepairActionKind.Analyzing) {
    const analyzing = action === RepairActionKind.Analyzing;
    return (
      <button
        type="button"
        className="primary-action convert-footer__primary"
        onClick={onAnalyze}
        disabled={analyzing || !canAnalyze}
        aria-busy={analyzing}
        aria-describedby={hintId}
        data-testid="analyze-mesh"
      >
        <Icon name={analyzing ? 'loader' : 'scan'} size={16} className={analyzing ? 'spin' : ''} />
        <span>{analyzing ? 'Analyzing…' : ANALYZE_MODEL_ACTION}</span>
      </button>
    );
  }

  if (action === RepairActionKind.Preview || action === RepairActionKind.Applying) {
    const applying = action === RepairActionKind.Applying;
    return (
      <button
        type="button"
        className="primary-action convert-footer__primary"
        onClick={onApply}
        disabled={applying || !previewable}
        aria-busy={applying}
        aria-describedby={hintId}
        data-testid="apply-repair"
      >
        <Icon name="ok" size={16} />
        <span>{applying ? 'Applying…' : APPLY_REPAIRS_ACTION}</span>
      </button>
    );
  }

  // Every other state shows Repair model, enabled only when a current plan has
  // something selected and applicable to do.
  const building = action === RepairActionKind.Building;
  return (
    <button
      type="button"
      className="primary-action convert-footer__primary"
      onClick={onRepair}
      disabled={action !== RepairActionKind.Ready}
      aria-busy={building}
      aria-describedby={hintId}
      data-testid="preview-repair"
    >
      <Icon name={building ? 'loader' : 'zap'} size={16} className={building ? 'spin' : ''} />
      <span>{building ? 'Preparing preview…' : REPAIR_MODEL_ACTION}</span>
    </button>
  );
}

/**
 * The one line beneath the action: what pressing it will do, or why it is
 * disabled. The longer "why" is one ⓘ away.
 */
function FooterHint({
  action,
  hintId,
  describeScope,
  hasRemainingDefects,
  reasonInfo,
}: {
  readonly action: RepairActionKind;
  readonly hintId: string;
  readonly describeScope: string;
  readonly hasRemainingDefects: boolean;
  readonly reasonInfo: ReturnType<typeof useInfoDisclosure>;
}): ReactNode {
  switch (action) {
    case RepairActionKind.Ready:
      return (
        <p className="convert-footer__hint" id={hintId} data-testid="repair-scope">
          {describeScope}
        </p>
      );
    case RepairActionKind.NothingSafe:
    case RepairActionKind.NothingFound:
      return (
        <>
          <div className="repair-footer__reason">
            <p className="convert-footer__hint" id={hintId} data-testid="repair-no-repairs">
              {action === RepairActionKind.NothingSafe ? NO_SAFE_REPAIRS : NO_REPAIRABLE_PROBLEMS}
            </p>
            <InfoButton
              disclosure={reasonInfo}
              label="automatic repair"
              testId="repair-no-repairs-info"
            />
          </div>
          <InfoPanel disclosure={reasonInfo} label="automatic repair">
            <p className="info-panel__text" data-testid="repair-no-repairs-detail">
              {describeNoRepairsAvailable(hasRemainingDefects)}
            </p>
          </InfoPanel>
        </>
      );
    case RepairActionKind.Unavailable:
      return (
        <>
          <div className="repair-footer__reason">
            <p className="convert-footer__hint" id={hintId} data-testid="repair-action-unavailable">
              {REPAIR_UNAVAILABLE_LINE}
            </p>
            <InfoButton disclosure={reasonInfo} label="repair availability" />
          </div>
          <InfoPanel disclosure={reasonInfo} label="repair availability">
            <p className="info-panel__text">{REPAIR_ISOLATION_DETAIL}</p>
          </InfoPanel>
        </>
      );
    case RepairActionKind.Analyze:
      return (
        <p className="convert-footer__hint" id={hintId}>
          Pybrix checks the mesh before it can repair it.
        </p>
      );
    case RepairActionKind.Preview:
      return (
        <p className="convert-footer__hint" id={hintId}>
          Apply replaces the model with the validated preview. You can undo it.
        </p>
      );
    case RepairActionKind.NoModel:
    case RepairActionKind.Analyzing:
    case RepairActionKind.Planning:
    case RepairActionKind.PlanFailed:
    case RepairActionKind.Building:
    case RepairActionKind.Applying:
    case RepairActionKind.Undoing:
      return <span id={hintId} hidden />;
  }
}
