import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IDENTITY_PART_TRANSFORM, type PartTransform } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentRenderSnapshot,
  PartDescriptor,
} from '@cadfixer/geometry-runtime';
import { ConversionVerdict, ExportFormat } from '@cadfixer/file-formats';
import { LengthUnit } from '@cadfixer/shared';
import { ConvertWorkspace } from './ConvertWorkspace';
import { ExportSummary } from './ExportSummary';
import { OutputSizeCard } from './OutputSizeCard';
import { FileIntakeProvider } from './FileIntake';
import { ShellLayoutProvider } from './shell/shell-layout';
import { GeometryClientProvider } from '../runtime/client-context';
import { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from '../state/store-context';
import { WorkspaceStore } from '../state/workspace-store';
import { CONVERSION_FORBIDDEN_TERMS, UNIT_CHOICES } from '../state/conversion-presentation';
import type { LoadedModel } from '../state/model';
import { measurementUnitKey } from '../state/output-size';

/**
 * THE CONVERT WORKSPACE, at component level. (Ported from the Stage 4A-2B3
 * dialog's suite when UI-03 made the workspace the one conversion surface; the
 * dialog-only cases — modal focus, Escape to close — went with the dialog.)
 *
 * The happy path is proven end to end against real workers, where a download is
 * a download. What is worth testing here is what the workspace SAYS and what it
 * lets a user do — the states an end-to-end test reaches only by breaking
 * something, and the ones a browser test cannot assert cheaply:
 *
 *   - that no unit is ever preselected;
 *   - that the export action is unavailable until a conversion is possible;
 *   - that a filename full of markup renders as text;
 *   - that the four loss registers appear in the right places.
 *
 * The worker is stubbed in `vitest.setup.ts` and never replies, so nothing here
 * can accidentally be reading a real export result.
 */

afterEach(cleanup);

const TRANSLATED: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0];

interface PartOptions {
  readonly partId?: string;
  readonly name?: string;
  readonly transform?: PartTransform;
  readonly meshResourceIndex?: number;
  readonly groupCount?: number;
  readonly materialRef?: string;
}

function partDescriptor(options: PartOptions = {}): PartDescriptor {
  return {
    partId: options.partId ?? 'part-1',
    ...(options.name === undefined ? {} : { name: options.name }),
    transform: options.transform ?? IDENTITY_PART_TRANSFORM,
    triangleCount: 4,
    vertexCount: 12,
    bounds: undefined,
    meshResourceIndex: options.meshResourceIndex ?? 0,
    ...(options.materialRef === undefined ? {} : { materialRef: options.materialRef }),
    groupCount: options.groupCount ?? 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
  };
}

interface ModelOptions {
  readonly parts?: readonly PartDescriptor[];
  readonly fileName?: string;
  readonly formatId?: string;
  readonly unit?: string | undefined;
  readonly unsupportedFeatures?: readonly string[];
}

