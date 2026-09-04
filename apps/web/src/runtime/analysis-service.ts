import { internalError, operationCancelled } from '@cadfixer/shared';
import type {
  ModelAnalyzeResult,
  DocumentHandle,
  OperationHandle,
  ProgressUpdate,
  TopologyDetail,
  TopologyReport,
} from '@cadfixer/geometry-runtime';

/**
 * The one path from a loaded model to a topology report.
 *
 * Shaped deliberately like `import-service` and `export-service`: start it,
 * watch progress, cancel it, await the outcome. Components decide *that* an
 * analysis happens; this decides *how*. No React import appears in this file,
 * and no topology algorithm does either — the engine runs in the worker and this
 * is the transport.
 *
 * WHAT CROSSES. Out: a handle, a revision, and a sample cap. Back: counts,
 * statuses, and bounded diagnostic samples. The authoritative canonical mesh
 * never moves in either direction.
 */

/**
 * Worker phase names translated for the interface.
 *
 * The engine's phase names are written for the engine ("canonicalizing
 * vertices"), and they are the right names there. A progress bar is not the
 * place to teach vocabulary, so they are mapped once, here, rather than by each
 * component that happens to show progress. An unmapped phase falls through
 * unchanged rather than being hidden, so a new engine phase shows up as itself
 * instead of silently vanishing.
 */
const PHASE_LABELS: Readonly<Record<string, string>> = {
  'canonicalizing vertices': 'Recovering connectivity',
  'building edges': 'Building edges',
  'grouping edges': 'Grouping edges',
  'analyzing edge incidence': 'Analyzing edges',
  'analyzing vertex fans': 'Checking manifold topology',
  'finding components': 'Finding connected components',
  'analyzing boundaries': 'Analyzing boundaries',
  'checking faces': 'Checking faces',
  'measuring geometry': 'Calculating metrics',
  'preparing report': 'Preparing report',
};

export function describeAnalysisPhase(phase: string | undefined): string {
  if (phase === undefined || phase.length === 0) return 'Analyzing topology';
  return PHASE_LABELS[phase] ?? phase;
}

export interface AnalysisProgress {
  /** Already translated for display. */
  readonly phase: string;
  /** 0..1, monotonic across the whole analysis. */
  readonly fraction: number;
}

export interface AnalysisOutcome {
  /** The handle the report describes. Echoed by the worker, not assumed. */
  readonly handle: DocumentHandle;
  /** The part the report describes. Echoed by the worker, not assumed. */
  readonly partId: string;
  readonly report: TopologyReport;
  readonly detail: TopologyDetail;
  readonly durationMs: number;
}

export interface AnalysisSession {
  readonly promise: Promise<AnalysisOutcome>;
  /**
   * Requests cancellation.
   *
   * ANALYSIS IS NOT DISPATCHED AS INTERRUPTIBLE, so this is the message path:
   * the flag changes when the worker next returns to its event loop, which for
   * a synchronous analysis pass means when that pass finishes. The result is
   * then discarded rather than installed. Accurate as of Stage 3B-1C, which made
   * repair — not analysis — genuinely interruptible; see
   * docs/repair/REPAIR_ARCHITECTURE.md for why the two differ.
   */
  cancel(): void;
}

/**
 * The slice of the geometry client this service needs.
 *
 * Declared structurally so the service can be tested against a stand-in without
 * constructing a real `Worker`, and so the dependency is visibly one method
 * wide.
 */
export interface AnalysisCapableClient {
  analyzeModel(
    handle: DocumentHandle,
    partId: string,
    onProgress: (update: ProgressUpdate) => void,
    sampleLimit?: number,
  ): OperationHandle<ModelAnalyzeResult>;
}

export interface AnalysisRequest {
  readonly handle: DocumentHandle;
  /** The part to analyse. Analysis is per part — see ADR 0013. */
  readonly partId: string;
  readonly client: AnalysisCapableClient;
  /** Caps retained detail samples per category. */
  readonly sampleLimit?: number;
  onProgress?(progress: AnalysisProgress): void;
}

export function analyzeModelTopology(request: AnalysisRequest): AnalysisSession {
  const { handle: requested, partId: requestedPart, client, sampleLimit } = request;

  let cancelled = false;
  let dispatchCancel: (() => void) | undefined;

  // Read through a function so TypeScript does not narrow the flag to
  // permanently false across the closure boundary.
  const isCancelled = (): boolean => cancelled;

  const run = async (): Promise<AnalysisOutcome> => {
    const startedAt = Date.now();
    request.onProgress?.({ phase: describeAnalysisPhase(undefined), fraction: 0 });

    const operation = client.analyzeModel(
      requested,
      requestedPart,
      (update: ProgressUpdate) => {
        request.onProgress?.({
          phase: describeAnalysisPhase(update.note),
          fraction: update.fraction,
        });
      },
      sampleLimit,
    );

    dispatchCancel = (): void => {
      operation.cancel();
    };
    if (isCancelled()) operation.cancel();

    const result = await operation.promise;

    // A cancel that lands while the result is in flight must not install a
    // report. A report that arrives after the user pressed cancel is still a
    // complete report, but presenting it would make the cancel button a lie.
    if (isCancelled()) throw operationCancelled();

    // THE HANDLE AND PART ARE VERIFIED, NOT TRUSTED. The worker echoes both; if it does not match what was asked for, something upstream
    // routed a result to the wrong operation and the only safe response is to
    // refuse it. Silently accepting would attach one model's topology to
    // another's geometry — the exact failure the revision system exists to
    // prevent.
    if (
      result.handle.documentId !== requested.documentId ||
      result.handle.revision !== requested.revision ||
      result.partId !== requestedPart
    ) {
      throw internalError(
        'A topology report arrived for a different model than the one requested.',
      );
    }

    return {
      handle: result.handle,
      partId: result.partId,
      report: result.report,
      detail: result.detail,
      durationMs: Date.now() - startedAt,
    };
  };

  return {
    promise: run(),
    cancel(): void {
      cancelled = true;
      dispatchCancel?.();
    },
  };
}
