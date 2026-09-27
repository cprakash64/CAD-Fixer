import type { ReactNode } from 'react';
import {
  TEXTURE_COPY,
  describeCoverage,
  describeDepthLabel,
  describeDirection,
  describeSelectionArea,
  patternOption,
} from '../state/texture-presentation';
import { formatNumber } from '../state/split-presentation';
import { useTextureControls } from '../state/workflow-controllers';
import { PropertyRow } from './shell/primitives';

/**
 * The inspector's Surface Texture selection: the selected surface and the
 * texture that would be applied to it, with only measured or chosen values.
 * The result's triangle count appears once a preview has actually built it.
 */
export function TextureInspector(): ReactNode {
  const texture = useTextureControls();
  if (texture.part === undefined)
    return <p className="panel__empty">Nothing is selected. Open a model to begin.</p>;
  const selection = texture.selection;
  const settings = texture.settings;
  const layout = texture.layout.result;

  return (
    <div className="export-summary" data-testid="texture-inspector">
      <p className="export-summary__eyebrow">Surface selection</p>
      {selection === undefined ? (
        <p className="panel__empty">{TEXTURE_COPY.noSelection}</p>
      ) : (
        <dl className="property-grid">
          <PropertyRow
            label="Area"
            value={describeSelectionArea(selection.area, texture.unit)}
            testId="texture-inspector-area"
          />
          <PropertyRow
            label="Faces"
            value={selection.triangleIds.length.toLocaleString()}
            testId="texture-inspector-triangles"
          />
          <PropertyRow
            label="Coverage"
            value={describeCoverage(selection.area, selection.partArea) ?? '—'}
          />
          <PropertyRow label="Surface" mono={false} value="Flat" />
        </dl>
      )}
      <p className="export-summary__eyebrow">Texture</p>
      <dl className="property-grid">
        <PropertyRow
          label="Source"
          mono={false}
          value={patternOption(settings.pattern).name}
          testId="texture-inspector-source"
        />
        <PropertyRow label="Projection" mono={false} value="Flat, on the face" />
        <PropertyRow
          label="Direction"
          mono={false}
          value={describeDirection(settings.mode)}
          testId="texture-inspector-direction"
        />
        <PropertyRow
          label={describeDepthLabel(settings.mode)}
          value={`${formatNumber(settings.heightOrDepth)} mm`}
          testId="texture-inspector-depth"
        />
        {layout === undefined ? null : (
          <PropertyRow
            label="Elements"
            value={layout.elementCount.toLocaleString()}
            testId="texture-inspector-elements"
          />
        )}
        {texture.preview === undefined ? null : (
          <PropertyRow
            label="Result"
            value={`${texture.preview.candidateTriangleCount.toLocaleString()} triangles`}
            testId="texture-inspector-result"
          />
        )}
      </dl>
    </div>
  );
}