function loadModel(store: WorkspaceStore, options: ModelOptions = {}): DocumentHandle {
  const parts = options.parts ?? [partDescriptor()];
  const handle = { documentId: 'model-1', revision: 1 } as DocumentHandle;
  const renderSnapshot: DocumentRenderSnapshot = {
    parts: parts.map((part) => ({
      partId: part.partId,
      transform: part.transform,
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      vertexCount: 3,
    })),
  };
  const model: Omit<LoadedModel, 'revision'> = {
    handle,
    parts,
    render: renderSnapshot,
    source: {
      fileName: options.fileName ?? 'part.stl',
      fileBytes: 100,
      formatId: options.formatId ?? 'stl',
      encoding: 'binary',
      unit: options.unit,
      unsupportedFeatures: options.unsupportedFeatures ?? [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount: parts.length * 4,
    vertexCount: parts.length * 12,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 192,
  };
  const token = store.beginImport(model.source.fileName);
  store.commitImport(token, model);
  return handle;
}

function mount(store: WorkspaceStore, active = true): void {
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <ShellLayoutProvider>
          <FileIntakeProvider>
            <ConvertWorkspace active={active} />
          </FileIntakeProvider>
        </ShellLayoutProvider>
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
}

function renderWorkspace(configure: (store: WorkspaceStore) => void): WorkspaceStore {
  const store = new WorkspaceStore();
  configure(store);
  mount(store);
  return store;
}

/* ------------------------------------------------------------- CF18/CF22 -- */

describe('opening and choosing a target', () => {
  it('starts no session while the workspace is hidden', () => {
    const store = new WorkspaceStore();
    loadModel(store);
    mount(store, false);
    expect(store.getSnapshot().conversion.state).toBe('closed');
    expect(screen.queryByTestId('convert-progress')).toBeNull();
  });

  it('starts a session with the source format preselected once it is shown', () => {
    const store = new WorkspaceStore();
    loadModel(store, { formatId: 'obj' });
    mount(store, true);
    expect(store.getSnapshot().conversion.state).toBe('reviewing');
    expect(screen.getByTestId('convert-target-obj')).toBeChecked();
  });
  it('shows an empty source and no usable controls when there is no model', () => {
    renderWorkspace(() => undefined);
    expect(screen.getByTestId('convert-source-empty')).toHaveTextContent('Open an STL, OBJ or 3MF');
    expect(screen.getByTestId('convert-export')).toBeDisabled();
    expect(screen.getByTestId('convert-unavailable')).toHaveTextContent('Open an STL, OBJ or 3MF');
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });
  it('offers exactly the three formats CAD Fixer can write', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });

    expect(screen.getByTestId('convert-target-stl')).toBeEnabled();
    expect(screen.getByTestId('convert-target-obj')).toBeEnabled();
    expect(screen.getByTestId('convert-target-3mf')).toBeEnabled();

    /*
     * ONE MORE CARD, AND IT IS NOT A CHOICE. ASCII STL is a real CAD Fixer
     * capability that THIS operation does not perform, so it is shown disabled
     * with the place it does exist. No card for a format with no writer: a
     * disabled "PLY" or "GLB" would advertise a capability the product lacks.
     */
    const outputs = screen.getByRole('radiogroup', { name: 'Output format' });
    const radios = [...outputs.querySelectorAll('input[type="radio"]')];
    expect(radios).toHaveLength(4);
    expect(radios.filter((radio) => !(radio as HTMLInputElement).disabled)).toHaveLength(3);
    expect(screen.getByTestId('convert-target-stl-ascii')).toBeDisabled();
    expect(screen.getByTestId('convert-target-stl-ascii')).toHaveAccessibleDescription(
      /Inspector › Model/,
    );
    const text = outputs.textContent;
    for (const absent of ['PLY', 'AMF', 'GLB', 'FBX']) expect(text).not.toContain(absent);
  });
  it('preselects the source format, which bypasses no review', () => {
    renderWorkspace((store) => {
      loadModel(store, { formatId: 'obj' });
      store.openConversion('obj');
    });
    expect(screen.getByTestId('convert-target-obj')).toBeChecked();
    // The summary for that target is already on screen before anything is clicked.
    expect(screen.getByTestId('convert-report')).toBeInTheDocument();
  });

  it('never exports on its own', () => {
    /*
     * A PRESELECTED TARGET IS NOT A STARTED EXPORT. Opening the dialog must
     * leave the workspace idle; the only thing that writes a file is a press.
     */
    const store = renderWorkspace((s) => {
      loadModel(s);
      s.openConversion('stl');
    });
    expect(store.getSnapshot().conversion.state).toBe('reviewing');
    expect(screen.queryByTestId('convert-progress')).toBeNull();
  });

  it('recomputes the summary when the target changes', () => {
    renderWorkspace((store) => {
      loadModel(store, {
        parts: [
          partDescriptor({ partId: 'a' }),
          partDescriptor({ partId: 'b', meshResourceIndex: 1 }),
        ],
      });
      store.openConversion('stl');
    });

    // STL merges the parts.
    expect(screen.getByTestId('convert-verdict')).toHaveAttribute(
      'data-verdict',
      ConversionVerdict.LossyStructure,
    );

    fireEvent.click(screen.getByTestId('convert-target-obj'));

    // OBJ keeps them.
    expect(screen.getByTestId('convert-verdict')).toHaveAttribute(
      'data-verdict',
      ConversionVerdict.Lossless,
    );
  });
});

/* ------------------------------------------------------- CF19/CF20/CF21 -- */

