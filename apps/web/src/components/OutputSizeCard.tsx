import type { ReactNode } from 'react';
import { isExportFormat } from '@cadfixer/file-formats';
import {
  OUTPUT_SIZE_HEADING,
  OutputSizeKind,
  SOURCE_SUFFIX,
  describeOutput,
  describeOutputSizeBadge,
  describeOutputSizeKind,
  describeSizeDifference,
  describeSourceKind,
  describeUnknownSize,
  formatExportBytes,
} from '../state/conversion-presentation';
import { describeSourceFormat } from '../state/model';
import { outputSize } from '../state/output-size';
import { useWorkspaceState } from '../state/store-context';

/**
 * The viewport's output-size card: the source file beside the chosen output.
 *
 * ONLY NUMBERS WITH SOMETHING BEHIND THEM. The source row is the file's real
 * length. The output row is EXACT for binary STL, MEASURED once an export of
 * this revision has actually been written, and otherwise says it will be known
 * on export — each labelled as which, so an exact figure and a measured one are
 * never mistaken for the same kind of knowledge, and neither for a guess.
 *
 * A LARGER FILE IS NOT AN ERROR. The difference is shown neutrally when the
 * output is bigger and in the muted success tone only when it is smaller.
 *
 * OVERLAY, NOT LAYOUT. It floats over the canvas, takes pointer events only
 * inside its own box, and reads scalars from the store — choosing a card
 * re-renders this and nothing in the renderer.
 */
export function OutputSizeCard(): ReactNode {
  const { model, conversion } = useWorkspaceState();
  if (model === undefined) return null;
  const target =
    conversion.target !== undefined && isExportFormat(conversion.target)
      ? conversion.target
      : undefined;

  const sourceBytes = model.source.fileBytes;
  const sourceKind = describeSourceKind(
    describeSourceFormat(model.source),
    model.source.formatId,
    model.source.encoding,
  );
  const size =
    target === undefined
      ? undefined
      : outputSize(model, target, conversion.unitAssertion, conversion.measured);
  const knownBytes =
    size === undefined || size.kind === OutputSizeKind.Unknown ? undefined : size.bytes;
  const largest = Math.max(sourceBytes, knownBytes ?? 0, 1);
  const difference =
    knownBytes === undefined ? undefined : describeSizeDifference(knownBytes, sourceBytes);

  return (
    <section className="size-card" aria-label={OUTPUT_SIZE_HEADING} data-testid="output-size-card">
      <h2 className="size-card__heading">{OUTPUT_SIZE_HEADING}</h2>
      <div className="size-card__row size-card__row--source" data-testid="output-size-source">
        <span className="size-card__label">
          {sourceKind} {SOURCE_SUFFIX}
        </span>
        <span className="size-card__value">{formatExportBytes(sourceBytes)}</span>
        <span className="size-card__bar" aria-hidden="true">
          <span
            className="size-card__fill size-card__fill--source"
            style={{ width: `${String((sourceBytes / largest) * 100)}%` }}
          />
        </span>
      </div>
      {target === undefined || size === undefined ? null : (
        <div
          className="size-card__row"
          data-testid="output-size-target"
          data-kind={size.kind}
          title={describeOutputSizeKind(size.kind)}
        >
          <span className="size-card__label">{describeOutput(target)}</span>
          <span className="size-card__value">
            {knownBytes === undefined ? describeUnknownSize() : formatExportBytes(knownBytes)}
            {difference === undefined ? null : (
              <span
                className={`size-card__delta size-card__delta--${knownBytes !== undefined && knownBytes < sourceBytes ? 'smaller' : 'larger'}`}
                data-testid="output-size-delta"
              >
                {difference}
              </span>
            )}
          </span>
          <span className="size-card__bar" aria-hidden="true">
            {knownBytes === undefined ? null : (
              <span
                className="size-card__fill"
                style={{ width: `${String((knownBytes / largest) * 100)}%` }}
              />
            )}
          </span>
          <span className="size-card__kind" data-testid="output-size-kind">
            {describeOutputSizeBadge(size.kind)}
          </span>
        </div>
      )}
    </section>
  );
}
