import { useEffect, useId, useRef, type ReactNode } from 'react';
import {
  CompatibilityDisposition,
  CompatibilityFeature,
  ExportFormat,
  isExportFormat,
  type ConversionCompatibilityReport,
} from '@cadfixer/file-formats';
import {
  BEFORE_CONVERTING_NOTE,
  CONVERSION_QUALIFIER,
  CONVERT_WORKSPACE_COPY,
  OBJECTS_LABEL,
  OUTPUT_FORMATS_NOTE,
  OUTPUT_VARIANTS,
  OutputSizeKind,
  PENDING_PREVIEW_NOTE,
  REVIEW_IN_REPAIR,
  UNITS_LABEL,
  UNKNOWN_SIZE_MARK,
  UNIT_ASSERTION_EXPLANATION,
  UNIT_ASSERTION_SCOPE,
  UNIT_CHOICES,
  UNIT_REQUIRED_HEADLINE,
  NO_MODEL_NOTE,
  describeConvertAction,
  describeConvertUnavailable,
  describeExportFailure,
  describeExportFailureHeadline,
  describeOutput,
  describeOutputSizeKind,
  describeOutputUnit,
  describePartCount,
  describePhase,
  describeSaved,
  describeSizeRefusalDetails,
  describeSourceKind,
  describeSourceUnit,
  describeStatedUnit,
  describeStructure,
  describeUnrecordedUnit,
  formatExportBytes,
  type OutputVariant,
} from '../state/conversion-presentation';
import { describeSourceFormat, type LoadedModel } from '../state/model';
import { measurementUnitKey, outputSize, type OutputSize } from '../state/output-size';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { useDocumentConversion } from '../state/use-document-conversion';
import { WorkflowId } from '../state/workflows';
import {
  ConversionState,
  HoleFillWorkState,
  RepairCandidateState,
  refusedExportFor,
  type MeasuredExport,
} from '../state/workspace-store';
import { ConversionReport } from './ConversionReport';
import { Icon } from './shell/Icon';
import { InfoButton, InfoPanel, useInfoDisclosure, type InfoDisclosure } from './shell/info';
import { PanelSection } from './shell/primitives';

/**
 * THE CONVERT WORKSPACE — the one place a document becomes a file.
 *
 * PRESENTATION ONLY. The compatibility report is `analyseConversion`'s, the
 * wording is `conversion-presentation.ts`'s, the sizes are `output-size.ts`'s
 * and the operation is `useDocumentConversion`'s, which drives the same
 * validated export worker every document export has always used. Nothing here
 * decides what a format keeps, and nothing here writes a byte.
 *
 * ONE FORMAT PER EXPORT, and the controls say so. `DocumentExportService` runs
 * one export at a time and each export is one validated file, so the output
 * grid is a single-choice radio group rather than the reference's multi-select:
 * a multi-select over a one-at-a-time engine would be a queue the product does
 * not have. For the same reason the selected card and the card whose options
 * are shown are the same thing — there is one choice, not two.
 *
 * WHOLE DOCUMENT, ALWAYS. Every target writes every part; the active part
 * decides nothing here.
 *
 * STAYS MOUNTED WHILE HIDDEN, like every workspace panel: the conversion hook
 * cancels what it started when it unmounts, and switching tabs is not a reason
 * to throw away someone's file.
 */
