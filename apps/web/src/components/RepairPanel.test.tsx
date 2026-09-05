import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentRenderSnapshot,
  PartDescriptor,
  TopologyReport,
} from '@cadfixer/geometry-runtime';
import { RepairPanel } from './RepairPanel';
import { GeometryClientProvider } from '../runtime/client-context';
import { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from '../state/store-context';
import { WorkspaceStore } from '../state/workspace-store';
import {
  REPAIR_EXCLUSIONS,
  REPAIR_ISOLATION_HEADLINE,
  REPAIR_QUALIFIER,
} from '../state/repair-presentation';
import type { LoadedModel } from '../state/model';

/**
 * The repair panel's STATES, at component level.
 *
 * The happy path is covered end to end against the real worker, where it belongs:
 * a component test that stubbed a plan would only prove the stub was rendered.
 * What is worth testing here is what the panel says when it CANNOT offer a
 * repair — no model, and no usable topology report — because those are the paths
 * an end-to-end test reaches only by breaking something, and they are exactly
 * where an interface is tempted to show nothing at all.
 *
 * The worker is stubbed in `vitest.setup.ts` and never replies, so nothing here
 * can accidentally be reading a real result.
 */

/**
 * Declares the cross-origin isolation the repair workflow REQUIRES.
 *
 * jsdom is never isolated and does not define `crossOriginIsolated` at all, so
 * without this every panel test would exercise the fail-closed path instead of
 * the workflow. Set per file rather than globally in `vitest.setup.ts`, because
 * `App.test.tsx` asserts the diagnostic that reports the REAL value of this
 * property and a global override would make that assertion meaningless.
 *
 * The gate itself is asserted in both directions below.
 */
function setIsolated(value: boolean): void {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    configurable: true,
    writable: true,
    value,
  });
}

beforeEach(() => {
  setIsolated(true);
});

function renderPanel(configure: (store: WorkspaceStore) => void = () => undefined): WorkspaceStore {
  const store = new WorkspaceStore();
  configure(store);
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <RepairPanel />
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
  return store;
}

const PART = 'part-1';

function partDescriptor(): PartDescriptor {
  return {
    partId: PART,
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount: 4,
    vertexCount: 12,
    bounds: undefined,
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
  };
}

function loadModel(store: WorkspaceStore): DocumentHandle {
  const handle = { documentId: 'model-1', revision: 1 } as DocumentHandle;
  const render_: DocumentRenderSnapshot = {
    parts: [
      {
        partId: PART,
        transform: IDENTITY_PART_TRANSFORM,
        positions: new Float32Array(9),
        normals: new Float32Array(9),
        vertexCount: 3,
      },
    ],
  };
  const model: Omit<LoadedModel, 'revision'> = {
    handle,
    parts: [partDescriptor()],
    render: render_,
    source: {
      fileName: 'part.stl',
      fileBytes: 100,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount: 4,
    vertexCount: 12,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 192,
  };
  const token = store.beginImport('part.stl');
  store.commitImport(token, model);
  return handle;
}

afterEach(cleanup);

describe('with no model', () => {
  it('shows an empty state rather than enabled repair controls', () => {
    renderPanel();

    expect(screen.getByTestId('repair-empty')).toHaveTextContent('No model loaded.');
    // PART B2. Nothing that could be pressed exists at all.
    expect(screen.queryByTestId('preview-repair')).toBeNull();
    expect(screen.queryByTestId('apply-repair')).toBeNull();
    expect(screen.queryByTestId('undo-repair')).toBeNull();
    expect(screen.queryByTestId('repair-operations')).toBeNull();
  });

  it('still states what the workflow does not do', () => {
    // The exclusions are not conditional on having a model: a user deciding
    // whether to open a file needs to know what this workflow covers.
    renderPanel();

    const exclusions = within(screen.getByTestId('repair-exclusions')).getAllByRole('listitem');
    expect(exclusions).toHaveLength(REPAIR_EXCLUSIONS.length);
    expect(screen.getByTestId('repair-exclusions')).toHaveTextContent('No tolerance is used');
  });

  it('names itself conservative in its heading', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Conservative repair' })).toBeInTheDocument();
    // The claims this stage exists to avoid, checked against the whole panel.
    const panel = screen.getByRole('region', { name: 'Conservative repair' });
    expect(panel.textContent).not.toMatch(/printable|watertight|fix everything/i);
  });
});

