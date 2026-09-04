import { useCallback, useEffect, useRef } from 'react';
import { AppErrorCode, toAppError } from '@cadfixer/shared';
import type { DocumentHandle } from '@cadfixer/geometry-runtime';
import { analyzeModelTopology, type AnalysisSession } from '../runtime/analysis-service';
import { useGeometryClient } from '../runtime/client-context';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { AnalysisState, StatusSeverity, type AnalysisToken } from './workspace-store';

/**
 * Binds the analysis service to the workspace store, and starts analysis
 * automatically when a model is imported.
 *
 * WHY AUTOMATIC. Topology defects are the reason a user opens this tool. Making
 * them press "Analyze" to discover that their model has 40 boundary edges puts a
 * button between the user and the answer they came for.
 *
 * WHY IT IS SEPARATE FROM IMPORT. Import must succeed or fail on its own terms.
 * If analysis is refused for want of memory, or cancelled, or fails outright,
 * the imported model stays loaded, renderable, and exportable — diagnostics are
 * additional information about a model, not a precondition for having one.
 * Chaining analysis inside the import promise would have coupled the two.
 */

export interface TopologyAnalysisControls {
  readonly runAnalysis: () => void;
  readonly cancelAnalysis: () => void;
  readonly isAnalyzing: boolean;
  /** True when re-running would plausibly do something different. */
  readonly canRetry: boolean;
}

export function useTopologyAnalysis(): TopologyAnalysisControls {
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const { model, activePartId, analysis } = useWorkspaceState();
  const sessionRef = useRef<AnalysisSession | undefined>(undefined);

  const start = useCallback(
    (handle: DocumentHandle, partId: string): void => {
      if (client === undefined) {
        store.pushStatus(StatusSeverity.Error, 'The geometry worker is not ready yet.');
        return;
      }

      sessionRef.current?.cancel();
      const token: AnalysisToken = store.beginAnalysis(handle, partId);

      const session = analyzeModelTopology({
        handle,
        partId,
        client,
        onProgress: (progress) => {
          store.reportAnalysisProgress(token, progress.fraction, progress.phase);
        },
      });
      sessionRef.current = session;

      session.promise.then(
        (outcome) => {
          const installed = store.commitAnalysis(
            token,
            outcome.handle,
            outcome.partId,
            outcome.report,
            outcome.detail,
            outcome.durationMs,
          );
          sessionRef.current = undefined;
          // A report for a model that is no longer loaded says nothing at all.
          // It is dropped silently rather than announced, because announcing it
          // would describe a model the user is not looking at.
          if (!installed) return;

          const defects = countDefects(outcome.report);
          store.pushStatus(
            defects === 0 ? StatusSeverity.Success : StatusSeverity.Warning,
            defects === 0
              ? 'Topology analysis found no defects. Self-intersections and wall thickness were not checked.'
              : `Topology analysis found ${defects.toLocaleString()} issue${defects === 1 ? '' : 's'}.`,
          );
        },
        (cause: unknown) => {
          const error = toAppError(cause);
          sessionRef.current = undefined;

          if (error.code === AppErrorCode.OperationCancelled) {
            if (!store.cancelAnalysis(token)) return;
            store.pushStatus(
              StatusSeverity.Info,
              'Topology analysis cancelled. The model is still loaded.',
            );
            return;
          }

          const budgetRefusal = error.code === AppErrorCode.ResourceLimitExceeded;
          if (
            !store.failAnalysis(token, {
              message: error.message,
              code: error.code,
              // A budget refusal will refuse identically next time; offering a
              // retry there would be a button that cannot help.
              retryable: !budgetRefusal,
            })
          ) {
            return;
          }

          store.pushStatus(
            StatusSeverity.Error,
            budgetRefusal
              ? `Topology analysis could not run: ${error.message} The model is still loaded and can be viewed and exported.`
              : `Topology analysis failed: ${error.message}`,
          );
        },
      );
    },
    [client, store],
  );

  /**
   * Starts analysis once per (document revision, active part).
   *
   * Keyed on the handle AND the part, and guarded by a ref, because
   * `StrictMode` runs effects twice in development and an unguarded version
   * would dispatch two analyses for every import. The part belongs in the key
   * for a reason that is not cosmetic: two parts share a revision, so a
   * handle-only key would leave the second part unanalysed after a switch and
   * the panel showing the first part's counts.
   *
   * ONE PART AT A TIME, deliberately. Analysing every part of a hundred-part
   * document on import would spend a hundred full topology passes to fill a
   * panel that shows one of them.
   */
  const startedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (model === undefined || activePartId === undefined) {
      startedForRef.current = undefined;
      return;
    }
    if (client === undefined) return;

    const key = `${model.handle.documentId}@${String(model.handle.revision)}/${activePartId}`;
    if (startedForRef.current === key) return;
    startedForRef.current = key;
    start(model.handle, activePartId);
  }, [activePartId, client, model, start]);

  /**
   * Cancels the in-flight analysis when the model goes away.
   *
   * Without this a long analysis would keep running in the worker against a
   * model the application has already released, burning a core to produce a
   * report nothing will accept.
   */
  useEffect(() => {
    if (model !== undefined) return;
    sessionRef.current?.cancel();
    sessionRef.current = undefined;
  }, [model]);

  const runAnalysis = useCallback((): void => {
    if (model === undefined || activePartId === undefined) return;
    start(model.handle, activePartId);
  }, [activePartId, model, start]);

  const cancelAnalysis = useCallback((): void => {
    sessionRef.current?.cancel();
  }, []);

  return {
    runAnalysis,
    cancelAnalysis,
    isAnalyzing: analysis.state === AnalysisState.Analyzing,
    canRetry:
      model !== undefined &&
      analysis.state !== AnalysisState.Analyzing &&
      (analysis.state !== AnalysisState.Failed || analysis.error?.retryable !== false),
  };
}

/**
 * Total topological defects, for the one-line status message only.
 *
 * The panel reports every category separately; this is the count that decides
 * whether the status line says "no defects" or gives a number. Boundary edges
 * are included because an unexpected opening is the most common real defect,
 * and excluded categories would make the number quietly wrong.
 */
function countDefects(report: {
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  readonly nonManifoldVertexCount: number;
  readonly windingConflictEdgeCount: number;
  readonly repeatedPositionFaceCount: number;
  readonly zeroAreaFaceCount: number;
  readonly sameOrientationDuplicateCount: number;
  readonly reversedOrientationDuplicateCount: number;
}): number {
  return (
    report.boundaryEdgeCount +
    report.nonManifoldEdgeCount +
    report.nonManifoldVertexCount +
    report.windingConflictEdgeCount +
    report.repeatedPositionFaceCount +
    report.zeroAreaFaceCount +
    report.sameOrientationDuplicateCount +
    report.reversedOrientationDuplicateCount
  );
}
