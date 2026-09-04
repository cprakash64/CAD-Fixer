import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import type { OperationId } from '@cadfixer/shared';
import type {
  ModelAnalyzeResult,
  DocumentHandle,
  DocumentId,
  OperationHandle,
  ProgressUpdate,
} from '@cadfixer/geometry-runtime';
import {
  analyzeModelTopology,
  describeAnalysisPhase,
  type AnalysisCapableClient,
} from './analysis-service';

/**
 * Tested against a stand-in client rather than a real worker, so the service's
 * own rules — handle verification, cancellation ordering, phase translation —
 * are exercised without the worker's timing in the way. The real worker path is
 * covered end to end by Playwright.
 */

const HANDLE: DocumentHandle = { documentId: 'model-1' as DocumentId, revision: 1 };
const PART = 'part-1';

interface Controllable {
  readonly client: AnalysisCapableClient;
  resolve(result: ModelAnalyzeResult): void;
  reject(cause: unknown): void;
  emitProgress(update: ProgressUpdate): void;
  readonly cancelCount: number;
}

function controllableClient(): Controllable {
  let resolveResult: (value: ModelAnalyzeResult) => void = () => undefined;
  let rejectResult: (cause: unknown) => void = () => undefined;
  let onProgress: (update: ProgressUpdate) => void = () => undefined;
  let cancelCount = 0;

  const promise = new Promise<ModelAnalyzeResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const client: AnalysisCapableClient = {
    analyzeModel(_handle, _partId, progress): OperationHandle<ModelAnalyzeResult> {
      onProgress = progress;
      return {
        id: 1 as unknown as OperationId,
        promise,
        cancel(): void {
          cancelCount += 1;
        },
        interruptible: false,
      };
    },
  };

  return {
    client,
    resolve: (result: ModelAnalyzeResult): void => {
      resolveResult(result);
    },
    reject: (cause: unknown): void => {
      rejectResult(cause);
    },
    emitProgress: (update: ProgressUpdate): void => {
      onProgress(update);
    },
    get cancelCount(): number {
      return cancelCount;
    },
  };
}

function resultFor(handle: DocumentHandle, partId = PART): ModelAnalyzeResult {
  return {
    handle,
    partId,
    // The service does not inspect the report's contents; it routes it.
    // Contents are irrelevant here: the service routes the report, it does not
    // read it. Cast through `unknown` because a partial report is deliberately
    // not a valid one.
    report: { documentId: handle.documentId } as unknown as ModelAnalyzeResult['report'],
    detail: {} as unknown as ModelAnalyzeResult['detail'],
  };
}

describe('phase translation', () => {
  it('turns engine vocabulary into something a progress bar can say', () => {
    expect(describeAnalysisPhase('canonicalizing vertices')).toBe('Recovering connectivity');
    expect(describeAnalysisPhase('analyzing vertex fans')).toBe('Checking manifold topology');
    expect(describeAnalysisPhase('measuring geometry')).toBe('Calculating metrics');
  });

  it('passes an unknown phase through rather than hiding it', () => {
    // A new engine phase should appear as itself, not vanish from the UI.
    expect(describeAnalysisPhase('reticulating splines')).toBe('reticulating splines');
    expect(describeAnalysisPhase(undefined)).toBe('Analyzing topology');
  });
});

describe('handle verification', () => {
  /**
   * The worker echoes the handle it analysed. If it ever fails to match, the
   * result has been routed to the wrong operation, and accepting it would
   * attach one model's topology to another's geometry.
   */
  it('rejects a result whose handle does not match the request', async () => {
    const controllable = controllableClient();
    const session = analyzeModelTopology({
      handle: HANDLE,
      partId: PART,
      client: controllable.client,
    });

    controllable.resolve(resultFor({ documentId: 'model-2' as DocumentId, revision: 1 }));

    await expect(session.promise).rejects.toThrow(/different model/i);
  });

  it('rejects a result for the right model at the wrong revision', async () => {
    const controllable = controllableClient();
    const session = analyzeModelTopology({
      handle: HANDLE,
      partId: PART,
      client: controllable.client,
    });

    controllable.resolve(resultFor({ documentId: 'model-1' as DocumentId, revision: 2 }));

    await expect(session.promise).rejects.toThrow(/different model/i);
  });

  it('accepts a matching result', async () => {
    const controllable = controllableClient();
    const session = analyzeModelTopology({
      handle: HANDLE,
      partId: PART,
      client: controllable.client,
    });

    controllable.resolve(resultFor(HANDLE));

    const outcome = await session.promise;
    expect(outcome.handle).toEqual(HANDLE);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('cancellation', () => {
  it('forwards the cancel to the worker operation', async () => {
    const controllable = controllableClient();
    const session = analyzeModelTopology({
      handle: HANDLE,
      partId: PART,
      client: controllable.client,
    });

    // Let the service dispatch before cancelling.
    await Promise.resolve();
    session.cancel();

    expect(controllable.cancelCount).toBe(1);
    controllable.reject(new Error('cancelled by worker'));
    await expect(session.promise).rejects.toThrow();
  });

  it('refuses a result that arrives after the user cancelled', async () => {
    const controllable = controllableClient();
    const session = analyzeModelTopology({
      handle: HANDLE,
      partId: PART,
      client: controllable.client,
    });

    await Promise.resolve();
    session.cancel();
    // The worker finished anyway — cancellation is cooperative, so this is a
    // real race, not a hypothetical one. Presenting the report would make the
    // cancel button a lie.
    controllable.resolve(resultFor(HANDLE));

    await session.promise.then(
      () => {
        throw new Error('expected the cancelled analysis to reject');
      },
      (cause: unknown) => {
        expect(isAppError(cause)).toBe(true);
        if (!isAppError(cause)) return;
        expect(cause.code).toBe(AppErrorCode.OperationCancelled);
      },
    );
  });
});

describe('progress', () => {
  it('reports translated phases and the worker fraction', async () => {
    const controllable = controllableClient();
    const seen: { phase: string; fraction: number }[] = [];

    const session = analyzeModelTopology({
      handle: HANDLE,
      partId: PART,
      client: controllable.client,
      onProgress: (progress) => seen.push({ ...progress }),
    });

    await Promise.resolve();
    controllable.emitProgress({ fraction: 0.5, note: 'analyzing vertex fans' });
    controllable.resolve(resultFor(HANDLE));
    await session.promise;

    expect(seen[0]).toEqual({ phase: 'Analyzing topology', fraction: 0 });
    expect(seen).toContainEqual({ phase: 'Checking manifold topology', fraction: 0.5 });
  });
});
