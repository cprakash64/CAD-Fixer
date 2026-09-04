import { useCallback, useEffect, useRef } from 'react';
import {
  SelfIntersectionBand,
  SelfIntersectionPhase,
  SelfIntersectionStatus,
} from '@cadfixer/mesh-self-intersection';
import { toAppError } from '@cadfixer/shared';
import { useGeometryClient } from '../runtime/client-context';
import {
  SelfIntersectionCancelled,
  SelfIntersectionService,
  type SelfIntersectionSession,
} from '../runtime/self-intersection-service';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import type { SelfIntersectionToken } from './workspace-store';

/**
 * DRIVES THE SELF-INTERSECTION DIAGNOSTIC.
 *
 * REACT IS NOT THE AUTHORITY HERE, and that is deliberate. The hook decides
 * WHEN to ask and renders WHAT came back; the store owns which model a result
 * belongs to, and the worker owns the geometry. Every publish is guarded by a
 * token AND a handle in the store, so a result that arrives after the model
 * changed is discarded rather than shown beside geometry it never described.
 *
 * ONE CHECK AT A TIME, per workspace. Starting a second disposes the first:
 * two concurrent diagnostics would race to publish into one slot and the
 * loser's answer would be indistinguishable from the winner's.
 */

export interface SelfIntersectionControls {
  /** True when the model's size band allows an explicit check to be offered. */
  readonly canCheck: boolean;
  /** True while a check is scheduled, running or being cancelled. */
  readonly isBusy: boolean;
  runCheck: () => void;
  cancelCheck: () => void;
}

export function useSelfIntersection(): SelfIntersectionControls {
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const { model, activePartId, selfIntersection } = useWorkspaceState();

  const serviceRef = useRef<SelfIntersectionService | undefined>(undefined);
  const sessionRef = useRef<SelfIntersectionSession | undefined>(undefined);
  const tokenRef = useRef<SelfIntersectionToken | undefined>(undefined);

  /**
   * The service is created lazily and ONLY when a check actually runs.
   *
   * That laziness is the whole point of the worker being disposable: a user who
   * never triggers a check never constructs a worker and never downloads the
   * ~1.2 MB kernel it would import.
   */
  const service = useCallback((): SelfIntersectionService | undefined => {
    // No client means no worker runtime; there is nothing to ask.
    if (client === undefined) return undefined;
    serviceRef.current ??= new SelfIntersectionService(client);
    return serviceRef.current;
  }, [client]);

  const start = useCallback(
    (auto: boolean): void => {
      if (model === undefined || activePartId === undefined) return;
      const token = store.beginSelfIntersection(model.handle, activePartId, auto);
      if (token === undefined) return;
      tokenRef.current = token;

      const active = service();
      if (active === undefined) return;
      const session = active.run({
        handle: model.handle,
        partId: activePartId,
        onStarted: (faceCount) => {
          store.reportSelfIntersectionStarted(token, faceCount);
        },
      });
      sessionRef.current = session;

      session.promise.then(
        (report) => {
          sessionRef.current = undefined;
          tokenRef.current = undefined;
          // The store re-checks handle AND revision; a stale answer lands nowhere.
          store.completeSelfIntersection(token, report);
        },
        (cause: unknown) => {
          sessionRef.current = undefined;
          tokenRef.current = undefined;
          if (cause instanceof SelfIntersectionCancelled) {
            // Cancellation is not failure and must never read as one.
            store.failSelfIntersection(
              token,
              SelfIntersectionStatus.Cancelled,
              'The check was cancelled.',
            );
            return;
          }
          store.failSelfIntersection(
            token,
            SelfIntersectionStatus.InternalFailure,
            toAppError(cause).message,
          );
        },
      );
    },
    [activePartId, model, service, store],
  );

  /**
   * AUTOMATIC SCHEDULING for small models.
   *
   * Guarded by `autoScheduled` in the store rather than by an effect
   * dependency: React re-runs effects for reasons that have nothing to do with
   * the model, and a diagnostic that restarted on every re-render would burn a
   * worker each time. One authoritative revision schedules at most one
   * automatic run FOR THE ACTIVE PART; an explicit retry after failure is a
   * separate, deliberate act.
   *
   * THE ACTIVE PART ONLY. A hundred-part document must not launch a hundred
   * kernels because a file was opened. Switching parts re-binds the slice, and
   * the new part becomes eligible for its own single automatic run — which is
   * how a user still gets an answer for what they are actually looking at.
   *
   * Deferred so the model becomes usable first. Import, first render and Mesh
   * Health must not wait for a check that can take a second.
   */
  useEffect(() => {
    if (model === undefined || activePartId === undefined) return;
    if (selfIntersection.band !== SelfIntersectionBand.AutoEligible) return;
    if (selfIntersection.autoScheduled) return;
    if (selfIntersection.phase !== SelfIntersectionPhase.Idle) return;
    if (!sameHandle(selfIntersection.handle, model.handle)) return;
    if (selfIntersection.partId !== activePartId) return;

    const scheduled = setTimeout(() => {
      start(true);
    }, 0);
    return (): void => {
      clearTimeout(scheduled);
    };
  }, [
    activePartId,
    model,
    selfIntersection.band,
    selfIntersection.autoScheduled,
    selfIntersection.phase,
    selfIntersection.handle,
    selfIntersection.partId,
    start,
  ]);

  /**
   * A model OR PART change disposes any in-flight diagnostic: its answer
   * describes a mesh the user is no longer looking at.
   */
  useEffect(() => {
    return (): void => {
      sessionRef.current?.cancel();
      sessionRef.current = undefined;
    };
  }, [model?.handle.documentId, model?.handle.revision, activePartId]);

  /** Unmount releases the worker and its channel. */
  useEffect(() => {
    return (): void => {
      serviceRef.current?.dispose();
      serviceRef.current = undefined;
    };
  }, []);

  const runCheck = useCallback((): void => {
    start(false);
  }, [start]);

  const cancelCheck = useCallback((): void => {
    const token = tokenRef.current;
    if (token !== undefined) store.beginSelfIntersectionCancellation(token);
    sessionRef.current?.cancel();
  }, [store]);

  const isBusy =
    selfIntersection.phase === SelfIntersectionPhase.Scheduled ||
    selfIntersection.phase === SelfIntersectionPhase.Running ||
    selfIntersection.phase === SelfIntersectionPhase.Cancelling;

  return {
    canCheck:
      model !== undefined &&
      activePartId !== undefined &&
      selfIntersection.band !== SelfIntersectionBand.SizeLimit &&
      !isBusy,
    isBusy,
    runCheck,
    cancelCheck,
  };
}

function sameHandle(
  a: { documentId: string; revision: number } | undefined,
  b: { documentId: string; revision: number } | undefined,
): boolean {
  if (a === undefined || b === undefined) return false;
  return a.documentId === b.documentId && a.revision === b.revision;
}
