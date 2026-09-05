import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { GeometryClientProvider } from './runtime/client-context';
import { GeometryClient } from './runtime/geometry-client';
import { WorkspaceProvider } from './state/store-context';
import { WORKFLOWS, WorkflowId } from './state/workflows';
import { WorkspaceStore } from './state/workspace-store';

/**
 * The worker is injected, exactly as `main.tsx` injects it. The `Worker` global
 * is stubbed in `vitest.setup.ts` and never replies, so any test that appeared
 * to receive a worker result would be reading a fake — which is why none do.
 */
function renderApp(): WorkspaceStore {
  const store = new WorkspaceStore();
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <App />
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
  return store;
}

function dropFiles(files: readonly File[]): void {
  fireEvent.drop(screen.getByTestId('drop-zone'), { dataTransfer: { files } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('application shell', () => {
  it('renders the header and the local-processing statement', () => {
    renderApp();

    expect(screen.getByRole('heading', { level: 1, name: 'CAD Fixer' })).toBeInTheDocument();
    expect(screen.getByTestId('privacy-badge')).toHaveTextContent(
      'Models are processed locally in your browser',
    );
  });

  it('renders the workspace regions a user needs to orient themselves', () => {
    renderApp();

    expect(screen.getByRole('region', { name: '3D workspace' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Import a model' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Workflows' })).toBeInTheDocument();
  });

  it('logs the viewport failure jsdom causes, and nothing else, on first render', () => {
    // jsdom has no WebGL, so mounting legitimately produces one status entry.
    // Asserting the exact contents keeps this honest: nothing else may appear
    // at startup. The empty-log-on-load case is asserted end to end, where the
    // viewport actually succeeds.
    renderApp();

    const entries = within(screen.getByTestId('status-list')).getAllByRole('listitem');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toHaveTextContent(/3D viewport could not start/i);
  });
});

describe('workflow navigation', () => {
  it('lists all five planned workflows', () => {
    renderApp();

    for (const workflow of WORKFLOWS) {
      expect(screen.getByTestId(`workflow-${workflow.id}`)).toHaveTextContent(workflow.label);
    }
    expect(WORKFLOWS).toHaveLength(5);
  });

  /**
   * Repair became the FIRST enabled workflow in Stage 3B-1B and Convert became
   * the second in Stage 4A-2B3. The assertion is keyed off
   * `WORKFLOWS[].implemented` rather than a hard-coded name, and the explicit
   * list below is stated so that flipping a workflow's flag without shipping it
   * fails here rather than passing quietly.
   *
   * CONVERT IS IMPLEMENTED AND STILL DISABLED IN THIS RENDER, because no model
   * is loaded. That is not the same state as "not implemented", and the two are
   * asserted apart in the test below: one says the feature does not exist, the
   * other says it has nothing to act on.
   */
  it('enables exactly the workflows that are implemented and have something to act on', () => {
    renderApp();
    const nav = screen.getByRole('navigation', { name: 'Workflows' });

    const enabled = within(nav)
      .getAllByRole('button')
      .filter((button) => !(button as HTMLButtonElement).disabled)
      .map((button) => button.textContent);

    const implemented = WORKFLOWS.filter((workflow) => workflow.implemented).map(
      (workflow) => workflow.label,
    );

    expect(implemented).toEqual(['Repair', 'Convert']);
    // With an empty workspace, Convert has nothing to convert and says so.
    expect(enabled).toEqual(['Repair']);
  });

  it('tells an implemented workflow with nothing to act on apart from a missing one', () => {
    renderApp();

    for (const workflow of WORKFLOWS) {
      const button = screen.getByTestId(`workflow-${workflow.id}`);
      if (!workflow.implemented) {
        expect(button).toBeDisabled();
        expect(button).toHaveTextContent('Not implemented');
        continue;
      }

      // No "Not implemented" badge on a workflow that genuinely exists — the
      // badge is a claim about absence, and printing it beside a working screen
      // would be the mirror image of claiming a capability that is missing.
      expect(button).not.toHaveTextContent('Not implemented');

      if (workflow.id === WorkflowId.Convert) {
        // IMPLEMENTED, UNAVAILABLE, AND EXPLICIT ABOUT WHICH. A disabled button
        // with no reason beside it is indistinguishable from a broken one.
        expect(button).toBeDisabled();
        expect(button).toHaveTextContent('Open a model first');
        continue;
      }

      expect(button).toBeEnabled();
      expect(button).not.toHaveTextContent('Open a model first');
    }
  });

  it('describes Repair as conservative rather than as general repair', () => {
    renderApp();

    const summary = screen.getByText(/Conservative repair: remove exact duplicate/);
    expect(summary).toBeInTheDocument();
    // The old summary promised closing openings and resolving non-manifold
    // geometry. Conservative repair does neither, and the navigation must not
    // advertise a capability the screen behind it does not have.
    expect(summary.textContent).not.toMatch(/close|non-manifold/i);
  });
});

describe('file intake at the UI boundary', () => {
  it('rejects an obviously unsupported extension', () => {
    renderApp();

    dropFiles([new File(['x'], 'drawing.zip', { type: 'application/zip' })]);

    const log = screen.getByTestId('status-list');
    expect(within(log).getByText(/\.zip files are not supported/)).toBeInTheDocument();
  });

  it('rejects a file with no extension', () => {
    renderApp();

    dropFiles([new File(['x'], 'model')]);

    expect(screen.getByTestId('status-list')).toHaveTextContent(/supported extension/i);
  });

  it('starts a real import for an OBJ file rather than refusing it', async () => {
    /*
     * OBJ IMPORT IS IMPLEMENTED as of Stage 4A-2B1, so the file is genuinely
     * read — the opposite of the Stage 1 assertion this replaces. What the
     * worker then makes of the contents is the parser's business and is tested
     * against it directly; what matters here is that the interface no longer
     * refuses the format at the door.
     */
    renderApp();
    const file = new File(['v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'], 'part.obj');
    const readAsBuffer = vi.spyOn(file, 'arrayBuffer');

    dropFiles([file]);

    expect(await screen.findByTestId('import-progress')).toBeInTheDocument();
    expect(readAsBuffer).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('status-list').textContent).not.toMatch(/not implemented/i);
  });

  it('starts a real import for a 3MF file rather than refusing it', async () => {
    renderApp();
    // A ZIP signature is enough to reach the worker; the archive's validity is
    // the reader's business, and it is tested against the reader.
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'part.3mf');
    const readAsBuffer = vi.spyOn(file, 'arrayBuffer');

    dropFiles([file]);

    expect(await screen.findByTestId('import-progress')).toBeInTheDocument();
    expect(readAsBuffer).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('status-list').textContent).not.toMatch(/not implemented/i);
  });

  it('starts a real import for an STL file and reads it locally', async () => {
    // STL import IS implemented as of Stage 1, so the file is genuinely read —
    // the opposite of the Stage 0 assertion this replaces.
    renderApp();
    const file = new File([new Uint8Array(84)], 'bracket.stl');
    const readAsBuffer = vi.spyOn(file, 'arrayBuffer');

    dropFiles([file]);

    expect(await screen.findByTestId('import-progress')).toBeInTheDocument();
    expect(readAsBuffer).toHaveBeenCalledTimes(1);
  });

  it('does not claim the model is loaded while the import is still running', async () => {
    // The worker stub never replies, so the import stays pending forever. That
    // is the point: nothing may report success before a result arrives.
    renderApp();

    dropFiles([new File([new Uint8Array(84)], 'bracket.stl')]);
    await screen.findByTestId('import-progress');

    expect(screen.getByTestId('model-empty')).toBeInTheDocument();
    expect(screen.getByTestId('status-list').textContent).not.toMatch(
      /loaded|imported|ready to repair/i,
    );
  });

  it('never reads a file it has already refused', () => {
    renderApp();
    const file = new File(['x'], 'drawing.zip');
    const readAsBuffer = vi.spyOn(file, 'arrayBuffer');
    const readAsText = vi.spyOn(file, 'text');

    dropFiles([file]);

    // Screening is a filename check, and a refused file must never be opened.
    expect(readAsBuffer).not.toHaveBeenCalled();
    expect(readAsText).not.toHaveBeenCalled();
  });

  it('uses only the first file of a multi-file drop and says so', () => {
    // One model is open at a time, so silently ignoring the rest would be
    // confusing.
    renderApp();

    dropFiles([new File(['a'], 'first.obj'), new File(['b'], 'second.stl')]);

    const log = screen.getByTestId('status-list');
    expect(within(log).getByText(/Only one model can be open at a time/i)).toBeInTheDocument();
    // And the FIRST file is the one that was taken, not the last or the one
    // that happens to be a format the application has supported longest.
    expect(log.textContent).toMatch(/first\.obj/i);
  });

  it('reports an empty drop instead of doing nothing', () => {
    renderApp();

    dropFiles([]);

    expect(screen.getByTestId('status-list')).toHaveTextContent(/no file was received/i);
  });
});

