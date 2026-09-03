import { useEffect, useRef, type ReactNode } from 'react';
import type {
  ConservativeRepairPlan,
  RepairChangeCounts,
  RepairChangeSamples,
  RepairOperation,
  RepairOperationDecision,
  RepairValidation,
} from '@cadfixer/geometry-runtime';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { useConservativeRepair } from '../state/use-conservative-repair';
import { useTopologyAnalysis } from '../state/use-topology-analysis';
import {
  DeltaMeaning,
  NO_REPAIRS_AVAILABLE_HEADLINE,
  REPAIR_APPLIED_DETAIL,
  REPAIR_APPLIED_HEADLINE,
  REPAIR_EXCLUSIONS,
  REPAIR_OPERATION_COPY,
  REPAIR_OPERATION_ORDER,
  REPAIR_QUALIFIER,
  REPAIR_WORKFLOW_SUMMARY,
  REPAIR_WORKFLOW_TITLE,
  buildMetricRows,
  describeBoundsComparison,
  describeAnalysisDependency,
  describeChangeSampling,
  describeNoRepairsAvailable,
  describeVolumeComparison,
  describeVolumeComparisonHelp,
  presentAcceptance,
  presentDecision,
} from '../state/repair-presentation';
import { formatArea, formatMagnitude, totalDefectCount } from '../state/topology-presentation';
import {
  AnalysisState,
  RepairCandidateState,
  RepairCommitState,
  RepairPlanState,
  RepairPreviewMode,
  type ChangeOverlayId,
} from '../state/workspace-store';
import { WorkflowId } from '../state/workflows';

/**
 * The conservative repair workflow.
 *
 * PRESENTATION AND DISPATCH ONLY. Every decision shown here was made in the
 * worker; every sentence was written in `repair-presentation.ts`. This component
 * runs no repair logic, decides no safety question, and — critically — cannot
 * commit anything: `Apply` calls a hook that calls the worker, and the worker
 * re-checks every guard before it swaps a single reference.
 *
 * WHAT THE SCREEN IS FOR. Four things, in this order: what CAD Fixer knows, what
 * it proposes to change, what it refused to change and why, and what it has not
 * checked at all. A user should be able to leave this panel knowing which of
 * those four applies to their model. Making the model look green is not one of
 * the goals.
 *
 * EVERY OPERATION IS LISTED, always — including the ones with nothing to do and
 * the ones that were refused. An absent row leaves the user wondering whether
 * the check ran.
 */
