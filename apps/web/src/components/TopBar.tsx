import { useId, type ReactNode } from 'react';
import { useWorkspaceState } from '../state/store-context';
import { useDocumentConversion } from '../state/use-document-conversion';
import { useFileIntake } from './FileIntake';
import { WorkflowNav } from './WorkflowNav';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { Icon } from './shell/Icon';
import { CompactSwitch, IconButton } from './shell/primitives';
import { useDismissableMenu, useShellLayout } from './shell/shell-layout';

/**
 * The application's top bar.
 *
 * EVERY CONTROL HERE IS A COMMAND THAT ALREADY EXISTS. Open is the file intake
 * every import goes through; Export opens the whole-document Export / Convert
 * dialog, which is what "Export" means everywhere in the product; the tabs and
 * the dropdown select workflows. Controls the reference design shows that CAD
 * Fixer has no command behind — Save project, Recent files, Redo, an account
 * menu — are deliberately absent rather than drawn disabled forever. Undo is
 * absent too: each workflow owns its own undo in its panel, and a global Undo
 * that could reach only some of them would be wrong about the rest.
 */
export function TopBar(): ReactNode {
  const { model } = useWorkspaceState();
  const { openPicker, isImporting } = useFileIntake();
  const { open: openConversion } = useDocumentConversion();
  const layout = useShellLayout();

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <BrandMark />
        <h1 className="topbar__title">CAD Fixer</h1>
      </div>
      <span className="topbar__divider topbar__divider--brand" aria-hidden="true" />

      <div className="topbar__switcher">
        <WorkspaceSwitcher />
      </div>
      <span className="topbar__divider topbar__divider--switcher" aria-hidden="true" />

      <div className="topbar__file" role="group" aria-label="File">
        <IconButton
          label="Open a model file (STL, OBJ or 3MF)"
          icon="open"
          text="Open"
          className="topbar__action"
          onClick={openPicker}
          disabled={isImporting}
          testId="browse-button"
        />
        <IconButton
          label={
            model === undefined
              ? 'Export — open a model first'
              : 'Export the whole document as STL, OBJ or 3MF'
          }
          icon="download"
          text="Export"
          className="topbar__action"
          onClick={openConversion}
          disabled={model === undefined}
          testId="topbar-export"
        />
      </div>

      <div className="topbar__center">
        <WorkflowNav />
      </div>

      <div className="topbar__end">
        <IconButton
          label={layout.toolDrawerOpen ? 'Hide workspace tools' : 'Show workspace tools'}
          icon="panel-left"
          className="topbar__action topbar__drawer-toggle topbar__drawer-toggle--tools"
          pressed={layout.toolDrawerOpen}
          onClick={layout.toggleToolDrawer}
          controls="tool-panel"
          testId="toggle-tool-drawer"
        />
        <IconButton
          label={layout.inspectorDrawerOpen ? 'Hide inspector' : 'Show inspector'}
          icon="panel"
          className="topbar__action topbar__drawer-toggle topbar__drawer-toggle--inspector"
          pressed={layout.inspectorDrawerOpen}
          onClick={layout.toggleInspectorDrawer}
          controls="inspector"
          testId="toggle-inspector-drawer"
        />
        <HelpMenu />
        <SettingsMenu />
      </div>
    </header>
  );
}

/** The product mark. Decorative: the heading beside it carries the name. */
function BrandMark(): ReactNode {
  return (
    <svg className="topbar__mark" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--cad-accent)" />
      <path
        d="M8 9.5 12 7l4 2.5v5L12 17l-4-2.5z"
        fill="none"
        stroke="var(--cad-on-accent)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M8 9.5 12 12l4-2.5M12 12v5"
        fill="none"
        stroke="var(--cad-on-accent)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * How to drive the viewport. Static facts about the camera controls, which are
 * OrbitControls' mapping plus the navigation mode in the viewport toolbar.
 *
 * The menu triggers here are plain buttons rather than `IconButton`s because
 * they carry `aria-haspopup`, which the menu hook uses to return focus on Esc.
 */
function HelpMenu(): ReactNode {
  const { open, toggle, containerRef } = useDismissableMenu();
  const menuId = useId();
  return (
    <div className="topbar__menu" ref={containerRef}>
      <button
        type="button"
        className="icon-btn topbar__action"
        aria-label="Help"
        data-tooltip="Help"
        data-tooltip-side="below"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={toggle}
        data-testid="help-menu"
      >
        <Icon name="help" size={16} />
      </button>
      {open ? (
        <div className="menu menu--end" id={menuId}>
          <p className="menu__eyebrow">Viewport controls</p>
          <dl className="menu__shortcuts">
            <div>
              <dt>Orbit</dt>
              <dd>Left-drag · one finger</dd>
            </div>
            <div>
              <dt>Pan</dt>
              <dd>Right-drag · two fingers</dd>
            </div>
            <div>
              <dt>Zoom</dt>
              <dd>Scroll · pinch</dd>
            </div>
            <div>
              <dt>Pan with left-drag</dt>
              <dd>Pan tool in the viewport</dd>
            </div>
          </dl>
          <p className="menu__note">
            Models are read, checked and written on this device. Nothing is uploaded.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SettingsMenu(): ReactNode {
  const { open, toggle, containerRef } = useDismissableMenu();
  const layout = useShellLayout();
  const menuId = useId();
  return (
    <div className="topbar__menu" ref={containerRef}>
      <button
        type="button"
        className="icon-btn topbar__action topbar__settings"
        aria-label="Settings"
        data-tooltip="Settings"
        data-tooltip-side="below"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={toggle}
        data-testid="settings-menu"
      >
        <Icon name="settings" size={16} />
      </button>
      {open ? (
        <div className="menu menu--end" id={menuId}>
          <p className="menu__eyebrow">Preferences</p>
          <CompactSwitch
            label="Inspector panel"
            checked={!layout.inspectorCollapsed}
            onChange={(checked) => {
              layout.setInspectorCollapsed(!checked);
            }}
            testId="setting-inspector"
          />
        </div>
      ) : null}
    </div>
  );
}
