import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentId,
  DocumentRenderSnapshot,
  PartDescriptor,
} from '@cadfixer/geometry-runtime';
import { PartSelector } from './PartSelector';
import { WorkspaceProvider } from '../state/store-context';
import { WorkspaceStore } from '../state/workspace-store';
import type { LoadedModel } from '../state/model';

/**
 * THE SMALLEST CONTROL THAT MAKES PART-TARGETED WORKFLOWS HONEST.
 *
 * Two things are worth pinning. It must render NOTHING for a single-part
 * document, because an STL user's sidebar should be exactly what it was. And it
 * must never imply a document-level verdict: parts are checked separately, and
 * nothing in the product knows whether two parts overlap each other.
 */

afterEach(cleanup);

function descriptor(partId: string, triangleCount: number, name?: string): PartDescriptor {
  return {
    partId,
    ...(name === undefined ? {} : { name }),
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount,
    vertexCount: triangleCount * 3,
    bounds: undefined,
    meshResourceIndex: 0,
  };
}

function renderSnapshot(parts: readonly PartDescriptor[]): DocumentRenderSnapshot {
  return {
    parts: parts.map((part) => ({
      partId: part.partId,
      transform: part.transform,
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      vertexCount: 3,
    })),
  };
}

function renderSelector(parts: readonly PartDescriptor[] | undefined): WorkspaceStore {
  const store = new WorkspaceStore();
  if (parts !== undefined) {
    const handle: DocumentHandle = { documentId: 'document-1' as DocumentId, revision: 1 };
    let triangles = 0;
    for (const part of parts) triangles += part.triangleCount;
    const model: Omit<LoadedModel, 'revision'> = {
      handle,
      parts,
      render: renderSnapshot(parts),
      source: {
        fileName: 'assembly.stl',
        fileBytes: 512,
        formatId: 'stl',
        encoding: 'binary',
        unit: undefined,
        importedAt: 0,
      },
      bounds: undefined,
      triangleCount: triangles,
      vertexCount: triangles * 3,
      validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
      warnings: [],
      residentBytes: 1024,
    };
    store.commitImport(store.beginImport('assembly.stl'), model);
  }

  render(
    <WorkspaceProvider store={store}>
      <PartSelector />
    </WorkspaceProvider>,
  );
  return store;
}

describe('when there is nothing to choose between', () => {
  it('renders nothing at all with no model loaded', () => {
    renderSelector(undefined);

    expect(screen.queryByTestId('part-selector')).toBeNull();
  });

  it('renders nothing for a single-part document', () => {
    // An STL produces one part. Offering a list of one would add a decision the
    // user does not have, and would change the single-part experience this
    // migration exists not to change.
    renderSelector([descriptor('part-1', 12)]);

    expect(screen.queryByTestId('part-selector')).toBeNull();
  });
});

describe('when a document has several parts', () => {
  it('lists every part, in document order', () => {
    renderSelector([descriptor('a', 4), descriptor('b', 8), descriptor('c', 2)]);

    const items = screen.getAllByRole('button');
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain('Part 1');
    expect(items[2]?.textContent).toContain('Part 3');
  });

  it('quotes the source’s name when there is one', () => {
    renderSelector([descriptor('a', 4, 'Left bracket'), descriptor('b', 8, 'Right bracket')]);

    expect(screen.getByTestId('part-option-a').textContent).toContain('Left bracket');
    expect(screen.getByTestId('part-option-b').textContent).toContain('Right bracket');
  });

  it('falls back to a positional label rather than inventing a name', () => {
    // `Part 2` is not a name the file contained, and it does not pretend to be
    // one. Anything descriptive would be information about the user's model
    // that nothing established.
    renderSelector([descriptor('a', 4, 'Named'), descriptor('b', 8)]);

    expect(screen.getByTestId('part-option-b').textContent).toContain('Part 2');
  });

  it('marks the active part and moves the mark when another is chosen', () => {
    const store = renderSelector([descriptor('a', 4), descriptor('b', 8)]);

    expect(screen.getByTestId('part-option-a')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('part-option-b')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('part-option-b'));

    expect(store.getSnapshot().activePartId).toBe('b');
    expect(screen.getByTestId('part-option-b')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('part-option-a')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows each part’s own triangle count', () => {
    renderSelector([descriptor('a', 4), descriptor('b', 1234)]);

    expect(screen.getByTestId('part-option-b').textContent).toContain('1,234');
  });

  it('says that parts are checked separately and claims nothing about overlap', () => {
    /*
     * INTER-PART OVERLAP IS NOT IMPLEMENTED, and the panel must not imply it
     * is. Two parts that intersect each other in world space are not
     * self-intersecting and nothing here has looked.
     */
    renderSelector([descriptor('a', 4), descriptor('b', 8)]);

    const note = screen.getByTestId('part-selector').textContent;
    expect(note).toContain('separately');
    expect(note).toContain('nothing here reports whether two parts overlap each other');
  });

  it('never claims a document-level verdict', () => {
    renderSelector([descriptor('a', 4), descriptor('b', 8)]);

    const text = screen.getByTestId('part-selector').textContent.toLowerCase();
    for (const banned of [
      'printable',
      'watertight',
      'valid mesh',
      'error free',
      'document healthy',
      'model healthy',
      'hole',
    ]) {
      expect(text).not.toContain(banned);
    }
  });
});
