import type { ReactNode } from 'react';
import { isExportFormat, objNeedsFileSink } from '@cadfixer/file-formats';
import {
  DOWNLOAD_DESTINATION,
  EXPORT_SUMMARY_COPY,
  describeOutput,
  describeOutputUnit,
  describeSourceKind,
  describeStructure,
  formatExportBytes,
} from '../state/conversion-presentation';
import { describeSourceFormat } from '../state/model';
import { useWorkspaceState } from '../state/store-context';
import { ConversionState } from '../state/workspace-store';
import { PropertyRow } from './shell/primitives';

/**
 * The inspector's Convert selection: what the next file will be.
 *
 * ONLY REAL STATE. Every row is the store's conversion session or a pure
 * description of it; the destination follows the same routing estimate as the
 * Export click. No filesystem path is inferred. The last file is shown only for the revision on screen — a
 * file written before a repair describes geometry the user has moved off.
 */
export function ExportSummary(): ReactNode {
  const { model, conversion } = useWorkspaceState();
  if (model === undefined) {
    return <p className="panel__empty">Nothing is selected. Open a model to begin.</p>;
  }
  const target =
    conversion.target !== undefined && isExportFormat(conversion.target)
      ? conversion.target
      : undefined;
  const result = conversion.result;
  const lastFile =
    conversion.state === ConversionState.Saved &&
    result?.source.documentId === model.handle.documentId &&
    result.source.revision === model.handle.revision
      ? result
      : undefined;

  return (
    <div className="export-summary" data-testid="export-summary">
      <p className="export-summary__eyebrow">{EXPORT_SUMMARY_COPY.heading}</p>
      <dl className="property-grid">
        <PropertyRow
          label={EXPORT_SUMMARY_COPY.source}
          mono={false}
          value={describeSourceKind(
            describeSourceFormat(model.source),
            model.source.formatId,
            model.source.encoding,
          )}
          testId="export-summary-source"
        />
        <PropertyRow
          label={EXPORT_SUMMARY_COPY.output}
          mono={false}
          value={target === undefined ? EXPORT_SUMMARY_COPY.outputNone : describeOutput(target)}
          testId="export-summary-output"
        />
        {target === undefined ? null : (
          <>
            <PropertyRow
              label={EXPORT_SUMMARY_COPY.parts}
              mono={false}
              value={describeStructure(target, model.parts.length)}
              testId="export-summary-parts"
            />
            <PropertyRow
              label={EXPORT_SUMMARY_COPY.units}
              mono={false}
              value={describeOutputUnit(target, model.source.unit, conversion.unitAssertion)}
              testId="export-summary-units"
            />
          </>
        )}
        <PropertyRow
          label={EXPORT_SUMMARY_COPY.destination}
          mono={false}
          value={
            target === 'obj' && objNeedsFileSink(model.parts)
              ? 'Folder and filename you choose'
              : DOWNLOAD_DESTINATION
          }
          testId="export-summary-destination"
        />
        {lastFile === undefined ? null : (
          <PropertyRow
            label={EXPORT_SUMMARY_COPY.lastFile}
            value={`${lastFile.fileName} · ${formatExportBytes(lastFile.byteLength)}`}
            testId="export-summary-last"
          />
        )}
      </dl>
    </div>
  );
}
