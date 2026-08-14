import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { internalError } from '@cadfixer/shared';
import type { WorkspaceState, WorkspaceStore } from './workspace-store';

/**
 * React binding for the framework-free workspace store.
 *
 * `useSyncExternalStore` is the supported way to read an external store in
 * React 19 without tearing during concurrent rendering, and it keeps the store
 * itself free of React imports.
 */

const StoreContext = createContext<WorkspaceStore | undefined>(undefined);

export function WorkspaceProvider({
  store,
  children,
}: {
  readonly store: WorkspaceStore;
  readonly children: ReactNode;
}): ReactNode {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useWorkspaceStore(): WorkspaceStore {
  const store = useContext(StoreContext);
  if (store === undefined) {
    throw internalError('useWorkspaceStore was called outside a WorkspaceProvider.');
  }
  return store;
}

export function useWorkspaceState(): WorkspaceState {
  const store = useWorkspaceStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