export function ConvertWorkspace({ active }: { readonly active: boolean }): ReactNode {
  const { model, conversion, repair, holeFill } = useWorkspaceState();
  const store = useWorkspaceStore();
  const { report, start, chooseTarget, chooseUnit, convert, cancel } = useDocumentConversion();

  /*
   * A SESSION STARTS WHEN THE WORKSPACE IS SHOWN FOR A MODEL, preselecting the
   * source format. Starting it earlier would preselect a target for a model
   * nobody has asked to convert; the report it enables is pure and costs a
   * walk over part descriptors, and no export worker exists until Convert is
   * pressed.
   */
  useEffect(() => {
    if (active && model !== undefined) start();
  }, [active, model, start]);

  const working = conversion.state === ConversionState.Working;
  const target =
    conversion.target !== undefined && isExportFormat(conversion.target)
      ? conversion.target
      : undefined;
  const exportable = report?.exportable === true;
  const pendingPreview =
    repair.candidateState === RepairCandidateState.Ready ||
    holeFill.workState === HoleFillWorkState.Ready;
  /*
   * REFUSED FOR SIZE AT THIS REVISION, TARGET AND UNIT — Convert P1. The same
   * three can only be refused again, so the action is disabled with the reason
   * beside it rather than offered for another four-second wait.
   */
  const refusedForSize =
    model !== undefined &&
    target !== undefined &&
    refusedExportFor(
      conversion.refused,
      model.handle,
      target,
      measurementUnitKey(model, target, conversion.unitAssertion),
    ) !== undefined
      ? target
      : undefined;
  const outcomeInfo = useInfoDisclosure();

  return (
    <div className="convert-workspace" data-testid="convert-workspace">
      <div className="convert-workspace__sections">
        <PanelSection title={CONVERT_WORKSPACE_COPY.sourceSection} testId="convert-source-section">
          {model === undefined ? <EmptySource /> : <SourceCard model={model} />}
        </PanelSection>

        <PanelSection
          title={CONVERT_WORKSPACE_COPY.outputsSection}
          meta={CONVERT_WORKSPACE_COPY.outputsMeta}
          testId="convert-outputs"
        >
          <OutputGrid
            model={model}
            target={target}
            unitAssertion={conversion.unitAssertion}
            measured={conversion.measured}
            disabled={working || model === undefined}
            onChoose={chooseTarget}
          />
          <p className="convert-workspace__note">{OUTPUT_FORMATS_NOTE}</p>
        </PanelSection>

        <PanelSection
          title={CONVERT_WORKSPACE_COPY.optionsSection}
          meta={target === undefined ? undefined : describeOutput(target)}
          testId="convert-options"
        >
          {model === undefined || target === undefined || report === undefined ? (
            <p className="panel__empty">{CONVERT_WORKSPACE_COPY.optionsEmpty}</p>
          ) : (
            <FormatOptions
              model={model}
              target={target}
              report={report}
              unitAssertion={conversion.unitAssertion}
              disabled={working}
              onChooseUnit={chooseUnit}
            />
          )}
        </PanelSection>

        <PanelSection title={CONVERT_WORKSPACE_COPY.beforeSection} testId="convert-before">
          <p className="convert-workspace__note">{BEFORE_CONVERTING_NOTE}</p>
          {pendingPreview ? (
            <p className="convert-workspace__caution" data-testid="convert-pending-preview">
              {PENDING_PREVIEW_NOTE}
            </p>
          ) : null}
          <button
            type="button"
            className="secondary-action"
            disabled={model === undefined}
            onClick={() => {
              store.selectWorkflow(WorkflowId.Repair);
            }}
            data-testid="convert-review-repair"
          >
            <Icon name="repair" size={14} />
            {REVIEW_IN_REPAIR}
          </button>
        </PanelSection>

        <OutcomeDetails disclosure={outcomeInfo} target={target} refusedForSize={refusedForSize} />
      </div>

      <ConvertFooter
        hasModel={model !== undefined}
        sourceFormat={model?.source.formatId}
        target={target}
        exportable={exportable}
        refusedForSize={refusedForSize}
        outcomeInfo={outcomeInfo}
        onConvert={convert}
        onCancel={cancel}
      />
    </div>
  );
}

/* ---------------------------------------------------------- source card -- */

function EmptySource(): ReactNode {
  // The Open action is the workspace's empty state above this section
  // (UI-07A); a second one here would be the same command twice.
  return (
    <div className="source-card source-card--empty" data-testid="convert-source-empty">
      <p className="convert-workspace__note">{NO_MODEL_NOTE}</p>
    </div>
  );
}

