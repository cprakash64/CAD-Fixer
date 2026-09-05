import { describe, expect, it, vi } from 'vitest';
import { ExportStatus, MeshFormatId, type ExportMetadata } from '@cadfixer/file-formats';
import { AppErrorCode, AppError } from '@cadfixer/shared';
import type { DocumentHandle } from '@cadfixer/geometry-runtime';
import { DocumentExportService, ExportTarget } from './document-export-service';
import type { GeometryClient } from './geometry-client';

/**
 * THE EXPORT CONTROLLER'S LIFECYCLE, including the paths nobody wants.
 *
 * WHY A WORKER DOUBLE RATHER THAN A REJECTED PROMISE. The paths under test are
 * not "the promise settled" — they are whether the `error` LISTENER runs,
 * whether the ports are closed, whether the worker reference is released,
 * whether a stale artifact is discarded, and whether the next export can start.
 * A hand-settled promise proves none of that because it never touches the
 * worker at all. This double dispatches real `MessageEvent` objects through
 * real `EventTarget` machinery.
 */

const handle: DocumentHandle = { documentId: 'model-1', revision: 3 } as DocumentHandle;

const METADATA: ExportMetadata = {
  formatId: MeshFormatId.Obj,
  outputBytes: 128,
  triangleCount: 4,
  partCount: 1,
  meshResourceCount: 1,
  observations: [],
};

class FakeWorker extends EventTarget {
  public terminated = 0;
  public readonly posted: unknown[] = [];

  public postMessage(message: unknown): void {
    this.posted.push(message);
  }

  public terminate(): void {
    this.terminated += 1;
  }

  public failToLoad(): void {
    this.dispatchEvent(new Event('error'));
  }

  public progress(operationId: string, fraction: number, note?: string): void {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'progress', operationId, fraction, note },
      }),
    );
  }

  public written(operationId: string, documentId = 'model-1', documentRevision = 3): void {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: {
          kind: 'written',
          operationId,
          documentId,
          documentRevision,
          bytes: new Uint8Array([1, 2, 3, 4]).buffer,
          metadata: METADATA,
        },
      }),
    );
  }

  public failed(operationId: string, reason: string, message = 'refused'): void {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'failed', operationId, code: 'INVALID_STATE', reason, message },
      }),
    );
  }
}

interface Harness {
  readonly service: DocumentExportService;
  readonly workers: FakeWorker[];
  readonly sends: number;
}

function harness(sendBehaviour: 'resolve' | 'reject' | 'unavailable' = 'resolve'): Harness {
  const workers: FakeWorker[] = [];
  const state = { sends: 0 };

  const client = {
    sendForExport: vi.fn(async () => {
      state.sends += 1;
      if (sendBehaviour === 'reject') throw new Error('producer refused');
      if (sendBehaviour === 'unavailable') {
        throw new AppError(AppErrorCode.ModelUnavailable, 'That model is no longer available.');
      }
      return Promise.resolve({
        partCount: 1,
        meshResourceCount: 1,
        triangleCount: 4,
        revision: 3,
      });
    }),
  } as unknown as GeometryClient;

  const service = new DocumentExportService(client, () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });

  return {
    service,
    workers,
    get sends(): number {
      return state.sends;
    },
  };
}

describe('a completed export', () => {
  it('returns the artifact, releases the worker and reports progress', async () => {
    const { service, workers } = harness();
    const seen: number[] = [];
    const session = service.run({
      handle,
      target: ExportTarget.Obj,
      onProgress: (fraction) => seen.push(fraction),
    });
    const worker = workers[0];
    if (worker === undefined) throw new Error('no worker');

    expect(service.liveWorkerCount).toBe(1);
    expect(service.liveChannelCount).toBe(1);

    worker.progress(session.operationId, 0.5, 'writing');
    worker.written(session.operationId);

    const outcome = await session.promise;
    expect(outcome.status).toBe(ExportStatus.Success);
    if (outcome.status !== ExportStatus.Success) return;
    expect([...outcome.bytes]).toEqual([1, 2, 3, 4]);
    expect(outcome.metadata.triangleCount).toBe(4);

    // DISPOSED ON SUCCESS TOO, not only on failure: a worker retained after a
    // completed export is a leak per export.
    expect(worker.terminated).toBe(1);
    expect(service.liveWorkerCount).toBe(0);
    expect(service.liveChannelCount).toBe(0);
    expect(service.activeOperation).toBeUndefined();
    expect(seen).toEqual([0.5]);
  });
});