describe('how losses are presented', () => {
  it('shows a clear, unalarmed state when nothing supported is lost', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });

    expect(screen.getByTestId('convert-lossless')).toBeInTheDocument();
    expect(screen.queryByTestId('convert-structure')).toBeNull();
    expect(screen.queryByTestId('convert-metadata')).toBeNull();
    expect(screen.queryByTestId('convert-blockers')).toBeNull();
  });

  it('separates metadata loss from structural loss', () => {
    renderWorkspace((store) => {
      loadModel(store, {
        formatId: '3mf',
        unit: LengthUnit.Millimeter,
        parts: [
          partDescriptor({ partId: 'a', name: 'Body' }),
          partDescriptor({ partId: 'b', name: 'Lid', meshResourceIndex: 1 }),
        ],
      });
      store.openConversion('3mf');
    });

    fireEvent.click(screen.getByTestId('convert-target-stl'));

    // The unit and the names are labels...
    expect(screen.getByTestId('convert-metadata')).toHaveTextContent('stores no unit');
    // ...and the merged parts are structure.
    expect(screen.getByTestId('convert-structure')).toHaveTextContent('merged into one mesh');
  });

  it('says the coordinates are unchanged in the same breath as the lost unit', () => {
    /*
     * THE SENTENCE THAT MATTERS MOST ON THIS SCREEN. Either half alone misleads:
     * "the unit is not stored" invites the fear that something was rescaled, and
     * "the coordinates are unchanged" invites the belief that the size survived.
     */
    renderWorkspace((store) => {
      loadModel(store, { formatId: '3mf', unit: LengthUnit.Inch });
      store.openConversion('obj');
    });

    const metadata = screen.getByTestId('convert-metadata');
    expect(metadata).toHaveTextContent('written unchanged');
    expect(metadata).toHaveTextContent('nothing is resized');
  });

  it('shows a blocker as a requirement rather than as a failure', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('3mf');
    });

    expect(screen.getByTestId('convert-blockers')).toBeInTheDocument();
    expect(screen.getByTestId('convert-verdict')).toHaveAttribute(
      'data-verdict',
      ConversionVerdict.Blocked,
    );
    expect(screen.getByTestId('convert-export')).toBeDisabled();
  });

  it('warns about nothing the document does not contain', () => {
    /*
     * A REPORT THAT WARNS ABOUT EVERYTHING TEACHES PEOPLE TO READ NOTHING. A
     * one-part identity-placed unnamed document loses nothing an STL could have
     * carried, and the panel says so by showing no loss sections at all.
     */
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });

    const workspace = screen.getByTestId('convert-workspace');
    expect(workspace).not.toHaveTextContent('merged into one mesh');
    expect(workspace).not.toHaveTextContent('texture coordinates');
    expect(workspace).not.toHaveTextContent('face group');
  });

  it('never emits a forbidden claim, whatever the document', () => {
    renderWorkspace((store) => {
      loadModel(store, {
        formatId: '3mf',
        unit: LengthUnit.Inch,
        unsupportedFeatures: ['TEXTURES', 'MATERIALS', 'COMPONENT_HIERARCHY'],
        parts: [
          partDescriptor({ partId: 'a', name: 'Body', groupCount: 2, materialRef: 'steel' }),
          partDescriptor({ partId: 'b', transform: TRANSLATED }),
        ],
      });
      store.openConversion('obj');
    });

    const text = screen.getByTestId('convert-workspace').textContent.toLowerCase();
    for (const term of CONVERSION_FORBIDDEN_TERMS) {
      expect(text.includes(term), `"${term}" reached the screen`).toBe(false);
    }
  });
});

/* ----------------------------------------------------------- CF13 / CF36 -- */

describe('source import warnings', () => {
  it('shows them in their own section, apart from the target losses', () => {
    renderWorkspace((store) => {
      loadModel(store, {
        formatId: '3mf',
        unit: LengthUnit.Millimeter,
        unsupportedFeatures: ['TEXTURES'],
      });
      store.openConversion('3mf');
    });

    const section = screen.getByTestId('convert-source-warnings');
    expect(section).toHaveTextContent('did not import');
    expect(section).toHaveTextContent('cannot put it back');
  });

  it('keeps them on screen when the target changes', () => {
    /*
     * THEY DESCRIBE THE FILE THAT WAS OPENED, not the format being written, so
     * changing the target cannot make them disappear — and folding them into the
     * target's losses would blame this conversion for a loss that happened on
     * import.
     */
    renderWorkspace((store) => {
      loadModel(store, {
        formatId: '3mf',
        unit: LengthUnit.Millimeter,
        unsupportedFeatures: ['TEXTURES'],
      });
      store.openConversion('3mf');
    });

    for (const target of ['stl', 'obj', '3mf']) {
      fireEvent.click(screen.getByTestId(`convert-target-${target}`));
      expect(screen.getByTestId('convert-source-warnings')).toHaveTextContent('did not import');
    }
  });

  it('shows no such section for a file that lost nothing on import', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    expect(screen.queryByTestId('convert-source-warnings')).toBeNull();
  });
});

/* --------------------------------------------------------------- CF14/CF15 -- */

