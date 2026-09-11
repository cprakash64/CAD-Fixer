import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * WHAT HAPPENS WHEN THE INTERFACE ITSELF THROWS.
 *
 * Every other failure mode in CAD Fixer is accounted for: a malformed file is a
 * typed refusal, a lost geometry worker clears the model and says so, a rejected
 * candidate leaves the source alone. A RENDER error was the one that was not.
 * React unmounts the whole tree when a component throws during render, so a
 * single unexpected UI bug replaced the entire application with a blank white
 * page — no message, no reload affordance, and no indication that the user's
 * model was ever there.
 *
 * That is the worst available outcome for the smallest class of bug, which is
 * what makes a boundary worth its weight: the geometry is worker-resident and
 * untouched by a render fault, so the honest thing to do is say what happened
 * and offer the one action that recovers.
 *
 * NOT AN EXCUSE TO SWALLOW ERRORS. The boundary re-reports to the console so a
 * developer still sees the stack, and it does not retry: a render that threw
 * once will throw again on the same state, and an automatic retry loop would
 * turn one bug into a spin.
 */

function Boom({ when }: { readonly when: boolean }): ReactNode {
  if (when) throw new Error('render exploded');
  return <p>the application</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error itself; silence it so the suite output stays
    // readable, and assert below that OUR reporting still happened.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // EXPLICIT, because this project does not enable testing-library globals:
    // without it each `render` adds another copy to the same container and the
    // queries below find several.
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('the application')).toBeInTheDocument();
    expect(screen.queryByTestId('app-crashed')).not.toBeInTheDocument();
  });

  it('replaces a thrown tree with an explanation instead of a blank page', () => {
    render(
      <ErrorBoundary>
        <Boom when={true} />
      </ErrorBoundary>,
    );

    const panel = screen.getByTestId('app-crashed');
    expect(panel).toBeInTheDocument();
    // THE BLANK PAGE IS THE DEFECT. Something must be on screen.
    expect(panel.textContent.length).toBeGreaterThan(40);
    // And a way out.
    expect(screen.getByTestId('app-crashed-reload')).toBeInTheDocument();
  });

  it('announces the failure rather than leaving it silent', () => {
    render(
      <ErrorBoundary>
        <Boom when={true} />
      </ErrorBoundary>,
    );
    // A screen-reader user gets the same information a sighted one does.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'app-crashed');
  });

  it('says nothing about the cause that could leak internals', () => {
    render(
      <ErrorBoundary>
        <Boom when={true} />
      </ErrorBoundary>,
    );
    const text = screen.getByTestId('app-crashed').textContent;
    // §95: no stack, no message from the throw, no internal vocabulary.
    for (const banned of ['render exploded', 'Error:', 'at ', 'worker', 'Geogram', 'undefined']) {
      expect(text).not.toContain(banned);
    }
  });

  it('does not claim the model was saved, because it was not', () => {
    render(
      <ErrorBoundary>
        <Boom when={true} />
      </ErrorBoundary>,
    );
    const text = screen.getByTestId('app-crashed').textContent.toLowerCase();
    // §96: no overclaiming. A reload loses the model — say so, do not imply
    // recovery of geometry that lives only in memory.
    for (const banned of ['saved', 'recovered', 'restored', 'no data was lost']) {
      expect(text).not.toContain(banned);
    }
    expect(text).toContain('re-import');
  });

  it('reports the error for developers rather than swallowing it', () => {
    const reported: unknown[] = [];
    render(
      <ErrorBoundary
        onError={(error): void => {
          reported.push(error);
        }}
      >
        <Boom when={true} />
      </ErrorBoundary>,
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(Error);
  });
});