describe('one active export at a time', () => {
  it('disposes the first export when a second starts, and settles it', async () => {
    /*
     * TWO CONCURRENT FIFTY-MEGABYTE SERIALISATIONS would compete for exactly the
     * memory the output ceilings were sized against, and both would publish into
     * the same slot with no way to tell which artifact was which. Superseding is
     * deterministic, and the superseded promise SETTLES rather than hanging.
     */
    const { service, workers } = harness();
    const first = service.run({ handle, target: ExportTarget.Obj });
    const second = service.run({ handle, target: ExportTarget.ThreeMf });

    const outcome = await first.promise;
    expect(outcome.status).toBe(ExportStatus.Cancelled);
    expect(workers[0]?.terminated).toBe(1);
    expect(service.activeOperation).toBe(second.operationId);
    expect(service.liveWorkerCount).toBe(1);
  });

  it('ignores a message from a superseded operation', async () => {
    const { service, workers } = harness();
    const first = service.run({ handle, target: ExportTarget.Obj });
    // Starting the second supersedes the first and settles it as cancelled.
    const second = service.run({ handle, target: ExportTarget.Obj });
    expect((await first.promise).status).toBe(ExportStatus.Cancelled);

    // The first worker answering late must not publish into the second's slot.
    workers[0]?.written(first.operationId);
    workers[1]?.written(second.operationId);

    const outcome = await second.promise;
    expect(outcome.status).toBe(ExportStatus.Success);
    if (outcome.status !== ExportStatus.Success) return;
    // The bytes are the SECOND worker's, and the first's arrived nowhere.
    expect([...outcome.bytes]).toEqual([1, 2, 3, 4]);
  });
});

describe('cancellation', () => {
  it('terminates the worker and settles as CANCELLED', async () => {
    const { service, workers } = harness();
    const session = service.run({ handle, target: ExportTarget.ThreeMf });

    session.cancel();

    const outcome = await session.promise;
    expect(outcome.status).toBe(ExportStatus.Cancelled);
    // NO ARTIFACT. A cancelled export must not hand back partial bytes.
    expect('bytes' in outcome).toBe(false);
    expect(workers[0]?.terminated).toBe(1);
    expect(service.liveWorkerCount).toBe(0);
    expect(service.liveChannelCount).toBe(0);
  });

  it('reports the elapsed time, not zero', async () => {
    /*
     * THE REGRESSION THIS PINS. `dispose` settles a pending operation with a
     * zeroed record, and `cancel` used to dispose BEFORE settling — so the
     * promise had already resolved with `durationMs: 0` by the time the real
     * outcome arrived, and a promise settles once.
     *
     * Nothing user-visible depended on the number, which is why it survived: a
     * browser test comparing a cancelled export's duration against an
     * uncancelled one was comparing against zero and passing for the wrong
     * reason. A duration that is always zero cannot distinguish a cancel that
     * interrupted work from one that did not.
     */
    const { service } = harness();
    const session = service.run({ handle, target: ExportTarget.Obj });

    await new Promise((resolve) => setTimeout(resolve, 25));
    session.cancel();

    const outcome = await session.promise;
    expect(outcome.status).toBe(ExportStatus.Cancelled);
    expect(outcome.durationMs).toBeGreaterThan(0);
  });

  it('is idempotent, and a late result after it changes nothing', async () => {
    const { service, workers } = harness();
    const session = service.run({ handle, target: ExportTarget.Obj });

    session.cancel();
    session.cancel();
    workers[0]?.written(session.operationId);

    expect((await session.promise).status).toBe(ExportStatus.Cancelled);
    expect(workers[0]?.terminated).toBe(1);
  });

  it('allows a retry that succeeds', async () => {
    const { service, workers } = harness();
    service.run({ handle, target: ExportTarget.Obj }).cancel();

    const retry = service.run({ handle, target: ExportTarget.Obj });
    workers[1]?.written(retry.operationId);

    expect((await retry.promise).status).toBe(ExportStatus.Success);
    expect(service.liveWorkerCount).toBe(0);
  });
});

