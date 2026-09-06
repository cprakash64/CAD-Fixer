import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppErrorCode, toAppError } from '@cadfixer/shared';
import {
  HOLE_FILL_MAX_PART_FACES,
  HoleFillStatus,
  type BoundaryLoopSummary,
  type DocumentHandle,
  type HoleFillCandidateHandle,
} from '@cadfixer/geometry-runtime';
import { HoleFillCancelled, HoleFillService } from '../runtime/hole-fill-service';
import type { HoleFillSession } from '../runtime/hole-fill-service';
import { useGeometryClient } from '../runtime/client-context';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import {
  HOLE_FILL_APPLIED_HEADLINE,
  HOLE_FILL_APPLIED_QUALIFIER,
  HOLE_FILL_CANCELLED,
  HOLE_FILL_DISCARDED,
  HOLE_FILL_UNDONE,
  HoleFillPhase,
  describeApplied,
  presentHoleFillStatus,
} from './hole-fill-presentation';
import {
  HoleFillCommitState,
  HoleFillInventoryState,
  HoleFillWorkState,
  StatusSeverity,
  type HoleBoundaryRow,
  type HoleFillFailure,
  type HoleFillToken,
} from './workspace-store';

/**
 * Binds the hole-fill service and the authoritative worker to the workspace.
 *
 * WHAT THIS OWNS: when openings are listed, when a rim is fetched, when a
 * candidate is built, when a candidate is released, and how a worker error
 * becomes a sentence.
 *
 * WHAT IT DOES NOT OWN: the transaction. Every guard that decides whether a fill
 * may become the user's geometry lives in the worker, behind a `MessagePort`,
 * and this hook cannot reach past any of them. A defect here can waste work or
 * show a wrong label; it cannot apply a candidate the runtime refused, apply one
 * twice, or apply one to the wrong part.
 *
 * LISTING IS AUTOMATIC; NOTHING ELSE IS. Enumerating a part's open boundaries is
 * read-only, allocates no candidate, mutates nothing, and is the answer the user
 * came for — making them press a button to discover whether their model has
 * openings puts a click between them and it. Previewing allocates a worker and a
 * second copy of the part; applying changes their geometry. Both are explicit.
 *
 * THE WORKER IS BUILT ONLY WHEN A PREVIEW STARTS. Opening the app, opening this
 * panel, listing openings and selecting one construct no `Worker` at all —
 * `HoleFillService.run` is the only thing that does, and nothing above calls it.
 */

export interface HoleFillControls {
  readonly selectOpening: (boundaryLoopId: string | undefined) => void;
  readonly previewFill: () => void;
  readonly cancelPreview: () => void;
  readonly discardPreview: () => void;
  readonly applyFill: () => void;
  readonly undoLastFill: () => void;
  readonly refreshOpenings: () => void;
  readonly isBusy: boolean;
  /** True when the active part is above the engine's face ceiling. */
  readonly partTooLarge: boolean;
}

