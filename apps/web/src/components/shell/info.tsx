import { useCallback, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * The ⓘ pattern — REPAIR-UX-01.
 *
 * A DISCLOSURE, NOT A POPOVER. The button is a real `<button>` with
 * `aria-expanded` and `aria-controls`; the explanation is an ordinary block in
 * the flow of the panel, directly beneath the thing it explains. Nothing
 * floats, so nothing can leave the viewport or sit over a control on a narrow
 * or short screen, and there is no menu or dialog semantics to misuse.
 *
 * CLICK OR TAP, NEVER HOVER. Escape closes it from the button or from inside
 * the explanation, and focus returns to the button either way, so a keyboard
 * user is never dropped on the document body.
 *
 * THE PANEL STAYS MOUNTED WHILE CLOSED, `hidden` like the panel sections: the
 * explanation still exists in the document and simply is not shown, which keeps
 * the DOM stable and costs a few short paragraphs.
 */

export interface InfoDisclosure {
  readonly open: boolean;
  readonly panelId: string;
  readonly toggle: () => void;
  readonly close: () => void;
  /** The controlling button's id; `close` returns focus to it. */
  readonly buttonId: string;
}

export function useInfoDisclosure(): InfoDisclosure {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonId = `${panelId}-button`;
  const toggle = useCallback(() => {
    setOpen((current) => !current);
  }, []);
  // Called from event handlers only, so reading the document here is not a
  // render-time side effect. By id rather than a ref: the disclosure is passed
  // between components, and a ref inside it would be read during their render.
  const close = useCallback(() => {
    setOpen(false);
    document.getElementById(buttonId)?.focus();
  }, [buttonId]);
  return { open, panelId, buttonId, toggle, close };
}

function closeOnEscape(disclosure: InfoDisclosure) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || !disclosure.open) return;
    // Handled here so an enclosing drawer does not close as well.
    event.stopPropagation();
    event.preventDefault();
    disclosure.close();
  };
}

export function InfoButton({
  disclosure,
  label,
  testId,
}: {
  readonly disclosure: InfoDisclosure;
  /** What the explanation is about, e.g. "Open boundaries". */
  readonly label: string;
  readonly testId?: string;
}): ReactNode {
  return (
    <button
      id={disclosure.buttonId}
      type="button"
      className="info-btn"
      aria-label={`About ${label}`}
      aria-expanded={disclosure.open}
      aria-controls={disclosure.panelId}
      onClick={disclosure.toggle}
      onKeyDown={closeOnEscape(disclosure)}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      <Icon name="info" size={14} />
    </button>
  );
}

export interface InfoSections {
  readonly meaning: string;
  readonly canDo: string;
  readonly cannot: string;
}

export function InfoPanel({
  disclosure,
  label,
  info,
  children,
  testId,
}: {
  readonly disclosure: InfoDisclosure;
  readonly label: string;
  /** The standard three-part explanation, when there is one. */
  readonly info?: InfoSections;
  /** Anything more, rendered after the three parts. */
  readonly children?: ReactNode;
  readonly testId?: string;
}): ReactNode {
  return (
    <div
      id={disclosure.panelId}
      className="info-panel"
      role="group"
      aria-label={`About ${label}`}
      hidden={!disclosure.open}
      onKeyDown={closeOnEscape(disclosure)}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {info === undefined ? null : (
        <dl className="info-panel__sections">
          <dt>What it means</dt>
          <dd>{info.meaning}</dd>
          <dt>What Pybrix can do</dt>
          <dd>{info.canDo}</dd>
          <dt>When it cannot</dt>
          <dd>{info.cannot}</dd>
        </dl>
      )}
      {children}
      <button type="button" className="info-panel__close" onClick={disclosure.close}>
        Close
      </button>
    </div>
  );
}