describe('when the topology report is not usable', () => {
  it('explains the dependency rather than showing an empty operation list', () => {
    /*
     * PART B1. Repair is planned FROM a report, so with none there is nothing
     * honest to plan.
     *
     * Which of the four sentences appears is decided by
     * `describeAnalysisDependency`, and every branch of it is asserted in
     * `repair-presentation.test.ts`. What matters here is the STRUCTURE: an
     * explanation is rendered, and nothing that could start a repair is.
     */
    renderPanel(loadModel);

    expect(screen.getByTestId('repair-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('repair-analysis-note').textContent).toMatch(/topology report/i);
    expect(screen.queryByTestId('repair-operations')).toBeNull();
    expect(screen.queryByTestId('preview-repair')).toBeNull();
    expect(screen.queryByTestId('apply-repair')).toBeNull();
  });

  it('says nothing about the model while an analysis is still running', () => {
    renderPanel((store) => {
      const handle = loadModel(store);
      store.beginAnalysis(handle, PART);
    });

    expect(screen.getByTestId('repair-analysis-note')).toHaveTextContent(
      /Analysis is still running/,
    );
    // No retry while one is in flight: it would cancel the answer being computed.
    expect(screen.queryByTestId('repair-run-analysis')).toBeNull();
  });

  it('refuses a report that describes a DIFFERENT revision of the model', () => {
    /*
     * The stale-report case, which matters most immediately after a repair: the
     * model is at revision 2 and the report on screen still describes revision 1.
     * Planning from it would propose changes to geometry that no longer exists.
     */
    renderPanel((store) => {
      const handle = loadModel(store);
      const token = store.beginAnalysis(handle, PART);
      store.commitAnalysis(token, handle, PART, {} as TopologyReport, {} as never, 1);
      store.applyRepairResult({
        handle: { documentId: 'model-1', revision: 2 } as DocumentHandle,
        partId: PART,
        parts: [partDescriptor()],
        parentRevision: 1,
        recordId: 'record-1',
        appliedOperations: [],
        counts: {
          removedDuplicateFaces: 0,
          removedRepeatedPositionFaces: 0,
          removedZeroAreaFaces: 0,
          flippedFaces: 0,
          sourceFaceCount: 4,
          candidateFaceCount: 4,
        },
        undoable: true,
        render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
        bounds: undefined,
        triangleCount: 4,
        vertexCount: 12,
        residentBytes: 192,
      });
    });

    expect(screen.getByTestId('repair-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-repair')).toBeNull();
  });
});

describe('after a repair has been applied', () => {
  it('reports what was applied, qualifies it, and offers a single undo', () => {
    renderPanel((store) => {
      loadModel(store);
      store.applyRepairResult({
        handle: { documentId: 'model-1', revision: 2 } as DocumentHandle,
        partId: PART,
        parts: [partDescriptor()],
        parentRevision: 1,
        recordId: 'record-1',
        appliedOperations: ['remove-duplicate-faces'],
        counts: {
          removedDuplicateFaces: 1,
          removedRepeatedPositionFaces: 0,
          removedZeroAreaFaces: 0,
          flippedFaces: 0,
          sourceFaceCount: 5,
          candidateFaceCount: 4,
        },
        undoable: true,
        render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
        bounds: undefined,
        triangleCount: 4,
        vertexCount: 12,
        residentBytes: 192,
      });
    });

    expect(screen.getByTestId('repair-applied-headline')).toHaveTextContent(
      'Conservative repair applied',
    );
    expect(screen.getByTestId('repair-applied-detail')).toHaveTextContent(
      'Selected topological issues were repaired and revalidated.',
    );
    // The qualifier travels with the success message, not only with failures.
    expect(screen.getByTestId('repair-applied-qualifier')).toHaveTextContent(REPAIR_QUALIFIER);
    expect(screen.getByTestId('repair-applied-operations')).toHaveTextContent(
      'Remove exact duplicate triangles',
    );
    expect(screen.getByTestId('repair-applied-counts')).toHaveTextContent(
      '5 triangles before · 4 after',
    );
    expect(screen.getByTestId('undo-repair')).toBeEnabled();
  });

  it('disables undo and says so when the repair cannot be reversed', () => {
    renderPanel((store) => {
      loadModel(store);
      store.applyRepairResult({
        handle: { documentId: 'model-1', revision: 2 } as DocumentHandle,
        partId: PART,
        parts: [partDescriptor()],
        parentRevision: 1,
        recordId: 'record-1',
        appliedOperations: [],
        counts: {
          removedDuplicateFaces: 0,
          removedRepeatedPositionFaces: 0,
          removedZeroAreaFaces: 0,
          flippedFaces: 0,
          sourceFaceCount: 4,
          candidateFaceCount: 4,
        },
        undoable: false,
        render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
        bounds: undefined,
        triangleCount: 4,
        vertexCount: 12,
        residentBytes: 192,
      });
    });

    expect(screen.getByTestId('undo-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-undo-unavailable')).toBeInTheDocument();
  });
});

describe('when the context cannot interrupt a repair', () => {
  /*
   * FAIL CLOSED. Conservative repair promises that a running repair can be
   * stopped. Without cross-origin isolation there is no SharedArrayBuffer, so
   * the only cancellation left is a message a synchronous pass cannot read —
   * which would make Cancel a control that silently does nothing on exactly the
   * large models where a user reaches for it.
   */
  it('withholds the workflow and names the deployment fault', () => {
    setIsolated(false);
    renderPanel(loadModel);

    expect(screen.getByTestId('repair-isolation-unavailable')).toHaveTextContent(
      REPAIR_ISOLATION_HEADLINE,
    );
    expect(screen.getByTestId('repair-isolation-detail')).toHaveTextContent(
      /cross-origin isolated/i,
    );
  });

  it('offers no control that would start or cancel a repair', () => {
    setIsolated(false);
    renderPanel(loadModel);

    // The point of the gate: not a disabled Cancel, but no repair surface at all.
    expect(screen.queryByTestId('preview-repair')).toBeNull();
    expect(screen.queryByTestId('cancel-repair')).toBeNull();
    expect(screen.queryByTestId('apply-repair')).toBeNull();
    expect(screen.queryByTestId('repair-operations')).toBeNull();
  });

  it('still renders the workflow when the context IS isolated', () => {
    setIsolated(true);
    renderPanel(loadModel);

    expect(screen.queryByTestId('repair-isolation-unavailable')).toBeNull();
  });
});