export function useHoleFillWorkflow(): HoleFillControls {
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const { model, activePartId, holeFill } = useWorkspaceState();

  /**
   * The fill controller, created once per client.
   *
   * A `HoleFillService` OWNS NOTHING UNTIL `run` IS CALLED — no worker, no
   * channel, no operation — so building one is an object allocation and
   * constructs no `Worker`. `useMemo` rather than a ref written during render,
   * because a ref assignment in the render body is a side effect React is
   * entitled to run twice; the disposal effect below is what releases whatever
   * a run left behind.
   */
  const service = useMemo(
    () => (client === undefined ? undefined : new HoleFillService(client)),
    [client],
  );

  const sessionRef = useRef<HoleFillSession | undefined>(undefined);
  const activeTokenRef = useRef<HoleFillToken | undefined>(undefined);

  /**
   * The candidate this hook is responsible for releasing.
   *
   * Held in a ref rather than read from the store at cleanup time: an effect
   * cleanup runs after the state that triggered it has already changed, so by
   * then the store no longer knows what there was to release.
   */
  const liveCandidateRef = useRef<HoleFillCandidateHandle | undefined>(undefined);

  /* ------------------------------------------------------------- release -- */

  const releaseCandidate = useCallback(
    (handle: HoleFillCandidateHandle | undefined): void => {
      if (handle === undefined) return;
      if (liveCandidateRef.current?.candidateId === handle.candidateId) {
        liveCandidateRef.current = undefined;
      }
      if (client === undefined) return;
      client.discardHoleFillCandidate(handle).promise.catch((cause: unknown) => {
        /*
         * A candidate the worker has already released, or one that died with the
         * worker, is not a fault: the release is best-effort cleanup of memory
         * the user never owned. Recorded rather than swallowed, and never
         * surfaced as an error, because there is no action a user could take.
         */
        const error = toAppError(cause);
        if (error.code === AppErrorCode.ModelUnavailable) return;
        store.pushStatus(
          StatusSeverity.Info,
          `A discarded fill preview could not be released: ${error.message}`,
        );
      });
    },
    [client, store],
  );

  /* ------------------------------------------------------------- listing -- */

  const listOpenings = useCallback(
    (handle: DocumentHandle, partId: string): void => {
      if (client === undefined) return;
      const token = store.beginHoleFillListing(handle, partId);

      client.listBoundaryLoops(handle, partId).promise.then(
        (result) => {
          store.commitHoleFillListing(token, {
            handle: result.handle,
            partId: result.partId,
            loopCount: result.loopCount,
            rows: toRows(result.loops),
            truncated: result.truncated,
            partFaceCount: result.partFaceCount,
          });
        },
        (cause: unknown) => {
          const failure = describeFailure(cause);
          store.failHoleFillListing(token, failure);
          // Not announced in the status log: the panel explains it in place,
          // beside the list it concerns, and a second copy would be noise for
          // something the user is already looking at.
        },
      );
    },
    [client, store],
  );

  /**
   * Lists once per (model revision, part).
   *
   * Keyed and guarded by a ref because `StrictMode` runs effects twice in
   * development, and because a re-render from an unrelated status message must
   * not re-dispatch a listing. The key includes the REVISION, so every applied
   * fill, repair or undo re-lists automatically — which is what makes the
   * inventory a fact about the current document rather than a cached number
   * somebody has to remember to decrement.
   */
  const listedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (model === undefined || client === undefined || activePartId === undefined) {
      listedForRef.current = undefined;
      return;
    }
    const key = `${model.handle.documentId}@${String(model.handle.revision)}/${activePartId}`;
    if (listedForRef.current === key) return;
    listedForRef.current = key;
    listOpenings(model.handle, activePartId);
  }, [activePartId, client, listOpenings, model]);

  /**
   * Releases the candidate when the workflow is abandoned.
   *
   * Keyed on the model IDENTITY, so an applied fill — which changes the revision
   * but not the document — does not trip it, while importing a different file
   * does. A candidate holds a second copy of a part in the worker; leaving one
   * alive because the user opened another file would be an invisible leak
   * proportional to the model's size.
   */
  useEffect(() => {
    const documentId = model?.handle.documentId;
    return (): void => {
      const live = liveCandidateRef.current;
      if (live === undefined) return;
      if (live.documentId === documentId) return;
      releaseCandidate(live);
    };
  }, [model?.handle.documentId, releaseCandidate]);

  // Unmount: kill the worker and release whatever is still held.
  useEffect(() => {
    return (): void => {
      sessionRef.current?.cancel();
      sessionRef.current = undefined;
      service?.dispose();
      releaseCandidate(liveCandidateRef.current);
    };
  }, [releaseCandidate, service]);

  /**
   * Drops everything when the model goes away.
   *
   * Worker loss clears the store's slice on its own; this stops the hook from
   * believing it still owns something to release, and cancels a session that can
   * no longer produce anything usable.
   */
  useEffect(() => {
    if (model !== undefined) return;
    sessionRef.current?.cancel();
    sessionRef.current = undefined;
    liveCandidateRef.current = undefined;
  }, [model]);

  /* ----------------------------------------------------------- selection -- */

  const selectOpening = useCallback(
    (boundaryLoopId: string | undefined): void => {
      // A selection change abandons any fill in flight: the candidate being
      // built closes a DIFFERENT opening from the one now highlighted.
      sessionRef.current?.cancel();
      sessionRef.current = undefined;
      const dropped = store.selectBoundaryLoop(boundaryLoopId);
      if (dropped !== undefined) releaseCandidate(dropped.candidate);
    },
    [releaseCandidate, store],
  );

  /**
   * Fetches the rim for whatever is selected.
   *
   * ONLY THE SELECTED OPENING'S GEOMETRY EVER TRAVELS. The listing is scalar; a
   * ring of points crosses the boundary for one opening at a time, and only
   * because the user asked to look at it. Listing every rim for a model with
   * twenty thousand openings would move megabytes to draw one.
   */
  useEffect(() => {
    if (client === undefined || model === undefined || activePartId === undefined) return;
    const selected = holeFill.selectedLoopId;
    if (selected === undefined) return;
    if (holeFill.rim?.boundaryLoopId === selected) return;

    const handle = model.handle;
    let abandoned = false;
    client.previewBoundaryLoop(handle, activePartId, selected).promise.then(
      (result) => {
        if (abandoned) return;
        store.installBoundaryRim({
          boundaryLoopId: result.boundaryLoopId,
          partId: result.partId,
          source: result.handle,
          positions: result.positions,
          edgeCount: result.edgeCount,
        });
      },
      (cause: unknown) => {
        if (abandoned) return;
        /*
         * A RIM THAT CANNOT BE DRAWN IS NOT A WORKFLOW FAILURE. The opening is
         * still listed, still described, and — if eligible — still fillable;
         * only the highlight is missing. Recorded so it is not silent, and not
         * raised as an error the user has to dismiss.
         */
        const error = toAppError(cause);
        if (error.code === AppErrorCode.OperationCancelled) return;
        store.pushStatus(
          StatusSeverity.Info,
          `The selected opening could not be highlighted: ${error.message}`,
        );
      },
    );
    return (): void => {
      abandoned = true;
    };
  }, [activePartId, client, holeFill.rim?.boundaryLoopId, holeFill.selectedLoopId, model, store]);

  /* ----------------------------------------------------------- candidate -- */

  const previewFill = useCallback((): void => {
    if (service === undefined || client === undefined) return;
    if (model === undefined || activePartId === undefined) return;
    const selected = holeFill.selectedLoopId;
    if (selected === undefined) return;

    const row = holeFill.inventory.rows.find((entry) => entry.boundaryLoopId === selected);
    if (row?.fillable !== true) return;

    // At most one candidate is ever resident. The worker enforces this too — the
    // store supersedes an earlier candidate on `create` — but releasing here is
    // what frees the memory promptly rather than at the next fill.
    releaseCandidate(liveCandidateRef.current);

    const handle = model.handle;
    const token = store.beginHoleFillCandidate(handle, activePartId, selected);
    if (token === undefined) return;
    activeTokenRef.current = token;

    const session = service.run({
      handle,
      partId: activePartId,
      boundaryLoopId: selected,
      onStarted: () => {
        // THE ONLY PHASE THE OPERATION ACTUALLY REPORTS. Everything after this
        // is one synchronous pass in a worker that cannot report from inside
        // itself, so the interface says "building" and shows an indeterminate
        // indicator rather than a fraction nobody measured.
        store.reportHoleFillPhase(token, HoleFillPhase.Building);
      },
    });
    sessionRef.current = session;

    session.promise.then(
      (outcome) => {
        sessionRef.current = undefined;

        /*
         * A RESULT IS NOT A CANDIDATE. Every status except `VALID_CANDIDATE`
         * means no geometry exists to apply — including the refusals, which are
         * correct answers rather than failures, and the validation rejections,
         * which are the hard gate doing its job. The model is untouched in all
         * of them.
         */
        if (outcome.status !== HoleFillStatus.ValidCandidate || outcome.candidate === undefined) {
          const presented = presentHoleFillStatus(outcome.status);
          store.failHoleFillCandidate(token, {
            message: `${presented.headline}. ${presented.detail}`,
            code: outcome.status,
            retryable: presented.retryable,
          });
          return;
        }

        const candidate = outcome.candidate;
        const installed = store.commitHoleFillCandidate(token, {
          candidate,
          source: handle,
          partId: activePartId,
          boundaryLoopId: selected,
          summary: outcome.summary,
          patchPositions: undefined,
          patchNormals: undefined,
          patchTriangleCount: 0,
        });

        if (!installed) {
          // The workflow moved on while this was being built. The candidate is
          // real and worker-resident, so it is released rather than abandoned.
          releaseCandidate(candidate);
          return;
        }
        liveCandidateRef.current = candidate;

        /*
         * THE PATCH SNAPSHOT, fetched from the STORED candidate.
         *
         * Not recomputed, not re-triangulated, not reconstructed from the
         * summary: the worker reads the faces out of the very mesh Apply will
         * install. That is what makes "what you previewed is what was applied"
         * a structural fact rather than an intention.
         */
        client.previewHoleFillPatch(candidate).promise.then(
          (patch) => {
            store.installPatchPreview(candidate.candidateId, {
              positions: patch.positions,
              normals: patch.normals,
              triangleCount: patch.triangleCount,
            });
          },
          (cause: unknown) => {
            const error = toAppError(cause);
            if (error.code === AppErrorCode.OperationCancelled) return;
            store.pushStatus(
              StatusSeverity.Info,
              `The fill preview could not be drawn: ${error.message}`,
            );
          },
        );
      },
      (cause: unknown) => {
        sessionRef.current = undefined;
        activeTokenRef.current = undefined;
        if (cause instanceof HoleFillCancelled) {
          /*
           * THE ACKNOWLEDGEMENT. The worker was terminated and the authoritative
           * operation cancelled, so the work has genuinely stopped and nothing
           * was published. Only now may the panel say `Cancelled`.
           */
          if (!store.cancelHoleFillCandidate(token)) return;
          store.pushStatus(StatusSeverity.Info, HOLE_FILL_CANCELLED);
          return;
        }
        const error = toAppError(cause);
        if (error.code === AppErrorCode.OperationCancelled) {
          if (!store.cancelHoleFillCandidate(token)) return;
          store.pushStatus(StatusSeverity.Info, HOLE_FILL_CANCELLED);
          return;
        }
        const failure = describeFailure(cause);
        if (!store.failHoleFillCandidate(token, failure)) return;
        store.pushStatus(StatusSeverity.Error, failure.message);
      },
    );
  }, [
    activePartId,
    client,
    holeFill.inventory.rows,
    holeFill.selectedLoopId,
    model,
    releaseCandidate,
    service,
    store,
  ]);

  const cancelPreview = useCallback((): void => {
    const token = activeTokenRef.current;
    if (token !== undefined) store.beginHoleFillCancellation(token);
    // TERMINATION, not a polled flag. The fill is one synchronous pass through
    // exact C++ predicates that read nothing of ours, so the worker is killed —
    // and the authoritative operation is cancelled with it, because that side is
    // awaiting a channel a dead worker will never answer.
    sessionRef.current?.cancel();
    sessionRef.current = undefined;
  }, [store]);

  const discardPreview = useCallback((): void => {
    sessionRef.current?.cancel();
    sessionRef.current = undefined;
    const dropped = store.clearHoleFillCandidate();
    if (dropped !== undefined) {
      releaseCandidate(dropped.candidate);
      // DISCARD IS NOT UNDO, and the wording says so: nothing was applied, so
      // there is nothing to reverse.
      store.pushStatus(StatusSeverity.Info, HOLE_FILL_DISCARDED);
    }
  }, [releaseCandidate, store]);

  /* -------------------------------------------------------------- commit -- */

  const applyFill = useCallback((): void => {
    if (client === undefined || model === undefined) return;
    const preview = holeFill.candidate;
    if (preview === undefined) return;

    // The first of two independent defences against a double apply. The second
    // is in the worker, which refuses to commit a consumed candidate.
    if (!store.beginHoleFillCommit()) return;

    const displayIndex =
      holeFill.inventory.rows.find((row) => row.boundaryLoopId === preview.boundaryLoopId)
        ?.displayIndex ?? 1;

    client
      .commitHoleFill({
        candidate: preview.candidate,
        expectedSource: preview.source,
        // STATED BY THE CALLER, never read off the candidate: a guard that
        // compares the candidate with itself is vacuous.
        expectedPart: preview.partId,
        expectedLoopId: preview.boundaryLoopId,
      })
      .promise.then(
        (result) => {
          // The candidate is now the model. The worker released its second
          // reference at commit, so this hook forgets it rather than discarding
          // it — discarding a committed candidate is a typed error, correctly.
          liveCandidateRef.current = undefined;

          const applied = store.applyHoleFillResult({
            handle: result.handle,
            parentRevision: result.parentRevision,
            recordId: result.recordId,
            partId: result.partId,
            boundaryLoopId: result.boundaryLoopId,
            patchFaceCount: result.patchFaceCount,
            undoable: result.undoable,
            render: result.render,
            parts: result.parts,
            bounds: result.bounds,
            triangleCount: result.triangleCount,
            vertexCount: result.vertexCount,
            residentBytes: result.residentBytes,
          });

          /*
           * THE DIVERGENCE CASE. The worker committed — the user's geometry
           * really did change — but the workspace could not install the result,
           * because the model it belongs to is no longer the one loaded.
           * Returning quietly would leave `commitState` at `Applying` forever,
           * freezing Apply, Discard and Undo behind an operation that has
           * already finished.
           */
          if (!applied) {
            store.failHoleFillCommit({
              message:
                'The fill was applied, but the model it belongs to is no longer open. Re-open that file to see the filled version.',
              code: AppErrorCode.ModelUnavailable,
              retryable: false,
            });
            return;
          }
          store.pushStatus(
            StatusSeverity.Success,
            describeApplied(displayIndex, result.patchFaceCount),
          );
        },
        (cause: unknown) => {
          const failure = describeFailure(cause);
          store.failHoleFillCommit(failure);
          store.pushStatus(StatusSeverity.Error, `The fill was not applied: ${failure.message}`);
          /*
           * A REFUSED APPLY DISCARDS THE PREVIEW, because every reason it can be
           * refused makes it permanently unusable: the revision moved, the
           * candidate was consumed, the part changed. Leaving an Apply button on
           * screen that can only fail again is worse than clearing it and saying
           * why.
           */
          const dropped = store.clearHoleFillCandidate();
          if (dropped !== undefined) releaseCandidate(dropped.candidate);
        },
      );
  }, [client, holeFill.candidate, holeFill.inventory.rows, model, releaseCandidate, store]);

  /* ---------------------------------------------------------------- undo -- */

  const undoLastFill = useCallback((): void => {
    if (client === undefined || model === undefined) return;
    const applied = holeFill.lastApplied;
    if (applied?.undoable !== true) return;
    if (!store.beginHoleFillUndo()) return;

    client
      .undoRepair(model.handle, applied.recordId, () => {
        // The undo is a truncation and a buffer rebuild; it reports no phases
        // worth showing, and inventing one would be a fabricated measurement.
      })
      .promise.then(
        (result) => {
          const restored = store.applyUndoResult({
            handle: result.handle,
            partId: result.partId,
            render: result.render,
            parts: result.parts,
            bounds: result.bounds,
            triangleCount: result.triangleCount,
            vertexCount: result.vertexCount,
            residentBytes: result.residentBytes,
          });

          if (!restored) {
            store.failHoleFillUndo({
              message:
                'The fill was undone, but the model it belongs to is no longer open. Re-open that file to see the restored version.',
              code: AppErrorCode.ModelUnavailable,
              retryable: false,
            });
            return;
          }
          store.pushStatus(StatusSeverity.Success, HOLE_FILL_UNDONE);
        },
        (cause: unknown) => {
          const failure = describeFailure(cause);
          store.failHoleFillUndo(failure);
          store.pushStatus(
            StatusSeverity.Error,
            `The fill could not be undone: ${failure.message}`,
          );
        },
      );
  }, [client, holeFill.lastApplied, model, store]);

  const refreshOpenings = useCallback((): void => {
    if (model === undefined || activePartId === undefined) return;
    listedForRef.current = undefined;
    listOpenings(model.handle, activePartId);
  }, [activePartId, listOpenings, model]);

  return {
    selectOpening,
    previewFill,
    cancelPreview,
    discardPreview,
    applyFill,
    undoLastFill,
    refreshOpenings,
    isBusy:
      holeFill.inventory.state === HoleFillInventoryState.Listing ||
      holeFill.workState === HoleFillWorkState.Generating ||
      holeFill.workState === HoleFillWorkState.Cancelling ||
      holeFill.commitState !== HoleFillCommitState.Idle,
    partTooLarge:
      holeFill.inventory.state === HoleFillInventoryState.Ready &&
      holeFill.inventory.partFaceCount > HOLE_FILL_MAX_PART_FACES,
  };
}