export function RepairPanel(): ReactNode {
  const { model, analysis, repair, selectedWorkflow } = useWorkspaceState();
  const store = useWorkspaceStore();
  const controls = useConservativeRepair();
  const { runAnalysis, isAnalyzing, canRetry } = useTopologyAnalysis();
  const headingRef = useRef<HTMLHeadingElement>(null);

  /**
   * Moves focus here when the workflow is chosen from the navigation.
   *
   * The panel is always on screen, so "opening" it is a matter of attention
   * rather than mounting. Focusing the heading is what makes the navigation
   * button do something real for a keyboard or screen-reader user instead of
   * only highlighting itself.
   */
  useEffect(() => {
    if (selectedWorkflow !== WorkflowId.Repair) return;
    headingRef.current?.focus();
  }, [selectedWorkflow]);

  if (model === undefined) {
    return (
      <section className="panel" aria-labelledby="repair-title">
        <h2 className="panel__title" id="repair-title" tabIndex={-1} ref={headingRef}>
          {REPAIR_WORKFLOW_TITLE}
        </h2>
        <p className="panel__empty" data-testid="repair-empty">
          No model loaded.
        </p>
        <Exclusions />
      </section>
    );
  }

  const plan = repair.plan;
  const candidate = repair.candidate;
  const previewReady =
    repair.candidateState === RepairCandidateState.Ready && candidate !== undefined;
  const isCancelling = repair.candidateState === RepairCandidateState.Cancelling;
  // The progress block stays up through cancellation: the worker is still
  // unwinding, and hiding it would suggest the work had already stopped.
  const isBuilding = repair.candidateState === RepairCandidateState.Building || isCancelling;
  const isCommitting = repair.commitState !== RepairCommitState.Idle;
  const percent = Math.round(repair.fraction * 100);

  /*
   * THE ANALYSIS DEPENDENCY, stated rather than hidden. A plan is derived from a
   * topology report for the CURRENT revision. While one is missing there is
   * nothing honest to plan from, and the user is told which of the four reasons
   * applies rather than being shown an empty panel.
   */
  const reportIsCurrent =
    analysis.state === AnalysisState.Ready &&
    analysis.report !== undefined &&
    analysis.handle?.modelId === model.handle.modelId &&
    analysis.handle.revision === model.handle.revision;

  return (
    <section className="panel" aria-labelledby="repair-title" data-testid="repair-panel">
      <h2 className="panel__title" id="repair-title" tabIndex={-1} ref={headingRef}>
        {REPAIR_WORKFLOW_TITLE}
      </h2>
      <p className="panel__note" data-testid="repair-summary">
        {REPAIR_WORKFLOW_SUMMARY}
      </p>

      {repair.lastApplied === undefined ? null : (
        <AppliedBanner
          operations={repair.lastApplied.appliedOperations}
          counts={repair.lastApplied.counts}
          undoable={repair.lastApplied.undoable}
          undoing={repair.commitState === RepairCommitState.Undoing}
          busy={isCommitting}
          onUndo={controls.undoLastRepair}
        />
      )}

      {!reportIsCurrent ? (
        <div className="repair__blocked" data-testid="repair-unavailable">
          <p className="panel__note" data-testid="repair-analysis-note">
            {describeAnalysisDependency(analysis.state, isAnalyzing)}
          </p>
          {!isAnalyzing && canRetry ? (
            <button
              type="button"
              className="action"
              onClick={runAnalysis}
              data-testid="repair-run-analysis"
            >
              Run analysis
            </button>
          ) : null}
        </div>
      ) : repair.planState === RepairPlanState.Failed && repair.planError !== undefined ? (
        <div className="repair__blocked" role="alert" data-testid="repair-plan-error">
          <p className="repair__error-message">{repair.planError.message}</p>
          <p className="panel__note">
            Your model is unchanged and can still be viewed, analysed and exported.
          </p>
          {repair.planError.retryable ? (
            <button
              type="button"
              className="action"
              onClick={controls.replan}
              data-testid="repair-replan"
            >
              Try planning again
            </button>
          ) : null}
        </div>
      ) : plan === undefined ? (
        <p className="panel__note" data-testid="repair-planning">
          Working out what can be repaired conservatively…
        </p>
      ) : (
        <>
          <OperationList
            plan={plan}
            selection={repair.selection}
            disabled={isBuilding || isCommitting || previewReady}
            onToggle={controls.setOperationSelected}
          />

          {plan.warnings.length > 0 ? (
            <ul className="repair__warnings" data-testid="repair-plan-warnings">
              {plan.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}

          {/* The decision list above is the PREVIOUS plan while a new one is
              computed, so the panel does not blank on every checkbox click.
              Saying so is the difference between stale and wrong. */}
          {repair.planState === RepairPlanState.Planning ? (
            <p className="panel__note" data-testid="repair-replanning">
              Updating the plan for the operations you selected…
            </p>
          ) : null}

          {plan.noOp && repair.planState === RepairPlanState.Ready ? (
            <div className="repair__nothing" data-testid="repair-no-repairs">
              <p className="repair__headline">{NO_REPAIRS_AVAILABLE_HEADLINE}</p>
              <p className="panel__note">
                {describeNoRepairsAvailable(totalDefectCount(analysis.report) > 0)}
              </p>
              <p className="panel__note" data-testid="repair-nothing-qualifier">
                {REPAIR_QUALIFIER}
              </p>
            </div>
          ) : null}
        </>
      )}

      {/* --- preparing a candidate ---------------------------------------- */}
      {isBuilding ? (
        <div className="repair__progress" data-testid="repair-progress">
          <div className="import__progress-row">
            <span data-testid="repair-phase">{repair.phase ?? 'Preparing repair'}</span>
            <span data-testid="repair-percent">{percent}%</span>
          </div>
          <progress
            className="import__bar"
            max={100}
            value={percent}
            aria-label={`Repair preparation progress: ${String(percent)}%`}
          />
          <button
            type="button"
            className="import__cancel"
            onClick={controls.cancelPreview}
            // Disabled once cancellation is signalled: the flag is already set,
            // and a second press cannot make the worker unwind sooner.
            disabled={isCancelling}
            data-testid="cancel-repair"
          >
            {isCancelling ? 'Cancelling…' : 'Cancel repair'}
          </button>
          {isCancelling ? (
            <p className="panel__note" role="status" data-testid="repair-cancelling">
              Cancelling… CAD Fixer has told the repair to stop and is waiting for it to confirm.
              Nothing has been changed.
            </p>
          ) : null}
        </div>
      ) : null}

      {repair.candidateState === RepairCandidateState.Cancelled ? (
        <p className="panel__note" data-testid="repair-cancelled">
          Repair was cancelled. Nothing was changed, and you can prepare it again.
        </p>
      ) : null}

      {repair.candidateState === RepairCandidateState.Failed &&
      repair.candidateError !== undefined ? (
        <div className="repair__blocked" role="alert" data-testid="repair-candidate-error">
          <p className="repair__error-message">{repair.candidateError.message}</p>
          <p className="panel__note" data-testid="repair-candidate-error-qualifier">
            {REPAIR_QUALIFIER}
          </p>
        </div>
      ) : null}

      {/* Preview is offered only for a plan that is CURRENT. While a new plan is
          being computed the decisions on screen belong to the previous
          selection, and building from them would apply something other than what
          the user is looking at — the worker would refuse the mismatched plan
          hash anyway, but a button that can only fail should not be offered. */}
      {plan !== undefined &&
      repair.planState === RepairPlanState.Ready &&
      !plan.noOp &&
      !previewReady &&
      !isBuilding ? (
        <div className="panel__actions">
          <button
            type="button"
            className="action action--primary"
            onClick={controls.previewRepair}
            disabled={isCommitting || !reportIsCurrent}
            data-testid="preview-repair"
          >
            Preview repair
          </button>
        </div>
      ) : null}

      {/* --- the validated candidate -------------------------------------- */}
      {previewReady ? (
        <CandidateReview
          validation={candidate.validation}
          counts={candidate.counts}
          samples={candidate.samples}
          unit={model.source.unit}
          previewMode={repair.previewMode}
          overlays={repair.changeOverlays}
          committing={isCommitting}
          percent={percent}
          phase={repair.phase}
          onPreviewMode={controls.setPreviewMode}
          onOverlayToggle={(overlay, next) => {
            store.setChangeOverlayVisible(overlay, next);
          }}
          onApply={controls.applyRepair}
          onDiscard={controls.discardPreview}
        />
      ) : null}

      {repair.commitError !== undefined ? (
        <p className="repair__error-message" role="alert" data-testid="repair-commit-error">
          {repair.commitError.message}
        </p>
      ) : null}

      <Exclusions />

      {controls.memoryCeiling.narrowed ? (
        <p className="panel__note" data-testid="repair-memory-note">
          A reduced repair memory ceiling of{' '}
          {Math.round(controls.memoryCeiling.bytes / 1048576).toLocaleString()} MiB is in force for
          this session, set by a URL option. Repairs above it are refused before anything is
          allocated. This option can only lower the limit, never raise it.
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------ exclusions -- */

/**
 * What this workflow does not do.
 *
 * PART A2, on screen and not only in a document. A user who cannot find their
 * defect in the operation list above needs to know whether CAD Fixer looked and
 * refused or never looked at all — and those are genuinely different answers.
 */
function Exclusions(): ReactNode {
  return (
    <>
      <h3 className="panel__subtitle">What this does not do</h3>
      <ul className="repair__exclusions" data-testid="repair-exclusions">
        {REPAIR_EXCLUSIONS.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
    </>
  );
}

/* ------------------------------------------------------------- operations -- */

function OperationList({
  plan,
  selection,
  disabled,
  onToggle,
}: {
  readonly plan: ConservativeRepairPlan;
  readonly selection: readonly RepairOperation[];
  readonly disabled: boolean;
  readonly onToggle: (operation: RepairOperation, selected: boolean) => void;
}): ReactNode {
  const byOperation = new Map<RepairOperation, RepairOperationDecision>(
    plan.decisions.map((entry) => [entry.operation, entry]),
  );

  return (
    <>
      <h3 className="panel__subtitle" id="repair-operations-title">
        Operations
      </h3>
      <ul
        className="repair__operations"
        aria-labelledby="repair-operations-title"
        data-testid="repair-operations"
      >
        {REPAIR_OPERATION_ORDER.map((operation) => {
          const decision = byOperation.get(operation);
          const copy = REPAIR_OPERATION_COPY[operation];
          if (decision === undefined) {
            // The plan always decides every operation. If one is missing, say so
            // rather than rendering a row that implies it was considered.
            return (
              <li
                className="repair__operation"
                key={operation}
                data-testid={`repair-op-${operation}`}
              >
                <span className="repair__operation-name">{copy.label}</span>
                <p className="repair__operation-reason">
                  CAD Fixer did not report a decision for this operation.
                </p>
              </li>
            );
          }

          const presented = presentDecision(decision);
          const checked = selection.includes(operation);
          const reasonId = `repair-op-reason-${operation}`;

          return (
            <li
              className={`repair__operation repair__operation--${presented.tone}`}
              key={operation}
              data-testid={`repair-op-${operation}`}
            >
              <label className="repair__operation-label">
                <input
                  type="checkbox"
                  checked={checked}
                  // A refused or blocked operation cannot be selected: selecting
                  // it would produce a plan that refuses it again, which reads
                  // as the checkbox not working.
                  disabled={disabled || !presented.selectable}
                  aria-describedby={reasonId}
                  onChange={(event) => {
                    onToggle(operation, event.target.checked);
                  }}
                  data-testid={`repair-op-toggle-${operation}`}
                />
                <span className="repair__operation-name">{copy.label}</span>
              </label>

              {/* The verdict is text, never colour alone. */}
              <p
                className="repair__operation-verdict"
                data-testid={`repair-op-verdict-${operation}`}
              >
                {presented.verdict}
              </p>
              <p className="repair__operation-reason" id={reasonId} data-testid={reasonId}>
                {presented.reason}
              </p>
              <p className="repair__operation-help">{copy.help}</p>
              <p className="repair__operation-counts">
                <span data-testid={`repair-op-targeted-${operation}`}>
                  {decision.targetedCount.toLocaleString()}
                </span>{' '}
                found ·{' '}
                <span data-testid={`repair-op-mutations-${operation}`}>
                  {decision.expectedFaceMutations.toLocaleString()}
                </span>{' '}
                triangles would change
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* -------------------------------------------------------- candidate review -- */

function CandidateReview({
  validation,
  counts,
  samples,
  unit,
  previewMode,
  overlays,
  committing,
  percent,
  phase,
  onPreviewMode,
  onOverlayToggle,
  onApply,
  onDiscard,
}: {
  readonly validation: RepairValidation;
  readonly counts: RepairChangeCounts;
  readonly samples: RepairChangeSamples;
  readonly unit: string | undefined;
  readonly previewMode: RepairPreviewMode;
  readonly overlays: Readonly<Record<ChangeOverlayId, boolean>>;
  readonly committing: boolean;
  readonly percent: number;
  readonly phase: string | undefined;
  readonly onPreviewMode: (mode: RepairPreviewMode) => void;
  readonly onOverlayToggle: (overlay: ChangeOverlayId, next: boolean) => void;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
}): ReactNode {
  const presented = presentAcceptance(validation.acceptance, validation.regressions);
  const rows = buildMetricRows(validation);

  return (
    <div className="repair__candidate" data-testid="repair-candidate">
      <p className="repair__headline" data-testid="repair-candidate-headline">
        {presented.headline}
      </p>
      <p className="panel__note" data-testid="repair-candidate-qualifier">
        {presented.qualifier}
      </p>
      <p className="panel__note" data-testid="repair-candidate-detail">
        {presented.detail}
      </p>

      {/* --- Part E3: Before / After ------------------------------------- */}
      <fieldset className="repair__view" data-testid="preview-mode">
        <legend className="panel__subtitle">Viewport</legend>
        <label className="repair__view-option">
          <input
            type="radio"
            name="repair-preview-mode"
            checked={previewMode === RepairPreviewMode.Before}
            onChange={() => {
              onPreviewMode(RepairPreviewMode.Before);
            }}
            data-testid="preview-mode-before"
          />
          <span>Before — your model as it is now</span>
        </label>
        <label className="repair__view-option">
          <input
            type="radio"
            name="repair-preview-mode"
            checked={previewMode === RepairPreviewMode.After}
            onChange={() => {
              onPreviewMode(RepairPreviewMode.After);
            }}
            data-testid="preview-mode-after"
          />
          <span>After — the proposed result, not applied</span>
        </label>
      </fieldset>

      {/* --- Part F: the change summary ---------------------------------- */}
      <h3 className="panel__subtitle">What would change</h3>
      <dl className="facts" data-testid="repair-changes">
        <Fact
          label="Duplicate triangles removed"
          value={counts.removedDuplicateFaces.toLocaleString()}
          testId="change-count-removedDuplicates"
        />
        <Fact
          label="Repeated-position triangles removed"
          value={counts.removedRepeatedPositionFaces.toLocaleString()}
          testId="change-count-removedRepeatedPosition"
        />
        <Fact
          label="Zero-area triangles removed"
          value={counts.removedZeroAreaFaces.toLocaleString()}
          testId="change-count-removedZeroArea"
        />
        <Fact
          label="Triangles reversed"
          value={counts.flippedFaces.toLocaleString()}
          testId="change-count-flippedFaces"
        />
      </dl>

      <div className="component-table__scroll">
        <table className="component-table" data-testid="repair-metrics">
          <caption className="component-table__caption">
            Measured before and after by the same analysis, on the same terms. A number that moved
            is not automatically an improvement, and a number that moved is not automatically a
            problem — the column on the right says which.
          </caption>
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-testid={`repair-metric-${row.key}`}>
                <th scope="row">
                  {row.label}
                  {row.note === undefined ? null : (
                    <span className="repair__metric-note" data-testid={`repair-note-${row.key}`}>
                      {row.note}
                    </span>
                  )}
                </th>
                <td data-testid={`repair-before-${row.key}`}>{row.before.toLocaleString()}</td>
                <td data-testid={`repair-after-${row.key}`}>{row.after.toLocaleString()}</td>
                <td data-testid={`repair-delta-${row.key}`}>
                  {describeDelta(row.delta, row.meaning)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="facts" data-testid="repair-measures">
        <Fact
          label="Surface area before"
          value={formatArea(validation.surfaceAreaBefore, unit)}
          testId="repair-area-before"
        />
        <Fact
          label="Surface area after"
          value={formatArea(validation.surfaceAreaAfter, unit)}
          testId="repair-area-after"
        />
        <Fact
          label="Signed volume (algebraic)"
          value={`${formatMagnitude(validation.signedVolumeBefore)} → ${formatMagnitude(validation.signedVolumeAfter)}`}
          testId="repair-volume"
        />
        <Fact
          label="Volume comparison"
          value={describeVolumeComparison(validation.volumeComparison)}
          testId="repair-volume-status"
        />
        <Fact
          label="Bounding box"
          value={describeBoundsComparison(validation.boundsComparison)}
          testId="repair-bounds-status"
        />
        <Fact label="Self-intersections" value="Not checked" testId="repair-selfintersection" />
      </dl>
      <p className="panel__note">{describeVolumeComparisonHelp(validation.volumeComparison)}</p>

      {/* --- Part F2: warnings are not errors ---------------------------- */}
      {validation.warnings.length > 0 ? (
        <>
          <h3 className="panel__subtitle">Worth knowing</h3>
          <ul className="repair__warnings" data-testid="repair-warnings">
            {validation.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      ) : null}

      {/* --- Part G: change overlays ------------------------------------- */}
      <ChangeOverlayControls
        counts={counts}
        samples={samples}
        visible={overlays}
        previewMode={previewMode}
        onToggle={onOverlayToggle}
      />

      {/* --- Part H / I: apply and discard -------------------------------- */}
      {committing ? (
        <div className="repair__progress" data-testid="repair-commit-progress">
          <div className="import__progress-row">
            <span data-testid="repair-commit-phase">{phase ?? 'Applying'}</span>
            <span>{percent}%</span>
          </div>
          <progress
            className="import__bar"
            max={100}
            value={percent}
            aria-label={`Applying repair: ${String(percent)}%`}
          />
        </div>
      ) : null}

      <div className="panel__actions">
        <button
          type="button"
          className="action action--primary"
          onClick={onApply}
          disabled={committing || !presented.previewable}
          data-testid="apply-repair"
        >
          Apply repair
        </button>
        <button
          type="button"
          className="action"
          onClick={onDiscard}
          disabled={committing}
          data-testid="discard-preview"
        >
          Discard preview
        </button>
      </div>
    </div>
  );
}

/**
 * The change delta, worded so a movement is never mislabelled.
 *
 * PART F1. Once the validator ACCEPTED a candidate, every remaining difference
 * was predicted before the rebuild and confirmed after it — including a
 * boundary-edge count that rose because a duplicate that was hiding an opening
 * has been removed. Calling that an error would be the interface inventing a
 * problem the engine explicitly reasoned about and allowed.
 */
function describeDelta(delta: number, meaning: DeltaMeaning): string {
  if (meaning === DeltaMeaning.Unchanged) return 'No change';
  const signed = `${delta > 0 ? '+' : ''}${delta.toLocaleString()}`;
  return meaning === DeltaMeaning.Expected ? `${signed} (expected)` : `${signed} (rejected)`;
}

/* ---------------------------------------------------------- change overlays -- */

interface ChangeOverlayDescriptor {
  readonly id: ChangeOverlayId;
  readonly label: string;
  readonly exact: number;
  readonly drawn: number;
  /** False when the category's triangles do not exist in the current view. */
  readonly availableInView: boolean;
}

function ChangeOverlayControls({
  counts,
  samples,
  visible,
  previewMode,
  onToggle,
}: {
  readonly counts: RepairChangeCounts;
  readonly samples: RepairChangeSamples;
  readonly visible: Readonly<Record<ChangeOverlayId, boolean>>;
  readonly previewMode: RepairPreviewMode;
  readonly onToggle: (overlay: ChangeOverlayId, next: boolean) => void;
}): ReactNode {
  const showingAfter = previewMode === RepairPreviewMode.After;

  const descriptors: readonly ChangeOverlayDescriptor[] = [
    {
      id: 'removedDuplicates',
      label: 'Removed duplicate triangles',
      exact: counts.removedDuplicateFaces,
      drawn: samples.removedDuplicateFaces.length,
      availableInView: !showingAfter,
    },
    {
      id: 'removedRepeatedPosition',
      label: 'Removed repeated-position triangles',
      exact: counts.removedRepeatedPositionFaces,
      drawn: samples.removedRepeatedPositionFaces.length,
      availableInView: !showingAfter,
    },
    {
      id: 'removedZeroArea',
      label: 'Removed zero-area triangles',
      exact: counts.removedZeroAreaFaces,
      drawn: samples.removedZeroAreaFaces.length,
      availableInView: !showingAfter,
    },
    {
      id: 'flippedFaces',
      label: 'Reversed triangles',
      exact: counts.flippedFaces,
      drawn: samples.flippedFaces.length,
      // A flip reorders corners and moves no vertex, so these triangles occupy
      // the same coordinates in both views. The direction marker changes; the
      // highlight does not.
      availableInView: true,
    },
  ];

  return (
    <>
      <h3 className="panel__subtitle" id="change-overlays-title">
        Highlight changes in the viewport
      </h3>
      <ul
        className="overlays"
        aria-labelledby="change-overlays-title"
        data-testid="change-overlay-controls"
      >
        {descriptors.map((descriptor) => {
          const empty = descriptor.exact === 0;
          const sampling = describeChangeSampling(descriptor.drawn, descriptor.exact);
          return (
            <li className="overlays__row" key={descriptor.id}>
              <label className="overlays__label">
                <input
                  type="checkbox"
                  checked={visible[descriptor.id] && !empty && descriptor.availableInView}
                  disabled={empty || !descriptor.availableInView}
                  onChange={(event) => {
                    onToggle(descriptor.id, event.target.checked);
                  }}
                  data-testid={`change-overlay-toggle-${descriptor.id}`}
                />
                <span
                  className={`overlays__swatch overlays__swatch--${descriptor.id}`}
                  aria-hidden="true"
                />
                <span className="overlays__name">{descriptor.label}</span>
                <span
                  className="overlays__count"
                  data-testid={`change-overlay-count-${descriptor.id}`}
                >
                  {descriptor.exact.toLocaleString()}
                </span>
              </label>
              {sampling === undefined ? null : (
                <p
                  className="overlays__sampling"
                  data-testid={`change-overlay-sampling-${descriptor.id}`}
                >
                  {sampling}
                </p>
              )}
              {descriptor.availableInView ? null : (
                <p
                  className="overlays__sampling"
                  data-testid={`change-overlay-unavailable-${descriptor.id}`}
                >
                  These triangles do not exist in the proposed result. Switch the viewport to Before
                  to see where they are.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {samples.truncated ? (
        <p className="panel__note" data-testid="change-overlay-truncated">
          The viewport draws a bounded sample of the changes. The counts beside each category are
          exact.
        </p>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- applied -- */

function AppliedBanner({
  operations,
  counts,
  undoable,
  undoing,
  busy,
  onUndo,
}: {
  readonly operations: readonly RepairOperation[];
  readonly counts: RepairChangeCounts;
  readonly undoable: boolean;
  readonly undoing: boolean;
  readonly busy: boolean;
  readonly onUndo: () => void;
}): ReactNode {
  return (
    <div className="repair__applied" role="status" data-testid="repair-applied">
      <p className="repair__headline" data-testid="repair-applied-headline">
        {REPAIR_APPLIED_HEADLINE}
      </p>
      <p className="panel__note" data-testid="repair-applied-detail">
        {REPAIR_APPLIED_DETAIL}
      </p>
      <p className="panel__note" data-testid="repair-applied-qualifier">
        {REPAIR_QUALIFIER}
      </p>
      <ul className="repair__applied-list" data-testid="repair-applied-operations">
        {operations.map((operation) => (
          <li key={operation}>{REPAIR_OPERATION_COPY[operation].label}</li>
        ))}
      </ul>
      <p className="panel__note" data-testid="repair-applied-counts">
        {counts.sourceFaceCount.toLocaleString()} triangles before ·{' '}
        {counts.candidateFaceCount.toLocaleString()} after
      </p>
      <div className="panel__actions">
        <button
          type="button"
          className="action"
          onClick={onUndo}
          disabled={!undoable || busy}
          data-testid="undo-repair"
        >
          {undoing ? 'Undoing repair…' : 'Undo repair'}
        </button>
      </div>
      {undoable ? null : (
        <p className="panel__note" data-testid="repair-undo-unavailable">
          This repair can no longer be undone.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- utilities -- */

function Fact({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId?: string;
}): ReactNode {
  return (
    <div className="facts__row">
      <dt className="facts__label">{label}</dt>
      <dd className="facts__value" {...(testId === undefined ? {} : { 'data-testid': testId })}>
        {value}
      </dd>
    </div>
  );
}
