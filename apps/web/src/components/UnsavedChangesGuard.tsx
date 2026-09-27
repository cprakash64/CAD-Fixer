import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useWorkspaceStore } from '../state/store-context';
import { hasUnexportedChanges } from '../state/unsaved-changes';

/**
 * Asks before the page unloads while applied work exists nowhere else (PR-01).
 *
 * CAD Fixer keeps no copy of a model: a refresh, a closed tab or a back-swipe
 * discards whatever has been repaired, split, textured or filled since the
 * last whole-document export. The browser's own "Leave site?" prompt is the
 * one safeguard that costs nothing when there is nothing to lose — it is
 * attached ONLY while `hasUnexportedChanges` holds, so an untouched or
 * exported model never prompts.
 *
 * Renders nothing, and subscribes to one boolean: the rest of the shell does
 * not re-render on the store's every change because of it.
 */
export function UnsavedChangesGuard(): ReactNode {
  const store = useWorkspaceStore();
  const unsaved = useSyncExternalStore(store.subscribe, () =>
    hasUnexportedChanges(store.getSnapshot()),
  );

  useEffect(() => {
    if (!unsaved) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      // The browser shows its own wording; a custom message is ignored.
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return (): void => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [unsaved]);

  return null;
}