describe('the unit selection', () => {
  function openUnitCase(): WorkspaceStore {
    return renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('3mf');
    });
  }

  it('asks for a unit only when the target needs one and the document has none', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    expect(screen.queryByTestId('convert-unit')).toBeNull();

    cleanup();

    renderWorkspace((store) => {
      loadModel(store, { formatId: '3mf', unit: LengthUnit.Millimeter });
      store.openConversion('3mf');
    });
    expect(screen.queryByTestId('convert-unit')).toBeNull();
  });

  it('SELECTS NOTHING by default', () => {
    /*
     * THE TEST THIS FLOW MOST NEEDS. A unit control that started with an answer
     * would be CAD Fixer choosing a physical unit on the user's behalf, which is
     * precisely what this stage exists to prevent. No radio starts checked and
     * the store holds `undefined`.
     */
    const store = openUnitCase();
    const group = screen.getByRole('radiogroup', { name: 'Units' });
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(6);
    expect(radios.some((radio) => radio.checked)).toBe(false);
    expect(store.getSnapshot().conversion.unitAssertion).toBeUndefined();
  });
  it('keeps the export action unavailable until a unit is deliberately chosen', () => {
    openUnitCase();
    expect(screen.getByTestId('convert-export')).toBeDisabled();

    fireEvent.click(screen.getByTestId(`convert-unit-${LengthUnit.Inch}`));

    expect(screen.getByTestId('convert-export')).toBeEnabled();
  });
  it('offers exactly the six units, in the shared order', () => {
    openUnitCase();
    const group = screen.getByRole('radiogroup', { name: 'Units' });
    const values = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(
      (radio) => radio.value,
    );

    expect(values).toEqual(UNIT_CHOICES.map((choice) => choice.value));
    expect(values).toHaveLength(6);
  });
  it('accepts each of the six and records exactly what was chosen', () => {
    for (const choice of UNIT_CHOICES) {
      const store = openUnitCase();
      fireEvent.click(screen.getByTestId(`convert-unit-${choice.value}`));
      expect(store.getSnapshot().conversion.unitAssertion).toBe(choice.value);
      cleanup();
    }
  });
  it('explains that choosing a unit labels rather than resizes', () => {
    openUnitCase();
    const panel = screen.getByTestId('convert-unit');
    expect(panel).toHaveTextContent('does not resize anything');
    expect(panel).toHaveTextContent('25 mm');
    expect(panel).toHaveTextContent('exported file only');
  });

  it('keeps the choice when the user looks at another target and comes back', () => {
    /*
     * A UNIT IS A STATEMENT ABOUT THE MODEL, not about the target. Someone who
     * has said "these numbers are inches" has not unsaid it by looking at what
     * OBJ would do.
     */
    const store = openUnitCase();
    fireEvent.click(screen.getByTestId(`convert-unit-${LengthUnit.Foot}`));

    fireEvent.click(screen.getByTestId('convert-target-obj'));
    fireEvent.click(screen.getByTestId('convert-target-3mf'));

    expect(store.getSnapshot().conversion.unitAssertion).toBe(LengthUnit.Foot);
    expect(screen.getByTestId(`convert-unit-${LengthUnit.Foot}`)).toBeChecked();
  });
});

/* ------------------------------------------------------------------ CF25 -- */

describe('hostile display strings', () => {
  const HOSTILE = '<script>alert(1)</script>&"‮gnp.lts‬../../etc/passwd';

  it('renders a hostile filename as text and nothing else', () => {
    renderWorkspace((store) => {
      loadModel(store, { fileName: HOSTILE });
      store.openConversion('stl');
    });

    const source = screen.getByTestId('convert-source');
    // The characters are PRESENT, as text.
    expect(source.textContent).toContain('<script>');
    // And no element was created from them.
    expect(source.querySelector('script')).toBeNull();
    expect(screen.getByTestId('convert-workspace').querySelector('script')).toBeNull();
  });

  it('renders a hostile part name as text', () => {
    renderWorkspace((store) => {
      loadModel(store, {
        parts: [
          partDescriptor({ name: HOSTILE }),
          partDescriptor({ partId: 'b', meshResourceIndex: 1 }),
        ],
      });
      store.openConversion('obj');
    });

    const workspace = screen.getByTestId('convert-workspace');
    expect(workspace.querySelector('script')).toBeNull();
    /*
     * AND THE NAME IS NOT SHOWN AT ALL, because the report carries COUNTS rather
     * than names. A fact that held a part name would be a fact that could carry
     * hostile text into markup, and it would be a second place display copy
     * lived.
     */
    expect(workspace.textContent).not.toContain('alert(1)');
  });

  it('keeps a very long filename whole in the accessible name and the tooltip', () => {
    const long = `${'a'.repeat(400)}.stl`;
    renderWorkspace((store) => {
      loadModel(store, { fileName: long });
      store.openConversion('stl');
    });
    // The card truncates visually; the full name stays readable.
    const source = screen.getByTestId('convert-source');
    expect(source).toHaveAttribute('title', long);
    expect(source.textContent).toBe(long);
  });
});

