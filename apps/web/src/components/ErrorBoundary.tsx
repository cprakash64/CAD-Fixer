import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * The last line of defence for a RENDER fault.
 *
 * Every other failure mode in CAD Fixer is accounted for and says so: a
 * malformed file is a typed refusal, a lost geometry worker clears the model and
 * explains it, a rejected candidate leaves the source untouched. A component
 * throwing during render was the one that was not. React unmounts the entire
 * tree in that case, so one unexpected interface bug replaced the whole
 * application with a blank white page — no message, no way forward, and no
 * indication the model had ever loaded.
 *
 * WHY A BOUNDARY IS THE RIGHT ANSWER HERE AND NOT A PAPERING-OVER. The
 * authoritative geometry lives in a worker and a render fault does not touch it,
 * so the state of the user's data after a throw is knowable: it is still in
 * memory, and it is unreachable. Saying that, and offering the one action that
 * recovers, is strictly better than a blank page.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   - it does not retry. A render that threw once throws again on the same
 *     state, and an automatic retry is a spin rather than a recovery;
 *   - it does not swallow. The error goes to the console — and to `onError` for
 *     tests — so a developer still gets the stack React would have printed;
 *   - it does not show the user the error. A stack trace or an internal message
 *     is not information they can act on, and it is exactly what the error-copy
 *     rules forbid;
 *   - it does not claim anything was saved. A reload starts a fresh session and
 *     the model is gone, because processing is local and in memory. The copy
 *     says to re-import rather than implying recovery.
 *
 * NO EXTERNAL REPORTING. Nothing here transmits anything anywhere; the privacy
 * architecture has no exception for crash reports.
 */

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Test seam. Production passes nothing and the console is the only sink. */
  readonly onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  readonly crashed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { crashed: false };
  }

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { crashed: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    /*
     * Reported, never silently absorbed — project rule 10. The console is the
     * sink because there is no other legitimate one: an external crash
     * reporter would be the first thing in this application to send anything
     * off-origin, and the privacy architecture does not have an exception for
     * it.
     */
    console.error('CAD Fixer interface error', error, info.componentStack);
    this.props.onError?.(error, info);
  }

  public override render(): ReactNode {
    if (!this.state.crashed) return this.props.children;

    return (
      <div className="crashed" role="alert" data-testid="app-crashed">
        <h1 className="crashed__title">CAD Fixer ran into a problem</h1>
        <p className="crashed__body">
          Something in the interface stopped working, so this page cannot continue. Nothing was sent
          anywhere, and no file on your computer was changed.
        </p>
        <p className="crashed__body">
          Reloading starts a new session. Models are held in memory while you work on them, so you
          will need to re-import the file you were working on.
        </p>
        <button
          type="button"
          className="crashed__action"
          data-testid="app-crashed-reload"
          onClick={(): void => {
            globalThis.location.reload();
          }}
        >
          Reload CAD Fixer
        </button>
      </div>
    );
  }
}
