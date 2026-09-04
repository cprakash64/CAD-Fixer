import { useEffect, useRef, type ReactNode } from 'react';
import { createViewport, type ViewportHandle } from '../viewport/create-viewport';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { RepairCandidateState, RepairPreviewMode, StatusSeverity } from '../state/workspace-store';

/**
 * React owns the container element; `createViewport` owns everything inside it.
 *
 * The viewport instance is created once and kept in a ref. Model changes are
 * pushed into it imperatively rather than by recreating it, so switching models
 * does not tear down and rebuild the WebGL context.
 */
export function ViewportPanel(): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<ViewportHandle | undefined>(undefined);
  const store = useWorkspaceStore();
  const { viewportFailure, model, activePartId, analysis, overlays, repair } = useWorkspaceState();

  /**
   * The candidate the viewport may legitimately draw.
   *
   * Four conditions, all necessary. It must be READY — a building or failed
   * candidate has nothing to show. It must carry a render snapshot. It must
   * belong to the model that is actually loaded: a candidate for a model the
   * user has replaced describes geometry that is no longer on screen. And it
   * must belong to the PART that is selected — two parts share a revision, so
   * without that check a candidate for part A would be drawn in part B's frame,
   * on top of geometry it says nothing about.
   */
  const previewable =
    repair.candidateState === RepairCandidateState.Ready &&
    repair.candidate?.render !== undefined &&
    repair.candidate.source.documentId === model?.handle.documentId &&
    repair.candidate.source.revision === model.handle.revision &&
    repair.candidate.partId === activePartId
      ? repair.candidate
      : undefined;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    try {
      const viewport = createViewport(container, {
        onContextLost: () => {
          store.setViewportFailure(
            'The graphics context was lost. Reload the page to restore the viewport.',
          );
          store.pushStatus(StatusSeverity.Error, 'The 3D viewport lost its graphics context.');
        },
      });
      viewportRef.current = viewport;
      store.setViewportFailure(undefined);
      return (): void => {
        viewportRef.current = undefined;
        viewport.dispose();
      };
    } catch (cause) {
      // Surfaced, not swallowed: without WebGL the viewport genuinely cannot run.
      const message =
        cause instanceof Error
          ? `The 3D viewport could not start: ${cause.message}`
          : 'The 3D viewport could not start.';
      store.setViewportFailure(message);
      store.pushStatus(StatusSeverity.Error, message);
      return undefined;
    }
  }, [store]);

  // Depends on the model object itself, which is safe precisely because the
  // store replaces it only on a successful import — unrelated updates such as a
  // status message keep the same reference, so this does not rebuild GPU
  // buffers every time something else in the workspace changes.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;

    if (model === undefined) {
      viewport.setModel(undefined);
      return;
    }

    /*
     * The render snapshot and the part descriptors are joined here rather than
     * in the worker, because they travel for different reasons: the buffers are
     * transferred and the bounds are scalars the panel also displays. Joining by
     * part id keeps the two in step without sending either twice.
     */
    const descriptorsById = new Map(model.parts.map((part) => [part.partId, part]));

    viewport.setModel({
      parts: model.render.parts.map((part) => {
        const descriptor = descriptorsById.get(part.partId);
        return {
          partId: part.partId,
          transform: part.transform,
          positions: part.positions,
          normals: part.normals,
          center: descriptor?.bounds?.center ?? [0, 0, 0],
          radius: descriptor?.bounds?.radius ?? 1,
        };
      }),
      center: model.bounds?.center ?? [0, 0, 0],
      radius: model.bounds?.radius ?? 1,
      revision: model.revision,
    });
  }, [model]);

  /**
   * Points the overlay, preview and change-overlay frame at the active part.
   *
   * SEPARATE FROM THE MODEL EFFECT, and that separation is the whole point. A
   * selection change is not a model change: routing it through `setModel`
   * disposed and re-uploaded every part's GPU geometry on a click — four
   * uploads for a two-part document where two were correct, and two thousand
   * for a thousand-placement one.
   *
   * `model` is a dependency because a new document resets the viewport's
   * selection to none, and this is what installs the new one.
   */
  useEffect(() => {
    viewportRef.current?.setActivePart(activePartId);
  }, [activePartId, model]);

  /**
   * Pushes diagnostic overlays for the model that is actually displayed.
   *
   * THE STALE-REPORT GUARD. `analysis.handle` is compared against the loaded
   * model's handle before anything is drawn. An analysis of M0 that completes
   * after M1 has been imported carries M0's handle, fails this comparison, and
   * clears the overlays instead of decorating M1 with M0's defects. The viewport
   * repeats the check on revision, so neither layer relies on the other.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;

    const detail = analysis.detail;
    const belongsToLoadedModel =
      model !== undefined &&
      analysis.handle?.documentId === model.handle.documentId &&
      analysis.handle.revision === model.handle.revision &&
      // Samples are part-local. Drawing part A's defects while part B is
      // selected would put markers at coordinates that mean nothing.
      analysis.partId === activePartId;

    if (detail === undefined || !belongsToLoadedModel) {
      viewport.setOverlays(undefined);
      return;
    }

    viewport.setOverlays({
      samples: {
        boundaryEdges: detail.boundaryEdges,
        nonManifoldEdges: detail.nonManifoldEdges,
        windingConflictEdges: detail.windingConflictEdges,
        degenerateFaces: detail.degenerateFaces,
        sampleVertexIds: detail.sampleVertexIds,
        sampleVertexPositions: detail.sampleVertexPositions,
      },
      visibility: overlays,
      revision: model.revision,
    });
  }, [activePartId, analysis.detail, analysis.handle, analysis.partId, model, overlays]);

  /**
   * Pushes the repair preview.
   *
   * Depends on `previewMode` as well as the candidate, because switching Before
   * and After is a change to what is drawn — but `setPreview` rebuilds nothing
   * when only the mode changed, so the toggle costs a visibility flag and a
   * redraw rather than a GPU upload.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;

    const render = previewable?.render;
    if (previewable === undefined || render === undefined || model === undefined) {
      viewport.setPreview(undefined);
      return;
    }

    viewport.setPreview({
      positions: render.positions,
      normals: render.normals,
      // Candidate bounds when the worker measured them; the source bounds
      // otherwise. Conservative repair only removes and reorders, so the
      // source's sphere always contains the candidate — it is a safe fallback
      // rather than a guess.
      center: previewable.bounds?.center ?? model.bounds?.center ?? [0, 0, 0],
      radius: previewable.bounds?.radius ?? model.bounds?.radius ?? 1,
      showing: repair.previewMode === RepairPreviewMode.After ? 'after' : 'before',
      revision: model.revision,
      generation: previewable.candidate.generation,
    });
  }, [model, previewable, repair.previewMode]);

  /**
   * Pushes the repair change overlays.
   *
   * Built from the SOURCE render snapshot in every case, because every change
   * sample is a source face index. The viewport hides the removal categories
   * when the proposed result is being shown, since those triangles do not exist
   * there.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;

    if (previewable === undefined || model === undefined) {
      viewport.setChangeOverlays(undefined);
      return;
    }

    viewport.setChangeOverlays({
      samples: {
        removedDuplicates: previewable.samples.removedDuplicateFaces,
        removedRepeatedPosition: previewable.samples.removedRepeatedPositionFaces,
        removedZeroArea: previewable.samples.removedZeroAreaFaces,
        flippedFaces: previewable.samples.flippedFaces,
      },
      visibility: repair.changeOverlays,
      view: repair.previewMode === RepairPreviewMode.After ? 'after' : 'before',
      revision: model.revision,
      generation: previewable.candidate.generation,
    });
  }, [model, previewable, repair.changeOverlays, repair.previewMode]);

  const showingPreview =
    previewable !== undefined && repair.previewMode === RepairPreviewMode.After;

  return (
    <section className="viewport" aria-label="3D workspace">
      <div className="viewport__canvas" ref={containerRef} data-testid="viewport-canvas" />

      {/* PART E4. Never let a preview be mistaken for the model. The banner is
          text with a role, not a colour: a user who cannot see the tint still
          learns that nothing has been applied. */}
      {showingPreview ? (
        <p className="viewport__preview-banner" role="status" data-testid="preview-banner">
          Preview — not applied
        </p>
      ) : null}

      {viewportFailure !== undefined ? (
        <p className="viewport__error" role="alert" data-testid="viewport-error">
          {viewportFailure}
        </p>
      ) : model === undefined ? (
        <p className="viewport__empty" data-testid="viewport-empty">
          Empty workspace — open an STL file to view it.
        </p>
      ) : (
        <div className="viewport__toolbar">
          <button
            type="button"
            className="viewport__action"
            data-testid="fit-view"
            onClick={() => viewportRef.current?.fitView()}
          >
            Fit view
          </button>
        </div>
      )}
    </section>
  );
}