/* ------------------------------------------------------------------ CF26 -- */

describe('keyboard and assistive technology', () => {
  it('presents the outputs as a labelled single-choice group with full names', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });

    const outputs = screen.getByRole('radiogroup', { name: 'Output format' });
    expect(outputs).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'STL, binary' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '3MF, core model package' })).not.toBeChecked();
    // Not a modal: the workspace is a panel beside the model, never over it.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('labels the unit choices by their full names', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('3mf');
    });

    expect(screen.getByRole('radiogroup', { name: 'Units' })).toBeInTheDocument();
    for (const choice of UNIT_CHOICES) {
      expect(screen.getByRole('radio', { name: choice.label })).toBeInTheDocument();
    }
  });

  it('says why the action is unavailable, beside it and in its description', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('3mf');
    });

    const action = screen.getByTestId('convert-export');
    expect(action).toBeDisabled();
    expect(action).toHaveAccessibleDescription(/Format options/);
    expect(screen.getByTestId('convert-unavailable')).toBeVisible();
  });
  it('announces the outcome in a live region', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
      const token = store.beginConversion();
      store.completeConversion(token, {
        fileName: 'part.stl',
        byteLength: 284,
        target: 'stl',
        triangleCount: 4,
        partCount: 1,
        source: { documentId: 'model-1', revision: 1 } as DocumentHandle,
        unitAssertion: undefined,
      });
    });

    const saved = screen.getByTestId('convert-saved');
    expect(saved.closest('[aria-live]')).not.toBeNull();
    expect(saved).toHaveTextContent('read back and checked');
  });

  it('does not rely on colour alone: every section states its meaning in words', () => {
    renderWorkspace((store) => {
      loadModel(store, {
        formatId: '3mf',
        unit: LengthUnit.Millimeter,
        parts: [
          partDescriptor({ partId: 'a' }),
          partDescriptor({ partId: 'b', meshResourceIndex: 1 }),
        ],
      });
      store.openConversion('stl');
    });

    expect(screen.getByTestId('convert-structure')).toHaveTextContent(
      'How the model is put together will change',
    );
    expect(screen.getByTestId('convert-metadata')).toHaveTextContent(
      'Labels this format cannot store',
    );
  });
});

/* ------------------------------------------------------------ CF23 / CF35 -- */

