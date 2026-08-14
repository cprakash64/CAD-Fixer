import { createContext, useContext, type ReactNode } from 'react';
import { internalError } from '@cadfixer/shared';
import type { GeometryClient } from './geometry-client';

/**
 * Supplies the shared geometry worker to the component tree.
 *
 * The client is created OUTSIDE React and passed in, rather than constructed in
 * an effect or a lazy `useState` initialiser. Both of those are wrong here:
 *
 * - A lazy `useState` initialiser runs twice under `StrictMode`, so it would
 *   construct two `Worker`s and orphan one — a leaked thread in development.
 * - Creating it in an effect means the first render has no client, which forces
 *   a state update from inside the effect purely to publish it.
 *
 * A worker whose lifetime is the application's lifetime does not belong to any
 * component, so it is owned by the entry point (`main.tsx`) and injected. Tests
 * supply their own, which is also how they avoid needing a real worker.
 */

const ClientContext = createContext<GeometryClient | undefined>(undefined);

export interface GeometryClientProviderProps {
  /** `undefined` is legal and means the worker is unavailable in this context. */
  readonly client: GeometryClient | undefined;
  readonly children: ReactNode;
}

export function GeometryClientProvider({
  client,
  children,
}: GeometryClientProviderProps): ReactNode {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

/**
 * Returns the shared client, or `undefined` when none was provided.
 *
 * Callers must handle `undefined` rather than assuming one exists.
 */
export function useGeometryClient(): GeometryClient | undefined {
  return useContext(ClientContext);
}

export function useRequiredGeometryClient(): GeometryClient {
  const client = useGeometryClient();
  if (client === undefined) {
    throw internalError('The geometry worker is not available.');
  }
  return client;
}
