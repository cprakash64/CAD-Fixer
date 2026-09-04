import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorCode, createOperationId, isAppError, operationCancelled } from '@cadfixer/shared';
import type {
  DocumentHandle,
  DocumentId,
  OperationHandle,
  StlExportResult,
} from '@cadfixer/geometry-runtime';
import { exportStlFile, type ExportCapableClient, type ExportProgress } from './export-service';

/**
 * Export used to be a fire-and-forget call inside a React component: no
 * progress, no cancellation, and — on the 8.5 s ASCII export of a
 * two-million-triangle model measured in Stage 1 — a button that appeared to do
 * nothing for nine seconds.
 *
 * These tests drive the real service against a controllable stand-in for the
 * worker client, so the sequencing is exercised without a browser.
 */

/**
 * Export now names a resident model instead of carrying geometry. That is the
 * point of the resident runtime: nothing larger than this handle crosses the
 * worker boundary.
 */
const HANDLE: DocumentHandle = { documentId: 'model-1' as DocumentId, revision: 1 };
const PART = 'part-1';

/** A client whose operation the test resolves, rejects, or cancels by hand. */
function controllableClient(): {
  client: ExportCapableClient;
  emitProgress: (fraction: number) => void;
  resolve: (byteLength?: number) => void;
  reject: (error: unknown) => void;
  cancelCalls: () => number;
} {
  let emit: (fraction: number) => void = () => undefined;
  let settleResolve: (value: StlExportResult) => void = () => undefined;
  let settleReject: (reason: unknown) => void = () => undefined;
  let cancels = 0;

  const client: ExportCapableClient = {
    exportModel(_handle, _partId, _encoding, onProgress): OperationHandle<StlExportResult> {
      emit = (fraction): void => {
        onProgress({ fraction });
      };
      const promise = new Promise<StlExportResult>((resolvePromise, rejectPromise) => {
        settleResolve = resolvePromise;
        settleReject = rejectPromise;
      });
      return {
        id: createOperationId(),
        promise,
        interruptible: false,
        cancel: (): void => {
          cancels += 1;
        },
      };
    },
  };

  return {
    client,
    emitProgress: (fraction): void => {
      emit(fraction);
    },
    resolve: (byteLength = 134): void => {
      settleResolve({
        bytes: new ArrayBuffer(byteLength),
        byteLength,
        encoding: 'binary',
        warnings: [],
      });
    },
    reject: (error): void => {
      settleReject(error);
    },
    cancelCalls: () => cancels,
  };
}