describe('progress, cancellation and retry', () => {
  it('shows the writer own phase rather than a fabricated bar', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
      const token = store.beginConversion();
      store.reportConversionProgress(token, 0.42, 'validating');
    });

    expect(screen.getByTestId('convert-phase')).toHaveTextContent(
      'Checking the file reads back correctly',
    );
    expect(screen.getByTestId('convert-percent')).toHaveTextContent('42%');
  });

  it('offers Cancel only while an export is running', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
      s.openConversion('stl');
    });
    expect(screen.queryByTestId('convert-cancel')).toBeNull();

    act(() => {
      store.beginConversion();
    });
    expect(screen.getByTestId('convert-cancel')).toBeInTheDocument();
  });

  it('locks the choices mid-write, so a running file cannot change underneath', () => {
    /*
     * NOTHING ABOUT A RUNNING EXPORT CHANGES EXCEPT BY CANCEL. The format cards
     * are disabled while a file is written, and Escape does not stop it: an
     * accidental key that silently killed the worker would look exactly like a
     * finished export that produced no file.
     */
    const store = renderWorkspace((s) => {
      loadModel(s);
      s.openConversion('stl');
      s.beginConversion();
    });

    fireEvent.keyDown(screen.getByTestId('convert-workspace'), { key: 'Escape' });
    expect(store.getSnapshot().conversion.state).toBe('working');
    expect(screen.getByTestId('convert-target-obj')).toBeDisabled();
    expect(screen.getByTestId('convert-export')).toBeDisabled();
    expect(screen.getByTestId('convert-export')).toHaveAttribute('aria-busy', 'true');
  });
  it('stays usable after a failure, so the user can act on it', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
      s.openConversion('3mf');
      s.setConversionUnit(LengthUnit.Millimeter);
      const token = s.beginConversion();
      s.failConversion(token, { status: 'RESOURCE_LIMIT', reason: 'EXPORT_OUTPUT_TOO_LARGE' });
    });

    // ONE LINE in the footer (Convert P1); the sentence is behind ⓘ.
    expect(screen.getByTestId('convert-failure')).toHaveTextContent('3MF export unavailable');
    expect(screen.getByTestId('convert-outcome-details')).toHaveTextContent('nothing was saved');
    // The chosen target and unit survive, so a retry does not start from scratch.
    expect(store.getSnapshot().conversion.target).toBe('3mf');
    expect(store.getSnapshot().conversion.unitAssertion).toBe(LengthUnit.Millimeter);
    // No size refusal was recorded for this attempt, so nothing is disabled.
    expect(screen.getByTestId('convert-export')).toBeEnabled();
  });

  it('a size refusal disables exactly that revision, format and unit, with the reason beside it (Convert P1)', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
      s.openConversion('3mf');
      s.setConversionUnit(LengthUnit.Millimeter);
      const model = s.getSnapshot().model;
      if (model === undefined) throw new Error('expected a model');
      const token = s.beginConversion();
      s.failConversion(
        token,
        { status: 'RESOURCE_LIMIT', reason: 'EXPORT_SERIALISED_TOO_LARGE' },
        {
          source: model.handle,
          target: '3mf',
          unitAssertion: measurementUnitKey(model, ExportFormat.ThreeMf, LengthUnit.Millimeter),
        },
      );
    });

    expect(screen.getByTestId('convert-failure')).toHaveTextContent('3MF export unavailable');
    expect(screen.getByTestId('convert-export')).toBeDisabled();
    expect(screen.getByTestId('convert-unavailable')).toHaveTextContent(
      'This model exceeds the safe browser export limit for 3MF.',
    );
    expect(screen.getByTestId('convert-outcome-details')).toHaveTextContent('saved nothing');
    fireEvent.click(screen.getByTestId('convert-refusal-info'));
    expect(screen.getByTestId('convert-outcome-details')).toBeVisible();

    // Another format is offered; the refused one stays refused without a retry.
    act(() => {
      store.setConversionTarget('stl');
    });
    expect(screen.getByTestId('convert-export')).toBeEnabled();
    expect(screen.queryByTestId('convert-unavailable')).toBeNull();
    act(() => {
      store.setConversionTarget('3mf');
      store.setConversionUnit(LengthUnit.Millimeter);
    });
    expect(screen.getByTestId('convert-export')).toBeDisabled();
    // A different unit is a different file, so it is offered again.
    act(() => {
      store.setConversionUnit(LengthUnit.Inch);
    });
    expect(screen.getByTestId('convert-export')).toBeEnabled();
  });

  it('never claims a file was saved before validation succeeded', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
      const token = store.beginConversion();
      store.reportConversionProgress(token, 0.9, 'validating');
    });
    expect(screen.queryByTestId('convert-saved')).toBeNull();
  });
});

/* ------------------------------------------------------------------ CF34 -- */

describe('the workflow is document-level', () => {
  it('says every part is written, whichever one is selected', () => {
    renderWorkspace((store) => {
      loadModel(store, {
        parts: [
          partDescriptor({ partId: 'a' }),
          partDescriptor({ partId: 'b', meshResourceIndex: 1 }),
        ],
      });
      store.selectPart('b');
      store.openConversion('stl');
    });

    expect(screen.getByTestId('convert-whole-document')).toHaveTextContent(
      'Every part is written, whichever part is selected',
    );
  });

  it('reports the same facts whichever part is active', () => {
    const parts = [
      partDescriptor({ partId: 'a', name: 'Body' }),
      partDescriptor({ partId: 'b', name: 'Lid', meshResourceIndex: 1 }),
    ];

    const readFacts = (active: string): string | null => {
      const store = new WorkspaceStore();
      loadModel(store, { parts });
      store.selectPart(active);
      store.openConversion('stl');
      mount(store);
      const text = screen.getByTestId('convert-report').textContent;
      cleanup();
      return text;
    };

    expect(readFacts('b')).toBe(readFacts('a'));
  });

  it('shows no whole-document note for a one-part document', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    expect(screen.queryByTestId('convert-whole-document')).toBeNull();
  });
});

/* --------------------------------------------------------------- UI-03 -- */

function saveAs(
  store: WorkspaceStore,
  target: string,
  byteLength: number,
  unitAssertion?: string,
): void {
  const token = store.beginConversion();
  const model = store.getSnapshot().model;
  if (model === undefined) throw new Error('fixture');
  store.completeConversion(token, {
    fileName: `part.${target}`,
    byteLength,
    target,
    triangleCount: model.triangleCount,
    partCount: model.parts.length,
    source: model.handle,
    unitAssertion,
  });
}

