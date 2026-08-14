import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { WorkspaceProvider } from './state/store-context';
import { WORKFLOWS } from './state/workflows';
import { WorkspaceStore } from './state/workspace-store';

function renderApp(): WorkspaceStore {
  const store = new WorkspaceStore();
  render(
    <WorkspaceProvider store={store}>
      <App />
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

  it('offers no working workflow, because none is implemented', () => {
    renderApp();
    const nav = screen.getByRole('navigation', { name: 'Workflows' });

    const enabled = within(nav)
      .getAllByRole('button')
      .filter((button) => !(button as HTMLButtonElement).disabled);

    expect(enabled).toEqual([]);
  });

  it('marks every workflow as not implemented for assistive technology too', () => {
    renderApp();

    for (const workflow of WORKFLOWS) {
      const button = screen.getByTestId(`workflow-${workflow.id}`);
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('Not implemented');
    }
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

  it('does not claim success for a supported extension, because import is unimplemented', () => {
    renderApp();

    dropFiles([new File(['solid'], 'bracket.stl')]);

    const log = screen.getByTestId('status-list');
    expect(within(log).getByText(/importing models is not implemented yet/i)).toBeInTheDocument();
    expect(log.textContent).not.toMatch(/imported|loaded successfully|ready to repair/i);
  });

  it('screens each file in a multi-file drop', () => {
    renderApp();

    dropFiles([new File(['a'], 'good.obj'), new File(['b'], 'bad.gcode')]);

    const log = screen.getByTestId('status-list');
    expect(within(log).getByText(/not implemented yet/i)).toBeInTheDocument();
    expect(within(log).getByText(/\.gcode files are not supported/)).toBeInTheDocument();
  });

  it('never reads the contents of a dropped file', () => {
    renderApp();
    const file = new File(['solid ascii stl body'], 'bracket.stl');
    const readAsBuffer = vi.spyOn(file, 'arrayBuffer');
    const readAsText = vi.spyOn(file, 'text');

    dropFiles([file]);

    // Screening is a filename check. Reading contents would mean a parser
    // exists, and none does.
    expect(readAsBuffer).not.toHaveBeenCalled();
    expect(readAsText).not.toHaveBeenCalled();
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
