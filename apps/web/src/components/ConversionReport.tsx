import type { ReactNode } from 'react';
import {
  ConversionVerdict,
  type CompatibilityFact,
  type ConversionCompatibilityReport,
} from '@cadfixer/file-formats';
import {
  ASSUMPTIONS_HEADLINE,
  BLOCKED_HEADLINE,
  LOSSLESS_HEADLINE,
  METADATA_LOSS_HEADLINE,
  PRESERVED_HEADLINE,
  SOURCE_WARNINGS_HEADLINE,
  STRUCTURE_LOSS_HEADLINE,
  TRANSFORMATIONS_HEADLINE,
  ConversionSeverity,
  describeFact,
  describeVerdict,
  metadataLosses,
  structuralLosses,
  verdictSeverity,
} from '../state/conversion-presentation';

/**
 * What a conversion keeps, changes and cannot write — the compatibility report
 * for ONE target, in the four registers it is read in.
 *
 * PRESENTATION ONLY. It renders a report it did not compute, in wording it did
 * not choose: every sentence comes from `conversion-presentation.ts`, so no
 * component can invent a claim about what a conversion preserves.
 *
 * SEVERITY IS PROPORTIONATE. A dropped unit is a note, a merged part list is a
 * caution, and only a genuine blocker gets the strongest treatment. Rendering
 * every format limitation as a danger would train people to skip this without
 * reading it — and then the one case that mattered would be skipped too.
 *
 * Each section carries its own heading text, so meaning never depends on colour
 * alone.
 */
export function ConversionReport({
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
          headline={TRANSFORMATIONS_HEADLINE}
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