describe('output sizes are exact, measured or unknown — never invented', () => {
  it('states the binary STL size exactly, from the triangle count', () => {
    renderWorkspace((store) => {
      loadModel(store); // 4 triangles
      store.openConversion('stl');
    });
    // 84 + 50 × 4 = 284 bytes, before anything is written.
    expect(screen.getByTestId('convert-size-stl')).toHaveTextContent('284 B');
  });

  it('shows no number for OBJ or 3MF until one has been written', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    for (const target of ['obj', '3mf']) {
      expect(screen.getByTestId(`convert-size-${target}`)).toHaveTextContent('—');
      // The dash is never the whole explanation.
      expect(screen.getByTestId(`convert-target-${target}`)).toHaveAccessibleDescription(
        /Known once the file is written/,
      );
    }
  });

  it('shows the measured size of a file written from this revision', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
      s.openConversion('obj');
    });
    act(() => {
      saveAs(store, 'obj', 5_000);
    });
    expect(screen.getByTestId('convert-size-obj')).toHaveTextContent('4.9 KiB');
  });

  it('files a 3MF measurement under the unit it was written with', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
      s.openConversion('3mf');
      s.setConversionUnit(LengthUnit.Inch);
    });
    act(() => {
      saveAs(store, '3mf', 2_000, LengthUnit.Inch);
    });
    expect(screen.getByTestId('convert-size-3mf')).toHaveTextContent('2.0 KiB');

    // Another unit writes another file, so the measurement no longer applies.
    fireEvent.click(screen.getByTestId(`convert-unit-${LengthUnit.Meter}`));
    expect(screen.getByTestId('convert-size-3mf')).toHaveTextContent('—');
  });

  it('forgets every measurement when a different model is opened', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
      s.openConversion('obj');
    });
    act(() => {
      saveAs(store, 'obj', 5_000);
    });
    act(() => {
      loadModel(store);
    });
    expect(store.getSnapshot().conversion.measured).toEqual([]);
  });
});

describe('the primary action says what it does', () => {
  it('reads "Export STL" when the format does not change', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    expect(screen.getByTestId('convert-export')).toHaveTextContent('Export STL');
  });

  it('reads "Convert to OBJ" when it does, and never counts files', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('obj');
    });
    const action = screen.getByTestId('convert-export');
    expect(action).toHaveTextContent('Convert to OBJ');
    expect(action.textContent).not.toMatch(/files|formats/i);
  });

  it('reads "Writing…" while an export runs', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
      store.beginConversion();
    });
    expect(screen.getByTestId('convert-export')).toHaveTextContent('Writing…');
  });
});

describe('the source card shows only what the document records', () => {
  it('shows the format, encoding, size, triangles, parts and unit', () => {
    renderWorkspace((store) => {
      loadModel(store, {
        parts: [partDescriptor({ partId: 'a' }), partDescriptor({ partId: 'b' })],
      });
      store.openConversion('stl');
    });
    expect(screen.getByTestId('convert-source-meta')).toHaveTextContent('STL');
    expect(screen.getByTestId('convert-source-meta')).toHaveTextContent('8 triangles');
    expect(screen.getByTestId('convert-source-meta')).toHaveTextContent('100 B');
    expect(screen.getByTestId('convert-source-parts')).toHaveTextContent('2 parts');
    expect(screen.getByTestId('convert-source-unit')).toHaveTextContent('No unit stated');
  });

  it('never claims an absence it cannot know', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    const card = screen.getByTestId('convert-source-section');
    expect(card).not.toHaveTextContent(/no colou?rs|no materials/i);
    expect(screen.queryByTestId('convert-source-materials')).toBeNull();
  });

  it('names material references only when the document carries them', () => {
    renderWorkspace((store) => {
      loadModel(store, { parts: [partDescriptor({ materialRef: 'steel' })] });
      store.openConversion('stl');
    });
    expect(screen.getByTestId('convert-source-materials')).toBeInTheDocument();
  });
});