describe('status log', () => {
  it('clears entries on request', () => {
    renderApp();
    dropFiles([new File(['x'], 'drawing.zip')]);
    expect(screen.queryByTestId('status-empty')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('clear-status'));

    expect(screen.getByTestId('status-empty')).toBeInTheDocument();
  });

  it('disables the clear control once the log is empty', () => {
    renderApp();

    fireEvent.click(screen.getByTestId('clear-status'));

    expect(screen.getByTestId('status-empty')).toBeInTheDocument();
    expect(screen.getByTestId('clear-status')).toBeDisabled();
  });
});

describe('viewport', () => {
  beforeEach(() => {
    // Three.js logs a WebGL acquisition failure before throwing; the test
    // asserts on our handling of the throw, not on that noise.
    vi.spyOn(console, 'error').mockImplementation((): void => {
      // Discarded: Three.js logs its own WebGL acquisition failure.
    });
  });

  it('surfaces a graphics failure instead of rendering a blank panel', () => {
    // jsdom provides no WebGL context, which is exactly the failure a user on a
    // machine without WebGL would hit.
    renderApp();

    expect(screen.getByTestId('viewport-error')).toHaveTextContent(/3D viewport could not start/i);
  });
});

describe('runtime diagnostics', () => {
  it('exposes a self-test that is idle until it is run', () => {
    renderApp();

    expect(screen.getByTestId('self-test-state')).toHaveTextContent('idle');
    expect(screen.getByTestId('run-self-test')).toBeEnabled();
    expect(screen.getByTestId('cancel-self-test')).toBeDisabled();
  });

  it('reports cross-origin isolation as a fact about the environment', () => {
    renderApp();

    // jsdom is not cross-origin isolated, and the panel must say so rather than
    // assuming the capability is present.
    expect(screen.getByTestId('isolation-state')).toHaveTextContent('no');
  });
});
