import type { ReactNode } from 'react';

/**
 * The local-processing indicator is a factual statement about this build: no
 * code path in the application transmits model data anywhere. It must be
 * removed or qualified the moment that stops being true.
 */
export function AppHeader(): ReactNode {
  return (
    <header className="app-header">
      <div className="app-header__identity">
        <span className="app-header__mark" aria-hidden="true" />
        <h1 className="app-header__title">CAD Fixer</h1>
        <span className="app-header__stage">Stage 0 — foundation</span>
      </div>
      <p className="app-header__privacy" data-testid="privacy-badge">
        Models are processed locally in your browser
      </p>
    </header>
  );
}