describe('format options show facts, and a control only where it changes the file', () => {
  it('offers no axis, merge, colour, texture or metadata control for any target', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('3mf');
    });
    for (const target of ['stl', 'obj', '3mf']) {
      fireEvent.click(screen.getByTestId(`convert-target-${target}`));
      const options = screen.getByTestId('convert-options');
      expect(options.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
      expect(options).not.toHaveTextContent(/Y-up|Z-up|Merge objects|Designer|thumbnail/i);
    }
  });

  it('states that STL records no unit and writes the coordinates unchanged', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    const fact = screen.getByTestId('convert-unit-fact');
    expect(fact).toHaveTextContent('STL has no unit field');
    expect(fact).toHaveTextContent('written unchanged');
  });

  it('states a unit the model already has instead of asking for one', () => {
    renderWorkspace((store) => {
      loadModel(store, { formatId: '3mf', unit: LengthUnit.Millimeter });
      store.openConversion('3mf');
    });
    expect(screen.queryByTestId('convert-unit')).toBeNull();
    expect(screen.getByTestId('convert-unit-fact')).toHaveTextContent('Millimetres (mm)');
  });

  it('says how the parts end up, per target', () => {
    renderWorkspace((store) => {
      loadModel(store, {
        parts: [partDescriptor({ partId: 'a' }), partDescriptor({ partId: 'b' })],
      });
      store.openConversion('stl');
    });
    expect(screen.getByTestId('convert-objects-fact')).toHaveTextContent('merged into one mesh');
    fireEvent.click(screen.getByTestId('convert-target-3mf'));
    expect(screen.getByTestId('convert-objects-fact')).toHaveTextContent('placements kept');
  });

  it('warns when an unapplied preview is on screen', () => {
    renderWorkspace((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    expect(screen.queryByTestId('convert-pending-preview')).toBeNull();
  });
});

function mountSurface(store: WorkspaceStore, surface: 'size' | 'summary'): void {
  render(
    <WorkspaceProvider store={store}>
      {surface === 'size' ? <OutputSizeCard /> : <ExportSummary />}
    </WorkspaceProvider>,
  );
}

describe('the viewport size card', () => {
  it('compares an exact output with the source and labels it exact', () => {
    const store = new WorkspaceStore();
    loadModel(store); // 100-byte source, 4 triangles
    store.openConversion('stl');
    mountSurface(store, 'size');

    expect(screen.getByTestId('output-size-source')).toHaveTextContent('100 B');
    const row = screen.getByTestId('output-size-target');
    expect(row).toHaveAttribute('data-kind', 'exact');
    expect(row).toHaveTextContent('284 B');
    expect(screen.getByTestId('output-size-delta')).toHaveTextContent('+184%');
    expect(screen.getByTestId('output-size-kind')).toHaveTextContent('Exact');
  });

  it('shows no number and no difference for a size it cannot know', () => {
    const store = new WorkspaceStore();
    loadModel(store);
    store.openConversion('3mf');
    mountSurface(store, 'size');

    expect(screen.getByTestId('output-size-target')).toHaveAttribute('data-kind', 'unknown');
    expect(screen.queryByTestId('output-size-delta')).toBeNull();
  });

  it('does not present a larger file as an error', () => {
    const store = new WorkspaceStore();
    loadModel(store);
    store.openConversion('stl');
    mountSurface(store, 'size');
    expect(screen.getByTestId('output-size-delta').className).not.toMatch(/error|danger/);
  });
});

describe('the inspector export summary', () => {
  it('names the source, output, parts, units and a destination it does not invent', () => {
    const store = new WorkspaceStore();
    loadModel(store);
    store.openConversion('obj');
    mountSurface(store, 'summary');

    expect(screen.getByTestId('export-summary-source')).toHaveTextContent('STL · Binary');
    expect(screen.getByTestId('export-summary-output')).toHaveTextContent('OBJ · No MTL');
    expect(screen.getByTestId('export-summary-units')).toHaveTextContent('OBJ has no unit field');
    expect(screen.getByTestId('export-summary-destination')).toHaveTextContent('Browser downloads');
    expect(screen.getByTestId('export-summary')).not.toHaveTextContent('~/');
  });

  it('names the native destination for large OBJ without inventing its path', () => {
    const store = new WorkspaceStore();
    loadModel(store, {
      parts: [{ ...partDescriptor(), vertexCount: 750_000, triangleCount: 250_000 }],
    });
    store.openConversion('obj');
    mountSurface(store, 'summary');
    expect(screen.getByTestId('export-summary-destination')).toHaveTextContent('File you choose');
    expect(screen.getByTestId('export-summary')).not.toHaveTextContent('/Users/');
  });

  it('shows the last file only for the revision on screen', () => {
    const store = new WorkspaceStore();
    loadModel(store);
    store.openConversion('stl');
    saveAs(store, 'stl', 284);
    mountSurface(store, 'summary');
    expect(screen.getByTestId('export-summary-last')).toHaveTextContent('part.stl');
  });
});