/**
 * Turns the worker's loop summaries into rows.
 *
 * THE DISPLAY INDEX IS ASSIGNED HERE AND NOWHERE ELSE, from the order the worker
 * produced — which `extractBoundaryLoops` guarantees is deterministic for a
 * given mesh: components are keyed by their smallest welded vertex id and sorted
 * by it. So "Opening 3" is the same opening on every listing of the same
 * geometry, and it never depends on which request finished first.
 */
function toRows(loops: readonly BoundaryLoopSummary[]): readonly HoleBoundaryRow[] {
  return loops.map((loop, index) => ({
    boundaryLoopId: loop.boundaryLoopId,
    displayIndex: index + 1,
    vertexCount: loop.vertexCount,
    edgeCount: loop.edgeCount,
    fillable: loop.fillable,
    refusal: loop.refusal,
  }));
}

/**
 * Turns a worker error into something a user can act on.
 *
 * A stale or lifecycle refusal is singled out because it is NOT a generic
 * failure and must not read like one: the model is intact, nothing was applied,
 * and the advice is to prepare a fresh preview rather than to report a bug.
 */
function describeFailure(cause: unknown): HoleFillFailure {
  const error = toAppError(cause);
  if (error.code === AppErrorCode.ModelUnavailable) {
    return {
      message: `${error.message} Choose the opening again to prepare a fresh preview.`,
      code: error.code,
      retryable: true,
    };
  }
  return {
    message: error.message,
    code: error.code,
    // A lifecycle refusal (already applied, already discarded, wrong part) will
    // refuse identically next time; a transient failure is worth retrying.
    retryable: error.code !== AppErrorCode.InvalidState,
  };
}

export { HOLE_FILL_APPLIED_HEADLINE, HOLE_FILL_APPLIED_QUALIFIER };