describe('stale revisions', () => {
  it('DISCARDS an artifact written from a revision the caller is no longer on', async () => {
    /*
     * THE CASE THIS EXISTS FOR: an export starts at revision 3, the user applies
     * a repair, and the writer finishes. Those bytes describe geometry the user
     * is no longer looking at. Handing them over — or downloading them — would
     * give someone a file of a model they had already changed.
     */
    const { service, workers } = harness();
    const session = service.run({ handle, target: ExportTarget.Obj });
    workers[0]?.written(session.operationId, 'model-1', 4);

    const outcome = await session.promise;
    expect(outcome.status).toBe(ExportStatus.StaleRevision);
    expect('bytes' in outcome).toBe(false);
    expect(service.liveWorkerCount).toBe(0);
  });

  it('discards an artifact written from a different document', async () => {
    const { service, workers } = harness();
    const session = service.run({ handle, target: ExportTarget.Obj });
    workers[0]?.written(session.operationId, 'model-2', 3);

    expect((await session.promise).status).toBe(ExportStatus.StaleRevision);
  });

  it('reports a producer-side refusal for a released document as STALE', async () => {
    const { service } = harness('unavailable');
    const session = service.run({ handle, target: ExportTarget.Obj });

    const outcome = await session.promise;
    expect(outcome.status).toBe(ExportStatus.StaleRevision);
    // AND THE PROMISE SETTLED AT ALL. Settling after teardown would have called
    // nothing, leaving a panel saying "Writing…" with no worker running.
    expect(service.liveWorkerCount).toBe(0);
  });
});

describe('typed outcomes', () => {
  it.each([
    ['EXPORT_UNIT_REQUIRED', ExportStatus.BlockedUnitRequired],
    ['EXPORT_OUTPUT_TOO_LARGE', ExportStatus.ResourceLimit],
    ['EXPORT_SERIALISED_TOO_LARGE', ExportStatus.ResourceLimit],
    ['EXPORT_VALIDATION_FAILED', ExportStatus.ValidationFailed],
    ['EXPORT_VALIDATION_UNREADABLE', ExportStatus.ValidationFailed],
    ['EXPORT_MALFORMED_SNAPSHOT', ExportStatus.InternalFailure],
  ])('maps %s to %s', async (reason, status) => {
    const { service, workers } = harness();
    const session = service.run({ handle, target: ExportTarget.ThreeMf });
    workers[0]?.failed(session.operationId, reason);

    const outcome = await session.promise;
    expect(outcome.status).toBe(status);
    if (outcome.status === ExportStatus.Success) return;
    expect(outcome.reason).toBe(reason);
    // THE SENTENCE IS CARRIED, NOT INVENTED HERE. Stage 4A-2B3 decides the
    // wording; this stage must not put a second copy of it in the controller.
    expect(outcome.message).toBe('refused');
  });

  it('turns a real worker error event into INTERNAL_FAILURE and releases everything', async () => {
    const { service, workers } = harness();
    const session = service.run({ handle, target: ExportTarget.Obj });

    workers[0]?.failToLoad();

    const outcome = await session.promise;
    expect(outcome.status).toBe(ExportStatus.InternalFailure);
    expect(workers[0]?.terminated).toBe(1);
    expect(service.liveWorkerCount).toBe(0);
    expect(service.liveChannelCount).toBe(0);
  });

  it('settles a producer-side rejection rather than hanging', async () => {
    const { service } = harness('reject');
    const session = service.run({ handle, target: ExportTarget.Obj });

    const outcome = await session.promise;
    expect(outcome.status).toBe(ExportStatus.InternalFailure);
    expect(service.liveWorkerCount).toBe(0);
  });
});

describe('repeated lifecycle', () => {
  it('leaks no worker, channel or operation across many runs', async () => {
    const { service, workers } = harness();

    // complete, complete, cancel, retry — twice over, for both targets.
    for (let round = 0; round < 2; round += 1) {
      for (const target of [ExportTarget.Obj, ExportTarget.ThreeMf]) {
        const done = service.run({ handle, target });
        workers[workers.length - 1]?.written(done.operationId);
        expect((await done.promise).status).toBe(ExportStatus.Success);

        const cancelled = service.run({ handle, target });
        cancelled.cancel();
        expect((await cancelled.promise).status).toBe(ExportStatus.Cancelled);

        const retried = service.run({ handle, target });
        workers[workers.length - 1]?.written(retried.operationId);
        expect((await retried.promise).status).toBe(ExportStatus.Success);
      }
    }

    // EVERY worker terminated exactly once, and nothing is still live.
    expect(workers).toHaveLength(12);
    expect(workers.every((worker) => worker.terminated === 1)).toBe(true);
    expect(service.liveWorkerCount).toBe(0);
    expect(service.liveChannelCount).toBe(0);
    expect(service.activeOperation).toBeUndefined();
  });

  it('releases everything on dispose, and settles what was pending', async () => {
    const { service, workers } = harness();
    const session = service.run({ handle, target: ExportTarget.Obj });

    service.dispose();
    service.dispose();

    expect((await session.promise).status).toBe(ExportStatus.Cancelled);
    expect(workers[0]?.terminated).toBe(1);
    expect(service.liveWorkerCount).toBe(0);
  });
});
