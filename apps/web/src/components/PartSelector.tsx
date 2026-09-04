import type { ReactNode } from 'react';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { describePartAt } from '../state/part-presentation';

/**
 * Chooses which part of a multi-part document the workflows act on.
 *
 * DELIBERATELY NOT AN ASSEMBLY TREE. There is no hierarchy to show, no
 * renaming, no reordering, no visibility toggles and no transform editing. The
 * document model exists to carry OBJ and 3MF structure faithfully; this is the
 * smallest control that lets the existing per-part workflows name a target.
 *
 * ONE PART MEANS NO CONTROL AT ALL. An STL produces a single-part document, and
 * offering a list of one would add a decision the user does not have. The
 * single-part experience is unchanged, which is the point of §40.
 *
 * PRESENTATION ONLY. Selection lives in the workspace store, which re-binds the
 * diagnostic and repair slices; nothing here touches geometry, and changing the
 * selection does not change the document revision.
 */
export function PartSelector(): ReactNode {
  const { model, activePartId } = useWorkspaceState();
  const store = useWorkspaceStore();

  if (model === undefined) return null;
  if (model.parts.length <= 1) return null;

  return (
    <section className="panel" aria-labelledby="parts-title" data-testid="part-selector">
      <h2 className="panel__title" id="parts-title">
        Parts
      </h2>
      <p className="panel__note">
        This model contains {model.parts.length.toLocaleString()} parts. Mesh Health, the
        self-intersection check and repair all act on the selected part. Parts are checked
        separately: nothing here reports whether two parts overlap each other.
      </p>
      <ul className="parts" data-testid="part-list">
        {model.parts.map((part, index) => {
          const selected = part.partId === activePartId;
          return (
            <li key={part.partId}>
              <button
                type="button"
                className={selected ? 'parts__item parts__item--selected' : 'parts__item'}
                aria-pressed={selected}
                data-testid={`part-option-${part.partId}`}
                onClick={() => {
                  store.selectPart(part.partId);
                }}
              >
                <span className="parts__name">{describePartAt(part, index)}</span>
                <span className="parts__count">
                  {part.triangleCount.toLocaleString()} triangles
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