/**
 * The file this workspace is converting, as the file itself describes it.
 *
 * EVERY VALUE IS THE IMPORT'S. Nothing here says "no colours" or "no
 * materials", because CAD Fixer does not read colours and a model with no
 * material REFERENCE may still have had materials in a form that was never
 * imported — which the report's source warnings state when it happened. The
 * chips show only what the document actually records.
 */
function SourceCard({ model }: { readonly model: LoadedModel }): ReactNode {
  const { source } = model;
  const partCount = model.parts.length;
  const materialRefs = model.parts.some(
    (part) => part.materialRef !== undefined || part.groupMaterialRefCount > 0,
  );
  const kind = describeSourceKind(describeSourceFormat(source), source.formatId, source.encoding);

  return (
    <div className="source-card">
      <span className="source-card__thumb" aria-hidden="true">
        <Icon name="cube" size={20} />
      </span>
      <div className="source-card__text">
        {/* User-supplied text, rendered as text. Never markup, never a path. */}
        <p
          className="source-card__name"
          title={source.fileName}
          data-testid="convert-source"
          aria-label={`Source file: ${source.fileName}`}
        >
          {source.fileName}
        </p>
        <p className="source-card__meta" data-testid="convert-source-meta">
          {kind} · {formatExportBytes(source.fileBytes)} · {model.triangleCount.toLocaleString()}{' '}
          triangles
        </p>
        <ul className="source-card__chips" aria-label={CONVERT_WORKSPACE_COPY.chipsLabel}>
          <li className="chip" data-testid="convert-source-parts">
            {describePartCount(partCount)}
          </li>
          <li className="chip" data-testid="convert-source-unit">
            {describeSourceUnit(source.unit)}
          </li>
          {materialRefs ? (
            <li className="chip" data-testid="convert-source-materials">
              {CONVERT_WORKSPACE_COPY.materialReferences}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- output grid -- */

interface OutputGridProps {
  readonly model: LoadedModel | undefined;
  readonly target: ExportFormat | undefined;
  readonly unitAssertion: string | undefined;
  readonly measured: readonly MeasuredExport[];
  readonly disabled: boolean;
  readonly onChoose: (format: ExportFormat) => void;
}

/**
 * The output cards: a native radio group, drawn as tiles.
 *
 * NATIVE RADIOS, so arrow keys move between cards, Tab enters and leaves the
 * group once, and the checked state is announced by the platform. The input is
 * visually hidden inside a `<label>` that is the card; focus shows on the card.
 * The selected card carries a check mark as well as the accent border, so the
 * state never depends on colour.
 */
function OutputGrid({
  model,
  target,
  unitAssertion,
  measured,
  disabled,
  onChoose,
}: OutputGridProps): ReactNode {
  return (
    <div className="format-grid" role="radiogroup" aria-label={CONVERT_WORKSPACE_COPY.outputsGroup}>
      {OUTPUT_VARIANTS.map((variant) => (
        <FormatCard
          key={variant.id}
          variant={variant}
          selected={variant.format !== undefined && variant.format === target}
          disabled={disabled || variant.format === undefined}
          size={
            model === undefined || variant.format === undefined
              ? undefined
              : outputSize(model, variant.format, unitAssertion, measured)
          }
          onChoose={onChoose}
        />
      ))}
    </div>
  );
}

function FormatCard({
  variant,
  selected,
  disabled,
  size,
  onChoose,
}: {
  readonly variant: OutputVariant;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly size: OutputSize | undefined;
  readonly onChoose: (format: ExportFormat) => void;
}): ReactNode {
  const detailId = useId();
  const format = variant.format;
  const unavailable = format === undefined;
  /*
   * A CARD IS TOO NARROW FOR "On export", so an unknown or unavailable size is
   * a dash — never alone: the accessible description and the tooltip carry the
   * sentence saying why.
   */
  const sizeText =
    unavailable || size === undefined || size.kind === OutputSizeKind.Unknown
      ? UNKNOWN_SIZE_MARK
      : formatExportBytes(size.bytes);
  const detail = unavailable
    ? (variant.unavailableReason ?? '')
    : size === undefined
      ? ''
      : describeOutputSizeKind(size.kind);

  return (
    <label
      className="format-card"
      data-selected={selected ? 'true' : 'false'}
      data-unavailable={unavailable ? 'true' : 'false'}
      title={detail === '' ? undefined : detail}
    >
      <input
        type="radio"
        name="convert-target"
        className="format-card__input"
        value={variant.id}
        checked={selected}
        disabled={disabled}
        aria-label={variant.accessibleName}
        {...(detail === '' ? {} : { 'aria-describedby': detailId })}
        onChange={() => {
          if (format !== undefined) onChoose(format);
        }}
        data-testid={`convert-target-${variant.id}`}
      />
      <span className="format-card__name">{variant.name}</span>
      <span className="format-card__variant">{variant.variant}</span>
      <span
        className={`format-card__size format-card__size--${unavailable ? 'unavailable' : (size?.kind ?? 'none')}`}
        data-testid={`convert-size-${variant.id}`}
      >
        {sizeText}
      </span>
      {selected ? (
        <span className="format-card__check" aria-hidden="true">
          <Icon name="ok" size={13} />
        </span>
      ) : null}
      {detail === '' ? null : (
        <span className="visually-hidden" id={detailId}>
          {detail}
        </span>
      )}
    </label>
  );
}

/* ------------------------------------------------------- format options -- */

/**
 * What the chosen format will do with THIS model.
 *
 * NO CONTROL APPEARS UNLESS IT CHANGES THE FILE. The one real option is the
 * unit a 3MF must state when the model states none — and it labels the numbers,
 * it never rescales them. Everything else here is a FACT about the output
 * rather than a switch: CAD Fixer has no axis conversion, no unit conversion,
 * no merge option, and writes no colours, materials, textures, thumbnails or
 * 3MF metadata, so none of those has a control that would pretend otherwise.
 */
function FormatOptions({
  model,
  target,
  report,
  unitAssertion,
  disabled,
  onChooseUnit,
}: {
  readonly model: LoadedModel;
  readonly target: ExportFormat;
  readonly report: ConversionCompatibilityReport;
  readonly unitAssertion: string | undefined;
  readonly disabled: boolean;
  readonly onChooseUnit: (unit: string | undefined) => void;
}): ReactNode {
  /*
   * THE UNIT CONTROL STAYS ONCE IT HAS BEEN ANSWERED. It is shown whenever the
   * unit is a question this target asks of this document — unanswered it is a
   * blocker, answered it is an assumption — derived from the report so the
   * workspace never holds a second opinion about when a unit is required.
   */
  const asksForUnit =
    report.blockers.some(
      (fact) =>
        fact.feature === CompatibilityFeature.PhysicalUnit &&
        fact.disposition === CompatibilityDisposition.RequiresUserAssertion,
    ) || report.assumptions.some((fact) => fact.feature === CompatibilityFeature.PhysicalUnit);

  return (
    <div className="format-options">
      {model.parts.length > 1 ? (
        <p className="convert-workspace__note" data-testid="convert-whole-document">
          {CONVERT_WORKSPACE_COPY.wholeDocument}
        </p>
      ) : null}

      {asksForUnit ? (
        <UnitChooser value={unitAssertion} disabled={disabled} onChoose={onChooseUnit} />
      ) : (
        <div className="format-options__field" data-testid="convert-unit-fact">
          <p className="format-options__label">{UNITS_LABEL}</p>
          <p className="format-options__value">
            {describeOutputUnit(target, model.source.unit, unitAssertion)}
          </p>
          <p className="convert-workspace__note">
            {target === ExportFormat.ThreeMf && model.source.unit !== undefined
              ? describeStatedUnit(model.source.unit)
              : describeUnrecordedUnit(target)}
          </p>
        </div>
      )}

      <div className="format-options__field" data-testid="convert-objects-fact">
        <p className="format-options__label">{OBJECTS_LABEL}</p>
        <p className="format-options__value">{describeStructure(target, model.parts.length)}</p>
      </div>

      <ConversionReport report={report} />
      <p className="convert__qualifier">{CONVERSION_QUALIFIER}</p>
    </div>
  );
}

/**
 * The six 3MF units as a single-choice group with NOTHING SELECTED until the
 * user chooses. A preselected unit would be CAD Fixer asserting a physical fact
 * about the model on the user's behalf — the one thing this flow exists to
 * prevent — so no radio starts checked and nothing is remembered from a
 * previous model.
 */
function UnitChooser({
  value,
  disabled,
  onChoose,
}: {
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly onChoose: (unit: string) => void;
}): ReactNode {
  const headingId = useId();
  return (
    <fieldset className="format-options__field unit-chooser" data-testid="convert-unit">
      <legend className="format-options__label" id={headingId}>
        {UNITS_LABEL}
      </legend>
      <p className="format-options__value">{UNIT_REQUIRED_HEADLINE}</p>
      <div className="unit-chooser__options" role="radiogroup" aria-labelledby={headingId}>
        {UNIT_CHOICES.map((choice) => (
          <label
            key={choice.value}
            className="unit-chooser__option"
            data-selected={value === choice.value ? 'true' : 'false'}
            title={choice.label}
          >
            <input
              type="radio"
              name="convert-unit"
              className="unit-chooser__input"
              value={choice.value}
              checked={value === choice.value}
              disabled={disabled}
              aria-label={choice.label}
              onChange={() => {
                onChoose(choice.value);
              }}
              data-testid={`convert-unit-${choice.value}`}
            />
            <span aria-hidden="true">{choice.symbol}</span>
          </label>
        ))}
      </div>
      <p className="convert-workspace__note">{UNIT_ASSERTION_EXPLANATION}</p>
      <p className="convert-workspace__note">{UNIT_ASSERTION_SCOPE}</p>
    </fieldset>
  );
}

/* --------------------------------------------------------------- footer -- */

/**
 * The primary action, its progress and its outcome.
 *
 * STICKY AT THE BOTTOM OF THE PANEL, so the action is reachable however long
 * the report above it is. Its label says what pressing it does — "Convert to
 * 3MF", or "Export STL" when the format does not change — and when it cannot
 * be pressed the reason is written beside it rather than left to a disabled
 * style.
 */
function ConvertFooter({
  hasModel,
  sourceFormat,
  target,
  exportable,
  refusedForSize,
  outcomeInfo,
  onConvert,
  onCancel,
}: {
  readonly hasModel: boolean;
  readonly sourceFormat: string | undefined;
  readonly target: ExportFormat | undefined;
  readonly exportable: boolean;
  readonly refusedForSize: ExportFormat | undefined;
  readonly outcomeInfo: InfoDisclosure;
  readonly onConvert: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { conversion } = useWorkspaceState();
  const hintId = useId();
  const working = conversion.state === ConversionState.Working;
  const unavailable = describeConvertUnavailable(
    hasModel,
    target !== undefined,
    exportable,
    refusedForSize,
  );
  const failure = conversion.state === ConversionState.Failed ? conversion.failure : undefined;
  const percent = Math.round(conversion.fraction * 100);

  return (
    <div className="convert-footer" data-testid="convert-footer">
      {/* THE OUTCOME, announced. A refusal is an alert; progress and success
          are polite, and only the PHASE is announced — a percentage read out
          on every update would drown everything else. */}
      <div className="convert-footer__status" aria-live="polite">
        {working ? (
          <div className="convert-footer__progress" data-testid="convert-progress">
            <div className="convert-footer__progress-row">
              {/* THE PHASE IS THE WRITER'S OWN, not a fabricated animation. */}
              <span data-testid="convert-phase">{describePhase(conversion.phase)}</span>
              <span data-testid="convert-percent" aria-hidden="true">
                {percent}%
              </span>
            </div>
            <progress
              className="import__bar"
              max={100}
              value={percent}
              aria-label={`Export progress: ${String(percent)}%`}
            />
          </div>
        ) : null}
        {conversion.state === ConversionState.Saved && conversion.result !== undefined ? (
          <p className="convert-footer__saved" data-testid="convert-saved">
            <Icon name="ok" size={14} />
            <span>
              {describeSaved(
                conversion.result.fileName,
                conversion.result.byteLength,
                conversion.result.triangleCount,
              )}
            </span>
          </p>
        ) : null}
      </div>
      {/* ONE LINE, NEVER A PARAGRAPH — Convert P1. The full sentence is behind
          ⓘ, in the scrolling content: a paragraph here grew the sticky footer
          until the button left the panel on a short window. */}
      {failure !== undefined ? (
        <div className="convert-footer__failure" role="alert" data-testid="convert-failure">
          <span className="convert-footer__failure-text">
            {describeExportFailureHeadline(failure.status, target)}
          </span>
          {refusedForSize === undefined ? (
            <InfoButton
              disclosure={outcomeInfo}
              label="this export"
              testId="convert-failure-info"
            />
          ) : null}
        </div>
      ) : null}

      <div className="convert-footer__actions">
        {working ? (
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={onCancel}
            data-testid="convert-cancel"
          >
            {CONVERT_WORKSPACE_COPY.cancel}
          </button>
        ) : null}
        <button
          type="button"
          className="primary-action convert-footer__primary"
          onClick={onConvert}
          disabled={working || unavailable !== undefined}
          aria-busy={working}
          {...(unavailable === undefined ? {} : { 'aria-describedby': hintId })}
          data-testid="convert-export"
        >
          <Icon name="convert" size={16} />
          <span>{describeConvertAction(sourceFormat, target, working)}</span>
        </button>
      </div>
      {unavailable === undefined || working ? null : (
        <div className="convert-footer__hint-row">
          <p className="convert-footer__hint" id={hintId} data-testid="convert-unavailable">
            {unavailable}
          </p>
          {refusedForSize === undefined ? null : (
            <InfoButton
              disclosure={outcomeInfo}
              label="this export limit"
              testId="convert-refusal-info"
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------ outcome details -- */

/**
 * WHAT THE LAST EXPORT MEANT, in full, behind the footer's ⓘ — Convert P1.
 *
 * IN THE SCROLLING CONTENT, directly above the sticky footer, never inside it:
 * the footer holds only bounded content so the action cannot be pushed out of
 * the panel, while this can be as long as the explanation needs. Opening it
 * scrolls the panel's own scroll area to the end so it lands beside the button
 * — the panel's scroller, set directly, never `scrollIntoView`, which would
 * also scroll every clipped ancestor and move the whole application shell.
 */
function OutcomeDetails({
  disclosure,
  target,
  refusedForSize,
}: {
  readonly disclosure: InfoDisclosure;
  readonly target: ExportFormat | undefined;
  readonly refusedForSize: ExportFormat | undefined;
}): ReactNode {
  const { conversion } = useWorkspaceState();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!disclosure.open) return;
    const scroller = ref.current?.closest('.tool-panel__body');
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight;
  }, [disclosure.open]);

  const failure = conversion.state === ConversionState.Failed ? conversion.failure : undefined;
  const paragraphs =
    refusedForSize !== undefined
      ? describeSizeRefusalDetails(refusedForSize)
      : failure !== undefined
        ? [describeExportFailure(failure.status, failure.reason)]
        : [];
  // Nothing left to explain — the outcome was replaced — so nothing stays open.
  const empty = paragraphs.length === 0;
  const { open, close } = disclosure;
  useEffect(() => {
    if (open && empty) close();
  }, [open, empty, close]);
  const label =
    failure === undefined ? 'this export' : describeExportFailureHeadline(failure.status, target);

  return (
    <div ref={ref} className="convert-outcome-details">
      <InfoPanel disclosure={disclosure} label={label} testId="convert-outcome-details">
        {paragraphs.map((text) => (
          <p key={text} className="info-panel__text">
            {text}
          </p>
        ))}
      </InfoPanel>
    </div>
  );
}
