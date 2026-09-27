import { describe, expect, it } from 'vitest';
import type { LoadedModel } from './model';
import { hasUnexportedChanges } from './unsaved-changes';
import type { MeasuredExport, WorkspaceState } from './workspace-store';

type Inputs = Parameters<typeof hasUnexportedChanges>[0];
type Handle = NonNullable<Inputs['importedHandle']>;

/** A handle from a plain id: the brand exists to stop mixing ids, not to test them. */
function handle(value: { documentId: string; revision: number }): Handle {
  return { documentId: value.documentId as Handle['documentId'], revision: value.revision };
}

/*
 * The predicate reads a model's HANDLE and nothing else of it, and only the
 * `measured` list of the conversion slice. Building whole slices for it would
 * test fixtures, not the rule, so the two are narrowed here — and only here.
 */
function state(
  current: { documentId: string; revision: number } | undefined,
  imported: { documentId: string; revision: number } | undefined,
  measured: readonly Pick<MeasuredExport, 'documentId' | 'revision'>[] = [],
): Inputs {
  return {
    model:
      current === undefined ? undefined : ({ handle: handle(current) } as unknown as LoadedModel),
    importedHandle: imported === undefined ? undefined : handle(imported),
    conversion: {
      measured: measured.map((entry) => ({
        ...entry,
        target: '3mf',
        unitAssertion: undefined,
        byteLength: 1,
      })),
    } as unknown as WorkspaceState['conversion'],
  };
}

describe('hasUnexportedChanges', () => {
  it('is false with no model: there is nothing to lose', () => {
    expect(hasUnexportedChanges(state(undefined, undefined))).toBe(false);
  });

  it('is false for a model exactly as imported: the file is still on disk', () => {
    const handle = { documentId: 'd1', revision: 1 };
    expect(hasUnexportedChanges(state(handle, handle))).toBe(false);
  });

  it('is true once an applied change moves the revision', () => {
    expect(
      hasUnexportedChanges(
        state({ documentId: 'd1', revision: 2 }, { documentId: 'd1', revision: 1 }),
      ),
    ).toBe(true);
  });

  it('is false once that exact revision has been exported', () => {
    expect(
      hasUnexportedChanges(
        state({ documentId: 'd1', revision: 2 }, { documentId: 'd1', revision: 1 }, [
          { documentId: 'd1', revision: 2 },
        ]),
      ),
    ).toBe(false);
  });

  it('is true again after a further change: the export describes the earlier revision', () => {
    expect(
      hasUnexportedChanges(
        state({ documentId: 'd1', revision: 3 }, { documentId: 'd1', revision: 1 }, [
          { documentId: 'd1', revision: 2 },
        ]),
      ),
    ).toBe(true);
  });

  it('does not credit an export of a different document at the same revision number', () => {
    expect(
      hasUnexportedChanges(
        state({ documentId: 'd2', revision: 2 }, { documentId: 'd2', revision: 1 }, [
          { documentId: 'd1', revision: 2 },
        ]),
      ),
    ).toBe(true);
  });

  it('treats an Undo as a change: it is a new revision, and the rule stays conservative', () => {
    // Imported at 1, changed at 2, undone at 3 — the geometry may equal the
    // import, but nothing proves it without comparing meshes, so it asks.
    expect(
      hasUnexportedChanges(
        state({ documentId: 'd1', revision: 3 }, { documentId: 'd1', revision: 1 }),
      ),
    ).toBe(true);
  });
});