function startExport(
  client: ExportCapableClient,
  onProgress?: (progress: ExportProgress) => void,
): ReturnType<typeof exportStlFile> {
  return exportStlFile({
    partId: PART,
    handle: HANDLE,
    sourceFileName: 'bracket.stl',
    encoding: 'binary',
    client,
    ...(onProgress === undefined ? {} : { onProgress }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('export progress', () => {
  it('reports progress from the worker rather than inventing it', async () => {
    const harness = controllableClient();
    const seen: number[] = [];
    const session = startExport(harness.client, (progress) => seen.push(progress.fraction));

    harness.emitProgress(0.25);
    harness.emitProgress(0.75);
    harness.resolve();
    await session.promise;

    // The values track the worker's, scaled into the service's own range.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.some((fraction) => fraction > 0.2 && fraction < 0.3)).toBe(true);
    expect(seen.some((fraction) => fraction > 0.7 && fraction < 0.8)).toBe(true);
  });

  it('is monotonic and ends at exactly 1', async () => {
    const harness = controllableClient();
    const seen: number[] = [];
    const session = startExport(harness.client, (progress) => seen.push(progress.fraction));

    for (const fraction of [0, 0.1, 0.4, 0.9, 1]) harness.emitProgress(fraction);
    harness.resolve();
    await session.promise;

    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1] ?? 0);
    }
    expect(seen.at(-1)).toBe(1);
  });

  it('never reports 1 before the file has actually been written', () => {
    const harness = controllableClient();
    const seen: number[] = [];
    startExport(harness.client, (progress) => seen.push(progress.fraction));

    // The worker claims completion of its own phase...
    harness.emitProgress(1);

    // ...but the export is not finished until the bytes are saved.
    expect(seen.at(-1)).toBeLessThan(1);
  });
});

describe('export cancellation', () => {
  it('forwards cancellation to the worker operation', () => {
    const harness = controllableClient();
    const session = startExport(harness.client);

    session.cancel();

    expect(harness.cancelCalls()).toBe(1);
  });

  it('cancels an operation that was already cancelled before dispatch settled', async () => {
    const harness = controllableClient();
    const session = startExport(harness.client);

    session.cancel();
    harness.reject(operationCancelled());

    await expect(session.promise).rejects.toThrow();
    expect(harness.cancelCalls()).toBe(1);
  });

  it('DOES NOT download a partial file when cancelled', async () => {
    // The property that matters most. A truncated STL saved to disk with no
    // indication it is truncated is worse than no file at all.
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    const harness = controllableClient();
    const session = startExport(harness.client);

    session.cancel();
    // The worker's result arrives anyway — cancellation raced the completion.
    harness.resolve();

    await expect(session.promise).rejects.toThrow();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('rejects with OPERATION_CANCELLED so the UI can distinguish it from failure', async () => {
    const harness = controllableClient();
    const session = startExport(harness.client);

    session.cancel();
    harness.resolve();

    try {
      await session.promise;
      expect.unreachable('expected the export to reject');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.OperationCancelled);
    }
  });

  it('never sends geometry across the boundary at all', async () => {
    // Replaces a Stage 1 test that asserted the source mesh was not mutated.
    // With the resident runtime there is no mesh on this side to mutate: the
    // export payload is a handle, which is the stronger property.
    const captured: unknown[] = [];
    const client: ExportCapableClient = {
      exportModel: (handle): OperationHandle<StlExportResult> => {
        captured.push(handle);
        return {
          id: createOperationId(),
          promise: Promise.reject(operationCancelled()),
          cancel: () => undefined,
          interruptible: false,
        };
      },
    };

    await exportStlFile({
      partId: PART,
      handle: HANDLE,
      sourceFileName: 'bracket.stl',
      encoding: 'binary',
      client,
    }).promise.catch(() => undefined);

    expect(captured).toEqual([HANDLE]);
  });
});

describe('successful export', () => {
  it('saves a file and reports what was written', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const harness = controllableClient();
    const session = startExport(harness.client);

    harness.resolve(4242);
    const outcome = await session.promise;

    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(outcome.fileName).toBe('bracket.stl');
    expect(outcome.byteLength).toBe(4242);
  });

  it('surfaces writer warnings instead of swallowing them', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let settle: (value: StlExportResult) => void = () => undefined;
    const client: ExportCapableClient = {
      exportModel: () => ({
        id: createOperationId(),
        promise: new Promise<StlExportResult>((resolve) => {
          settle = resolve;
        }),
        cancel: () => undefined,
        interruptible: false,
      }),
    };
    const session = startExport(client);

    settle({
      bytes: new ArrayBuffer(8),
      byteLength: 8,
      encoding: 'binary',
      warnings: [{ code: 'STL_GROUPS_FLATTENED', message: 'Groups were merged.' }],
    });

    expect((await session.promise).warnings).toHaveLength(1);
  });

  it('names an ASCII export distinctly so it cannot overwrite the binary one', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const harness = controllableClient();
    const session = exportStlFile({
      partId: PART,
      handle: HANDLE,
      sourceFileName: 'bracket.stl',
      encoding: 'ascii',
      client: harness.client,
    });

    harness.resolve();

    expect((await session.promise).fileName).toBe('bracket-ascii.stl');
  });
});

describe('concurrent exports', () => {
  it('keeps two exports independent, so one cannot drive the other’s progress', async () => {
    // Each session closes over its own callback. A second export must not
    // receive progress belonging to the first.
    const first = controllableClient();
    const second = controllableClient();
    const firstSeen: number[] = [];
    const secondSeen: number[] = [];

    const firstSession = startExport(first.client, (p) => firstSeen.push(p.fraction));
    const secondSession = startExport(second.client, (p) => secondSeen.push(p.fraction));

    first.emitProgress(0.3);
    second.emitProgress(0.9);

    expect(firstSeen.some((fraction) => fraction > 0.25 && fraction < 0.35)).toBe(true);
    expect(secondSeen.some((fraction) => fraction > 0.25 && fraction < 0.35)).toBe(false);

    first.reject(operationCancelled());
    second.reject(operationCancelled());
    await Promise.allSettled([firstSession.promise, secondSession.promise]);
  });
});
