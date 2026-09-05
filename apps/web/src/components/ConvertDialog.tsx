import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import {
  CompatibilityDisposition,
  CompatibilityFeature,
  ConversionVerdict,
  EXPORT_FORMATS,
  isExportFormat,
  type CompatibilityFact,
  type ConversionCompatibilityReport,
  type ExportFormat,
} from '@cadfixer/file-formats';
import {
  ASSUMPTIONS_HEADLINE,
  BLOCKED_HEADLINE,
  CONVERSION_QUALIFIER,
  LOSSLESS_HEADLINE,
  METADATA_LOSS_HEADLINE,
  PRESERVED_HEADLINE,
  SOURCE_WARNINGS_HEADLINE,
  STRUCTURE_LOSS_HEADLINE,
  UNIT_ASSERTION_EXPLANATION,
  UNIT_ASSERTION_SCOPE,
  UNIT_CHOICES,
  UNIT_REQUIRED_HEADLINE,
  describeExportFailure,
  describeFact,
  describePhase,
  describeTarget,
  describeVerdict,
  formatExportBytes,
  metadataLosses,
  structuralLosses,
  verdictSeverity,
  ConversionSeverity,
} from '../state/conversion-presentation';
import { useDocumentConversion } from '../state/use-document-conversion';
import { useWorkspaceState } from '../state/store-context';
import { ConversionState } from '../state/workspace-store';

/**
 * EXPORT / CONVERT — the one place a document becomes a file.
 *
 * PRESENTATION ONLY. It renders a report it did not compute, in wording it did
 * not choose, and calls a hook that owns the operation. Every sentence comes
 * from `conversion-presentation.ts`, so no component can invent a claim about
 * what a conversion preserves.
 *
 * WHOLE DOCUMENT, ALWAYS. Every target here writes every part. The active-part
 * selection moves the viewport and the diagnostics; it has no effect on what
 * this writes, and the panel says so whenever a document has more than one part
 * — because "Export" quietly meaning "export the bit you clicked" is precisely
 * the kind of silent loss this stage exists to remove.
 */
