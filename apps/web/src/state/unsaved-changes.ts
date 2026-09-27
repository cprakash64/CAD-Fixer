import type { WorkspaceState } from './workspace-store';

/**
 * Whether leaving the page now would discard applied work that exists nowhere
 * else (PR-01).
 *
 * CAD Fixer is session-only: geometry lives in a worker, nothing is persisted,
 * and a reload starts empty. That is fine for a model the user has only looked
 * at — the file is still on their disk — and not fine for one they have
 * repaired, split, textured or filled and not yet exported.
 *
 * DERIVED, NEVER STORED. True when a model is loaded, its revision is not the
 * one it was imported at, and no whole-document export (the Convert workspace,
 * which Split's export also uses) was written from that exact revision. Every
 * applied change, and every Undo, produces a new revision, so an Undo back to
 * the imported geometry still counts as unexported — conservative, and never
 * the other way round. A single-part STL export does not count: it may leave
 * parts out.
 */
export function hasUnexportedChanges(
  state: Pick<WorkspaceState, 'model' | 'importedHandle' | 'conversion'>,
): boolean {
  const model = state.model;
  if (model === undefined) return false;
  const { documentId, revision } = model.handle;
  const imported = state.importedHandle;
  if (imported?.documentId === documentId && imported.revision === revision) return false;
  return !state.conversion.measured.some(
    (entry) => entry.documentId === documentId && entry.revision === revision,
  );
}
