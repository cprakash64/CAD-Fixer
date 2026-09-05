import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { IDENTITY_PART_TRANSFORM, type PartTransform } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentRenderSnapshot,
  PartDescriptor,
} from '@cadfixer/geometry-runtime';
import { ConversionVerdict } from '@cadfixer/file-formats';
import { LengthUnit } from '@cadfixer/shared';
import { ConvertDialog } from './ConvertDialog';
import { GeometryClientProvider } from '../runtime/client-context';
import { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from '../state/store-context';
import { WorkspaceStore } from '../state/workspace-store';
import { CONVERSION_FORBIDDEN_TERMS, UNIT_CHOICES } from '../state/conversion-presentation';
import type { LoadedModel } from '../state/model';

/**
 * THE EXPORT / CONVERT DIALOG, at component level.
 *
 * The happy path is proven end to end against real workers, where a download is
 * a download. What is worth testing here is what the dialog SAYS and what it
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

function renderDialog(configure: (store: WorkspaceStore) => void): WorkspaceStore {
  const store = new WorkspaceStore();
  configure(store);
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <ConvertDialog />
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
  return store;
}

/* ------------------------------------------------------------- CF18/CF22 -- */

describe('opening and choosing a target', () => {
  it('renders nothing at all until it is opened', () => {
    renderDialog((store) => {
      loadModel(store);
    });
    expect(screen.queryByTestId('convert-dialog')).toBeNull();
  });

  it('renders nothing when there is no model to convert', () => {
    renderDialog((store) => {
      store.openConversion('stl');
    });
    expect(screen.queryByTestId('convert-dialog')).toBeNull();
  });

  it('offers exactly the three formats CAD Fixer can write', () => {
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('stl');
    });

    expect(screen.getByTestId('convert-target-stl')).toBeInTheDocument();
    expect(screen.getByTestId('convert-target-obj')).toBeInTheDocument();
    expect(screen.getByTestId('convert-target-3mf')).toBeInTheDocument();

    // NO PLACEHOLDERS FOR FORMATS THAT DO NOT EXIST. A disabled "STEP" entry
    // would be advertising a capability the product does not have.
    const targets = within(screen.getByTestId('convert-dialog')).getAllByRole('radio');
    expect(targets).toHaveLength(3);
  });

  it('preselects the source format, which bypasses no review', () => {
    renderDialog((store) => {
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
    const store = renderDialog((s) => {
      loadModel(s);
      s.openConversion('stl');
    });
    expect(store.getSnapshot().conversion.state).toBe('reviewing');
    expect(screen.queryByTestId('convert-progress')).toBeNull();
  });

  it('recomputes the summary when the target changes', () => {
    renderDialog((store) => {
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
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('stl');
    });

    expect(screen.getByTestId('convert-lossless')).toBeInTheDocument();
    expect(screen.queryByTestId('convert-structure')).toBeNull();
    expect(screen.queryByTestId('convert-metadata')).toBeNull();
    expect(screen.queryByTestId('convert-blockers')).toBeNull();
  });

  it('separates metadata loss from structural loss', () => {
    renderDialog((store) => {
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
    renderDialog((store) => {
      loadModel(store, { formatId: '3mf', unit: LengthUnit.Inch });
      store.openConversion('obj');
    });

    const metadata = screen.getByTestId('convert-metadata');
    expect(metadata).toHaveTextContent('written unchanged');
    expect(metadata).toHaveTextContent('nothing is resized');
  });

  it('shows a blocker as a requirement rather than as a failure', () => {
    renderDialog((store) => {
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
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('stl');
    });

    const dialog = screen.getByTestId('convert-dialog');
    expect(dialog).not.toHaveTextContent('merged into one mesh');
    expect(dialog).not.toHaveTextContent('texture coordinates');
    expect(dialog).not.toHaveTextContent('face group');
  });

  it('never emits a forbidden claim, whatever the document', () => {
    renderDialog((store) => {
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

    const text = screen.getByTestId('convert-dialog').textContent.toLowerCase();
    for (const term of CONVERSION_FORBIDDEN_TERMS) {
      expect(text.includes(term), `"${term}" reached the screen`).toBe(false);
    }
  });
});

/* ----------------------------------------------------------- CF13 / CF36 -- */

describe('source import warnings', () => {
  it('shows them in their own section, apart from the target losses', () => {
    renderDialog((store) => {
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
    renderDialog((store) => {
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
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    expect(screen.queryByTestId('convert-source-warnings')).toBeNull();
  });
});

/* --------------------------------------------------------------- CF14/CF15 -- */

describe('the unit selection', () => {
  function openUnitCase(): WorkspaceStore {
    return renderDialog((store) => {
      loadModel(store);
      store.openConversion('3mf');
    });
  }

  it('asks for a unit only when the target needs one and the document has none', () => {
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    expect(screen.queryByTestId('convert-unit')).toBeNull();

    cleanup();

    renderDialog((store) => {
      loadModel(store, { formatId: '3mf', unit: LengthUnit.Millimeter });
      store.openConversion('3mf');
    });
    expect(screen.queryByTestId('convert-unit')).toBeNull();
  });

  it('SELECTS NOTHING by default', () => {
    /*
     * THE TEST THIS FLOW MOST NEEDS. An HTML `<select>` with no explicit value
     * reports its FIRST option, so a naive control would silently assert
     * microns — CAD Fixer choosing a physical unit on the user's behalf, which
     * is precisely what this stage exists to prevent. The placeholder is a real,
     * disabled option and the store holds `undefined`.
     */
    const store = openUnitCase();
    const select = screen.getByTestId('convert-unit-select');

    expect(select).toHaveValue('');
    expect(store.getSnapshot().conversion.unitAssertion).toBeUndefined();
    // And the placeholder cannot be chosen as if it were an answer.
    const placeholder = within(select).getByRole('option', { name: /choose a unit/i });
    expect(placeholder).toBeDisabled();
  });

  it('keeps the export action unavailable until a unit is deliberately chosen', () => {
    openUnitCase();
    expect(screen.getByTestId('convert-export')).toBeDisabled();

    fireEvent.change(screen.getByTestId('convert-unit-select'), {
      target: { value: LengthUnit.Inch },
    });

    expect(screen.getByTestId('convert-export')).toBeEnabled();
  });

  it('offers exactly the six units, in the shared order', () => {
    openUnitCase();
    const select = screen.getByTestId('convert-unit-select');
    const values = within(select)
      .getAllByRole('option')
      .map((option) => option.getAttribute('value') ?? '')
      .filter((value) => value !== '');

    expect(values).toEqual(UNIT_CHOICES.map((choice) => choice.value));
    expect(values).toHaveLength(6);
  });

  it('accepts each of the six and records exactly what was chosen', () => {
    for (const choice of UNIT_CHOICES) {
      const store = openUnitCase();
      fireEvent.change(screen.getByTestId('convert-unit-select'), {
        target: { value: choice.value },
      });
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
    fireEvent.change(screen.getByTestId('convert-unit-select'), {
      target: { value: LengthUnit.Foot },
    });

    fireEvent.click(screen.getByTestId('convert-target-obj'));
    fireEvent.click(screen.getByTestId('convert-target-3mf'));

    expect(store.getSnapshot().conversion.unitAssertion).toBe(LengthUnit.Foot);
    expect(screen.getByTestId('convert-unit-select')).toHaveValue(LengthUnit.Foot);
  });
});

/* ------------------------------------------------------------------ CF25 -- */

describe('hostile display strings', () => {
  const HOSTILE = '<script>alert(1)</script>&"‮gnp.lts‬../../etc/passwd';

  it('renders a hostile filename as text and nothing else', () => {
    renderDialog((store) => {
      loadModel(store, { fileName: HOSTILE });
      store.openConversion('stl');
    });

    const source = screen.getByTestId('convert-source');
    // The characters are PRESENT, as text.
    expect(source.textContent).toContain('<script>');
    // And no element was created from them.
    expect(source.querySelector('script')).toBeNull();
    expect(screen.getByTestId('convert-dialog').querySelector('script')).toBeNull();
  });

  it('renders a hostile part name as text', () => {
    renderDialog((store) => {
      loadModel(store, {
        parts: [
          partDescriptor({ name: HOSTILE }),
          partDescriptor({ partId: 'b', meshResourceIndex: 1 }),
        ],
      });
      store.openConversion('obj');
    });

    const dialog = screen.getByTestId('convert-dialog');
    expect(dialog.querySelector('script')).toBeNull();
    /*
     * AND THE NAME IS NOT SHOWN AT ALL, because the report carries COUNTS rather
     * than names. A fact that held a part name would be a fact that could carry
     * hostile text into markup, and it would be a second place display copy
     * lived.
     */
    expect(dialog.textContent).not.toContain('alert(1)');
  });

  it('lets a very long filename wrap rather than widening the dialog', () => {
    renderDialog((store) => {
      loadModel(store, { fileName: `${'a'.repeat(400)}.stl` });
      store.openConversion('stl');
    });
    // The name is inside the source line, which the stylesheet wraps.
    expect(screen.getByTestId('convert-source').textContent).toContain('a'.repeat(100));
  });
});

/* ------------------------------------------------------------------ CF26 -- */

describe('keyboard and assistive technology', () => {
  it('is a modal dialog with an accessible name', () => {
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('stl');
    });

    const dialog = screen.getByRole('dialog', { name: 'Export / Convert' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('labels the target choices and the unit selector', () => {
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('3mf');
    });

    expect(screen.getByRole('group', { name: 'Save as' })).toBeInTheDocument();
    expect(screen.getByLabelText('These measurements are in')).toBeInTheDocument();
  });

  it('moves focus into the dialog when it opens', () => {
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    expect(document.activeElement).toBe(screen.getByTestId('convert-close'));
  });

  it('keeps Tab inside the dialog', () => {
    /*
     * `aria-modal` does not stop the Tab key, and the backdrop only hides the
     * workspace visually. Without a trap a keyboard user tabs off the end of the
     * panel onto controls they cannot see, behind an overlay they cannot dismiss
     * from there.
     */
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('stl');
    });

    const dialog = screen.getByRole('dialog');
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button, input, select')].filter(
      (element) => !element.hasAttribute('disabled'),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;

    // Forwards off the end wraps to the beginning.
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    // And backwards off the beginning wraps to the end.
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to whatever opened it', () => {
    const store = new WorkspaceStore();
    loadModel(store);
    const client = new GeometryClient({ onDiagnostic: (): void => undefined });

    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    render(
      <WorkspaceProvider store={store}>
        <GeometryClientProvider client={client}>
          <ConvertDialog />
        </GeometryClientProvider>
      </WorkspaceProvider>,
    );

    act(() => {
      store.openConversion('stl');
    });
    expect(document.activeElement).toBe(screen.getByTestId('convert-close'));

    act(() => {
      store.closeConversion();
    });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('closes on Escape while nothing irreversible is happening', () => {
    const store = renderDialog((s) => {
      loadModel(s);
      s.openConversion('stl');
    });

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(store.getSnapshot().conversion.state).toBe('closed');
  });

  it('announces the outcome in a live region', () => {
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('stl');
      const token = store.beginConversion();
      store.completeConversion(token, {
        fileName: 'part.stl',
        byteLength: 284,
        target: 'stl',
        triangleCount: 4,
        partCount: 1,
      });
    });

    const saved = screen.getByTestId('convert-saved');
    expect(saved.closest('[aria-live]')).not.toBeNull();
    expect(saved).toHaveTextContent('read back and checked');
  });

  it('does not rely on colour alone: every section states its meaning in words', () => {
    renderDialog((store) => {
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
    renderDialog((store) => {
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
    const store = renderDialog((s) => {
      loadModel(s);
      s.openConversion('stl');
    });
    expect(screen.queryByTestId('convert-cancel')).toBeNull();

    act(() => {
      store.beginConversion();
    });
    expect(screen.getByTestId('convert-cancel')).toBeInTheDocument();
  });

  it('refuses to close mid-write, so a cancel cannot be mistaken for a finish', () => {
    /*
     * ESCAPE IS INERT DURING A WRITE, ON PURPOSE. An accidental Escape that
     * silently killed the worker would look exactly like a finished export that
     * produced no file. Cancel is a labelled button, pressed deliberately.
     */
    const store = renderDialog((s) => {
      loadModel(s);
      s.openConversion('stl');
      s.beginConversion();
    });

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(store.getSnapshot().conversion.state).toBe('working');
    expect(screen.getByTestId('convert-close')).toBeDisabled();
  });

  it('stays open and usable after a failure, so the user can act on it', () => {
    const store = renderDialog((s) => {
      loadModel(s);
      s.openConversion('3mf');
      s.setConversionUnit(LengthUnit.Millimeter);
      const token = s.beginConversion();
      s.failConversion(token, { status: 'RESOURCE_LIMIT', reason: 'EXPORT_OUTPUT_TOO_LARGE' });
    });

    expect(screen.getByTestId('convert-failure')).toHaveTextContent('nothing was saved');
    // The chosen target and unit survive, so a retry does not start from scratch.
    expect(store.getSnapshot().conversion.target).toBe('3mf');
    expect(store.getSnapshot().conversion.unitAssertion).toBe(LengthUnit.Millimeter);
    expect(screen.getByTestId('convert-export')).toBeEnabled();
  });

  it('never claims a file was saved before validation succeeded', () => {
    renderDialog((store) => {
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
    renderDialog((store) => {
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
      const client = new GeometryClient({ onDiagnostic: (): void => undefined });
      render(
        <WorkspaceProvider store={store}>
          <GeometryClientProvider client={client}>
            <ConvertDialog />
          </GeometryClientProvider>
        </WorkspaceProvider>,
      );
      const text = screen.getByTestId('convert-report').textContent;
      cleanup();
      return text;
    };

    expect(readFacts('b')).toBe(readFacts('a'));
  });

  it('shows no whole-document note for a one-part document', () => {
    renderDialog((store) => {
      loadModel(store);
      store.openConversion('stl');
    });
    expect(screen.queryByTestId('convert-whole-document')).toBeNull();
  });
});