/** What counts as a stop on the way round the dialog. */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function ConvertDialog(): ReactNode {
  const { model } = useWorkspaceState();
  const { conversion, report, close, chooseTarget, chooseUnit, convert, cancel } =
    useDocumentConversion();
  const titleId = useId();
  const unitId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  const isOpen = conversion.state !== ConversionState.Closed;
  const isWorking = conversion.state === ConversionState.Working;

  /*
   * FOCUS IS MOVED IN AND PUT BACK.
   *
   * Without this a keyboard user presses Export/Convert and focus stays behind
   * the dialog, so the next Tab walks the page underneath — which for a screen
   * reader is a dialog that never opened. The opener is remembered so closing
   * returns focus where it was rather than to the top of the document.
   */
  useEffect(() => {
    if (!isOpen) return;
    openerRef.current = document.activeElement;
    closeRef.current?.focus();
    return (): void => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [isOpen]);

  /**
   * Escape closes — EXCEPT while a file is being written.
   *
   * Nothing here is irreversible, so Escape is safe in every reviewing state.
   * During a write it is deliberately inert: an accidental Escape that silently
   * killed a worker mid-export would look exactly like a finished export that
   * produced no file. Cancel is a labelled button, pressed on purpose.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        if (isWorking) return;
        event.stopPropagation();
        close();
        return;
      }

      /*
       * TAB IS KEPT INSIDE THE DIALOG.
       *
       * `aria-modal` tells assistive technology this is modal, and the backdrop
       * covers the workspace visually — but neither stops the Tab key, so
       * without this a keyboard user tabs off the end of the panel and lands on
       * controls they cannot see, behind an overlay they cannot dismiss from
       * there. The focusable set is read at the moment Tab is pressed rather
       * than cached, because it changes as the dialog does: choosing a target
       * can add the unit selector, and starting an export replaces Export with
       * Cancel.
       */
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (root === null) return;

      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hasAttribute('disabled') && element.tabIndex !== -1,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;

      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [close, isWorking],
  );

  if (!isOpen || model === undefined) return null;

  const target = conversion.target;
  /*
   * THE UNIT CONTROL STAYS ONCE IT HAS BEEN ANSWERED.
   *
   * Keying it off the BLOCKER alone made it vanish the moment a unit was chosen
   * — the blocker was resolved, so the control that resolved it disappeared and
   * the choice could not be changed or even seen. It is shown whenever the unit
   * is a question this target asks of this document, which is exactly "the
   * report has a physical-unit fact that came from the user": unanswered it is a
   * blocker, answered it is an assumption.
   *
   * Derived from the report rather than recomputed, so the dialog never holds a
   * second opinion about when a unit is required.
   */
  const needsUnit =
    (report?.blockers.some(
      (fact) =>
        fact.feature === CompatibilityFeature.PhysicalUnit &&
        fact.disposition === CompatibilityDisposition.RequiresUserAssertion,
    ) ??
      false) ||
    (report?.assumptions.some((fact) => fact.feature === CompatibilityFeature.PhysicalUnit) ??
      false);

  return (
    <div className="convert__backdrop" data-testid="convert-dialog">
      <div
        className="convert"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <div className="convert__bar">
          <h2 className="convert__title" id={titleId}>
            Export / Convert
          </h2>
          <button
            type="button"
            className="convert__close"
            onClick={close}
            ref={closeRef}
            disabled={isWorking}
            data-testid="convert-close"
          >
            Close
          </button>
        </div>

        <p className="convert__source" data-testid="convert-source">
          {/* User-supplied text, rendered as text. Never markup, never a path. */}
          From <span className="convert__filename">{model.source.fileName}</span> —{' '}
          {model.triangleCount.toLocaleString()} triangles
          {model.parts.length > 1 ? `, ${model.parts.length.toLocaleString()} parts` : ''}.
        </p>

        {model.parts.length > 1 ? (
          <p className="convert__note" data-testid="convert-whole-document">
            Every part is written, whichever part is selected in the viewport.
          </p>
        ) : null}

        <fieldset className="convert__targets">
          <legend className="convert__legend">Save as</legend>
          {EXPORT_FORMATS.map((format) => (
            <TargetOption
              key={format}
              format={format}
              selected={target === format}
              disabled={isWorking}
              onChoose={chooseTarget}
            />
          ))}
        </fieldset>

        {report === undefined ? (
          <p className="convert__note">Choose a format to see what it will keep.</p>
        ) : (
          <CompatibilitySummary report={report} />
        )}

        {needsUnit ? (
          <div className="convert__unit" data-testid="convert-unit">
            <h3 className="convert__subtitle">{UNIT_REQUIRED_HEADLINE}</h3>
            <p className="convert__note">{UNIT_ASSERTION_EXPLANATION}</p>
            <p className="convert__note">{UNIT_ASSERTION_SCOPE}</p>
            <label className="convert__unit-label" htmlFor={unitId}>
              These measurements are in
            </label>
            <select
              id={unitId}
              className="convert__unit-select"
              /*
               * VALUE IS THE EMPTY STRING UNTIL A UNIT IS CHOSEN, and the first
               * option is a real, non-selectable placeholder. A `<select>` with
               * no explicit value reports its FIRST option, which would make
               * CAD Fixer silently assert a physical unit nobody picked — the
               * one thing this whole flow exists to prevent.
               */
              value={conversion.unitAssertion ?? ''}
              disabled={isWorking}
              onChange={(event) => {
                chooseUnit(event.target.value === '' ? undefined : event.target.value);
              }}
              data-testid="convert-unit-select"
            >
              <option value="" disabled>
                Choose a unit…
              </option>
              {UNIT_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <p className="convert__qualifier">{CONVERSION_QUALIFIER}</p>

        <div className="convert__actions">
          <button
            type="button"
            className="action convert__primary"
            onClick={convert}
            disabled={isWorking || report?.exportable !== true}
            data-testid="convert-export"
          >
            {target === undefined || !isExportFormat(target)
              ? 'Export'
              : `Export as ${describeTarget(target).label}`}
          </button>
          {isWorking ? (
            <button
              type="button"
              className="import__cancel"
              onClick={cancel}
              data-testid="convert-cancel"
            >
              Cancel
            </button>
          ) : null}
        </div>

        {isWorking ? (
          <div className="convert__progress" data-testid="convert-progress">
            {/*
              THE PHASE IS THE WRITER'S OWN, not a fabricated animation. The
              fraction is what the writer reported; a smooth bar invented on the
              main thread would say nothing about the work.
            */}
            <div className="import__progress-row">
              <span data-testid="convert-phase">{describePhase(conversion.phase)}</span>
              <span data-testid="convert-percent">{Math.round(conversion.fraction * 100)}%</span>
            </div>
            <progress
              className="import__bar"
              max={100}
              value={Math.round(conversion.fraction * 100)}
              aria-label={`Export progress: ${String(Math.round(conversion.fraction * 100))}%`}
            />
          </div>
        ) : null}

        <div aria-live="polite">
          {conversion.state === ConversionState.Failed && conversion.failure !== undefined ? (
            <p className="convert__failure" data-testid="convert-failure">
              {describeExportFailure(conversion.failure.status, conversion.failure.reason)}
            </p>
          ) : null}
          {conversion.state === ConversionState.Saved && conversion.result !== undefined ? (
            <p className="convert__saved" data-testid="convert-saved">
              Saved {conversion.result.fileName} — {formatExportBytes(conversion.result.byteLength)}
              , {conversion.result.triangleCount.toLocaleString()} triangles. The file was read back
              and checked before it was saved.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TargetOption({
  format,
  selected,
  disabled,
  onChoose,
}: {
  readonly format: ExportFormat;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onChoose: (format: ExportFormat) => void;
}): ReactNode {
  const description = describeTarget(format);
  return (
    <label className={`convert__target${selected ? ' convert__target--selected' : ''}`}>
      <input
        type="radio"
        name="convert-target"
        value={format}
        checked={selected}
        disabled={disabled}
        onChange={() => {
          onChoose(format);
        }}
        data-testid={`convert-target-${format}`}
      />
      <span className="convert__target-name">{description.label}</span>
      <span className="convert__target-summary">{description.summary}</span>
    </label>
  );
}

/**
 * The four registers a conversion is reported in.
 *
 * SEVERITY IS PROPORTIONATE. A dropped unit is a note, a merged part list is a
 * caution, and only a genuine blocker gets the strongest treatment. Rendering
 * every format limitation as a danger would train people to close this without
 * reading it — and then the one case that mattered would be closed too.
 *
 * Each section carries its own heading text, so meaning never depends on colour
 * alone.
 */
function CompatibilitySummary({
  report,
}: {
  readonly report: ConversionCompatibilityReport;
}): ReactNode {
  const severity = verdictSeverity(report.verdict);
  const metadata = metadataLosses(report);
  const structural = structuralLosses(report);

  return (
    <div className="convert__report" data-testid="convert-report">
      <p
        className={`convert__verdict convert__verdict--${severity}`}
        data-testid="convert-verdict"
        data-verdict={report.verdict}
      >
        {describeVerdict(report.verdict)}
      </p>

      {report.blockers.length > 0 ? (
        <FactSection
          headline={BLOCKED_HEADLINE}
          severity={ConversionSeverity.Action}
          facts={report.blockers}
          testId="convert-blockers"
        />
      ) : null}

      {structural.length > 0 ? (
        <FactSection
          headline={STRUCTURE_LOSS_HEADLINE}
          severity={ConversionSeverity.Caution}
          facts={structural}
          testId="convert-structure"
        />
      ) : null}

      {metadata.length > 0 ? (
        <FactSection
          headline={METADATA_LOSS_HEADLINE}
          severity={ConversionSeverity.Note}
          facts={metadata}
          testId="convert-metadata"
        />
      ) : null}

      {report.transformations.length > 0 ? (
        <FactSection
          headline="What changes shape to fit this format"
          severity={ConversionSeverity.Note}
          facts={report.transformations}
          testId="convert-transformations"
        />
      ) : null}

      {report.assumptions.length > 0 ? (
        <FactSection
          headline={ASSUMPTIONS_HEADLINE}
          severity={ConversionSeverity.Note}
          facts={report.assumptions}
          testId="convert-assumptions"
        />
      ) : null}

      {report.verdict === ConversionVerdict.Lossless ? (
        <p className="convert__clear" data-testid="convert-lossless">
          {LOSSLESS_HEADLINE}
        </p>
      ) : null}

      {report.preserved.length > 0 ? (
        <FactSection
          headline={PRESERVED_HEADLINE}
          severity={ConversionSeverity.Clear}
          facts={report.preserved}
          testId="convert-preserved"
        />
      ) : null}

      {/*
        SOURCE WARNINGS SIT APART, and stay put when the target changes. They
        describe the FILE that was opened, not the format being written, and
        folding them in would blame this conversion for a loss that happened on
        import.
      */}
      {report.sourceImportWarnings.length > 0 ? (
        <FactSection
          headline={SOURCE_WARNINGS_HEADLINE}
          severity={ConversionSeverity.Note}
          facts={report.sourceImportWarnings}
          testId="convert-source-warnings"
        />
      ) : null}
    </div>
  );
}

function FactSection({
  headline,
  severity,
  facts,
  testId,
}: {
  readonly headline: string;
  readonly severity: ConversionSeverity;
  readonly facts: readonly CompatibilityFact[];
  readonly testId: string;
}): ReactNode {
  return (
    <section className={`convert__section convert__section--${severity}`} data-testid={testId}>
      <h3 className="convert__subtitle">{headline}</h3>
      <ul className="convert__facts">
        {facts.map((fact) => (
          <li key={`${fact.feature}:${fact.disposition}`} data-feature={fact.feature}>
            {describeFact(fact)}
          </li>
        ))}
      </ul>
    </section>
  );
}
