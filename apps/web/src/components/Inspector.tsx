import { useRef, type ReactNode } from 'react';
import { useWorkspaceState } from '../state/store-context';
import { ModelPanel } from './ModelPanel';
import { PartSelector } from './PartSelector';
import { RuntimePanel } from './RuntimePanel';
import { Icon } from './shell/Icon';
import { keepTabWithin } from './shell/focus-trap';
import { IconButton, PanelSection } from './shell/primitives';
import { useShellLayout } from './shell/shell-layout';

/**
 * The right-hand inspector: facts about what is open.
 *
 * COLLAPSING HIDES, IT DOES NOT UNMOUNT. The Model section owns the active-part
 * export, whose hook tracks a running export; dropping it to save a few pixels
 * would orphan that operation. The collapsed rail is a separate element beside
 * the hidden panel.
 *
 * Below 1200 px the same element becomes an overlay drawer. CSS decides which
 * presentation applies; React only records the two flags.
 */
export function Inspector({ inert = false }: { readonly inert?: boolean }): ReactNode {
  const { model } = useWorkspaceState();
  const layout = useShellLayout();
  const collapsed = layout.inspectorCollapsed;
  const panelRef = useRef<HTMLElement>(null);
  const modal = layout.modalDrawer === 'inspector';

  return (
    <>
      <aside
        ref={panelRef}
        id="inspector"
        className="inspector"
        aria-label="Inspector"
        data-collapsed={collapsed ? 'true' : 'false'}
        data-drawer-open={layout.inspectorDrawerOpen ? 'true' : 'false'}
        data-testid="inspector"
        inert={inert}
        tabIndex={-1}
        {...(modal ? { role: 'dialog', 'aria-modal': true } : {})}
        onKeyDown={(event) => {
          if (modal && panelRef.current !== null) keepTabWithin(event, panelRef.current);
        }}
      >
        <div className="inspector__header">
          <h2 className="inspector__title">Inspector</h2>
          <IconButton
            label="Collapse inspector"
            icon="panel"
            tooltip="left"
            iconSize={15}
            className="inspector__collapse"
            onClick={() => {
              layout.setInspectorCollapsed(true);
            }}
            testId="collapse-inspector"
          />
          <IconButton
            label="Close inspector"
            icon="x"
            tooltip="left"
            iconSize={15}
            className="inspector__close"
            onClick={layout.closeDrawers}
            testId="close-inspector"
          />
        </div>

        <div className="inspector__body">
          <PanelSection title="Model">
            <ModelPanel />
          </PanelSection>

          <PanelSection title="Selection">
            {model === undefined ? (
              <p className="panel__empty">Nothing is selected. Open a model to begin.</p>
            ) : model.parts.length <= 1 ? (
              <p className="panel__note" data-testid="selection-single-part">
                This model has one part, so every workflow acts on the whole model.
              </p>
            ) : (
              <PartSelector />
            )}
          </PanelSection>

          <PanelSection title="Runtime">
            <RuntimePanel />
          </PanelSection>
        </div>
      </aside>

      {collapsed ? (
        <aside
          className="inspector-rail"
          aria-label="Inspector (collapsed)"
          data-testid="inspector-rail"
        >
          <button
            type="button"
            className="icon-btn inspector-rail__expand"
            aria-label="Show inspector"
            data-tooltip="Show inspector"
            data-tooltip-side="left"
            onClick={() => {
              layout.setInspectorCollapsed(false);
            }}
            data-testid="expand-inspector"
          >
            <Icon name="panel" size={15} />
          </button>
          <span className="inspector-rail__label" aria-hidden="true">
            INSPECTOR
          </span>
        </aside>
      ) : null}
    </>
  );
}
