import type { ReactNode } from 'react';
import {
  TEXTURE_COPY,
  describeCoverage,
  describeSelectionArea,
  describeTriangles,
} from '../state/texture-presentation';
import { TexturePhase } from '../state/use-texture-workflow';
import { useTextureControls } from '../state/workflow-controllers';

/**
 * The viewport's selection capsule: what is selected, measured by the worker,
 * and the one thing a click does. Only the tool CAD Fixer has is mentioned.
 */
export function TextureHud(): ReactNode {
  const texture = useTextureControls();
  if (texture.part === undefined) return null;
  const selection = texture.selection;

  return (
    <div
      className="issue-hud split-hud"
      role="group"
      aria-label="Surface selection"
      data-testid="texture-hud"
    >
      <div className="split-hud__lines">
        <p className="split-hud__cut" data-testid="texture-hud-selection">
          {selection === undefined ? (
            <span className="split-hud__name">No surface selected</span>
          ) : (
            <>
              <span className="split-hud__name">Selected</span>{' '}
              {describeSelectionArea(selection.area, texture.unit)}
              <span className="texture-hud__stats">
                {' '}
                {describeTriangles(selection.triangleIds.length)}
                {describeCoverage(selection.area, selection.partArea) === undefined
                  ? ''
                  : ` · ${describeCoverage(selection.area, selection.partArea) ?? ''}`}
              </span>
            </>
          )}
        </p>
        <p className="split-hud__detail" data-testid="texture-hud-detail">
          {texture.phase === TexturePhase.Preview
            ? TEXTURE_COPY.previewLabel
            : selection === undefined
              ? TEXTURE_COPY.hintSelect
              : TEXTURE_COPY.hintSelected}
        </p>
      </div>
    </div>
  );
}
