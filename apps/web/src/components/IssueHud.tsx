import type { ReactNode } from 'react';
import { describeSeverity } from '../state/repair-issues';
import type { IssueNavigation } from '../state/use-issue-navigation';
import { Icon } from './shell/Icon';

/**
 * The viewport's issue capsule: which issue, which occurrence, and the way to
 * step through and frame them.
 *
 * NO LOGIC OF ITS OWN. It renders the one resolved selection and calls the
 * same `step` and `zoom` the Mesh analysis navigator calls, so the two cannot
 * show different occurrences.
 *
 * Shown only when the selected issue has occurrences to step through; an issue
 * known only as a count has nothing to point at, and nothing is invented.
 */
export function IssueHud({ navigation }: { readonly navigation: IssueNavigation }): ReactNode {
  const selection = navigation.selection;
  if (selection?.occurrence === undefined) return null;
  const { issue, occurrence, location } = selection;
  const total = issue.occurrenceCount;

  return (
    <div className="issue-hud" role="group" aria-label="Selected issue" data-testid="issue-hud">
      <span className={`severity-dot severity-dot--${issue.severity}`} aria-hidden="true" />
      <span className="visually-hidden">{describeSeverity(issue.severity)}: </span>
      <span className="issue-hud__name">{issue.label}</span>
      <span className="issue-hud__position" data-testid="issue-hud-position">
        {occurrence + 1} / {total}
      </span>
      <button
        type="button"
        className="issue-hud__step"
        aria-label={`Previous ${issue.unit[0]}`}
        disabled={total < 2}
        onClick={() => {
          navigation.step(-1);
        }}
        data-testid="issue-hud-previous"
      >
        <Icon name="chev-left" size={14} />
      </button>
      <button
        type="button"
        className="issue-hud__step"
        aria-label={`Next ${issue.unit[0]}`}
        disabled={total < 2}
        onClick={() => {
          navigation.step(1);
        }}
        data-testid="issue-hud-next"
      >
        <Icon name="chev-right" size={14} />
      </button>
      <button
        type="button"
        className="issue-hud__zoom"
        onClick={navigation.zoom}
        disabled={location === undefined}
        title={location === undefined ? 'Locating this occurrence…' : undefined}
        data-testid="issue-hud-zoom"
      >
        <Icon name="target" size={13} />
        <span className="issue-hud__zoom-text">Zoom to issue</span>
      </button>
    </div>
  );
}
