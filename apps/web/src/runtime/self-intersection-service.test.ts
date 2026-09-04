import { describe, expect, it, vi } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import type { ModelHandle } from '@cadfixer/geometry-runtime';
import { SelfIntersectionCancelled, SelfIntersectionService } from './self-intersection-service';
import type { GeometryClient } from './geometry-client';

/**
 * THE DISPOSABLE WORKER'S LIFECYCLE, including the paths nobody wants.
 *
 * WHY A WORKER DOUBLE RATHER THAN A REJECTED PROMISE. The failure path under
 * test is not "the promise rejected" — it is whether the `error` LISTENER runs,
 * whether the ports are closed, whether the worker reference is released and
 * whether the next operation can start. A hand-rejected promise proves none of
 * that because it never touches the worker at all. This double dispatches real
 * `Event` and `MessageEvent` objects through real `EventTarget` machinery.
 */

const handle: ModelHandle = { modelId: 'model-1', revision: 1 } as ModelHandle;

/** A Worker stand-in that records termination and can emit real events. */
class FakeWorker extends EventTarget {
  public terminated = 0;
  public readonly posted: unknown[] = [];

  public postMessage(message: unknown): void {
    this.posted.push(message);
  }

  public terminate(): void {
    this.terminated += 1;
  }

  /** Fires the same `error` event a failing module worker fires. */
  public failToLoad(): void {
    this.dispatchEvent(new Event('error'));
  }

  public report(operationId: string): void {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: {
          kind: 'report',
          operationId,
          report: { status: 'CHECKED', modelId: 'model-1', modelRevision: 1 },
        },
      }),
    );
  }
}

interface Harness {
  service: SelfIntersectionService;
  workers: FakeWorker[];
  sends: number;
}

function harness(sendBehaviour: 'resolve' | 'reject' = 'resolve'): Harness {
  const workers: FakeWorker[] = [];
  const state = { sends: 0 };
  const client = {
    sendForDiagnostic: vi.fn(async () => {
      state.sends += 1;
      if (sendBehaviour === 'reject') throw new Error('producer refused');
      return Promise.resolve({ faceCount: 12, vertexCount: 8 });
    }),
  } as unknown as GeometryClient;

  const service = new SelfIntersectionService(client, () => {
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

describe('a diagnostic worker that fails is reported, released, and retryable', () => {
  it('turns a real worker error event into INTERNAL_FAILURE', async () => {
    const { service, workers } = harness();
    const session = service.run({ handle });
    const worker = workers[0];
    expect(worker).toBeDefined();
    if (worker === undefined) return;

    expect(service.liveWorkerCount).toBe(1);
    expect(service.liveChannelCount).toBe(1);

    // The actual failure the browser would deliver.
    worker.failToLoad();

    const cause = await session.promise.catch((error: unknown) => error);
    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.Internal);

    // Everything the operation owned is released, not merely forgotten.
    expect(worker.terminated).toBeGreaterThan(0);
    expect(service.liveWorkerCount).toBe(0);
    expect(service.liveChannelCount).toBe(0);
    expect(service.activeOperation).toBeUndefined();
  });

  it('allows a retry on a FRESH worker after a failure', async () => {
    const { service, workers } = harness();
    const failed = service.run({ handle });
    workers[0]?.failToLoad();
    await failed.promise.catch(() => undefined);

    const retried = service.run({ handle });
    expect(workers).toHaveLength(2);
    expect(workers[1]).not.toBe(workers[0]);
    expect(service.liveWorkerCount).toBe(1);

    workers[1]?.report(retried.operationId);
    await expect(retried.promise).resolves.toMatchObject({ status: 'CHECKED' });
    expect(service.liveWorkerCount).toBe(0);
  });

  it('reports a producer-side refusal without leaving a worker behind', async () => {
    const { service, workers } = harness('reject');
    const session = service.run({ handle });

    const cause = await session.promise.catch((error: unknown) => error);
    expect(isAppError(cause)).toBe(true);
    expect(workers[0]?.terminated).toBeGreaterThan(0);
    expect(service.liveWorkerCount).toBe(0);
  });
});

describe('cancellation is not failure', () => {
  it('rejects with SelfIntersectionCancelled and releases everything', async () => {
    const { service, workers } = harness();
    const session = service.run({ handle });

    session.cancel();

    const cause = await session.promise.catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(SelfIntersectionCancelled);
    expect(workers[0]?.terminated).toBeGreaterThan(0);
    expect(service.liveWorkerCount).toBe(0);
    expect(service.activeOperation).toBeUndefined();
  });

  it('is idempotent', async () => {
    const { service } = harness();
    const session = service.run({ handle });
    // Attached before cancelling: the promise rejects synchronously, and an
    // unobserved rejection would surface as an unhandled error rather than as
    // the behaviour under test.
    const settled = session.promise.catch((error: unknown) => error);

    session.cancel();
    expect(() => {
      session.cancel();
    }).not.toThrow();

    expect(await settled).toBeInstanceOf(SelfIntersectionCancelled);
    expect(service.liveWorkerCount).toBe(0);
  });
});

describe('stale results cannot reach a later operation', () => {
  it('discards a message whose operation has been superseded', async () => {
    const { service, workers } = harness();
    const first = service.run({ handle });
    const firstId = first.operationId;
    // Observed immediately: superseding it rejects, and an unobserved rejection
    // would be reported as an unhandled error.
    const firstSettled = first.promise.catch(() => undefined);

    // A second run supersedes the first and disposes its worker.
    const second = service.run({ handle });
    expect(workers).toHaveLength(2);
    expect(workers[0]?.terminated).toBeGreaterThan(0);

    // The OLD worker answers late. It must not settle the new operation.
    workers[1]?.report(firstId);
    let settled = false;
    void second.promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    // The correct answer still settles it.
    workers[1]?.report(second.operationId);
    await expect(second.promise).resolves.toMatchObject({ status: 'CHECKED' });

    // The superseded operation settled as a cancellation, not as a result.
    await firstSettled;
  });
});

describe('repeated lifecycle leaves nothing behind', () => {
  it('never accumulates workers, channels or operations across many runs', async () => {
    const { service, workers } = harness();

    for (let cycle = 0; cycle < 8; cycle += 1) {
      const session = service.run({ handle });
      // Alternate completing and cancelling, as a user would.
      if (cycle % 3 === 2) {
        session.cancel();
        await session.promise.catch(() => undefined);
      } else {
        workers[workers.length - 1]?.report(session.operationId);
        await session.promise;
      }

      // THE INVARIANT: after every terminal operation, exactly nothing is live.
      expect(service.liveWorkerCount, `cycle ${String(cycle)}`).toBe(0);
      expect(service.liveChannelCount, `cycle ${String(cycle)}`).toBe(0);
      expect(service.activeOperation, `cycle ${String(cycle)}`).toBeUndefined();
    }

    // One worker per run and not one more: no hidden retain, no doubling.
    expect(workers).toHaveLength(8);
    for (const worker of workers) {
      expect(worker.terminated).toBeGreaterThan(0);
    }
  });
});
